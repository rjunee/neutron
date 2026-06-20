/**
 * Tests for the cores_oauth_pending sweep cron handler (Argus PR #210
 * minor #1). The handler builds its own CoresOAuthPendingStore against
 * the injected `db` + clock, scans + deletes expired rows in one
 * transaction, and reports `'ok'` / `'skipped'` / `'error'`.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { ProjectDb } from '../../../persistence/index.ts'
import { applyMigrations } from '../../../migrations/runner.ts'
import {
  CoresOAuthPendingStore,
  PENDING_TTL_MS,
} from '../oauth-pending-store.ts'
import {
  buildCoresOAuthPendingSweepHandler,
  buildCoresOAuthPendingSweepJob,
  registerCoresOAuthPendingSweepCron,
  DEFAULT_CORES_OAUTH_SWEEP_INTERVAL_MS,
  CORES_OAUTH_PENDING_SWEEP_HANDLER_NAME,
} from '../oauth-pending-sweep-cron.ts'
import { CronJobRegistry } from '../../../cron/jobs.ts'
import { CronHandlerRegistry } from '../../../cron/handlers.ts'

let workdir: string
let db: ProjectDb

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'neutron-cores-oauth-sweep-cron-'))
  const dbPath = join(workdir, 'owner.db')
  const raw = new Database(dbPath, { create: true })
  applyMigrations(raw)
  raw.close()
  db = ProjectDb.open(dbPath)
})

afterEach(() => {
  db.close()
  rmSync(workdir, { recursive: true, force: true })
})

test('handler returns skipped when no expired rows exist', async () => {
  const handler = buildCoresOAuthPendingSweepHandler({
    db,
    now: () => 1_700_000_000_000,
  })
  const result = await handler({
    job_name: 'cores-oauth-pending-sweep-alice',
    project_slug: 'alice',
    fired_at: 1_700_000_000_000,
  })
  expect(result.status).toBe('skipped')
})

test('handler deletes expired rows and returns ok', async () => {
  let nowVal = 1_700_000_000_000
  const store = new CoresOAuthPendingStore({ db, now: () => nowVal })
  // Two rows — one fresh, one we'll let expire.
  await store.put({
    state: 'fresh-state',
    project_slug: 'alice',
    code_verifier: 'verifier-fresh',
    labels: ['google_calendar'],
    redirect_uri: 'https://auth.test/oauth/cores/google/callback',
  })
  await store.put({
    state: 'expired-state',
    project_slug: 'alice',
    code_verifier: 'verifier-expired',
    labels: ['gmail_compose'],
    redirect_uri: 'https://auth.test/oauth/cores/google/callback',
  })
  // Advance clock past the TTL for both rows; then add a fresh row.
  nowVal += PENDING_TTL_MS + 1
  await store.put({
    state: 'still-fresh-state',
    project_slug: 'alice',
    code_verifier: 'verifier-still-fresh',
    labels: ['google_calendar'],
    redirect_uri: 'https://auth.test/oauth/cores/google/callback',
  })

  const handler = buildCoresOAuthPendingSweepHandler({ db, now: () => nowVal })
  const result = await handler({
    job_name: 'cores-oauth-pending-sweep-alice',
    project_slug: 'alice',
    fired_at: nowVal,
  })
  expect(result.status).toBe('ok')
  expect(result.detail).toContain('swept=2')

  // The fresh row that's still under TTL must remain consumable.
  const consumed = await store.consume('still-fresh-state')
  expect(consumed).not.toBeNull()

  // Both expired rows are gone — consume returns null.
  expect(await store.consume('fresh-state')).toBeNull()
  expect(await store.consume('expired-state')).toBeNull()
})

test('buildCoresOAuthPendingSweepJob produces the expected shape', () => {
  const job = buildCoresOAuthPendingSweepJob({ project_slug: 'alice' })
  expect(job.name).toBe('cores-oauth-pending-sweep-alice')
  expect(job.handler).toBe(CORES_OAUTH_PENDING_SWEEP_HANDLER_NAME)
  expect(job.schedule.kind).toBe('interval_ms')
  if (job.schedule.kind === 'interval_ms') {
    expect(job.schedule.interval_ms).toBe(DEFAULT_CORES_OAUTH_SWEEP_INTERVAL_MS)
  }
  expect(job.skip_if_running).toBe(true)
})

test('registerCoresOAuthPendingSweepCron registers both job + handler', () => {
  const jobs = new CronJobRegistry()
  const handlers = new CronHandlerRegistry()
  const handler = buildCoresOAuthPendingSweepHandler({ db })
  const { job_name } = registerCoresOAuthPendingSweepCron({
    project_slug: 'alice',
    jobs,
    handlers,
    handler,
  })
  expect(job_name).toBe('cores-oauth-pending-sweep-alice')
  expect(jobs.get(job_name)).toBeDefined()
  expect(handlers.get(CORES_OAUTH_PENDING_SWEEP_HANDLER_NAME)).toBeDefined()
})

test('registerCoresOAuthPendingSweepCron is idempotent on the handler name', () => {
  const jobs = new CronJobRegistry()
  const handlers = new CronHandlerRegistry()
  const handler = buildCoresOAuthPendingSweepHandler({ db })
  registerCoresOAuthPendingSweepCron({
    project_slug: 'alice',
    jobs,
    handlers,
    handler,
  })
  // A second instance registering the same handler shape must not throw —
  // the handler-registry register() throws on duplicate names, but the
  // wrapper skips re-registration when the name is already bound.
  registerCoresOAuthPendingSweepCron({
    project_slug: 'bob',
    jobs,
    handlers,
    handler,
  })
  expect(jobs.get('cores-oauth-pending-sweep-alice')).toBeDefined()
  expect(jobs.get('cores-oauth-pending-sweep-bob')).toBeDefined()
})
