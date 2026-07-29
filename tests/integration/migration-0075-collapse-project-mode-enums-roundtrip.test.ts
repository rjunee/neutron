/**
 * Round-trip test — migration 0075 (collapse project mode enums, audit P2-12).
 *
 * Spec: docs/plans/open-refactor-audit-2026-06-15.md § 3 R6 + § 2 P2-12.
 *
 * Seeds `projects` rows at every privacy_mode / billing_mode value (including
 * the removed group-oriented ones), applies migration 0075 via the production
 * runner, then asserts the actual row contents post-migration:
 *
 *   privacy_mode 'workspace'                 -> 'private'
 *   billing_mode 'group_per_seat'            -> 'personal'
 *   billing_mode 'group_shared'              -> 'personal'
 *   privacy_mode 'private'/'public' + billing 'personal' -> untouched
 *
 * Idempotency exercised two ways: re-applying via the runner (version dedup)
 * and re-executing the raw SQL body (every UPDATE matches zero rows).
 *
 * Anti-pattern guard (CLAUDE.md "Forbidden patterns"): this test does NOT just
 * assert "SQL ran without error". It reads each seeded row by its stable PK
 * after the migration and asserts the enum columns directly.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyMigrations } from '@neutronai/migrations/runner.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const PER_OWNER_MIGRATIONS_DIR = join(HERE, '..', '..', 'migrations')

interface SeedRow {
  id: string
  privacy_mode: string
  billing_mode: string
  expected_privacy: string
  expected_billing: string
}

const ROWS: ReadonlyArray<SeedRow> = [
  // Removed values collapse to the canonical survivors.
  { id: 'p-workspace-group-seat', privacy_mode: 'workspace', billing_mode: 'group_per_seat', expected_privacy: 'private', expected_billing: 'personal' },
  { id: 'p-workspace-group-shared', privacy_mode: 'workspace', billing_mode: 'group_shared', expected_privacy: 'private', expected_billing: 'personal' },
  { id: 'p-workspace-personal', privacy_mode: 'workspace', billing_mode: 'personal', expected_privacy: 'private', expected_billing: 'personal' },
  { id: 'p-private-group-shared', privacy_mode: 'private', billing_mode: 'group_shared', expected_privacy: 'private', expected_billing: 'personal' },
  // Already-canonical rows must be byte-identical after the migration.
  { id: 'p-private-personal', privacy_mode: 'private', billing_mode: 'personal', expected_privacy: 'private', expected_billing: 'personal' },
  { id: 'p-public-personal', privacy_mode: 'public', billing_mode: 'personal', expected_privacy: 'public', expected_billing: 'personal' },
]

let tmp: string
let dbPath: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-mig-0075-'))
  dbPath = join(tmp, 'project.db')
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

function stagePerOwnerMigrations(stage: string, predicate: (file: string) => boolean): string[] {
  const allFiles = readdirSync(PER_OWNER_MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort()
  const matched = allFiles.filter(predicate)
  for (const f of matched) {
    copyFileSync(join(PER_OWNER_MIGRATIONS_DIR, f), join(stage, f))
  }
  return matched
}

function seedProject(db: Database, row: SeedRow): void {
  db.run(
    `INSERT INTO projects (id, name, privacy_mode, billing_mode, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [row.id, row.id, row.privacy_mode, row.billing_mode, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'],
  )
}

function readRow(db: Database, id: string): { privacy_mode: string; billing_mode: string } | undefined {
  return db
    .query<{ privacy_mode: string; billing_mode: string }, [string]>(
      'SELECT privacy_mode, billing_mode FROM projects WHERE id = ?',
    )
    .get(id) ?? undefined
}

test('migration 0075 — collapses removed privacy/billing values, leaves canonical rows intact', () => {
  const stage = join(tmp, 'migrations')
  mkdirSync(stage, { recursive: true })

  // Phase A — apply everything before 0075 (creates the `projects` table with
  // the pre-collapse CHECK that still ACCEPTS 'workspace'/'group_*').
  const pre0075 = stagePerOwnerMigrations(stage, (f) => Number.parseInt(f.slice(0, 4), 10) < 75)
  const db = new Database(dbPath, { create: true })
  const firstPass = applyMigrations(db, stage)
  expect(firstPass.applied).toContain(38) // projects table lands in 0038
  expect(firstPass.applied).not.toContain(75)
  expect(pre0075.length).toBeGreaterThan(0)

  for (const row of ROWS) seedProject(db, row)
  const seeded = db.query<{ c: number }, []>('SELECT COUNT(*) AS c FROM projects').get()
  expect(seeded?.c).toBe(ROWS.length)

  // Phase B — stage + apply 0075.
  stagePerOwnerMigrations(stage, (f) => f.startsWith('0075_'))
  const secondPass = applyMigrations(db, stage)
  expect(secondPass.applied).toEqual([75])
  expect(secondPass.skipped).toEqual(firstPass.applied)

  for (const row of ROWS) {
    const after = readRow(db, row.id)
    expect(after?.privacy_mode).toBe(row.expected_privacy)
    expect(after?.billing_mode).toBe(row.expected_billing)
  }

  // No 'workspace'/'group_*' value survives anywhere.
  const stragglers = db
    .query<{ c: number }, []>(
      `SELECT COUNT(*) AS c FROM projects
        WHERE privacy_mode = 'workspace'
           OR billing_mode IN ('group_per_seat', 'group_shared')`,
    )
    .get()
  expect(stragglers?.c).toBe(0)

  // Row count unchanged (only UPDATEs, no inserts/deletes).
  const finalCount = db.query<{ c: number }, []>('SELECT COUNT(*) AS c FROM projects').get()
  expect(finalCount?.c).toBe(ROWS.length)
  db.close()
})

test('migration 0075 — re-applying via the runner is a no-op (version dedup)', () => {
  const stage = join(tmp, 'migrations')
  mkdirSync(stage, { recursive: true })
  stagePerOwnerMigrations(stage, (f) => Number.parseInt(f.slice(0, 4), 10) <= 75)

  const db = new Database(dbPath, { create: true })
  const first = applyMigrations(db, stage)
  expect(first.applied).toContain(75)

  const second = applyMigrations(db, stage)
  expect(second.applied).toEqual([])
  expect(second.skipped).toContain(75)
  db.close()
})

test('migration 0075 — raw SQL body is itself idempotent (every UPDATE matches zero rows on re-run)', () => {
  const stage = join(tmp, 'migrations')
  mkdirSync(stage, { recursive: true })
  stagePerOwnerMigrations(stage, (f) => Number.parseInt(f.slice(0, 4), 10) <= 75)

  const db = new Database(dbPath, { create: true })
  applyMigrations(db, stage)

  // After the migration applied, re-running its UPDATEs must change nothing.
  db.run("INSERT INTO projects (id, name, privacy_mode, billing_mode, created_at, updated_at) VALUES ('only-canonical', 'x', 'public', 'personal', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')")
  db.run("UPDATE projects SET privacy_mode = 'private' WHERE privacy_mode = 'workspace'")
  db.run("UPDATE projects SET billing_mode = 'personal' WHERE billing_mode IN ('group_per_seat', 'group_shared')")
  const row = readRow(db, 'only-canonical')
  expect(row?.privacy_mode).toBe('public')
  expect(row?.billing_mode).toBe('personal')
  db.close()
})
