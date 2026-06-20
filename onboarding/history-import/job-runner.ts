/**
 * @neutronai/onboarding/history-import — ImportJobRunner (P2 S3 + v0.1.78).
 *
 * SUPERSEDED ON THE OPEN ONBOARDING PATH (Step 2b, 2026-06-17). The live Open
 * single-owner import no longer drives this per-chunk runner — it runs through
 * the ONE accumulating synthesis session (`onboarding/synthesis/*` via
 * `gateway/realmode-composer/build-synthesis-import-runner.ts`), which reads the
 * whole export in a handful of passes through one warm `claude` REPL that
 * ACCUMULATES a user-model (NO `/clear`). This per-chunk runner — one heavy LLM
 * call per 150K-token chunk, `/clear`'d between chunks — is RETAINED only for:
 *   (a) the MANAGED hosted import path, whose import substrate is still
 *       `ephemeral` (unsuited to accumulation) pending a managed-substrate
 *       rework, and
 *   (b) the Pass-2 Sonnet-fallback / resilience / credential-kind tests that
 *       inject deterministic `importPass1Llm`/`importPass2Llm` callers.
 * See SPEC.md Decisions Log 2026-06-17 + `docs/plans/onboarding-single-session-architecture-2026-06-17.md`.
 *
 * Per docs/plans/P2-onboarding.md § 4.7 (job-runner module contract) +
 * § 2.3 (locked design — two-pass map-reduce, idempotent chunk hashing).
 *
 * v0.1.78 (2026-05-22, "import resilience") rewrites the rate-limit
 * handling and removes the budget-cap subsystem entirely. The shape:
 *
 *   start(input) → returns job_id immediately, runs in background
 *   status(job_id) → polled by signup landing page + onboarding engine
 *   cancel(job_id) → user-initiated mid-run abort
 *
 * Pipeline phases:
 *   1. Source → ConversationStream (parser)
 *   2. ConversationStream → Chunks (chunker)
 *   3. Per chunk:
 *        a. Check chunk_hash against `import_pass1_chunks` (idempotent dedup)
 *        b. If unseen: run Pass-1 LLM via `retryWith429` — on 429 the
 *           runner persists `status='rate_limit_cooling_off'`, sleeps
 *           `min(60, 5 * 2^attempt)` seconds, retries. On exhaustion
 *           after ~30 min, flips `status='rate_limit_paused'` and exits;
 *           cached Pass-1 work survives for a future resume.
 *        c. Persist Pass-1 result + actual billed cost
 *   4. After all chunks: aggregatePass1 → Pass-2 LLM via the same
 *      `retryWith429` wrapper → persist `import_results` row
 *
 * dollars_spent stays on the row purely for telemetry / observability;
 * NOTHING reads it for enforcement. Sam's directive (2026-05-22): Max
 * OAuth owners don't pay marginal cost — the prior "we hit a $X cap,
 * Continue/Stop/Skip?" UX was misleading and a hard fail for the live
 * walkthroughs. The budget-cap subsystem is gone, no flag, no shim.
 */

import { randomUUID } from 'node:crypto'
import type { ProjectDb } from '../../persistence/index.ts'
import { BEST_MODEL } from '../../runtime/models.ts'
import type { CredentialKind } from '../../runtime/credential-pool.ts'
import { aggregatePass1, pass2Synthesize, type Pass2LlmCall } from './pass2-synthesis.ts'
import { pass1Triage, type Pass1LlmCall } from './pass1-triage.ts'
import { chunkConversations } from './chunker.ts'
import {
  CHUNK_TARGET_TOKENS,
  ImportError,
  MAX_OAUTH_CHUNK_TARGET_TOKENS,
  type Chunk,
  type ChunkerInput,
  type ConversationRecord,
  type ImportJob,
  type ImportJobStatus,
  type ImportResult,
  type ImportSource,
  type Pass1ChunkResult,
} from './types.ts'
import {
  populateEntitiesFromImport,
  type WriteEntityFn,
} from './entity-populator.ts'
import type { SyncHook } from '../../runtime/entity-writer.ts'

/**
 * v0.1.85 (2026-05-23) — credential-kind resolver shape. The composer
 * threads this so the runner can pick the right `chunk_target_tokens`
 * at job-start time without rebuilding the full credential-pool path.
 * Returns `null` when the pool is empty (no credential yet — the
 * runner falls back to the default chunk target and the substrate's
 * own dispatch will surface the empty-pool error). The runner only
 * cares whether `kind === 'oauth'` to flip the smaller target.
 */
export type CredentialKindResolver = () => Promise<CredentialKind | null> | CredentialKind | null

/**
 * Source-specific parser: takes a Buffer (zip) or OAuthRefs (oauth)
 * and yields conversations. Production wires:
 *   chatgpt-zip      → parseChatgptExport
 *   claude-zip       → parseClaudeExport
 *   gmail-oauth      → fetchGmailThreads
 *   calendar-oauth   → fetchCalendarEvents
 *   drive/notion/slack → throw 'oauth_scope_missing'
 */
export type SourceParser = (
  source: ImportSource,
  payload: ChunkerInput,
) => AsyncIterable<ConversationRecord>

export interface ImportJobRunnerDeps {
  db: ProjectDb
  pass1: Pass1LlmCall
  pass2: Pass2LlmCall
  pass1Prompt: string
  pass2Prompt: string
  parse: SourceParser
  /**
   * Test seam: chunk-target override + uuid override + clock override.
   * `min_user_content_chars` overrides the skip_llm pre-filter floor
   * (defaults to `MIN_USER_CONTENT_CHARS` from types.ts). Tests can
   * also force-disable the skip_llm path with `enable_skip_llm: false`
   * (the runner does this for non-chat sources at job-start time
   * regardless of what tests pass — see resolveEffectiveChunkOptions).
   */
  chunkOptions?: {
    target_tokens?: number
    min_user_content_chars?: number
    enable_skip_llm?: boolean
  }
  uuid?: () => string
  now?: () => number
  /**
   * 2026-05-31 — Pass-1 worker-pool fan-out. Number of concurrent Pass-1
   * chunk LLM calls in flight at any time. Default 1 (2026-06-17 import
   * warm-session sprint — was 3). The import substrate now reuses ONE warm
   * `claude` REPL across chunks; running N concurrent chunk turns through it
   * would (a) require N warm REPLs (re-introducing the spawn-per-chunk load
   * spike this sprint removes — load 8-15 on 8 cores on Ryan's box) and
   * (b) break the per-chunk `/clear` context-reset, which depends on strictly
   * sequential turns. Sequential-1 keeps exactly one warm session busy at a
   * time. Override via `NEUTRON_IMPORT_PASS1_CONCURRENCY` for BYO-key owners
   * who want parallelism (each parallel worker then gets its own warm REPL).
   * Clamped to `Math.max(1, value)` at the worker-pool entry
   * so 0 / negative values fall back to the sequential shape. Tests
   * that depend on completion ordering (idempotency assertions over
   * which row landed first) pin this to 1 explicitly to keep their
   * fixtures deterministic.
   *
   * The pool draws from a `Chunk[]` materialized by the pre-count path
   * (always available — the pre-count fallback to streaming mode also
   * materializes into an array internally; see `run` for the wiring).
   * Each worker claims an index atomically (JS single-threaded
   * `idx++`), invokes the existing per-chunk pipeline (cached lookup →
   * claimChunk → retryWith429 → finalizePass1Chunk → bumpProgress),
   * and either continues or short-circuits on:
   *   - cancellation → all workers exit cleanly within one chunk
   *   - rate_limit_exhausted → first worker that hits it flips the job
   *     to `rate_limit_paused` and sets a shared `paused` flag the
   *     others observe between chunks
   *   - llm_unwired (or other non-retryable Pass-1 ImportError that
   *     bubbles past the per-chunk degraded branch) → re-thrown by the
   *     worker; the outer catch marks the job failed
   */
  pass1Concurrency?: number
  /**
   * v0.1.78 (2026-05-22) — sleep override threaded into the 429
   * exponential-backoff schedule. Production omits (uses `setTimeout`-
   * backed Promise); tests pass a no-op so the multi-minute delays don't
   * blow up wall-clock time in unit runs.
   */
  sleep?: (ms: number) => Promise<void>
  /**
   * v0.1.78 (2026-05-22) — 429 backoff schedule (ms between retries) used
   * for BOTH Pass-1 (per chunk) and Pass-2 calls. Default mirrors the
   * brief: `min(60, 5 * 2^attempt)` seconds for ~30 attempts (~27 min of
   * wall-clock backoff). Each entry is the delay BEFORE that retry — the
   * first entry MUST be 0 so the initial attempt is immediate. After the
   * full schedule exhausts without a non-429 result, the runner persists
   * `import_jobs.status='rate_limit_paused'` and returns gracefully.
   *
   * Notice this is one schedule shared across Pass-1 + Pass-2, NOT the
   * pre-v0.1.78 `[0, 5s, 15s, 45s]` Pass-2-only retry. Pass-1 used to
   * swallow-and-continue on substrate errors (silent 95% data loss when
   * a single 429 hit mid-import); v0.1.78 makes it survive too.
   */
  rateLimitBackoffMs?: ReadonlyArray<number>
  /**
   * v0.1.85 (2026-05-23) — credential-kind resolver. Production wires
   * a callback that reads the resolved Anthropic CredentialPool's
   * primary kind from `resolveLlmCredentials(...)`. The runner calls
   * this ONCE per job at start time (right before chunking) to decide
   * the per-job `chunk_target_tokens`:
   *   - `'oauth'` (Max OAuth Bearer auth) → `MAX_OAUTH_CHUNK_TARGET_TOKENS`
   *     (4096) — required because Max OAuth's predictive rate-limit
   *     gate rejects 50K-token-per-call requests with "This request
   *     would exceed your account's rate limit" even on the FIRST
   *     call. Without this override every Max-only owner's import is
   *     broken at 0/N chunks (incident of record: 2026-05-23 prod
   *     walkthrough).
   *   - any other kind / null / undefined → `CHUNK_TARGET_TOKENS`
   *     (50_000) — the throughput-optimised default for the regular
   *     `/v1/messages` path with an `x-api-key` header (BYO API key
   *     / per-project env / shared env).
   *
   * When omitted (T4 tests + non-Anthropic adapters), the runner
   * preserves the existing `chunkOptions.target_tokens` fallback so
   * legacy callers continue to work unchanged.
   *
   * Rotation note: mid-job credential rotation does NOT re-chunk —
   * the per-job target is frozen at start time. Re-chunking
   * mid-stream would invalidate the chunk_hash dedup table.
   */
  getCurrentCredentialKind?: CredentialKindResolver
  /**
   * 2026-05-25 (import-pipeline-resilience sprint, Bug D) — optional
   * post-completion entity-population hook. When all three of
   * `ownerDataDir`, `writeEntity`, and (optionally) `gbrainSyncHook`
   * are wired, the runner fans the persisted `ImportResult` out through
   * `populateEntitiesFromImport(...)` immediately after `persistResult`
   * lands on the `completed` path (and the partial path from
   * `synthesizeOnDemand`). Failures are swallowed + logged so the
   * runner's terminal-status flip still observes happily — the agent
   * loses the entity surface but the user-visible flow continues.
   *
   * Omitted in tests + open-tier composers that don't yet have the
   * entity tree wired; populator-invocation no-ops in that case.
   */
  ownerDataDir?: string
  writeEntity?: EntityPopulatorWriteEntityFn
  gbrainSyncHook?: ImportPopulatorSyncHook
}

/**
 * Type alias for the populator's `writeEntity` seam. Re-exported from
 * the populator module so callers don't need to chase the import.
 */
export type EntityPopulatorWriteEntityFn = WriteEntityFn

/**
 * Type alias for the optional GBrain sync hook the populator wires
 * into each `writeEntity` call.
 */
export type ImportPopulatorSyncHook = SyncHook

/**
 * v0.1.78 (2026-05-22) — default 429 retry schedule (ms). Generated from
 * the brief's `min(60, 5 * 2^attempt)` rule. attempt=0 is the first call
 * (zero delay); attempt=1 sleeps 5s before retry; attempt=2 sleeps 10s;
 * ...; attempt=4+ caps at 60s. Total backoff time across 30 attempts is
 * 5+10+20+40+60*26 = 1635s ≈ 27.25 min — matches the brief's "~30 min".
 *
 * Exported so the test suite can confirm the production wiring matches
 * the spec (drift detector — change here, change the test there).
 */
export const RATE_LIMIT_BACKOFF_MS_DEFAULT: ReadonlyArray<number> = (() => {
  const schedule: number[] = [0]
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    const seconds = Math.min(60, 5 * Math.pow(2, attempt - 1))
    schedule.push(seconds * 1000)
  }
  return schedule
})()

/**
 * v0.1.78 — convenience constant for tests + observability dashboards.
 * Sum of every entry in `RATE_LIMIT_BACKOFF_MS_DEFAULT`. Approximately
 * 1.63 million ms (~27.25 min) on the default schedule.
 */
export const RATE_LIMIT_BACKOFF_TOTAL_MS_DEFAULT =
  RATE_LIMIT_BACKOFF_MS_DEFAULT.reduce((acc, ms) => acc + ms, 0)

/**
 * 2026-06-17 (import-analysis-completeness) — upper bound on a SINGLE
 * cooldown sleep when the substrate handed us a concrete cooldown window
 * (all-credential cooldown carrying the pool's soonest `cooldown_until`).
 * A 429 cooldown is 60s and a 402 is 30 min (see `runtime/credential-pool.ts`
 * COOLDOWN_*); we cap one sleep at 5 min so a long 402/consecutive-failure
 * window doesn't park the runner in one un-cancellable block — the retry
 * loop simply re-waits on the next attempt (each sleep is sliced for
 * cancel/abort polling). The overall retry CAP stays the
 * `rateLimitBackoffMs` schedule length, so the job still converges to
 * `rate_limit_paused` (resumable at $0 by the engine's cron) if the
 * cooldown never lifts. Exported so the regression suite can assert the
 * bound.
 */
export const MAX_COOLDOWN_WAIT_MS = 5 * 60_000

/**
 * 2026-06-17 — small slack added on top of a known cooldown window so we
 * retry just AFTER the provider's window elapses rather than racing the
 * exact boundary (clock skew + the pool's `cooldown_until` is a lower
 * bound). 1s is negligible against a 60s+ cooldown.
 */
const COOLDOWN_WAIT_SLACK_MS = 1_000

export interface StartImportInput {
  project_slug: string
  /**
   * ISSUES #2 (2026-05-19) — onboarding_state PK is composite. Threaded
   * here so the runner can stamp it on emitted events / future per-user
   * lookups. The runner itself doesn't key by user_id today (project_slug
   * uniquely scopes the per-project DB), but the field is preserved on
   * `StartImportInput` for the engine → runner contract symmetry.
   */
  user_id: string
  source: ImportSource
  payload: ChunkerInput
}

interface ImportJobRow {
  job_id: string
  project_slug: string
  source: string
  status: string
  dollars_spent: number
  pass1_chunks_done: number
  pass1_chunks_total: number
  /**
   * 2026-05-22 — `chunks_total_known` column added by migration 0039.
   * Stored as `INTEGER NOT NULL DEFAULT 0` (0/1); the loader converts to
   * the public boolean shape on `ImportJob.chunks_total_known`.
   */
  chunks_total_known: number
  started_at: number
  completed_at: number | null
  error_code: string | null
  error_message: string | null
  /**
   * Argus r1 (PR #271) — column added by migration 0041. Nullable;
   * `markRateLimitPaused` is the only writer (stamps `this.now()` when
   * the backoff schedule exhausts). Used by the engine's cron-driven
   * resume to apply COOLDOWN_AFTER_PAUSED_MS before dispatching a
   * fresh `runner.start(...)`.
   */
  last_paused_at: number | null
  /**
   * v0.1.85 (2026-05-23) — per-job Pass-1 chunk-target-tokens (column
   * added by migration 0044). Nullable: legacy rows that predate the
   * runner stamp have NULL, and the loader leaves
   * `ImportJob.chunk_target_tokens` undefined. New rows always write the
   * value the runner computed at job-start time (4096 for Max OAuth,
   * 50_000 otherwise) so operators can grep journald / sqlite for which
   * code path each import ran under.
   */
  chunk_target_tokens: number | null
  /**
   * 2026-06-17 (import-analysis-completeness) — wall-clock unix-ms the
   * soonest credential cooldown is expected to lift; written while the
   * runner sleeps inside a known cooldown window, cleared on recovery /
   * pause. Column added by migration 0076. Nullable.
   */
  cooldown_resume_at: number | null
}

interface ImportResultRow {
  job_id: string
  project_slug: string
  source: string
  projects_json: string
  tasks_json: string
  topics_json: string
  reminders_json: string
  entities_json: string
  voice_signals_json: string
  facts_json: string
  finalized_at: number
  partial: number
  inferred_interests_json: string
  confidence_by_inference_json: string
  conversation_count: number | null
  synthesizer_model: string | null
}

interface Pass1ChunkRow {
  chunk_hash: string
  candidate_entities_json: string
  candidate_topics_json: string
  candidate_tasks_json: string
  voice_signals_json: string
  dollars_billed: number
}

/**
 * v0.1.78 — outcome of a single `retryWith429` invocation.
 *
 * - `success`: the wrapped call returned a value within the retry budget.
 * - `rate_limited_exhausted`: every attempt in the schedule threw a 429-
 *   shaped error. Caller MUST flip the job to `rate_limit_paused` and
 *   return without finalizing (state is preserved on disk for resume).
 * - `non_retryable`: the wrapped call threw something that's NOT a 429.
 *   Caller decides whether this is fatal (Pass-2 error → job=failed) or
 *   recoverable (Pass-1 single chunk → degraded result, continue).
 * - `cancelled`: the runner observed `isCancelled()` between backoff
 *   chunks. Caller MUST return from `run()` immediately so the cancel
 *   status persists.
 */
type RetryOutcome<T> =
  | { kind: 'success'; value: T }
  | { kind: 'rate_limited_exhausted'; lastError: unknown; attempts: number }
  | { kind: 'non_retryable'; error: unknown }
  | { kind: 'cancelled' }

export class ImportJobRunner {
  private readonly db: ProjectDb
  private readonly pass1: Pass1LlmCall
  private readonly pass2: Pass2LlmCall
  private readonly pass1Prompt: string
  private readonly pass2Prompt: string
  private readonly parse: SourceParser
  private readonly chunkOptions: {
    target_tokens?: number
    min_user_content_chars?: number
    enable_skip_llm?: boolean
  }
  private readonly uuid: () => string
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly rateLimitBackoffMs: ReadonlyArray<number>
  private readonly getCurrentCredentialKind: CredentialKindResolver | undefined
  /** 2026-05-31 — Pass-1 worker-pool fan-out (default 3). See deps doc. */
  private readonly pass1Concurrency: number
  /**
   * 2026-05-25 (import-pipeline-resilience sprint, Bug D) — optional
   * entity-populator wiring. When all three are present the runner
   * fans the persisted ImportResult through `populateEntitiesFromImport`
   * on the completed + partial paths. When any is undefined the
   * populator no-ops.
   */
  private readonly ownerDataDir: string | undefined
  private readonly writeEntity: WriteEntityFn | undefined
  private readonly gbrainSyncHook: SyncHook | undefined
  /** Test hook — resolved when the most recently-started job finishes. */
  private inflight: Map<string, Promise<void>> = new Map()

  constructor(deps: ImportJobRunnerDeps) {
    this.db = deps.db
    this.pass1 = deps.pass1
    this.pass2 = deps.pass2
    this.pass1Prompt = deps.pass1Prompt
    this.pass2Prompt = deps.pass2Prompt
    this.parse = deps.parse
    this.chunkOptions = deps.chunkOptions ?? {}
    this.uuid = deps.uuid ?? randomUUID
    this.now = deps.now ?? ((): number => Date.now())
    this.sleep =
      deps.sleep ??
      ((ms: number): Promise<void> =>
        new Promise((resolve) => setTimeout(resolve, ms)))
    this.rateLimitBackoffMs =
      deps.rateLimitBackoffMs ?? RATE_LIMIT_BACKOFF_MS_DEFAULT
    this.getCurrentCredentialKind = deps.getCurrentCredentialKind
    this.pass1Concurrency = Math.max(
      1,
      typeof deps.pass1Concurrency === 'number' && Number.isFinite(deps.pass1Concurrency)
        ? Math.floor(deps.pass1Concurrency)
        : 1,
    )
    this.ownerDataDir = deps.ownerDataDir
    this.writeEntity = deps.writeEntity
    this.gbrainSyncHook = deps.gbrainSyncHook
  }

  /**
   * Kick off a new import job. Returns the `job_id` immediately; the
   * actual run happens in the background. Tests can `await
   * runner.awaitJob(job_id)` to deterministically synchronize.
   */
  async start(input: StartImportInput): Promise<{ job_id: string }> {
    const job_id = this.uuid()
    const now = this.now()
    await this.db.run(
      `INSERT INTO import_jobs
        (job_id, project_slug, source, status, dollars_spent, pass1_chunks_done,
         pass1_chunks_total, chunks_total_known, started_at, completed_at,
         error_code, error_message)
       VALUES (?, ?, ?, 'queued', 0, 0, 0, 0, ?, NULL, NULL, NULL)`,
      [job_id, input.project_slug, input.source, now],
    )
    const promise = this.run(job_id, input).finally(() => {
      this.inflight.delete(job_id)
    })
    this.inflight.set(job_id, promise)
    // Surface unhandled rejections via the awaitJob hook; the promise
    // is intentionally not awaited so `start` stays non-blocking.
    promise.catch(() => undefined)
    return { job_id }
  }

  /** Test seam — block until the named job completes. */
  async awaitJob(job_id: string): Promise<void> {
    const p = this.inflight.get(job_id)
    if (p === undefined) return
    await p
  }

  /** Status poll. Returns null if no such job. */
  async status(job_id: string): Promise<ImportJob | null> {
    const row = this.db
      .raw()
      .query<ImportJobRow, [string]>(
        `SELECT job_id, project_slug, source, status, dollars_spent, pass1_chunks_done,
                pass1_chunks_total, chunks_total_known, started_at, completed_at,
                error_code, error_message, last_paused_at, chunk_target_tokens,
                cooldown_resume_at
           FROM import_jobs WHERE job_id = ?`,
      )
      .get(job_id)
    if (row === null) return null
    const job: ImportJob = {
      job_id: row.job_id,
      project_slug: row.project_slug,
      source: row.source as ImportSource,
      status: row.status as ImportJobStatus,
      dollars_spent: row.dollars_spent,
      pass1_chunks_done: row.pass1_chunks_done,
      pass1_chunks_total: row.pass1_chunks_total,
      chunks_total_known: row.chunks_total_known === 1,
      started_at: row.started_at,
    }
    if (row.completed_at !== null) job.completed_at = row.completed_at
    if (row.error_code !== null) {
      job.error_code = row.error_code as Exclude<ImportJob['error_code'], undefined>
    }
    if (row.error_message !== null) job.error_message = row.error_message
    if (row.last_paused_at !== null) job.last_paused_at = row.last_paused_at
    if (row.chunk_target_tokens !== null) {
      job.chunk_target_tokens = row.chunk_target_tokens
    }
    // 2026-06-17 (import-analysis-completeness) — surface the cooldown
    // resume window + derive the `waiting_on_cooldown` phase for the
    // progress UI. The phase fires only while the job is actively cooling
    // off AND a known future resume time is stamped; a stale resume time
    // (already elapsed) collapses to the plain cooling-off UX.
    if (row.cooldown_resume_at !== null) {
      job.cooldown_resume_at = row.cooldown_resume_at
      if (
        row.status === 'rate_limit_cooling_off' &&
        row.cooldown_resume_at > this.now()
      ) {
        job.phase = 'waiting_on_cooldown'
      }
    }
    // Surface persisted partial results on terminal states.
    if (
      row.status === 'completed' ||
      row.status === 'failed' ||
      row.status === 'rate_limit_paused'
    ) {
      const result = await this.loadResult(job_id)
      if (result !== null) {
        job.result = result.result
        job.partial = result.partial
        if (
          row.status === 'completed' &&
          !result.partial &&
          job.result.synthesizer_model === undefined
        ) {
          job.result.synthesizer_model = BEST_MODEL
        }
      }
    }
    return job
  }

  /** Mark a job cancelled. Inflight chunks finish; no new ones start. */
  async cancel(job_id: string): Promise<void> {
    const now = this.now()
    await this.db.run(
      `UPDATE import_jobs
         SET status = 'cancelled', completed_at = ?, error_code = 'cancelled'
       WHERE job_id = ? AND status IN (
         'queued', 'pass1-running', 'pass2-running',
         'rate_limit_cooling_off', 'rate_limit_paused'
       )`,
      [now, job_id],
    )
  }

  /**
   * v0.1.78 — synthesize-on-demand. The engine no longer surfaces a
   * "stop now, use partial" button (the budget-warning UX was removed),
   * but the helper stays in case a future flow re-introduces it (e.g.
   * the user manually skips a stuck `rate_limit_paused` job and wants
   * to salvage whatever Pass-1 cache landed).
   *
   * Returns null when there's nothing to synthesize (no finalized
   * Pass-1 chunks for this (instance, source) — see ISSUES #91 below for why
   * the cache is scoped by the dedup key, not `job_id`). Persists with
   * `partial=true`.
   */
  async synthesizeOnDemand(
    job_id: string,
    opts: { preferDegraded?: boolean } = {},
  ): Promise<ImportResult | null> {
    const job = await this.status(job_id)
    if (job === null) return null
    // ISSUES #91 (Argus/Codex r1 BLOCKER) — salvage the FULL Pass-1 cache for
    // this (instance, source), NOT just the rows stamped with `job_id`.
    //
    // The auto-resume loop creates a fresh `job_id` per `runner.start` cycle,
    // but cached chunks are dedup-keyed by `(project_slug, source, chunk_hash)`
    // and stay stamped with whichever job FIRST analyzed them (claimChunk sets
    // job_id once; finalizePass1Chunk never rewrites it, and a resume's
    // fetchPass1Cached reuse is read-only). So under sustained 429 the
    // signal-bearing chunks live under the ORIGINAL job's id while the LATEST
    // resumed job (the one `degradeRateLimitExhausted` passes here) analyzed
    // ZERO chunks before re-exhausting. Filtering by that job_id returned no
    // rows → the salvage discarded the cached signal and the user still got
    // the hard "couldn't analyze" — exactly the prod symptom this sprint
    // closes. Scoping by the dedup key surfaces every chunk the lineage ever
    // analyzed, regardless of which resume cycle stamped it.
    const rows = this.db
      .raw()
      .query<Pass1ChunkRow, [string, string]>(
        `SELECT chunk_hash, candidate_entities_json, candidate_topics_json,
                candidate_tasks_json, voice_signals_json, dollars_billed
           FROM import_pass1_chunks
          WHERE project_slug = ? AND source = ? AND analyzed = 1`,
      )
      .all(job.project_slug, job.source)
    if (rows.length === 0) return null
    const pass1Results: Pass1ChunkResult[] = rows.map((r) => ({
      chunk_hash: r.chunk_hash,
      candidate_entities: JSON.parse(r.candidate_entities_json) as Pass1ChunkResult['candidate_entities'],
      candidate_topics: JSON.parse(r.candidate_topics_json) as Pass1ChunkResult['candidate_topics'],
      candidate_tasks: JSON.parse(r.candidate_tasks_json) as Pass1ChunkResult['candidate_tasks'],
      voice_signals: JSON.parse(r.voice_signals_json) as Pass1ChunkResult['voice_signals'],
      dollars_billed: 0,
    }))
    // Argus r1 — sort by chunk_hash before aggregation. The SELECT above
    // has no ORDER BY; SQLite is free to return rows in any internal
    // order, which would leak into aggregatePass1's tie behavior. See
    // the main worker-pool call site for the full rationale.
    pass1Results.sort((a, b) =>
      a.chunk_hash < b.chunk_hash ? -1 : a.chunk_hash > b.chunk_hash ? 1 : 0,
    )
    const aggregated = aggregatePass1(pass1Results)

    // 2026-06-01 (fix synthesizeOnDemand → real Pass-2; Codex r1 fixes) —
    // run the REAL Pass-2 LLM over the cached aggregated signal so a
    // salvaged partial carries real projects + interests +
    // synthesizer_model instead of the blank `degradedFromAggregated`
    // stub (which hardcodes `proposed_projects: []` and never sets
    // `inferred_interests`, leaving the user with a blank "(Based on N
    // conversations.)" template). `degradedFromAggregated` is now ONLY
    // the last-resort fallback when Pass-2 itself throws.
    //
    // We do a SINGLE Pass-2 attempt here — deliberately NOT wrapped in
    // `retryWith429` — for two reasons rooted in the SOLE caller (the
    // engine hard-timeout path, `engine.ts:advanceFromImportRunning`):
    //   1. Money-burn. The caller cancels the original runner immediately
    //      BEFORE invoking us, but that runner's in-flight Pass-1 workers
    //      only stop at their next `isCancelled` poll. A multi-minute
    //      `retryWith429` backoff window here would keep that drain alive
    //      far longer than the one Pass-2 call's worth of overlap a
    //      single attempt costs. The whole point of the hard-timeout is
    //      to STOP burning money (Sam's 2026-05-25 $0.27-post-timeout
    //      incident).
    //   2. Cancel-awareness. `retryWith429` short-circuits to
    //      `{kind:'cancelled'}` the moment `isCancelled(job_id)` is true
    //      — and the caller has already cancelled the job — so it would
    //      return null and salvage NOTHING from the cache. A direct call
    //      has no such guard, so it synthesizes the cancelled job's
    //      cached signal as intended.
    //
    // This is the ON_DEMAND path: we NEVER call `markRateLimitPaused` /
    // `setStatusIfNotCancelled` against the job — the caller owns the
    // job's lifecycle. On any Pass-2 throw (429 OR non-retryable) we log
    // an operator-greppable journald line and fall back to the no-LLM
    // aggregated stub so the user still sees SOME signal.
    let result: ImportResult
    let dollarsBilled = 0
    if (opts.preferDegraded === true) {
      // Codex r2 P2 — the caller (engine hard-timeout) observed the job
      // already in `pass2-running`: the original runner's Pass-2 is in
      // flight and its spend is unavoidable. Degrade from cache here
      // rather than paying for a SECOND Pass-2 over the same rows.
      // eslint-disable-next-line no-console
      console.warn(
        `[import] synthesize_on_demand_degraded_fallback job=${job_id} ` +
          `project=${job.project_slug} source=${job.source} ` +
          `reason=pass2_already_in_flight`,
      )
      result = degradedFromAggregated(aggregated)
    } else {
      try {
        const out = await pass2Synthesize(
          aggregated,
          { llm: this.pass2, prompt: this.pass2Prompt },
          job.source,
        )
        result = out.result
        dollarsBilled = out.dollars_billed
        // Partial run over however many Pass-1 chunks reached the cache —
        // stamp the honest count (parsePass2Result already does, but be
        // explicit). `synthesizer_model` is stamped inside pass2Synthesize
        // and flows through persistResult.
        if (aggregated.totals.chunks > 0) {
          result.conversation_count = aggregated.totals.chunks
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `[import] synthesize_on_demand_degraded_fallback job=${job_id} ` +
            `project=${job.project_slug} source=${job.source} ` +
            `reason=${extractErrorMessage(err)}`,
        )
        result = degradedFromAggregated(aggregated)
      }
    }

    await this.persistResult(job_id, job.project_slug, job.source, result, /*partial*/ true)
    // Record the real Pass-2 spend on the job's billing ledger. This is a
    // counter increment, NOT a lifecycle/status mutation, so it's safe on
    // an already-cancelled/paused row; `accumulateDollarsSpent` no-ops on
    // 0 (the degraded path bills nothing).
    await this.accumulateDollarsSpent(job_id, dollarsBilled)
    await this.runEntityPopulator(job_id, job.project_slug, job.source, result)
    return result
  }

  /**
   * 2026-05-25 (import-pipeline-resilience sprint, Part C) — public
   * alias for `synthesizeOnDemand`. The sprint brief named this method
   * `synthesizePartial`; the existing engine deps surface still uses
   * `synthesizeOnDemand` (added pre-sprint and stubbed across 10 test
   * harnesses), so we keep both names live. Both return the same
   * `Partial<ImportResult>`-shaped synthesis from cached Pass-1 rows.
   */
  async synthesizePartial(
    job_id: string,
    opts: { preferDegraded?: boolean } = {},
  ): Promise<ImportResult | null> {
    return await this.synthesizeOnDemand(job_id, opts)
  }

  private async loadResult(
    job_id: string,
  ): Promise<{ result: ImportResult; partial: boolean } | null> {
    const row = this.db
      .raw()
      .query<ImportResultRow, [string]>(
        `SELECT job_id, project_slug, source, projects_json, tasks_json, topics_json,
                reminders_json, entities_json, voice_signals_json, facts_json,
                finalized_at, partial,
                inferred_interests_json, confidence_by_inference_json,
                conversation_count, synthesizer_model
           FROM import_results WHERE job_id = ?`,
      )
      .get(job_id)
    if (row === null) return null
    const result: ImportResult = {
      entities: JSON.parse(row.entities_json) as ImportResult['entities'],
      topics: JSON.parse(row.topics_json) as ImportResult['topics'],
      proposed_projects: JSON.parse(row.projects_json) as ImportResult['proposed_projects'],
      proposed_tasks: JSON.parse(row.tasks_json) as ImportResult['proposed_tasks'],
      proposed_reminders: JSON.parse(row.reminders_json) as ImportResult['proposed_reminders'],
      voice_signals: JSON.parse(row.voice_signals_json) as ImportResult['voice_signals'],
      facts: JSON.parse(row.facts_json) as ImportResult['facts'],
    }
    try {
      const interests = JSON.parse(row.inferred_interests_json) as unknown
      if (Array.isArray(interests) && interests.length > 0) {
        result.inferred_interests = interests as NonNullable<ImportResult['inferred_interests']>
      }
    } catch {
      // legacy row with malformed column — skip
    }
    try {
      const confidence = JSON.parse(row.confidence_by_inference_json) as unknown
      if (Array.isArray(confidence) && confidence.length > 0) {
        result.confidence_by_inference =
          confidence as NonNullable<ImportResult['confidence_by_inference']>
      }
    } catch {
      // skip
    }
    if (typeof row.conversation_count === 'number' && row.conversation_count > 0) {
      ;(result as ImportResult & { conversation_count?: number }).conversation_count =
        row.conversation_count
    }
    if (typeof row.synthesizer_model === 'string' && row.synthesizer_model.length > 0) {
      result.synthesizer_model = row.synthesizer_model
    }
    return { result, partial: row.partial === 1 }
  }

  private async run(job_id: string, input: StartImportInput): Promise<void> {
    const { project_slug, source, payload } = input
    try {
      // Re-check cancel state at every loop top so a `cancel()` mid-run
      // actually stops launching new chunks.
      if (await this.isCancelled(job_id)) return
      const flipped = await this.setStatusIfNotCancelled(job_id, 'pass1-running')
      if (!flipped) return

      // v0.1.85 (2026-05-23) — derive the per-job Pass-1 chunk target
      // from the resolved credential kind BEFORE chunking. Max OAuth
      // (Bearer auth) needs the 4096 target to stay under Anthropic's
      // predictive rate-limit gate; everything else keeps the 50K
      // default. Persist the value on the row + emit a single journald
      // line so operators can grep which path each import ran under.
      const effectiveChunkOptions = await this.resolveEffectiveChunkOptions(
        job_id,
        project_slug,
        source,
      )

      // 2026-05-22 (import-progress UX fix) — pre-count the entire chunk
      // list BEFORE the per-chunk loop so `pass1_chunks_total` is stable
      // and the user sees real progress.
      //
      // 2026-05-31 — also drain the streaming-fallback path into an
      // array so the worker pool below can index it. Streaming + parallel
      // are mutually exclusive shapes; the brief picks "always
      // materialize" because (a) the typical case ALREADY pre-counts and
      // (b) the giant-export edge case where pre-count throws on
      // parse-error is so rare in production it's acceptable to buffer
      // chunks in memory after a single recovery.
      let chunkArray: Chunk[]
      let chunksTotalKnown = false
      try {
        const preCounted: Chunk[] = []
        for await (const c of chunkConversations(
          this.parse(source, payload),
          effectiveChunkOptions,
        )) {
          preCounted.push(c)
          if (await this.isCancelled(job_id)) return
        }
        chunkArray = preCounted
        chunksTotalKnown = true
        await this.persistChunksTotalKnown(job_id, preCounted.length, true)
      } catch (preCountErr) {
        // eslint-disable-next-line no-console
        console.warn(
          `[import] pre-count failed for job=${job_id} source=${source}: ${
            preCountErr instanceof Error ? preCountErr.message : String(preCountErr)
          }; falling back to streaming mode (in-memory drain for parallel pool)`,
        )
        const streamed: Chunk[] = []
        try {
          for await (const c of chunkConversations(
            this.parse(source, payload),
            effectiveChunkOptions,
          )) {
            streamed.push(c)
            if (await this.isCancelled(job_id)) return
          }
        } catch (streamErr) {
          // Both pre-count and the streaming fallback failed → propagate
          // so the outer catch flips the job to failed with the source-
          // parser error_code. Preserves pre-2026-05-31 behaviour shape.
          throw streamErr
        }
        chunkArray = streamed
        // chunks_total_known stays false to preserve the legacy
        // streaming-fallback body shape ("N batches processed").
      }

      const chunksTotal = chunkArray.length
      const pass1Results: Pass1ChunkResult[] = []
      let chunksDone = 0
      let pass2Error: { code: string; message: string } | null = null

      // 2026-05-31 — N-worker pool fan-out for Pass-1. Default
      // concurrency 1 since 2026-06-17 (was 3) — one warm `claude` session,
      // sequential chunks (overridden via `pass1Concurrency` constructor
      // dep + the gateway composer's `NEUTRON_IMPORT_PASS1_CONCURRENCY`
      // env var). JS event-loop single-threading makes `nextIdx++` and
      // `chunksDone++` atomic from app-code's POV — no locks needed.
      // Workers exit cleanly on:
      //   - cancellation (per-iteration cancel poll)
      //   - rate_limit_exhausted (first worker that hits it flips the
      //     `paused` flag + marks the job paused; siblings observe
      //     the flag at the top of the next iteration)
      //   - any thrown ImportError bubbles via `fatalError`; the outer
      //     catch marks the job failed
      const concurrency = chunkArray.length === 0
        ? 0
        : Math.min(this.pass1Concurrency, chunkArray.length)
      let nextIdx = 0
      let paused = false
      let cancelledByWorker = false
      let fatalError: unknown = null

      // 2026-05-31 — processOne returns `true` when the chunk landed
      // a real Pass-1 result (cached / skipped / synthesized / degraded)
      // and the worker should count it toward chunksDone. Returns
      // `false` when the chunk exited without producing a result —
      // cancelled mid-pipeline OR rate-limited-exhausted OR another
      // worker re-claimed the row during a steal race. Codex r2 fix:
      // the v1 of the worker unconditionally incremented chunksDone
      // after every processOne, which inflated `pass1_chunks_done`
      // toward `pass1_chunks_total` on cancel / pause and let the
      // engine's "done >= total" heuristic mis-classify a paused job
      // as Pass-2.
      const processOne = async (chunk: Chunk): Promise<boolean> => {
        if (await this.isCancelled(job_id)) {
          cancelledByWorker = true
          return false
        }
        // 2026-05-31 — skip_llm fast path. The chunker stamps this
        // when the chunk's non-assistant content fell under
        // MIN_USER_CONTENT_CHARS. Persist an empty placeholder so
        // the chunk-hash dedup row lands, charge $0, no LLM call.
        if (chunk.skip_llm === true) {
          const result: Pass1ChunkResult = {
            chunk_hash: chunk.chunk_hash,
            candidate_entities: [],
            candidate_topics: [],
            candidate_tasks: [],
            voice_signals: {},
            dollars_billed: 0,
          }
          // Claim row first so concurrent re-imports observe the same
          // hash → cache hit instead of re-skipping.
          const claimed = await this.claimChunk(job_id, project_slug, source, chunk)
          if (claimed) {
            await this.finalizePass1Chunk(project_slug, source, chunk, result)
          } else {
            // Lost the race — read whatever the winning worker / prior
            // job persisted. If still in flight, fall back to our empty
            // placeholder for aggregation.
            const winner = await this.awaitClaimedFinalize(
              project_slug,
              source,
              chunk.chunk_hash,
            )
            if (winner !== null) {
              pass1Results.push(winner)
              return true
            }
          }
          // eslint-disable-next-line no-console
          console.info(
            `[import] job=${job_id} chunk=${chunk.chunk_hash.slice(0, 12)} ` +
              `skip_llm=true reason=insufficient_user_content user_chars=${chunk.skip_llm_user_chars ?? 0}`,
          )
          pass1Results.push(result)
          return true
        }

        // Idempotency dedup — scoped by (project_slug, source, chunk_hash)
        const cached = this.fetchPass1Cached(project_slug, source, chunk.chunk_hash)
        if (cached !== null) {
          // Item 4 (migration 0063) — a cache-hit row from a PRE-retention
          // import carries no raw text (the discard already happened).
          // The re-import has the text in hand right here; backfill it so
          // retention repopulates at $0 LLM cost. No-op on post-retention
          // rows (chunk_text IS NULL guard).
          await this.backfillChunkText(project_slug, source, chunk)
          pass1Results.push(cached)
          return true
        }
        // Claim the chunk via INSERT-or-skip BEFORE the LLM call so two
        // concurrent workers (same job OR cross-job re-imports) for
        // the same (instance, source, chunk_hash) don't both burn an
        // LLM call.
        const claimed = await this.claimChunk(job_id, project_slug, source, chunk)
        if (!claimed) {
          const winnerResult = await this.awaitClaimedFinalize(
            project_slug,
            source,
            chunk.chunk_hash,
          )
          if (winnerResult !== null) {
            pass1Results.push(winnerResult)
            return true
          }
          // Winner timed out; steal the placeholder + re-claim.
          await this.db.run(
            `DELETE FROM import_pass1_chunks
              WHERE project_slug = ? AND source = ? AND chunk_hash = ? AND analyzed = 0`,
            [project_slug, source, chunk.chunk_hash],
          )
          const reClaimed = await this.claimChunk(job_id, project_slug, source, chunk)
          if (!reClaimed) {
            // Some other worker re-claimed in between; this chunk will
            // land via the winner — DON'T count toward chunksDone here
            // (the winner will count it when it lands).
            return false
          }
        }

        // v0.1.78 — wrap Pass-1 in retryWith429. Pre-v0.1.78 a 429 on
        // Pass-1 fell through to the degraded path (silent empty
        // result + log warning), so a single rate-limit mid-import
        // could silently drop every subsequent chunk's analysis. Now
        // we sleep + retry up to the full backoff schedule before
        // either succeeding or marking the whole job paused.
        //
        // Codex r3 (2026-05-31, post-parallel-pool) — `shouldAbort:
        // () => paused` makes sibling workers that are deep inside
        // their own retry schedule observe the shared `paused` flag
        // set by the first worker that exhausted. Without this hook
        // 3 concurrent workers in a sustained-429 scenario would each
        // walk their full 30-attempt backoff schedule independently
        // (≈3× the intended retry calls), further hammering the
        // owner's rate-limit window after the job is already
        // unrecoverable.
        const pass1Outcome = await this.retryWith429(
          () => pass1Triage(chunk, { llm: this.pass1, prompt: this.pass1Prompt }),
          job_id,
          'pass1',
          () => paused,
        )
        if (pass1Outcome.kind === 'cancelled') {
          // Argus r1 (2026-05-31) — mirror the rate_limited_exhausted
          // branch's dropPlaceholder. retryWith429 returns 'cancelled'
          // when the shouldAbort callback (`() => paused`) flips mid-
          // sleep — i.e. a sibling worker hit rate-limit exhaustion
          // and marked the job paused. Without this drop the
          // placeholder row claimed at line 768 (analyzed=0,
          // job_id=current) sits orphaned in import_pass1_chunks. On
          // the next resume, awaitClaimedFinalize burns its full
          // 30 × 200ms = 6s poll for every stale row before stealing
          // it — multiplied across however many siblings hit the abort
          // mid-flight. Best-effort: any throw here is logged + swallowed
          // by dropPlaceholder.
          await this.dropPlaceholder(project_slug, source, chunk.chunk_hash, job_id)
          cancelledByWorker = true
          return false
        }
        if (pass1Outcome.kind === 'rate_limited_exhausted') {
          // First worker to reach exhaustion takes ownership of the
          // pause flip; siblings simply observe `paused` at the next
          // iteration and exit. Drop only THIS chunk's placeholder so
          // future resumes re-process it; cached completed chunks stay
          // in `import_pass1_chunks` for $0 reuse.
          if (!paused) {
            paused = true
            await this.dropPlaceholder(project_slug, source, chunk.chunk_hash, job_id)
            await this.markRateLimitPaused(
              job_id,
              'pass1',
              extractErrorMessage(pass1Outcome.lastError),
            )
          } else {
            // Sibling already marked paused — best-effort drop our own
            // placeholder so the future resume can re-process this
            // chunk too.
            await this.dropPlaceholder(project_slug, source, chunk.chunk_hash, job_id)
          }
          return false
        }
        // Restore status to pass1-running in case retryWith429 flipped
        // it to rate_limit_cooling_off during the inner loop.
        await this.setStatusIfNotCancelled(job_id, 'pass1-running')

        if (pass1Outcome.kind === 'success') {
          const result = pass1Outcome.value
          await this.finalizePass1Chunk(project_slug, source, chunk, result)
          await this.accumulateDollarsSpent(job_id, result.dollars_billed)
          pass1Results.push(result)
          return true
        }
        // Non-retryable error.
        if (
          pass1Outcome.error instanceof ImportError &&
          pass1Outcome.error.code === 'llm_unwired'
        ) {
          // Configuration gap → bubble so the outer catch marks the
          // whole job 'failed'. Best-effort cleanup first.
          try {
            await this.dropPlaceholder(project_slug, source, chunk.chunk_hash, job_id)
          } catch {
            /* best-effort */
          }
          throw pass1Outcome.error
        }
        // Transient per-chunk failure: persist a degraded row, charge
        // $0, and proceed. One bad chunk doesn't kill an otherwise-
        // healthy job.
        const degraded: Pass1ChunkResult = {
          chunk_hash: chunk.chunk_hash,
          candidate_entities: [],
          candidate_topics: [],
          candidate_tasks: [],
          voice_signals: {},
          dollars_billed: 0,
        }
        await this.finalizePass1Chunk(project_slug, source, chunk, degraded)
        // NOTE: pre-2026-05-31 the sequential loop did NOT push the
        // degraded row into pass1Results — only its bumpProgress side
        // effect ran. Preserving that shape: aggregation only sees
        // successful chunks; the degraded row exists in
        // `import_pass1_chunks` for the next resume to reuse. The
        // degraded chunk DID land a row to disk — count it as done.
        return true
      }

      const worker = async (): Promise<void> => {
        while (true) {
          if (cancelledByWorker || paused || fatalError !== null) return
          if (await this.isCancelled(job_id)) {
            cancelledByWorker = true
            return
          }
          const idx = nextIdx
          nextIdx += 1
          if (idx >= chunkArray.length) return
          const chunk = chunkArray[idx]!
          let progressed = false
          try {
            progressed = await processOne(chunk)
          } catch (err) {
            // Capture the first fatal — siblings observe via the flag
            // and exit; the outer catch handles re-throw with the
            // appropriate code mapping.
            if (fatalError === null) fatalError = err
            return
          }
          if (progressed) {
            chunksDone += 1
            await this.bumpProgress(job_id, chunksDone, chunksTotal)
          }
        }
      }

      if (concurrency > 0) {
        const workers = Array.from({ length: concurrency }, () => worker())
        await Promise.all(workers)
      }

      if (fatalError !== null) throw fatalError
      if (cancelledByWorker) {
        await this.bumpProgress(job_id, chunksDone, chunksTotal)
        return
      }
      if (paused) {
        await this.bumpProgress(job_id, chunksDone, chunksTotal)
        return
      }

      await this.bumpProgress(job_id, chunksDone, chunksTotal)
      if (await this.isCancelled(job_id)) return

      const flipPass2 = await this.setStatusIfNotCancelled(job_id, 'pass2-running')
      if (!flipPass2) return

      // Argus r1 (2026-05-31, post-parallel-pool) — sort by chunk_hash
      // before aggregation so the parallel pool's completion-order
      // pushes don't leak nondeterminism into `aggregatePass1`.
      // aggregatePass1 has order-dependent tie behavior in five places
      // (entity name capitalization on equal-length ties, topic summary
      // cap at 5 in arrival order, task dedup by lowercased title,
      // pickMostFrequent voice-signal tie resolution, entity top-50
      // slice when ties land at the boundary). The sequential
      // pre-2026-05-31 loop walked the chunk array in source order and
      // was deterministic by construction; the worker pool pushes each
      // result as its LLM call returns. Pass1ChunkResult.chunk_hash is
      // sha256(conversation_id + ':' + chunk_index + ':' + chunk_bytes)
      // — uniquely identifies the chunk + stable across runs, so a
      // lexicographic sort gives byte-identical aggregation input on
      // every run regardless of which worker finishes first.
      const sortedPass1Results = [...pass1Results].sort((a, b) =>
        a.chunk_hash < b.chunk_hash ? -1 : a.chunk_hash > b.chunk_hash ? 1 : 0,
      )
      const aggregated = aggregatePass1(sortedPass1Results)
      let importResult: ImportResult = degradedFromAggregated(aggregated)

      if (pass1Results.length === 0) {
        // No analyzable chunks landed. Two reasons we can reach this:
        //   (a) chunksTotal===0 — legitimately empty parse → completed
        //   (b) chunksTotal>0 yet every chunk hit the degraded branch
        //       → mark `failed` with `pass1_all_failed` so the engine's
        //       failed-sub_step UX fires.
        let finalStatus: ImportJobStatus
        let failureCode: string | null = null
        let failureMessage: string | null = null
        if (chunksTotal === 0) {
          finalStatus = 'completed'
        } else {
          finalStatus = 'failed'
          failureCode = 'pass1_all_failed'
          failureMessage =
            'Every Pass-1 chunk failed before producing analyzable signal. ' +
            'No entities were extracted.'
        }
        await this.persistResult(
          job_id,
          project_slug,
          source,
          importResult,
          finalStatus === 'failed',
        )
        if (finalStatus === 'completed') {
          await this.runEntityPopulator(job_id, project_slug, source, importResult)
        }
        const now = this.now()
        if (finalStatus === 'failed') {
          await this.db.run(
            `UPDATE import_jobs
               SET status = 'failed', completed_at = ?, error_code = ?, error_message = ?
             WHERE job_id = ?`,
            [now, failureCode, failureMessage, job_id],
          )
        } else {
          await this.db.run(
            `UPDATE import_jobs SET status = ?, completed_at = ? WHERE job_id = ?`,
            [finalStatus, now, job_id],
          )
        }
        return
      }

      // v0.1.78 — Pass-2 wrapped in retryWith429 with the SAME schedule
      // as Pass-1 (replaces the prior [0, 5s, 15s, 45s] 4-attempt-only
      // schedule). The runner persists `rate_limit_cooling_off` between
      // attempts so the engine's poll renders the cooling-off bubble.
      const pass2Outcome = await this.retryWith429(
        () =>
          pass2Synthesize(
            aggregated,
            { llm: this.pass2, prompt: this.pass2Prompt },
            source,
          ),
        job_id,
        'pass2',
      )

      if (pass2Outcome.kind === 'cancelled') {
        return
      }
      if (pass2Outcome.kind === 'rate_limited_exhausted') {
        // Persist the aggregated-only partial result so a future
        // resume / status poll can surface what we got from Pass-1.
        importResult = degradedFromAggregated(aggregated)
        await this.persistResult(job_id, project_slug, source, importResult, /*partial*/ true)
        await this.runEntityPopulator(job_id, project_slug, source, importResult)
        await this.markRateLimitPaused(
          job_id,
          'pass2',
          extractErrorMessage(pass2Outcome.lastError),
        )
        return
      }
      if (pass2Outcome.kind === 'non_retryable') {
        const err = pass2Outcome.error
        pass2Error = {
          code: err instanceof ImportError ? err.code : 'substrate_error',
          message: err instanceof Error ? err.message : String(err),
        }
        importResult = degradedFromAggregated(aggregated)
      } else {
        // success
        const out = pass2Outcome.value
        importResult = out.result
        await this.accumulateDollarsSpent(job_id, out.dollars_billed)
        // Restore pass2-running so the post-loop persist below sees a
        // sensible non-cooling status (and so a final cancel race
        // doesn't observe rate_limit_cooling_off and mis-route).
        await this.setStatusIfNotCancelled(job_id, 'pass2-running')
      }

      if (await this.isCancelled(job_id)) return

      const partial = pass2Error !== null
      await this.persistResult(job_id, project_slug, source, importResult, partial)
      await this.runEntityPopulator(job_id, project_slug, source, importResult)

      const now = this.now()
      if (pass2Error !== null) {
        await this.db.run(
          `UPDATE import_jobs
             SET status = 'failed', completed_at = ?, error_code = ?, error_message = ?
           WHERE job_id = ?`,
          [now, pass2Error.code, pass2Error.message, job_id],
        )
        return
      }
      await this.db.run(
        `UPDATE import_jobs SET status = 'completed', completed_at = ? WHERE job_id = ?`,
        [now, job_id],
      )
    } catch (err) {
      const code = err instanceof ImportError ? err.code : 'substrate_error'
      const msg = err instanceof Error ? err.message : String(err)
      const now = this.now()
      await this.db.run(
        `UPDATE import_jobs
           SET status = 'failed', completed_at = ?, error_code = ?, error_message = ?
         WHERE job_id = ?`,
        [now, code, msg, job_id],
      )
    }
  }

  /**
   * Wrap any LLM call (Pass-1 chunk OR Pass-2 synthesis) in the
   * rate-limit retry loop.
   *
   * Why this wrapper still exists under the CC-subprocess substrate.
   * The `claude` subprocess (per
   * `runtime/adapters/claude-code/cli-transport.ts:mapAssistantLine`)
   * parses Anthropic 429 responses, prefixes them with `rate_limit:`,
   * emits a single `Event{kind:'error', retryable:true}`, and exits.
   * It does NOT do cross-invocation retry. This wrapper is the
   * substrate-state-machine bridge that:
   *
   *   1. Drives N subprocess invocations on a `min(60, 5 * 2^attempt)`
   *      schedule (~27 min budget).
   *   2. Persists `import_jobs.status='rate_limit_cooling_off'`
   *      between attempts so the engine's status poll renders a
   *      "still waiting on rate limit" bubble instead of a hard
   *      failure.
   *   3. Persists a human-readable cooling-off message in
   *      `error_message` (cleared on success or non-429 passthrough).
   *   4. Cancellation observability — each backoff sleep is sliced
   *      into 500ms chunks with `isCancelled(job_id)` polled between
   *      slices, so a user cancel mid-sleep returns within ≤500ms
   *      instead of after the full minute wait.
   *   5. Discriminates exhaustion (`rate_limited_exhausted` flips the
   *      job to `rate_limit_paused` so the resume-cron picks it up
   *      after `COOLDOWN_AFTER_PAUSED_MS`) from real non-429
   *      failures (`non_retryable`, surfaced to the caller).
   *
   * Codex r3 (2026-05-31, post-Pass-1-parallel) — `shouldAbort` callback
   * is polled at every cancel-check site (between attempts + between
   * each 500ms sleep slice). When it returns true the loop short-
   * circuits to `{kind:'cancelled'}`. The Pass-1 worker pool passes a
   * `() => paused` callback so sibling workers stuck mid-retry
   * observe the pause flag set by another worker and stop hammering
   * the rate-limit quota with their own retry schedules. Pass-2 omits
   * the callback (single-call path; no sibling state).
   *
   * Outcomes:
   *   - `{kind:'success', value}` on a call that returned within
   *     the retry budget.
   *   - `{kind:'non_retryable', error}` on a non-429 throw. Caller
   *     decides whether this is fatal (Pass-2) or recoverable
   *     (Pass-1 single chunk → degraded result, continue).
   *   - `{kind:'rate_limited_exhausted'}` if every attempt 429s.
   *     Caller MUST flip the job to `rate_limit_paused` and exit.
   *   - `{kind:'cancelled'}` on cancel observed mid-sleep or
   *     between attempts.
   */
  private async retryWith429<T>(
    call: () => Promise<T>,
    job_id: string,
    pass: 'pass1' | 'pass2',
    shouldAbort?: () => boolean,
  ): Promise<RetryOutcome<T>> {
    const schedule = this.rateLimitBackoffMs
    const maxAttempts = schedule.length
    let lastError: unknown = null
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (shouldAbort?.() === true) return { kind: 'cancelled' }
      // 2026-06-17 (import-analysis-completeness) — COOLDOWN = WAIT+RETRY.
      // When the prior failure was an all-credential cooldown that carried
      // the pool's soonest `cooldown_until` (as `retry_after_ms`), wait for
      // that ACTUAL quota-reset window (capped at MAX_COOLDOWN_WAIT_MS,
      // sliced for cancel/abort polling) under the `waiting_on_cooldown`
      // phase, instead of the generic fixed backoff. The chunk is NEVER
      // finalized empty here — we loop and retry the same LLM call until it
      // succeeds or the retry cap (schedule length) is exhausted, at which
      // point the caller marks the job `rate_limit_paused` (resumable at
      // $0). The schedule still governs WHETHER we sleep (attempt 0 is
      // immediate; attempt ≥ 1 sleeps) so the retry cap is unchanged.
      const scheduledDelay = schedule[attempt] ?? 0
      const cooldownResumeAt =
        scheduledDelay > 0 ? extractCooldownResumeAt(lastError, this.now()) : null
      let sleepMs = scheduledDelay
      let isCooldownWait = false
      let resumeAtToStamp = 0
      if (cooldownResumeAt !== null) {
        const rawWait = Math.max(0, cooldownResumeAt + COOLDOWN_WAIT_SLACK_MS - this.now())
        sleepMs = Math.min(rawWait, MAX_COOLDOWN_WAIT_MS)
        if (sleepMs > 0) {
          isCooldownWait = true
          resumeAtToStamp = this.now() + sleepMs
        }
      }
      if (sleepMs > 0) {
        if (isCooldownWait) {
          await this.persistWaitingOnCooldown(
            job_id,
            pass,
            resumeAtToStamp,
            extractErrorMessage(lastError),
          )
        } else {
          await this.setStatusIfNotCancelled(job_id, 'rate_limit_cooling_off')
          await this.persistCoolingOffMessage(
            job_id,
            pass,
            attempt + 1,
            maxAttempts,
            sleepMs,
            extractErrorMessage(lastError),
          )
        }
        const cancelledMidSleep = await this.sleepWithCancelCheck(sleepMs, job_id, shouldAbort)
        if (cancelledMidSleep) return { kind: 'cancelled' }
      }
      if (await this.isCancelled(job_id)) return { kind: 'cancelled' }
      if (shouldAbort?.() === true) return { kind: 'cancelled' }
      try {
        const value = await call()
        // Clear the cooling-off error_message stamp on success so a
        // future status poll doesn't surface a stale "rate-limited"
        // body after the job recovered.
        await this.clearCoolingOffMessage(job_id)
        return { kind: 'success', value }
      } catch (err) {
        lastError = err
        // 2026-06-17 (import-analysis-completeness) — an error that carries
        // a concrete cooldown hint (`retry_after_ms`, threaded up from the
        // substrate's all-credential-cooldown branch) is ALWAYS a retryable
        // cooldown, even if its message text doesn't match the 429 regex.
        // This is the defense-in-depth that guarantees "on cooldown, wait +
        // retry, never skip": message wording can drift, but the structured
        // hint cannot be misread as a permanent failure (which would route
        // the chunk into the degraded empty-finalize branch).
        const hasCooldownHint = extractCooldownResumeAt(err, this.now()) !== null
        if (!is429RetryableError(err) && !hasCooldownHint) {
          // Codex r1 (PR #271 carry-over) — clear the cooling-off
          // error_code/error_message stamp BEFORE handing the failure
          // back to the caller. Without this, a 429 → cool-off → non-
          // 429 sequence leaves `error_code='rate_limit_cooling_off'`
          // on the row; the caller's subsequent UPDATE to status='failed'
          // re-stamps `error_message` with the real error but the
          // `error_code` may already be overwritten with the new code
          // — except the status-poll path that surfaces a "rate-limited"
          // body keys off the stale `error_code` until the caller
          // explicitly clears it. Clear here so the caller writes onto
          // a clean slate.
          await this.clearCoolingOffMessage(job_id)
          return { kind: 'non_retryable', error: err }
        }
        // eslint-disable-next-line no-console
        console.warn(
          `[import] ${pass} attempt ${attempt + 1}/${maxAttempts} for job=${job_id} hit 429; backing off`,
        )
        // continue → next loop iteration sleeps before retry
      }
    }
    return { kind: 'rate_limited_exhausted', lastError, attempts: maxAttempts }
  }

  /**
   * Persist a human-readable cooling-off message on the job row so the
   * engine's poll can surface it in the live progress envelope. We
   * overload `error_message` here (the column is otherwise unused
   * mid-run) — the brief's "rate_limit_cooling_off" status discriminates
   * cooling vs. real failure.
   */
  private async persistCoolingOffMessage(
    job_id: string,
    pass: 'pass1' | 'pass2',
    attempt: number,
    max_attempts: number,
    delay_ms: number,
    last_error_message: string,
  ): Promise<void> {
    const summary = last_error_message.length > 0
      ? last_error_message.slice(0, 200)
      : 'HTTP 429'
    const body =
      `${pass} attempt ${attempt}/${max_attempts}: Claude rate limit cooling off ` +
      `(${Math.round(delay_ms / 1000)}s backoff). Last error: ${summary}`
    await this.db.run(
      `UPDATE import_jobs
          SET error_code = 'rate_limit_cooling_off',
              error_message = ?
        WHERE job_id = ?
          AND status NOT IN ('cancelled', 'completed', 'failed', 'rate_limit_paused')`,
      [body, job_id],
    )
  }

  /**
   * 2026-06-17 (import-analysis-completeness) — persist the
   * `waiting_on_cooldown` signal while the runner sleeps for a KNOWN
   * Anthropic quota-reset window (the substrate handed us the pool's
   * soonest `cooldown_until`). Keeps the DB `status='rate_limit_cooling_off'`
   * (so the engine's existing import-running state machine + cooling-off
   * bubble are unchanged — no status-enum migration / engine rewrite),
   * but ALSO stamps `cooldown_resume_at` so `status()` can derive the
   * `waiting_on_cooldown` phase + the progress UI can render an accurate
   * "waiting for your Anthropic quota to reset, resuming…" countdown.
   * The `cooldown_resume_at` stamp is cleared by `clearCoolingOffMessage`
   * on the next successful LLM call.
   */
  private async persistWaitingOnCooldown(
    job_id: string,
    pass: 'pass1' | 'pass2',
    resume_at: number,
    last_error_message: string,
  ): Promise<void> {
    await this.setStatusIfNotCancelled(job_id, 'rate_limit_cooling_off')
    const summary = last_error_message.length > 0 ? last_error_message.slice(0, 200) : 'HTTP 429'
    const secs = Math.max(1, Math.round((resume_at - this.now()) / 1000))
    const body =
      `${pass}: waiting for your Anthropic quota to reset, resuming in ~${secs}s. ` +
      `Last error: ${summary}`
    await this.db.run(
      `UPDATE import_jobs
          SET error_code = 'rate_limit_cooling_off',
              error_message = ?,
              cooldown_resume_at = ?
        WHERE job_id = ?
          AND status NOT IN ('cancelled', 'completed', 'failed', 'rate_limit_paused')`,
      [body, resume_at, job_id],
    )
  }

  /**
   * Clear the transient cooling-off stamp on a successful retry. Also
   * clears `cooldown_resume_at` (2026-06-17) so a recovered job stops
   * advertising a stale `waiting_on_cooldown` phase to the progress UI.
   */
  private async clearCoolingOffMessage(job_id: string): Promise<void> {
    await this.db.run(
      `UPDATE import_jobs
          SET error_code = NULL, error_message = NULL, cooldown_resume_at = NULL
        WHERE job_id = ?
          AND error_code = 'rate_limit_cooling_off'`,
      [job_id],
    )
  }

  /**
   * Final state when the backoff window exhausts. Persisted as a
   * non-terminal-for-the-user status: the engine's poll will render
   * the quieter "still waiting on rate limit" body and NOT advance to
   * gap-fill.
   *
   * Argus r1 (PR #271) — also stamps `last_paused_at` so the engine's
   * cron-driven resume can apply the COOLDOWN_AFTER_PAUSED_MS gate
   * before dispatching a fresh `runner.start(...)` to pick up at $0
   * from the cached Pass-1 chunks. Without this column the cron would
   * have no way to know how long a row has been parked.
   */
  private async markRateLimitPaused(
    job_id: string,
    pass: 'pass1' | 'pass2',
    last_error_message: string,
  ): Promise<void> {
    const summary = last_error_message.length > 0
      ? last_error_message.slice(0, 400)
      : 'HTTP 429 (no detail)'
    const body =
      `${pass} backoff exhausted: still rate-limited by Claude. ` +
      `Cached Pass-1 work is preserved; the next runner.start resumes at $0. ` +
      `Last error: ${summary}`
    const paused_at = this.now()
    // 2026-06-17 — clear `cooldown_resume_at`: once the retry cap is
    // exhausted and the job parks at `rate_limit_paused`, the engine's
    // COOLDOWN_AFTER_PAUSED_MS resume cron owns the resume timing, so a
    // stale per-attempt resume hint would mislead the progress UI.
    await this.db.run(
      `UPDATE import_jobs
          SET status = 'rate_limit_paused',
              error_code = 'rate_limit_paused',
              error_message = ?,
              last_paused_at = ?,
              cooldown_resume_at = NULL
        WHERE job_id = ?
          AND status NOT IN ('cancelled', 'completed', 'failed')`,
      [body, paused_at, job_id],
    )
  }

  private async isCancelled(job_id: string): Promise<boolean> {
    const row = this.db
      .raw()
      .query<{ status: string }, [string]>(`SELECT status FROM import_jobs WHERE job_id = ?`)
      .get(job_id)
    return row?.status === 'cancelled'
  }

  /**
   * v0.1.78 — sliced sleep that polls `isCancelled` between each
   * ≤500ms chunk so a cancel landing mid-backoff is observed in O(1)
   * slice rather than after a 60s sleep. Returns true when cancel was
   * observed.
   *
   * Codex r3 (2026-05-31) — also polls the optional `shouldAbort`
   * callback so a sibling Pass-1 worker that flips `paused` mid-sleep
   * is observed within one slice instead of after the full backoff.
   */
  private async sleepWithCancelCheck(
    totalMs: number,
    job_id: string,
    shouldAbort?: () => boolean,
  ): Promise<boolean> {
    if (totalMs <= 0) return false
    const CHUNK_MS = 500
    let remaining = totalMs
    while (remaining > 0) {
      const slice = Math.min(remaining, CHUNK_MS)
      await this.sleep(slice)
      if (await this.isCancelled(job_id)) return true
      if (shouldAbort?.() === true) return true
      remaining -= slice
    }
    return false
  }

  /**
   * Conditional status update — only flip if the row is NOT already
   * cancelled / paused / completed / failed. Returns whether the row
   * ended up at the requested status.
   */
  private async setStatusIfNotCancelled(
    job_id: string,
    status: ImportJobStatus,
  ): Promise<boolean> {
    await this.db.run(
      `UPDATE import_jobs SET status = ?
         WHERE job_id = ?
           AND status NOT IN ('cancelled', 'completed', 'failed', 'rate_limit_paused')`,
      [status, job_id],
    )
    const row = this.db
      .raw()
      .query<{ status: string }, [string]>(`SELECT status FROM import_jobs WHERE job_id = ?`)
      .get(job_id)
    return row?.status === status
  }

  private async bumpProgress(
    job_id: string,
    chunks_done: number,
    chunks_total: number,
  ): Promise<void> {
    await this.db.run(
      `UPDATE import_jobs SET pass1_chunks_done = ?, pass1_chunks_total = ? WHERE job_id = ?`,
      [chunks_done, chunks_total, job_id],
    )
  }

  private async persistChunksTotalKnown(
    job_id: string,
    chunks_total: number,
    known: boolean,
  ): Promise<void> {
    await this.db.run(
      `UPDATE import_jobs
          SET pass1_chunks_total = ?, chunks_total_known = ?
        WHERE job_id = ?`,
      [chunks_total, known ? 1 : 0, job_id],
    )
  }

  /**
   * v0.1.85 (2026-05-23) — resolve the per-job chunk options at start
   * time. Priority order:
   *
   *   1. If `getCurrentCredentialKind` is wired AND the resolver
   *      returns `'oauth'` (Max OAuth Bearer auth), override
   *      `target_tokens` with `MAX_OAUTH_CHUNK_TARGET_TOKENS` (4096).
   *      This is the fix for the 2026-05-23 Max-only owner incident:
   *      the default 50K target exceeded Anthropic's predictive
   *      rate-limit gate and every chunk 429'd at submit time.
   *   2. Else: use the constructor-supplied `chunkOptions` as-is.
   *      Test seams (chunker tests, idempotency tests) supply their
   *      own `target_tokens` override; production omits the field so
   *      the chunker falls through to its own `CHUNK_TARGET_TOKENS`
   *      default (50K).
   *
   * The resolved target is persisted to `import_jobs.chunk_target_tokens`
   * (migration 0044) so operators can grep journald / sqlite for which
   * code path each import ran under. A best-effort resolver failure
   * (callback throws, returns null) preserves the constructor default
   * and persists whatever value the chunker would land on — the import
   * still progresses on the BYO path; only the Max-OAuth-specific
   * override is skipped.
   */
  private async resolveEffectiveChunkOptions(
    job_id: string,
    project_slug: string,
    source: ImportSource,
  ): Promise<{ target_tokens?: number; enable_skip_llm?: boolean; min_user_content_chars?: number }> {
    let credentialKind: CredentialKind | null = null
    if (this.getCurrentCredentialKind !== undefined) {
      try {
        credentialKind = await this.getCurrentCredentialKind()
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `[import] getCurrentCredentialKind threw for job=${job_id} project=${project_slug} source=${source}: ${
            err instanceof Error ? err.message : String(err)
          }; falling back to default chunk size`,
        )
      }
    }
    const effective: {
      target_tokens?: number
      enable_skip_llm?: boolean
      min_user_content_chars?: number
    } = { ...this.chunkOptions }
    if (credentialKind === 'oauth') {
      effective.target_tokens = MAX_OAUTH_CHUNK_TARGET_TOKENS
    } else if (effective.target_tokens === undefined) {
      effective.target_tokens = CHUNK_TARGET_TOKENS
    }
    // 2026-06-17 (import-analysis-completeness) — ANALYZE EVERY CHUNK.
    // Ryan-directed ("I dont want it to skip analysis — that's a dumb
    // code path and we should not have it"): a single-owner import
    // analyzes the owner's FULL history because it's their own Max plan
    // (completeness > cost/speed). The production default is now
    // `enable_skip_llm = false` for ALL sources, so the chunker never
    // stamps `skip_llm=true` and no chunk is dropped on
    // `insufficient_user_content`.
    //
    // Prior behavior (REMOVED): chat-export sources (chatgpt-zip /
    // claude-zip) defaulted the 500-char skip floor ON, silently
    // dropping thin chunks ("user said 'hi'"). Ryan dogfooded a Claude
    // export and saw `skip_llm=true reason=insufficient_user_content
    // user_chars=97` lines — incomplete analysis. The floor seams
    // (`enable_skip_llm` / `min_user_content_chars`) survive ONLY for
    // tests that opt in explicitly via `chunkOptions`; the explicit
    // constructor override still wins over this analyze-all default.
    if (this.chunkOptions.enable_skip_llm === undefined) {
      effective.enable_skip_llm = false
    }
    const stamped = effective.target_tokens ?? CHUNK_TARGET_TOKENS
    await this.db.run(
      `UPDATE import_jobs SET chunk_target_tokens = ? WHERE job_id = ?`,
      [stamped, job_id],
    )
    // eslint-disable-next-line no-console
    console.info(
      `[import] job=${job_id} project=${project_slug} source=${source} ` +
        `chunk_target_tokens=${stamped} credential_kind=${credentialKind ?? 'unknown'} ` +
        `analysis=${effective.enable_skip_llm === false ? 'analyze-all' : 'skip-floor-enabled'}`,
    )
    return effective
  }

  /**
   * Accumulate the substrate's billed dollar cost on the job row for
   * telemetry only. The column is WRITTEN so dashboards / operator
   * queries can see how much an import burned, but nothing READS it
   * for control flow. (The pre-v0.1.78 BudgetCap subsystem used this
   * column to enforce a $X cap; that enforcement was removed
   * 2026-05-22.)
   */
  private async accumulateDollarsSpent(job_id: string, dollars: number): Promise<void> {
    if (!Number.isFinite(dollars) || dollars === 0) return
    await this.db.run(
      `UPDATE import_jobs SET dollars_spent = dollars_spent + ? WHERE job_id = ?`,
      [dollars, job_id],
    )
  }

  private fetchPass1Cached(
    project_slug: string,
    source: ImportSource,
    chunk_hash: string,
  ): Pass1ChunkResult | null {
    const row = this.db
      .raw()
      .query<Pass1ChunkRow, [string, string, string]>(
        `SELECT chunk_hash, candidate_entities_json, candidate_topics_json,
                candidate_tasks_json, voice_signals_json, dollars_billed
           FROM import_pass1_chunks
          WHERE project_slug = ? AND source = ? AND chunk_hash = ? AND analyzed = 1`,
      )
      .get(project_slug, source, chunk_hash)
    if (row === null) return null
    return {
      chunk_hash: row.chunk_hash,
      candidate_entities: JSON.parse(row.candidate_entities_json) as Pass1ChunkResult['candidate_entities'],
      candidate_topics: JSON.parse(row.candidate_topics_json) as Pass1ChunkResult['candidate_topics'],
      candidate_tasks: JSON.parse(row.candidate_tasks_json) as Pass1ChunkResult['candidate_tasks'],
      voice_signals: JSON.parse(row.voice_signals_json) as Pass1ChunkResult['voice_signals'],
      dollars_billed: 0, // Re-runs cost $0 by design
    }
  }

  /**
   * Item 4 (migration 0063) — retention backfill for cache-hit rows
   * analyzed before chunk_text existed. Touches ONLY rows whose
   * chunk_text is NULL; never disturbs job_id / analyzed / candidates,
   * so the idempotency-dedup semantics are byte-identical.
   */
  private async backfillChunkText(
    project_slug: string,
    source: ImportSource,
    chunk: Chunk,
  ): Promise<void> {
    await this.db.run(
      `UPDATE import_pass1_chunks
          SET chunk_text = ?
        WHERE project_slug = ? AND source = ? AND chunk_hash = ?
          AND chunk_text IS NULL`,
      [chunk.text, project_slug, source, chunk.chunk_hash],
    )
  }

  private async claimChunk(
    job_id: string,
    project_slug: string,
    source: ImportSource,
    chunk: Chunk,
  ): Promise<boolean> {
    const now = this.now()
    try {
      // Item 4 (migration 0063) — RETAIN the raw chunk text at claim
      // time. The transcript is the user's own data in their own project
      // DB; the project materializer slices it per project after the
      // wow-moment shells land. The ON CONFLICT branch backfills
      // chunk_text onto cache-hit rows from PRE-retention imports
      // (chunk_text IS NULL) without disturbing the claim semantics —
      // job_id is never touched, so the claimed-by check below is
      // unaffected and re-runs still dedupe at $0 LLM cost.
      await this.db.run(
        `INSERT INTO import_pass1_chunks
          (project_slug, source, chunk_hash, job_id, conversation_id, chunk_index,
           chunk_byte_length, candidate_entities_json, candidate_topics_json,
           candidate_tasks_json, voice_signals_json, dollars_billed, analyzed_at,
           chunk_text)
         VALUES (?, ?, ?, ?, ?, ?, ?, '[]', '[]', '[]', '{}', 0, ?, ?)
         ON CONFLICT (project_slug, source, chunk_hash) DO UPDATE SET
           chunk_text = excluded.chunk_text
           WHERE import_pass1_chunks.chunk_text IS NULL`,
        [
          project_slug,
          source,
          chunk.chunk_hash,
          job_id,
          chunk.conversation_id,
          chunk.chunk_index,
          chunk.byte_length,
          now,
          chunk.text,
        ],
      )
    } catch (err) {
      throw err
    }
    const row = this.db
      .raw()
      .query<{ job_id: string }, [string, string, string]>(
        `SELECT job_id FROM import_pass1_chunks
          WHERE project_slug = ? AND source = ? AND chunk_hash = ?`,
      )
      .get(project_slug, source, chunk.chunk_hash)
    return row?.job_id === job_id
  }

  private async finalizePass1Chunk(
    project_slug: string,
    source: ImportSource,
    chunk: Chunk,
    result: Pass1ChunkResult,
  ): Promise<void> {
    await this.db.run(
      `UPDATE import_pass1_chunks
          SET candidate_entities_json = ?,
              candidate_topics_json = ?,
              candidate_tasks_json = ?,
              voice_signals_json = ?,
              dollars_billed = ?,
              analyzed_at = ?,
              analyzed = 1
        WHERE project_slug = ? AND source = ? AND chunk_hash = ?`,
      [
        JSON.stringify(result.candidate_entities),
        JSON.stringify(result.candidate_topics),
        JSON.stringify(result.candidate_tasks),
        JSON.stringify(result.voice_signals),
        result.dollars_billed,
        this.now(),
        project_slug,
        source,
        chunk.chunk_hash,
      ],
    )
  }

  private async dropPlaceholder(
    project_slug: string,
    source: ImportSource,
    chunk_hash: string,
    job_id: string,
  ): Promise<void> {
    await this.db.run(
      `DELETE FROM import_pass1_chunks
        WHERE project_slug = ? AND source = ? AND chunk_hash = ?
          AND analyzed = 0 AND job_id = ?`,
      [project_slug, source, chunk_hash, job_id],
    )
  }

  private async awaitClaimedFinalize(
    project_slug: string,
    source: ImportSource,
    chunk_hash: string,
    pollMs = 200,
    maxAttempts = 30,
  ): Promise<Pass1ChunkResult | null> {
    for (let i = 0; i < maxAttempts; i++) {
      const cached = this.fetchPass1Cached(project_slug, source, chunk_hash)
      if (cached !== null) return cached
      await new Promise((r) => setTimeout(r, pollMs))
    }
    return null
  }

  /**
   * 2026-05-25 (import-pipeline-resilience sprint, Bug D) — fan out
   * the persisted `ImportResult` through `writeEntity` per the
   * `entity-populator` rules. No-op when any of the optional deps
   * (`ownerDataDir`, `writeEntity`) is missing. Best-effort: any
   * throw is logged and swallowed so the runner's terminal status
   * flip still completes.
   */
  private async runEntityPopulator(
    job_id: string,
    project_slug: string,
    source: ImportSource,
    result: ImportResult,
  ): Promise<void> {
    const ownerDataDir = this.ownerDataDir
    const writeEntity = this.writeEntity
    if (ownerDataDir === undefined || writeEntity === undefined) {
      return
    }
    const populatorDeps: {
      writeEntity: WriteEntityFn
      syncHook?: SyncHook
    } =
      this.gbrainSyncHook !== undefined
        ? { writeEntity, syncHook: this.gbrainSyncHook }
        : { writeEntity }
    try {
      const report = await populateEntitiesFromImport(
        {
          ownerDataDir,
          project_slug,
          job_id,
          source,
          result,
          now: () => this.now(),
        },
        populatorDeps,
      )
      // eslint-disable-next-line no-console
      console.log(
        `[entity-populator] job=${job_id} project=${project_slug} source=${source} ` +
          `pages_written=${report.pages_written} pages_skipped=${report.pages_skipped} ` +
          `memory_edges=${report.memory_edges}`,
      )
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[entity-populator] threw for job=${job_id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
  }

  private async persistResult(
    job_id: string,
    project_slug: string,
    source: ImportSource,
    result: ImportResult,
    partial: boolean,
  ): Promise<void> {
    const now = this.now()
    const conv_count_raw = (result as ImportResult & { conversation_count?: number })
      .conversation_count
    const conversation_count =
      typeof conv_count_raw === 'number' && Number.isFinite(conv_count_raw) && conv_count_raw > 0
        ? conv_count_raw
        : null
    const synthesizer_model =
      typeof result.synthesizer_model === 'string' && result.synthesizer_model.length > 0
        ? result.synthesizer_model
        : null
    await this.db.run(
      `INSERT INTO import_results
        (job_id, project_slug, source, projects_json, tasks_json, topics_json,
         reminders_json, entities_json, voice_signals_json, facts_json,
         finalized_at, partial,
         inferred_interests_json, confidence_by_inference_json, conversation_count,
         synthesizer_model)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (job_id) DO UPDATE SET
         projects_json = excluded.projects_json,
         tasks_json = excluded.tasks_json,
         topics_json = excluded.topics_json,
         reminders_json = excluded.reminders_json,
         entities_json = excluded.entities_json,
         voice_signals_json = excluded.voice_signals_json,
         facts_json = excluded.facts_json,
         finalized_at = excluded.finalized_at,
         partial = excluded.partial,
         inferred_interests_json = excluded.inferred_interests_json,
         confidence_by_inference_json = excluded.confidence_by_inference_json,
         conversation_count = excluded.conversation_count,
         synthesizer_model = excluded.synthesizer_model`,
      [
        job_id,
        project_slug,
        source,
        JSON.stringify(result.proposed_projects),
        JSON.stringify(result.proposed_tasks),
        JSON.stringify(result.topics),
        JSON.stringify(result.proposed_reminders),
        JSON.stringify(result.entities),
        JSON.stringify(result.voice_signals),
        JSON.stringify(result.facts),
        now,
        partial ? 1 : 0,
        JSON.stringify(result.inferred_interests ?? []),
        JSON.stringify(result.confidence_by_inference ?? []),
        conversation_count,
        synthesizer_model,
      ],
    )
  }
}

/**
 * 2026-06-17 (import-analysis-completeness) — read the cooldown resume
 * hint off a thrown error. Returns the wall-clock epoch-ms the soonest
 * Anthropic credential is expected to leave cooldown (i.e. when a retry
 * can plausibly succeed), or null when the error carries no cooldown hint
 * (a generic 429 without a retry-after, a non-cooldown failure, etc.).
 *
 * The hint originates in `build-import-substrate`'s all-cooldown branch
 * (the pool's soonest `cooldown_until` → the error Event's
 * `retry_after_ms`) and is threaded onto `ImportError.retry_after_ms` by
 * `substrate-callers.drainSubstrateEvents`. `retry_after_ms` is a DURATION
 * from when the substrate observed the cooldown; we convert it to an
 * absolute resume time relative to `now` (slightly conservative — a few ms
 * of threading latency means we wait marginally longer, never shorter).
 */
function extractCooldownResumeAt(err: unknown, now: number): number | null {
  if (
    err instanceof ImportError &&
    typeof err.retry_after_ms === 'number' &&
    Number.isFinite(err.retry_after_ms) &&
    err.retry_after_ms > 0
  ) {
    return now + err.retry_after_ms
  }
  return null
}

/**
 * v0.1.78 — narrow an unknown thrown value to its message string for the
 * cooling-off status overlay + persisted error_message column.
 */
function extractErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  if (err === null || err === undefined) return ''
  return String(err)
}

/**
 * True when the given error message matches a 429 / rate-limit shape
 * worth retrying. Used by both Pass-1 and Pass-2 retries.
 *
 * Detection sources (in order — any one match counts):
 *   1. `ImportError` whose message matches `HTTP 429` or `rate_limit`.
 *   2. Any plain `Error` whose message matches the same patterns.
 *
 * Non-429 errors (parse failures, 400/403, OAuth refresh, llm_unwired)
 * are NOT retryable — retry just papers over an obvious permanent error.
 *
 * Exported for the regression test suite.
 */
export function is429RetryableError(err: unknown): boolean {
  if (err === null || err === undefined) return false
  const message =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : String(err)
  if (/HTTP\s+429\b/i.test(message)) return true
  if (/rate[_-]?limit/i.test(message)) return true
  return false
}

function degradedFromAggregated(aggregated: ReturnType<typeof aggregatePass1>): ImportResult {
  const out: ImportResult = {
    entities: aggregated.entities,
    topics: aggregated.topics.map((t) => ({
      name: t.name,
      recurrence_score: t.recurrence_score,
      recency_score: t.recency_score,
    })),
    proposed_projects: [],
    proposed_tasks: aggregated.tasks,
    proposed_reminders: [],
    voice_signals: aggregated.voice_signals,
    facts: {},
  }
  if (aggregated.totals.chunks > 0) {
    out.conversation_count = aggregated.totals.chunks
  }
  return out
}
