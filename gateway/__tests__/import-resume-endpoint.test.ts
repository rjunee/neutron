/**
 * 2026-05-25 — POST /api/import/<job_id>/resume integration test.
 *
 * Sprint Part G.4 — covers the resume HTTP endpoint's contract:
 *
 *   1. Happy path: cancelled job + ZIP on disk → 200, new job dispatched,
 *      onboarding_state flips back to import_running with new job_id.
 *   2. 404 when no such job exists for this instance.
 *   3. 409 with `error: 'not_resumable'` when status is already
 *      `completed`.
 *   4. 409 with `error: 'source_zip_missing'` when the ZIP was deleted.
 *   5. 401 when the auth gate denies the request.
 *   6. 405 on a non-POST method.
 *   7. Non-matching paths return null so the chain falls through.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import {
  buildImportResumeHandler,
  RESUMABLE_STATUSES,
} from '../upload/import-resume-handler.ts'
import { SqliteOnboardingStateStore } from '@neutronai/onboarding/interview/sqlite-state-store.ts'
import type {
  ImportJobRunnerHook,
  ImportPayloadResolver,
} from '@neutronai/onboarding/interview/engine.ts'

const OWNER = 'alice'
const USER = 'u-alice'
const OWNER_HOME = '/fake/owner_home'

let tmp: string
let db: ProjectDb
let stateStore: SqliteOnboardingStateStore
let runnerStartCalls: number
let payloadResolveCalls: number
let zipExists: boolean
let nextJobId: string

function seedImportJob(opts: {
  job_id: string
  status: string
  source: string
}): void {
  db.raw().run(
    `INSERT INTO import_jobs (job_id, project_slug, source, status,
        dollars_spent, pass1_chunks_done, pass1_chunks_total,
        chunks_total_known, started_at)
     VALUES (?, ?, ?, ?, 0, 0, 0, 0, ?)`,
    [opts.job_id, OWNER, opts.source, opts.status, 1_700_000_000_000],
  )
}

function makeRunner(): ImportJobRunnerHook {
  return {
    start: async () => {
      runnerStartCalls += 1
      return { job_id: nextJobId }
    },
    status: async () => null,
    cancel: async () => undefined,
    synthesizeOnDemand: async () => null,
  }
}

function makePayloadResolver(opts: { returnNull?: boolean } = {}): ImportPayloadResolver {
  return {
    resolve: async () => {
      payloadResolveCalls += 1
      if (opts.returnNull) return null
      return Buffer.from('fake-zip-bytes')
    },
  }
}

function makeHandler(opts: { auth?: (req: Request) => boolean } = {}) {
  const input: Parameters<typeof buildImportResumeHandler>[0] = {
    db,
    project_slug: OWNER,
    owner_home: OWNER_HOME,
    runner: makeRunner(),
    payloadResolver: makePayloadResolver(),
    stateStore,
    fs: { existsSync: () => zipExists },
    now: () => 1_700_000_500_000,
  }
  if (opts.auth !== undefined) input.auth = opts.auth
  return buildImportResumeHandler(input)
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-resume-endpoint-'))
  db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
  stateStore = new SqliteOnboardingStateStore({ db })
  runnerStartCalls = 0
  payloadResolveCalls = 0
  zipExists = true
  nextJobId = 'job-new'
  // Seed an onboarding row so the handler's user_id pulls from it.
  await stateStore.upsert({
    user_id: USER,
    owner_slug: OWNER,
    phase: 'import_analysis_presented',
    phase_state_patch: {
      topic_id: 'web:u',
      user_id: USER,
      import_job_id: 'job-old',
      import_source: 'chatgpt-zip',
      import_failed: true,
    },
    advanced_at: 1_700_000_400_000,
  })
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

describe('POST /api/import/<job_id>/resume', () => {
  test('happy path — cancelled job + ZIP exists → 200, runner dispatched, state flips', async () => {
    seedImportJob({ job_id: 'job-old', status: 'cancelled', source: 'chatgpt-zip' })
    const handler = makeHandler()

    const res = await handler(
      new Request('http://t.example/api/import/job-old/resume', { method: 'POST' }),
    )
    expect(res).not.toBeNull()
    expect(res!.status).toBe(200)
    const body = (await res!.json()) as Record<string, any>
    expect(body.ok).toBe(true)
    expect(body.prior_job_id).toBe('job-old')
    expect(body.job_id).toBe('job-new')
    expect(body.source).toBe('chatgpt-zip')

    expect(runnerStartCalls).toBe(1)
    expect(payloadResolveCalls).toBe(1)

    const after = await stateStore.get(OWNER, USER)
    expect(after).not.toBeNull()
    expect(after!.phase).toBe('import_running')
    expect(after!.phase_state['import_job_id']).toBe('job-new')
    expect(after!.phase_state['import_failed']).toBe(false)
  })

  test('failed status is also resumable (covers the 27-min backoff exhausted case)', async () => {
    seedImportJob({ job_id: 'job-old', status: 'failed', source: 'chatgpt-zip' })
    const handler = makeHandler()
    const res = await handler(
      new Request('http://t.example/api/import/job-old/resume', { method: 'POST' }),
    )
    expect(res!.status).toBe(200)
    expect(runnerStartCalls).toBe(1)
  })

  test('rate_limit_paused is resumable', async () => {
    seedImportJob({ job_id: 'job-old', status: 'rate_limit_paused', source: 'chatgpt-zip' })
    const handler = makeHandler()
    const res = await handler(
      new Request('http://t.example/api/import/job-old/resume', { method: 'POST' }),
    )
    expect(res!.status).toBe(200)
  })

  test('404 when job id is unknown to this project', async () => {
    const handler = makeHandler()
    const res = await handler(
      new Request('http://t.example/api/import/nonexistent/resume', { method: 'POST' }),
    )
    expect(res!.status).toBe(404)
    const body = (await res!.json()) as Record<string, any>
    expect(body.error).toBe('job_not_found')
    expect(runnerStartCalls).toBe(0)
  })

  test('409 not_resumable when status === completed', async () => {
    seedImportJob({ job_id: 'job-old', status: 'completed', source: 'chatgpt-zip' })
    const handler = makeHandler()
    const res = await handler(
      new Request('http://t.example/api/import/job-old/resume', { method: 'POST' }),
    )
    expect(res!.status).toBe(409)
    const body = (await res!.json()) as Record<string, any>
    expect(body.error).toBe('not_resumable')
    expect(body.status).toBe('completed')
    expect(runnerStartCalls).toBe(0)
  })

  test('409 source_zip_missing when ZIP was deleted', async () => {
    seedImportJob({ job_id: 'job-old', status: 'cancelled', source: 'chatgpt-zip' })
    zipExists = false
    const handler = makeHandler()
    const res = await handler(
      new Request('http://t.example/api/import/job-old/resume', { method: 'POST' }),
    )
    expect(res!.status).toBe(409)
    const body = (await res!.json()) as Record<string, any>
    expect(body.error).toBe('source_zip_missing')
    expect(body.source).toBe('chatgpt-zip')
    expect(runnerStartCalls).toBe(0)
  })

  test('409 unsupported_source for a legacy non-zip row — refused, never dispatched (K11c Codex r1)', async () => {
    // A legacy `gmail-oauth` row can still exist because migration 0040's
    // `import_jobs.source` CHECK constraint (immutable history) permits it,
    // even though `ImportSource` is now narrowed to the two zip sources.
    // The K11c OAuth-source purge removed the code that once bypassed the
    // ZIP check for such rows; the handler must now refuse it cleanly.
    seedImportJob({ job_id: 'job-old', status: 'cancelled', source: 'gmail-oauth' })
    const handler = makeHandler()
    const res = await handler(
      new Request('http://t.example/api/import/job-old/resume', { method: 'POST' }),
    )
    expect(res!.status).toBe(409)
    const body = (await res!.json()) as Record<string, any>
    expect(body.error).toBe('unsupported_source')
    expect(body.source).toBe('gmail-oauth')
    // Never resolved or dispatched.
    expect(payloadResolveCalls).toBe(0)
    expect(runnerStartCalls).toBe(0)
  })

  test('401 when auth gate denies the request', async () => {
    seedImportJob({ job_id: 'job-old', status: 'cancelled', source: 'chatgpt-zip' })
    const handler = makeHandler({ auth: () => false })
    const res = await handler(
      new Request('http://t.example/api/import/job-old/resume', { method: 'POST' }),
    )
    expect(res!.status).toBe(401)
    expect(runnerStartCalls).toBe(0)
  })

  test('405 on non-POST methods', async () => {
    seedImportJob({ job_id: 'job-old', status: 'cancelled', source: 'chatgpt-zip' })
    const handler = makeHandler()
    const res = await handler(
      new Request('http://t.example/api/import/job-old/resume', { method: 'GET' }),
    )
    expect(res!.status).toBe(405)
  })

  test('returns null for non-matching paths (chain falls through)', async () => {
    const handler = makeHandler()
    const res = await handler(
      new Request('http://t.example/api/upload/chatgpt', { method: 'POST' }),
    )
    expect(res).toBeNull()
  })

  test('drift-safe: resume succeeds and updates user row when phase_state.import_job_id has drifted off the cancelled job', async () => {
    // 2026-05-27 — regression for Sam's prod 2026-05-27 case.
    // Pre-fix the handler matched user_id via a LEFT JOIN keyed on
    // `phase_state.import_job_id = j.job_id`. When the onboarding row's
    // `import_job_id` had drifted away from the cancelled job's id
    // (e.g. a prior advance nulled it), the JOIN missed, user_id slid
    // through as empty string, and `stateStore.upsert` INSERTED a
    // phantom `(project_slug, '')` row rather than UPDATING the user's
    // primary row.
    //
    // Post-fix the user_id is resolved by `project_slug` ONLY. The
    // pre-existing user row is updated; no phantom row appears.
    await stateStore.upsert({
      user_id: USER,
      owner_slug: OWNER,
      phase: 'import_analysis_presented',
      phase_state_patch: {
        topic_id: 'web:u',
        user_id: USER,
        // drift: pointer is on a DIFFERENT job, not 'job-old'
        import_job_id: 'job-drifted',
        import_source: 'chatgpt-zip',
        import_failed: true,
      },
      advanced_at: 1_700_000_400_000,
    })
    seedImportJob({ job_id: 'job-old', status: 'cancelled', source: 'chatgpt-zip' })

    const handler = makeHandler()
    const res = await handler(
      new Request('http://t.example/api/import/job-old/resume', { method: 'POST' }),
    )
    expect(res!.status).toBe(200)
    const body = (await res!.json()) as Record<string, any>
    expect(body.ok).toBe(true)
    expect(body.job_id).toBe('job-new')

    // The user's primary row was UPDATED in place.
    const userRow = await stateStore.get(OWNER, USER)
    expect(userRow).not.toBeNull()
    expect(userRow!.phase).toBe('import_running')
    expect(userRow!.phase_state['import_job_id']).toBe('job-new')
    expect(userRow!.phase_state['import_failed']).toBe(false)
    expect(userRow!.phase_state['import_partial']).toBe(false)
    expect(userRow!.phase_state['import_failure_reason']).toBeNull()
    // Codex 2026-05-27 P2 — `import_source` must be restitched to the
    // resumed job's source so subsequent ticks of
    // `pollImportRunningAndAdvance` read the correct source for the
    // progress envelope + the auto-resume helper's payload-resolver
    // call. Pre-fix the upsert preserved whatever source was on the
    // drifted row.
    expect(userRow!.phase_state['import_source']).toBe('chatgpt-zip')

    // NO phantom (project_slug, '') row was created.
    const rows = db
      .raw()
      .query<{ user_id: string; phase: string }, [string]>(
        `SELECT user_id, phase FROM onboarding_state WHERE project_slug = ?`,
      )
      .all(OWNER)
    expect(rows.length).toBe(1)
    expect(rows[0]!.user_id).toBe(USER)
  })

  test('drift-safe: import_source on the user row is overwritten when it differs from the resumed job source', async () => {
    // Codex 2026-05-27 P2 regression — a drifted row could carry a
    // stale `import_source` (e.g. from a prior chatgpt-zip cycle) while
    // the user is now resuming a claude-zip job. The resume must
    // restamp `import_source` to match the resumed job's source so
    // `pollImportRunningAndAdvance` reads the correct source on its
    // next tick.
    await stateStore.delete(OWNER, USER)
    await stateStore.upsert({
      user_id: USER,
      owner_slug: OWNER,
      phase: 'import_analysis_presented',
      phase_state_patch: {
        topic_id: 'web:u',
        user_id: USER,
        import_job_id: 'job-drifted',
        // Stale source from a prior cycle — points at the wrong source
        // for the job we're about to resume.
        import_source: 'chatgpt-zip',
        import_failed: true,
      },
      advanced_at: 1_700_000_400_000,
    })
    seedImportJob({ job_id: 'job-old', status: 'cancelled', source: 'claude-zip' })

    const handler = makeHandler()
    const res = await handler(
      new Request('http://t.example/api/import/job-old/resume', { method: 'POST' }),
    )
    expect(res!.status).toBe(200)

    const userRow = await stateStore.get(OWNER, USER)
    expect(userRow).not.toBeNull()
    expect(userRow!.phase).toBe('import_running')
    expect(userRow!.phase_state['import_job_id']).toBe('job-new')
    expect(userRow!.phase_state['import_source']).toBe('claude-zip')
  })

  test('409 no_onboarding_state when no user row exists for the project (refuses to insert a phantom row)', async () => {
    // Wipe the seeded onboarding_state row so the instance has zero
    // matching rows. Pre-fix the handler would have inserted a
    // `(project_slug, '')` row via stateStore.upsert; post-fix it
    // refuses and returns 409.
    await stateStore.delete(OWNER, USER)
    seedImportJob({ job_id: 'job-old', status: 'cancelled', source: 'chatgpt-zip' })

    const handler = makeHandler()
    const res = await handler(
      new Request('http://t.example/api/import/job-old/resume', { method: 'POST' }),
    )
    expect(res!.status).toBe(409)
    const body = (await res!.json()) as Record<string, any>
    expect(body.error).toBe('no_onboarding_state')
    expect(body.project_slug).toBe(OWNER)

    // No phantom row was created.
    const rows = db
      .raw()
      .query<{ user_id: string }, [string]>(
        `SELECT user_id FROM onboarding_state WHERE project_slug = ?`,
      )
      .all(OWNER)
    expect(rows.length).toBe(0)

    // runner.start was NOT invoked because we refused before dispatch.
    expect(runnerStartCalls).toBe(0)
  })

  test('409 no_onboarding_state when the only matching row is itself a phantom (empty user_id)', async () => {
    // Edge case: a pre-fix phantom row is sitting in the table with
    // user_id = ''. The user_id != '' guard skips it, and since no real
    // row exists for this instance we refuse.
    await stateStore.delete(OWNER, USER)
    db.raw().run(
      `INSERT INTO onboarding_state (project_slug, user_id, phase,
          phase_state_json, started_at, last_advanced_at, completed_at,
          import_job_id, persona_files_committed, wow_fired, attempt_id,
          wow_pushed_at)
       VALUES (?, '', 'import_running', '{}', 1, 1, NULL, NULL, 0, 0, 'a', NULL)`,
      [OWNER],
    )
    seedImportJob({ job_id: 'job-old', status: 'cancelled', source: 'chatgpt-zip' })

    const handler = makeHandler()
    const res = await handler(
      new Request('http://t.example/api/import/job-old/resume', { method: 'POST' }),
    )
    expect(res!.status).toBe(409)
    const body = (await res!.json()) as Record<string, any>
    expect(body.error).toBe('no_onboarding_state')
  })

  test('409 payload_unavailable when resolver returns null', async () => {
    seedImportJob({ job_id: 'job-old', status: 'cancelled', source: 'chatgpt-zip' })
    const handler = buildImportResumeHandler({
      db,
      project_slug: OWNER,
      owner_home: OWNER_HOME,
      runner: makeRunner(),
      payloadResolver: makePayloadResolver({ returnNull: true }),
      stateStore,
      fs: { existsSync: () => true },
      now: () => 1_700_000_500_000,
    })
    const res = await handler(
      new Request('http://t.example/api/import/job-old/resume', { method: 'POST' }),
    )
    expect(res!.status).toBe(409)
    const body = (await res!.json()) as Record<string, any>
    expect(body.error).toBe('payload_unavailable')
    expect(runnerStartCalls).toBe(0)
  })
})

describe('RESUMABLE_STATUSES constant', () => {
  test('contains cancelled, rate_limit_paused, failed (not completed)', () => {
    expect(RESUMABLE_STATUSES).toContain('cancelled')
    expect(RESUMABLE_STATUSES).toContain('rate_limit_paused')
    expect(RESUMABLE_STATUSES).toContain('failed')
    expect(RESUMABLE_STATUSES).not.toContain('completed')
    expect(RESUMABLE_STATUSES).not.toContain('pass1-running')
  })
})
