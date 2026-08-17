/**
 * model-floor.test.ts — THE OWNER'S CHAT NEVER RESUMES BELOW THE FRONTIER MODEL.
 *
 * THE DEFECT THIS GUARDS. A spawn resolves its model as
 * `record.model ?? getBestModel()` (`pool.ts` / `supervision.ts`), so a REPL
 * registry row OVERRIDES the frontier model rather than falling back to it, and
 * `spawn.ts` writes the row back with whatever it just spawned on. One wrong
 * value therefore survives every respawn, restart and resume. The owner's
 * project chat ran a full working day on Haiku on that path, twice; setting the
 * row to Opus by hand held for a few hours and it came back. Nobody ever
 * identified the writer.
 *
 * SO THE TESTS BELOW ASSERT A PROPERTY, NOT A FIX AT A WRITER. They drive the
 * REAL spawn path with a registry row naming Haiku — the exact string measured
 * in the live registry — and assert on what the child was actually spawned with
 * (`--model` in the argv) and on what got written BACK to the row. A test that
 * only checked the decision function would pass while the argv stayed wrong.
 *
 * Structure:
 *   1. The pure decision (`resolveModelFloor`) — clamps, and what it must NOT clamp.
 *   2. End-to-end: a Haiku record on a floored substrate spawns Opus…
 *   3. …and the row it writes back is Opus, so the value cannot self-perpetuate.
 *   4. A substrate WITHOUT the floor keeps its per-session model choice (scribe).
 *   5. The factory forwards the option (the seam that silently dropped
 *      `appendSystemPromptFile` once — see `append-system-prompt-wiring.test.ts`).
 */

import { describe, it, expect, afterEach } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentSpec } from '../../../../substrate.ts'
import type { SessionHandle } from '../../../../session-handle.ts'
import type { Event } from '../../../../events.ts'
import { FAST_MODEL, SONNET_MODEL, getBestModel } from '../../../../models.ts'
import type { PtyChild, PtyHost } from '../pty-host.ts'
import { createClaudeCodeSubstrateAuto } from '../../index.ts'
import { familyOf, resolveModelFloor, tierRankOf } from '../model-floor.ts'
import {
  createPersistentReplSubstrate,
  getReplSinkInfo,
  shutdownAllPersistentRepls,
  type PersistentReplSubstrateOptions,
} from '../persistent-repl-substrate.ts'
import { poolKeyFor } from '../pool.ts'
import { supervisedBySessionKey } from '../pool-state.ts'
import { getRecord, upsertRecord } from '../repl-registry.ts'

/** The EXACT id measured in the owner's live REPL registry on the degraded row. */
const LIVE_HAIKU_ID = 'claude-haiku-4-5-20251001'

/** A real spawn walks the post-spawn readiness + health assertions (5s budgets
 *  each), so the 5s bun-test default is not enough headroom on a loaded box. */
const SPAWN_TEST_TIMEOUT_MS = 30_000

const tempDirs: string[] = []

afterEach(async () => {
  await shutdownAllPersistentRepls()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

// ---------------------------------------------------------------------------
// 1. The pure decision.
// ---------------------------------------------------------------------------

describe('resolveModelFloor — the decision', () => {
  it('clamps the exact id found in the owner’s live registry row', () => {
    const d = resolveModelFloor({ requested: LIVE_HAIKU_ID, enabled: true })
    expect(d.clamped).toBe(true)
    expect(d.model).toBe(getBestModel())
    expect(d.requested).toBe(LIVE_HAIKU_ID)
  })

  it('clamps every named lower tier, dated or base form', () => {
    for (const id of [FAST_MODEL, SONNET_MODEL, 'claude-haiku-4-5', 'claude-sonnet-4-6']) {
      expect(resolveModelFloor({ requested: id, enabled: true }).clamped, id).toBe(true)
    }
  })

  it('clamps the BARE CLI ALIASES — `--model haiku` is a real thing the CLI accepts', () => {
    // Cross-model review blocker #1. The first revision matched a set of four
    // literal ids, so `haiku` / `sonnet` walked straight past a floor whose whole
    // claim is "whatever the persisted record says". The record is not
    // schema-checked (`repl-registry.ts` leaves `model` optional and unvalidated),
    // so it really can hold one of these.
    for (const id of ['haiku', 'sonnet']) {
      const d = resolveModelFloor({ requested: id, enabled: true })
      expect(d.clamped, id).toBe(true)
      expect(d.model, id).toBe(getBestModel())
    }
  })

  it('clamps an OLDER generation and a FUTURE generation of a lower tier', () => {
    // Neither is in the alias set, and neither ever will be — a set of literals
    // needs a human to remember. The family token does not.
    for (const id of ['claude-haiku-3-5-20241022', 'claude-haiku-9', 'claude-sonnet-7']) {
      expect(resolveModelFloor({ requested: id, enabled: true }).clamped, id).toBe(true)
    }
  })

  it('clamps a FUTURE dated snapshot of a lower tier', () => {
    const d = resolveModelFloor({ requested: 'claude-haiku-4-5-20260901', enabled: true })
    expect(d.clamped).toBe(true)
    expect(d.model).toBe(getBestModel())
  })

  it('clamps despite stray whitespace or mixed case in an unvalidated row', () => {
    for (const id of ['  claude-haiku-4-5  ', 'CLAUDE-HAIKU-4-5', 'Haiku']) {
      expect(resolveModelFloor({ requested: id, enabled: true }).clamped, id).toBe(true)
    }
  })

  it('leaves the frontier model itself alone', () => {
    const d = resolveModelFloor({ requested: getBestModel(), enabled: true })
    expect(d.clamped).toBe(false)
    expect(d.model).toBe(getBestModel())
  })

  it('does NOT clamp an unrecognised or newer top-tier id', () => {
    // Clamping "anything ≠ best" would fight the model-update watchdog, which
    // legitimately writes ids THIS process has never heard of into a record before
    // a `--resume` respawn. A NAMED lower tier is unambiguous; an unknown id is not.
    for (const id of ['claude-opus-6', 'claude-fable-5', 'claude-opus-5-20260401', 'some-new-model']) {
      expect(resolveModelFloor({ requested: id, enabled: true }).clamped, id).toBe(false)
    }
  })

  it('is a no-op for a substrate without the floor — deliberate FAST_MODEL callers', () => {
    const d = resolveModelFloor({ requested: FAST_MODEL, enabled: false })
    expect(d.clamped).toBe(false)
    expect(d.model).toBe(FAST_MODEL)
  })

  it('holds at the CONFIGURED best when an operator pinned a cheaper tier', () => {
    // Cross-model review blocker #2, against an earlier revision of this file that
    // DISABLED the floor whenever the configured best was itself a lower tier.
    // That is not a floor: a poisoned fast-tier row would then sit below the
    // operator's OWN configured best and stay there. Rank comparison holds the
    // line at whatever the operator configured.
    const d = resolveModelFloor({ requested: FAST_MODEL, enabled: true, best: SONNET_MODEL })
    expect(d.clamped).toBe(true)
    expect(d.model).toBe(SONNET_MODEL)
  })

  it('does NOT clamp a request at the SAME tier as a cheaper configured best', () => {
    // The other half of the same decision, and the reason it is rank-based rather
    // than "is a lower tier": a same-tier request must not produce a no-op clamp
    // with a `model_floor_applied` event naming a degradation that did not happen.
    // An event that fires on correct behaviour trains the reader to ignore it —
    // the exact failure the loudness exists to prevent.
    const d = resolveModelFloor({ requested: SONNET_MODEL, enabled: true, best: SONNET_MODEL })
    expect(d.clamped).toBe(false)
    expect(d.model).toBe(SONNET_MODEL)
  })

  it('never clamps TO a blank floor — that would fail the launch outright', () => {
    // `BEST_MODEL` resolves with `??`, so an empty `NEUTRON_BEST_MODEL` arrives as
    // `''`. Handing the CLI an empty `--model` is strictly worse than the
    // degradation being corrected.
    const d = resolveModelFloor({ requested: FAST_MODEL, enabled: true, best: '' })
    expect(d.clamped).toBe(false)
    expect(d.model).toBe(FAST_MODEL)
  })

  it('resolves a BLANK request to the floor rather than spawning an empty --model', () => {
    const d = resolveModelFloor({ requested: '   ', enabled: true })
    expect(d.clamped).toBe(true)
    expect(d.model).toBe(getBestModel())
  })

  it('survives a non-string model in an unvalidated registry row', () => {
    // `repl-registry.ts` never schema-checks `model`, so a row from another build
    // can carry anything. A throw HERE would be inside a spawn — a wrong-model
    // bug turned into a dead session.
    const d = resolveModelFloor({ requested: 42 as unknown as string, enabled: true })
    expect(d.model).toBe(getBestModel())
  })

  it('orders the tiers FROM the aliases, so a generation bump cannot invert it', () => {
    expect(tierRankOf(FAST_MODEL)).toBeLessThan(tierRankOf(SONNET_MODEL))
    expect(tierRankOf(SONNET_MODEL)).toBeLessThan(tierRankOf(getBestModel()))
  })

  it('extracts the tier family from every id shape the CLI accepts', () => {
    expect(familyOf('claude-haiku-4-5-20251001')).toBe('haiku')
    expect(familyOf('claude-sonnet-5')).toBe('sonnet')
    expect(familyOf('claude-opus-5')).toBe('opus')
    expect(familyOf('haiku')).toBe('haiku')
    expect(familyOf('  Sonnet ')).toBe('sonnet')
  })
})

// ---------------------------------------------------------------------------
// 2-4. End-to-end through the real spawn path.
// ---------------------------------------------------------------------------

/** Echo host that captures the argv of every spawn (mirrors `append-system-prompt-wiring.test.ts`). */
function makeCapturingHost(): { host: PtyHost; argvs: string[][] } {
  const argvs: string[][] = []
  let spawns = 0
  const host: PtyHost = {
    spawn(argv: string[]): PtyChild {
      spawns += 1
      argvs.push(argv)
      const pid = 310000 + spawns
      const i = argv.indexOf('--session-id')
      const r = argv.indexOf('--resume')
      const sid = (i >= 0 ? argv[i + 1] : r >= 0 ? argv[r + 1] : undefined) as string
      const { port: sinkPort, token } = getReplSinkInfo()
      let hasExited = false
      let exitResolve: (code: number | null) => void = () => {}
      const exited = new Promise<number | null>((res) => {
        exitResolve = res
      })
      const post = (path: string, body: unknown): Promise<unknown> =>
        fetch(`http://127.0.0.1:${sinkPort}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Sink-Token': token },
          body: JSON.stringify(body),
        }).catch(() => undefined)
      let seen = 0
      const server = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        async fetch(req) {
          const url = new URL(req.url)
          if (url.pathname === '/health') return Response.json({ ok: true })
          if (req.method === 'POST' && url.pathname === '/message') {
            const body = (await req.json()) as { text: string; turn_id?: string }
            const reply = `seen=${seen} got=${body.text}`
            seen += 1
            void post('/reply', { session_id: sid, text: reply, turn_id: body.turn_id })
            return Response.json({ status: 'delivered' })
          }
          return new Response('nf', { status: 404 })
        },
      })
      void post('/channel-ready', { session_id: sid, channel_port: server.port, pid })
      void post('/channel-bound', { session_id: sid })
      return {
        pid,
        write() {},
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
  return { host, argvs }
}

function opts(
  host: PtyHost,
  extra: Partial<PersistentReplSubstrateOptions>,
): PersistentReplSubstrateOptions {
  return {
    substrate_instance_id: 'cc-agent-owner',
    cwd: tempDir('neutron-model-floor-cwd-'),
    ptyHost: host,
    skipTrustSeed: true,
    idleQuietMs: 0,
    captureConfig: { maxAttempts: 1, attemptDelayMs: 1 },
    assertConfig: {
      readyBudgetMs: 5000,
      readyIntervalMs: 25,
      healthBudgetMs: 5000,
      healthIntervalMs: 25,
    },
    ...extra,
  }
}

function spec(model: string): AgentSpec {
  return { prompt: 'hi', tools: [], model_preference: [model] }
}

async function drain(handle: SessionHandle): Promise<void> {
  for await (const ev of handle.events as AsyncIterable<Event>) {
    if (ev.kind === 'completion') return
    if (ev.kind === 'error') throw new Error(`drain error: ${ev.message}`)
  }
}

function modelArg(argv: string[]): string | undefined {
  const i = argv.indexOf('--model')
  return i >= 0 ? argv[i + 1] : undefined
}

describe('the frontier-model floor holds at the spawn chokepoint', () => {
  it('a Haiku record on the owner’s chat substrate spawns the FRONTIER model', async () => {
    // THE LIVE DEFECT, reproduced: a registry row naming Haiku is what
    // `pool.ts` / `supervision.ts` hand to the spawn as `record.model`.
    const { host, argvs } = makeCapturingHost()
    const registryPath = join(tempDir('neutron-model-floor-reg-'), 'repl-registry.json')
    const sub = createPersistentReplSubstrate(
      opts(host, {
        user_id: 'u-floor',
        project_id: 'default',
        credential_identity: 'cred-1',
        replRegistryPath: registryPath,
        frontierModelFloor: true,
      }),
    )
    await drain(sub.start(spec(LIVE_HAIKU_ID)))
    expect(argvs.length).toBe(1)
    expect(modelArg(argvs[0]!)).toBe(getBestModel())
    expect(modelArg(argvs[0]!)).not.toBe(LIVE_HAIKU_ID)
  }, SPAWN_TEST_TIMEOUT_MS)

  it('the row it writes back names the FRONTIER model — the value cannot self-perpetuate', async () => {
    // The half that makes the fix permanent rather than per-spawn. `spawn.ts`
    // persists the model it spawned with; clamping before that write means the
    // next respawn reads a clean row instead of re-poisoning itself.
    const { host } = makeCapturingHost()
    const registryPath = join(tempDir('neutron-model-floor-reg-'), 'repl-registry.json')
    const sub = createPersistentReplSubstrate(
      opts(host, {
        user_id: 'u-persist',
        project_id: 'default',
        credential_identity: 'cred-1',
        replRegistryPath: registryPath,
        frontierModelFloor: true,
      }),
    )
    await drain(sub.start(spec(LIVE_HAIKU_ID)))
    const keys = Object.keys(
      JSON.parse(readFileSync(registryPath, 'utf8')) as Record<string, unknown>,
    )
    expect(keys.length).toBe(1)
    const record = getRecord(registryPath, keys[0]!)
    expect(record).toBeDefined()
    expect(record!.model).toBe(getBestModel())
  }, SPAWN_TEST_TIMEOUT_MS)

  it('a pre-poisoned row is corrected rather than obeyed on the next spawn', async () => {
    // Seed the registry the way the live box was found — under the REAL pool key,
    // so this is the row `record.model` would actually be resolved from — then
    // spawn and assert both halves: the child comes up on the frontier model, and
    // nothing is left holding the poisoned value.
    const { host, argvs } = makeCapturingHost()
    const registryPath = join(tempDir('neutron-model-floor-reg-'), 'repl-registry.json')
    const options = opts(host, {
      user_id: 'u-seed',
      project_id: 'default',
      credential_identity: 'cred-1',
      replRegistryPath: registryPath,
      frontierModelFloor: true,
    })
    const sessionKey = poolKeyFor(options)
    upsertRecord(registryPath, {
      sessionKey,
      sessionId: '00000000-0000-4000-8000-000000000000',
      cwd: options.cwd!,
      channelName: 'seeded',
      has_session: false,
      model: LIVE_HAIKU_ID,
    })
    expect(getRecord(registryPath, sessionKey)!.model).toBe(LIVE_HAIKU_ID)

    await drain(createPersistentReplSubstrate(options).start(spec(LIVE_HAIKU_ID)))
    expect(modelArg(argvs[0]!)).toBe(getBestModel())
    const rows = JSON.parse(readFileSync(registryPath, 'utf8')) as Record<
      string,
      { model?: string }
    >
    expect(Object.keys(rows)).toContain(sessionKey)
    for (const [key, row] of Object.entries(rows)) {
      expect(row.model, key).not.toBe(LIVE_HAIKU_ID)
    }
  }, SPAWN_TEST_TIMEOUT_MS)

  it('a substrate WITHOUT the floor keeps its deliberate fast-tier choice', async () => {
    // Scribe extraction / the reflection + correction judges are FAST_MODEL on
    // purpose. Breaking them would be trading one regression for another.
    const { host, argvs } = makeCapturingHost()
    const sub = createPersistentReplSubstrate(
      opts(host, {
        substrate_instance_id: 'cc-scribe-owner',
        user_id: 'u-scribe',
        project_id: 'default',
        credential_identity: 'cred-1',
      }),
    )
    await drain(sub.start(spec(FAST_MODEL)))
    expect(modelArg(argvs[0]!)).toBe(FAST_MODEL)
  }, SPAWN_TEST_TIMEOUT_MS)

  it('the floor never DOWNGRADES — a frontier request on a floored substrate is untouched', async () => {
    const { host, argvs } = makeCapturingHost()
    const sub = createPersistentReplSubstrate(
      opts(host, {
        user_id: 'u-best',
        project_id: 'default',
        credential_identity: 'cred-1',
        frontierModelFloor: true,
      }),
    )
    await drain(sub.start(spec(getBestModel())))
    expect(modelArg(argvs[0]!)).toBe(getBestModel())
  }, SPAWN_TEST_TIMEOUT_MS)
})

// ---------------------------------------------------------------------------
// 5. The factory forwards the option — the seam that once silently dropped one.
// ---------------------------------------------------------------------------

describe('createClaudeCodeSubstrateAuto forwards frontier_model_floor', () => {
  function registeredFor(instanceId: string): PersistentReplSubstrateOptions | undefined {
    for (const o of supervisedBySessionKey.values()) {
      if (o.substrate_instance_id === instanceId) return o
    }
    return undefined
  }

  it('maps the option onto the persistent options bag', () => {
    const cwd = tempDir('neutron-floor-fwd-')
    const instanceId = `cc-agent-fwd-${Date.now()}`
    createClaudeCodeSubstrateAuto({
      substrate_instance_id: instanceId,
      cwd,
      frontier_model_floor: true,
    })
    const reg = registeredFor(instanceId)
    expect(reg).toBeDefined()
    expect(reg!.frontierModelFloor).toBe(true)
  })

  it('leaves it unset when the caller omits it (every utility substrate)', () => {
    const cwd = tempDir('neutron-floor-fwd-')
    const instanceId = `cc-util-fwd-${Date.now()}`
    createClaudeCodeSubstrateAuto({ substrate_instance_id: instanceId, cwd })
    const reg = registeredFor(instanceId)
    expect(reg).toBeDefined()
    expect(reg!.frontierModelFloor).toBeUndefined()
  })
})
