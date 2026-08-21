import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { DEFAULT_MAX_INFLIGHT_MS, NO_ADVANCE_HANG_MS } from '@neutronai/trident/liveness.ts'
import { WAKEUP_STAND_DOWN_MS } from '@neutronai/trident/run-driving.ts'
import type { TridentRun } from '@neutronai/trident/store.ts'
import { makeTridentRun } from '@neutronai/trident/testing/make-trident-run.ts'
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
    blocked_by: [],
    declared_surfaces: null,
    inline_active: false,
    linked_run_id: null,
    created_at: '2026-08-14T21:00:00Z',
    updated_at: '2026-08-14T21:00:00Z',
    completed_at: null,
    ...over,
  }
}

function run(over: Partial<TridentRun> = {}): TridentRun {
  return makeTridentRun({
    id: 'run-1',
    slug: 'demo',
    project_slug: OWNER,
    branch: 'trident/demo',
    merge_mode: 'pr',
    // A LAUNCHED run is the realistic default: a clean fire writes both columns
    // in one update (`orchestrator.ts:2106-2114`). Tests that want the
    // never-launched shape null them explicitly.
    subagent_run_id: 'wf-1',
    repo_path: '/repo',
    task: 'build a thing',
    channel_kind: 'app_socket',
    workflow_run_id: 'wf-1',
    started_at: '2026-08-14T21:35:47Z',
    last_advanced_at: '2026-08-14T21:35:47Z',
    ...over,
  })
}

function select(input: {
  items: WorkBoardItem[]
  runs?: TridentRun[]
  now_ms?: number
  /** `TridentRunStore.latestStageEventAt` by run id. Absent → the source is UNWIRED. */
  stageEvents?: Record<string, string | null>
}): ReturnType<typeof selectWakeupWork> {
  const byId = new Map((input.runs ?? []).map((r) => [r.id, r]))
  return selectWakeupWork({
    items: input.items,
    lookupRun: (id) => byId.get(id) ?? null,
    ...(input.stageEvents === undefined
      ? {}
      : { latestStageEventAt: (id: string) => input.stageEvents?.[id] ?? null }),
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
    // AND IT SAYS THE BINDING SURVIVED. The run row is still there and still
    // non-terminal; only the judgement that it drives lapsed. Dropping that made
    // the prompt tell the agent no run existed, and an agent believing it
    // dispatches a second one onto a slug the live-only unique index still holds
    // (`migrations/0120_trident_slug_unique_only_live.sql:42-44`).
    expect(out[0]?.items[0]?.stalled_run).toEqual({
      run_id: 'run-1',
      phase: 'forge-init',
      reason: 'no-advance',
      since_advance_ms: WAKEUP_STAND_DOWN_MS + 1,
    })
  })

  test('an UNBOUND item carries no stalled_run — there is nothing to reap', () => {
    const out = select({ items: [item()], runs: [] })
    expect(out[0]?.items[0]?.stalled_run).toBeUndefined()
  })

  test('a TERMINAL run leaves no stalled_run either — it finished, it is not parked', () => {
    // The distinction that keeps the prompt honest in the other direction: a run
    // that reached `done`/`failed`/`stopped` is not something to go and reap, and
    // telling the agent to reap it would be its own small lie.
    const out = select({
      items: [item({ linked_run_id: 'run-1' })],
      runs: [run({ phase: 'done' })],
    })
    expect(out[0]?.items[0]?.stalled_run).toBeUndefined()
  })

  test('a run whose row VANISHED leaves no stalled_run — there is no run to name', () => {
    const out = select({ items: [item({ linked_run_id: 'ghost' })], runs: [] })
    expect(out[0]?.items[0]?.stalled_run).toBeUndefined()
  })

  test('a CORRUPT stamp is released AND marked, so a broken clock is not silently an unbound item', () => {
    const out = select({
      items: [item({ linked_run_id: 'run-1' })],
      runs: [run({ last_advanced_at: 'not-a-date' })],
    })
    expect(out[0]?.items[0]?.stalled_run?.reason).toBe('unknown-advance')
    expect(out[0]?.items[0]?.stalled_run?.since_advance_ms).toBe(0)
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

  // ── PROPERTY 4: THE TWO SCHEDULERS READ THE SAME EVIDENCE ───────────────────
  //
  // The run in these tests is the one the hang watchdog now SPARES: reaper-reachable
  // (`subagent_run_id` set), `last_advanced_at` past the stand-down threshold, and a
  // mid-phase `codex-exec-alive` heartbeat landing every 5 minutes. Before the
  // heartbeat existed such a run had already been flipped `failed` at 90 min, so this
  // module answered `terminal` at 100 min and waking the item was correct. Now it
  // stays non-terminal — and a wakeup keyed only on `last_advanced_at` would drive an
  // item whose build is alive, every WORK_WAKEUP_INTERVAL_MS, for the whole 100→120
  // min window.
  test('a run the WATCHDOG spares on fresh stage evidence is deferred here too', () => {
    const now = T0 + WAKEUP_STAND_DOWN_MS + 1
    const out = select({
      items: [item({ linked_run_id: 'run-1' })],
      runs: [run({ phase: 'forge-init' })],
      now_ms: now,
      stageEvents: { 'run-1': new Date(now - 5 * 60_000).toISOString() },
    })
    expect(out).toHaveLength(1)
    expect(out[0]?.items).toEqual([])
    expect(out[0]?.deferred.map((d) => d.item_id)).toEqual(['item-1'])
  })

  test('CONTROL: the SAME run with no stage evidence is wakeable — the ledger is what moved it', () => {
    // Identical fixture minus the one row. Without this the test above could be
    // passing for any reason at all.
    const now = T0 + WAKEUP_STAND_DOWN_MS + 1
    const out = select({
      items: [item({ linked_run_id: 'run-1' })],
      runs: [run({ phase: 'forge-init' })],
      now_ms: now,
      stageEvents: { 'run-1': null },
    })
    expect(out[0]?.items.map((i) => i.title)).toEqual(['Ship the importer'])
    expect(out[0]?.deferred).toEqual([])
  })

  test('CONTROL: a STALE stage event does not defer — the ledger must be fresh, not merely present', () => {
    const now = T0 + WAKEUP_STAND_DOWN_MS + 1
    const out = select({
      items: [item({ linked_run_id: 'run-1' })],
      runs: [run({ phase: 'forge-init' })],
      now_ms: now,
      // Older than the stand-down window: the ticker stopped long ago.
      stageEvents: { 'run-1': new Date(now - WAKEUP_STAND_DOWN_MS - 60_000).toISOString() },
    })
    expect(out[0]?.items.map((i) => i.title)).toEqual(['Ship the importer'])
    expect(out[0]?.deferred).toEqual([])
  })

  test('RETRACTION PATH: an endlessly-heartbeating run is released at the 2 h ceiling', () => {
    // NEVER WIDEN A REFUSAL WITHOUT A RETRACTION PATH. A leaked ticker would otherwise
    // hide its item from the only autonomy mechanism forever, with nothing but a human
    // to clear it. The ceiling clears it instead, on the same clock the orchestrator
    // uses to outrank its own reprieve — no operator action, no stored state.
    const now = T0 + DEFAULT_MAX_INFLIGHT_MS + 60_000
    const out = select({
      items: [item({ linked_run_id: 'run-1' })],
      runs: [run({ phase: 'forge-init' })],
      now_ms: now,
      // As fresh as it gets: the ticker is still stamping this second.
      stageEvents: { 'run-1': new Date(now - 1_000).toISOString() },
    })
    expect(out[0]?.items.map((i) => i.title)).toEqual(['Ship the importer'])
    expect(out[0]?.deferred).toEqual([])
  })

  test('UNWIRED is not evidence: with no reader at all the pre-existing timer decides', () => {
    const out = select({
      items: [item({ linked_run_id: 'run-1' })],
      runs: [run({ phase: 'forge-init' })],
      now_ms: T0 + WAKEUP_STAND_DOWN_MS + 1,
    })
    expect(out[0]?.items.map((i) => i.title)).toEqual(['Ship the importer'])
    expect(out[0]?.deferred).toEqual([])
  })

  test('ANTI-UNWIRED GUARD: the composer really hands this module the stage-event reader', () => {
    // NO COMPOSED TEST DRIVES `open/composer.ts`'s `listOutstanding` closure, so
    // every injector this module takes is reachable only through a source read.
    // This repo has shipped the "merged green but unwired" shape five times in one
    // night — module + unit tests landed, the registration skipped — and an optional
    // injector is the easiest possible instance of it: drop the one line in the
    // composer and every test in this file still passes.
    const composer = readFileSync(
      fileURLToPath(new URL('../../../open/composer.ts', import.meta.url)),
      'utf8',
    )
    // The extraction must be able to MISS, or "found it" says nothing.
    expect(composer).not.toContain('latestStageEventAtThatDoesNotExist')
    const call = composer.slice(
      composer.indexOf('return selectWakeupWork({'),
      composer.indexOf('return selectWakeupWork({') + 900,
    )
    expect(call).toContain('lookupRun:')
    expect(call).toContain('latestStageEventAt: (run_id: string) => boardRunStore.latestStageEventAt(run_id)')
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
