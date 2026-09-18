import { afterEach, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { seedMigratedDb } from '../tests/support/migrated-db.ts'
import { TridentRunStore } from './store.ts'
import { dispatchBoardBoundBuild } from './board-dispatch.ts'
import { createProductionHostEffects } from './production-host-effects.ts'
import { spawnCapture } from './git-mode.ts'
import { slugifyTask } from './slugify-task.ts'
import type { ResumeCheckpoint } from './build-run.ts'

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })
const HEAD = 'a'.repeat(40)
const BASE = 'b'.repeat(40)
const TASK = 'Build the specified retry continuity change with a full regression suite and preserved review rounds'

async function fixture(over: { checkpoint?: Partial<ResumeCheckpoint>; phase?: 'failed' | 'stopped'; cardRound?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cross-run-retry-'))
  seedMigratedDb(join(dir, 'project.db'))
  const db = ProjectDb.open(join(dir, 'project.db'))
  cleanups.push(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })
  const store = new TridentRunStore(db)
  const branch = `trident/${slugifyTask(TASK)}`
  const prior = await store.create({ slug: slugifyTask(TASK), project_slug: 'project', repo_path: dir,
    task: TASK, branch, merge_mode: 'local', ralph: true, ralph_round: 4, max_ralph_rounds: 8 })
  const worktree = join(dir, 'work')
  await store.update(prior.id, { worktree, base_sha: BASE })
  const options = { store, runId: prior.id, projectSlug: 'project', repo: dir, worktree, branch,
    baseBranch: 'main', runHost: spawnCapture, ciWorkflow: undefined,
    publication: async () => ({ title: TASK, bodyFile: join(dir, 'publication') }) }
  const checkpoint: ResumeCheckpoint = { head: HEAD, stage: 'fixed', round: 3, replansUsed: 1,
    findings: [], previousFindings: ['Earlier finding'], previousBlockingCount: 1, ...over.checkpoint }
  const original = createProductionHostEffects(options)
  await original.modes.saveCheckpoint(checkpoint)
  // Positive control: the original host can read the exact state being retried.
  expect(await original.modes.loadResume()).toEqual(checkpoint)
  await store.update(prior.id, { phase: over.phase ?? 'failed' })
  const dispatch = (tip = HEAD, linkedRun: string | null = prior.id, task = TASK) => dispatchBoardBoundBuild({ task, board_item_id: 'card' }, {
    store, project_slug: 'project', repo_path: dir,
    board: { get: () => ({ id: 'card', title: TASK, design_doc_ref: null, linked_run_id: linkedRun,
      ...(over.cardRound === undefined ? {} : { ralph_round: over.cardRound, max_ralph_rounds: 8 }) }),
      attachRun: async () => {} },
    resolveBuildRepo: async () => dir, resolveMergeMode: async () => 'local', resolveRalph: async () => true,
    readBranchTip: async () => tip,
  })
  return { dir, store, prior, options, checkpoint, dispatch }
}

test('a new run dispatched from a completed typed checkpoint resumes its review round', async () => {
  const { dir, store, prior, options, checkpoint, dispatch } = await fixture()
  const result = await dispatch()
  expect(result.ok, JSON.stringify(result)).toBe(true)
  if (!result.ok) return
  expect(result.run.id).not.toBe(prior.id)
  await store.update(result.run.id, { worktree: join(dir, 'retry-work'), base_sha: BASE })
  const retry = createProductionHostEffects({ ...options, runId: result.run.id, worktree: join(dir, 'retry-work') })
  expect(await retry.modes.loadResume()).toEqual(checkpoint)
  const ownEvents = store.stageEvents(result.run.id).filter(event => event.stage === 'build-mode-state')
  expect(ownEvents).toHaveLength(1)
  expect(JSON.parse(ownEvents[0]!.meta!).runId).toBe(result.run.id)
  expect(JSON.parse(ownEvents[0]!.meta!).worktree).toBe(join(dir, 'retry-work'))
  expect(result.run.ralph_round).toBe(4)
  expect(result.run.max_ralph_rounds).toBe(8)
})

for (const tip of ['', 'c'.repeat(40)]) test(`a ${tip ? 'moved' : 'missing'} branch tip cannot authorize typed checkpoint adoption`, async () => {
  const f = await fixture()
  const result = await f.dispatch(tip)
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(result.run.inner_checkpoint).toBeNull()
  expect(f.store.stageEvents(result.run.id).filter(event => event.stage === 'build-retry-source')).toHaveLength(0)
  expect(result.run.ralph_round).toBe(4)
})

for (const link of [null, 'missing']) test(`a card naming ${link ?? 'no run'} cannot inherit another card's checkpoint`, async () => {
  const f = await fixture()
  const result = await f.dispatch(HEAD, link)
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(result.run.inner_checkpoint).toBeNull()
  expect(f.store.stageEvents(result.run.id)).toHaveLength(0)
})

for (const stage of ['approved', 'rejected', 'ralph-task-built', 'built'] as const) test(`a governed ${stage} checkpoint does not promise completed-build review`, async () => {
  const f = await fixture({ checkpoint: { stage } })
  const result = await f.dispatch()
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(result.run.inner_checkpoint).toBeNull()
  expect(f.store.stageEvents(result.run.id)).toHaveLength(0)
})

test('a stopped run and a changed task do not donate typed state', async () => {
  const stopped = await fixture({ phase: 'stopped' })
  const first = await stopped.dispatch()
  expect(first.ok && first.run.inner_checkpoint).toBeNull()
  const edited = await fixture()
  const second = await edited.dispatch(HEAD, edited.prior.id, `${TASK} after clarification`)
  expect(second.ok && second.run.inner_checkpoint).toBeNull()
})

test('pending work and malformed source identity cannot become a new completed checkpoint', async () => {
  const f = await fixture()
  const source = f.store.stageEvents(f.prior.id).filter(event => event.stage === 'build-mode-state').at(-1)!
  const state = JSON.parse(source.meta!)
  state.checkpoint.pending = { phase: 'review', step_id: `${f.prior.id}:review:3` }
  await f.store.recordStageEvent(f.prior.id, 'build-mode-state', JSON.stringify(state))
  const pending = await f.dispatch()
  expect(pending.ok && pending.run.inner_checkpoint).toBeNull()
  if (pending.ok) await f.store.update(pending.run.id, { phase: 'failed' })
  delete state.checkpoint.pending
  state.runId = 'another-run'
  await f.store.recordStageEvent(f.prior.id, 'build-mode-state', JSON.stringify(state))
  const invalid = await f.dispatch()
  expect(invalid).toMatchObject({ ok: false, code: 'backend_error' })
})

test('a source changed after dispatch cannot be imported', async () => {
  const f = await fixture()
  const result = await f.dispatch()
  expect(result.ok).toBe(true)
  if (!result.ok) return
  const worktree = join(f.dir, 'retry-work')
  await f.store.update(result.run.id, { worktree })
  const host = createProductionHostEffects({ ...f.options, runId: result.run.id, worktree })
  const event = f.store.stageEvents(f.prior.id).filter(event => event.stage === 'build-mode-state').at(-1)!
  await f.store.recordStageEvent(f.prior.id, 'build-mode-state', event.meta)
  await expect(host.modes.loadResume()).rejects.toThrow('changed after dispatch')
})

test('a copied retry link cannot authorize another run', async () => {
  const f = await fixture()
  const result = await f.dispatch()
  expect(result.ok).toBe(true)
  if (!result.ok) return
  const link = f.store.stageEvents(result.run.id).find(event => event.stage === 'build-retry-source')!
  const other = await f.store.create({ slug: 'other-card', project_slug: 'project', repo_path: f.dir,
    task: TASK, branch: f.options.branch, merge_mode: 'local', ralph: true })
  const worktree = join(f.dir, 'other-work')
  await f.store.update(other.id, { worktree, base_sha: BASE, inner_checkpoint_head: HEAD })
  await f.store.recordStageEvent(other.id, 'build-retry-source', link.meta)
  const host = createProductionHostEffects({ ...f.options, runId: other.id, worktree })
  await expect(host.modes.loadResume()).rejects.toThrow('Retry source identity is invalid')
})

test('importing a checkpoint cannot lower a newer card-owned iteration count', async () => {
  const f = await fixture({ cardRound: 5 })
  const result = await f.dispatch()
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(result.run.ralph_round).toBe(5)
  const worktree = join(f.dir, 'retry-work')
  await f.store.update(result.run.id, { worktree })
  const host = createProductionHostEffects({ ...f.options, runId: result.run.id, worktree })
  await host.modes.loadResume()
  expect(host.ralphIteration()).toBe(5)
})

test('a source write failure rolls back the new run instead of leaving an orphan resume seed', async () => {
  const f = await fixture()
  const fail = spyOn(f.store, 'recordStageEvent').mockRejectedValue(new Error('Source write failed'))
  try {
    expect(await f.dispatch()).toMatchObject({ ok: false, code: 'backend_error' })
    expect(f.store.listNonTerminal()).toHaveLength(0)
  } finally { fail.mockRestore() }
  // The same admissible source creates a row once the write works.
  const result = await f.dispatch()
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(f.store.stageEvents(result.run.id).find(event => event.stage === 'build-retry-source')).toBeDefined()
})

for (const stage of ['approved', 'rejected', 'pending'] as const) test(`a later typed ${stage} checkpoint vetoes an inherited legacy seed on the next retry`, async () => {
  const f = await fixture()
  const first = await f.dispatch()
  expect(first.ok).toBe(true)
  if (!first.ok) return
  const worktree = join(f.dir, 'retry-work')
  await f.store.update(first.run.id, { worktree })
  const host = createProductionHostEffects({ ...f.options, runId: first.run.id, worktree })
  expect(await host.modes.loadResume()).toEqual(f.checkpoint)
  await host.modes.saveCheckpoint({ ...f.checkpoint,
    ...(stage === 'pending' ? { pending: { phase: 'review' as const, step_id: `${first.run.id}:review:3` } } : { stage }) })
  await f.store.update(first.run.id, { phase: 'failed', worktree: null })
  expect(f.store.get(first.run.id)!.inner_checkpoint).toBe('fix-round-3')
  const next = await f.dispatch(HEAD, first.run.id)
  expect(next.ok).toBe(true)
  if (!next.ok) return
  expect(next.run.inner_checkpoint).toBeNull()
  expect(f.store.stageEvents(next.run.id)).toHaveLength(0)
})
