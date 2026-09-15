import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { seedMigratedDb } from '../tests/support/migrated-db.ts'
import { TridentPhaseUsageStore } from './phase-usage.ts'
import { TridentRunStore } from './store.ts'
import { TridentUsageAnalytics } from './usage-analytics.ts'

let dir: string
let db: ProjectDb
let runs: TridentRunStore
let phaseUsage: TridentPhaseUsageStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'usage-analytics-'))
  seedMigratedDb(join(dir, 'project.db'))
  db = ProjectDb.open(join(dir, 'project.db'))
  runs = new TridentRunStore(db)
  phaseUsage = new TridentPhaseUsageStore(db)
})
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

async function create(id: string, repo: string): Promise<void> {
  await runs.create({ id, slug: id, project_slug: 'owner', repo_path: repo, task: 'build' })
}

test('unknown rows stay unknown instead of becoming zero', async () => {
  await create('unknown', '/repos/alpha')
  const analytics = new TridentUsageAnalytics(db).read()
  expect(analytics.spend.total).toEqual({ unit: 'tokens', value: null, state: 'unknown' })
  expect(analytics.waste.total).toEqual({ unit: 'tokens', value: null, state: 'unknown' })
  expect(analytics.spend.by_model).toEqual({ state: 'unknown', rows: [] })
})

test('attributes measured tokens, waste and terminal duration without inventing missing coverage', async () => {
  await create('good', '/repos/alpha')
  await create('waste', '/repos/beta')
  await phaseUsage.record('good', 'build', {
    status: 'complete', input_tokens: 100, output_tokens: 20, cache_read_tokens: 30,
    cache_creation_tokens: 10, cost_usd: 1, source: 'fixture', observed_at: 10,
  })
  await phaseUsage.record('waste', 'review_codex', {
    status: 'complete', input_tokens: 40, output_tokens: 5, cache_read_tokens: 0,
    cache_creation_tokens: 0, cost_usd: 0, source: 'fixture', observed_at: 10,
  })
  db.runSync(`UPDATE code_trident_runs SET phase = 'done', inner_verdict = 'APPROVE',
    started_at = '2026-09-15T00:00:00.000Z', last_advanced_at = '2026-09-15T00:10:00.000Z' WHERE id = 'good'`)
  db.runSync(`UPDATE code_trident_runs SET phase = 'failed', inner_verdict = 'REQUEST_CHANGES',
    inner_result = ?, started_at = '2026-09-15T00:00:00.000Z', last_advanced_at = '2026-09-15T00:30:00.000Z' WHERE id = 'waste'`,
    [JSON.stringify({ terminalCauseKind: 'round-budget-exhausted' })])

  const analytics = new TridentUsageAnalytics(db).read()
  expect(analytics.spend.total).toEqual({ unit: 'tokens', value: 205, state: 'partial' })
  expect(analytics.spend.by_project.map((row) => [row.key, row.amount.value])).toEqual([['alpha', 160], ['beta', 45]])
  expect(analytics.spend.by_phase[0]).toMatchObject({ key: 'build', amount: { value: 160 } })
  expect(analytics.waste.total).toEqual({ unit: 'tokens', value: 45, state: 'partial' })
  expect(analytics.waste.by_reason[0]?.key).toBe('full review budget, not approved')
  expect(analytics.throughput.runs[0]).toEqual({ project: 'beta', seconds: 1800, outcome: 'failed' })
})
