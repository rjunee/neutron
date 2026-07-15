/**
 * @neutronai/onboarding/history-import — boot-sweep tests (P6, durability P0).
 *
 * Proves the boot sweep that resumes an orphaned import after a process restart:
 *   - a non-terminal `import_jobs` row left by a dead process is flipped to
 *     `failed` with an honest, user-facing message + a stable error_code (so the
 *     engine's failed-branch surfaces retry/skip) — the behavior that FAILS
 *     pre-fix, where the orphan stayed `pass1-running` forever;
 *   - terminal rows (`completed` / `failed` / `cancelled`) are left untouched;
 *   - the flip is idempotent + never double-fires (a second sweep changes
 *     nothing; a row already made terminal by the engine's hard timeout between
 *     scan and write is not clobbered);
 *   - the swept set matches the schema's non-terminal statuses.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import {
  NON_TERMINAL_IMPORT_JOB_STATUSES,
  sweepOrphanedImportJobsOnBoot,
} from '../import-job-boot-sweep.ts'

let tmp: string
let db: ProjectDb

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-import-boot-sweep-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

interface SeedJob {
  job_id: string
  status: string
  started_at?: number
}

function insertJob(job: SeedJob): void {
  db.raw().run(
    `INSERT INTO import_jobs
       (job_id, project_slug, source, status, dollars_spent, pass1_chunks_done,
        pass1_chunks_total, chunks_total_known, started_at, completed_at,
        error_code, error_message)
     VALUES (?, 'owner', 'claude-zip', ?, 0, 0, 0, 0, ?, NULL, NULL, NULL)`,
    [job.job_id, job.status, job.started_at ?? 1_000],
  )
}

function readJob(job_id: string): {
  status: string
  error_code: string | null
  error_message: string | null
  completed_at: number | null
} {
  const row = db
    .raw()
    .query<
      { status: string; error_code: string | null; error_message: string | null; completed_at: number | null },
      [string]
    >(`SELECT status, error_code, error_message, completed_at FROM import_jobs WHERE job_id = ?`)
    .get(job_id)
  if (row === null) throw new Error(`no import_jobs row for ${job_id}`)
  return row
}

test('an orphaned pass1-running row (left by a dead process) is swept to failed with an honest message', () => {
  // The exact restart-loss scenario: the previous process started an import,
  // wrote `pass1-running`, then died — the in-process synthesis run is gone.
  insertJob({ job_id: 'orphan-1', status: 'pass1-running', started_at: 5_000 })

  const result = sweepOrphanedImportJobsOnBoot({ db, now: () => 9_000 })

  expect(result.scanned).toBe(1)
  expect(result.failed).toBe(1)

  const row = readJob('orphan-1')
  // Durable row content — not just a call count.
  expect(row.status).toBe('failed')
  expect(row.error_code).toBe('substrate_error')
  expect(row.error_message).toContain('interrupted')
  expect(row.error_message).toContain('retry the import or skip it')
  expect(row.completed_at).toBe(9_000)
})

test('every non-terminal status is swept; terminal statuses are left untouched', () => {
  for (const status of NON_TERMINAL_IMPORT_JOB_STATUSES) {
    insertJob({ job_id: `nt-${status}`, status })
  }
  insertJob({ job_id: 't-completed', status: 'completed' })
  insertJob({ job_id: 't-failed', status: 'failed' })
  insertJob({ job_id: 't-cancelled', status: 'cancelled' })

  const result = sweepOrphanedImportJobsOnBoot({ db, now: () => 42 })

  expect(result.scanned).toBe(NON_TERMINAL_IMPORT_JOB_STATUSES.length)
  expect(result.failed).toBe(NON_TERMINAL_IMPORT_JOB_STATUSES.length)

  for (const status of NON_TERMINAL_IMPORT_JOB_STATUSES) {
    expect(readJob(`nt-${status}`).status).toBe('failed')
  }
  // Terminal rows keep their status — a completed import (whose result the
  // atomic write persisted) is NOT clobbered.
  expect(readJob('t-completed').status).toBe('completed')
  expect(readJob('t-completed').error_code).toBeNull()
  expect(readJob('t-failed').status).toBe('failed')
  expect(readJob('t-cancelled').status).toBe('cancelled')
})

test('idempotent: a second sweep changes nothing (no double-fire)', () => {
  insertJob({ job_id: 'orphan-2', status: 'pass2-running' })

  const first = sweepOrphanedImportJobsOnBoot({ db, now: () => 100 })
  expect(first.failed).toBe(1)
  const afterFirst = readJob('orphan-2')
  expect(afterFirst.status).toBe('failed')
  expect(afterFirst.completed_at).toBe(100)

  // Second boot: the row is already terminal, so it is neither scanned as an
  // orphan nor re-stamped (completed_at stays at the first sweep's clock).
  const second = sweepOrphanedImportJobsOnBoot({ db, now: () => 999 })
  expect(second.scanned).toBe(0)
  expect(second.failed).toBe(0)
  expect(readJob('orphan-2').completed_at).toBe(100)
})

test('empty DB: sweep is a no-op', () => {
  const result = sweepOrphanedImportJobsOnBoot({ db })
  expect(result).toEqual({ scanned: 0, failed: 0 })
})
