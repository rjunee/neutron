/**
 * 2026-05-31 — Pass-1 N-worker pool regression suite.
 *
 * Per the "Import pass-1 — Opus default + parallel + ETA + chunk-size
 * audit" sprint brief (Part B). Pre-2026-05-31 the runner walked the
 * chunk array sequentially via `for await (const chunk of chunksIter)`
 * at job-runner.ts:609. Production Max OAuth owners now hit a
 * 4096-token Pass-1 chunk size → 12× more chunks per export → wall-
 * clock ~ N × 30s per chunk. The N-worker pool default 3× reduces
 * wall-clock to ~ N/3 × 30s and exposes the `pass1Concurrency`
 * constructor dep (env override `NEUTRON_IMPORT_PASS1_CONCURRENCY` is
 * wired by the composer; tested in build-import-job-runner.test.ts).
 *
 * 2026-06-17 (import warm-session): the DEFAULT concurrency was lowered
 * 3 to 1 — the import substrate now reuses ONE warm `claude` session and
 * the per-chunk `/clear` context reset depends on strictly sequential
 * turns. The N-worker parallel mechanism still works when an operator
 * opts in explicitly via NEUTRON_IMPORT_PASS1_CONCURRENCY.
 *
 * What this suite proves:
 *   1. Explicit `pass1Concurrency=3` runs three Pass-1 calls in flight
 *      simultaneously (concurrency assertion via in-flight counter); the
 *      OMITTED default is 1 (sequential).
 *   2. Explicit `pass1Concurrency=1` falls back to sequential — useful
 *      for legacy tests that assert ordering AND for operators who hit
 *      a per-credential rate-limit ceiling and want to throttle.
 *   3. Idempotency invariants survive the parallel shape: every chunk
 *      ends up persisted in `import_pass1_chunks` exactly once even
 *      when N=5 workers race on the same chunk array.
 *   4. Cancellation: cancel() mid-run stops new chunks from launching
 *      within one chunk completion (all workers observe the cancel
 *      flag at the top of their next iteration).
 *   5. Rate-limit exhaustion: when one worker hits
 *      `rate_limited_exhausted`, the others observe the `paused`
 *      flag + exit cleanly; the job lands at `rate_limit_paused`.
 *   6. `chunksDone` count matches the chunk array length even with
 *      parallel completion ordering.
 *   7. An LLM-unwired ImportError thrown by Pass-1 bubbles past the
 *      worker pool and the outer catch marks the job 'failed' with
 *      error_code='llm_unwired'.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '../../../migrations/runner.ts'
import { ProjectDb } from '../../../persistence/index.ts'
import { ImportError, type ConversationRecord } from '../types.ts'
import { ImportJobRunner, type SourceParser } from '../job-runner.ts'
import type { Pass1LlmCall } from '../pass1-triage.ts'
import type { Pass2LlmCall } from '../pass2-synthesis.ts'

let tmp: string
let db: ProjectDb

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-pass1-parallel-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

function makeRecords(count: number): ConversationRecord[] {
  return Array.from({ length: count }).map((_, i) => ({
    conversation_id: `c${i}`,
    messages: [
      { role: 'user' as const, text: `Conversation ${i} about projects.` },
      { role: 'assistant' as const, text: `Reply ${i}` },
    ],
  }))
}

function makeParser(records: ConversationRecord[]): SourceParser {
  return async function* () {
    for (const r of records) yield r
  }
}

const pass2: Pass2LlmCall = async () => ({
  result: {
    proposed_projects: [],
    proposed_tasks: [],
    proposed_reminders: [],
  },
  dollars_billed: 0.05,
})

test('explicit pass1Concurrency=3 runs three Pass-1 calls in flight simultaneously', async () => {
  // Track in-flight count over time. The peak should hit 3 (the
  // default concurrency); sequential would peak at 1.
  let inFlight = 0
  let peakInFlight = 0
  const release: Array<() => void> = []
  const gates: Array<Promise<void>> = []
  const gatedPass1: Pass1LlmCall = async () => {
    inFlight += 1
    if (inFlight > peakInFlight) peakInFlight = inFlight
    // Park 3 of the workers; the others continue immediately.
    if (gates.length < 3) {
      let resolver: () => void = () => undefined
      gates.push(
        new Promise<void>((r) => {
          resolver = r
        }),
      )
      release.push(resolver)
      await gates[gates.length - 1]
    }
    inFlight -= 1
    return {
      result: {
        candidate_entities: [],
        candidate_topics: [],
        candidate_tasks: [],
        voice_signals: {},
      },
      dollars_billed: 0.01,
    }
  }
  const runner = new ImportJobRunner({
    db,
    pass1: gatedPass1,
    pass2,
    pass1Prompt: 'p1',
    pass2Prompt: 'p2',
    parse: makeParser(makeRecords(6)),
    // Explicit pass1Concurrency=3 — the parallel mechanism still works when an
    // operator opts in via NEUTRON_IMPORT_PASS1_CONCURRENCY (the DEFAULT became 1
    // on 2026-06-17 for the warm single-session import; see the default test below).
    pass1Concurrency: 3,
    chunkOptions: { min_user_content_chars: 0 },
  })
  const { job_id } = await runner.start({
    user_id: 'u',
    project_slug: 't-parallel',
    source: 'chatgpt-zip',
    payload: Buffer.from(''),
  })
  // Spin until 3 workers are parked at the gate.
  while (release.length < 3) {
    await new Promise((r) => setTimeout(r, 5))
  }
  expect(peakInFlight).toBe(3)
  // Release every parked worker so the job can complete.
  for (const r of release) r()
  await runner.awaitJob(job_id)
  const status = await runner.status(job_id)
  expect(status!.status).toBe('completed')
  expect(status!.pass1_chunks_done).toBe(6)
})

test('explicit pass1Concurrency=1 falls back to sequential (peak in-flight = 1)', async () => {
  let inFlight = 0
  let peakInFlight = 0
  const seqPass1: Pass1LlmCall = async () => {
    inFlight += 1
    if (inFlight > peakInFlight) peakInFlight = inFlight
    await new Promise((r) => setTimeout(r, 10))
    inFlight -= 1
    return {
      result: {
        candidate_entities: [],
        candidate_topics: [],
        candidate_tasks: [],
        voice_signals: {},
      },
      dollars_billed: 0.01,
    }
  }
  const runner = new ImportJobRunner({
    db,
    pass1: seqPass1,
    pass2,
    pass1Prompt: 'p1',
    pass2Prompt: 'p2',
    parse: makeParser(makeRecords(5)),
    pass1Concurrency: 1,
    chunkOptions: { min_user_content_chars: 0 },
  })
  const { job_id } = await runner.start({
    user_id: 'u',
    project_slug: 't-seq',
    source: 'chatgpt-zip',
    payload: Buffer.from(''),
  })
  await runner.awaitJob(job_id)
  expect(peakInFlight).toBe(1)
  const status = await runner.status(job_id)
  expect(status!.status).toBe('completed')
  expect(status!.pass1_chunks_done).toBe(5)
})

test('DEFAULT pass1Concurrency (omitted) is 1 — sequential, one warm import session (2026-06-17)', async () => {
  // The import substrate now reuses ONE warm `claude` session across chunks; the
  // default concurrency was lowered 3 → 1 so the warm REPL serves chunks strictly
  // sequentially (no re-introduced spawn-per-chunk load spike, and the per-chunk
  // `/clear` context reset is never raced). This guards that default.
  let inFlight = 0
  let peakInFlight = 0
  const seqPass1: Pass1LlmCall = async () => {
    inFlight += 1
    if (inFlight > peakInFlight) peakInFlight = inFlight
    await new Promise((r) => setTimeout(r, 10))
    inFlight -= 1
    return {
      result: {
        candidate_entities: [],
        candidate_topics: [],
        candidate_tasks: [],
        voice_signals: {},
      },
      dollars_billed: 0.01,
    }
  }
  const runner = new ImportJobRunner({
    db,
    pass1: seqPass1,
    pass2,
    pass1Prompt: 'p1',
    pass2Prompt: 'p2',
    parse: makeParser(makeRecords(5)),
    // pass1Concurrency OMITTED → runner default. Must be 1 (was 3).
    chunkOptions: { min_user_content_chars: 0 },
  })
  const { job_id } = await runner.start({
    user_id: 'u',
    project_slug: 't-default-seq',
    source: 'chatgpt-zip',
    payload: Buffer.from(''),
  })
  await runner.awaitJob(job_id)
  // Omitted concurrency ⇒ sequential ⇒ peak in-flight is exactly 1.
  expect(peakInFlight).toBe(1)
  const status = await runner.status(job_id)
  expect(status!.status).toBe('completed')
  expect(status!.pass1_chunks_done).toBe(5)
})

test('idempotency under N=5 parallel — every chunk persisted in import_pass1_chunks exactly once', async () => {
  const runner = new ImportJobRunner({
    db,
    pass1: async () => ({
      result: {
        candidate_entities: [],
        candidate_topics: [],
        candidate_tasks: [],
        voice_signals: {},
      },
      dollars_billed: 0,
    }),
    pass2,
    pass1Prompt: 'p1',
    pass2Prompt: 'p2',
    parse: makeParser(makeRecords(10)),
    pass1Concurrency: 5,
    chunkOptions: { min_user_content_chars: 0 },
  })
  const { job_id } = await runner.start({
    user_id: 'u',
    project_slug: 't-idem',
    source: 'chatgpt-zip',
    payload: Buffer.from(''),
  })
  await runner.awaitJob(job_id)
  const rows = db
    .raw()
    .query<{ count: number }, [string]>(
      `SELECT COUNT(*) AS count FROM import_pass1_chunks WHERE project_slug = ? AND analyzed = 1`,
    )
    .get('t-idem')
  expect(rows?.count).toBe(10)
})

test('rate-limit exhaustion: first worker to hit it flips paused; siblings exit cleanly', async () => {
  let pass1Calls = 0
  const flakyPass1: Pass1LlmCall = async () => {
    pass1Calls += 1
    throw new ImportError(
      'substrate_error',
      null,
      `HTTP 429: rate_limit_error (call ${pass1Calls})`,
    )
  }
  // Tight backoff schedule so the test doesn't burn wall-clock.
  const runner = new ImportJobRunner({
    db,
    pass1: flakyPass1,
    pass2,
    pass1Prompt: 'p1',
    pass2Prompt: 'p2',
    parse: makeParser(makeRecords(8)),
    pass1Concurrency: 3,
    chunkOptions: { min_user_content_chars: 0 },
    rateLimitBackoffMs: [0, 50, 100], // 3 attempts then exhausted
    sleep: async () => undefined,
  })
  const { job_id } = await runner.start({
    user_id: 'u',
    project_slug: 't-paused',
    source: 'chatgpt-zip',
    payload: Buffer.from(''),
  })
  await runner.awaitJob(job_id)
  const row = db
    .raw()
    .query<{ status: string }, [string]>(`SELECT status FROM import_jobs WHERE job_id = ?`)
    .get(job_id)
  expect(row?.status).toBe('rate_limit_paused')
})

test('Codex r2 — rate-limited paused job does NOT over-count chunksDone toward chunksTotal', async () => {
  // The v1 worker pool unconditionally incremented chunksDone after
  // every processOne return, even when the chunk exited on
  // rate_limited_exhausted without producing a result. In a 3-worker
  // / 3-chunk shape that meant pass1_chunks_done == pass1_chunks_total
  // even though zero chunks were actually finalized — the engine's
  // "done >= total" rate-limit heuristic would then mis-classify the
  // paused job as Pass-2. Codex r2 fix: processOne returns
  // `progressed: boolean` and the worker only bumps on `true`.
  const flakyPass1: Pass1LlmCall = async () => {
    throw new ImportError(
      'substrate_error',
      null,
      `HTTP 429: rate_limit_error`,
    )
  }
  const runner = new ImportJobRunner({
    db,
    pass1: flakyPass1,
    pass2,
    pass1Prompt: 'p1',
    pass2Prompt: 'p2',
    // Exactly 3 chunks + 3 workers + 0 successful = the worst case.
    parse: makeParser(makeRecords(3)),
    pass1Concurrency: 3,
    chunkOptions: { min_user_content_chars: 0 },
    rateLimitBackoffMs: [0, 25, 50],
    sleep: async () => undefined,
  })
  const { job_id } = await runner.start({
    user_id: 'u',
    project_slug: 't-rl-no-overcount',
    source: 'chatgpt-zip',
    payload: Buffer.from(''),
  })
  await runner.awaitJob(job_id)
  const row = db
    .raw()
    .query<
      { status: string; pass1_chunks_done: number; pass1_chunks_total: number },
      [string]
    >(
      `SELECT status, pass1_chunks_done, pass1_chunks_total FROM import_jobs WHERE job_id = ?`,
    )
    .get(job_id)
  expect(row?.status).toBe('rate_limit_paused')
  expect(row?.pass1_chunks_total).toBe(3)
  // Zero chunks finalized → chunksDone MUST stay at 0. Anything else
  // means the worker is bumping on the no-result return paths.
  expect(row?.pass1_chunks_done).toBe(0)
  expect(row?.pass1_chunks_done).toBeLessThan(row?.pass1_chunks_total ?? 0)
})

test('Codex r3 — siblings stop retrying after another worker flips paused (no 3× quota burn)', async () => {
  // Sustained-429 across all workers. The brief's pre-Codex-r3
  // contract: each worker walked its full retry schedule
  // independently → N concurrent workers × full schedule = N× the
  // intended retry calls hammering an already-paused job. Fix: the
  // worker pool threads `shouldAbort: () => paused` into retryWith429
  // so siblings observe the pause flag mid-sleep (within one 500ms
  // slice) and short-circuit.
  //
  // Test approach: stagger worker timing by having the first worker
  // exhaust its schedule on attempt 3 (single-chunk fast path) while
  // the other two workers are still walking longer/deeper retry
  // schedules. With a 10-attempt schedule and 3 chunks, pre-fix worst
  // case is 30 calls. Post-fix should be substantially less because
  // workers 2 and 3 observe paused well before walking all 10
  // attempts.
  let pass1Calls = 0
  const flakyPass1: Pass1LlmCall = async () => {
    pass1Calls += 1
    throw new ImportError(
      'substrate_error',
      null,
      `HTTP 429: rate_limit_error (call ${pass1Calls})`,
    )
  }
  // 10-attempt schedule with growing delays. First worker exhausts
  // after summing the schedule; siblings should observe paused well
  // before then.
  const backoff = [0, 500, 1000, 1500, 2000, 2500, 3000, 3500, 4000, 4500]
  const runner = new ImportJobRunner({
    db,
    pass1: flakyPass1,
    pass2,
    pass1Prompt: 'p1',
    pass2Prompt: 'p2',
    parse: makeParser(makeRecords(3)),
    pass1Concurrency: 3,
    chunkOptions: { min_user_content_chars: 0 },
    rateLimitBackoffMs: backoff,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms / 20)), // 20× faster
  })
  const { job_id } = await runner.start({
    user_id: 'u',
    project_slug: 't-sibling-abort',
    source: 'chatgpt-zip',
    payload: Buffer.from(''),
  })
  await runner.awaitJob(job_id)
  const row = db
    .raw()
    .query<{ status: string }, [string]>(`SELECT status FROM import_jobs WHERE job_id = ?`)
    .get(job_id)
  expect(row?.status).toBe('rate_limit_paused')
  // Pre-Codex-r3 contract: every worker walks its full schedule
  // independently regardless of sibling state. 3 chunks × 10
  // attempts = 30 calls (the exact upper bound, no exceptions).
  //
  // Post-Codex-r3 contract: the FIRST worker that exhausts flips
  // `paused = true`, and siblings observe the flag mid-sleep
  // (between 500ms slices) and short-circuit their remaining
  // attempts. The savings depend on how tightly the 3 workers are
  // running in lockstep — with identical 429 timing they ALL hit
  // attempt 9 almost simultaneously, so the abort only catches
  // workers that haven't yet started attempt 9. The minimum
  // observable savings is 1 call (one sibling sees the abort just
  // before its final dispatch). The maximum savings would be ~7-8
  // calls per sibling on a longer-tailed sustained-429 scenario.
  //
  // We assert strict inequality with the pre-fix worst case (30)
  // because the call-count math is too timing-sensitive to pin
  // tighter. Any value < 30 proves the abort hook engaged at least
  // once.
  expect(pass1Calls).toBeLessThan(30)
  expect(pass1Calls).toBeGreaterThanOrEqual(10) // sanity: at least one full walk
})

test('Codex r3 — calendar-oauth source-aware skip_llm gate: short event bodies are NOT skipped', async () => {
  // Calendar imports emit one Conversation per event with a short
  // `role: 'event'` body. The pre-Codex-r3 chunker applied the
  // 500-char floor source-agnostically → every calendar event
  // marked skip_llm=true → empty Pass-1 placeholder → silently zero
  // entities extracted. Fix: the runner's resolveEffectiveChunkOptions
  // sets enable_skip_llm=false for every non-chat source by default.
  let pass1Calls = 0
  const tracker: Pass1LlmCall = async () => {
    pass1Calls += 1
    return {
      result: {
        candidate_entities: [{ name: 'Alice', kind: 'person', mention_count: 1 }],
        candidate_topics: [],
        candidate_tasks: [],
        voice_signals: {},
      },
      dollars_billed: 0,
    }
  }
  const calendarParser: SourceParser = async function* () {
    yield {
      conversation_id: 'event-1',
      messages: [{ role: 'event', text: '1:1 with Alice' }], // ~14 chars
    }
    yield {
      conversation_id: 'event-2',
      messages: [{ role: 'event', text: 'Quarterly planning' }], // ~18 chars
    }
  }
  const runner = new ImportJobRunner({
    db,
    pass1: tracker,
    pass2,
    pass1Prompt: 'p1',
    pass2Prompt: 'p2',
    parse: calendarParser,
    pass1Concurrency: 1,
    // chunkOptions is NOT set → runner derives enable_skip_llm=false
    // from source==='calendar-oauth' regardless of the 500-char floor.
  })
  const { job_id } = await runner.start({
    user_id: 'u',
    project_slug: 't-cal',
    source: 'calendar-oauth',
    payload: { access_token: 'fake' },
  })
  await runner.awaitJob(job_id)
  const status = await runner.status(job_id)
  expect(status!.status).toBe('completed')
  // Both calendar events MUST have dispatched to the LLM.
  expect(pass1Calls).toBe(2)
})

test('Codex r3 — explicit chunkOptions.enable_skip_llm=true overrides the source-aware gate', async () => {
  // Tests that want to exercise the skip_llm code path against a
  // non-chat source can still opt-in explicitly. The constructor
  // override wins over the runner's source-derived default.
  let pass1Calls = 0
  const tracker: Pass1LlmCall = async () => {
    pass1Calls += 1
    return {
      result: {
        candidate_entities: [],
        candidate_topics: [],
        candidate_tasks: [],
        voice_signals: {},
      },
      dollars_billed: 0,
    }
  }
  const calendarParser: SourceParser = async function* () {
    yield {
      conversation_id: 'event-1',
      messages: [{ role: 'event', text: 'tiny' }],
    }
  }
  const runner = new ImportJobRunner({
    db,
    pass1: tracker,
    pass2,
    pass1Prompt: 'p1',
    pass2Prompt: 'p2',
    parse: calendarParser,
    pass1Concurrency: 1,
    chunkOptions: { enable_skip_llm: true }, // explicit opt-in
  })
  const { job_id } = await runner.start({
    user_id: 'u',
    project_slug: 't-cal-explicit',
    source: 'calendar-oauth',
    payload: { access_token: 'fake' },
  })
  await runner.awaitJob(job_id)
  // The single event has only 4 chars of event-role text → < 500
  // floor → skip_llm=true → tracker NEVER fires.
  expect(pass1Calls).toBe(0)
})

test('Codex r2 — cancelled job does NOT over-count chunksDone toward chunksTotal', async () => {
  // Same shape as the rate-limit case but for the cancellation path.
  // Mid-pipeline cancel must not let the worker bump chunksDone for
  // the chunk it abandoned.
  let pass1Calls = 0
  const slowPass1: Pass1LlmCall = async () => {
    pass1Calls += 1
    await new Promise((r) => setTimeout(r, 80))
    return {
      result: {
        candidate_entities: [],
        candidate_topics: [],
        candidate_tasks: [],
        voice_signals: {},
      },
      dollars_billed: 0,
    }
  }
  const runner = new ImportJobRunner({
    db,
    pass1: slowPass1,
    pass2,
    pass1Prompt: 'p1',
    pass2Prompt: 'p2',
    parse: makeParser(makeRecords(10)),
    pass1Concurrency: 3,
    chunkOptions: { min_user_content_chars: 0 },
  })
  const { job_id } = await runner.start({
    user_id: 'u',
    project_slug: 't-cancel-no-overcount',
    source: 'chatgpt-zip',
    payload: Buffer.from(''),
  })
  // Let workers start (but most chunks are unfinished — pass1Calls
  // likely 3+ in flight by now).
  await new Promise((r) => setTimeout(r, 30))
  await runner.cancel(job_id)
  await runner.awaitJob(job_id)
  const row = db
    .raw()
    .query<{ status: string; pass1_chunks_done: number; pass1_chunks_total: number }, [string]>(
      `SELECT status, pass1_chunks_done, pass1_chunks_total FROM import_jobs WHERE job_id = ?`,
    )
    .get(job_id)
  expect(row?.status).toBe('cancelled')
  // chunksDone may be > 0 (some chunks finished before cancel landed),
  // but MUST NOT equal chunksTotal — that would mean the worker
  // over-counted abandoned chunks. We started 10 chunks with a 30ms
  // pre-cancel pause + 80ms per-chunk latency; at most a couple
  // could have finalized.
  expect(row?.pass1_chunks_total).toBe(10)
  expect(row?.pass1_chunks_done).toBeLessThan(row?.pass1_chunks_total ?? 0)
})

test('cancel mid-run stops new chunk launches within one chunk completion', async () => {
  let pass1Calls = 0
  const slowPass1: Pass1LlmCall = async () => {
    pass1Calls += 1
    await new Promise((r) => setTimeout(r, 50))
    return {
      result: {
        candidate_entities: [],
        candidate_topics: [],
        candidate_tasks: [],
        voice_signals: {},
      },
      dollars_billed: 0,
    }
  }
  const runner = new ImportJobRunner({
    db,
    pass1: slowPass1,
    pass2,
    pass1Prompt: 'p1',
    pass2Prompt: 'p2',
    parse: makeParser(makeRecords(20)),
    pass1Concurrency: 4,
    chunkOptions: { min_user_content_chars: 0 },
  })
  const { job_id } = await runner.start({
    user_id: 'u',
    project_slug: 't-cancel',
    source: 'chatgpt-zip',
    payload: Buffer.from(''),
  })
  // Let a few workers spin up, then cancel.
  await new Promise((r) => setTimeout(r, 30))
  await runner.cancel(job_id)
  await runner.awaitJob(job_id)
  const status = await runner.status(job_id)
  expect(status!.status).toBe('cancelled')
  // Far fewer than the full 20 chunks should have launched.
  expect(pass1Calls).toBeLessThan(20)
})

test('Argus r1 — N=3 parallel runs produce byte-identical aggregated Pass-1 input across N runs', async () => {
  // Per the post-parallel-pool finding: each worker pushes into
  // `pass1Results` as its LLM call returns, so the array fed to
  // `aggregatePass1(...)` is completion-order, not chunk-index order.
  // `aggregatePass1` has order-dependent tie behavior in five places
  // (entity-name capitalization on equal-length ties, topic summary
  // cap at 5 in arrival order, task dedup by lowercased title,
  // pickMostFrequent voice-signal tie resolution, entity top-50 slice
  // when ties land at the boundary). The fix sorts pass1Results by
  // chunk_hash before aggregation so the aggregated object is
  // deterministic across runs regardless of LLM completion order.
  //
  // Test approach:
  //   - 12 chunks crafted so that aggregation hits every order-
  //     dependent tie path (same-length entity-name variants, >5
  //     topic-summary variants on one canonical topic, tied
  //     pickMostFrequent voice signals).
  //   - Pass-1 LLM call introduces a random per-chunk delay so the
  //     completion order shuffles across runs.
  //   - Capture the AggregatedPass1 object Pass-2 receives.
  //   - Run twice → JSON.stringify each captured aggregate → assert
  //     byte-identical.
  //
  // Pre-fix this would be flaky / fail; post-fix it's a hard equality.

  const makeRunner = (capture: (a: unknown) => void): ImportJobRunner => {
    const racyPass1: Pass1LlmCall = async ({ chunk }) => {
      // Per-chunk random delay 0-25ms so completion ordering shuffles.
      await new Promise((r) => setTimeout(r, Math.random() * 25))
      // Use chunk.conversation_id index parsed from `c<N>` to vary
      // the result shape across chunks.
      const idx = Number.parseInt(chunk.conversation_id.slice(1), 10)
      // Same-length entity-name variants across pairs of chunks → ties
      // resolve to first-seen post-sort.
      const entityName = idx % 2 === 0 ? 'alice smith' : 'ALICE SMITH'
      // 12 chunks all reference one canonical topic 'planning' with a
      // distinct summary each → cap-at-5 picks first 5 in input order.
      const topicSummary = `summary-${idx}`
      // Voice-signal ties: alternate tone values to hit equal counts.
      const tone = idx % 2 === 0 ? 'terse' : 'expansive'
      return {
        result: {
          candidate_entities: [
            { name: entityName, kind: 'person' as const, mention_count: 1 },
          ],
          candidate_topics: [
            { name: 'planning', summary: topicSummary, recency_at: idx },
          ],
          candidate_tasks: [{ title: `task-${idx % 4}`, due_at: idx }],
          voice_signals: { tone },
        },
        dollars_billed: 0,
      }
    }
    const capturingPass2: Pass2LlmCall = async ({ aggregated }) => {
      capture(aggregated)
      return {
        result: { proposed_projects: [], proposed_tasks: [], proposed_reminders: [] },
        dollars_billed: 0,
      }
    }
    return new ImportJobRunner({
      db,
      pass1: racyPass1,
      pass2: capturingPass2,
      pass1Prompt: 'p1',
      pass2Prompt: 'p2',
      parse: makeParser(makeRecords(12)),
      pass1Concurrency: 3,
      chunkOptions: { min_user_content_chars: 0 },
    })
  }

  let firstAggregate: unknown = null
  const runner1 = makeRunner((a) => {
    firstAggregate = a
  })
  const { job_id: job1 } = await runner1.start({
    user_id: 'u',
    project_slug: 't-determ-1',
    source: 'chatgpt-zip',
    payload: Buffer.from(''),
  })
  await runner1.awaitJob(job1)

  let secondAggregate: unknown = null
  const runner2 = makeRunner((a) => {
    secondAggregate = a
  })
  const { job_id: job2 } = await runner2.start({
    user_id: 'u',
    project_slug: 't-determ-2',
    source: 'chatgpt-zip',
    payload: Buffer.from(''),
  })
  await runner2.awaitJob(job2)

  expect(firstAggregate).not.toBeNull()
  expect(secondAggregate).not.toBeNull()
  // Byte-identical aggregation regardless of which worker landed
  // each chunk first. Pre-fix flakes; post-fix is a hard equality.
  expect(JSON.stringify(firstAggregate)).toBe(JSON.stringify(secondAggregate))
})

test('llm_unwired ImportError bubbles past worker pool → job marked failed', async () => {
  const unwiredPass1: Pass1LlmCall = async () => {
    throw new ImportError(
      'llm_unwired',
      null,
      'ImportJobRunner: pass1Llm is not wired',
    )
  }
  const runner = new ImportJobRunner({
    db,
    pass1: unwiredPass1,
    pass2,
    pass1Prompt: 'p1',
    pass2Prompt: 'p2',
    parse: makeParser(makeRecords(3)),
    pass1Concurrency: 3,
    chunkOptions: { min_user_content_chars: 0 },
  })
  const { job_id } = await runner.start({
    user_id: 'u',
    project_slug: 't-unwired',
    source: 'chatgpt-zip',
    payload: Buffer.from(''),
  })
  await runner.awaitJob(job_id)
  const row = db
    .raw()
    .query<{ status: string; error_code: string | null }, [string]>(
      `SELECT status, error_code FROM import_jobs WHERE job_id = ?`,
    )
    .get(job_id)
  expect(row?.status).toBe('failed')
  expect(row?.error_code).toBe('llm_unwired')
})
