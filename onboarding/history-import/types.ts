/**
 * @neutronai/onboarding/history-import — shared types (P2 S3).
 *
 * Per docs/plans/P2-onboarding.md § 2.3 (locked design — two-pass map-
 * reduce, $5 owner ceiling, per-source caps) + § 4.7 module contract
 * (ImportJob shape, ImportResult shape, ImportError codes).
 *
 * The shapes here are the public surface — every other history-import
 * file imports from this module. Persistence rows + LLM prompts speak
 * the same language so the round-trip is auditable.
 */

export type ImportSource =
  | 'chatgpt-zip'
  | 'claude-zip'
  | 'gmail-oauth'
  | 'calendar-oauth'
  | 'drive-oauth'
  | 'notion-oauth'
  | 'slack-oauth'

export type ImportJobStatus =
  | 'queued'
  | 'pass1-running'
  | 'pass2-running'
  /**
   * 2026-05-22 (v0.1.78) — runner observed an HTTP 429 from the
   * Anthropic substrate and is sleeping inside the exponential backoff
   * window before the next retry. Persisted between attempts so the
   * engine's `pollImportRunningAndAdvance` can render the "Claude rate
   * limit cooling off — resuming shortly" bubble. On retry success, the
   * runner flips back to `pass1-running` / `pass2-running`.
   */
  | 'rate_limit_cooling_off'
  /**
   * 2026-05-22 (v0.1.78) — the backoff window exhausted (~30 minutes of
   * 429s). The runner stops attempting; the engine surfaces a quieter
   * "still waiting on Claude's rate limit" body and DOES NOT fall back
   * to gap-fill. State is recoverable — every Pass-1 chunk already
   * analyzed is cached, so a future `runner.start` for the same source
   * resumes at $0 from the same chunk index.
   */
  | 'rate_limit_paused'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type ImportErrorCode =
  | 'parse_failed'
  | 'budget_exceeded'
  | 'substrate_error'
  | 'oauth_scope_missing'
  | 'cancelled'
  | 'job_not_found'
  | 'duplicate_job'
  // Argus r2 (fix-pass) — added so an import that hits a runner with no
  // wired Pass-1 / Pass-2 LLM caller surfaces a user-visible `failed`
  // job (NOT a silent `completed` with empty entities). The job-runner
  // bubbles this code out of the per-chunk catch so the outer
  // `runJobInternal` catch can mark `import_jobs.status='failed'` with
  // a stable `error_code` the engine reads when emitting the failed
  // sub_step. See engine.ts:pollImportRunningAndAdvance + spec
  // "Spec is the source of truth" rule in CLAUDE.md.
  | 'llm_unwired'
  // Argus r2 (fix-pass) — every Pass-1 chunk threw before we landed a
  // single analyzable result. Distinguishes "honestly empty parse"
  // (chunksTotal===0 → still completed) from "all chunks errored"
  // (chunksTotal>0 AND pass1Results.length===0 → failed). The latter
  // used to silently flip to status='completed' with empty entities —
  // the exact no-op pattern the spec-conformance rule forbids.
  | 'pass1_all_failed'

export class ImportError extends Error {
  override readonly name = 'ImportError'
  /**
   * 2026-06-17 (import-analysis-completeness) — optional cooldown hint
   * carried up from the substrate when the failure is an all-credential
   * cooldown (every Anthropic credential in the pool is in 429/402/401
   * cooldown). Populated by `substrate-callers.drainSubstrateEvents` from
   * the error Event's `retry_after_ms` (which `build-import-substrate`
   * stamps as `soonestCooldownUntil - now`). The runner's `retryWith429`
   * reads this to sleep for the ACTUAL soonest cooldown window (respecting
   * the provider's retry-after) and to surface the `waiting_on_cooldown`
   * phase + `cooldown_resume_at` to the progress UI, instead of falling
   * back to the generic fixed backoff schedule. Absent ⇒ no cooldown hint
   * (generic 429 backoff applies).
   */
  retry_after_ms?: number
  constructor(
    readonly code: ImportErrorCode,
    readonly source: ImportSource | null,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message)
  }
}

/**
 * One conversation surface drawn from any source. ChatGPT zips emit one
 * record per conversation; Claude.ai zips emit one per dialogue; the
 * Gmail importer emits one per thread; Calendar emits one per event
 * (treated as a degenerate single-message conversation). The chunker
 * consumes this stream.
 */
export interface ConversationRecord {
  /** Stable id from the source — re-runs hash on this for dedup. */
  conversation_id: string
  /** Optional title; defaults to first user-message preamble. */
  title?: string
  /** Optional unix-ms timestamp; used by Pass-2 for recency scoring. */
  created_at?: number
  /** The message stream. Empty array is valid (sources can emit metadata-only convos). */
  messages: ConversationMessage[]
  /** Source-specific extras the LLM passes ignore but the persistence layer keeps. */
  meta?: Record<string, unknown>
}

export interface ConversationMessage {
  role: 'user' | 'assistant' | 'system' | 'tool' | 'event'
  text: string
  /** Optional unix-ms timestamp (when the source carries it). */
  created_at?: number
}

/**
 * One Pass-1 unit. The hash is `sha256(conversation_id + ':' +
 * chunk_index + ':' + chunk_text_bytes)` per § 2.3 idempotency rule.
 * The chunker emits these; the Pass-1 mapper analyzes; the persistence
 * layer dedupes on `chunk_hash` PRIMARY KEY.
 */
export interface Chunk {
  chunk_hash: string
  conversation_id: string
  chunk_index: number
  text: string
  /** Convenience — sum of UTF-8 byte length of `text`. */
  byte_length: number
  /** Estimate; the chunker uses ~4 chars per token. Drives chunk-boundary placement only. */
  approx_tokens: number
  /**
   * 2026-05-31 — pre-filter signal set by the chunker (`MIN_USER_CONTENT_CHARS`).
   * When `true`, the chunk's total non-assistant content fell under the
   * `MIN_USER_CONTENT_CHARS` threshold (default 500 chars) — the runner's
   * Pass-1 worker pool MUST NOT dispatch this chunk to the LLM. Instead it
   * persists an empty `Pass1ChunkResult` placeholder (0 entities / 0
   * topics / 0 tasks / 0 dollars) so the aggregate's chunk count stays
   * honest and the chunk-hash dedup row still lands. Common case: ChatGPT
   * exports with conversations where the user only said "hi" / "thanks" /
   * "ok" — burning a 30-second Opus call on a 10-character user turn is
   * pure waste. On Claude exports this skips ~10-30% of chunks.
   *
   * **Codex r1 fix (post-initial-commit):** the threshold counts every
   * role EXCEPT `assistant` (which is the prior LLM reply, not the
   * signal we're triaging). This includes `user` (ChatGPT/Claude user
   * turns), `event` (calendar imports + Gmail received-message rows),
   * `tool` (tool-call outputs), and `system`. v1 of this filter
   * counted ONLY `role === 'user'` text, which would have silently
   * 100%-skipped every `calendar-oauth` chunk (all events emit as
   * `role: 'event'`) AND received-only Gmail threads where the
   * owner's address was NEVER the sender.
   *
   * Omitted (undefined) means "no pre-filter signal" — the runner treats
   * undefined identically to `false` and dispatches normally.
   */
  skip_llm?: boolean
  /**
   * 2026-05-31 — when `skip_llm === true`, the non-assistant char count
   * the chunker measured before pre-filtering. Stamped onto the log line
   * `[import] job=X chunk=Y skip_llm=true reason=insufficient_user_content user_chars=N`
   * so operators can grep journald for the actual char distribution.
   * Field name kept as `_user_chars` for back-compat with the
   * constructor seam name `min_user_content_chars`; meaning is now
   * "non-assistant chars" (see `skip_llm` doc above).
   * Not persisted to disk — purely a transient annotation on the in-memory
   * Chunk object.
   */
  skip_llm_user_chars?: number
}

/**
 * 2026-05-31 — minimum non-assistant content (chars) a chunk must carry
 * to justify spending an LLM call on it. When the skip floor is ENABLED
 * (test opt-in only — see below), a chunk whose non-assistant content
 * falls under this threshold is stamped `skip_llm=true` and the runner's
 * worker pool persists an empty placeholder result.
 *
 * **2026-06-17 (import-analysis-completeness) — the production import path
 * DISABLES this floor: every chunk is analyzed.** Ryan-directed
 * ("I dont want it to skip analysis — that's a dumb code path"): a
 * single-owner import analyzes the owner's FULL history because it's their
 * own Max plan (completeness > cost/speed). The runner's
 * `resolveEffectiveChunkOptions` now defaults `enable_skip_llm = false`
 * for ALL sources, so the chunker never stamps `skip_llm` in production.
 * The threshold + the `min_user_content_chars` / `enable_skip_llm` seams
 * survive ONLY so unit tests can still exercise the floor explicitly
 * (`chunker-skip-llm.test.ts`).
 *
 * "Non-assistant" includes `user`, `event` (calendar / Gmail received
 * messages), `tool`, and `system`. See `Chunk.skip_llm` doc above for
 * the Codex r1 fix that broadened from "user only" to "all non-assistant".
 *
 * Exported so tests + analytics can reference the exact threshold.
 */
export const MIN_USER_CONTENT_CHARS = 500

/**
 * 2026-06-17 (import-analysis-completeness) — coarse-grained progress
 * PHASE the import job is currently in, derived by `ImportJobRunner.status`
 * for the progress UI to consume (the per-chunk numerator/denominator lives
 * on `pass1_chunks_done` / `pass1_chunks_total`). Distinct from the DB
 * `ImportJobStatus` enum: a phase is a UI-facing roll-up that can be
 * computed from status + side columns without a status-enum migration.
 *
 * Currently the only special phase is `waiting_on_cooldown` — the job is
 * parked sleeping until the owner's Anthropic quota window resets
 * (`cooldown_resume_at`), after which it resumes analyzing automatically.
 * The progress UI renders "waiting for your Anthropic quota to reset,
 * resuming…" with a countdown to `cooldown_resume_at`.
 */
export type ImportJobPhase = 'waiting_on_cooldown'

/**
 * What Pass-1 emits per chunk. The LLM returns this shape; the runner
 * persists it on `import_pass1_chunks`. Aggregation happens in Pass-2.
 */
export interface Pass1ChunkResult {
  chunk_hash: string
  candidate_entities: CandidateEntity[]
  candidate_topics: CandidateTopic[]
  candidate_tasks: CandidateTask[]
  voice_signals: VoiceSignals
  /** Actual dollars billed for this chunk (chunker's estimate adjusted by the substrate's cost report). */
  dollars_billed: number
}

export interface CandidateEntity {
  /** Canonical name as the LLM extracted it. Pass-2 dedupes case-insensitively. */
  name: string
  /** 'person' | 'company' | 'concept' (LLM picks). */
  kind: 'person' | 'company' | 'concept'
  /** How many times the LLM saw this name in the chunk. Pass-2 sums to mention_count. */
  mention_count: number
}

export interface CandidateTopic {
  /** Short topic name (e.g. "Topline sales pipeline"). */
  name: string
  /** 1-2 sentence summary. */
  summary?: string
  /** Optional unix-ms timestamp of the most recent message in the chunk that referenced this topic. */
  recency_at?: number
}

export interface CandidateTask {
  /** Imperative-form task title (e.g. "Reply to Priya about Q3 invoice"). */
  title: string
  /** Optional unix-ms due date if the LLM detected one. */
  due_at?: number
  /** "P0"|"P1"|"P2"|"P3" hint per priority-map.md convention. */
  priority_hint?: 'P0' | 'P1' | 'P2' | 'P3'
}

export interface VoiceSignals {
  /** "terse" | "expansive" | "neutral" — Pass-2 averages. */
  tone?: 'terse' | 'expansive' | 'neutral'
  /** "low" | "medium" | "high". */
  verbosity?: 'low' | 'medium' | 'high'
  /** "bullets" | "prose" | "mixed". */
  structure_pref?: 'bullets' | 'prose' | 'mixed'
  /** Free-text phrases / quotes the LLM thinks capture the user's voice. */
  signature_phrases?: string[]
}

/**
 * P2 v2 § 2.5 — per-inference confidence score from Pass-2.
 *
 * `field` is a slug shaped as `<kind>:<name>` (e.g. `project:Topline
 * Hospitality` or `interest:climbing`) so the consumer can pair the
 * score back to the bullet without a name-collision risk. `score` is
 * 0.0-1.0; items < 0.5 surface in the "I'm less sure about" callout in
 * `import_analysis_presented`. `basis` is an optional 1-line evidence
 * string ("mentioned 23 times in last 90d") the LLM emits alongside.
 */
export interface InferenceConfidence {
  field: string
  score: number
  basis?: string
}

/**
 * Final synthesis output. Pass-2 returns this; the persistence layer
 * stores it as JSON columns on `import_results`.
 */
export interface ImportResult {
  entities: Array<{
    name: string
    kind: 'person' | 'company' | 'concept'
    mention_count: number
  }>
  topics: Array<{
    name: string
    recurrence_score: number
    recency_score: number
  }>
  proposed_projects: Array<{
    name: string
    rationale: string
    suggested_topics: string[]
  }>
  proposed_tasks: Array<{
    title: string
    due_at?: number
    priority_hint?: 'P0' | 'P1' | 'P2' | 'P3'
  }>
  proposed_reminders: Array<{
    pattern: string
    body: string
  }>
  voice_signals: VoiceSignals
  facts: {
    user_role?: string
    companies?: string[]
    key_people?: string[]
  }
  /**
   * P2 v2 § 2.5 / S5 — per-inference confidence scores.
   *
   * Optional + schema-additive: instances whose Pass-2 ran against the
   * pre-v2 prompt won't have these fields; downstream consumers MUST
   * treat undefined as "no confidence signal" rather than as a hard
   * error. The analysis-presentation phase surfaces items with score <
   * 0.5 in the "I'm less sure about" callout per § 2.3.
   */
  confidence_by_inference?: ReadonlyArray<InferenceConfidence>
  /**
   * P2 v2 § 2.3 / § 2.5 / S5 — non-work interests inferred from the
   * import. Distinct from `proposed_projects`: these are the "outside
   * work" bullets in the wow-moment bullet list. Optional for the same
   * reason as `confidence_by_inference` (pre-v2 Pass-2 result rows
   * won't have it).
   */
  inferred_interests?: ReadonlyArray<{
    name: string
    basis?: string
    cadence_hint?: 'weekly' | 'monthly' | 'occasional'
  }>
  /**
   * P2 v2 § 2.3 / S5 — total Pass-1 chunk count, set by the runner at
   * persist time from `aggregated.totals.chunks`. Surfaced in the
   * "Based on N conversations" anchor of the
   * `import_analysis_presented` body. Optional for legacy result rows
   * that predate the S5 migration; the body builder collapses to the
   * "(Based on N conversations.)" clause or omits the count entirely
   * when absent. NOT a substitute for `entities.length`, which is a
   * deduped top-50 list (NOT one row per conversation) — relying on
   * `entities.length` for grounding would systematically misreport
   * the count for normal imports.
   */
  conversation_count?: number
  /**
   * P2 v2 S21 (2026-05-17) — which model produced the Pass-2
   * synthesis. `BEST_MODEL` (Opus 4.7) is the primary; `SONNET_MODEL`
   * (Sonnet 4.6) lands here when the Opus call exhausted 429s and the
   * substrate caller fell back per the S21 spec. Optional + schema-
   * additive: pre-S21 rows have NULL in the column and the runner
   * defaults to `BEST_MODEL` at read time. Observability / metrics
   * consumers can group by this field to see how often production
   * trips the fallback path.
   */
  synthesizer_model?: string
}

/** ImportJob — what the runner persists + what `status()` returns. */
export interface ImportJob {
  job_id: string
  project_slug: string
  source: ImportSource
  status: ImportJobStatus
  dollars_spent: number
  pass1_chunks_done: number
  pass1_chunks_total: number
  /**
   * 2026-05-22 — pre-count-before-pass1 fix follow-up to PR #264.
   *
   * `true`  → the runner materialized the entire parser→chunker pipeline
   *           upfront; `pass1_chunks_total` is the FINAL count for this
   *           job and the user-visible denominator is stable.
   * `false` → the runner is streaming the source (fallback path —
   *           pre-count threw, or the row predates this column);
   *           `pass1_chunks_total` is whatever has been DISCOVERED so
   *           far and may still grow. Clients render a count-only body
   *           ("Pass 1: N batches processed") in this mode rather than
   *           a fake N/N denominator.
   *
   * Persisted as `chunks_total_known INTEGER` (0/1) on `import_jobs`
   * (migration 0039). Existing rows default to 0 — same as a streaming
   * fallback — so the user-visible behavior on legacy in-flight jobs
   * stays exactly as before this fix landed.
   */
  chunks_total_known: boolean
  started_at: number
  completed_at?: number
  error_code?: ImportErrorCode
  error_message?: string
  result?: ImportResult
  partial?: boolean
  /**
   * Argus r1 (PR #271, 2026-05-22) — wall-clock unix-ms when the runner
   * flipped this row to `status='rate_limit_paused'` (i.e. when the
   * 429-backoff schedule exhausted). Only set on rows currently or
   * previously at `rate_limit_paused`. The engine's import-running cron
   * uses this to apply `COOLDOWN_AFTER_PAUSED_MS` before dispatching a
   * fresh `runner.start(...)` that resumes from the cached Pass-1
   * chunks at $0. Absent means either "never paused" or "row predates
   * migration 0041" — the engine treats absent on a paused row as
   * "cooldown already satisfied → resume immediately".
   */
  last_paused_at?: number
  /**
   * v0.1.85 (2026-05-23) — per-job Pass-1 chunk-target-tokens, stamped
   * at start time by the runner from the resolved credential kind:
   *   - `MAX_OAUTH_CHUNK_TARGET_TOKENS` (4096) when the substrate's
   *     credential kind is `'oauth'` (Max OAuth Bearer auth);
   *   - `CHUNK_TARGET_TOKENS` (50_000) otherwise (BYO API key / env).
   *
   * Persisted as `import_jobs.chunk_target_tokens` (migration 0044).
   * Nullable: legacy rows that predate v0.1.85 have NULL and the
   * engine's import-running renderer collapses to the original
   * progress-bubble UX with no Max-OAuth notice. Telemetry consumers
   * group by this column to see which path each import ran under.
   */
  chunk_target_tokens?: number
  /**
   * 2026-06-17 (import-analysis-completeness) — wall-clock unix-ms the
   * runner expects the soonest Anthropic credential cooldown to lift,
   * stamped while the job sleeps inside a known cooldown window. Set
   * alongside `status='rate_limit_cooling_off'` whenever the substrate
   * surfaced a concrete cooldown hint (all-credential cooldown carrying
   * the pool's soonest `cooldown_until`); cleared on the next successful
   * LLM call. Persisted as `import_jobs.cooldown_resume_at` (migration
   * 0076). The progress UI renders a countdown to this value under the
   * `waiting_on_cooldown` phase. Absent ⇒ not currently parked on a known
   * cooldown window.
   */
  cooldown_resume_at?: number
  /**
   * 2026-06-17 (import-analysis-completeness) — UI-facing progress phase
   * roll-up, derived by `status()` (NOT a DB column). Currently only
   * surfaces `waiting_on_cooldown` (status is `rate_limit_cooling_off` AND
   * `cooldown_resume_at` is in the future). Absent ⇒ the per-status UX
   * applies with no special phase. See `ImportJobPhase`.
   */
  phase?: ImportJobPhase
}

/** Re-export of the OAuth refs shape. */
export interface OAuthRefs {
  /** Encrypted access token (looked up via SecretsStore by the runner). */
  access_token: string
  /** Optional refresh token; oauth-gmail/calendar will refresh as needed. */
  refresh_token?: string
  /** Source-specific extras (Gmail: {after_date_ms?}; Calendar: {since_ts_ms?}). */
  options?: Record<string, unknown>
}

/** Convenience: what `chunkExport` accepts. */
export type ChunkerInput = Buffer | OAuthRefs

/** Per-source budget defaults per § 2.3 Pass-2 deepening. */
export const PER_SOURCE_CAPS: Readonly<Record<ImportSource, number>> = {
  'chatgpt-zip': 3.5,
  'claude-zip': 2.0,
  'gmail-oauth': 0.75,
  'calendar-oauth': 0.2,
  'drive-oauth': 0,
  'notion-oauth': 0,
  'slack-oauth': 0,
}

/** Per-owner ceiling per § 2.3. */
export const DEFAULT_OWNER_CAP_DOLLARS = 5.0

/** 80% warning threshold ratio. */
export const WARNING_RATIO = 0.8

/**
 * Pass-1 token-window target. ~50K tokens per chunk per § 2.3. The
 * chunker uses 4 chars per token as a rough approximation (English
 * average is ~3.7-4.5 for GPT/Claude tokenizers).
 *
 * Production note (2026-05-23, v0.1.85): the 50K target is the right
 * default for the regular Anthropic API path. When the substrate
 * authenticates via Max OAuth (Bearer token), Anthropic's predictive
 * rate-limit gate rejects 50K-token-per-call requests with
 * "This request would exceed your account's rate limit" — even on the
 * FIRST call when no prior usage exists in the window. Max OAuth is
 * designed for interactive Claude Code (1-8K tokens/call), NOT bulk
 * 50K batches. Use `MAX_OAUTH_CHUNK_TARGET_TOKENS` for that path.
 *
 * 2026-06-17 (import warm-session sprint): raised 50_000 → 150_000 for the
 * regular API-key path. The import substrate now reuses ONE warm `claude`
 * session across all chunks (no spawn-per-chunk), so the dominant cost is the
 * NUMBER of chunk round-trips, not the per-call token size. Bigger chunks ⇒ ~3x
 * fewer round-trips on a typical export. 150K input + ~2K analysis system prompt
 * + 1.5K Pass-1 output ≈ 153K, safely under Opus 4.7's 200K context window with
 * headroom for the ~4-chars/token estimate's variance. The Max-OAuth path keeps
 * its own (smaller) target — Anthropic's predictive per-request rate gate for
 * Bearer auth is unchanged by warm reuse (see `MAX_OAUTH_CHUNK_TARGET_TOKENS`).
 */
export const CHUNK_TARGET_TOKENS = 150_000
export const APPROX_CHARS_PER_TOKEN = 4

/**
 * Pass-1 token-window target for the Max OAuth substrate (Bearer auth).
 * Sized to stay comfortably under Anthropic's per-call rate-limit gate
 * for Max OAuth tokens. Trade-off: with ~12x more chunks per export
 * the wall-clock time grows accordingly, but the alternative on a
 * Max-only owner is 0/N chunks (every call 429'd at submit time —
 * 2026-05-23 prod walkthrough).
 *
 * Runner selection rule: `getCurrentCredentialKind()` returning
 * `'oauth'` switches the per-job target to this value; anything else
 * (`api_key`, `codex_oauth`, undefined) keeps the 50K default.
 *
 * Known worst-case (Codex r1 P2, 2026-05-23, out-of-scope for the
 * v0.1.85 incident fix): the chunker's "always emit at least one
 * message into a chunk so the worst-case (one giant message) still
 * makes progress" contract (`chunker.ts:chunkOneConversation`) means
 * an export containing a single rendered message larger than
 * ~`MAX_OAUTH_CHUNK_TARGET_TOKENS * APPROX_CHARS_PER_TOKEN` chars
 * still emits ONE oversized chunk and would still 429 the Max OAuth
 * substrate. The Sam 2026-05-23 incident was the typical-size case
 * (the FIRST 50K chunk 429'd at submit time); chunking at 4K
 * resolves the typical-size case. Splitting mid-message changes the
 * chunk_hash dedup semantics for `import_pass1_chunks` and is
 * explicitly out-of-scope here (the brief carved chunking-strategy
 * refactor out). File a follow-up sprint when the first user
 * reports the giant-message worst-case in practice.
 */
export const MAX_OAUTH_CHUNK_TARGET_TOKENS = 4_096
