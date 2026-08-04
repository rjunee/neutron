/**
 * model-update-watchdog-wiring.test.ts — proves the row #16 model-update watchdog
 * is actually WIRED into the substrate (anti-pattern #1: no built-but-not-wired
 * core). A 6h-gated probe that returns a genuinely-NEW top-tier id must, through
 * the LIVE substrate path:
 *   1. fire the `onModelUpdate` notice once (edge),
 *   2. adopt the new model as the runtime default (`getBestModel()` flips), and
 *   3. idle-gated graceful-respawn the warm session onto the new model — the
 *      respawn argv carries `--model <newModel>` and `--resume <sid>`, and the
 *      registry record's `model` is rewritten BEFORE the respawn.
 * And a probe that returns a known FALLBACK id (the Opus-outage→Haiku trap) —
 * or, per ISSUES #491, any id that is merely DIFFERENT rather than demonstrably
 * NEWER — must do NONE of that.
 */

import { describe, it, expect, afterEach, beforeEach } from 'bun:test'
import type { PtyChild, PtyHost } from '../pty-host.ts'
import {
  createPersistentReplSubstrate,
  getReplSinkInfo,
  poolKeyFor,
  registerSupervisedSubstrate,
  startModelUpdateWatchdogForInstance,
  peekModelUpdateWatchdogForTest,
  getReplRegistrySnapshot,
  shutdownAllPersistentRepls,
  type PersistentReplSubstrateOptions,
} from '../persistent-repl-substrate.ts'
import { BEST_MODEL, getBestModel, setBestModelOverride } from '../../../../models.ts'
import { compareModelRecency, type ProbeResult } from '../model-update-watchdog.ts'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A probe id that is demonstrably NEWER than whatever `BEST_MODEL` currently
 * seeds. Deliberately far ahead so a future seed bump cannot quietly overtake it.
 * This fixture used to be a literal `claude-opus-4-9`; once the seed moved on to
 * `claude-opus-5`, the "upgrade" assertions below were silently asserting that a
 * DOWNGRADE was correct behaviour — which is exactly ISSUES #491, and which the
 * new guard caught. The rank assertion in each test now fails loudly rather than
 * mysteriously if that ever recurs.
 */
const NEWER_THAN_SEED = 'claude-opus-99'
/** A recognised id that is OLDER than the seed — the #491 downgrade case. */
const OLDER_THAN_SEED = 'claude-opus-4-7'

beforeEach(() => setBestModelOverride(undefined))
afterEach(async () => {
  await shutdownAllPersistentRepls()
  setBestModelOverride(undefined) // never leak an adopted model across files
})

/** A fake `claude` + dev-channel host that records EVERY spawn argv (so we can
 *  assert the post-upgrade respawn carries `--model <newModel>` + `--resume`). */
function makeHost(): { host: PtyHost; spawns: () => string[][] } {
  const spawns: string[][] = []
  const host: PtyHost = {
    spawn(argv: string[]): PtyChild {
      spawns.push([...argv])
      const i = argv.indexOf('--session-id')
      const sid = (i >= 0 ? argv[i + 1] : argv[argv.indexOf('--resume') + 1]) as string
      const { port: sinkPort, token } = getReplSinkInfo()
      let hasExited = false
      let exitResolve: (c: number | null) => void = () => {}
      const exited = new Promise<number | null>((res) => (exitResolve = res))
      const post = (path: string, body: unknown): Promise<unknown> =>
        fetch(`http://127.0.0.1:${sinkPort}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Sink-Token': token },
          body: JSON.stringify(body),
        }).catch(() => undefined)
      const server = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        async fetch(req) {
          const url = new URL(req.url)
          if (url.pathname === '/health') return Response.json({ ok: true, session_id: sid })
          if (req.method === 'POST' && url.pathname === '/message') {
            const body = (await req.json()) as { text: string; turn_id?: string }
            void post('/reply', { session_id: sid, text: `ok:${body.text}`, turn_id: body.turn_id })
            return Response.json({ status: 'delivered' })
          }
          return new Response('not found', { status: 404 })
        },
      })
      void post('/channel-ready', { session_id: sid, channel_port: server.port, pid: 4242 })
      void post('/channel-bound', { session_id: sid })
      return {
        pid: 4242,
        write: () => {},
        resize() {},
        kill() {
          if (hasExited) return
          hasExited = true
          try {
            server.stop(true)
          } catch {
            /* ignore */
          }
          exitResolve(143)
        },
        exited,
        hasExited: () => hasExited,
      }
    },
  }
  return { host, spawns: () => spawns }
}

let n = 0
function optsWith(
  host: PtyHost,
  stateDir: string,
  probe: ProbeResult,
  extra: Partial<PersistentReplSubstrateOptions> = {},
): PersistentReplSubstrateOptions {
  n += 1
  return {
    substrate_instance_id: `mu-wire-${n}-${Math.floor(performance.now())}`,
    // A REAL dir — the respawn validates cwd existence before `--resume`.
    cwd: mkdtempSync(join(stateDir, 'cwd-')),
    ptyHost: host,
    skipTrustSeed: true,
    idleQuietMs: 0,
    captureConfig: { maxAttempts: 1, attemptDelayMs: 1 },
    assertConfig: { readyBudgetMs: 5000, readyIntervalMs: 25, healthBudgetMs: 5000, healthIntervalMs: 25 },
    replRegistryPath: join(stateDir, 'repl-registry.json'),
    modelUpdateStatePath: join(stateDir, '.model-update-state.json'),
    jsonlExistsProbe: () => true, // make the session resumable without a real JSONL
    modelProbe: () => Promise.resolve(probe),
    modelCheckIntervalMs: 0, // 6h gate always open
    // Drive a fast, deterministic idle-gated upgrade.
    modelUpgradeIdleQuiesceMs: 0,
    modelUpgradeJsonlFreshMs: 0,
    modelUpgradePollMs: 1,
    modelUpgradePerSessionTimeoutMs: 5000,
    ...extra,
  }
}

async function drainOK(handle: { events: AsyncIterable<{ kind: string }> }): Promise<void> {
  for await (const ev of handle.events) {
    if (ev.kind === 'completion' || ev.kind === 'error') return
  }
}

/** Poll until `pred()` is true or the budget elapses. */
async function until(pred: () => boolean, budgetMs = 3000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < budgetMs) {
    if (pred()) return true
    await Bun.sleep(15)
  }
  return pred()
}

describe('model-update watchdog — substrate wiring (row #16)', () => {
  it('a NEW top-tier id → notice + adopt + graceful respawn onto the new model', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'neutron-mu-wire-'))
    mkdirSync(stateDir, { recursive: true })
    try {
      // The fixture must genuinely outrank the seed, or this test proves nothing.
      expect(compareModelRecency(NEWER_THAN_SEED, BEST_MODEL)).toBe('newer')
      const { host, spawns } = makeHost()
      const notices: Array<{ newModel: string; oldModel: string }> = []
      const opts = optsWith(host, stateDir, { ok: true, model: NEWER_THAN_SEED }, {
        onModelUpdate: (notice) => notices.push({ newModel: notice.newModel, oldModel: notice.oldModel }),
      })
      registerSupervisedSubstrate(opts)

      const sub = createPersistentReplSubstrate(opts)
      await drainOK(sub.start({ prompt: 'hi', tools: [], model_preference: ['claude-opus-4-7'] }))
      const key = poolKeyFor(opts)
      const spawnsBefore = spawns().length

      // Start + drive the model-update watchdog tick deterministically.
      startModelUpdateWatchdogForInstance(opts)
      const wd = peekModelUpdateWatchdogForTest(opts.modelUpdateStatePath as string)
      expect(wd).toBeDefined()
      await wd!.tick()

      // 1. The notice fired once (edge).
      expect(notices).toEqual([{ newModel: NEWER_THAN_SEED, oldModel: BEST_MODEL }])
      // 2. The model was adopted as the runtime default.
      expect(getBestModel()).toBe(NEWER_THAN_SEED)

      // 3. The idle session was respawned onto the new model (fire-and-forget
      //    upgrade — poll for the respawn argv).
      const respawned = await until(() =>
        spawns()
          .slice(spawnsBefore)
          .some((argv) => argv.includes('--resume') && argv.includes(NEWER_THAN_SEED)),
      )
      expect(respawned).toBe(true)

      const upgradeSpawn = spawns()
        .slice(spawnsBefore)
        .find((argv) => argv.includes('--resume'))
      expect(upgradeSpawn).toBeDefined()
      // `--model` is emitted LAST and carries the new id.
      const mIdx = upgradeSpawn!.indexOf('--model')
      expect(upgradeSpawn![mIdx + 1]).toBe(NEWER_THAN_SEED)

      // The registry record's model was rewritten BEFORE the respawn.
      await until(() => getReplRegistrySnapshot(opts.replRegistryPath as string)[key]?.model === NEWER_THAN_SEED)
      expect(getReplRegistrySnapshot(opts.replRegistryPath as string)[key]?.model).toBe(NEWER_THAN_SEED)
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('THE TRAP: a known FALLBACK id (Opus outage) → no notice, no adopt, no respawn', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'neutron-mu-wire-'))
    mkdirSync(stateDir, { recursive: true })
    try {
      const { host, spawns } = makeHost()
      const notices: unknown[] = []
      const opts = optsWith(host, stateDir, { ok: true, model: 'claude-haiku-4-5-20251001' }, {
        onModelUpdate: (n2) => notices.push(n2),
      })
      registerSupervisedSubstrate(opts)

      const sub = createPersistentReplSubstrate(opts)
      await drainOK(sub.start({ prompt: 'hi', tools: [], model_preference: ['claude-opus-4-7'] }))
      const spawnsBefore = spawns().length

      startModelUpdateWatchdogForInstance(opts)
      const wd = peekModelUpdateWatchdogForTest(opts.modelUpdateStatePath as string)
      await wd!.tick()
      await Bun.sleep(50) // give any (erroneous) async upgrade a chance to fire

      expect(notices).toEqual([])
      expect(getBestModel()).toBe(BEST_MODEL) // NOT downgraded to Haiku
      const newSpawns = spawns().slice(spawnsBefore)
      expect(newSpawns.filter((argv) => argv.includes('--resume'))).toEqual([])
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('#491: a recognised OLDER id → no notice, no adopt, no respawn, nothing persisted', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'neutron-mu-wire-'))
    mkdirSync(stateDir, { recursive: true })
    try {
      // The fixture must genuinely be a downgrade, or this test proves nothing.
      expect(compareModelRecency(OLDER_THAN_SEED, BEST_MODEL)).toBe('older')
      const { host, spawns } = makeHost()
      const notices: unknown[] = []
      const opts = optsWith(host, stateDir, { ok: true, model: OLDER_THAN_SEED }, {
        onModelUpdate: (n2) => notices.push(n2),
      })
      registerSupervisedSubstrate(opts)

      const sub = createPersistentReplSubstrate(opts)
      await drainOK(sub.start({ prompt: 'hi', tools: [], model_preference: [BEST_MODEL] }))
      const spawnsBefore = spawns().length

      startModelUpdateWatchdogForInstance(opts)
      const wd = peekModelUpdateWatchdogForTest(opts.modelUpdateStatePath as string)
      await wd!.tick()
      await Bun.sleep(50) // give any (erroneous) async upgrade a chance to fire

      expect(notices).toEqual([])
      // The whole point: the owner's runtime default is NOT moved backwards.
      expect(getBestModel()).toBe(BEST_MODEL)
      const newSpawns = spawns().slice(spawnsBefore)
      expect(newSpawns.filter((argv) => argv.includes('--resume'))).toEqual([])
      // …and the downgrade is not written back as the baseline, so a restart
      // cannot re-apply it.
      const persisted = JSON.parse(
        await Bun.file(opts.modelUpdateStatePath as string).text(),
      ) as { last_known_model?: string }
      expect(persisted.last_known_model).not.toBe(OLDER_THAN_SEED)
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })
})
