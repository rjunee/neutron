import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { seedMigratedDb } from '../../tests/support/migrated-db.ts'
import { TridentPhaseUsageStore } from '../phase-usage.ts'
import { TridentRunStore } from '../store.ts'

// WHY A REAL DATABASE. Every other phase-usage test injects a fake `record()`, so none
// of them can see the CHECK in `0144_trident_phase_usage.sql:23-34`. That constraint is
// the whole contract: all-null measurements are legal ONLY as `status:'unknown'`, while
// `'partial'` demands a source, an observed_at AND at least one non-null token/cost.
//
// A project build reports no usage at all (`metadata: () => undefined` in
// `open/wiring/project-build.ts`), so the first completed worker turn tried to write
// exactly the illegal row and killed the run at the plan phase. A fake store accepted
// it; SQLite did not.
const cleanup: Array<() => Promise<void> | void> = []

async function realStore() {
  const dir = await mkdtemp(join(tmpdir(), 'phase-usage-check-'))
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  seedMigratedDb(join(dir, 'project.db'))
  const db = ProjectDb.open(join(dir, 'project.db'))
  cleanup.push(() => db.close())
  const runs = new TridentRunStore(db)
  const row = await runs.create({ slug: 'usage', project_slug: 'project', repo_path: dir, task: 'Build' })
  return { usage: new TridentPhaseUsageStore(db), runId: row.id }
}

test('the real schema REFUSES a partial row with no measurements', async () => {
  const { usage, runId } = await realStore()
  // Exactly the shape the driver used to compose for a project build.
  await expect(usage.record(runId, 'decomposition', {
    status: 'partial', input_tokens: null, output_tokens: null, cache_read_tokens: null,
    cache_creation_tokens: null, cost_usd: null, source: 'unknown-model', observed_at: Date.now(),
  })).rejects.toThrow()
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

test('the trigger seeds every phase as unknown, so skipping the write keeps the truth', async () => {
  const { usage, runId } = await realStore()
  const seeded = usage.list(runId)
  expect(seeded).not.toBeNull()
  expect(seeded!.length).toBeGreaterThan(0)
  // This is why not writing is correct rather than lossy: the row already says
  // "no measurement", which is precisely what happened.
  for (const row of seeded!) expect(row.status).toBe('unknown')
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

test('a partial row with a real measurement is accepted — the positive control', async () => {
  const { usage, runId } = await realStore()
  expect(await usage.record(runId, 'decomposition', {
    status: 'partial', input_tokens: 12, output_tokens: null, cache_read_tokens: null,
    cache_creation_tokens: null, cost_usd: null, source: 'test-model', observed_at: Date.now(),
  })).toBe('recorded')
  for (const fn of cleanup.splice(0).reverse()) await fn()
})
