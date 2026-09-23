import { expect, test } from 'bun:test'
import { parseBuildModeState, readBuildRetrySource, retryModeSource, retrySourceIdentity } from './build-mode-state.ts'
import type { TridentRun, TridentRunStore } from './store.ts'

const head = 'a'.repeat(40)
const base = 'b'.repeat(40)
const oldPlan = { implementationPlan: '- [ ] T1: Finish', topTask: '- [ ] T1: Finish',
  executionSpec: 'Finish', complexity: 'mechanical', remainingTasks: 0 }
const run = (patch: Partial<TridentRun> = {}): TridentRun => ({
  id: 'run', branch: 'change', base_sha: base, repo_path: '/repo', project_slug: 'project',
  merge_mode: 'local', worktree: '/repo/work', task: 'Implement the change', phase: 'failed',
  execution_strategy: 'task_sequence', strategy_source: 'legacy', task_iteration: 4, max_task_iterations: 8,
  ...patch,
} as TridentRun)
const state = <P extends Record<string, unknown>>(row: TridentRun, patch: P = {} as P) => ({
  runId: row.id, branch: row.branch, base: row.base_sha, repo: row.repo_path, projectSlug: row.project_slug,
  mergeMode: row.merge_mode, worktree: row.worktree, iteration: 4,
  checkpoint: { head, stage: 'built', round: 2, replansUsed: 1, findings: [], previousFindings: ['Prior finding'],
    previousBlockingCount: 1, previousReview: { findings: ['Prior finding'], blockingCount: 1 },
    reviewBaseline: 'required', ...patch }, consumed: { round: 3, head },
})
function store(rows: TridentRun[], events: Record<string, { id: number; stage: string; meta: string }[]>): TridentRunStore {
  return { get: (id: string) => rows.find(row => row.id === id) ?? null,
    stageEvents: (id: string) => events[id] ?? [] } as unknown as TridentRunStore
}

for (const stage of ['ralph-task-built', 'ralph-task-built-deviated']) {
  test(`legacy checkpoint ${stage} translates without changing spend or history`, () => {
    const row = run()
    const before = state(row, { stage })
    const meta = JSON.stringify(before)
    expect(parseBuildModeState(meta, row) as unknown).toEqual({ ...before,
      checkpoint: { ...before.checkpoint, stage: stage.replace('ralph-', '') } })
    expect(JSON.parse(meta)).toEqual(before)
    for (const strategy_source of ['planner', null] as const)
      expect(() => parseBuildModeState(meta, run({ strategy_source }))).toThrow('identity or state')
    expect(parseBuildModeState(JSON.stringify(state(row, { stage: 'task-built' })), run({ strategy_source: 'planner' })))
      .toMatchObject({ iteration: 4, checkpoint: { stage: 'task-built' } })
  })
}

function pending(row: TridentRun, mode = 'ralph') {
  const request = { run_id: row.id, step_id: 'run:task:4:build:2', role: 'build', model_id: 'model',
    budget: { wall_ms: 321 }, result: { schema: 'project-build', path: '/state/build.result' } }
  return state(row, { pending: { phase: 'build', step_id: request.step_id, recovery: {
    request, inputs: { run_id: row.id, mode, ralphRound: 4, maxRounds: 5,
      workers: { plan: { provider: 'pi', request: { result: { schema: 'project-plan' } } },
        build: { provider: 'pi', request } } }, round: 2, snapshot: { head, diff: '+change', pr: null },
    previous: structuredClone(oldPlan), findings: ['Prior finding'], planner: 'full', plan: structuredClone(oldPlan),
    previousReview: { findings: ['Prior finding'], blockingCount: 1 }, reviewBaseline: 'required',
  } } })
}

for (const [mode, strategy] of [['pr', 'single'], ['ralph', 'task_sequence']] as const) {
  test(`legacy pending ${mode} keeps the original request and budget`, () => {
    const row = run({ execution_strategy: strategy })
    const before = pending(row, mode)
    const parsed = parseBuildModeState(JSON.stringify(before), row)
    const recovery = parsed.checkpoint.pending!.recovery!
    const original = (before.checkpoint.pending as any).recovery
    expect(recovery).toEqual({ ...original, executionStrategy: strategy,
      inputs: { ...original.inputs, mode: 'implementation', ralphRound: undefined, taskIteration: 4 },
      plan: { ...oldPlan, strategy, rationale: expect.any(String) } })
    expect(recovery.inputs).not.toHaveProperty('ralphRound')
    expect(recovery.request).toEqual(original.request)
    expect(recovery.previous).toEqual(original.previous)
    expect(parsed.iteration).toBe(4)
    expect(parsed.checkpoint.replansUsed).toBe(1)
    expect(row.max_task_iterations).toBe(8)
    expect(parseBuildModeState(JSON.stringify(before), { ...row, strategy_source: 'planner' })
      .checkpoint.pending!.recovery).not.toHaveProperty('executionStrategy')
  })
}

test('a corrupt new checkpoint cannot use legacy provenance to fill missing selection', () => {
  const row = run()
  const value = pending(row, 'implementation')
  expect(parseBuildModeState(JSON.stringify(value), row).checkpoint.pending!.recovery)
    .not.toHaveProperty('executionStrategy')
  expect(() => parseBuildModeState(JSON.stringify(pending(row, 'pr')), row)).toThrow('contradicts')
  const partial = pending(row)
  ;(partial.checkpoint.pending as any).recovery.plan.strategy = 'single'
  expect(() => parseBuildModeState(JSON.stringify(partial), row)).toThrow('execution plan is invalid')
})

for (const [mode, strategy] of [['pr', 'single'], ['ralph', 'task_sequence']] as const) {
  test(`legacy ${mode} omitted iteration preserves old default zero without changing original evidence`, () => {
    const row = run({ execution_strategy: strategy, task_iteration: 0 })
    const value = pending(row, mode)
    const recovery = value.checkpoint.pending.recovery
    delete (recovery.inputs as Partial<typeof recovery.inputs>).ralphRound
    const meta = JSON.stringify(value)
    const normalized = parseBuildModeState(meta, row)
    expect(normalized.checkpoint.pending!.recovery!.inputs).toMatchObject({ mode: 'implementation', taskIteration: 0 })
    expect(normalized.checkpoint.pending!.recovery!.request as unknown).toEqual(recovery.request)
    expect(JSON.stringify(value)).toBe(meta)
    expect(normalized.iteration).toBe(4)
    expect(normalized.checkpoint.pending!.recovery!.inputs.maxRounds).toBe(5)
    expect(parseBuildModeState(meta, { ...row, strategy_source: 'planner' })
      .checkpoint.pending!.recovery!.inputs).not.toHaveProperty('taskIteration')
  })
}

test('legacy wave omitted iteration remains absent, and supplied malformed counts are not repaired', () => {
  const row = run({ execution_strategy: 'single' })
  const value = pending(row, 'wave')
  delete (value.checkpoint.pending.recovery.inputs as Partial<typeof value.checkpoint.pending.recovery.inputs>).ralphRound
  const normalized = parseBuildModeState(JSON.stringify(value), row)
  expect(normalized.checkpoint.pending!.recovery!.inputs).not.toHaveProperty('taskIteration')
  expect(normalized.checkpoint.pending!.recovery!.executionStrategy).toBeNull()
  for (const count of [null, -1, '0']) {
    const invalid = pending(row, 'pr')
    ;(invalid.checkpoint.pending.recovery.inputs as Record<string, unknown>).ralphRound = count
    expect(parseBuildModeState(JSON.stringify(invalid), row).checkpoint.pending!.recovery!.inputs.taskIteration as unknown).toBe(count)
  }
})

test('legacy single pending build recovers its validated previous plan without changing worker evidence', () => {
  const row = run({ execution_strategy: 'single' })
  const value = pending(row, 'pr')
  const original = value.checkpoint.pending.recovery as Omit<typeof value.checkpoint.pending.recovery, 'plan'> & { plan: unknown }
  original.plan = null
  original.previous.remainingTasks = 3
  const meta = JSON.stringify(value)
  const recovery = parseBuildModeState(meta, row).checkpoint.pending!.recovery!
  expect(recovery.plan).toMatchObject({ ...oldPlan, strategy: 'single', remainingTasks: 0 })
  expect(recovery.previous).toEqual({ ...oldPlan, remainingTasks: 3 })
  expect(recovery.request as unknown).toEqual(original.request)
  expect(JSON.stringify(value)).toBe(meta)
  expect(parseBuildModeState(meta, { ...row, strategy_source: 'planner' }).checkpoint.pending!.recovery!.plan).toBeNull()
  original.previous.remainingTasks = -1
  expect(() => parseBuildModeState(JSON.stringify(value), row)).toThrow('execution plan is invalid')
  original.previous.remainingTasks = 3
  original.previous.executionSpec = ''
  expect(() => parseBuildModeState(JSON.stringify(value), row)).toThrow('execution plan is invalid')
  ;(original as { previous: unknown }).previous = null
  expect(() => parseBuildModeState(JSON.stringify(value), row)).toThrow('execution plan is invalid')
})

test('legacy single pending planner cannot adopt its previous payload as a build plan', () => {
  const row = run({ execution_strategy: 'single' })
  const value = pending(row, 'pr')
  value.checkpoint.pending.phase = 'plan'
  ;(value.checkpoint.pending.recovery as { plan: unknown }).plan = null
  expect(parseBuildModeState(JSON.stringify(value), row).checkpoint.pending!.recovery!.plan).toBeNull()
})

for (const stage of ['built', 'fixed', 'task-built'] as const) {
  test(`unknown strategy cannot inherit ${stage} authority`, () => {
    const row = run()
    const events = { run: [{ id: 1, stage: 'build-mode-state', meta: JSON.stringify(state(row, { stage, remainingTasks: 0 })) }] }
    expect(retryModeSource(store([row], events), row)).not.toBeNull()
    expect(retryModeSource(store([row], events), { ...row, execution_strategy: null })).toBeNull()
    expect(retryModeSource(store([row], events), { ...row, execution_strategy: 'unknown' as any })).toBeNull()
  })
}

test('task-sequence builds need known terminal remainder, single builds do not', () => {
  const row = run()
  const events = { run: [{ id: 1, stage: 'build-mode-state', meta: JSON.stringify(state(row)) }] }
  expect(retryModeSource(store([row], events), row)).toBeNull()
  expect(retryModeSource(store([row], events), { ...row, execution_strategy: 'single' })).not.toBeNull()
})

for (const strategy of ['single', 'task_sequence'] as const) {
  test(`old boolean invalidation identity requires legacy ${strategy} provenance`, () => {
    const row = run({ execution_strategy: strategy })
    const prior = run({ id: 'prior', execution_strategy: strategy })
    const meta = JSON.stringify({ runId: row.id, priorRunId: prior.id, head })
    const identity = JSON.stringify([row.id, row.project_slug, row.repo_path, row.branch, row.task,
      row.merge_mode, strategy === 'task_sequence'])
    const proof = { runId: row.id, sourceEventId: 1, sourceMeta: meta, identity, recordedHead: head,
      baseSha: base, observedHead: 'c'.repeat(40) }
    const events = { run: [{ id: 1, stage: 'build-retry-source', meta },
      { id: 2, stage: 'build-retry-source-invalidated', meta: JSON.stringify(proof) }] }
    const db = store([row, prior], events)
    expect(readBuildRetrySource(db, row)).toBeNull()
    expect(() => readBuildRetrySource(db, { ...row, strategy_source: 'planner' })).toThrow('invalidation is invalid')
    expect(() => readBuildRetrySource(db, { ...row, execution_strategy: null })).toThrow('invalidation is invalid')
    expect(JSON.parse(retrySourceIdentity(row)).at(-1)).toBe(strategy)
    events.run[1]!.meta = JSON.stringify({ ...proof, identity: retrySourceIdentity(row) })
    expect(readBuildRetrySource(db, { ...row, strategy_source: 'planner' })).toBeNull()
    events.run[1]!.meta = JSON.stringify({ ...proof, identity: retrySourceIdentity(row), sourceEventId: 99 })
    expect(() => readBuildRetrySource(db, row)).toThrow('invalidation is invalid')
  })
}
