/**
 * Sprint 30 (Codex r1 P1) — `OnboardingState.attempt_id` minted on row
 * creation, preserved across updates, surfaced through both store
 * implementations. The P1 finding was that the migration shipped the
 * column but nothing ever wrote a non-legacy value, so the per-attempt
 * `onboarding_metrics` view collapsed every restart/resume into one row.
 *
 * 2026-05-19 — ISSUES #2: every store call keys on (project_slug, user_id).
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { InMemoryOnboardingStateStore } from '../state-store.ts'
import { SqliteOnboardingStateStore } from '../sqlite-state-store.ts'
import { LEGACY_ATTEMPT_ID } from '../../telemetry/event-emitter.ts'

const USER = 'test-user'

let tmp: string
let db: ProjectDb

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-attempt-id-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

test('InMemory: upsert mints a fresh attempt_id on first write', async () => {
  let counter = 0
  const store = new InMemoryOnboardingStateStore({
    newAttemptId: () => `attempt-${++counter}`,
  })
  const state = await store.upsert({ project_slug: 't1', user_id: USER, phase: 'signup' })
  expect(state.attempt_id).toBe('attempt-1')
})

test('InMemory: upsert preserves attempt_id across phase advances', async () => {
  let counter = 0
  const store = new InMemoryOnboardingStateStore({
    newAttemptId: () => `attempt-${++counter}`,
  })
  await store.upsert({ project_slug: 't1', user_id: USER, phase: 'signup' })
  const advanced = await store.upsert({ project_slug: 't1', user_id: USER, phase: 'agent_name_chosen' })
  expect(advanced.attempt_id).toBe('attempt-1')
  expect(counter).toBe(1)
})

test('InMemory: distinct owners get distinct attempt_ids', async () => {
  const store = new InMemoryOnboardingStateStore()
  const a = await store.upsert({ project_slug: 't1', user_id: USER, phase: 'signup' })
  const b = await store.upsert({ project_slug: 't2', user_id: USER, phase: 'signup' })
  expect(a.attempt_id).not.toBe(b.attempt_id)
  expect(a.attempt_id.length).toBeGreaterThan(0)
  expect(b.attempt_id.length).toBeGreaterThan(0)
})

test('Sqlite: upsert mints a fresh attempt_id on insert', async () => {
  const store = new SqliteOnboardingStateStore({
    db,
    newAttemptId: () => 'fixed-attempt',
  })
  const state = await store.upsert({ project_slug: 't1', user_id: USER, phase: 'signup' })
  expect(state.attempt_id).toBe('fixed-attempt')
  // Round-trip via get — the column persists.
  const reloaded = await store.get('t1', USER)
  expect(reloaded?.attempt_id).toBe('fixed-attempt')
})

test('Sqlite: upsert preserves attempt_id across phase updates', async () => {
  let counter = 0
  const store = new SqliteOnboardingStateStore({
    db,
    newAttemptId: () => `attempt-${++counter}`,
  })
  await store.upsert({ project_slug: 't1', user_id: USER, phase: 'signup' })
  await store.upsert({ project_slug: 't1', user_id: USER, phase: 'agent_name_chosen' })
  const final = await store.get('t1', USER)
  expect(final?.attempt_id).toBe('attempt-1')
  expect(counter).toBe(1)
})

test('Sqlite: second upsert RETURN VALUE carries attempt_id (Argus IMPORTANT #2 regression)', async () => {
  // Argus 2026-05-08 IMPORTANT #2: the existing-row SELECT inside upsert()
  // omitted attempt_id, so the UPDATE branch returned attempt_id=undefined
  // even though the row in the DB had the right value. Engine consumers
  // that read state.attempt_id off the upsert() return value (instead of
  // re-fetching via get()) would see undefined on every phase advance after
  // the initial insert. Lock this in.
  const store = new SqliteOnboardingStateStore({
    db,
    newAttemptId: () => 'mint-once',
  })
  const first = await store.upsert({ project_slug: 't1', user_id: USER, phase: 'signup' })
  expect(first.attempt_id).toBe('mint-once')
  const second = await store.upsert({ project_slug: 't1', user_id: USER, phase: 'agent_name_chosen' })
  expect(second.attempt_id).toBe('mint-once')
  const third = await store.upsert({ project_slug: 't1', user_id: USER, phase: 'persona_reviewed' })
  expect(third.attempt_id).toBe('mint-once')
})

test('Sqlite: legacy backfill — rows pre-Sprint-30 default to legacy-pre-S30', () => {
  // Insert a row WITHOUT attempt_id to simulate the migration's
  // backfill default. The column's NOT NULL DEFAULT supplies the value.
  // ISSUES #2: composite PK requires user_id; supply a sentinel for the
  // legacy-row simulation.
  db.raw().run(
    `INSERT INTO onboarding_state
       (project_slug, user_id, phase, phase_state_json, started_at,
        last_advanced_at, completed_at, import_job_id,
        persona_files_committed, wow_fired)
       VALUES ('legacy-project', 'legacy:pre-project-isolation', 'signup', '{}',
               1, 1, NULL, NULL, 0, 0)`,
  )
  const row = db
    .raw()
    .query<{ attempt_id: string }, []>(
      `SELECT attempt_id FROM onboarding_state WHERE project_slug = 'legacy-project'`,
    )
    .get()
  expect(row?.attempt_id).toBe(LEGACY_ATTEMPT_ID)
})

test('Sqlite: rekey carries attempt_id to the renamed slug', async () => {
  const store = new SqliteOnboardingStateStore({
    db,
    newAttemptId: () => 'pre-rename',
  })
  await store.upsert({ project_slug: 'old-slug', user_id: USER, phase: 'signup' })
  const rekeyed = await store.rekey('old-slug', 'new-slug', USER)
  expect(rekeyed?.attempt_id).toBe('pre-rename')
  const reloaded = await store.get('new-slug', USER)
  expect(reloaded?.attempt_id).toBe('pre-rename')
})
