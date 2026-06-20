/**
 * v0.1.78 (2026-05-22) — rate-limit resilience regression suite.
 *
 * Rewritten from the S13 (2026-05-16) Pass-2-only retry suite. The
 * v0.1.78 sprint applies the same 429 backoff to BOTH Pass-1 (per
 * chunk) AND Pass-2 (single synthesis), and exhausting the backoff
 * window now persists `import_jobs.status='rate_limit_paused'` instead
 * of marking the whole job `failed`.
 *
 * What this suite proves:
 *
 *   1. The default backoff schedule matches the brief: 30 retry
 *      attempts at `min(60, 5 * 2^attempt)` seconds each. Sum is
 *      `RATE_LIMIT_BACKOFF_TOTAL_MS_DEFAULT` ≈ 1.6M ms (~27 min).
 *   2. A Pass-2 LLM that 429s on attempts 1+2 and succeeds on attempt 3
 *      produces a `completed` job (not `failed`, not `rate_limit_paused`).
 *   3. A Pass-2 LLM that 429s on every attempt eventually marks the job
 *      `rate_limit_paused` (NEW behavior — pre-v0.1.78 this was `failed`).
 *   4. A Pass-2 LLM that throws a NON-429 error fails on the FIRST
 *      attempt (no wasteful backoff on permanent errors).
 *   5. is429RetryableError detects HTTP 429 + rate_limit message shapes.
 *   6. Custom rateLimitBackoffMs override is honoured (test seam for
 *      shorter sequences).
 *   7. Cancel during Pass-2 backoff terminates the retry loop within
 *      one 500ms slice (sliced sleep contract).
 *   8. A Pass-1 chunk that 429s eventually flips the job to
 *      `rate_limit_paused` instead of silently dropping the chunk into
 *      the degraded branch.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '../../../migrations/runner.ts'
import { ProjectDb } from '../../../persistence/index.ts'
import {
  ImportJobRunner,
  RATE_LIMIT_BACKOFF_MS_DEFAULT,
  RATE_LIMIT_BACKOFF_TOTAL_MS_DEFAULT,
  is429RetryableError,
  type SourceParser,
} from '../job-runner.ts'
import type { Pass1LlmCall } from '../pass1-triage.ts'
import type { Pass2LlmCall } from '../pass2-synthesis.ts'
import { ImportError, type ConversationRecord } from '../types.ts'

let tmp: string
let db: ProjectDb

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-pass2retry-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

const fakeRecords: ConversationRecord[] = [
  {
    conversation_id: 'c1',
    messages: [
      { role: 'user', text: 'hello there' },
      { role: 'assistant', text: 'hi' },
    ],
  },
]

const parser: SourceParser = async function* () {
  for (const r of fakeRecords) yield r
}

const pass1Ok: Pass1LlmCall = async () => ({
  result: {
    candidate_entities: [{ name: 'Topline', kind: 'company', mention_count: 1 }],
    candidate_topics: [],
    candidate_tasks: [],
    voice_signals: {},
  },
  dollars_billed: 0.01,
})

test('RATE_LIMIT_BACKOFF_MS_DEFAULT — first attempt immediate, then min(60, 5*2^attempt)s, 30 retries (~27 min)', () => {
  // Brief: `min(60, 5 * 2^attempt)` seconds. 30 retries total (so
  // RATE_LIMIT_BACKOFF_MS_DEFAULT has 31 entries: 1 zero + 30 backoffs).
  expect(RATE_LIMIT_BACKOFF_MS_DEFAULT.length).toBeGreaterThanOrEqual(31)
  expect(RATE_LIMIT_BACKOFF_MS_DEFAULT[0]).toBe(0)
  expect(RATE_LIMIT_BACKOFF_MS_DEFAULT[1]).toBe(5_000) // 5s
  expect(RATE_LIMIT_BACKOFF_MS_DEFAULT[2]).toBe(10_000) // 10s
  expect(RATE_LIMIT_BACKOFF_MS_DEFAULT[3]).toBe(20_000) // 20s
  expect(RATE_LIMIT_BACKOFF_MS_DEFAULT[4]).toBe(40_000) // 40s
  expect(RATE_LIMIT_BACKOFF_MS_DEFAULT[5]).toBe(60_000) // cap
  expect(RATE_LIMIT_BACKOFF_MS_DEFAULT[10]).toBe(60_000) // still capped
  // Total wall-clock budget across the schedule ≥ 25 min (the brief
  // says "~30 min"; the exact sum is 5+10+20+40+60*26 = 1635s ≈ 27.25 min).
  expect(RATE_LIMIT_BACKOFF_TOTAL_MS_DEFAULT).toBeGreaterThanOrEqual(25 * 60 * 1000)
})

test('is429RetryableError detects HTTP 429 + rate_limit shapes', () => {
  expect(is429RetryableError(new Error('pass2 substrate error: HTTP 429: rate_limit_error'))).toBe(true)
  expect(is429RetryableError(new Error('rate_limit_error'))).toBe(true)
  expect(is429RetryableError(new Error('rate-limit hit'))).toBe(true)
  expect(is429RetryableError(new ImportError('substrate_error', null, 'pass2 substrate error: HTTP 429'))).toBe(true)
  // Non-429 substrate failures — NOT retryable (engine surfaces `failed` immediately).
  expect(is429RetryableError(new Error('HTTP 400: bad request'))).toBe(false)
  expect(is429RetryableError(new Error('HTTP 500: server error'))).toBe(false)
  expect(is429RetryableError(new Error('parse_failed'))).toBe(false)
  expect(is429RetryableError(undefined)).toBe(false)
  expect(is429RetryableError(null)).toBe(false)
})

test('Pass-2 retries on 429 and succeeds on attempt 3 → job completes (status=completed)', async () => {
  let pass2Calls = 0
  const pass2: Pass2LlmCall = async () => {
    pass2Calls += 1
    if (pass2Calls < 3) {
      throw new ImportError(
        'substrate_error',
        null,
        `pass2 substrate error: HTTP 429: rate_limit_error (attempt ${pass2Calls})`,
      )
    }
    return {
      result: {
        entities: [],
        topics: [],
        proposed_projects: [{ name: 'Topline', rationale: 'recurring' }],
        proposed_tasks: [],
        proposed_reminders: [],
        voice_signals: {},
        facts: {},
      },
      dollars_billed: 0.3,
    }
  }
  const runner = new ImportJobRunner({
    db,
    pass1: pass1Ok,
    pass2,
    pass1Prompt: 'p1',
    pass2Prompt: 'p2',
    parse: parser,
    // Short schedule so the test doesn't burn wall-clock; the
    // sleep callback is a no-op anyway (test seam).
    rateLimitBackoffMs: [0, 100, 200, 400, 800],
    sleep: async () => undefined,
    // 2026-05-31 — short fixtures ("hello there") fall under the 500-
    // char skip_llm pre-filter; disable it so the test's Pass-1 + Pass-2
    // calls actually dispatch.
    chunkOptions: { min_user_content_chars: 0 },
  })
  const { job_id } = await runner.start({
    user_id: 'test-user',
    project_slug: 't1',
    source: 'chatgpt-zip',
    payload: Buffer.from(''),
  })
  await runner.awaitJob(job_id)
  const status = await runner.status(job_id)
  expect(status?.status).toBe('completed')
  // Three pass2 calls: attempt 1 (429), attempt 2 (429), attempt 3 (success).
  expect(pass2Calls).toBe(3)
  // dollars_spent must include the successful Pass-2 billing.
  expect(status?.dollars_spent).toBeGreaterThanOrEqual(0.01 + 0.3 - 0.001)
})

test('Pass-2 429 on every attempt → job lands at rate_limit_paused (not failed), state recoverable', async () => {
  let pass2Calls = 0
  const pass2: Pass2LlmCall = async () => {
    pass2Calls += 1
    throw new ImportError(
      'substrate_error',
      null,
      `pass2 substrate error: HTTP 429: rate_limit_error (attempt ${pass2Calls})`,
    )
  }
  const backoff = [0, 50, 100] // 3 attempts total
  const runner = new ImportJobRunner({
    db,
    pass1: pass1Ok,
    pass2,
    pass1Prompt: 'p1',
    pass2Prompt: 'p2',
    parse: parser,
    rateLimitBackoffMs: backoff,
    sleep: async () => undefined,
    // 2026-05-31 — short fixtures bypass the skip_llm pre-filter so
    // Pass-1 + Pass-2 dispatch as the test expects.
    chunkOptions: { min_user_content_chars: 0 },
  })
  const { job_id } = await runner.start({
    user_id: 'test-user',
    project_slug: 't1',
    source: 'chatgpt-zip',
    payload: Buffer.from(''),
  })
  await runner.awaitJob(job_id)
  expect(pass2Calls).toBe(backoff.length)
  // v0.1.78 — the NEW expected behavior: rate_limit_paused, not failed.
  const row = db
    .raw()
    .query<
      { status: string; error_code: string | null; error_message: string | null },
      [string]
    >(`SELECT status, error_code, error_message FROM import_jobs WHERE job_id = ?`)
    .get(job_id)
  expect(row?.status).toBe('rate_limit_paused')
  expect(row?.error_code).toBe('rate_limit_paused')
  expect(row?.error_message).toContain('HTTP 429')
  // Pass-1 cached chunk is preserved (state recoverable across simulated restart).
  const pass1Rows = db
    .raw()
    .query<{ count: number }, [string]>(
      `SELECT COUNT(*) AS count FROM import_pass1_chunks WHERE project_slug = ? AND analyzed = 1`,
    )
    .get('t1')
  expect(pass1Rows?.count ?? 0).toBeGreaterThan(0)
  // Partial result row exists with partial=1 so a future status() call
  // surfaces the aggregated-only synthesis.
  const resultRow = db
    .raw()
    .query<{ partial: number }, [string]>(
      `SELECT partial FROM import_results WHERE job_id = ?`,
    )
    .get(job_id)
  expect(resultRow?.partial).toBe(1)
})

test('Pass-2 non-429 error fails on the FIRST attempt (no wasteful backoff on permanent errors)', async () => {
  let pass2Calls = 0
  const pass2: Pass2LlmCall = async () => {
    pass2Calls += 1
    throw new ImportError(
      'substrate_error',
      null,
      'pass2 substrate error: HTTP 400: invalid_request_error',
    )
  }
  const runner = new ImportJobRunner({
    db,
    pass1: pass1Ok,
    pass2,
    pass1Prompt: 'p1',
    pass2Prompt: 'p2',
    parse: parser,
    rateLimitBackoffMs: [0, 50, 100],
    sleep: async () => undefined,
    // 2026-05-31 — short fixtures bypass the skip_llm pre-filter so
    // Pass-1 + Pass-2 dispatch as the test expects.
    chunkOptions: { min_user_content_chars: 0 },
  })
  const { job_id } = await runner.start({
    user_id: 'test-user',
    project_slug: 't1',
    source: 'chatgpt-zip',
    payload: Buffer.from(''),
  })
  await runner.awaitJob(job_id)
  // Single attempt — no retry on non-429.
  expect(pass2Calls).toBe(1)
  const row = db
    .raw()
    .query<{ status: string; error_message: string | null }, [string]>(
      `SELECT status, error_message FROM import_jobs WHERE job_id = ?`,
    )
    .get(job_id)
  expect(row?.status).toBe('failed')
  expect(row?.error_message).toContain('HTTP 400')
})

test('Pass-1 chunk that 429s eventually flips the job to rate_limit_paused (NOT silent drop)', async () => {
  let pass1Calls = 0
  const pass1Always429: Pass1LlmCall = async () => {
    pass1Calls += 1
    throw new ImportError(
      'substrate_error',
      null,
      `pass1 substrate error: HTTP 429: rate_limit_error (attempt ${pass1Calls})`,
    )
  }
  const pass2Stub: Pass2LlmCall = async () => ({
    result: { proposed_projects: [], proposed_tasks: [], proposed_reminders: [] },
    dollars_billed: 0,
  })
  const backoff = [0, 50, 100] // 3 attempts total
  const runner = new ImportJobRunner({
    db,
    pass1: pass1Always429,
    pass2: pass2Stub,
    pass1Prompt: 'p1',
    pass2Prompt: 'p2',
    parse: parser,
    rateLimitBackoffMs: backoff,
    sleep: async () => undefined,
    // 2026-05-31 — short fixtures bypass the skip_llm pre-filter so
    // Pass-1 + Pass-2 dispatch as the test expects.
    chunkOptions: { min_user_content_chars: 0 },
  })
  const { job_id } = await runner.start({
    user_id: 'test-user',
    project_slug: 't1',
    source: 'chatgpt-zip',
    payload: Buffer.from(''),
  })
  await runner.awaitJob(job_id)
  expect(pass1Calls).toBe(backoff.length)
  const row = db
    .raw()
    .query<{ status: string }, [string]>(`SELECT status FROM import_jobs WHERE job_id = ?`)
    .get(job_id)
  expect(row?.status).toBe('rate_limit_paused')
})

test('Cancel during Pass-2 backoff terminates the retry loop within one 500ms slice', async () => {
  let pass2Calls = 0
  let sleepCallsBeforeCancel = 0
  const sleepDelays: number[] = []
  const cancelAfterNSleeps = 3
  let cancelInjected = false
  let injectingJobId: string | null = null
  const pass2: Pass2LlmCall = async () => {
    pass2Calls += 1
    throw new ImportError(
      'substrate_error',
      null,
      'pass2 substrate error: HTTP 429: rate_limit_error',
    )
  }
  const runner = new ImportJobRunner({
    db,
    pass1: pass1Ok,
    pass2,
    pass1Prompt: 'p1',
    pass2Prompt: 'p2',
    parse: parser,
    rateLimitBackoffMs: [0, 5_000, 15_000, 45_000],
    sleep: async (ms) => {
      sleepCallsBeforeCancel += 1
      sleepDelays.push(ms)
      if (sleepCallsBeforeCancel === cancelAfterNSleeps && !cancelInjected) {
        cancelInjected = true
        if (injectingJobId !== null) {
          await db.run(`UPDATE import_jobs SET status = 'cancelled' WHERE job_id = ?`, [
            injectingJobId,
          ])
        }
      }
    },
    // 2026-05-31 — short fixtures bypass the skip_llm pre-filter.
    chunkOptions: { min_user_content_chars: 0 },
  })
  const { job_id } = await runner.start({
    user_id: 'test-user',
    project_slug: 't1',
    source: 'chatgpt-zip',
    payload: Buffer.from(''),
  })
  injectingJobId = job_id
  await runner.awaitJob(job_id)
  expect(pass2Calls).toBeLessThanOrEqual(2)
  // Every chunk respects the 500ms cap.
  expect(sleepDelays.every((d) => d <= 500)).toBe(true)
  // Final row status remains 'cancelled' (the post-loop persist does NOT
  // overwrite a cancelled row).
  const row = db
    .raw()
    .query<{ status: string }, [string]>(`SELECT status FROM import_jobs WHERE job_id = ?`)
    .get(job_id)
  expect(row?.status).toBe('cancelled')
})

test('Codex r1 (PR #271 carry-over): retryWith429 clears the cooling stamp before returning non_retryable so a status poll never sees a stale "rate-limited" body after the actual failure', async () => {
  // Bug shape: pass-1 chunk hits 429 on attempt 1 (cool-off stamp:
  // status='rate_limit_cooling_off', error_code='rate_limit_cooling_off',
  // error_message='pass1 attempt 1/N: ...cooling off...').
  // Attempt 2 throws a non-429 (substrate_error). retryWith429 returns
  // non_retryable. Pre-fix: cooling_off stamp leaks because the
  // caller's pass-1 degraded-chunk branch only flips status back to
  // 'pass1-running' — it does NOT clear error_code / error_message.
  // A status poll fired between the degraded-chunk continuation and
  // the next chunk's retryWith429 sees error_code='rate_limit_cooling_off'
  // and renders the cooling bubble incorrectly. Post-fix:
  // clearCoolingOffMessage runs before the non_retryable return.
  let pass1Calls = 0
  const pass1Sequence: Pass1LlmCall = async () => {
    pass1Calls += 1
    if (pass1Calls === 1) {
      throw new ImportError(
        'substrate_error',
        null,
        'pass1 substrate error: HTTP 429: rate_limit_error (attempt 1)',
      )
    }
    // Attempt 2 = non-429 (a real failure). retryWith429 should
    // clear the cooling stamp BEFORE returning non_retryable.
    throw new ImportError(
      'substrate_error',
      null,
      'pass1 substrate error: HTTP 400: invalid_request_error (attempt 2)',
    )
  }
  const pass2Stub: Pass2LlmCall = async () => ({
    result: {
      entities: [],
      topics: [],
      proposed_projects: [],
      proposed_tasks: [],
      proposed_reminders: [],
      voice_signals: {},
      facts: {},
    },
    dollars_billed: 0,
  })
  const runner = new ImportJobRunner({
    db,
    pass1: pass1Sequence,
    pass2: pass2Stub,
    pass1Prompt: 'p1',
    pass2Prompt: 'p2',
    parse: parser,
    rateLimitBackoffMs: [0, 50, 100], // attempt 1, 2 will fire
    sleep: async () => undefined,
    // 2026-05-31 — short fixtures bypass the skip_llm pre-filter.
    chunkOptions: { min_user_content_chars: 0 },
  })
  const { job_id } = await runner.start({
    user_id: 'test-user',
    project_slug: 't1',
    source: 'chatgpt-zip',
    payload: Buffer.from(''),
  })
  await runner.awaitJob(job_id)

  expect(pass1Calls).toBe(2)
  const row = db
    .raw()
    .query<
      { status: string; error_code: string | null; error_message: string | null },
      [string]
    >(`SELECT status, error_code, error_message FROM import_jobs WHERE job_id = ?`)
    .get(job_id)
  // The non_retryable error_code MUST NOT be the cooling-off stamp.
  // Pre-fix this row would have error_code='rate_limit_cooling_off'
  // after the degraded-chunk branch took over; the cooling text would
  // also leak into error_message.
  expect(row?.error_code).not.toBe('rate_limit_cooling_off')
  if (row?.error_message !== null && row?.error_message !== undefined) {
    expect(row.error_message).not.toContain('rate limit cooling off')
  }
})

test('rate_limit_cooling_off is persisted between retries so the engine poll can render the cooling bubble', async () => {
  let pass2Calls = 0
  let coolingObserved = false
  const pass2: Pass2LlmCall = async () => {
    pass2Calls += 1
    if (pass2Calls < 3) {
      // Between retries, the runner persists status='rate_limit_cooling_off'.
      // We sample the row right before the next call to confirm the
      // engine-poll-observable signal lives on disk.
      const row = db
        .raw()
        .query<{ status: string }, []>(`SELECT status FROM import_jobs LIMIT 1`)
        .get()
      // The cooling flag lands AFTER attempt N fails, BEFORE attempt N+1
      // dispatches — so attempts 2+ observe it.
      if (pass2Calls > 1 && row?.status === 'rate_limit_cooling_off') {
        coolingObserved = true
      }
      throw new ImportError('substrate_error', null, 'pass2 substrate error: HTTP 429')
    }
    return {
      result: {
        entities: [],
        topics: [],
        proposed_projects: [],
        proposed_tasks: [],
        proposed_reminders: [],
        voice_signals: {},
        facts: {},
      },
      dollars_billed: 0.1,
    }
  }
  const runner = new ImportJobRunner({
    db,
    pass1: pass1Ok,
    pass2,
    pass1Prompt: 'p1',
    pass2Prompt: 'p2',
    parse: parser,
    rateLimitBackoffMs: [0, 50, 100, 200],
    sleep: async () => undefined,
    // 2026-05-31 — short fixtures bypass the skip_llm pre-filter.
    chunkOptions: { min_user_content_chars: 0 },
  })
  const { job_id } = await runner.start({
    user_id: 'test-user',
    project_slug: 't1',
    source: 'chatgpt-zip',
    payload: Buffer.from(''),
  })
  await runner.awaitJob(job_id)
  expect(coolingObserved).toBe(true)
  // After a successful retry the cooling stamp is cleared and final
  // status is `completed`.
  const status = await runner.status(job_id)
  expect(status?.status).toBe('completed')
})
