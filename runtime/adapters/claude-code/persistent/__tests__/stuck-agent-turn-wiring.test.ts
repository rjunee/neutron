/**
 * stuck-agent-turn-wiring.test.ts — proves the stuck_agent watchdog is ACTUALLY
 * WIRED at the dispatch site, by driving a REAL turn through the substrate and
 * reading the ambient ProcessRegistry the detector reads.
 *
 * Why this file exists (F4 round-2 BLOCKER). `pool.ts` is the ONLY production
 * writer of `busy_since` — every other stuck_agent test seeds the registry by
 * hand (`reg.markTurnStarted(...)`). Argus reproduced the gap: deleting the
 * `session.liveHandle?.markTurnStarted(...)` line left the whole watchdog/
 * registry/composition suite GREEN while, in production, `busy_since` would stay
 * null forever → `listStuck` returns [] forever → stuck_agent silently never
 * fires again. That is the CLAUDE.md "built but never wired" forbidden pattern:
 * tests that assert bookkeeping instead of behaviour.
 *
 * So these tests assert the WIRING itself:
 *   1. mid-turn  → the live record is marked busy with the turn's own id
 *   2. on settle → the marker is cleared (no leak → no mirror-image bug)
 *   3. on cancel → the `finally` still clears it (the leak path that matters)
 * and each drives the real `createPersistentReplSubstrate` turn loop, never the
 * registry directly.
 */

import { describe, it, expect, afterEach } from 'bun:test'
import type { PtyChild, PtyHost } from '../pty-host.ts'
import {
  createPersistentReplSubstrate,
  getReplSinkInfo,
  shutdownAllPersistentRepls,
  type PersistentReplSubstrateOptions,
} from '../persistent-repl-substrate.ts'
import {
  ProcessRegistry,
  pushAmbientProcessRegistry,
} from '@neutronai/tools/process-registry.ts'
import { StuckAgentDetector } from '@neutronai/watchdog/detectors.ts'

afterEach(async () => {
  await shutdownAllPersistentRepls()
})

/**
 * A fake `claude` + dev-channel host whose `/message` handler WITHHOLDS the
 * reply until the test opens the gate. That hold is the whole point: it gives
 * the test a window in which a real turn is genuinely in flight, so it can
 * observe what the dispatch site wrote into the registry mid-turn.
 */
function makeGatedHost(): { host: PtyHost; releaseReply: () => void; pid: number } {
  const PID = 4343
  let openGate: () => void = () => {}
  const gate = new Promise<void>((res) => (openGate = res))
  const host: PtyHost = {
    spawn(argv: string[]): PtyChild {
      const i = argv.indexOf('--session-id')
      const sid = (i >= 0 ? argv[i + 1] : argv[argv.indexOf('--resume') + 1]) as string
      const { port: sinkPort, token } = getReplSinkInfo()
      let hasExited = false
      let killedByUs = false
      let resolveExit: (c: number | null) => void = () => {}
      const exited = new Promise<number | null>((res) => (resolveExit = res))
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
          if (url.pathname === '/health') return Response.json({ ok: true })
          if (req.method === 'POST' && url.pathname === '/message') {
            const body = (await req.json()) as { text: string; turn_id?: string }
            // Reply only once the test releases the gate — until then the turn
            // stays genuinely outstanding.
            void gate.then(() =>
              post('/reply', { session_id: sid, text: `ok:${body.text}`, turn_id: body.turn_id }),
            )
            return Response.json({ status: 'delivered' })
          }
          return new Response('not found', { status: 404 })
        },
      })
      void post('/channel-ready', { session_id: sid, channel_port: server.port, pid: PID })
      void post('/channel-bound', { session_id: sid })
      return {
        pid: PID,
        write() {},
        resize() {},
        kill() {
          killedByUs = true
          if (hasExited) return
          hasExited = true
          try {
            server.stop(true)
          } catch {
            /* ignore */
          }
          resolveExit(null)
        },
        exited,
        hasExited: () => hasExited,
        wasKilledByUs: () => killedByUs,
      }
    },
  }
  return { host, releaseReply: () => openGate(), pid: PID }
}

let n = 0
function optsWith(host: PtyHost): PersistentReplSubstrateOptions {
  n += 1
  return {
    substrate_instance_id: `stuck-wiring-${n}-${Math.floor(performance.now())}`,
    cwd: `/tmp/neutron-stuck-wiring-cwd-${n}`,
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
  }
}

async function drainOK(handle: { events: AsyncIterable<{ kind: string }> }): Promise<void> {
  for await (const ev of handle.events) {
    if (ev.kind === 'completion' || ev.kind === 'error') return
  }
}

/** Poll until `pred` holds or the budget elapses (spawn+handshake is async). */
async function until(pred: () => boolean, budgetMs = 5000): Promise<boolean> {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (pred()) return true
    await Bun.sleep(10)
  }
  return pred()
}

describe('stuck_agent — real dispatch-site wiring (F4 round-2 blocker)', () => {
  it('marks the live record BUSY mid-turn and CLEARS it once the turn settles', async () => {
    // MANUAL CLOCK, on the REGISTRY. `listStuck` compares against the
    // ProcessRegistry's OWN `this.now()` (tools/process-registry.ts:286-287),
    // so this is the only clock that can make the mid-turn assertion below
    // deterministic. See the note at the `detect()` call for the flake this
    // replaces — the previous attempt injected a clock into the DETECTOR,
    // which never participates in the comparison at all.
    let clockMs = 1_700_000_000_000
    const reg = new ProcessRegistry({ now: () => clockMs })
    const clear = pushAmbientProcessRegistry(reg)
    try {
      const { host, releaseReply } = makeGatedHost()
      const sub = createPersistentReplSubstrate(optsWith(host))
      const handle = sub.start({ prompt: 'hi', tools: [], model_preference: ['claude-opus-4-7'] })
      const drained = drainOK(handle)

      // MID-TURN: the dispatch site declared the turn outstanding. If the
      // `markTurnStarted` call at the dispatch site is removed, this fails —
      // which is exactly the regression Argus reproduced.
      const marked = await until(() => reg.list()[0]?.busy_turn_id != null)
      expect(marked).toBe(true)
      const rec = reg.list()[0]!
      expect(rec.busy_since).not.toBeNull()
      expect(typeof rec.busy_turn_id).toBe('string')

      // …and a detector run at that moment reports it as stuck (threshold 0),
      // proving the mark is visible through the REAL detector path.
      const detector = new StuckAgentDetector({
        owner_slug: 'owner',
        process_registry: reg,
        inactivity_threshold_ms: 0,
        // Same manual clock as the registry, so alert ids / payload timestamps
        // are deterministic too. NOTE this is NOT what makes the assertion
        // below sound — see the tick immediately after this.
        now: () => clockMs,
      })

      // ── THE FIX (ISSUES #438; flaked in CI 2026-08-02 shard 2/4 and
      // 2026-08-03 shard 3/4, always `Expected: 1, Received: 0` here) ────────
      //
      // `listStuck` is `busy_since !== null && busy_since < this.now() - threshold`
      // with a STRICT `<` and the REGISTRY's own clock. At threshold 0 the record
      // is only stuck once the clock has ticked PAST the instant it was marked.
      // Everything between `markTurnStarted` and this `detect()` is in-memory and
      // routinely finishes inside one millisecond, so under real `Date.now` this
      // was a coin flip on runner scheduling.
      //
      // The PREVIOUS attempt to fix exactly this passed `now: () => Date.now() + 1`
      // to the DETECTOR and documented itself as settling the race. It could not:
      // `detect()` delegates the cutoff to `registry.listStuck(...)`, so the
      // detector's clock is used only for alert ids and payload fields and NEVER
      // for the comparison. The flake survived that fix and its claim of being
      // "verified by mutation" was untestable — the mutation it cited (drop
      // `markTurnStarted`) nulls `busy_since`, which reds with or without the
      // clock, so it could not distinguish the two.
      //
      // Advancing the REGISTRY's clock is what actually states "a detector run at
      // that moment sees it". It does not weaken the assertion: drop
      // `markTurnStarted` at the dispatch site and `busy_since` is null, so the
      // record is filtered regardless of any clock and this still reds.
      clockMs += 1

      const midTurn = await detector.detect()
      expect(midTurn.length).toBe(1)
      expect(midTurn[0]?.payload['turn_id']).toBe(rec.busy_turn_id)

      // Let the turn complete.
      releaseReply()
      await drained

      // SETTLED: marker cleared → the warm REPL is back to its resting state and
      // is never stuck again, however long it stays quiet.
      const settled = await until(() => reg.list()[0]?.busy_since === null)
      expect(settled).toBe(true)
      expect(reg.list()[0]?.busy_turn_id).toBeNull()
      expect(reg.listStuck(0)).toEqual([])
      expect(await detector.detect()).toEqual([])
    } finally {
      clear()
    }
  })

  it('CANCELLING an in-flight turn still clears the marker (the leak path)', async () => {
    const reg = new ProcessRegistry()
    const clear = pushAmbientProcessRegistry(reg)
    try {
      const { host } = makeGatedHost()
      const sub = createPersistentReplSubstrate(optsWith(host))
      // Never release the gate: this turn never gets its reply.
      const handle = sub.start({ prompt: 'hi', tools: [], model_preference: ['claude-opus-4-7'] })
      void drainOK(handle).catch(() => undefined)

      expect(await until(() => reg.list()[0]?.busy_turn_id != null)).toBe(true)

      // The caller gives up. The dispatch site's `finally` must settle the
      // marker — otherwise `busy_since` latches forever and this bug returns
      // inverted: PERMANENT alerts instead of permanent silence.
      await handle.cancel()

      expect(await until(() => reg.list()[0]?.busy_since === null)).toBe(true)
      expect(reg.list()[0]?.busy_turn_id).toBeNull()
      expect(reg.listStuck(0)).toEqual([])
    } finally {
      clear()
    }
  })
})
