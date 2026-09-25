import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { WorkBoardStore } from '@neutronai/work-board/store.ts'
import { seedMigratedDb } from '../tests/support/migrated-db.ts'
import { TridentRunStore } from './store.ts'
import { createProductionHostEffects } from './production-host-effects.ts'
import { dispatchBoardBoundBuild } from './board-dispatch.ts'
import { slugifyTask } from './slugify-task.ts'
import { spawnCapture } from './git-mode.ts'
import { fixtureDispatchAdmission } from './__tests__/dispatch-admission-fixture.ts'

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })
const HEAD = 'a'.repeat(40), BASE = 'b'.repeat(40), MOVED = 'c'.repeat(40)
const TASK = 'Preserve the completed task budget across branch changes and crash recovery with durable provenance'
const selection = { strategy: 'task_sequence' as const, rationale: 'Two execution boundaries', plan: '{}' }

async function fixture(cap = 1) {
  const dir = mkdtempSync(join(tmpdir(), 'task-spend-provenance-'))
  seedMigratedDb(join(dir, 'project.db'))
  const db = ProjectDb.open(join(dir, 'project.db'))
  cleanups.push(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })
  const store = new TridentRunStore(db), board = new WorkBoardStore(db)
  const card = await board.create('project', { title: TASK })
  const branch = `trident/${slugifyTask(TASK)}`, worktree = join(dir, 'work')
  const run = await store.create({ slug: slugifyTask(TASK), project_slug: 'project', repo_path: dir,
    task: TASK, branch, merge_mode: 'local', max_task_iterations: cap })
  await board.attachRun('project', card.id, run.id)
  expect(await store.selectExecutionStrategy(run.id, selection)).toEqual({ kind: 'allow' })
  await store.update(run.id, { worktree, base_sha: BASE })
  const options = { store, runId: run.id, projectSlug: 'project', repo: dir, worktree, branch,
    baseBranch: 'main', runHost: spawnCapture, ciWorkflow: undefined,
    publication: async () => ({ title: TASK, bodyFile: join(dir, 'body') }) }
  const host = createProductionHostEffects(options)
  await host.modes.saveCheckpoint!({ stage: 'built', head: HEAD, round: 1, replansUsed: 0,
    findings: [], previousFindings: [], remainingTasks: 1 })
  const first = store.stageEvents(run.id).filter(e => e.stage === 'build-mode-state').at(-1)!
  const handoff = { ...JSON.parse(first.meta!), iteration: 1, consumed: { round: 0, head: HEAD },
    checkpoint: { ...JSON.parse(first.meta!).checkpoint, stage: 'task-built', round: 0 } }
  const dispatch = (tip = HEAD, task = TASK) => dispatchBoardBoundBuild({ task, board_item_id: card.id }, {
    store, projectAdmission: fixtureDispatchAdmission(db), board, project_slug: 'project', repo_path: dir,
    resolveBuildRepo: async () => dir, resolveMergeMode: async () => 'local', readBranchTip: async () => tip,
  })
  return { db, store, board, card, run, options, host, first, handoff, dispatch }
}

for (const tip of [HEAD, MOVED, '']) for (const cap of [1, 2]) {
  test(`durable handoff reconciles before commit adoption: ${tip === HEAD ? 'exact' : tip === MOVED ? 'moved' : 'unknown'} head, cap ${cap}`, async () => {
    const f = await fixture(cap)
    // Historical crash window: a real durable host event exists, but outer
    // harvest never projected it to either row. Do not pre-reconcile the fixture.
    await f.store.recordStageEvent(f.run.id, 'build-mode-state', JSON.stringify(f.handoff))
    expect(f.store.get(f.run.id)!.task_iteration).toBe(0)
    expect(f.board.get('project', f.card.id)!.task_iteration).toBe(0)
    await f.store.update(f.run.id, { phase: 'failed' })
    const result = await f.dispatch(tip)
    expect(f.store.get(f.run.id)!.task_iteration).toBe(1)
    expect(f.board.get('project', f.card.id)!.task_iteration).toBe(1)
    if (cap === 1) {
      expect(result).toMatchObject({ ok: false, code: 'task_budget_exhausted' })
      expect(f.board.get('project', f.card.id)!.linked_run_id).toBe(f.run.id)
    } else {
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error(result.message)
      expect(result.run).toMatchObject({ task_iteration: 1, max_task_iterations: 2,
        inner_checkpoint: tip === HEAD ? 'task-built' : null })
    }
  })
}

test('edited task text cannot refund a proven handoff', async () => {
  const f = await fixture()
  await f.store.recordStageEvent(f.run.id, 'build-mode-state', JSON.stringify(f.handoff))
  await f.store.update(f.run.id, { phase: 'failed' })
  expect(await f.dispatch(MOVED, `${TASK} with clarification`)).toMatchObject({ ok: false, code: 'task_budget_exhausted' })
  expect(f.board.get('project', f.card.id)!.task_iteration).toBe(1)
})

for (const stage of ['task-built-deviated', 'approved'] as const) {
  test(`a non-resumable ${stage} checkpoint retains its proven spend`, async () => {
    const f = await fixture()
    await f.store.recordStageEvent(f.run.id, 'build-mode-state', JSON.stringify({ ...f.handoff,
      checkpoint: { ...f.handoff.checkpoint, stage } }))
    await f.store.update(f.run.id, { phase: 'failed' })
    expect(await f.dispatch(MOVED)).toMatchObject({ ok: false, code: 'task_budget_exhausted' })
    expect(f.board.get('project', f.card.id)!.task_iteration).toBe(1)
  })
}

for (const cap of [1, 2]) test(`same-run crash recovery selection observes durable spend, cap ${cap}`, async () => {
  const f = await fixture(cap)
  await f.store.recordStageEvent(f.run.id, 'build-mode-state', JSON.stringify(f.handoff))
  const recovered = createProductionHostEffects(f.options)
  expect(recovered.taskIteration()).toBe(1)
  const decision = await recovered.modes.selectExecutionStrategy({ ...selection, plan: JSON.parse(selection.plan), refresh: false })
  expect(decision.kind).toBe(cap === 1 ? 'blocked' : 'allow')
  expect(f.store.get(f.run.id)!.task_iteration).toBe(1)
  expect(f.board.get('project', f.card.id)!.task_iteration).toBe(1)
  expect((await f.store.reconcileTaskSpend(f.run.id))!.task_iteration).toBe(1)
})

for (const fault of ['malformed', 'foreign', 'negative'] as const) test(`unproven ${fault} event cannot authorize or invent spend`, async () => {
  const f = await fixture(2)
  const meta = fault === 'malformed' ? '{' : JSON.stringify({ ...f.handoff,
    ...(fault === 'foreign' ? { runId: 'foreign' } : { iteration: -1 }) })
  await f.store.recordStageEvent(f.run.id, 'build-mode-state', meta)
  expect((await f.store.selectExecutionStrategy(f.run.id, selection)).kind).toBe('unknown')
  expect(f.store.get(f.run.id)!.task_iteration).toBe(0)
  await f.store.update(f.run.id, { phase: 'failed' })
  expect(await f.dispatch(MOVED)).toMatchObject({ ok: false, code: 'backend_error' })
  expect(f.board.get('project', f.card.id)!.task_iteration).toBe(0)
})

test('checkpoint append atomically persists spend and a cleared card link retains it', async () => {
  const f = await fixture()
  expect(await f.store.appendBuildModeState(f.run.id, f.first.id, JSON.stringify(f.handoff))).not.toBeNull()
  expect(f.store.get(f.run.id)!.task_iteration).toBe(1)
  expect(f.board.get('project', f.card.id)!.task_iteration).toBe(1)
  expect(await f.store.appendBuildModeState(f.run.id, f.first.id, JSON.stringify({ ...f.handoff, iteration: 2 }))).toBeNull()
  await f.store.save({ ...f.store.get(f.run.id)!, task_iteration: 0 })
  await f.store.update(f.run.id, { phase: 'failed' })
  await f.board.detachRun('project', f.run.id, 'failed')
  await f.board.update('project', f.card.id, { status: 'upcoming' })
  expect(f.board.get('project', f.card.id)).toMatchObject({ linked_run_id: null, task_iteration: 1 })
  expect(await f.dispatch(MOVED)).toMatchObject({ ok: false, code: 'task_budget_exhausted' })
})

test('failed card projection rolls back both checkpoint and spend', async () => {
  const f = await fixture(2)
  await f.db.run(`CREATE TEMP TRIGGER reject_spend BEFORE UPDATE OF task_iteration ON work_board_items
    BEGIN SELECT RAISE(ABORT, 'card unavailable'); END`, [])
  await expect(f.store.appendBuildModeState(f.run.id, f.first.id, JSON.stringify(f.handoff))).rejects.toThrow('card unavailable')
  expect(f.store.stageEvents(f.run.id).filter(e => e.stage === 'build-mode-state')).toHaveLength(1)
  expect(f.store.get(f.run.id)!.task_iteration).toBe(0)
  await f.db.run('DROP TRIGGER reject_spend', [])
  expect(await f.store.appendBuildModeState(f.run.id, f.first.id, JSON.stringify(f.handoff))).not.toBeNull()
  expect(f.board.get('project', f.card.id)!.task_iteration).toBe(1)
})

test('a stale mode count cannot refund a newer row when the project host restarts', async () => {
  const f = await fixture(2)
  await f.store.update(f.run.id, { task_iteration: 1 })
  const recovered = createProductionHostEffects(f.options)
  expect(recovered.taskIteration()).toBe(1)
  expect(await recovered.modes.loadResume()).toMatchObject({ stage: 'built' })
  expect(await f.store.selectExecutionStrategy(f.run.id, selection)).toEqual({ kind: 'allow' })
  expect(f.store.get(f.run.id)!.task_iteration).toBe(1)
})

test('a malformed append cannot replace the valid checkpoint or create spend', async () => {
  const f = await fixture(2)
  await expect(f.store.appendBuildModeState(f.run.id, f.first.id, JSON.stringify({ ...f.handoff, runId: 'foreign' }))).rejects.toThrow()
  expect(f.store.stageEvents(f.run.id).filter(e => e.stage === 'build-mode-state')).toHaveLength(1)
  expect(f.store.get(f.run.id)!.task_iteration).toBe(0)
  expect(await f.store.appendBuildModeState(f.run.id, f.first.id, JSON.stringify(f.handoff))).not.toBeNull()
  expect(f.store.get(f.run.id)!.task_iteration).toBe(1)
})
