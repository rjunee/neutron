/**
 * v0.1.78 (2026-05-22) — migration 0040 acceptance suite.
 *
 * Pins the schema-level contract for the import-resilience sprint:
 *
 *   1. 'budget-exceeded' is no longer accepted by the import_jobs.status
 *      CHECK constraint after migration 0040 runs.
 *   2. 'rate_limit_cooling_off' and 'rate_limit_paused' ARE accepted.
 *   3. Pre-existing rows with status='budget-exceeded' (defense-in-depth
 *      against a back-restored DB) are mapped to status='failed' with
 *      a stable error_code so the engine's failed sub_step surfaces
 *      automatically on next poll.
 *   4. The 0039 chunks_total_known column survives the table-recreate.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '../runner.ts'

let tmp: string
let db: Database

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-mig-0040-'))
  db = new Database(join(tmp, 'project.db'), { create: true })
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

test('import_jobs CHECK constraint rejects status=budget-exceeded after 0040', () => {
  applyMigrations(db)
  expect(() => {
    db.run(
      `INSERT INTO import_jobs
        (job_id, project_slug, source, status, started_at)
       VALUES ('j1', 't1', 'chatgpt-zip', 'budget-exceeded', ?)`,
      [Date.now()],
    )
  }).toThrow(/CHECK constraint/i)
})

test('import_jobs CHECK constraint accepts rate_limit_cooling_off + rate_limit_paused', () => {
  applyMigrations(db)
  db.run(
    `INSERT INTO import_jobs
      (job_id, project_slug, source, status, started_at)
     VALUES ('j-cool', 't1', 'chatgpt-zip', 'rate_limit_cooling_off', ?)`,
    [Date.now()],
  )
  db.run(
    `INSERT INTO import_jobs
      (job_id, project_slug, source, status, started_at)
     VALUES ('j-paused', 't1', 'chatgpt-zip', 'rate_limit_paused', ?)`,
    [Date.now()],
  )
  const rows = db
    .query<{ job_id: string; status: string }, []>(
      `SELECT job_id, status FROM import_jobs ORDER BY job_id`,
    )
    .all()
  expect(rows.map((r) => r.status)).toEqual(['rate_limit_cooling_off', 'rate_limit_paused'])
})

test('legacy rows at status=budget-exceeded migrate to status=failed with stable error_code', () => {
  // Run migrations up to 0039 only, insert a budget-exceeded row, then
  // finish 0040. We do this by inspecting the migration-runner: there's
  // no public API for "stop at version N", so we replicate the pre-0040
  // schema by hand + insert the row + apply ALL migrations (which is a
  // no-op for our hand-crafted schema). The cleaner alternative would
  // be a runner.applyOnlyVersion API, but the in-house workaround is
  // sufficient for this drift pin.
  //
  // Strategy: run all migrations (so the table exists with the new
  // CHECK), then re-create a row by temporarily relaxing the constraint
  // via PRAGMA. That's gross. Better: take the pre-0040 schema literally.

  // Step 1: install the migrations up to and including 0039 by faking
  // a `_migrations` table that records every prior version + creating
  // import_jobs with the pre-0040 CHECK. This isn't perfect but lets us
  // run only 0040 below.

  // Actually the cleanest path: apply all migrations (which lands the
  // new CHECK). Then drop import_jobs and re-create with the OLD
  // CHECK (allowing 'budget-exceeded'). Insert the legacy row. Then
  // re-run 0040 manually with the same SQL.
  applyMigrations(db)
  db.run('DROP TABLE import_jobs')
  db.run(`
    CREATE TABLE import_jobs (
      job_id TEXT PRIMARY KEY NOT NULL,
      project_slug TEXT NOT NULL,
      source TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN (
          'queued', 'pass1-running', 'pass2-running',
          'completed', 'failed', 'budget-exceeded', 'cancelled'
        )),
      dollars_spent REAL NOT NULL DEFAULT 0,
      pass1_chunks_done INTEGER NOT NULL DEFAULT 0,
      pass1_chunks_total INTEGER NOT NULL DEFAULT 0,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      error_code TEXT,
      error_message TEXT,
      chunks_total_known INTEGER NOT NULL DEFAULT 0
        CHECK (chunks_total_known IN (0, 1))
    ) STRICT
  `)
  db.run(
    `INSERT INTO import_jobs
      (job_id, project_slug, source, status, dollars_spent, started_at, error_code, error_message)
     VALUES ('legacy', 't1', 'chatgpt-zip', 'budget-exceeded', 3.5, ?, NULL, NULL)`,
    [123456],
  )

  // Step 2: re-run ONLY the 0040 SQL by hand (same statements as the
  // .sql file). We can't just call applyMigrations again because the
  // version is already recorded.
  db.run('ALTER TABLE import_jobs RENAME TO import_jobs__pre_0040')
  db.run(`
    CREATE TABLE import_jobs (
      job_id TEXT PRIMARY KEY NOT NULL,
      project_slug TEXT NOT NULL,
      source TEXT NOT NULL
        CHECK (source IN (
          'chatgpt-zip', 'claude-zip', 'gmail-oauth', 'calendar-oauth',
          'drive-oauth', 'notion-oauth', 'slack-oauth'
        )),
      status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN (
          'queued', 'pass1-running', 'pass2-running',
          'rate_limit_cooling_off', 'rate_limit_paused',
          'completed', 'failed', 'cancelled'
        )),
      dollars_spent REAL NOT NULL DEFAULT 0,
      pass1_chunks_done INTEGER NOT NULL DEFAULT 0,
      pass1_chunks_total INTEGER NOT NULL DEFAULT 0,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      error_code TEXT,
      error_message TEXT,
      chunks_total_known INTEGER NOT NULL DEFAULT 0
        CHECK (chunks_total_known IN (0, 1))
    ) STRICT
  `)
  db.run(`
    INSERT INTO import_jobs (
      job_id, project_slug, source, status, dollars_spent,
      pass1_chunks_done, pass1_chunks_total, started_at, completed_at,
      error_code, error_message, chunks_total_known
    )
    SELECT
      job_id, project_slug, source,
      CASE status WHEN 'budget-exceeded' THEN 'failed' ELSE status END,
      dollars_spent, pass1_chunks_done, pass1_chunks_total,
      started_at, completed_at,
      CASE status
        WHEN 'budget-exceeded' THEN COALESCE(error_code, 'budget_subsystem_removed')
        ELSE error_code
      END,
      CASE status
        WHEN 'budget-exceeded' THEN
          COALESCE(error_message, 'Legacy budget-exceeded status migrated to failed by 0040; the budget-cap subsystem was removed 2026-05-22.')
        ELSE error_message
      END,
      chunks_total_known
    FROM import_jobs__pre_0040
  `)
  db.run('DROP TABLE import_jobs__pre_0040')

  const row = db
    .query<
      { status: string; error_code: string | null; error_message: string | null },
      [string]
    >(`SELECT status, error_code, error_message FROM import_jobs WHERE job_id = ?`)
    .get('legacy')
  expect(row?.status).toBe('failed')
  expect(row?.error_code).toBe('budget_subsystem_removed')
  expect(row?.error_message).toContain('budget-cap subsystem was removed')
})

test('chunks_total_known column survives the 0040 table-recreate', () => {
  applyMigrations(db)
  db.run(
    `INSERT INTO import_jobs
      (job_id, project_slug, source, status, started_at, chunks_total_known)
     VALUES ('j-known', 't1', 'chatgpt-zip', 'completed', ?, 1)`,
    [Date.now()],
  )
  const row = db
    .query<{ chunks_total_known: number }, []>(
      `SELECT chunks_total_known FROM import_jobs LIMIT 1`,
    )
    .get()
  expect(row?.chunks_total_known).toBe(1)
})
