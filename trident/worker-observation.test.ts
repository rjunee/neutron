import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { seedMigratedDb } from '../tests/support/migrated-db.ts'
import { TridentRunStore } from './store.ts'
import { buildTridentOrchestrator } from './orchestrator.ts'
import { interpretFailure } from './delivery.ts'
import { makeTridentRun } from './testing/make-trident-run.ts'
import { unknownWorkerObservation, type RunWorkerObservation } from './worker-observation.ts'

const cleanup: Array<() => void> = []
afterEach(() => { while (cleanup.length) cleanup.pop()!() })
const menu = 'Choose organization\n❯ Alpha\n  Beta\nEnter to select'
function harness(state: RunWorkerObservation['state'], hang = 60_000) {
  return buildTridentOrchestrator({
    fire_workflow: async () => { throw new Error('must not relaunch') },
    db_path: '/tmp/worker-observation-test.db',
    run_host: async () => ({ ok: false, exit_code: 1, stdout: '', stderr: 'no repository' }),
    base_branch: 'main', on_orphaned_session: 'wait',
    no_advance_hang_ms: hang, max_inflight_ms: 120_000,
    now: () => new Date(180_000).toISOString(),
    observe_run_worker: async () => ({
      state, observed_at: new Date(180_000).toISOString(), detail: 'sampled',
      screen: state === 'blocked' ? menu : 'last visible output',
    }),
  })
}

test('blocked fails before the hang budget and persists the prompt across reopen', async () => {
  const root = mkdtempSync(join(tmpdir(), 'worker-observation-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const path = join(root, 'project.db')
  seedMigratedDb(path)
  let db = ProjectDb.open(path)
  cleanup.push(() => db.close())
  const store = new TridentRunStore(db)
  const run = await store.create({ slug: 'worker-observation', project_slug: 'test', repo_path: root, task: 'work' })
  await store.update(run.id, { subagent_status: 'running', subagent_run_id: 'worker' })
  const { step } = harness('blocked', 999_999)
  const out = await step(store.get(run.id)!)
  expect(out.run.phase).toBe('failed')
  expect(out.run.failure_reason).toContain(menu)
  expect(out.run.failure_reason).toContain('worker=blocked')
  await store.saveIfActive(out.run)
  db.close()
  db = ProjectDb.open(path)
  const saved = new TridentRunStore(db).get(run.id)!
  expect(saved.failure_reason).toContain(menu)
  expect(interpretFailure(saved).klass).toBe('infra')
})

// BOTH DIRECTIONS OF THE REPRIEVE. A working control must spare a slow build from
// the checkpoint-silence deadline — turning a slow build into a false failure is
// the expensive mistake — but it must NOT outrank the in-flight ceiling: a visible
// interrupt control proves a turn is in flight, not that it is progressing, and an
// unbounded lane is not an improvement on a bounded wrong answer.
test.each([60_000, 999_999])('slow work survives the no-advance deadline, hang budget %s', async (hang) => {
  const { step } = harness('working', hang)
  // now() is 180_000 and the ceiling is 120_000, so the run must sit INSIDE it.
  const out = await step(makeTridentRun({ last_advanced_at: new Date(120_000).toISOString() }))
  expect(out.run.phase).not.toBe('failed')
  expect(out.waiting).toBe(true)
  expect(out.changed).toBe(true)
  expect(out.note).toContain('worker=working')
})

test('a working control does not outrank the in-flight ceiling', async () => {
  const { step } = harness('working')
  // 180 s elapsed against a 120 s ceiling (and a 60 s no-advance budget).
  const out = await step(makeTridentRun({ last_advanced_at: new Date(0).toISOString() }))
  expect(out.run.phase).toBe('failed')
  expect(out.run.failure_reason).toContain('no terminal result within')
  // The evidence still says what was actually seen — the ceiling terminates the
  // run, it does not relabel the observation.
  expect(out.run.failure_reason).toContain('worker=working')
})

test('unknown remains explicit on timeout, with captured output', async () => {
  const { step } = harness('unknown')
  const out = await step(makeTridentRun({ last_advanced_at: new Date(0).toISOString() }))
  expect(out.run.failure_reason).toContain('worker=unknown')
  expect(out.run.failure_reason).toContain('last visible output')
  expect(out.run.failure_reason).not.toContain('worker blocked:')
  expect(out.run.failure_reason).not.toContain('suspected agent hang')
  expect(interpretFailure(out.run).klass).toBe('infra')
})

test('captured prose cannot change the blocked delivery class', () => {
  const r = makeTridentRun({ phase: 'failed', failure_reason: `worker blocked: prompt\n${menu}\nstalled conflict exhausted` })
  expect(interpretFailure(r).klass).toBe('infra')
  expect(unknownWorkerObservation('unavailable').state).toBe('unknown')
})
