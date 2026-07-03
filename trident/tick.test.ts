import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '../migrations/runner.ts'
import { ProjectDb } from '../persistence/index.ts'
import { TridentRunStore, type TridentRun } from './store.ts'
import { STALLED_WARN_MS } from './run-progress.ts'
import {
  stubAdvanceDeps,
  type AdvanceDeps,
  type AdvanceOutcome,
  type SubagentOutcome,
} from './state-machine.ts'
import { TridentTickLoop } from './tick.ts'
import { buildTridentDelivery, type OutboundSink } from './delivery.ts'
import type { OutgoingMessage } from '../channels/types.ts'

let tmp: string
let db: ProjectDb

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-trident-tick-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
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
      expect(sent[0]!.text).toContain('build done')
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
