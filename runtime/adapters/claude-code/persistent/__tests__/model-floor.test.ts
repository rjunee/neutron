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
import {
  applyModelFloor,
  familyOf,
  resolveModelFloor,
  tierRankOf,
  type ModelFloorNotice,
} from '../model-floor.ts'
import {
  createPersistentReplSubstrate,
  getReplSinkInfo,
  shutdownAllPersistentRepls,
  type PersistentReplSubstrateOptions,
} from '../persistent-repl-substrate.ts'
import { poolKeyFor, replayPendingInbound } from '../pool.ts'
import { supervisedBySessionKey } from '../pool-state.ts'
import { registerSupervisedSubstrate, respawnReplSession } from '../supervision.ts'
import { getRecord, patchRecord, upsertRecord } from '../repl-registry.ts'

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
    //
    // ⚠️ THE FIRST TWO ARE REAL PUBLISHED IDS, AND THAT IS THE WHOLE POINT. The
    // previous revision of this test asserted on `claude-haiku-3-5-20241022` — the
    // CURRENT naming order applied to an OLD generation, which Anthropic never
    // shipped. A fabricated id let the older-generation claim pass while the
    // genuinely published `claude-3-5-haiku-20241022` (generation FIRST) walked
    // straight through the floor: it yielded family `3`, unrecognised, ranked at
    // the frontier. A regression test whose input cannot occur proves nothing.
    for (const id of [
      'claude-3-5-haiku-20241022',
      'claude-3-5-sonnet-20241022',
      'claude-haiku-9',
      'claude-sonnet-7',
    ]) {
      expect(resolveModelFloor({ requested: id, enabled: true }).clamped, id).toBe(true)
    }
  })

  it('clamps a lower tier behind a GATEWAY / PROXY prefix', () => {
    // `repl-registry.ts` never schema-checks `model`, and these are the real id
    // shapes a Bedrock / Vertex / proxy-routed deployment writes. Anchoring the
    // family on the first token read every one of them as a vendor word, ranked
    // them at the frontier, and let them through.
    for (const id of [
      'us.anthropic.claude-haiku-4-5-v1:0',
      'eu.anthropic.claude-3-5-haiku-20241022-v1:0',
      'anthropic/claude-haiku-4-5',
      'publishers/anthropic/models/claude-3-5-haiku@20241022',
    ]) {
      const d = resolveModelFloor({ requested: id, enabled: true })
      expect(d.clamped, id).toBe(true)
      expect(d.model, id).toBe(getBestModel())
    }
  })

  it('reads the tier out of BOTH naming orders and every prefix shape', () => {
    // The predicate under the clamps above, asserted directly so a failure says
    // WHICH id shape broke rather than only that a clamp stopped happening.
    for (const id of [
      'claude-haiku-4-5-20251001',
      'claude-3-5-haiku-20241022',
      'us.anthropic.claude-haiku-4-5-v1:0',
      'anthropic/claude-haiku-4-5',
      'publishers/anthropic/models/claude-3-5-haiku@20241022',
      'HAIKU',
    ]) {
      expect(familyOf(id), id).toBe('haiku')
    }
    // …and the frontier tiers still read as themselves in both orders, so the
    // scan did not simply start matching everything.
    expect(familyOf('claude-opus-5')).toBe('opus')
    expect(familyOf('claude-3-opus-20240229')).toBe('opus')
    expect(familyOf('us.anthropic.claude-opus-5-v1:0')).toBe('opus')
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

  it('returns an UNFLOORED substrate’s value byte-for-byte, whatever it is', () => {
    // The unfloored path is a passthrough BY CONTRACT — `spawn.ts` relies on it to
    // claim the deliberate FAST_MODEL callers are untouched. A previous revision
    // coerced a non-string BEFORE the enabled check, so an unfloored substrate
    // that passed a junk value got `''` back instead of its own input. Padding is
    // the observable case; the non-string is the one that changed the outcome.
    const padded = '  claude-haiku-4-5  '
    expect(resolveModelFloor({ requested: padded, enabled: false }).model).toBe(padded)
    const junk = 42 as unknown as string
    expect(resolveModelFloor({ requested: junk, enabled: false }).model).toBe(junk)
  })

  it('TRIMS the id it hands to --model, not just the one it compares', () => {
    // The comparison has always been whitespace-insensitive; the RETURN was not,
    // so a padded frontier id in an unvalidated row reached the CLI padded. Case
    // is left alone deliberately — a model id's case is meaningful to the API.
    const d = resolveModelFloor({ requested: `  ${getBestModel()}  `, enabled: true })
    expect(d.clamped).toBe(false)
    expect(d.model).toBe(getBestModel())
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
// 1b. The clamp is LOUD — on BOTH surfaces.
// ---------------------------------------------------------------------------

describe('applyModelFloor — a clamp is never silent', () => {
  /** Capture the process log lines `createLogger`'s default sink writes. */
  function captureWarnings<T>(body: () => T): { result: T; lines: string[] } {
    const lines: string[] = []
    const original = console.warn
    console.warn = (...args: unknown[]): void => {
      lines.push(args.map(String).join(' '))
    }
    try {
      return { result: body(), lines }
    } finally {
      console.warn = original
    }
  }

  it('writes a structured operator line naming the session, the request and the floor', () => {
    // The OPERATOR half. Asserted on the emitted LINE rather than on a spy for the
    // helper, because the previous revision's only loudness was this call and
    // NOTHING failed when it was deleted — every test passed on the return value.
    const { result, lines } = captureWarnings(() =>
      applyModelFloor({
        requested: LIVE_HAIKU_ID,
        enabled: true,
        sessionKey: 'key-loud',
        source: 'resume',
      }),
    )
    expect(result).toBe(getBestModel())
    const line = lines.find((l) => l.includes('event=model_floor_applied'))
    expect(line, `no model_floor_applied line in ${JSON.stringify(lines)}`).toBeDefined()
    expect(line!).toContain('session_key=key-loud')
    expect(line!).toContain('source=resume')
    expect(line!).toContain(`requested_model=${LIVE_HAIKU_ID}`)
    expect(line!).toContain(`floor_model=${getBestModel()}`)
  })

  it('fires the OWNER-facing notice with the record’s model and the floor', () => {
    // The half a journald line cannot do. `log.warn` reaches the server's stderr;
    // the owner reads a chat. This seam is what `open/wiring/substrates.ts` hands
    // to the gateway's `substrate-notice-sink`, which turns it into a
    // `system_events` row plus a bubble on the owner's chat topic.
    const notices: ModelFloorNotice[] = []
    const model = applyModelFloor({
      requested: LIVE_HAIKU_ID,
      enabled: true,
      sessionKey: 'key-notice',
      source: 'spawn',
      notify: (n) => notices.push(n),
    })
    expect(model).toBe(getBestModel())
    expect(notices.length).toBe(1)
    expect(notices[0]).toEqual({
      sessionKey: 'key-notice',
      source: 'spawn',
      requested: LIVE_HAIKU_ID,
      floor: getBestModel(),
    })
  })

  it('stays quiet when nothing was clamped — an event on correct behaviour is noise', () => {
    const notices: ModelFloorNotice[] = []
    const { lines } = captureWarnings(() =>
      applyModelFloor({
        requested: getBestModel(),
        enabled: true,
        sessionKey: 'key-quiet',
        source: 'spawn',
        notify: (n) => notices.push(n),
      }),
    )
    expect(notices.length).toBe(0)
    expect(lines.filter((l) => l.includes('model_floor_applied')).length).toBe(0)
  })

  it('a throwing notice sink never fails the spawn it is describing', () => {
    const model = applyModelFloor({
      requested: LIVE_HAIKU_ID,
      enabled: true,
      sessionKey: 'key-throw',
      source: 'spawn',
      notify: () => {
        throw new Error('sink is down')
      },
    })
    expect(model).toBe(getBestModel())
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

  it('the pool’s REPLAY reader resolves the poisoned row — and the floor still holds', async () => {
    // THE PRODUCTION READER, not a hand-built spec. `pool.ts` resolves a replay
    // spawn as `record?.model ?? getBestModel()` — the exact `??` that is the
    // whole defect — so this drives `replayPendingInbound` against a seeded row
    // instead of passing the model in itself. A previous revision of this test
    // seeded the row AND passed the same id through `spec(...)`, which meant
    // deleting the seed left it green: it never proved the reader was covered.
    // Here the seed is load-bearing twice over — it is the only source of the
    // spawn's model, and the clamp notice must name it.
    const { host, argvs } = makeCapturingHost()
    const registryPath = join(tempDir('neutron-model-floor-reg-'), 'repl-registry.json')
    const notices: ModelFloorNotice[] = []
    const options = opts(host, {
      user_id: 'u-replay',
      project_id: 'default',
      credential_identity: 'cred-1',
      replRegistryPath: registryPath,
      frontierModelFloor: true,
      onModelFloorApplied: (n) => notices.push(n),
    })
    const sessionKey = poolKeyFor(options)
    const sessionId = '00000000-0000-4000-8000-000000000000'
    upsertRecord(registryPath, {
      sessionKey,
      sessionId,
      cwd: options.cwd!,
      channelName: 'seeded',
      has_session: true,
      model: LIVE_HAIKU_ID,
    })
    expect(getRecord(registryPath, sessionKey)!.model).toBe(LIVE_HAIKU_ID)

    const replayed = await replayPendingInbound(options, {
      sessionKey,
      sessionId,
      cwd: options.cwd!,
      droppedInbound: 'the turn that was dropped when the REPL died',
    })
    expect(replayed).toBe(true)
    expect(argvs.length).toBeGreaterThan(0)
    expect(modelArg(argvs[0]!)).toBe(getBestModel())
    // The clamp NAMED the seeded value — so this assertion cannot pass without
    // the reader having actually read the row.
    expect(notices.map((n) => n.requested)).toEqual([LIVE_HAIKU_ID])
    // …and nothing is left holding the poisoned value.
    const rows = JSON.parse(readFileSync(registryPath, 'utf8')) as Record<
      string,
      { model?: string }
    >
    for (const [key, row] of Object.entries(rows)) {
      expect(row.model, key).not.toBe(LIVE_HAIKU_ID)
    }
  }, SPAWN_TEST_TIMEOUT_MS)

  it('the supervision RESUME reader resolves the poisoned row — the respawn comes up floored', async () => {
    // THE SECOND PRODUCTION READER (`supervision.ts` `resumeSpecFor`), and the one
    // that made the live bug self-perpetuating: every watchdog respawn re-read the
    // row, re-spawned on it, and wrote it back. Spawn clean, poison the row the
    // way the live box was found, then respawn through the REAL actuation.
    const { host, argvs } = makeCapturingHost()
    const registryPath = join(tempDir('neutron-model-floor-reg-'), 'repl-registry.json')
    const notices: ModelFloorNotice[] = []
    const options = opts(host, {
      user_id: 'u-resume',
      project_id: 'default',
      credential_identity: 'cred-1',
      replRegistryPath: registryPath,
      frontierModelFloor: true,
      jsonlExistsProbe: () => true, // pretend the transcript landed → has_session flips
      onModelFloorApplied: (n) => notices.push(n),
    })
    registerSupervisedSubstrate(options)
    await drain(createPersistentReplSubstrate(options).start(spec(getBestModel())))
    const sessionKey = poolKeyFor(options)
    for (let i = 0; i < 200; i++) {
      if (getRecord(registryPath, sessionKey)?.has_session === true) break
      await Bun.sleep(15)
    }
    expect(getRecord(registryPath, sessionKey)?.has_session).toBe(true)
    expect(notices.length).toBe(0) // the clean spawn clamped nothing

    patchRecord(registryPath, sessionKey, { model: LIVE_HAIKU_ID })
    const outcome = respawnReplSession(options, sessionKey, 'wedge-watchdog', 'model-floor-test')
    expect(outcome.ok).toBe(true)
    for (let i = 0; i < 200; i++) {
      if (argvs.length >= 2) break
      await Bun.sleep(15)
    }
    expect(argvs.length).toBeGreaterThanOrEqual(2)
    expect(modelArg(argvs[1]!)).toBe(getBestModel())
    expect(notices.map((n) => n.requested)).toEqual([LIVE_HAIKU_ID])
    expect(notices[0]!.source).toBe('resume')
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
