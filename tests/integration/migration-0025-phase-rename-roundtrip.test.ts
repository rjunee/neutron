/**
 * Round-trip test — migration 0025 (P2 v2 phase rename)
 *
 * Spec: docs/plans/P2-onboarding-v2.md § 2.8 (v1 → v2 mapping table) +
 * § 9.6 (migration definition) + § 11 S1 exit criterion ("migration
 * applies cleanly on a snapshot of staging DB — covers in-flight rows
 * from v1 phases").
 *
 * The test seeds onboarding_state rows at every v1 phase value, applies
 * the migration via the production runner, then asserts the actual row
 * contents post-migration. Renamed phases must reflect the v2 strings;
 * untouched phases (signup, identity_oauth, instance_provisioned, import_running,
 * projects_proposed, persona_synthesizing, persona_reviewed, slug_chosen,
 * max_oauth_offered, wow_fired, completed, failed) must be byte-identical.
 *
 * Idempotency is exercised in two passes:
 *   1. Re-applying via `applyMigrations` (the runner records the version
 *      in _migrations and skips). Verifies the runner contract.
 *   2. Re-executing the raw SQL body. Verifies the UPDATE statements
 *      themselves are idempotent (every UPDATE matches zero rows once
 *      the rename has been applied).
 *
 * Anti-pattern guard (CLAUDE.md "Forbidden patterns"): this test does NOT
 * just assert "SQL ran without error". It reads each seeded row by its
 * stable project_slug PK after the migration and asserts the phase column
 * contents directly.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyMigrations } from '@neutronai/migrations/runner.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const PER_OWNER_MIGRATIONS_DIR = join(HERE, '..', '..', 'migrations')

interface SeedRow {
  project_slug: string
  phase: string
}

const PHASE_RENAMES_V1_TO_V2: ReadonlyArray<SeedRow & { expected_phase: string }> = [
  // Direct one-to-one renames from § 2.8 mapping table.
  { project_slug: 't-rename-import-offered', phase: 'import_offered', expected_phase: 'ai_substrate_offered' },
  { project_slug: 't-rename-archetype-picked', phase: 'archetype_picked', expected_phase: 'personality_offered' },
  { project_slug: 't-rename-name-chosen', phase: 'name_chosen', expected_phase: 'agent_name_chosen' },
  // Phases absorbed into the v2 gap-fill phase.
  { project_slug: 't-rename-profile-pic-gen', phase: 'profile_pic_generating', expected_phase: 'work_interview_gap_fill' },
  { project_slug: 't-rename-time-style', phase: 'time_style_picked', expected_phase: 'work_interview_gap_fill' },
  { project_slug: 't-rename-work-pattern', phase: 'work_pattern_captured', expected_phase: 'work_interview_gap_fill' },
  { project_slug: 't-rename-rituals', phase: 'rituals_captured', expected_phase: 'work_interview_gap_fill' },
]

// Phases that MUST NOT be touched by the migration — both v1 names that
// remain v2 names AND terminal phases. Asserting these stay byte-identical
// catches a stray UPDATE that wipes more than intended.
const PHASES_UNTOUCHED: ReadonlyArray<SeedRow> = [
  { project_slug: 't-stay-signup', phase: 'signup' },
  { project_slug: 't-stay-identity-oauth', phase: 'identity_oauth' },
  { project_slug: 't-stay-instance-provisioned', phase: 'instance_provisioned' },
  { project_slug: 't-stay-import-running', phase: 'import_running' },
  { project_slug: 't-stay-projects-proposed', phase: 'projects_proposed' },
  { project_slug: 't-stay-persona-synthesizing', phase: 'persona_synthesizing' },
  { project_slug: 't-stay-persona-reviewed', phase: 'persona_reviewed' },
  { project_slug: 't-stay-slug-chosen', phase: 'slug_chosen' },
  { project_slug: 't-stay-max-oauth', phase: 'max_oauth_offered' },
  { project_slug: 't-stay-wow-fired', phase: 'wow_fired' },
  { project_slug: 't-stay-completed', phase: 'completed' },
  { project_slug: 't-stay-failed', phase: 'failed' },
]

let tmp: string
let dbPath: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-mig-0025-'))
  dbPath = join(tmp, 'project.db')
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

/**
 * Stage a subset of the per-instance migrations into a tmp dir so we can
 * apply 0001..0024 first (creates `onboarding_state`), seed v1 rows, then
 * apply 0025 in a second pass. Mirrors the pattern in the provisioning
 * suite's migration-0004-fk-data-loss.test.ts.
 */
function stagePerOwnerMigrations(stage: string, predicate: (file: string) => boolean): string[] {
  const allFiles = readdirSync(PER_OWNER_MIGRATIONS_DIR).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort()
  const matched = allFiles.filter(predicate)
  for (const f of matched) {
    copyFileSync(join(PER_OWNER_MIGRATIONS_DIR, f), join(stage, f))
  }
  return matched
}

function seedOnboardingState(db: Database, row: SeedRow, started_at: number): void {
  db.run(
    `INSERT INTO onboarding_state (project_slug, phase, phase_state_json, started_at, last_advanced_at)
     VALUES (?, ?, ?, ?, ?)`,
    [row.project_slug, row.phase, '{}', started_at, started_at],
  )
}

function readPhase(db: Database, project_slug: string): string | undefined {
  return db
    .query<{ phase: string }, [string]>('SELECT phase FROM onboarding_state WHERE project_slug = ?')
    .get(project_slug)?.phase
}

test('migration 0025 — v1 → v2 phase rename hits every mapped phase and leaves untouched phases intact', () => {
  const stage = join(tmp, 'migrations')
  mkdirSync(stage, { recursive: true })

  // Phase A — apply 0001..0024 (creates onboarding_state).
  const pre0025 = stagePerOwnerMigrations(stage, (f) => {
    const v = Number.parseInt(f.slice(0, 4), 10)
    return v >= 1 && v <= 24
  })
  expect(pre0025.length).toBe(24)

  const db = new Database(dbPath, { create: true })
  const firstPass = applyMigrations(db, stage)
  expect(firstPass.applied).toContain(11) // onboarding_state lands in 0011
  expect(firstPass.applied).toContain(24)
  expect(firstPass.applied).not.toContain(25)

  // Seed every v1 phase + every "must-stay" phase as a separate instance row.
  const started_at = Math.floor(Date.now() / 1000)
  for (const row of PHASE_RENAMES_V1_TO_V2) seedOnboardingState(db, row, started_at)
  for (const row of PHASES_UNTOUCHED) seedOnboardingState(db, row, started_at)

  const seededCount = db
    .query<{ c: number }, []>('SELECT COUNT(*) AS c FROM onboarding_state')
    .get()
  expect(seededCount?.c).toBe(PHASE_RENAMES_V1_TO_V2.length + PHASES_UNTOUCHED.length)

  // Phase B — stage + apply 0025.
  stagePerOwnerMigrations(stage, (f) => f.startsWith('0025_'))
  const secondPass = applyMigrations(db, stage)
  expect(secondPass.applied).toEqual([25])
  expect(secondPass.skipped).toEqual(firstPass.applied)

  // Verify every renamed row landed at the v2 phase.
  for (const row of PHASE_RENAMES_V1_TO_V2) {
    expect(readPhase(db, row.project_slug)).toBe(row.expected_phase)
  }
  // Verify every untouched row kept its phase byte-identical.
  for (const row of PHASES_UNTOUCHED) {
    expect(readPhase(db, row.project_slug)).toBe(row.phase)
  }

  // Total row count unchanged (no rows added or dropped, only some UPDATEd).
  const finalCount = db
    .query<{ c: number }, []>('SELECT COUNT(*) AS c FROM onboarding_state')
    .get()
  expect(finalCount?.c).toBe(PHASE_RENAMES_V1_TO_V2.length + PHASES_UNTOUCHED.length)

  db.close()
})

test('migration 0025 — re-applying via the runner is a no-op (version dedup)', () => {
  const stage = join(tmp, 'migrations')
  mkdirSync(stage, { recursive: true })
  stagePerOwnerMigrations(stage, (f) => {
    const v = Number.parseInt(f.slice(0, 4), 10)
    return v >= 1 && v <= 25
  })

  const db = new Database(dbPath, { create: true })
  const first = applyMigrations(db, stage)
  expect(first.applied).toContain(25)

  // Seed two rows: one that WOULD have been renamed had it existed pre-migration,
  // and one already at the v2 phase. Both must be untouched by a re-apply.
  const started_at = Math.floor(Date.now() / 1000)
  seedOnboardingState(db, { project_slug: 't-late-archetype', phase: 'archetype_picked' }, started_at)
  seedOnboardingState(db, { project_slug: 't-already-v2', phase: 'personality_offered' }, started_at)

  // Re-apply via the runner — 0025 should be skipped because the version
  // is already recorded in _migrations.
  const second = applyMigrations(db, stage)
  expect(second.applied).toEqual([])
  expect(second.skipped).toContain(25)

  // The runner-dedup means the late-seeded 'archetype_picked' row is left
  // alone — the migration's SQL never re-runs. This proves the runner is
  // doing its job; downstream code is responsible for not inserting v1
  // phase names post-v2 deploy.
  expect(readPhase(db, 't-late-archetype')).toBe('archetype_picked')
  expect(readPhase(db, 't-already-v2')).toBe('personality_offered')

  db.close()
})

test('migration 0025 — raw SQL body is itself idempotent (every UPDATE matches zero rows on re-run)', () => {
  const stage = join(tmp, 'migrations')
  mkdirSync(stage, { recursive: true })
  stagePerOwnerMigrations(stage, (f) => {
    const v = Number.parseInt(f.slice(0, 4), 10)
    return v >= 1 && v <= 25
  })

  const db = new Database(dbPath, { create: true })
  applyMigrations(db, stage)

  // Seed the file body fully via the migration SQL directly. After the
  // first execution every row is at a v2 phase; a second execution should
  // leave the table unchanged (every WHERE clause matches zero rows).
  const started_at = Math.floor(Date.now() / 1000)
  for (const row of PHASE_RENAMES_V1_TO_V2) seedOnboardingState(db, row, started_at)

  const migrationSql = readFileSync(
    join(PER_OWNER_MIGRATIONS_DIR, '0025_p2_v2_phase_rename.sql'),
    'utf8',
  )
  db.exec(migrationSql)
  for (const row of PHASE_RENAMES_V1_TO_V2) {
    expect(readPhase(db, row.project_slug)).toBe(row.expected_phase)
  }

  // Snapshot every row's phase, re-run the SQL, snapshot again — must match.
  const before = db
    .query<{ project_slug: string; phase: string }, []>(
      'SELECT project_slug, phase FROM onboarding_state ORDER BY project_slug',
    )
    .all()
  db.exec(migrationSql)
  const after = db
    .query<{ project_slug: string; phase: string }, []>(
      'SELECT project_slug, phase FROM onboarding_state ORDER BY project_slug',
    )
    .all()
  expect(after).toEqual(before)

  db.close()
})
