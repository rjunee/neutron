/**
 * ISSUES #2 (2026-05-19) — `loadCurrentOnboardingPhase` scoping by
 * (project_slug, user_id).
 *
 * Spec: onboarding-state isolation brief § 2.7
 * (composer phase-gate must accept user_id).
 *
 * Pre-fix: the composer's phase lookup was keyed on project_slug alone,
 * so an instance with two onboarded users would always return whichever
 * row happened to be in the result set — typically the first user, since
 * the SQL had `LIMIT 1`. After the migration, the row PK is composite;
 * the helper now takes user_id and returns the correct phase.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { SqliteOnboardingStateStore } from '@neutronai/onboarding/interview/sqlite-state-store.ts'
import { loadCurrentOnboardingPhase } from '../resolve-onboarding-phase.ts'

let tmp: string
let db: ProjectDb

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-load-phase-multi-'))
  db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

test('loadCurrentOnboardingPhase returns the right user phase when multiple users exist', async () => {
  const store = new SqliteOnboardingStateStore({ db })
  await store.upsert({ owner_slug: 't', user_id: 'u-A', phase: 'signup' })
  await store.upsert({
    owner_slug: 't',
    user_id: 'u-B',
    phase: 'persona_reviewed',
  })

  expect(loadCurrentOnboardingPhase(db, 't', 'u-A')).toBe('signup')
  expect(loadCurrentOnboardingPhase(db, 't', 'u-B')).toBe('persona_reviewed')
})

test('loadCurrentOnboardingPhase returns null for a user that has no row on the project', async () => {
  const store = new SqliteOnboardingStateStore({ db })
  await store.upsert({ owner_slug: 't', user_id: 'u-A', phase: 'signup' })
  expect(loadCurrentOnboardingPhase(db, 't', 'u-A')).toBe('signup')
  expect(loadCurrentOnboardingPhase(db, 't', 'u-other')).toBeNull()
})

test('loadCurrentOnboardingPhase returns null for an instance that has no rows at all', async () => {
  expect(loadCurrentOnboardingPhase(db, 'no-project', 'u-A')).toBeNull()
})
