import { describe, expect, test } from 'bun:test'

import { NO_ADVANCE_HANG_MS } from '@neutronai/trident/liveness.ts'
import { WAKEUP_STAND_DOWN_MS } from '@neutronai/trident/run-driving.ts'
import type { TridentRun } from '@neutronai/trident/store.ts'
import type { WorkBoardItem } from '@neutronai/work-board/store.ts'

import { selectWakeupWork } from '../work-wakeup-selection.ts'

const OWNER = 'owner'
/** The night the wakeup shipped: the runs were created 21:35:47Z. */
const T0 = Date.parse('2026-08-14T21:35:47Z')

function item(over: Partial<WorkBoardItem> = {}): WorkBoardItem {
  return {
    id: 'item-1',
    project_slug: OWNER,
    title: 'Ship the importer',
    status: 'in_progress',
    sort_order: 0,
    design_doc_ref: null,
    task_type: 'build',
    inline_active: false,
    linked_run_id: null,
    created_at: '2026-08-14T21:00:00Z',
    updated_at: '2026-08-14T21:00:00Z',
    completed_at: null,
    ...over,
  }
}

function run(over: Partial<TridentRun> = {}): TridentRun {
  return {
    id: 'run-1',
    slug: 'demo',
    project_slug: OWNER,
    phase: 'forge-init',
    round: 1,
    max_rounds: 8,
    ralph: false,
    ralph_round: 0,
    max_ralph_rounds: 20,
    branch: 'trident/demo',
    pr: null,
    merge_mode: 'pr',
    // A LAUNCHED run is the realistic default: a clean fire writes both columns
    // in one update (`orchestrator.ts:2106-2114`). Tests that want the
    // never-launched shape null them explicitly.
    subagent_run_id: 'wf-1',
    subagent_status: 'running',
    repo_path: '/repo',
    worktree: null,
    task: 'build a thing',
    chat_id: null,
    thread_id: null,
    channel_kind: 'app_socket',
    failure_reason: null,
    workflow_run_id: 'wf-1',
    inner_checkpoint: null,
    inner_checkpoint_head: null,
    inner_checkpoint_findings: null,
    inner_verdict: null,
    inner_result: null,
    started_at: '2026-08-14T21:35:47Z',
    last_advanced_at: '2026-08-14T21:35:47Z',
    harvested_at: null,
    crash_recoveries: 0,
    infra_retries: 0,
    reviewed_head: null,
    bound_pr: null,
    fenced_paths: null,
    base_sha: null,
    base_behind: null,
    ...over,
  }
}

function select(input: {
  items: WorkBoardItem[]
  runs?: TridentRun[]
  now_ms?: number
}): ReturnType<typeof selectWakeupWork> {
  const byId = new Map((input.runs ?? []).map((r) => [r.id, r]))
  return selectWakeupWork({
    items: input.items,
    lookupRun: (id) => byId.get(id) ?? null,
    owner_slug: OWNER,
    now_ms: input.now_ms ?? T0 + 60_000,
  })
}

describe('selectWakeupWork — which items the wakeup may act on', () => {
  test('an unbound in_progress item is wakeable', () => {
    const out = select({ items: [item()] })
    expect(out).toHaveLength(1)
    expect(out[0]?.items.map((i) => i.title)).toEqual(['Ship the importer'])
    expect(out[0]?.deferred).toEqual([])
  })

  test('items that are not in_progress are ignored entirely', () => {
    const out = select({
      items: [item({ id: 'a', status: 'upcoming' }), item({ id: 'b', status: 'failed' })],
    })
    expect(out).toEqual([])
  })

  // ── PROPERTY 1: NO DOUBLE-DRIVING ────────────────────────────────────────────
  test('an item whose run is ADVANCING is withheld, and reported as deferred', () => {
    const out = select({
      items: [item({ linked_run_id: 'run-1' })],
      // 45 min in with a checkpoint 5 min ago — a healthy long build.
      runs: [run({ last_advanced_at: new Date(T0 + 40 * 60_000).toISOString() })],
      now_ms: T0 + 45 * 60_000,
    })
    expect(out).toHaveLength(1)
    expect(out[0]?.items).toEqual([])
    expect(out[0]?.deferred).toEqual([
      {
        title: 'Ship the importer',
        item_id: 'item-1',
        run_id: 'run-1',
        phase: 'forge-init',
        since_advance_ms: 5 * 60_000,
      },
    ])
  })

  test('a long build is STILL withheld past the reaper threshold — that moment belongs to the reaper', () => {
    // The blocker in the first cut: at `NO_ADVANCE_HANG_MS` a healthy long Forge
    // step was woken while it worked, because `last_advanced_at` is stale by
    // construction mid-phase. This run carries a dispatch id, so the reaper
    // (`orchestrator.ts:2570`) decides it — and the wakeup stands down past that.
    const out = select({
      items: [item({ linked_run_id: 'run-1' })],
      runs: [run()],
      now_ms: T0 + NO_ADVANCE_HANG_MS + 1,
    })
    expect(out[0]?.items).toEqual([])
    expect(out[0]?.deferred).toHaveLength(1)
  })

  // ── PROPERTY 2: NO PERMANENT INVISIBILITY ────────────────────────────────────
  test('an item whose run STOPPED advancing becomes wakeable again', () => {
    // The measured shape: non-terminal `forge-init`, no movement. Under the old
    // `!isTerminalPhase(run.phase)` test this item was withheld forever.
    const out = select({
      items: [item({ linked_run_id: 'run-1' })],
      runs: [run({ phase: 'forge-init' })],
      now_ms: T0 + WAKEUP_STAND_DOWN_MS + 1,
    })
    expect(out).toHaveLength(1)
    expect(out[0]?.items.map((i) => i.title)).toEqual(['Ship the importer'])
    expect(out[0]?.deferred).toEqual([])
  })

  test('THE LIVE INCIDENT: three parked forge-init runs no longer hide three items', () => {
    const items = ['a', 'b', 'c'].map((id) =>
      item({ id, title: `item ${id}`, linked_run_id: `run-${id}` }),
    )
    const runs = ['a', 'b', 'c'].map((id) =>
      run({ id: `run-${id}`, phase: 'forge-init', last_advanced_at: '2026-08-14T22:31:10Z' }),
    )
    const out = select({ items, runs, now_ms: Date.parse('2026-08-15T01:20:00Z') })
    expect(out).toHaveLength(1)
    expect(out[0]?.items.map((i) => i.title)).toEqual(['item a', 'item b', 'item c'])
  })

  test('a terminal run never withholds its item', () => {
    for (const phase of ['done', 'failed', 'stopped'] as const) {
      const out = select({
        items: [item({ linked_run_id: 'run-1' })],
        runs: [run({ phase })],
      })
      expect(out[0]?.items).toHaveLength(1)
      expect(out[0]?.deferred).toEqual([])
    }
  })

  test('a linked run whose row has VANISHED leaves the item wakeable (never stranded)', () => {
    const out = select({ items: [item({ linked_run_id: 'ghost' })], runs: [] })
    expect(out[0]?.items).toHaveLength(1)
  })

  test('a link to ANOTHER project’s run cannot hide the item, however healthy that run is', () => {
    // `TridentRunStore.get` is keyed on the id alone, so without the scope check a
    // stale cross-project `linked_run_id` pointing at a continuously-advancing run
    // suppresses this item for as long as that run lives.
    const out = select({
      items: [item({ project_slug: OWNER, linked_run_id: 'run-1' })],
      runs: [run({ id: 'run-1', project_slug: 'someone-else' })],
    })
    expect(out[0]?.items).toHaveLength(1)
    expect(out[0]?.deferred).toEqual([])
  })

  test('a run whose LAUNCH IS IN FLIGHT is not woken on the strength of its empty dispatch columns', () => {
    // An earlier cut read null/null past the 3-min settle budget as proof that no
    // workflow existed, and woke the item within minutes. But those columns are
    // written only after the fire settles (`orchestrator.ts:2106-2114`) and the
    // settle timer's cancellation is unbounded (`inner-loop.ts:774-786`), so this
    // row shape is routinely a LIVE launch — and waking it is the double-drive
    // Property 1 exists to prevent. It stays withheld until the ordinary timer.
    const out = select({
      items: [item({ linked_run_id: 'run-1' })],
      runs: [run({ subagent_run_id: null, subagent_status: null })],
      now_ms: T0 + 10 * 60_000,
    })
    expect(out[0]?.items).toEqual([])
    expect(out[0]?.deferred).toHaveLength(1)
  })

  test('but a run with no dispatch id is still released by the timer — no reaper can reach it', () => {
    const out = select({
      items: [item({ linked_run_id: 'run-1' })],
      runs: [run({ subagent_run_id: null, subagent_status: null })],
      now_ms: T0 + WAKEUP_STAND_DOWN_MS + 1,
    })
    expect(out[0]?.items).toHaveLength(1)
    expect(out[0]?.deferred).toEqual([])
  })

  test('a corrupt last_advanced_at makes the item wakeable rather than invisible', () => {
    const out = select({
      items: [item({ linked_run_id: 'run-1' })],
      runs: [run({ last_advanced_at: 'not-a-date' })],
    })
    expect(out[0]?.items).toHaveLength(1)
    expect(out[0]?.deferred).toEqual([])
  })

  // ── grouping / scope ─────────────────────────────────────────────────────────
  test('the owner slug is the General board: no project id, General label + scope', () => {
    const out = select({ items: [item({ project_slug: OWNER })] })
    expect(out[0]?.project_key).toBe(OWNER)
    expect(out[0]?.chat_scope).toBe('general')
    expect(out[0]?.label).toBe('your General workspace')
  })

  test('a real project keeps its id as the chat scope, and projects group separately', () => {
    const out = select({
      items: [
        item({ id: 'a', project_slug: 'acme', title: 'one' }),
        item({ id: 'b', project_slug: 'acme', title: 'two' }),
        item({ id: 'c', project_slug: OWNER, title: 'three' }),
      ],
    })
    expect(out).toHaveLength(2)
    const acme = out.find((p) => p.project_key === 'acme')
    expect(acme?.chat_scope).toBe('acme')
    expect(acme?.label).toBe('project "acme"')
    expect(acme?.items.map((i) => i.title)).toEqual(['one', 'two'])
  })

  test('a project with ONLY deferred items still yields an entry, so the sweep can say why', () => {
    const out = select({
      items: [item({ linked_run_id: 'run-1' })],
      runs: [run()],
    })
    expect(out).toHaveLength(1)
    expect(out[0]?.items).toEqual([])
    expect(out[0]?.deferred).toHaveLength(1)
  })
})
