import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, unlinkSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { fakeRunner, type BoundedWorkOutcome, type BoundedWorkRequest, type ProviderObservation } from '@neutronai/runtime/bounded-work.ts'
import { seedMigratedDb } from '../tests/support/migrated-db.ts'
import { TridentRunStore } from './store.ts'
import { TridentPhaseUsageStore } from './phase-usage.ts'
import { TridentAttemptLedger } from './attempt-ledger.ts'
import { AttemptAccounting } from './attempt-accounting.ts'

let dir: string, db: ProjectDb, ledger: TridentAttemptLedger, accounting: AttemptAccounting, now: number
const events: string[] = []
const request: BoundedWorkRequest = { run_id: 'run', step_id: 'build:0', role: 'build', model_id: 'resolved',
  effort: null, cwd: '/repo', writable: true, network: false, tools: 'edit', brief: { path: '/brief', integrity: 'hash' },
  result: { path: '/result', schema: 'test' }, thread: null, budget: { wall_ms: 100 }, needs_approval_decision: false }
const attribution = { phase: 'build', task_id: 'task-1', head_sha: 'a'.repeat(40), review_seat: null, requested_model: 'selected' }
const observed: ProviderObservation = { source: 'codex-cli-jsonl', started_at_ms: 11, finished_at_ms: 20, observed_at_ms: 20,
  model_reported: 'reported', thread_id: 'thread', usage: { input_tokens: 17, output_tokens: 4,
    cache_read_input_tokens: 8, cache_creation_input_tokens: 0, cost_usd: null } }
const key = { run_id: 'run', step_id: 'build:0', attempt_id: 'dispatch' }
const projection = () => new TridentPhaseUsageStore(db).list('run')!.find(row => row.phase === 'build')!
function createAccounting() { return new AttemptAccounting(ledger, dir, async stage => { events.push(stage) }, () => ++now) }
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'attempt-accounting-')); seedMigratedDb(join(dir, 'project.db'))
  db = ProjectDb.open(join(dir, 'project.db'))
  await new TridentRunStore(db).create({ id: 'run', slug: 'run', project_slug: 'project', repo_path: '/repo', task: 'Build' })
  now = 30; events.length = 0; ledger = new TridentAttemptLedger(db); accounting = createAccounting()
})
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })
async function dispatch(outcome: BoundedWorkOutcome, req = request) {
  await accounting.prepare(req, 'openai-codex', 'headless', attribution, async () => {})
  return accounting.run(fakeRunner('openai-codex', { outcomes: new Map([[req.step_id, outcome]]) }), req, 'headless', new AbortController().signal)
}

test.each(['completed', 'blocked', 'refused', 'failed', 'unknown'] as const)('keeps absolute provider observations when the result is %s', async kind => {
  const outcomes: Record<typeof kind, BoundedWorkOutcome> = {
    completed: { kind: 'completed', result: { approved: true }, usage: null, model_reported: null, thread_id: null },
    blocked: { kind: 'blocked', on: 'capacity' }, refused: { kind: 'refused', reason: 'cli-contract' },
    failed: { kind: 'failed', class: 'infra', detail: 'bad trailer' }, unknown: { kind: 'unknown', detail: 'partial response' },
  }
  const outcome = { ...outcomes[kind], observation: observed }
  expect(await dispatch(outcome)).toEqual(outcome)
  expect(ledger.get(key)).toMatchObject({ ...attribution, provider: 'openai-codex', resolved_model: 'resolved', placement: 'headless',
    outcome: kind, queued_at: 31, prepared_at: 32, started_at: 33, ended_at: 34 })
  expect(ledger.receipt(key)).toMatchObject({ source: 'codex-cli-jsonl', model_reported: 'reported', input_tokens: 17, cost_usd: null })
  expect(projection()).toMatchObject({ input_tokens: 17, output_tokens: 4, cache_read_tokens: 8, status: 'partial' })
})

test('missing measurements stay unknown, while a measured zero and a nonzero attempt survive independently', async () => {
  const completed = { kind: 'completed', result: {}, usage: null, model_reported: null, thread_id: null } as const
  expect(await dispatch(completed)).toEqual(completed)
  expect(projection()).toMatchObject({ status: 'unknown', input_tokens: null })
  expect(ledger.get(key)!.outcome).toBe('completed')
  expect(ledger.receipt(key)).toBeNull()
  const zero = { ...observed, usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cost_usd: 0 } }
  await dispatch({ ...completed, observation: zero }, { ...request, step_id: 'build:1' })
  await dispatch({ ...completed, observation: observed }, { ...request, step_id: 'build:2' })
  expect(ledger.receipt({ ...key, step_id: 'build:1' })!.input_tokens).toBe(0)
  expect(ledger.receipt({ ...key, step_id: 'build:2' })!.input_tokens).toBe(17)
  expect(projection().input_tokens).toBeNull()
})

test('duplicate completion and restart never add the same absolute receipt twice or erase prior partial spend', async () => {
  const outcome: BoundedWorkOutcome = { kind: 'failed', class: 'infra', detail: 'partial', observation: observed }
  await dispatch(outcome)
  const first = ledger.get(key)
  await dispatch(outcome)
  db.close(); db = ProjectDb.open(join(dir, 'project.db')); ledger = new TridentAttemptLedger(db); accounting = createAccounting()
  await dispatch({ ...outcome, observation: { ...observed, observed_at_ms: 21,
    usage: { ...observed.usage, input_tokens: null, output_tokens: 5 } } })
  expect(ledger.get(key)).toEqual(first)
  expect(projection()).toMatchObject({ input_tokens: 17, output_tokens: 5, cache_read_tokens: 8 })
  expect(ledger.list('run')).toHaveLength(1)
})

test('telemetry faults neither authorize a failure nor veto a completed result', async () => {
  const completed: BoundedWorkOutcome = { kind: 'completed', result: {}, usage: null, model_reported: null, thread_id: null,
    observation: { ...observed, usage: { ...observed.usage, input_tokens: -1 } } }
  expect((await dispatch(completed)).kind).toBe('completed')
  expect(ledger.receipt(key)).toBeNull()
  expect(events).toContain('attempt-accounting-refused')
  expect((await dispatch({ ...completed, kind: 'failed', class: 'infra', detail: 'invalid result' }, { ...request, step_id: 'build:1' })).kind).toBe('failed')
})

test('preparation and runner failures retain an attributable outcome without fabricating usage', async () => {
  await expect(accounting.prepare(request, 'openai-codex', 'headless', attribution, async () => { throw Error('prepare') })).rejects.toThrow('prepare')
  expect(ledger.get(key)).toMatchObject({ outcome: 'failed', started_at: null })
  const req = { ...request, step_id: 'build:1' }
  await accounting.prepare(req, 'openai-codex', 'headless', attribution, async () => {})
  const controller = new AbortController()
  await expect(accounting.run({ ...fakeRunner('openai-codex'), run: async () => { controller.abort(); throw Error('interrupted') } }, req, 'headless', controller.signal)).rejects.toThrow('interrupted')
  expect(ledger.get({ ...key, step_id: req.step_id })!.outcome).toBe('interrupted')
})

test('attribution mismatch refuses execution but a matching recovery still reaches the substrate recovery protocol', async () => {
  await accounting.prepare(request, 'openai-codex', 'headless', attribution, async () => {})
  const runner = fakeRunner('openai-codex')
  await expect(accounting.run(runner, { ...request, model_id: 'other' }, 'headless', new AbortController().signal)).rejects.toThrow('matching host preparation')
  expect(runner.calls).toHaveLength(0)
  await accounting.run(runner, request, 'headless', new AbortController().signal)
  await accounting.run(runner, request, 'headless', new AbortController().signal)
  expect(runner.calls).toHaveLength(2)
  expect(ledger.list('run')).toHaveLength(1)
})

test('abort records interruption while a transport is still draining, and late partial usage is retained', async () => {
  await accounting.prepare(request, 'openai-codex', 'headless', attribution, async () => {})
  let started!: () => void, finish!: (outcome: BoundedWorkOutcome) => void
  const running = new Promise<void>(resolve => { started = resolve })
  const result = new Promise<BoundedWorkOutcome>(resolve => { finish = resolve })
  const controller = new AbortController()
  const dispatching = accounting.run({ ...fakeRunner('openai-codex'), run: async () => { started(); return result } }, request, 'headless', controller.signal)
  await running
  controller.abort()
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(ledger.get(key)!.outcome).toBe('interrupted')
  expect(ledger.receipt(key)).toBeNull()
  finish({ kind: 'failed', class: 'killed', detail: 'cancelled', observation: observed })
  expect((await dispatching).kind).toBe('failed')
  expect(ledger.get(key)!.outcome).toBe('interrupted')
  expect(projection().output_tokens).toBe(4)
})

test('unavailable event sink cannot veto successful work, invalid telemetry, timed proof or cleanup', async () => {
  accounting = new AttemptAccounting(ledger, dir, async () => { throw Error('sink unavailable') }, () => ++now)
  const completed: BoundedWorkOutcome = { kind: 'completed', result: {}, usage: null, model_reported: null, thread_id: null,
    observation: observed }
  expect((await dispatch(completed)).kind).toBe('completed')
  expect(projection().output_tokens).toBe(4)
  const invalid = { ...completed, observation: { ...observed, usage: { ...observed.usage, input_tokens: -1 } } }
  expect((await dispatch(invalid, { ...request, step_id: 'build:1' })).kind).toBe('completed')
  expect(await accounting.interval('cleanup', {}, async () => 'cleaned')).toBe('cleaned')
  await expect(accounting.interval('proof', {}, async () => { throw Error('proof failed') })).rejects.toThrow('proof failed')
})

test('observation-only startup reconciliation ingests pre-crash spend without dispatching or authorizing a pending result', async () => {
  await accounting.prepare(request, 'openai-codex', 'headless', attribution, async () => {})
  await ledger.lifecycle(key, { started_at: 33 })
  const runner = { ...fakeRunner('openai-codex'), observe: async (req: BoundedWorkRequest) => {
    expect(req).toEqual(request)
    return observed
  } }
  accounting = createAccounting()
  await accounting.reconcile('run', () => runner)
  await accounting.reconcile('run', () => runner)
  expect(runner.calls).toHaveLength(0)
  expect(ledger.get(key)).toMatchObject({ outcome: null, ended_at: null })
  expect(projection()).toMatchObject({ input_tokens: 17, output_tokens: 4 })
  expect(ledger.list('run')).toHaveLength(1)
})

test('recovery reuses a started journal after restart without another dispatch or accounting start', async () => {
  await accounting.prepare(request, 'openai-codex', 'headless', attribution, async () => {})
  await ledger.lifecycle(key, { started_at: 33 })
  let recoveries = 0
  const runner = { ...fakeRunner('openai-codex'), recover: async (req: BoundedWorkRequest) => {
    recoveries++; expect(req).toEqual(request)
    return { kind: 'completed', result: { approved: true }, usage: null, model_reported: null, thread_id: 'thread', observation: observed } as const
  } }
  db.close(); db = ProjectDb.open(join(dir, 'project.db')); ledger = new TridentAttemptLedger(db); accounting = createAccounting()
  for (let i = 0; i < 2; i++) expect((await accounting.recover(runner, request, 'headless', new AbortController().signal)).kind).toBe('completed')
  expect(recoveries).toBe(2); expect(runner.calls).toHaveLength(0)
  expect(ledger.list('run')).toHaveLength(1)
  expect(ledger.get(key)).toMatchObject({ queued_at: 31, prepared_at: 32, started_at: 33, outcome: 'completed' })
  expect(projection()).toMatchObject({ input_tokens: 17, output_tokens: 4 })
})

test.each(['missing-attempt', 'unstarted', 'missing-journal', 'corrupt-journal', 'symlink', 'attribution', 'capability',
  'brief', 'model', 'tools', 'thread', 'result', 'budget', 'provider', 'placement'] as const)('recovery refuses %s without dispatch, observation, or new evidence', async defect => {
  if (defect !== 'missing-attempt') {
    await accounting.prepare(request, 'openai-codex', 'headless', attribution, async () => {})
    if (defect !== 'unstarted') await ledger.lifecycle(key, { started_at: 33 })
  }
  const path = readdirSync(dir).find(name => name.startsWith('attempt-request-'))
  if (path && ['missing-journal', 'corrupt-journal', 'symlink', 'attribution'].includes(defect)) {
    const target = join(dir, path), original = readFileSync(target, 'utf8')
    if (defect === 'missing-journal') unlinkSync(target)
    if (defect === 'corrupt-journal') writeFileSync(target, '{')
    if (defect === 'attribution') { const saved = JSON.parse(original); saved.attribution.head_sha = 'b'.repeat(40); writeFileSync(target, JSON.stringify(saved)) }
    if (defect === 'symlink') { writeFileSync(`${target}.copy`, original); unlinkSync(target); symlinkSync(`${target}.copy`, target) }
  }
  let recoveries = 0, observations = 0
  const runner = { ...fakeRunner(defect === 'provider' ? 'anthropic' : 'openai-codex'),
    observe: async () => { observations++; return observed },
    ...(defect === 'capability' ? {} : { recover: async () => { recoveries++; return { kind: 'completed', result: {}, usage: null, model_reported: null, thread_id: null } as const } }) }
  const req = { ...request,
    ...(defect === 'brief' ? { brief: { ...request.brief, integrity: 'changed-task' } } : {}),
    ...(defect === 'model' ? { model_id: 'other' } : {}), ...(defect === 'tools' ? { tools: 'none' as const } : {}),
    ...(defect === 'thread' ? { thread: { id: 'other' } } : {}),
    ...(defect === 'result' ? { result: { ...request.result, path: '/other' } } : {}),
    ...(defect === 'budget' ? { budget: { wall_ms: 99 } } : {}),
  }
  const before = ledger.list('run')
  expect((await accounting.recover(runner, req, defect === 'placement' ? 'in-repl' : 'headless', new AbortController().signal)).kind).toBe('unknown')
  expect(recoveries).toBe(0); expect(observations).toBe(0); expect(runner.calls).toHaveLength(0)
  expect(ledger.list('run')).toEqual(before); expect(ledger.receipt(key)).toBeNull()
})

test('uncertain recovery retains partial spend without claiming a terminal attempt', async () => {
  await accounting.prepare(request, 'openai-codex', 'headless', attribution, async () => {})
  await ledger.lifecycle(key, { started_at: 33 })
  const runner = { ...fakeRunner('openai-codex'), recover: async () => ({ kind: 'unknown', detail: 'still pending', observation: observed } as const) }
  expect((await accounting.recover(runner, request, 'headless', new AbortController().signal)).kind).toBe('unknown')
  expect(ledger.get(key)).toMatchObject({ ended_at: null, outcome: null })
  expect(projection().input_tokens).toBe(17); expect(runner.calls).toHaveLength(0)
})

test('reconciliation refuses mismatched or symlinked journals before observing and retains earlier nonzero spend', async () => {
  await dispatch({ kind: 'failed', class: 'infra', detail: 'partial', observation: observed })
  const path = join(dir, readdirSync(dir).find(name => name.startsWith('attempt-request-'))!)
  const original = JSON.parse(readFileSync(path, 'utf8'))
  let reads = 0
  const runner = { ...fakeRunner('openai-codex'), observe: async () => { reads++; return observed } }
  await accounting.reconcile('run', () => runner)
  expect(reads).toBe(1)
  for (const corrupt of [
    { ...original, request: { ...original.request, run_id: 'another-run' } },
    { ...original, request: { ...original.request, model_id: 'another-model' } },
    { ...original, attribution: { ...original.attribution, head_sha: 'b'.repeat(40) } },
  ]) {
    writeFileSync(path, JSON.stringify(corrupt))
    await accounting.reconcile('run', () => runner)
    expect(reads).toBe(1)
    expect(projection().input_tokens).toBe(17)
  }
  writeFileSync(`${path}.copy`, JSON.stringify(original))
  unlinkSync(path); symlinkSync(`${path}.copy`, path)
  await accounting.reconcile('run', () => runner)
  expect(reads).toBe(1)
  expect(projection().input_tokens).toBe(17)
  expect(events).toContain('attempt-reconciliation-unavailable')
})
