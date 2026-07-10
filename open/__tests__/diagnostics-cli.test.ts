/**
 * O5 — `neutron doctor` diagnostics CLI tests.
 *
 *  - `collectCliDiagnostics` opens a REAL migrated `project.db` read-only and
 *    composes every DB-backed section (empty DB → sections available with empty
 *    payloads; credentials unavailable off-process),
 *  - a missing DB returns `{ ok: false }` (a fresh box is NOT a doctor failure),
 *  - `formatDiagnosticsText` renders a human summary of a synthetic report.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ProjectDb } from '@neutronai/persistence/index.ts'
import { applyMigrationsToProjectDb } from '@neutronai/migrations/runner.ts'
import { composeDiagnostics } from '@neutronai/gateway/diagnostics/diagnostics-report.ts'
import { collectCliDiagnostics, formatDiagnosticsText } from '../diagnostics-cli.ts'

let tmp: string

function envFor(dbPath: string): NodeJS.ProcessEnv {
  return {
    NEUTRON_DB_PATH: dbPath,
    NEUTRON_HOME: tmp,
    NEUTRON_INSTANCE_SLUG: 'demo',
  } as NodeJS.ProcessEnv
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'o5-cli-'))
})
afterEach(() => {
  if (typeof tmp === 'string' && tmp.length > 0) rmSync(tmp, { recursive: true, force: true })
})

describe('collectCliDiagnostics', () => {
  it('reads a real migrated project.db read-only and composes DB-backed sections', () => {
    const dbPath = join(tmp, 'project.db')
    const db = ProjectDb.open(dbPath)
    applyMigrationsToProjectDb(db)
    db.close()

    const result = collectCliDiagnostics(envFor(dbPath))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const r = result.report
    expect(r.project_slug).toBe('demo')
    // DB-backed sections are readable (tables exist, no rows yet).
    expect(r.cron_jobs.available).toBe(true)
    expect(r.cron_jobs.jobs).toEqual([])
    expect(r.import_jobs.available).toBe(true)
    expect(r.import_jobs.jobs).toEqual([])
    expect(r.recent_events.available).toBe(true)
    // gbrain row absent → available with a "no state yet" note.
    expect(r.gbrain.available).toBe(true)
    expect(r.gbrain.status).toBeUndefined()
    // repl registry file absent under owner_home → available, empty.
    expect(r.repl_sessions.available).toBe(true)
    expect(r.repl_sessions.sessions).toEqual([])
    // credentials are in-process-only → not available off-process.
    expect(r.credentials.available).toBe(false)
  })

  it('surfaces a gbrain latch + import job written to the DB', () => {
    const dbPath = join(tmp, 'project.db')
    const db = ProjectDb.open(dbPath)
    applyMigrationsToProjectDb(db)
    db.runSync(
      `INSERT INTO gbrain_sync_state (scope, status, latch_reason, latched_at, last_success_at, deferred_count, updated_at)
       VALUES (?, 'unavailable', 'GBrainUnavailableError', '2026-07-01T00:00:00Z', NULL, 3, '2026-07-01T00:00:01Z')`,
      ['demo'],
    )
    db.runSync(
      `INSERT INTO import_jobs (job_id, project_slug, source, status, started_at, error_code, error_message)
       VALUES ('j1', 'demo', 'chatgpt-zip', 'failed', 100, 'rate_limit', 'slow down')`,
      [],
    )
    db.close()

    const result = collectCliDiagnostics(envFor(dbPath))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.report.gbrain.status).toBe('unavailable')
    expect(result.report.gbrain.deferred_count).toBe(3)
    expect(result.report.import_jobs.jobs?.[0]).toMatchObject({ job_id: 'j1', status: 'failed', error_code: 'rate_limit' })
  })

  it('scopes cron jobs to THIS instance slug (no cross-project leak)', () => {
    const dbPath = join(tmp, 'project.db')
    const db = ProjectDb.open(dbPath)
    applyMigrationsToProjectDb(db)
    db.runSync(
      `INSERT INTO cron_state (job_name, project_slug, last_run_at, last_run_status, last_run_error, last_run_duration_ms)
       VALUES ('nudge', 'demo', 10, 'ok', NULL, 5)`,
      [],
    )
    db.runSync(
      `INSERT INTO cron_state (job_name, project_slug, last_run_at, last_run_status, last_run_error, last_run_duration_ms)
       VALUES ('secret-job', 'other-project', 20, 'error', 'private error text', 9)`,
      [],
    )
    db.close()

    const result = collectCliDiagnostics(envFor(dbPath))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const jobs = result.report.cron_jobs.jobs ?? []
    expect(jobs.map((j) => j.job_name)).toEqual(['nudge'])
    // the other project's error text must NOT be present
    expect(JSON.stringify(jobs)).not.toContain('private error text')
  })

  it('repl registry: absent file → available with zero sessions', () => {
    const dbPath = join(tmp, 'project.db')
    ProjectDb.open(dbPath).close()
    const db = ProjectDb.open(dbPath)
    applyMigrationsToProjectDb(db)
    db.close()
    const result = collectCliDiagnostics(envFor(dbPath))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.report.repl_sessions.available).toBe(true)
    expect(result.report.repl_sessions.sessions).toEqual([])
  })

  it('repl registry: corrupt file → available:false with a note (NOT falsely healthy)', () => {
    const dbPath = join(tmp, 'project.db')
    const db = ProjectDb.open(dbPath)
    applyMigrationsToProjectDb(db)
    db.close()
    // owner_home is `tmp` (see envFor) → registry at tmp/.neutron/repl-registry.json
    mkdirSync(join(tmp, '.neutron'), { recursive: true })
    writeFileSync(join(tmp, '.neutron', 'repl-registry.json'), '{ this is not valid json', 'utf8')

    const result = collectCliDiagnostics(envFor(dbPath))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.report.repl_sessions.available).toBe(false)
    expect(result.report.repl_sessions.note).toContain('repl-registry unreadable/corrupt')
    // must NOT report a healthy "no sessions" state
    expect(result.report.repl_sessions.sessions).toBeUndefined()
  })

  it('returns { ok: false } when project.db does not exist (fresh box)', () => {
    const result = collectCliDiagnostics(envFor(join(tmp, 'missing.db')))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('could not open project.db')
  })
})

describe('formatDiagnosticsText', () => {
  it('renders a readable multi-section summary', () => {
    const report = composeDiagnostics({
      project_slug: 'demo',
      now: () => 0,
      gbrain: () => ({
        status: 'unavailable',
        latchReason: 'GBrainUnavailableError',
        latchedAt: '2026-07-01T00:00:00Z',
        lastSuccessAt: null,
        deferredCount: 3,
        updatedAt: '2026-07-01T00:00:01Z',
      }),
      importJobs: () => [
        { job_id: 'j1', source: 'chatgpt', status: 'failed', started_at: 1, completed_at: 2, error_code: 'rate_limit', error_message: 'x' },
      ],
    })
    const text = formatDiagnosticsText(report)
    expect(text).toContain('instance=demo')
    expect(text).toContain('memory (gbrain): status=unavailable')
    expect(text).toContain('LATCHED reason=GBrainUnavailableError')
    expect(text).toContain('import jobs: 1')
    expect(text).toContain('j1')
    // in-process-only sections are labelled, not crashed
    expect(text).toContain('credentials:')
  })
})
