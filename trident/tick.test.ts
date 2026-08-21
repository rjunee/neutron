import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedMigratedDb } from '../tests/support/migrated-db.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { TridentRunStore, type MergeMode, type TridentRun } from './store.ts'
import { STALLED_WARN_MS } from './run-progress.ts'
import {
  stubAdvanceDeps,
  type AdvanceDeps,
  type AdvanceOutcome,
  type SubagentOutcome,
} from './state-machine.ts'
import { TridentTickLoop } from './tick.ts'
import { buildTridentTerminator } from './terminate.ts'
import { buildTridentDelivery, type OutboundSink } from './delivery.ts'
import type { OutgoingMessage } from '@neutronai/channels/types.ts'

let tmp: string
let db: ProjectDb

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-trident-tick-'))
  seedMigratedDb(join(tmp, 'project.db'))
  db = ProjectDb.open(join(tmp, 'project.db'))
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

const fixedNow = '2026-01-01T01:00:00.000Z'

/** Deps that report a fixed outcome for whichever run is classified. */
function depsWith(outcome: SubagentOutcome): AdvanceDeps {
  return { now: () => fixedNow, classify: async () => outcome }
}

/** A recording outbound sink — captures every message the delivery hook sends. */
function recordingSink(): { sink: OutboundSink; sent: OutgoingMessage[] } {
  const sent: OutgoingMessage[] = []
  return {
    sent,
    sink: {
      async send(message) {
        sent.push(message)
        return `msg-${sent.length}`
      },
    },
  }
}

describe('TridentTickLoop.runOnce', () => {
  test('advances every non-terminal run whose sub-agent completed', async () => {
    const store = new TridentRunStore(db)
    const a = await store.create({ slug: 'a', project_slug: 't1', repo_path: '/r', task: 't' })
    const b = await store.create({ slug: 'b', project_slug: 't1', repo_path: '/r', task: 't' })

    const loop = new TridentTickLoop({ store, deps: depsWith({ status: 'completed', result: {} }) })
    const res = await loop.runOnce()

    // both forge-init → argus
    expect(res.advanced).toBe(2)
    expect(store.get(a.id)?.phase).toBe('argus')
    expect(store.get(b.id)?.phase).toBe('argus')
  })

  test('does not touch terminal runs (only queries non-terminal)', async () => {
    const store = new TridentRunStore(db)
    const done = await store.create({ slug: 'done', project_slug: 't1', repo_path: '/r', task: 't' })
    await store.save({ ...done, phase: 'done' })
    const active = await store.create({ slug: 'active', project_slug: 't1', repo_path: '/r', task: 't' })

    const loop = new TridentTickLoop({ store, deps: depsWith({ status: 'completed', result: {} }) })
    const res = await loop.runOnce()

    expect(res.advanced).toBe(1)
    expect(store.get(done.id)?.phase).toBe('done')
    expect(store.get(active.id)?.phase).toBe('argus')
  })

  test('idempotent: a running sub-agent advances nothing', async () => {
    const store = new TridentRunStore(db)
    const a = await store.create({ slug: 'a', project_slug: 't1', repo_path: '/r', task: 't' })
    const loop = new TridentTickLoop({ store, deps: stubAdvanceDeps(() => fixedNow) })

    expect((await loop.runOnce()).advanced).toBe(0)
    expect((await loop.runOnce()).advanced).toBe(0)
    expect(store.get(a.id)?.phase).toBe('forge-init')
  })

  test('per_tick_limit caps the per-tick advance count', async () => {
    const store = new TridentRunStore(db)
    for (let i = 0; i < 5; i++) {
      await store.create({ slug: `r${i}`, project_slug: 't1', repo_path: '/r', task: 't' })
    }
    const loop = new TridentTickLoop({
      store,
      deps: depsWith({ status: 'completed', result: {} }),
      per_tick_limit: 2,
    })
    expect((await loop.runOnce()).advanced).toBe(2)
    // 3 still in forge-init
    expect(store.listNonTerminal().filter((r) => r.phase === 'forge-init').length).toBe(3)
  })

  test('a single run advance error does not abort the tick', async () => {
    const store = new TridentRunStore(db)
    await store.create({ slug: 'a', project_slug: 't1', repo_path: '/r', task: 't' })
    await store.create({ slug: 'b', project_slug: 't1', repo_path: '/r', task: 't' })

    let calls = 0
    const flakyDeps: AdvanceDeps = {
      now: () => fixedNow,
      classify: async () => {
        calls++
        if (calls === 1) throw new Error('classify boom')
        return { status: 'completed', result: {} }
      },
    }
    const loop = new TridentTickLoop({ store, deps: flakyDeps })
    const res = await loop.runOnce()
    // one threw, the other advanced
    expect(res.advanced).toBe(1)
  })

  // ── Async result delivery (gap-audit P0-1) ──────────────────────────
  //
  // Integration: a REAL store + REAL loop + REAL delivery hook (only the
  // channel boundary is faked) — prove that a run reaching a terminal
  // phase actually invokes the outbound post with the run's persisted
  // chat_id/thread_id + the expected payload.
  describe('terminal delivery', () => {
    test('a run reaching `done` posts the result to its originating chat topic', async () => {
      const store = new TridentRunStore(db)
      // Seed a run mid-review (phase=argus) carrying the originating chat.
      const created = await store.create({
        slug: 'add-flag',
        project_slug: 't1',
        repo_path: '/r',
        task: 'add a feature flag',
        branch: 'trident/add-flag',
        chat_id: '12345',
        thread_id: '678',
      })
      await store.save({ ...store.get(created.id)!, phase: 'argus' })

      const { sink, sent } = recordingSink()
      const loop = new TridentTickLoop({
        store,
        // Argus APPROVE → done (terminal). No orchestrator/merge — the pure
        // state machine reaches `done`, which is the delivery trigger.
        deps: depsWith({ status: 'completed', result: { approved: true } }),
        on_terminal: buildTridentDelivery({ sink }),
      })

      const res = await loop.runOnce()

      expect(res.advanced).toBe(1)
      expect(store.get(created.id)?.phase).toBe('done')
      // The outbound post fired exactly once, addressed to the run's chat.
      expect(sent.length).toBe(1)
      expect(sent[0]!.topic.channel_kind).toBe('telegram')
      expect(sent[0]!.topic.channel_topic_id).toBe('12345:678')
      expect(sent[0]!.text).toContain('merged and deployed')
      expect(sent[0]!.text).toContain('add a feature flag')
      expect(loop.stats().delivered).toBe(1)
    })

    test('a run reaching `failed` also delivers (terminal, not just the happy path)', async () => {
      const store = new TridentRunStore(db)
      // A crashed sub-agent drives forge-init → failed in one step.
      const run = await store.create({
        slug: 'boom',
        project_slug: 't1',
        repo_path: '/r',
        task: 'do a risky thing',
        chat_id: '999',
        thread_id: null,
      })

      const { sink, sent } = recordingSink()
      const loop = new TridentTickLoop({
        store,
        deps: depsWith({ status: 'crashed', reason: 'sub-agent crashed' }),
        on_terminal: buildTridentDelivery({ sink }),
      })

      await loop.runOnce()

      expect(store.get(run.id)?.phase).toBe('failed')
      expect(sent.length).toBe(1)
      // chat_id only (no thread) → bare channel_topic_id.
      expect(sent[0]!.topic.channel_topic_id).toBe('999')
      // #352 — the terminal-failure announce is INTERPRETED into plain language
      // (leading ❌ + a human-facing summary), not a raw "build failed: <reason>".
      expect(sent[0]!.text).toContain('❌')
      expect(sent[0]!.text).toContain('sub-agent crashed')
    })

    test('a NON-terminal transition does not deliver', async () => {
      const store = new TridentRunStore(db)
      // forge-init → argus is a real (changed) transition but NOT terminal.
      await store.create({
        slug: 'mid',
        project_slug: 't1',
        repo_path: '/r',
        task: 't',
        chat_id: '1',
        thread_id: '2',
      })
      const { sink, sent } = recordingSink()
      const loop = new TridentTickLoop({
        store,
        deps: depsWith({ status: 'completed', result: {} }),
        on_terminal: buildTridentDelivery({ sink }),
      })

      const res = await loop.runOnce()
      expect(res.advanced).toBe(1) // advanced forge-init → argus
      expect(sent.length).toBe(0) // but did not post — argus is non-terminal
      expect(loop.stats().delivered).toBe(0)
    })

    test('a run with no originating chat reaches done WITHOUT posting', async () => {
      const store = new TridentRunStore(db)
      const run = await store.create({ slug: 'cron', project_slug: 't1', repo_path: '/r', task: 't' })
      await store.save({ ...store.get(run.id)!, phase: 'argus' })

      const { sink, sent } = recordingSink()
      const loop = new TridentTickLoop({
        store,
        deps: depsWith({ status: 'completed', result: { approved: true } }),
        on_terminal: buildTridentDelivery({ sink }),
      })

      await loop.runOnce()
      expect(store.get(run.id)?.phase).toBe('done')
      expect(sent.length).toBe(0) // chat_id === null → no-op inside the hook
    })

    test('a delivery failure does not un-terminate the run nor abort the tick', async () => {
      const store = new TridentRunStore(db)
      const a = await store.create({
        slug: 'a',
        project_slug: 't1',
        repo_path: '/r',
        task: 'first',
        chat_id: '1',
        thread_id: null,
      })
      const b = await store.create({
        slug: 'b',
        project_slug: 't1',
        repo_path: '/r',
        task: 'second',
        chat_id: '2',
        thread_id: null,
      })
      await store.save({ ...store.get(a.id)!, phase: 'argus' })
      await store.save({ ...store.get(b.id)!, phase: 'argus' })

      const failingHook = buildTridentDelivery({
        sink: { async send() { throw new Error('telegram down') } },
      })
      const loop = new TridentTickLoop({
        store,
        deps: depsWith({ status: 'completed', result: { approved: true } }),
        on_terminal: failingHook,
      })

      // The tick must not throw, both runs must still land `done`.
      const res = await loop.runOnce()
      expect(res.advanced).toBe(2)
      expect(store.get(a.id)?.phase).toBe('done')
      expect(store.get(b.id)?.phase).toBe('done')
      // Delivery never succeeded, so the delivered counter stays 0.
      expect(loop.stats().delivered).toBe(0)
    })
  })

  test('start is idempotent; stop clears the timer', () => {
    const store = new TridentRunStore(db)
    const loop = new TridentTickLoop({ store, deps: stubAdvanceDeps(), tick_interval_ms: 60_000 })
    loop.start()
    loop.start() // no throw, no double-timer
    loop.stop()
    loop.stop() // safe to stop twice
    expect(loop.stats().advanced).toBe(0)
  })
})

describe('TridentTickLoop — on_transition (M1 UX REDESIGN live-progress fan)', () => {
  test('fires on first observation, on each checkpoint advance, and on the terminal transition — never on a no-op', async () => {
    const store = new TridentRunStore(db)
    const r = await store.create({ slug: 'x', project_slug: 't1', repo_path: '/r', task: 't' })

    const seen: Array<{ id: string; cp: string | null; phase: string }> = []
    const on_transition = {
      async onTransition(run: TridentRun): Promise<void> {
        seen.push({ id: run.id, cp: run.inner_checkpoint, phase: run.phase })
      },
    }

    // A controllable step: waits in-flight (changed:false) until `terminalNow`,
    // then transitions the run to `done` (changed:true).
    let terminalNow = false
    const step = async (run: TridentRun): Promise<AdvanceOutcome> =>
      terminalNow
        ? { run: { ...run, phase: 'done' as const }, changed: true, waiting: false, note: 'done' }
        : { run, changed: false, waiting: true, note: 'waiting' }

    const loop = new TridentTickLoop({ store, step, on_transition })

    // Tick 1 — first observation of a fresh run → fan.
    await loop.runOnce()
    expect(seen.length).toBe(1)
    expect(seen[0]!.cp).toBeNull()

    // Tick 2 — nothing advanced → NO fan (the poll-killer must be quiet when idle).
    await loop.runOnce()
    expect(seen.length).toBe(1)

    // Checkpoint advance (inner workflow re-stamped) → fan.
    await store.update(r.id, { inner_checkpoint: 'forge-done' })
    await loop.runOnce()
    expect(seen.length).toBe(2)
    expect(seen[1]!.cp).toBe('forge-done')

    // Another advance → fan.
    await store.update(r.id, { inner_checkpoint: 'argus-approved' })
    await loop.runOnce()
    expect(seen.length).toBe(3)
    expect(seen[2]!.cp).toBe('argus-approved')

    // Terminal transition → fan (the rail must drop this run from live_runs).
    terminalNow = true
    await loop.runOnce()
    expect(seen.length).toBe(4)
    expect(seen[3]!.phase).toBe('done')

    expect(loop.stats().transitions).toBe(4)
  })

  test('§F6a race: a run terminalized out-of-band during `step` is NOT clobbered and delivers ONCE', async () => {
    // Codex's exact lost-update schedule: the tick loads a non-terminal run and
    // awaits `step`; DURING that await a board DELETE wins `terminate('stopped')`
    // and fires its observers; then `step` returns a terminal `done`. Without the
    // conditional commit the tick would `save('done')` over `stopped` AND fire its
    // own terminal delivery again — a lost update + a double-notify.
    const store = new TridentRunStore(db)
    const r = await store.create({ slug: 's', project_slug: 't1', repo_path: '/r', task: 't' })

    // ONE shared delivery recorder: the out-of-band terminate fires it once; a
    // second entry would be the tick re-delivering (the bug this guards).
    const deliveries: Array<{ id: string; phase: string }> = []
    const observer = {
      async onTerminal(run: TridentRun): Promise<void> {
        deliveries.push({ id: run.id, phase: run.phase })
      },
    }
    const terminator = buildTridentTerminator({ store, observer })

    const step = async (run: TridentRun): Promise<AdvanceOutcome> => {
      // The board DELETE lands mid-step: wins the terminal transition + observes.
      await terminator.terminate(run.id, 'stopped', { reason: 'user cancel' })
      // The in-flight step then reports its own (now-stale) terminal outcome.
      return { run: { ...run, phase: 'done' as const }, changed: true, waiting: false, note: 'done' }
    }

    const loop = new TridentTickLoop({ store, step, on_terminal: observer })
    const res = await loop.runOnce()

    // The tick's conditional `saveIfActive` LOST — the cancellation is authoritative.
    expect(store.get(r.id)?.phase).toBe('stopped')
    expect(store.get(r.id)?.failure_reason).toBe('user cancel')
    // The rejected write counts as no advance.
    expect(res.advanced).toBe(0)
    // Exactly ONE terminal delivery — the terminate's `stopped`. The tick did NOT
    // re-fire `done` (the double-notify this fix prevents).
    expect(deliveries).toEqual([{ id: r.id, phase: 'stopped' }])
  })

  test('§F6a r9: a concurrent cancel after a non-terminal save is NOT masked by a stale fan', async () => {
    // The tick commits a non-terminal advance; before the transition fan, a board
    // DELETE atomically terminalizes the SAME row. The fan must reflect the
    // COMMITTED (terminal) state — the tick reloads — not the stale non-terminal
    // snapshot, which would RESTORE the just-cancelled run in the rail's live_runs.
    const store = new TridentRunStore(db)
    const r = await store.create({ slug: 's', project_slug: 't1', repo_path: '/r', task: 't' })

    const fanned: string[] = []
    const on_transition = {
      async onTransition(run: TridentRun): Promise<void> {
        fanned.push(run.phase)
      },
    }

    // A store whose saveIfActive commits the non-terminal advance AND then models
    // the concurrent board DELETE terminalizing the row right after our save wins.
    const racing = {
      listNonTerminal: (n: number) => store.listNonTerminal(n),
      get: (id: string) => store.get(id),
      save: (run: TridentRun) => store.save(run),
      saveIfActive: async (run: TridentRun) => {
        const won = await store.saveIfActive(run) // writes 'argus' (non-terminal)
        await store.terminalTransition(r.id, { phase: 'stopped' }) // DELETE lands right after
        return won
      },
    } as unknown as TridentRunStore

    const step = async (run: TridentRun): Promise<AdvanceOutcome> => ({
      run: { ...run, phase: 'argus' as const },
      changed: true,
      waiting: false,
      note: 'advance',
    })

    const loop = new TridentTickLoop({ store: racing, step, on_transition })
    await loop.runOnce()

    // The fan saw the CURRENT terminal state, NOT the stale 'argus' (no restore).
    expect(fanned).toEqual(['stopped'])
    expect(store.get(r.id)?.phase).toBe('stopped')
  })

  test('fans exactly once when a live run ages past the display-stall threshold', async () => {
    const store = new TridentRunStore(db)
    const r = await store.create({ slug: 's', project_slug: 't1', repo_path: '/r', task: 't' })
    const advancedMs = Date.parse(store.get(r.id)!.last_advanced_at)

    const seen: string[] = []
    const on_transition = {
      async onTransition(run: TridentRun): Promise<void> {
        seen.push(run.id)
      },
    }
    const step = async (run: TridentRun): Promise<AdvanceOutcome> => ({
      run,
      changed: false,
      waiting: true,
      note: 'waiting',
    })

    let nowMs = advancedMs + 1_000 // just after start — not stalled
    const loop = new TridentTickLoop({ store, step, on_transition, now: () => nowMs })

    await loop.runOnce() // first observation → fan
    expect(seen.length).toBe(1)
    await loop.runOnce() // unchanged + not stalled → no fan
    expect(seen.length).toBe(1)

    nowMs = advancedMs + STALLED_WARN_MS + 60_000 // crossed the stall threshold
    await loop.runOnce() // stall crossing → fan
    expect(seen.length).toBe(2)
    await loop.runOnce() // still stalled, nothing else changed → no repeat fan
    expect(seen.length).toBe(2)
  })

  test('a throwing on_transition never aborts the tick', async () => {
    const store = new TridentRunStore(db)
    await store.create({ slug: 'a', project_slug: 't1', repo_path: '/r', task: 't' })
    await store.create({ slug: 'b', project_slug: 't1', repo_path: '/r', task: 't' })

    const on_transition = {
      async onTransition(): Promise<void> {
        throw new Error('fan sink down')
      },
    }
    const step = async (run: TridentRun): Promise<AdvanceOutcome> => ({
      run,
      changed: false,
      waiting: true,
      note: 'waiting',
    })
    const loop = new TridentTickLoop({ store, step, on_transition })
    // Both runs observed; both fans throw and are swallowed — the tick completes.
    const res = await loop.runOnce()
    expect(res.skipped_due_to_overlap).toBe(false)
    expect(loop.stats().transitions).toBe(0) // a throwing fan does not count
  })
})

describe('TridentTickLoop.wake', () => {
  /** Poll until `done()` or the bound elapses (the wake path is fire-and-forget). */
  async function waitFor(done: () => boolean, budgetMs = 2_000): Promise<void> {
    const deadline = Date.now() + budgetMs
    while (!done() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
  }

  test('wake() fires the full tick body without waiting for the 90 s interval', async () => {
    const store = new TridentRunStore(db)
    const r = await store.create({ slug: 'w', project_slug: 't1', repo_path: '/r', task: 't' })

    const stepped: string[] = []
    const step = async (run: TridentRun): Promise<AdvanceOutcome> => {
      stepped.push(run.id)
      return { run, changed: false, waiting: true, note: 'waiting' }
    }

    // Default tick_interval_ms (90 s) — the periodic timer CANNOT fire inside
    // this test, so any tick observed here came from `wake()`.
    const loop = new TridentTickLoop({ store, step })
    loop.start()
    loop.wake()
    await waitFor(() => stepped.length >= 1)
    await loop.stop()

    expect(stepped).toEqual([r.id])
  })

  test('wake() before start() is a no-op', async () => {
    const store = new TridentRunStore(db)
    await store.create({ slug: 'w2', project_slug: 't1', repo_path: '/r', task: 't' })

    const stepped: string[] = []
    const step = async (run: TridentRun): Promise<AdvanceOutcome> => {
      stepped.push(run.id)
      return { run, changed: false, waiting: true, note: 'waiting' }
    }

    const loop = new TridentTickLoop({ store, step })
    loop.wake() // never started → dropped
    await new Promise((r) => setTimeout(r, 50))
    expect(stepped.length).toBe(0)
    await loop.stop() // safe pre-start
  })
})

describe('TridentTickLoop — change watcher (wake-on-change)', () => {
  /** Poll until `done()` or the bound elapses (the wake path is fire-and-forget). */
  async function waitFor(done: () => boolean, budgetMs = 2_000): Promise<void> {
    const deadline = Date.now() + budgetMs
    while (!done() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
  }

  /** Every tick-body execution is observable as a `stepped` entry. */
  function recordingStep(stepped: string[]) {
    return async (run: TridentRun): Promise<AdvanceOutcome> => {
      stepped.push(run.id)
      return { run, changed: false, waiting: true, note: 'waiting' }
    }
  }

  test('an out-of-band checkpoint bump causes a full tick within one watcher cadence', async () => {
    const store = new TridentRunStore(db)
    const run = await store.create({ slug: 'cw1', project_slug: 't1', repo_path: '/r', task: 't' })
    const stepped: string[] = []

    // The 90 s-class backstop can NEVER fire in-test, so any tick observed
    // here came from the watcher's wake().
    const loop = new TridentTickLoop({
      store,
      step: recordingStep(stepped),
      tick_interval_ms: 600_000,
      watch_interval_ms: 25,
    })
    loop.start()
    // Several cadences: the FIRST observation has definitely been recorded.
    await new Promise((r) => setTimeout(r, 150))
    expect(stepped.length).toBe(0) // the boot observation never wakes

    // Simulate checkpoint.sh: `update` re-stamps `last_advanced_at`, exactly
    // what the shell UPDATE does.
    await store.update(run.id, { inner_checkpoint: 'building' })

    await waitFor(() => stepped.length >= 1)
    expect(stepped[0]).toBe(run.id)
    await loop.stop()
  })

  test('a quiet interval fires zero extra tick bodies', async () => {
    const store = new TridentRunStore(db)
    await store.create({ slug: 'cw2', project_slug: 't1', repo_path: '/r', task: 't' })
    const stepped: string[] = []

    const loop = new TridentTickLoop({
      store,
      step: recordingStep(stepped),
      tick_interval_ms: 600_000,
      watch_interval_ms: 25,
    })
    loop.start()
    await new Promise((r) => setTimeout(r, 300)) // ~12 cadences
    expect(stepped.length).toBe(0) // a detector, not a faster sweep
    await loop.stop()
  })

  test('a throwing changeSignature never stops the interval backstop', async () => {
    class ThrowingStore extends TridentRunStore {
      changeSignature(): string {
        throw new Error('database is locked')
      }
    }
    const store = new ThrowingStore(db)
    await store.create({ slug: 'cw3', project_slug: 't1', repo_path: '/r', task: 't' })
    const stepped: string[] = []

    const loop = new TridentTickLoop({
      store,
      step: recordingStep(stepped),
      tick_interval_ms: 50,
      watch_interval_ms: 10,
    })
    loop.start()
    // The interval backstop still ticks while the watcher throws every 10 ms.
    await waitFor(() => stepped.length >= 1)
    expect(stepped.length).toBeGreaterThanOrEqual(1)
    await loop.stop() // stop still quiesces a failing watcher
  })

  test('stop() quiesces the watcher — no wake after shutdown', async () => {
    const store = new TridentRunStore(db)
    const run = await store.create({ slug: 'cw4', project_slug: 't1', repo_path: '/r', task: 't' })
    const stepped: string[] = []

    const loop = new TridentTickLoop({
      store,
      step: recordingStep(stepped),
      tick_interval_ms: 600_000,
      watch_interval_ms: 25,
    })
    loop.start()
    await new Promise((r) => setTimeout(r, 100))
    await loop.stop()

    await store.update(run.id, { inner_checkpoint: 'reviewing' })
    await new Promise((r) => setTimeout(r, 150))
    expect(stepped.length).toBe(0)
  })

  test('a tick that WRITES does not wake itself again — one change, one sweep', async () => {
    // THE AMPLIFICATION BUG, as a test. `saveIfActive` re-stamps `last_advanced_at`
    // on every run the sweep advances, so the tick's own writes move the very
    // signature the watcher compares against: one run reporting `changed` used to
    // re-fire a full `listNonTerminal(50)` × per-run git/gh sweep on EVERY watcher
    // cadence, for as long as it kept reporting change. The existing guard test uses
    // a `changed: false` step and cannot see this at all.
    const store = new TridentRunStore(db)
    const run = await store.create({ slug: 'cw6', project_slug: 't1', repo_path: '/r', task: 't' })
    const stepped: string[] = []
    // ONE run and one `stepped` push per sweep, so `stepped.length` IS the number of
    // full tick bodies that ran.
    const step = async (r: TridentRun): Promise<AdvanceOutcome> => {
      stepped.push(r.id)
      return { run: r, changed: true, waiting: false, note: 'advanced' }
    }

    const loop = new TridentTickLoop({
      store,
      step,
      tick_interval_ms: 600_000, // the backstop cannot fire in-test
      watch_interval_ms: 25,
    })
    loop.start()
    await new Promise((r) => setTimeout(r, 100)) // boot observation recorded, no wake
    expect(stepped.length).toBe(0)

    // ONE external change — the checkpoint an out-of-process workflow writes.
    await store.update(run.id, { inner_checkpoint: 'building' })
    await waitFor(() => stepped.length >= 1)

    // …and then a dozen more watcher cadences with nothing external happening.
    await new Promise((r) => setTimeout(r, 300))
    expect(stepped.length).toBe(1)
    await loop.stop()
  })

  test('a SECOND external change after a writing tick still wakes promptly', async () => {
    // The other half: damping must not become deafness. Absorbing the sweep's own
    // writes may not absorb the NEXT out-of-process checkpoint.
    const store = new TridentRunStore(db)
    const run = await store.create({ slug: 'cw7', project_slug: 't1', repo_path: '/r', task: 't' })
    const stepped: string[] = []
    const step = async (r: TridentRun): Promise<AdvanceOutcome> => {
      stepped.push(r.id)
      return { run: r, changed: true, waiting: false, note: 'advanced' }
    }

    const loop = new TridentTickLoop({
      store,
      step,
      tick_interval_ms: 600_000,
      watch_interval_ms: 25,
    })
    loop.start()
    await new Promise((r) => setTimeout(r, 100))

    await store.update(run.id, { inner_checkpoint: 'building' })
    await waitFor(() => stepped.length >= 1)
    await new Promise((r) => setTimeout(r, 100))

    await store.update(run.id, { inner_checkpoint: 'reviewing' })
    await waitFor(() => stepped.length >= 2)
    expect(stepped.length).toBe(2)
    await loop.stop()
  })

  test('an out-of-process checkpoint that lands DURING an advancing sweep still wakes the next one', async () => {
    // ARGUS r2, THE CONFIRMED MAJOR — reproduced here as the regression guard. The
    // first fix damped the sweep's own writes by RE-SAMPLING the signature at the
    // tick's tail whenever the tick had written anything, which also absorbed every
    // out-of-process checkpoint that landed after the sweep took its own sample.
    // Under the multi-lane workload this card targets that is the common case (a
    // sweep advances lane A while lane B's inner workflow checkpoints), and the
    // absorbed handoff then waited out the 90 s backstop — the exact latency the
    // watcher exists to remove.
    //
    // The injected write is deliberately made from INSIDE the sweep, before the
    // sweep's own `saveIfActive`, so B's stamp is OLDER than the stamp the tick
    // leaves on A: an aggregate MAX cannot tell that apart from "only my own
    // writes", which is why the detector is per-run.
    const store = new TridentRunStore(db)
    const a = await store.create({ slug: 'cw9a', project_slug: 't1', repo_path: '/r', task: 't' })
    const b = await store.create({ slug: 'cw9b', project_slug: 't1', repo_path: '/r', task: 't' })
    const stepped: string[] = []
    let injected = false
    // `listNonTerminal` orders by `last_advanced_at ASC`, so A (created first) is
    // stepped first and its commit stamps AFTER the injected checkpoint on B.
    const step = async (r: TridentRun): Promise<AdvanceOutcome> => {
      stepped.push(r.slug)
      if (r.id === a.id && !injected) {
        injected = true
        await store.update(b.id, { inner_checkpoint: 'building' })
      }
      // Only A advances, so the tick WRITES — the condition under which the old
      // settle re-sampled and swallowed B's checkpoint.
      return { run: r, changed: r.id === a.id, waiting: false, note: 'advanced' }
    }

    const loop = new TridentTickLoop({
      store,
      step,
      tick_interval_ms: 600_000, // the backstop cannot fire in-test
      watch_interval_ms: 25,
    })
    loop.start()
    await new Promise((r) => setTimeout(r, 100)) // boot observation, no wake
    expect(stepped.length).toBe(0)

    // One external checkpoint kicks off sweep #1 (2 runs); B's mid-sweep checkpoint
    // must produce sweep #2 (2 more) within a cadence or two, NOT in 90 s.
    await store.update(a.id, { inner_checkpoint: 'building' })
    await waitFor(() => stepped.length >= 4)
    expect(stepped.length).toBeGreaterThanOrEqual(4)

    // …and it must then go quiet: nothing external happens after sweep #2, so the
    // sweep's own writes may not keep re-waking it.
    const settled = stepped.length
    await new Promise((r) => setTimeout(r, 300)) // ~12 cadences
    expect(stepped.length).toBe(settled)
    await loop.stop()
  })

  test('a run RE-STAMPED after the sweep committed it is not mistaken for the sweep own write', async () => {
    // The narrow half of the same finding: the sweep's ledger records the stamp ITS
    // write left, so a checkpoint that lands on the very run the sweep advanced —
    // after the commit, before the settle — is still a difference. Injected from the
    // transition fan, which runs after `saveIfActive`.
    //
    // The injected clock makes every write's stamp DISTINCT. In-process, the fan's
    // write lands microseconds after the sweep's own and the two share a millisecond
    // — the one residual this detector has (a same-run, same-millisecond overwrite
    // reads as the sweep's own write and waits for the backstop). That is a property
    // of the column's resolution, not of the rule under test, so the test does not
    // depend on it.
    let ticks = 0
    const base = Date.now()
    const store = new TridentRunStore(db, () => new Date(base + ticks++ * 1_000).toISOString())
    const run = await store.create({ slug: 'cw10', project_slug: 't1', repo_path: '/r', task: 't' })
    const stepped: string[] = []
    let injected = false
    const step = async (r: TridentRun): Promise<AdvanceOutcome> => {
      stepped.push(r.id)
      return { run: r, changed: true, waiting: false, note: 'advanced' }
    }
    const on_transition = {
      async onTransition(): Promise<void> {
        if (injected) return
        injected = true
        await store.update(run.id, { inner_checkpoint: 'reviewing' })
      },
    }

    const loop = new TridentTickLoop({
      store,
      step,
      on_transition,
      tick_interval_ms: 600_000,
      watch_interval_ms: 25,
    })
    loop.start()
    await new Promise((r) => setTimeout(r, 100))

    await store.update(run.id, { inner_checkpoint: 'building' })
    await waitFor(() => stepped.length >= 2)
    expect(stepped.length).toBeGreaterThanOrEqual(2)

    const settled = stepped.length
    await new Promise((r) => setTimeout(r, 300))
    expect(stepped.length).toBe(settled)
    await loop.stop()
  })

  test('a sweep whose row read THROWS does not absorb the change it was woken for', async () => {
    // ARGUS r3. The settle runs in a `finally`, and with an empty ledger it adopted
    // `sweptSig` — the signature sampled AFTER the change landed but BEFORE any row
    // was read. So a tick that threw out of `listNonTerminal` (locked DB, closed
    // handle) recorded the pending change as "seen" while having seen nothing: the
    // wake was consumed, no work happened, and the handoff waited out the 90 s
    // backstop. A sweep that never read its rows may not move the baseline.
    let failNextList = false
    class FlakyStore extends TridentRunStore {
      override listNonTerminal(limit?: number): TridentRun[] {
        if (failNextList) {
          failNextList = false
          throw new Error('database is locked')
        }
        return super.listNonTerminal(limit)
      }
    }
    const store = new FlakyStore(db)
    const run = await store.create({ slug: 'cw12', project_slug: 't1', repo_path: '/r', task: 't' })
    const stepped: string[] = []

    const loop = new TridentTickLoop({
      store,
      step: recordingStep(stepped),
      tick_interval_ms: 600_000, // the backstop cannot fire in-test
      watch_interval_ms: 25,
    })
    loop.start()
    await new Promise((r) => setTimeout(r, 100)) // boot observation, no wake
    expect(stepped.length).toBe(0)

    // The next sweep dies on its row read. The checkpoint that woke it is still
    // unswept, so the watcher must keep seeing it and re-fire — promptly, not in 90 s.
    failNextList = true
    await store.update(run.id, { inner_checkpoint: 'building' })
    await waitFor(() => stepped.length >= 1)
    expect(stepped[0]).toBe(run.id)

    // …and once a sweep DOES read the rows, the retry stops: no spin.
    const settled = stepped.length
    await new Promise((r) => setTimeout(r, 300)) // ~12 cadences
    expect(stepped.length).toBe(settled)
    await loop.stop()
  })

  test('watch_interval_ms: NaN disables the watcher instead of arming a ~1 ms timer', async () => {
    // `NaN <= 0` is FALSE, so a bare `<= 0` disable check let a NaN cadence through
    // to `setInterval(fn, NaN)`, which clamps to ~1 ms: a ~500 Hz signature query
    // where the caller asked for no watcher at all.
    const store = new TridentRunStore(db)
    const run = await store.create({ slug: 'cw11', project_slug: 't1', repo_path: '/r', task: 't' })
    const stepped: string[] = []

    const loop = new TridentTickLoop({
      store,
      step: recordingStep(stepped),
      tick_interval_ms: 600_000,
      watch_interval_ms: Number.NaN,
    })
    loop.start()
    expect(loop.describeAll().map((d) => d.name)).toEqual(['trident'])
    await store.update(run.id, { inner_checkpoint: 'building' })
    await new Promise((r) => setTimeout(r, 150))
    expect(stepped.length).toBe(0)
    await loop.stop()
  })

  test('stop() drops the observed signature — a re-armed loop does not wake for a dead lifetime', async () => {
    // The baseline is a comparison against a MOMENT, and that moment ends at
    // shutdown. A `stop()` → `start()` re-arm that kept it would fire a sweep for
    // change some other lifetime already handled; the boot rule (first observation
    // records, never wakes) is the right behaviour, and the interval backstop is
    // what covers whatever moved while the loop was down.
    const store = new TridentRunStore(db)
    const run = await store.create({ slug: 'cw8', project_slug: 't1', repo_path: '/r', task: 't' })
    const stepped: string[] = []

    const loop = new TridentTickLoop({
      store,
      step: recordingStep(stepped),
      tick_interval_ms: 600_000,
      watch_interval_ms: 25,
    })
    loop.start()
    await new Promise((r) => setTimeout(r, 100))
    await loop.stop()

    await store.update(run.id, { inner_checkpoint: 'reviewing' })
    loop.start()
    await new Promise((r) => setTimeout(r, 200)) // ~8 cadences
    expect(stepped.length).toBe(0)
    await loop.stop()
  })

  test('describeAll() surfaces BOTH timers to the loop inventory', async () => {
    // An unregistered timer is one the inventory reports as healthy by never
    // mentioning it: the watcher can be failing every 2 s and the only evidence is
    // `watch_failed` log lines, while the inventory shows one contented 90 s loop.
    const store = new TridentRunStore(db)
    const loop = new TridentTickLoop({ store, step: recordingStep([]), watch_interval_ms: 25 })
    loop.start()

    const names = loop.describeAll().map((d) => d.name)
    expect(names).toEqual(['trident', 'trident-watch'])
    expect(loop.describeAll().map((d) => d.cadenceMs)).toEqual([90_000, 25])
    // `describe()` is unchanged for single-loop callers.
    expect(loop.describe().name).toBe('trident')
    await loop.stop()
  })

  test('describeAll() reports only the sweep when the watcher is disabled', async () => {
    const store = new TridentRunStore(db)
    const loop = new TridentTickLoop({ store, step: recordingStep([]), watch_interval_ms: 0 })
    loop.start()
    expect(loop.describeAll().map((d) => d.name)).toEqual(['trident'])
    await loop.stop()
  })

  test('watch_interval_ms: 0 disables the watcher', async () => {
    const store = new TridentRunStore(db)
    const run = await store.create({ slug: 'cw5', project_slug: 't1', repo_path: '/r', task: 't' })
    const stepped: string[] = []

    const loop = new TridentTickLoop({
      store,
      step: recordingStep(stepped),
      tick_interval_ms: 600_000,
      watch_interval_ms: 0,
    })
    loop.start()
    await store.update(run.id, { inner_checkpoint: 'building' })
    await new Promise((r) => setTimeout(r, 150))
    expect(stepped.length).toBe(0)
    await loop.stop()
  })
})

describe('TridentTickLoop — as-built catch-up (T2 self-heal)', () => {
  test('the ordinary tick folds once per repo, including repos whose only runs are terminal', async () => {
    let second = 0
    const store = new TridentRunStore(
      db,
      () => new Date(Date.UTC(2026, 7, 18, 0, 0, second++)).toISOString(),
    )
    const a1 = await store.create({
      slug: 'as-built-a1', project_slug: 't1', repo_path: '/repo-a', task: 't', merge_mode: 'pr',
    })
    const a2 = await store.create({
      slug: 'as-built-a2', project_slug: 't1', repo_path: '/repo-a', task: 't', merge_mode: 'pr',
    })
    await store.update(a1.id, { phase: 'done' })
    await store.update(a2.id, { phase: 'done' })
    await store.create({
      slug: 'as-built-a-local', project_slug: 't1', repo_path: '/repo-a', task: 't', merge_mode: 'local',
    })
    await store.create({
      slug: 'as-built-b', project_slug: 't1', repo_path: '/repo-b', task: 't', merge_mode: 'local',
    })
    const calls: [string, MergeMode][] = []
    const loop = new TridentTickLoop({
      store,
      deps: stubAdvanceDeps(),
      fold_staged_as_built: async (repo, mode) => {
        calls.push([repo, mode])
        return { ok: true, folded: 1 }
      },
    })

    await loop.runOnce()
    expect(calls).toHaveLength(2)
    expect(new Set(calls.map(([repo, mode]) => `${repo}:${mode}`))).toEqual(
      new Set(['/repo-a:local', '/repo-b:local']),
    )
    await loop.stop()
  })

  test('one repo throwing does not stop the others', async () => {
    let second = 0
    const store = new TridentRunStore(
      db,
      () => new Date(Date.UTC(2026, 7, 18, 0, 0, second++)).toISOString(),
    )
    await store.create({ slug: 'as-built-b', project_slug: 't1', repo_path: '/repo-b', task: 't' })
    // Newest-first enumeration makes repo-a run first, so repo-b proves the
    // per-repo catch continues after the throw rather than merely before it.
    await store.create({ slug: 'as-built-a', project_slug: 't1', repo_path: '/repo-a', task: 't' })
    const calls: string[] = []
    const loop = new TridentTickLoop({
      store,
      deps: stubAdvanceDeps(),
      fold_staged_as_built: async (repo) => {
        calls.push(repo)
        if (repo === '/repo-a') throw new Error('repo-a unavailable')
        return { ok: true, folded: 1 }
      },
    })

    await loop.runOnce()
    expect(calls).toContain('/repo-a')
    expect(calls).toContain('/repo-b')
    expect(calls).toHaveLength(2)
    await loop.stop()
  })

  test('absent seam leaves the ordinary tick behavior and timer inventory unchanged', async () => {
    const store = new TridentRunStore(db)
    const absent = new TridentTickLoop({ store, deps: stubAdvanceDeps() })
    expect(await absent.runOnce()).toEqual({ advanced: 0, skipped_due_to_overlap: false })
    expect(absent.describeAll().map((descriptor) => descriptor.name)).toEqual(['trident', 'trident-watch'])
    await absent.stop()
  })

  test('each repo is attempted once without starving older repos', async () => {
    const store = new TridentRunStore(db)
    for (let i = 0; i < 25; i++) {
      await store.create({
        slug: `as-built-bound-${i}`,
        project_slug: 't1',
        repo_path: `/repo-${i}`,
        task: 't',
      })
    }
    const calls: string[] = []
    const loop = new TridentTickLoop({
      store,
      deps: stubAdvanceDeps(),
      fold_staged_as_built: async (repo) => {
        calls.push(repo)
        return { ok: true, folded: 0 }
      },
    })

    await loop.runOnce()
    expect(calls).toHaveLength(25)
    expect(new Set(calls).size).toBe(25)
    await loop.stop()
  })
})
