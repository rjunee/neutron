import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { Database } from 'bun:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { seedMigratedDb } from '../tests/support/migrated-db.ts'
import { TridentRunStore } from './store.ts'
import { TridentPhaseUsageStore } from './phase-usage.ts'
import { TridentAttemptLedger, type AttemptIdentity, type AttemptReceipt } from './attempt-ledger.ts'

let dir: string
let db: ProjectDb
let ledger: TridentAttemptLedger
const identity: AttemptIdentity = {
  run_id: 'run', step_id: 'build-1', attempt_id: 'first', phase: 'build', task_id: 'task-1',
  head_sha: 'a'.repeat(40), role: 'build', review_seat: null, provider: 'codex',
  requested_model: 'model', resolved_model: 'model-resolved', placement: 'headless', queued_at: 10,
}
const receipt: AttemptReceipt = {
  receipt_id: 'provider-call-1', source: 'provider-stream/v1', observed_at: 100,
  model_reported: 'model-observed', input_tokens: 100, output_tokens: 20,
  cache_read_tokens: 50, cache_creation_tokens: 0, cost_usd: 0.1,
}
const projection = () => new TridentPhaseUsageStore(db).list('run')!.find((row) => row.phase === 'build')!
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'attempt-ledger-'))
  seedMigratedDb(join(dir, 'project.db'))
  db = ProjectDb.open(join(dir, 'project.db'))
  await new TridentRunStore(db).create({ id: 'run', slug: 'run', project_slug: 'project', repo_path: '/repo', task: 'build' })
  ledger = new TridentAttemptLedger(db)
})
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

test('admission survives reconstruction; duplicate identity is inert and changed ownership refused', async () => {
  expect(await ledger.admit(identity)).toBe('recorded')
  expect(await ledger.admit(identity)).toBe('duplicate')
  for (const field of ['head_sha', 'task_id', 'phase', 'provider', 'resolved_model', 'requested_model', 'role', 'review_seat', 'placement'] as const) {
    await expect(ledger.admit({ ...identity, [field]: 'different' } as AttemptIdentity)).rejects.toThrow('identity conflict')
  }
  db.close()
  db = ProjectDb.open(join(dir, 'project.db'))
  ledger = new TridentAttemptLedger(db)
  expect(await ledger.admit(identity)).toBe('duplicate')
  expect(ledger.list('run')).toHaveLength(1)
  expect(ledger.get(identity)).toEqual({ ...identity, prepared_at: null, started_at: null, ended_at: null, outcome: null })
  expect(projection().status).toBe('unknown')
})

test('duplicate receipt cannot add spend, while a distinct failed attempt does', async () => {
  await ledger.admit(identity)
  expect(await ledger.observe(identity, receipt)).toBe('recorded')
  expect(await ledger.observe(identity, receipt)).toBe('stale')
  const second = { ...identity, attempt_id: 'second' }
  await ledger.admit(second)
  // A pending call is an unknown operand, not zero spend.
  expect(projection().input_tokens).toBeNull()
  expect(ledger.receipt(identity)!.input_tokens).toBe(100)
  await ledger.observe(second, { ...receipt, receipt_id: 'provider-call-2' })
  await ledger.lifecycle(second, { started_at: 20, ended_at: 120, outcome: 'failed' })
  expect(projection()).toMatchObject({ status: 'complete', input_tokens: 200, output_tokens: 40, cost_usd: 0.2 })
  expect(await ledger.observe(identity, { ...receipt, observed_at: 99, input_tokens: 999 })).toBe('stale')
  expect(projection().input_tokens).toBe(200)
  await expect(ledger.observe(second, { ...receipt, observed_at: 101 })).rejects.toThrow('ownership conflict')
})

test('the same provider receipt cannot be attributed to two attempts', async () => {
  const second = { ...identity, attempt_id: 'second' }
  await ledger.admit(identity)
  await ledger.admit(second)
  await ledger.observe(identity, receipt)
  await expect(ledger.observe(second, receipt)).rejects.toThrow()
  expect(ledger.receipt(second)).toBeNull()
  await ledger.observe(second, { ...receipt, receipt_id: 'different-call' })
  expect(projection().input_tokens).toBe(200)
})

test('missing, measured zero, and partial streaming measurements remain distinct after failure', async () => {
  await ledger.admit(identity)
  await ledger.observe(identity, { ...receipt, input_tokens: null, output_tokens: null,
    cache_read_tokens: null, cache_creation_tokens: null, cost_usd: null, model_reported: null })
  expect(projection()).toMatchObject({ status: 'unknown', input_tokens: null, source: null })
  expect(ledger.receipt(identity)!.source).toBe(receipt.source)
  await ledger.observe(identity, { ...receipt, observed_at: 101, input_tokens: 0, output_tokens: 0,
    cache_read_tokens: 0, cache_creation_tokens: 0, cost_usd: null })
  await ledger.lifecycle(identity, { ended_at: 102, outcome: 'failed' })
  expect(projection()).toMatchObject({ status: 'partial', input_tokens: 0, cost_usd: null })
  await ledger.observe(identity, { ...receipt, observed_at: 103, input_tokens: 0, output_tokens: 0,
    cache_read_tokens: 0, cache_creation_tokens: 0, cost_usd: 0 })
  expect(projection()).toMatchObject({ status: 'complete', input_tokens: 0, cost_usd: 0 })
})

test('newer cumulative observations replace rather than add and cannot erase earlier spend', async () => {
  await ledger.admit(identity)
  await ledger.observe(identity, receipt)
  await ledger.observe(identity, { ...receipt, observed_at: 200, input_tokens: 150 })
  expect(projection().input_tokens).toBe(150)
  await expect(ledger.observe(identity, { ...receipt, observed_at: 300, input_tokens: 150, model_reported: 'another-model' })).rejects.toThrow('model conflict')
  for (const input_tokens of [0, null]) {
    await expect(ledger.observe(identity, { ...receipt, observed_at: 300, input_tokens })).rejects.toThrow('regressed')
  }
  expect(projection().input_tokens).toBe(150)
})

test('lifecycle recovery fills holes in either order without rewriting terminal evidence', async () => {
  await ledger.admit(identity)
  await ledger.lifecycle(identity, { ended_at: 90, outcome: 'interrupted' })
  await ledger.lifecycle(identity, { started_at: 30 })
  await ledger.lifecycle(identity, { prepared_at: 20 })
  await ledger.lifecycle(identity, { ended_at: 90, outcome: 'interrupted' })
  expect(ledger.get(identity)).toMatchObject({ queued_at: 10, prepared_at: 20, started_at: 30, ended_at: 90, outcome: 'interrupted' })
  await expect(ledger.lifecycle(identity, { outcome: 'completed' })).rejects.toThrow('conflict')
  const second = { ...identity, attempt_id: 'second' }
  await ledger.admit(second)
  await ledger.lifecycle(second, { prepared_at: 20, started_at: 30 })
  await ledger.lifecycle(second, { ended_at: 90, outcome: 'interrupted' })
  expect(ledger.get(second)).toEqual({ ...ledger.get(identity)!, attempt_id: 'second' })
  await expect(ledger.lifecycle({ ...identity, attempt_id: 'absent' }, { started_at: 30 })).rejects.toThrow('unknown attempt')
})

test('observation replay permutations and reopened hosts produce identical totals', async () => {
  const second = { ...identity, attempt_id: 'second' }
  await ledger.admit(identity)
  await ledger.admit(second)
  const events = [
    [identity, receipt],
    [identity, { ...receipt, observed_at: 200, input_tokens: 150 }],
    [second, { ...receipt, receipt_id: 'other-call', observed_at: 150 }],
  ] as const
  for (const [key, observation] of events) await ledger.observe(key, observation)
  const expected = projection()
  db.close()
  db = ProjectDb.open(join(dir, 'project.db'))
  ledger = new TridentAttemptLedger(db)
  for (const [key, observation] of [...events].reverse()) await ledger.observe(key, observation)
  expect(projection()).toEqual(expected)
  expect(expected).toMatchObject({ input_tokens: 250, cost_usd: 0.2, observed_at: 200 })
  await new TridentRunStore(db).create({ id: 'reverse', slug: 'reverse', project_slug: 'project', repo_path: '/repo', task: 'build' })
  for (const key of [identity, second]) await ledger.admit({ ...key, run_id: 'reverse' })
  for (const [key, observation] of [...events].reverse()) await ledger.observe({ ...key, run_id: 'reverse' }, observation)
  const reversed = new TridentPhaseUsageStore(db).list('reverse')!.find((row) => row.phase === 'build')!
  expect(reversed).toEqual({ ...expected, run_id: 'reverse' })
})

test('forward migration preserves historical cumulative reports without fabricating attempts', () => {
  const old = new Database(':memory:')
  try {
    old.exec("CREATE TABLE code_trident_runs (id TEXT PRIMARY KEY); INSERT INTO code_trident_runs VALUES ('historical')")
    old.exec(readFileSync(new URL('../migrations/0144_trident_phase_usage.sql', import.meta.url), 'utf8'))
    old.exec("UPDATE code_trident_phase_usage SET status = 'partial', input_tokens = 42, source = 'historical-provider', observed_at = 100 WHERE phase = 'build'")
    const before = old.query('SELECT * FROM code_trident_phase_usage ORDER BY phase').all()
    old.exec(readFileSync(new URL('../migrations/0156_trident_attempt_ledger.sql', import.meta.url), 'utf8'))
    expect(old.query('SELECT * FROM code_trident_phase_usage ORDER BY phase').all()).toEqual(before)
    expect(old.query('SELECT * FROM code_trident_attempts').all()).toEqual([])
    expect(old.query('SELECT input_tokens FROM code_trident_phase_usage WHERE phase = \'build\'').get()).toEqual({ input_tokens: 42 })
  } finally { old.close() }
})

test('legacy phase reports and attempt projections cannot overwrite one another', async () => {
  const phases = new TridentPhaseUsageStore(db)
  const report = { ...receipt, status: 'complete' as const }
  await phases.record('run', 'build', report)
  await expect(ledger.admit(identity)).rejects.toThrow('legacy')
  const review = { ...identity, phase: 'review_codex' }
  await ledger.admit(review)
  await expect(phases.record('run', 'review_codex', report)).rejects.toThrow('owns this phase')
  expect(await phases.record('run', 'synthesis', report)).toBe('recorded')
  expect(projection().input_tokens).toBe(100)
  await phases.record('run', 'bookkeeping', { ...report, source: 'attempt-ledger/v1' })
  await expect(ledger.admit({ ...identity, step_id: 'bookkeeping-1', phase: 'bookkeeping' })).rejects.toThrow('legacy')
})

test('SQLite and typed writers refuse invalid measurements with nonzero positive controls', async () => {
  await ledger.admit(identity)
  await ledger.observe(identity, receipt)
  for (const field of ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens', 'observed_at'] as const) {
    for (const value of [-1, 0.5, 9007199254740992]) {
      expect(() => db.runSync(`UPDATE code_trident_attempt_receipts SET ${field} = ?`, [value])).toThrow()
    }
  }
  for (const value of [-1, Infinity]) {
    expect(() => db.runSync('UPDATE code_trident_attempt_receipts SET cost_usd = ?', [value])).toThrow()
  }
  for (const field of ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens', 'observed_at', 'cost_usd'] as const) {
    await expect(ledger.observe(identity, { ...receipt, observed_at: 200, [field]: NaN })).rejects.toThrow(TypeError)
  }
  expect(ledger.receipt(identity)!.input_tokens).toBe(100)
  expect(projection().input_tokens).toBe(100)
})

test('SQL rejects orphans, invalid ownership metadata, and impossible lifecycle times', async () => {
  await ledger.admit(identity)
  for (const [field, value] of [['phase', 'absent'], ['run_id', 'absent'], ['placement', 'guess'],
    ['resolved_model', ' '], ['queued_at', -1], ['prepared_at', 1], ['started_at', 1], ['ended_at', 100], ['outcome', 'completed']] as const) {
    expect(() => db.runSync(`UPDATE code_trident_attempts SET ${field} = ?`, [value])).toThrow()
  }
  await ledger.lifecycle(identity, { prepared_at: 20, started_at: 30, ended_at: 40, outcome: 'completed' })
  for (const [field, value] of [['prepared_at', 31], ['started_at', 41], ['ended_at', 29]] as const) {
    expect(() => db.runSync(`UPDATE code_trident_attempts SET ${field} = ?`, [value])).toThrow()
  }
  await ledger.observe(identity, receipt)
  db.runSync("DELETE FROM code_trident_runs WHERE id = 'run'")
  expect(ledger.list('run')).toEqual([])
  expect(ledger.receipt(identity)).toBeNull()
})
