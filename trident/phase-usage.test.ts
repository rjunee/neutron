import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { seedMigratedDb } from '../tests/support/migrated-db.ts'
import { TRIDENT_PHASES } from './phase-models.ts'
import { TridentRunStore } from './store.ts'
import { TridentPhaseUsageStore, type PhaseUsageReport } from './phase-usage.ts'

let dir: string
let db: ProjectDb
let runs: TridentRunStore
let usage: TridentPhaseUsageStore
const complete: PhaseUsageReport = {
  status: 'complete', input_tokens: 100, output_tokens: 50,
  cache_read_tokens: 20, cache_creation_tokens: 10, cost_usd: 0.0123,
  source: 'phase-reporter/v1', observed_at: 1000,
}
const create = (id: string) => runs.create({ id, slug: id, project_slug: 'p', repo_path: '/repo', task: 'build' })
const build = () => usage.list('one')!.find((r) => r.phase === 'build')!

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'phase-usage-'))
  seedMigratedDb(join(dir, 'project.db'))
  db = ProjectDb.open(join(dir, 'project.db'))
  runs = new TridentRunStore(db)
  usage = new TridentPhaseUsageStore(db)
  await create('one')
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

test('every run gets the full model-phase catalog with unknown, not zero, measurements', async () => {
  await create('two')
  for (const id of ['one', 'two']) {
    const rows = usage.list(id)!
    expect(rows.map((r) => r.phase).sort()).toEqual(TRIDENT_PHASES.map((p) => p.key).sort())
    for (const row of rows) {
      expect(row).toEqual({ run_id: id, phase: row.phase, status: 'unknown', input_tokens: null,
        output_tokens: null, cache_read_tokens: null, cache_creation_tokens: null, cost_usd: null,
        source: null, observed_at: null })
    }
  }
  expect(usage.list('missing')).toBeNull()
})

test('migration backfills old runs without inventing historical usage', () => {
  const legacy = new Database(':memory:')
  try {
    legacy.exec('CREATE TABLE code_trident_runs (id TEXT PRIMARY KEY); INSERT INTO code_trident_runs VALUES (\'old\')')
    legacy.exec(readFileSync(new URL('../migrations/0144_trident_phase_usage.sql', import.meta.url), 'utf8'))
    const rows = legacy.query<{ phase: string; status: string; cost_usd: number | null }, []>(
      'SELECT phase, status, cost_usd FROM code_trident_phase_usage WHERE run_id = \'old\'',
    ).all()
    expect(rows.map((r) => r.phase).sort()).toEqual(TRIDENT_PHASES.map((p) => p.key).sort())
    expect(rows.every((r) => r.status === 'unknown' && r.cost_usd === null)).toBe(true)
  } finally { legacy.close() }
})

test('partial reports retain missing metrics and complete reports survive run saves and reopening', async () => {
  expect(await usage.record('one', 'build', { ...complete, status: 'partial', cost_usd: null })).toBe('recorded')
  expect(build().cost_usd).toBeNull()
  expect(build().input_tokens).toBe(100)
  expect(build().status).toBe('partial')
  expect(await usage.record('one', 'build', { ...complete, observed_at: 2000 })).toBe('recorded')
  await runs.save({ ...runs.get('one')!, phase: 'done' })
  db.close()
  db = ProjectDb.open(join(dir, 'project.db'))
  usage = new TridentPhaseUsageStore(db)
  expect(build()).toEqual({ ...complete, run_id: 'one', phase: 'build', observed_at: 2000 })
  expect(usage.list('one')!.find((r) => r.phase === 'review_codex')!.status).toBe('unknown')
})

test('explicit zero is complete; duplicate and older snapshots cannot double count or overwrite', async () => {
  expect(await usage.record('one', 'build', complete)).toBe('recorded')
  expect(await usage.record('one', 'build', { ...complete, cost_usd: 99 })).toBe('stale')
  expect(await usage.record('one', 'build', { ...complete, observed_at: 999, cost_usd: 88 })).toBe('stale')
  expect(build().cost_usd).toBe(complete.cost_usd)
  expect(await usage.record('one', 'build', { ...complete, observed_at: 2000, input_tokens: 0,
    output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, cost_usd: 0 })).toBe('recorded')
  expect(build().cost_usd).toBe(0)
  expect(build().status).toBe('complete')
})

test('unknown target is explicit and cannot update another phase or run', async () => {
  expect(await usage.record('missing', 'build', complete)).toBe('unknown-target')
  expect(await usage.record('one', 'not-a-phase', complete)).toBe('unknown-target')
  expect(build().status).toBe('unknown')
})

const fields = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens'] as const
for (const field of fields) {
  test(`SQLite rejects invalid ${field} independently of the typed writer`, async () => {
    await usage.record('one', 'build', complete)
    for (const value of [-1, 0.5, 9007199254740992]) {
      expect(() => db.runSync(`UPDATE code_trident_phase_usage SET ${field} = ? WHERE run_id = 'one' AND phase = 'build'`, [value])).toThrow()
    }
    expect(build()[field]).toBe(complete[field])
  })
}

test('SQLite rejects negative and infinite cost and invalid observation time', async () => {
  await usage.record('one', 'build', complete)
  for (const cost of [-0.1, Infinity]) {
    expect(() => db.runSync("UPDATE code_trident_phase_usage SET cost_usd = ? WHERE run_id = 'one' AND phase = 'build'", [cost])).toThrow()
  }
  for (const stamp of [-1, 0.5, 9007199254740992]) {
    expect(() => db.runSync("UPDATE code_trident_phase_usage SET observed_at = ? WHERE run_id = 'one' AND phase = 'build'", [stamp])).toThrow()
  }
})

test('nonfinite numbers cannot turn into unreported NULL during SQLite binding', async () => {
  for (const field of [...fields, 'cost_usd', 'observed_at'] as const) {
    for (const value of [NaN, Infinity, -Infinity]) {
      await expect(usage.record('one', 'build', { ...complete, status: 'partial', [field]: value })).rejects.toThrow(TypeError)
    }
  }
  expect(build().status).toBe('unknown')
})

test('SQLite enforces coverage and provenance with writable partial and complete alternatives', async () => {
  for (const patch of [
    { status: 'bogus' }, { status: 'unknown' }, { status: 'partial' },
    { input_tokens: null }, { source: null }, { source: '  ' }, { observed_at: null },
    { status: 'partial', input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_creation_tokens: null, cost_usd: null },
  ]) {
    const report = { ...complete, ...patch }
    expect(() => db.runSync(`UPDATE code_trident_phase_usage SET status = ?, input_tokens = ?, output_tokens = ?,
      cache_read_tokens = ?, cache_creation_tokens = ?, cost_usd = ?, source = ?, observed_at = ?
      WHERE run_id = 'one' AND phase = 'build'`, [report.status, report.input_tokens, report.output_tokens,
      report.cache_read_tokens, report.cache_creation_tokens, report.cost_usd, report.source, report.observed_at])).toThrow()
  }
  expect(build().status).toBe('unknown')
  expect(await usage.record('one', 'build', { ...complete, status: 'partial', input_tokens: null })).toBe('recorded')
  expect(await usage.record('one', 'build', { ...complete, observed_at: 2000 })).toBe('recorded')
})

test('SQLite rejects orphan, unknown-phase and duplicate rows; deleting a run removes its accounting', () => {
  for (const [run, phase] of [['missing', 'build'], ['one', 'bogus'], ['one', 'build']]) {
    expect(() => db.runSync('INSERT INTO code_trident_phase_usage (run_id, phase) VALUES (?, ?)', [run!, phase!])).toThrow()
  }
  db.runSync("DELETE FROM code_trident_runs WHERE id = 'one'")
  expect(db.all('SELECT * FROM code_trident_phase_usage')).toEqual([])
  expect(usage.list('one')).toBeNull()
})
