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
import { readBuildRetrySource } from './build-mode-state.ts'

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })
const HEAD = 'a'.repeat(40)
const BASE = 'b'.repeat(40)
const TASK = 'Build the specified retry continuity change with a full regression suite and preserved review rounds'

async function fixture(over: { checkpoint?: Partial<ResumeCheckpoint>; phase?: 'failed' | 'stopped'; cardRound?: number;
  mergeMode?: 'local' | 'pr'; iteration?: number } = {}) {
  const mergeMode = over.mergeMode ?? 'local'
  const dir = mkdtempSync(join(tmpdir(), 'cross-run-retry-'))
  seedMigratedDb(join(dir, 'project.db'))
  const db = ProjectDb.open(join(dir, 'project.db'))
  cleanups.push(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })
  const store = new TridentRunStore(db)
  const branch = `trident/${slugifyTask(TASK)}`
  const prior = await store.create({ slug: slugifyTask(TASK), project_slug: 'project', repo_path: dir,
    task: TASK, branch, merge_mode: mergeMode, ralph: true, ralph_round: 4, max_ralph_rounds: 8 })
  const worktree = join(dir, 'work')
  await store.update(prior.id, { worktree, base_sha: BASE })
  const options = { store, runId: prior.id, projectSlug: 'project', repo: dir, worktree, branch,
    baseBranch: 'main', runHost: spawnCapture, ciWorkflow: undefined,
    publication: async () => ({ title: TASK, bodyFile: join(dir, 'publication') }) }
  const checkpoint: ResumeCheckpoint = { head: HEAD, stage: 'fixed', round: 3, replansUsed: 1,
    findings: [], previousFindings: ['Earlier finding'], previousBlockingCount: 1, ...over.checkpoint }
  const original = createProductionHostEffects(options)
  await original.modes.saveCheckpoint(checkpoint)
  if (over.iteration !== undefined) {
    // The shape `advanceRalph` leaves behind: the iteration advanced past the row's round.
    const event = store.stageEvents(prior.id).filter(e => e.stage === 'build-mode-state').at(-1)!
    await store.recordStageEvent(prior.id, 'build-mode-state', JSON.stringify({ ...JSON.parse(event.meta!),
      iteration: over.iteration, consumed: { round: over.iteration - 1, head: HEAD } }))
  }
  // Positive control: the original host can read the exact state being retried.
  expect(await original.modes.loadResume()).toEqual(checkpoint)
  await store.update(prior.id, { phase: over.phase ?? 'failed' })
  const tipReads: string[] = []
  const dispatch = (tip: string | ((mode: string) => string) = HEAD, linkedRun: string | null = prior.id, task = TASK) => dispatchBoardBoundBuild({ task, board_item_id: 'card' }, {
    store, project_slug: 'project', repo_path: dir,
    board: { get: () => ({ id: 'card', title: TASK, design_doc_ref: null, linked_run_id: linkedRun,
      ...(over.cardRound === undefined ? {} : { ralph_round: over.cardRound, max_ralph_rounds: 8 }) }),
      attachRun: async () => {} },
    resolveBuildRepo: async () => dir, resolveMergeMode: async () => mergeMode, resolveRalph: async () => true,
    readBranchTip: async (_repo, _branch, mode) => { tipReads.push(mode); return typeof tip === 'function' ? tip(mode) : tip },
  })
  return { dir, db, store, prior, options, checkpoint, dispatch, tipReads }
}

test('intentional source invalidation carries the Ralph budget without carrying a checkpoint', async () => {
  const f = await fixture()
  const result = await f.dispatch()
  expect(result.ok).toBe(true)
  if (!result.ok) return
  const falsified = { ...result.run, phase: 'failed' as const, inner_checkpoint: null, inner_checkpoint_head: null,
    base_sha: 'd'.repeat(40), retry_seed_falsified: { recordedHead: HEAD, observedHead: 'c'.repeat(40), baseSha: BASE } }
  expect(await f.store.saveIfActive(falsified)).toBe(true)
  expect(readBuildRetrySource(f.store, f.store.get(result.run.id)!)).toBeNull()
  await f.store.invalidateRetrySource(falsified)
  expect(f.store.stageEvents(result.run.id).filter(e => e.stage === 'build-retry-source-invalidated')).toHaveLength(1)
  const next = await f.dispatch('c'.repeat(40), result.run.id)
  expect(next.ok, JSON.stringify(next)).toBe(true)
  if (!next.ok) return
  expect(next.run.inner_checkpoint).toBeNull()
  expect(next.run.ralph_round).toBe(4)
  expect(next.run.max_ralph_rounds).toBe(8)
})

for (const fault of ['unchanged head', 'unknown head', 'wrong base', 'copied source', 'recovered run'] as const)
test(`source invalidation refuses ${fault}`, async () => {
  const f = await fixture()
  const result = await f.dispatch()
  expect(result.ok).toBe(true)
  if (!result.ok) return
  const run = { ...result.run, retry_seed_falsified: { recordedHead: HEAD, observedHead: 'c'.repeat(40), baseSha: BASE } }
  if (fault === 'unchanged head') run.retry_seed_falsified.observedHead = HEAD
  if (fault === 'unknown head') run.retry_seed_falsified.observedHead = ''
  if (fault === 'wrong base') run.retry_seed_falsified.baseSha = 'd'.repeat(40)
  if (fault === 'recovered run') await f.store.update(run.id, { workflow_run_id: 'already-fired' })
  if (fault === 'copied source') {
    const link = f.store.stageEvents(run.id).find(e => e.stage === 'build-retry-source')!
    await f.store.recordStageEvent(run.id, 'build-retry-source', JSON.stringify({ ...JSON.parse(link.meta!), runId: 'foreign' }))
  }
  await expect(f.store.invalidateRetrySource(run)).rejects.toThrow()
  expect(f.store.stageEvents(run.id).filter(e => e.stage === 'build-retry-source-invalidated')).toHaveLength(0)
})

test('invalidation cannot hide a replaced source link', async () => {
  const f = await fixture()
  const result = await f.dispatch()
  expect(result.ok).toBe(true)
  if (!result.ok) return
  const run = { ...result.run, retry_seed_falsified: { recordedHead: HEAD, observedHead: 'c'.repeat(40), baseSha: BASE } }
  await f.store.invalidateRetrySource(run)
  expect(readBuildRetrySource(f.store, result.run)).toBeNull()
  const link = f.store.stageEvents(run.id).find(e => e.stage === 'build-retry-source')!
  await f.store.recordStageEvent(run.id, 'build-retry-source', link.meta)
  expect(() => readBuildRetrySource(f.store, result.run)).toThrow('Retry source invalidation is invalid')
})

test('invalidation refuses a changed recorded base', async () => {
  const f = await fixture()
  const result = await f.dispatch()
  expect(result.ok).toBe(true)
  if (!result.ok) return
  await f.store.invalidateRetrySource({ ...result.run,
    retry_seed_falsified: { recordedHead: HEAD, observedHead: 'c'.repeat(40), baseSha: BASE } })
  const proof = f.store.stageEvents(result.run.id).find(e => e.stage === 'build-retry-source-invalidated')!
  await f.store.recordStageEvent(result.run.id, proof.stage, JSON.stringify({ ...JSON.parse(proof.meta!), baseSha: 'd'.repeat(40) }))
  expect(() => readBuildRetrySource(f.store, result.run)).toThrow('Retry source invalidation is invalid')
})

test('terminal base mutation and source invalidation roll back together', async () => {
  const f = await fixture()
  const result = await f.dispatch()
  expect(result.ok).toBe(true)
  if (!result.ok) return
  const run = { ...result.run, phase: 'failed' as const, inner_checkpoint: null, base_sha: 'd'.repeat(40),
    retry_seed_falsified: { recordedHead: HEAD, observedHead: 'c'.repeat(40), baseSha: BASE } }
  await f.db.run("CREATE TEMP TRIGGER reject_invalidation BEFORE INSERT ON code_trident_stage_events WHEN NEW.stage = 'build-retry-source-invalidated' BEGIN SELECT RAISE(ABORT, 'invalidation write failed'); END", [])
  await expect(f.store.invalidateRetrySource(run)).rejects.toThrow('invalidation write failed')
  await expect(f.store.saveIfActive(run)).rejects.toThrow('invalidation write failed')
  expect(f.store.get(run.id)!.base_sha).toBe(BASE)
  expect(f.store.get(run.id)!.phase).toBe(result.run.phase)
  expect(readBuildRetrySource(f.store, result.run)).not.toBeNull()
  await f.db.run('DROP TRIGGER reject_invalidation', [])
  expect(await f.store.saveIfActive(run)).toBe(true)
  expect(f.store.get(run.id)!.base_sha).toBe('d'.repeat(40))
  expect(readBuildRetrySource(f.store, f.store.get(run.id)!)).toBeNull()
})

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

test('a retry that fails before importing its checkpoint remains a typed source for the next retry', async () => {
  const f = await fixture()
  let previous = f.prior
  // More than one preparation failure must keep the immediate named lineage.
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await f.dispatch(HEAD, previous.id)
    expect(result.ok, JSON.stringify(result)).toBe(true)
    if (!result.ok) return
    const source = f.store.stageEvents(result.run.id).find(event => event.stage === 'build-retry-source')
    expect(source).toBeDefined()
    expect(JSON.parse(source!.meta!).priorRunId).toBe(previous.id)
    expect(result.run.ralph_round).toBe(4)
    expect(result.run.max_ralph_rounds).toBe(8)
    expect(f.store.stageEvents(result.run.id).filter(event => event.stage === 'build-mode-state')).toHaveLength(0)
    if (attempt < 2) await f.store.update(result.run.id, { phase: 'failed', worktree: null })
    previous = f.store.get(result.run.id)!
  }
  const worktree = join(f.dir, 'final-work')
  await f.store.update(previous.id, { worktree })
  const host = createProductionHostEffects({ ...f.options, runId: previous.id, worktree })
  expect(await host.modes.loadResume()).toEqual(f.checkpoint)
  expect(host.ralphIteration()).toBe(4)
})

for (const fault of ['foreign ancestor', 'changed source', 'copied link', 'stopped predecessor', 'changed merge mode', 'moved head'] as const)
test(`a source-only retry cannot launder a ${fault}`, async () => {
  const f = await fixture()
  const first = await f.dispatch()
  expect(first.ok).toBe(true)
  if (!first.ok) return
  await f.store.update(first.run.id, { phase: 'failed', worktree: null })
  if (fault === 'foreign ancestor') {
    const foreign = await f.store.create({ slug: 'foreign', project_slug: 'project', repo_path: f.dir,
      task: `${TASK} for another card`, branch: f.options.branch, merge_mode: 'local', ralph: true })
    await f.store.update(foreign.id, { phase: 'failed', base_sha: BASE })
    const event = f.store.stageEvents(first.run.id).find(event => event.stage === 'build-retry-source')!
    await f.store.recordStageEvent(first.run.id, 'build-retry-source', JSON.stringify({ ...JSON.parse(event.meta!), priorRunId: foreign.id }))
  }
  if (fault === 'changed source') {
    const event = f.store.stageEvents(f.prior.id).find(event => event.stage === 'build-mode-state')!
    await f.store.recordStageEvent(f.prior.id, 'build-mode-state', event.meta)
  }
  if (fault === 'copied link') {
    const event = f.store.stageEvents(first.run.id).find(event => event.stage === 'build-retry-source')!
    await f.store.recordStageEvent(first.run.id, 'build-retry-source', JSON.stringify({ ...JSON.parse(event.meta!), runId: f.prior.id }))
  }
  if (fault === 'stopped predecessor') await f.store.update(first.run.id, { phase: 'stopped' })
  if (fault === 'changed merge mode') await f.store.update(first.run.id, { merge_mode: 'pr' })
  const result = await f.dispatch(fault === 'moved head' ? 'c'.repeat(40) : HEAD, first.run.id)
  if (fault === 'stopped predecessor' || fault === 'changed merge mode' || fault === 'moved head') {
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.run.inner_checkpoint).toBeNull()
    expect(f.store.stageEvents(result.run.id)).toHaveLength(0)
    expect(result.run.ralph_round).toBe(4)
  } else {
    expect(result).toMatchObject({ ok: false, code: 'backend_error' })
    expect(f.store.listNonTerminal()).toHaveLength(0)
  }
})

test('a cyclic source-only lineage is refused before a new retry is created', async () => {
  const f = await fixture()
  const first = await f.dispatch()
  expect(first.ok).toBe(true)
  if (!first.ok) return
  await f.store.update(first.run.id, { phase: 'failed', worktree: null })
  const second = await f.dispatch(HEAD, first.run.id)
  expect(second.ok).toBe(true)
  if (!second.ok) return
  await f.store.update(second.run.id, { phase: 'failed', worktree: null })
  const secondLink = f.store.stageEvents(second.run.id).find(event => event.stage === 'build-retry-source')!
  // Both rows otherwise match. Close the chain back onto the immediate child.
  await f.store.recordStageEvent(first.run.id, 'build-retry-source', JSON.stringify({
    runId: first.run.id, priorRunId: second.run.id, eventId: secondLink.id, head: HEAD,
  }))
  expect(() => readBuildRetrySource(f.store, f.store.get(second.run.id)!)).toThrow('Retry source cycle')
  expect(await f.dispatch(HEAD, second.run.id)).toMatchObject({ ok: false, code: 'backend_error' })
  expect(f.store.listNonTerminal()).toHaveLength(0)
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

for (const stage of ['approved', 'rejected', 'ralph-task-built-deviated', 'built'] as const) test(`a governed ${stage} checkpoint does not promise completed-build review`, async () => {
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

// ── THE RALPH CONTINUATION (spec item a-retry-must-resume-from-the-checkpoint, gap 2) ──
// A governed iteration that built its task and handed back parks at `ralph-task-built`.
// Its retry used to be born with `inner_checkpoint = null`, so it paid the full planning
// survey again; it now carries the checkpoint, its head and the base pin, and the retry
// host imports the continuation state the cheap planner (`build-run.ts`, G026) reads.
const CONTINUATION = { stage: 'ralph-task-built', round: 0, previousFindings: [], previousBlockingCount: 0 } as const

for (const mergeMode of ['local', 'pr'] as const)
test(`a ${mergeMode}-mode retry of a handed-back Ralph iteration carries its checkpoint off the LOCAL tip`, async () => {
  // Origin lags the recorded head in BOTH modes: an iteration commits locally and hands
  // back without publishing. Only the local ref holds HEAD, so a remote read (the
  // `detectExistingPr`-shaped probe) cannot be what recovers continuity here.
  const f = await fixture({ checkpoint: CONTINUATION, mergeMode })
  const result = await f.dispatch(mode => mode === 'local' ? HEAD : 'c'.repeat(40))
  expect(result.ok, JSON.stringify(result)).toBe(true)
  if (!result.ok) return
  expect(f.tipReads).toEqual(['local'])
  expect(result.run.inner_checkpoint).toBe('ralph-task-built')
  expect(result.run.inner_checkpoint_head).toBe(HEAD)
  expect(result.run.base_sha).toBe(BASE)
  expect(result.run.ralph_round).toBe(4)
  expect(result.run.max_ralph_rounds).toBe(8)
  const link = f.store.stageEvents(result.run.id).find(e => e.stage === 'build-retry-source')
  expect(JSON.parse(link!.meta!)).toMatchObject({ priorRunId: f.prior.id, head: HEAD })
  // The retry host imports the continuation as its own state: stage and head intact.
  const worktree = join(f.dir, 'retry-work')
  await f.store.update(result.run.id, { worktree })
  const host = createProductionHostEffects({ ...f.options, runId: result.run.id, worktree })
  expect(await host.modes.loadResume()).toMatchObject({ stage: 'ralph-task-built', head: HEAD, round: 0 })
  expect(host.ralphIteration()).toBe(4)
})

test('a continuation retry is born at the iteration the handoff advanced to, never below it', async () => {
  // `advanceRalph` moved the source to iteration 6 while the card still reads round 4.
  const f = await fixture({ checkpoint: CONTINUATION, iteration: 6, cardRound: 4 })
  const result = await f.dispatch()
  expect(result.ok, JSON.stringify(result)).toBe(true)
  if (!result.ok) return
  expect(result.run.inner_checkpoint).toBe('ralph-task-built')
  expect(result.run.ralph_round).toBe(6)
  expect(result.run.max_ralph_rounds).toBe(8)
  const worktree = join(f.dir, 'retry-work')
  await f.store.update(result.run.id, { worktree })
  const host = createProductionHostEffects({ ...f.options, runId: result.run.id, worktree })
  await host.modes.loadResume()
  expect(host.ralphIteration()).toBe(6)
})

for (const tip of ['', 'c'.repeat(40)]) test(`a continuation on a ${tip ? 'moved' : 'missing'} local tip is not adopted`, async () => {
  const f = await fixture({ checkpoint: CONTINUATION })
  const result = await f.dispatch(tip)
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(result.run.inner_checkpoint).toBeNull()
  expect(f.store.stageEvents(result.run.id)).toHaveLength(0)
  expect(result.run.ralph_round).toBe(4)
})

test('a continuation carried once survives a retry that died before building', async () => {
  const f = await fixture({ checkpoint: CONTINUATION })
  const first = await f.dispatch()
  expect(first.ok).toBe(true)
  if (!first.ok) return
  const worktree = join(f.dir, 'retry-work')
  await f.store.update(first.run.id, { worktree })
  await createProductionHostEffects({ ...f.options, runId: first.run.id, worktree }).modes.loadResume()
  await f.store.update(first.run.id, { phase: 'failed', worktree: null })
  const second = await f.dispatch(HEAD, first.run.id)
  expect(second.ok, JSON.stringify(second)).toBe(true)
  if (!second.ok) return
  expect(second.run.inner_checkpoint).toBe('ralph-task-built')
  expect(JSON.parse(f.store.stageEvents(second.run.id).find(e => e.stage === 'build-retry-source')!.meta!).priorRunId)
    .toBe(first.run.id)
})

// ── THE CARD SENTENCE (spec item a-retry-must-resume-from-the-checkpoint, acceptance 1) ──
// "carries … forward, OR states plainly on the card that it will not. Silence fails." Each
// case goes through the real `dispatchBoardBoundBuild` and reads the ROW it wrote, because
// the row is what `run_progress` carries to the card. The sentence must agree with the
// round and cap that same row holds.
async function withSeedLine<T>(fn: () => Promise<T>): Promise<{ value: T; seedLine: string | null }> {
  const lines: string[] = []
  const original = console.log
  console.log = (...args: unknown[]) => { lines.push(args.map(a => String(a)).join(' ')) }
  try {
    const value = await fn()
    return { value, seedLine: lines.find(l => l.includes('event=dispatch_resume_seed')) ?? null }
  } finally { console.log = original }
}

const SHORT = HEAD.slice(0, 7)
const noteCases: { name: string; reason: string; over?: Parameters<typeof fixture>[0];
  tip?: string; link?: 'prior' | null | 'missing' | 'foreign'; task?: string; expected: (round: string) => string }[] = [
  { name: 'a carried review checkpoint', reason: 'resumed',
    expected: r => `Dispatched to resume from fix-round-3 at ${SHORT} (rebuilds if the branch moves before launch); Ralph round ${r} carried.` },
  { name: 'a carried Ralph continuation', reason: 'resumed_continuation', over: { checkpoint: CONTINUATION },
    expected: r => `Dispatched to resume from ralph-task-built at ${SHORT} (rebuilds if the branch moves before launch); Ralph round ${r} carried.` },
  { name: 'a moved branch tip', reason: 'branch_tip_moved', tip: 'c'.repeat(40),
    expected: r => `Not resumed: the branch moved off the last run's commit, so this is a fresh build; Ralph round ${r} carried.` },
  { name: 'an unreadable branch tip', reason: 'branch_tip_unreadable_or_absent', tip: '',
    expected: r => `Not resumed: the branch tip could not be read or the branch is gone, so this is a fresh build; Ralph round ${r} carried.` },
  { name: 'a prior with nothing to resume', reason: 'prior_run_has_no_resumable_build', over: { checkpoint: { stage: 'approved' } },
    expected: r => `Not resumed: the last run left no build to resume, so this is a fresh build; Ralph round ${r} carried.` },
  { name: 'an edited task text', reason: 'prior_run_task_text_differs', task: `${TASK} after clarification`,
    expected: r => `Not resumed: the card's task text changed since the last run, so this is a fresh build; Ralph round ${r} carried.` },
  { name: 'a card naming no run', reason: 'card_names_no_run', link: null,
    expected: r => `Not resumed: the card names no prior run, so this is a fresh build; fresh Ralph budget ${r}.` },
  { name: 'a card naming a deleted run', reason: 'card_names_an_unknown_run', link: 'missing',
    expected: r => `Not resumed: the run the card names no longer exists, so this is a fresh build; fresh Ralph budget ${r}.` },
  { name: "a card naming another project's run", reason: 'card_names_a_different_run', link: 'foreign',
    expected: r => `Not resumed: the run the card names belongs to another project, so this is a fresh build; fresh Ralph budget ${r}.` },
]

for (const c of noteCases) test(`a retry after ${c.name} states its resume decision on the row (${c.reason})`, async () => {
  const f = await fixture(c.over)
  let link: string | null = f.prior.id
  if (c.link === null) link = null
  if (c.link === 'missing') link = 'missing'
  if (c.link === 'foreign') {
    const foreign = await f.store.create({ slug: 'foreign-project-run', project_slug: 'another-project',
      repo_path: f.dir, task: TASK, ralph: true })
    await f.store.update(foreign.id, { phase: 'failed' })
    link = foreign.id
  }
  const { value: result, seedLine } = await withSeedLine(() => f.dispatch(c.tip ?? HEAD, link, c.task ?? TASK))
  expect(result.ok, JSON.stringify(result)).toBe(true)
  if (!result.ok) return
  const row = f.store.get(result.run.id)!
  // The sentence names the round and cap the ROW holds — never a value it only intended.
  const note = c.expected(`${row.ralph_round}/${row.max_ralph_rounds}`)
  expect(row.resume_note).toBe(note)
  expect(note.length).toBeLessThanOrEqual(200)
  // Carried exactly when the row carries it: a resumed note on a row with no
  // checkpoint (or the reverse) is the card lying about the row.
  expect(row.inner_checkpoint !== null).toBe(c.reason.startsWith('resumed'))
  expect(seedLine).toContain(`reason=${c.reason}`)
  expect(seedLine).toContain('note=')
  expect(seedLine).toContain(note.slice(0, 20))
})

test('a first dispatch, with no prior run to state anything about, writes no note', async () => {
  const f = await fixture()
  const { value: result, seedLine } = await withSeedLine(() =>
    f.dispatch(HEAD, null, 'Write an unrelated documentation card that has never been built before'))
  expect(result.ok, JSON.stringify(result)).toBe(true)
  if (!result.ok) return
  expect(f.store.get(result.run.id)!.resume_note).toBeNull()
  // …and the log line is not emitted either: there was no prior of any kind to ask about.
  expect(seedLine).toBeNull()
})

test("a first dispatch whose slug collides with ANOTHER card's run is not told it was not resumed", async () => {
  const f = await fixture()
  // Same first 35 characters as TASK, so `slugifyTask` gives the prior's slug, but a
  // different card: different task text, and the card links no run.
  const colliding = `${TASK} — a different card entirely`
  expect(slugifyTask(colliding)).toBe(slugifyTask(TASK))
  const { value: result, seedLine } = await withSeedLine(() => f.dispatch(HEAD, null, colliding))
  expect(result.ok, JSON.stringify(result)).toBe(true)
  if (!result.ok) return
  expect(f.store.get(result.run.id)!.resume_note).toBeNull()
  // The slug match is still reported to the operator, as another run for the slug.
  expect(seedLine).toContain(`other_prior_for_slug=${f.prior.id}`)
})

test('the carried and fresh budget wordings follow the row, not the reason', async () => {
  // A card holding its own budget snapshot carries it even when it names no run — the
  // sentence must say "carried" there, and "fresh" only when nothing was inherited.
  const f = await fixture({ cardRound: 5 })
  const result = await f.dispatch(HEAD, null)
  expect(result.ok, JSON.stringify(result)).toBe(true)
  if (!result.ok) return
  const row = f.store.get(result.run.id)!
  expect(row.ralph_round).toBe(5)
  expect(row.resume_note).toBe(
    `Not resumed: the card names no prior run, so this is a fresh build; Ralph round 5/${row.max_ralph_rounds} carried.`)
})
