/**
 * 2026-06-01 — synthesizeOnDemand → real Pass-2 regression suite.
 *
 * Bug shape (reproduced on prod instance t-99999999): a user whose import
 * was salvaged via `synthesizeOnDemand` (the engine hard-timeout backstop)
 * was shown a blank "(Based on N conversations.)" template with ZERO
 * projects + ZERO interests. Root cause: `synthesizeOnDemand` called
 * `degradedFromAggregated` directly — a no-LLM stub that hardcodes
 * `proposed_projects: []` and never sets `inferred_interests`.
 *
 * The fix runs the REAL Pass-2 LLM (`pass2Synthesize`) over the cached
 * aggregated Pass-1 signal, falling back to `degradedFromAggregated` ONLY
 * when Pass-2 itself throws.
 *
 * Design note (Codex r1 P1): the SOLE caller is the engine hard-timeout
 * path, which cancels the runner BEFORE invoking us. So `synthesizeOnDemand`
 * does a SINGLE direct Pass-2 attempt — NOT wrapped in `retryWith429` —
 * to (a) avoid a multi-minute backoff window of post-cancel money-burn and
 * (b) stay cancel-tolerant (retryWith429 short-circuits to null the moment
 * the job is cancelled, salvaging nothing).
 *
 * What this suite proves:
 *
 *   1. Happy path — real Pass-2 over the cache produces non-empty
 *      projects + interests, stamps `synthesizer_model`, persists
 *      `partial=1` + the honest cached-chunk `conversation_count`, AND
 *      accumulates the Pass-2 spend onto `import_jobs.dollars_spent`.
 *   2. Cancel-tolerant — a job ALREADY in `cancelled` still synthesizes a
 *      real Pass-2 result from the cache (no isCancelled short-circuit).
 *   3. Degraded fallback — a non_retryable Pass-2 error falls back to
 *      `degradedFromAggregated` and emits the operator-greppable
 *      `synthesize_on_demand_degraded_fallback` journald line.
 *   4. Single attempt on rate-limit — a Pass-2 that throws a 429 falls
 *      back to the degraded stub on the FIRST attempt (no retry/backoff)
 *      AND does NOT call `markRateLimitPaused` (the ON_DEMAND path must
 *      not mutate the parent job's known terminal/paused state).
 *   5. Empty cache — returns null when there are no analyzed chunks.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '../../../migrations/runner.ts'
import { ProjectDb } from '../../../persistence/index.ts'
import { ImportJobRunner, type SourceParser } from '../job-runner.ts'
import type { Pass1LlmCall } from '../pass1-triage.ts'
import type { Pass2LlmCall } from '../pass2-synthesis.ts'
import { ImportError, type ConversationRecord } from '../types.ts'

const OWNER = 't-ondemand'
const SOURCE = 'chatgpt-zip'

let tmp: string
let db: ProjectDb

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-ondemand-pass2-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

// Pass-1 is never invoked by synthesizeOnDemand (it reads the cached
// chunk rows directly), but the runner constructor requires a callable.
const pass1Never: Pass1LlmCall = async () => {
  throw new Error('pass1 must not be called by synthesizeOnDemand')
}

const parser: SourceParser = async function* (): AsyncGenerator<ConversationRecord> {
  // never iterated on this path
}

/** Seed an import_jobs row in a given status (default: cancelled). */
function seedJob(
  job_id: string,
  opts: {
    status?: string
    dollars_spent?: number
    error_code?: string | null
    error_message?: string | null
    last_paused_at?: number | null
  } = {},
): void {
  const status = opts.status ?? 'cancelled'
  db.raw()
    .query(
      `INSERT INTO import_jobs
        (job_id, project_slug, source, status, dollars_spent, pass1_chunks_done,
         pass1_chunks_total, chunks_total_known, started_at, completed_at,
         error_code, error_message, last_paused_at)
       VALUES (?, ?, ?, ?, ?, 5, 5, 1, 1000, NULL, ?, ?, ?)`,
    )
    .run(
      job_id,
      OWNER,
      SOURCE,
      status,
      opts.dollars_spent ?? 0,
      opts.error_code ?? null,
      opts.error_message ?? null,
      opts.last_paused_at ?? null,
    )
}

/** Seed N analyzed Pass-1 chunk rows with realistic candidate signal. */
function seedChunks(job_id: string, n: number): void {
  for (let i = 0; i < n; i += 1) {
    const entities = [
      { name: 'Acme', kind: 'company', mention_count: 3 + i },
      { name: 'Casey', kind: 'person', mention_count: 2 },
      { name: i % 2 === 0 ? 'fragrance' : 'packaging', kind: 'concept', mention_count: 1 },
    ]
    const topics = [
      { name: 'Q3 fragrance launch', summary: `spring 2026 line (chunk ${i})`, recency_at: 1700000000 + i },
    ]
    const tasks = [{ title: `Order packaging samples ${i}` }]
    const voice = { tone: 'expansive', verbosity: 'medium' }
    db.raw()
      .query(
        `INSERT INTO import_pass1_chunks
          (project_slug, source, chunk_hash, job_id, conversation_id, chunk_index,
           chunk_byte_length, candidate_entities_json, candidate_topics_json,
           candidate_tasks_json, voice_signals_json, dollars_billed, analyzed_at, analyzed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0.04, ?, 1)`,
      )
      .run(
        OWNER,
        SOURCE,
        `chunk-hash-${i}`,
        job_id,
        `conv-${i}`,
        i,
        500,
        JSON.stringify(entities),
        JSON.stringify(topics),
        JSON.stringify(tasks),
        JSON.stringify(voice),
        1700000000 + i,
      )
  }
}

function makeRunner(pass2: Pass2LlmCall): ImportJobRunner {
  return new ImportJobRunner({
    db,
    pass1: pass1Never,
    pass2,
    pass1Prompt: 'p1',
    pass2Prompt: 'p2',
    parse: parser,
    sleep: async () => undefined,
    now: () => 999_999,
  })
}

/** A real-Pass-2 stub returning a populated synthesis + billing + model. */
const realPass2: Pass2LlmCall = async () => ({
  result: {
    proposed_projects: [
      { name: 'Acme', rationale: 'fragrance brand Q3 launch', suggested_topics: ['packaging'] },
      { name: 'Topline', rationale: 'JV operations' },
    ],
    proposed_tasks: [{ title: 'Ship Q3 packaging' }],
    proposed_reminders: [],
    facts: { user_role: 'founder/CEO', companies: ['Acme'] },
    inferred_interests: [
      { name: 'climbing', basis: 'weekly mentions' },
      { name: 'tea ceremony' },
    ],
  },
  dollars_billed: 0.3,
  synthesizer_model: 'claude-opus-4-7',
})

test('synthesizeOnDemand runs real Pass-2 over cached signal → non-empty projects + interests + synthesizer_model, partial=1, dollars accumulated', async () => {
  const job_id = 'job-ondemand-success'
  seedJob(job_id, { status: 'rate_limit_paused', dollars_spent: 0.5 })
  seedChunks(job_id, 5)

  const runner = makeRunner(realPass2)
  const result = await runner.synthesizeOnDemand(job_id)
  expect(result).not.toBeNull()
  expect(result!.proposed_projects.length).toBe(2)
  expect(result!.inferred_interests?.length).toBe(2)
  expect(result!.synthesizer_model).toBe('claude-opus-4-7')

  const row = db
    .raw()
    .query<
      {
        projects_json: string
        inferred_interests_json: string
        synthesizer_model: string | null
        conversation_count: number | null
        partial: number
      },
      [string]
    >(
      `SELECT projects_json, inferred_interests_json, synthesizer_model,
              conversation_count, partial
         FROM import_results WHERE job_id = ?`,
    )
    .get(job_id)
  expect(row).not.toBeNull()

  const projects = JSON.parse(row!.projects_json) as Array<{ name: string }>
  expect(projects.length).toBe(2)
  expect(projects.map((p) => p.name)).toContain('Acme')

  const interests = JSON.parse(row!.inferred_interests_json) as Array<{ name: string }>
  expect(interests.length).toBe(2)
  expect(interests.map((i) => i.name)).toContain('climbing')

  expect(row!.synthesizer_model).toBe('claude-opus-4-7')
  // Honest cached-chunk count (5 analyzed chunks seeded).
  expect(row!.conversation_count).toBe(5)
  expect(row!.partial).toBe(1)

  // Codex r1 P2 — the real Pass-2 spend ($0.30) is accumulated onto the
  // pre-existing ledger ($0.50) instead of being silently discarded.
  const jobRow = db
    .raw()
    .query<{ dollars_spent: number }, [string]>(
      `SELECT dollars_spent FROM import_jobs WHERE job_id = ?`,
    )
    .get(job_id)
  expect(jobRow!.dollars_spent).toBeCloseTo(0.8, 5)
})

test('synthesizeOnDemand is cancel-tolerant — an ALREADY-cancelled job still synthesizes a real Pass-2 partial from the cache', async () => {
  // Codex r1 P2 — pre-fix-rework a retryWith429 wrapper would short-circuit
  // to {kind:'cancelled'} on this job and return null, salvaging nothing.
  // The single direct Pass-2 attempt has no isCancelled guard.
  const job_id = 'job-ondemand-cancelled'
  seedJob(job_id, { status: 'cancelled' })
  seedChunks(job_id, 5)

  const runner = makeRunner(realPass2)
  const result = await runner.synthesizeOnDemand(job_id)
  expect(result).not.toBeNull()
  expect(result!.proposed_projects.length).toBe(2)

  const row = db
    .raw()
    .query<{ projects_json: string; partial: number }, [string]>(
      `SELECT projects_json, partial FROM import_results WHERE job_id = ?`,
    )
    .get(job_id)
  expect((JSON.parse(row!.projects_json) as unknown[]).length).toBe(2)
  expect(row!.partial).toBe(1)
})

test('synthesizeOnDemand falls back to degradedFromAggregated on a non_retryable Pass-2 error + emits the operator journald line', async () => {
  const job_id = 'job-ondemand-nonretryable'
  seedJob(job_id, { status: 'rate_limit_paused' })
  seedChunks(job_id, 5)

  const pass2Stub: Pass2LlmCall = async () => {
    throw new ImportError('substrate_error', null, 'pass2 substrate error: HTTP 400: invalid_request_error')
  }

  // Capture console.warn to prove the operator-greppable line is emitted.
  const warnings: string[] = []
  const origWarn = console.warn
  console.warn = (...args: unknown[]): void => {
    warnings.push(args.map((a) => String(a)).join(' '))
  }
  let result
  try {
    const runner = makeRunner(pass2Stub)
    result = await runner.synthesizeOnDemand(job_id)
  } finally {
    console.warn = origWarn
  }

  expect(result).not.toBeNull()
  // Degraded stub — empty projects, no synthesizer_model.
  expect(result!.proposed_projects.length).toBe(0)
  expect(result!.synthesizer_model).toBeUndefined()

  const row = db
    .raw()
    .query<{ projects_json: string; synthesizer_model: string | null; partial: number }, [string]>(
      `SELECT projects_json, synthesizer_model, partial FROM import_results WHERE job_id = ?`,
    )
    .get(job_id)
  expect(JSON.parse(row!.projects_json)).toEqual([])
  expect(row!.synthesizer_model).toBeNull()
  expect(row!.partial).toBe(1)

  // The operator journald line landed with the failure reason.
  const fallbackLine = warnings.find((w) => w.includes('synthesize_on_demand_degraded_fallback'))
  expect(fallbackLine).toBeDefined()
  expect(fallbackLine).toContain(`job=${job_id}`)
  expect(fallbackLine).toContain('HTTP 400')
})

test('synthesizeOnDemand: a rate-limit (429) Pass-2 error degrades on the FIRST attempt (no retry/backoff) AND markRateLimitPaused does NOT run', async () => {
  const job_id = 'job-ondemand-ratelimited'
  const SENTINEL_PAUSED_AT = 12_345
  const SENTINEL_MSG = 'pre-existing pause body'
  seedJob(job_id, {
    status: 'rate_limit_paused',
    error_code: 'rate_limit_paused',
    error_message: SENTINEL_MSG,
    last_paused_at: SENTINEL_PAUSED_AT,
  })
  seedChunks(job_id, 5)

  let pass2Calls = 0
  const pass2Stub: Pass2LlmCall = async () => {
    pass2Calls += 1
    throw new ImportError('substrate_error', null, 'pass2 substrate error: HTTP 429: rate_limit_error')
  }

  const origWarn = console.warn
  console.warn = (): void => undefined
  let result
  try {
    const runner = makeRunner(pass2Stub)
    result = await runner.synthesizeOnDemand(job_id)
  } finally {
    console.warn = origWarn
  }

  // SINGLE attempt — no retryWith429 backoff loop on the on-demand path.
  expect(pass2Calls).toBe(1)

  // Degraded fallback persisted with partial=1.
  expect(result).not.toBeNull()
  expect(result!.proposed_projects.length).toBe(0)
  const resultRow = db
    .raw()
    .query<{ partial: number }, [string]>(`SELECT partial FROM import_results WHERE job_id = ?`)
    .get(job_id)
  expect(resultRow!.partial).toBe(1)

  // CRITICAL — markRateLimitPaused did NOT run: the seeded job state is
  // untouched. If it had run, last_paused_at would be 999_999 (the
  // runner's now()) and error_message would be the "backoff exhausted"
  // body. The on-demand path never mutates the job's lifecycle.
  const jobRow = db
    .raw()
    .query<
      { status: string; error_code: string | null; error_message: string | null; last_paused_at: number | null },
      [string]
    >(
      `SELECT status, error_code, error_message, last_paused_at
         FROM import_jobs WHERE job_id = ?`,
    )
    .get(job_id)
  expect(jobRow!.status).toBe('rate_limit_paused')
  expect(jobRow!.error_code).toBe('rate_limit_paused')
  expect(jobRow!.error_message).toBe(SENTINEL_MSG)
  expect(jobRow!.last_paused_at).toBe(SENTINEL_PAUSED_AT)
})

test('synthesizeOnDemand({preferDegraded:true}) skips the real Pass-2 call → degraded result (Codex r2: no double Pass-2 when the original job was already pass2-running)', async () => {
  const job_id = 'job-ondemand-prefer-degraded'
  seedJob(job_id, { status: 'cancelled', dollars_spent: 0.5 })
  seedChunks(job_id, 5)

  let pass2Calls = 0
  const pass2Stub: Pass2LlmCall = async () => {
    pass2Calls += 1
    return (await realPass2({ aggregated: undefined as never, prompt: '' }))
  }

  const warnings: string[] = []
  const origWarn = console.warn
  console.warn = (...args: unknown[]): void => {
    warnings.push(args.map((a) => String(a)).join(' '))
  }
  let result
  try {
    const runner = makeRunner(pass2Stub)
    result = await runner.synthesizeOnDemand(job_id, { preferDegraded: true })
  } finally {
    console.warn = origWarn
  }

  // The real Pass-2 substrate must NOT have been called.
  expect(pass2Calls).toBe(0)
  // Degraded result — empty projects, no synthesizer_model.
  expect(result).not.toBeNull()
  expect(result!.proposed_projects.length).toBe(0)
  expect(result!.synthesizer_model).toBeUndefined()

  const row = db
    .raw()
    .query<{ projects_json: string; partial: number }, [string]>(
      `SELECT projects_json, partial FROM import_results WHERE job_id = ?`,
    )
    .get(job_id)
  expect(JSON.parse(row!.projects_json)).toEqual([])
  expect(row!.partial).toBe(1)

  // No Pass-2 spend accumulated (degraded path bills nothing).
  const jobRow = db
    .raw()
    .query<{ dollars_spent: number }, [string]>(
      `SELECT dollars_spent FROM import_jobs WHERE job_id = ?`,
    )
    .get(job_id)
  expect(jobRow!.dollars_spent).toBeCloseTo(0.5, 5)

  // Journald line surfaces the pass2-already-in-flight reason.
  const line = warnings.find((w) => w.includes('synthesize_on_demand_degraded_fallback'))
  expect(line).toBeDefined()
  expect(line).toContain('reason=pass2_already_in_flight')
})

test('ISSUES #91 (Argus/Codex r1 BLOCKER) — salvage returns the cached signal even when the queried job_id (latest resume cycle) analyzed ZERO chunks: the signal lives under the ORIGINAL job_id', async () => {
  // Reproduce the resume-lineage job_id mismatch with the REAL SQL filter
  // (the engine-level fake-runner test masked this by ignoring job_id):
  //   - The ORIGINAL job analyzed all the chunks → rows stamped job=original.
  //   - The auto-resume loop spun up `job-resumed-4` which re-exhausted on
  //     429 before analyzing anything → ZERO chunks under its job_id.
  //   - `degradeRateLimitExhausted` calls synthesizeOnDemand with the LATEST
  //     resumed job_id. Pre-fix the `WHERE job_id = ?` filter matched no
  //     analyzed rows → returned null → discarded the cached signal.
  // Post-fix the cache is scoped by the dedup key (instance, source), so the
  // original job's chunks are salvaged regardless of the queried job_id.
  const ORIGINAL = 'job-original'
  const LATEST_RESUME = 'job-resumed-4'

  // Original job carried the Pass-1 cache (now terminal/paused).
  seedJob(ORIGINAL, { status: 'rate_limit_paused', dollars_spent: 1.2 })
  seedChunks(ORIGINAL, 5)

  // Latest resume cycle: paused, ZERO analyzed chunks under its own job_id.
  seedJob(LATEST_RESUME, { status: 'rate_limit_paused', dollars_spent: 0 })

  // Sanity: the latest resume genuinely has no rows under its job_id, so a
  // job_id-scoped query (the old behavior) would have salvaged nothing.
  const underResume = db
    .raw()
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM import_pass1_chunks WHERE job_id = ? AND analyzed = 1`,
    )
    .get(LATEST_RESUME)
  expect(underResume!.n).toBe(0)

  const origWarn = console.warn
  console.warn = (): void => undefined
  let result
  try {
    const runner = makeRunner(realPass2)
    // preferDegraded mirrors the degradeRateLimitExhausted call site.
    result = await runner.synthesizeOnDemand(LATEST_RESUME, { preferDegraded: true })
  } finally {
    console.warn = origWarn
  }

  // The cached Pass-1 signal is SALVAGED, not discarded — degraded path
  // aggregates the 5 original-job chunks (preferDegraded skips real Pass-2,
  // so projects come from the no-LLM stub, but the aggregated signal — the
  // honest conversation_count — proves the cache was read).
  expect(result).not.toBeNull()

  // The salvaged partial is persisted under the queried (latest) job_id with
  // the honest cached-chunk count from the ORIGINAL job's 5 analyzed chunks.
  const row = db
    .raw()
    .query<{ conversation_count: number | null; partial: number }, [string]>(
      `SELECT conversation_count, partial FROM import_results WHERE job_id = ?`,
    )
    .get(LATEST_RESUME)
  expect(row).not.toBeNull()
  expect(row!.partial).toBe(1)
  expect(row!.conversation_count).toBe(5)
})

test('synthesizeOnDemand returns null when there are no analyzed Pass-1 chunks', async () => {
  const job_id = 'job-ondemand-empty'
  seedJob(job_id, { status: 'cancelled' })
  // No chunks seeded.
  const pass2Stub: Pass2LlmCall = async () => {
    throw new Error('pass2 must not be called when there is nothing to synthesize')
  }
  const runner = makeRunner(pass2Stub)
  const result = await runner.synthesizeOnDemand(job_id)
  expect(result).toBeNull()
})
