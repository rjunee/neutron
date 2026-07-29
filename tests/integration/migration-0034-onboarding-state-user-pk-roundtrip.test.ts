/**
 * Round-trip test — migration 0034 (ISSUES #2 — onboarding_state PK widens
 * to (project_slug, user_id)).
 *
 * Spec: the onboarding-state project-isolation brief in docs/plans §§ 3-4
 * (state shape + migration body) + § 5.3 (backfill verification).
 *
 * The test seeds onboarding_state rows under the PRE-0034 schema with
 * two scenarios:
 *   1. `phase_state_json` carries a real `user_id` — the backfill must
 *      recover it via JSON_EXTRACT.
 *   2. `phase_state_json` carries no `user_id` — the backfill must fall
 *      back to the sentinel `'legacy:pre-project-isolation'`.
 *
 * Then applies migration 0034 and asserts:
 *   - both rows preserved
 *   - the JSON-recovered user_id matches the source string
 *   - the empty-JSON row carries the sentinel
 *   - the composite PK rejects a duplicate (project, user)
 *   - the composite PK ACCEPTS a different user on the same project
 *
 * Anti-pattern guard (CLAUDE.md "Forbidden patterns"): this test does NOT
 * just assert "SQL ran without error". It reads each row's user_id back
 * by project_slug and asserts the contents directly.
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

let tmp: string
let dbPath: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-mig-0034-'))
  dbPath = join(tmp, 'project.db')
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

/**
 * Stage a subset of the per-instance migrations into a tmp dir so we can
 * apply 0001..0033 first (creates `onboarding_state` with the single-column
 * PK + every additive column up to attempt_id), seed rows, then apply 0034
 * in a second pass.
 */
function stagePerOwnerMigrations(stage: string, predicate: (file: string) => boolean): string[] {
  const allFiles = readdirSync(PER_OWNER_MIGRATIONS_DIR).filter((f) =>
    /^\d{4}_.+\.sql$/.test(f),
  ).sort()
  const matched = allFiles.filter(predicate)
  for (const f of matched) {
    copyFileSync(join(PER_OWNER_MIGRATIONS_DIR, f), join(stage, f))
  }
  return matched
}

function seedOnboardingStatePreMigration(
  db: Database,
  row: { project_slug: string; phase_state_json: string },
): void {
  const ts = Math.floor(Date.now() / 1000)
  db.run(
    `INSERT INTO onboarding_state
       (project_slug, phase, phase_state_json, started_at, last_advanced_at,
        completed_at, import_job_id, persona_files_committed, wow_fired, attempt_id)
     VALUES (?, 'signup', ?, ?, ?, NULL, NULL, 0, 0, 'legacy-pre-S30')`,
    [row.project_slug, row.phase_state_json, ts, ts],
  )
}

interface RowAfterMigration {
  project_slug: string
  user_id: string
  phase: string
  phase_state_json: string
  attempt_id: string
}

function readAllRows(db: Database): RowAfterMigration[] {
  return db
    .query<RowAfterMigration, []>(
      `SELECT project_slug, user_id, phase, phase_state_json, attempt_id
         FROM onboarding_state ORDER BY project_slug, user_id`,
    )
    .all()
}

test('migration 0034 — backfills user_id from phase_state.user_id, falls back to sentinel', () => {
  const stage = join(tmp, 'migrations')
  mkdirSync(stage, { recursive: true })

  // Phase A — apply 0001..0033 (creates onboarding_state with single-PK).
  const pre0034 = stagePerOwnerMigrations(stage, (f) => {
    const v = Number.parseInt(f.slice(0, 4), 10)
    return v >= 1 && v <= 33
  })
  expect(pre0034.length).toBeGreaterThan(30) // sanity — enough migrations staged

  const db = new Database(dbPath, { create: true })
  const firstPass = applyMigrations(db, stage)
  expect(firstPass.applied).toContain(11) // onboarding_state lands in 0011
  expect(firstPass.applied).not.toContain(34)

  // Seed two rows:
  //   row #1 — phase_state.user_id recoverable (typical post-LLM-prompts row)
  //   row #2 — phase_state.user_id missing (legacy / hand-seeded test row)
  seedOnboardingStatePreMigration(db, {
    project_slug: 'with-user-id',
    phase_state_json: JSON.stringify({ user_id: 'google:abc-123', topic_id: 'web:google:abc-123' }),
  })
  seedOnboardingStatePreMigration(db, {
    project_slug: 'no-user-id',
    phase_state_json: '{}',
  })

  // Phase B — stage + apply 0034.
  stagePerOwnerMigrations(stage, (f) => f.startsWith('0034_'))
  const secondPass = applyMigrations(db, stage)
  expect(secondPass.applied).toEqual([34])

  const rows = readAllRows(db)
  expect(rows).toHaveLength(2)
  const withUser = rows.find((r) => r.project_slug === 'with-user-id')
  const noUser = rows.find((r) => r.project_slug === 'no-user-id')
  expect(withUser?.user_id).toBe('google:abc-123')
  expect(noUser?.user_id).toBe('legacy:pre-project-isolation')

  // Composite PK rejects a duplicate (project, user).
  expect(() =>
    db.run(
      `INSERT INTO onboarding_state
         (project_slug, user_id, phase, phase_state_json, started_at, last_advanced_at,
          completed_at, import_job_id, persona_files_committed, wow_fired, attempt_id)
       VALUES ('with-user-id', 'google:abc-123', 'signup', '{}', 1, 1, NULL, NULL, 0, 0, 'x')`,
    ),
  ).toThrow()

  // Composite PK ACCEPTS a different user on the same project.
  db.run(
    `INSERT INTO onboarding_state
       (project_slug, user_id, phase, phase_state_json, started_at, last_advanced_at,
        completed_at, import_job_id, persona_files_committed, wow_fired, attempt_id)
     VALUES ('with-user-id', 'google:second-user', 'signup', '{}', 1, 1, NULL, NULL, 0, 0, 'attempt-2')`,
  )
  const after = readAllRows(db)
  expect(after).toHaveLength(3)
  expect(after.filter((r) => r.project_slug === 'with-user-id')).toHaveLength(2)

  db.close()
})

test('migration 0034 — preserves phase, phase_state_json, started_at, attempt_id', () => {
  const stage = join(tmp, 'migrations')
  mkdirSync(stage, { recursive: true })
  stagePerOwnerMigrations(stage, (f) => {
    const v = Number.parseInt(f.slice(0, 4), 10)
    return v >= 1 && v <= 33
  })

  const db = new Database(dbPath, { create: true })
  applyMigrations(db, stage)

  const ts = Math.floor(Date.now() / 1000)
  db.run(
    `INSERT INTO onboarding_state
       (project_slug, phase, phase_state_json, started_at, last_advanced_at,
        completed_at, import_job_id, persona_files_committed, wow_fired, attempt_id)
     VALUES ('preserve-me', 'archetype_picked', ?, ?, ?, NULL, NULL, 1, 1, 'attempt-preserve')`,
    [JSON.stringify({ user_id: 'apple:xyz', meta: 'kept' }), ts, ts + 5],
  )

  stagePerOwnerMigrations(stage, (f) => f.startsWith('0034_'))
  applyMigrations(db, stage)

  const row = db
    .query<RowAfterMigration & { started_at: number; last_advanced_at: number; persona_files_committed: number; wow_fired: number }, []>(
      `SELECT project_slug, user_id, phase, phase_state_json, attempt_id,
              started_at, last_advanced_at, persona_files_committed, wow_fired
         FROM onboarding_state WHERE project_slug = 'preserve-me'`,
    )
    .get()
  expect(row?.user_id).toBe('apple:xyz')
  expect(row?.phase).toBe('archetype_picked')
  expect(row?.attempt_id).toBe('attempt-preserve')
  expect(row?.started_at).toBe(ts)
  expect(row?.last_advanced_at).toBe(ts + 5)
  expect(row?.persona_files_committed).toBe(1)
  expect(row?.wow_fired).toBe(1)
  const parsed = JSON.parse(row?.phase_state_json ?? '{}')
  expect(parsed.user_id).toBe('apple:xyz')
  expect(parsed.meta).toBe('kept')

  db.close()
})

test('migration 0034 — re-applying via the runner is a no-op (version dedup)', () => {
  const stage = join(tmp, 'migrations')
  mkdirSync(stage, { recursive: true })
  stagePerOwnerMigrations(stage, (f) => {
    const v = Number.parseInt(f.slice(0, 4), 10)
    return v >= 1 && v <= 34
  })
  const db = new Database(dbPath, { create: true })
  const first = applyMigrations(db, stage)
  expect(first.applied).toContain(34)
  const second = applyMigrations(db, stage)
  expect(second.applied).toEqual([])
  expect(second.skipped).toContain(34)
  db.close()
})
