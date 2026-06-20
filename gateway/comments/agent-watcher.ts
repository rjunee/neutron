/**
 * @neutronai/gateway/comments — agent inline-comment watcher (P7.2 S3).
 *
 * Per docs/plans/2026-05-23-003-feat-p7-2-s3-inline-comments-ui-watcher-escalate-plan.md
 * Part B ("Gateway-side agent watcher").
 *
 * Single-flight tick loop that:
 *   1. Enumerates every active project for this instance.
 *   2. Reads each project's persisted watcher cursor at
 *      `<owner_home>/Projects/<id>/.comments/watcher-cursor.json`.
 *   3. Pulls user-authored `comment_posted` events newer than the
 *      cursor via `CommentStore.listUserCommentsAfter`.
 *   4. For each new user comment:
 *        - Reads the doc body via the injected `doc_read` hook.
 *        - Builds a doc excerpt (~200 lines centred on the anchor).
 *        - Dispatches the watcher LLM call (persona-spliced).
 *        - Sniffs the reply against `ESCALATION_KEYWORDS`. On match,
 *          appends an `escalate_to_chat` event INSTEAD of an agent
 *          reply (the chat surface will absorb the thread on its
 *          next turn via the escalation-loader). Otherwise appends a
 *          `comment_posted` with `author_kind='agent'`.
 *        - On LLM failure (timeout, API error, doc-missing, no-creds)
 *          appends an `agent_reply_skipped` event with a structured
 *          `reason`.
 *   5. Advances the cursor file (atomically via temp + rename) AFTER
 *      the appendEvent lands. Cursor advance + appendEvent are both
 *      inside `with_project_lock` so a crash between them re-runs
 *      the comment on next tick.
 *
 * Tick mechanics (modelled on the Nova reminders/tick.ts pattern):
 *   - `setInterval` + `running` boolean → in-flight tick is skipped
 *     rather than queued. A 30s tick that overlaps a slow LLM call
 *     simply waits for the next 30s tick.
 *   - `stop()` only clears the interval; in-flight tick drains
 *     naturally. The cursor advance ordering guarantees no
 *     duplicate-reply on shutdown mid-tick.
 *
 * Concurrency (per Plan Enhancement Summary § 1, revised post-Argus
 * P7.2 S3 round 1):
 *   - `with_project_lock` wraps the ENTIRE per-tick body — cursor
 *     read, `listUserCommentsAfter`, the LLM call, the appendEvent
 *     write, and the cursor file advance — see `processProject`
 *     below (`this.with_project_lock(project_id, async () => …)`).
 *     The LLM call is intentionally INSIDE the lock so the watcher
 *     serialises against the anchor walker on the same project: this
 *     prevents stale doc reads + double cursor advance when a walker
 *     mutation interleaves with a watcher tick on the same project.
 *     Different projects still run concurrently (the mutex is keyed
 *     by `project_id`); the trade-off against blocking unrelated
 *     HTTP POSTs is acceptable because the docs/comments HTTP path
 *     does NOT acquire this mutex (see plan Part B + the inline
 *     "INSIDE the lock" comment at the top of `processProject`).
 *
 * Forbidden patterns per plan Enhancement Summary (do NOT add):
 *   - `prepend` field on `composeSystemPrompt` (Part C dropped that).
 *   - Retry endpoint (S4 follow-up).
 *   - `watcher_mode_for` per-project injection (no UI to flip it).
 *   - `AgentWatcherOptions.log` injection (use `structuredLog` directly).
 *   - `AgentWatcherOptions.poll_interval_ms` / per_tick_max_replies
 *     options (file-level constants below).
 *
 * Note: `latest_event_kind` IS materialised on `doc_comment_anchors`
 * (per Argus r2 BLOCKER 2 — the side-pane needs a stable read of the
 * most-recent kind so the Resolved tab + skipped badge survive a
 * refetch). The materialiser folds it on every event in a thread; the
 * watcher writes `agent_reply_skipped` / `escalate_to_chat` /
 * `comment_posted (author=agent)` and the next listThreads round-trip
 * surfaces the new kind. `listSkippedSince` is still used by the
 * side-pane to enumerate skipped events for the inline detail
 * tooltip, but the thread-row badge is driven off the materialised
 * `latest_event_kind`.
 */

import { constants as fsConstants } from 'node:fs'
import { lstat, open, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type {
  AppendEventInput,
  CommentStore,
  DocCommentEvent,
} from './comment-store.ts'
import type { WebChatSessionProjectRegistry } from '../http/chat-bridge.ts'
import type { EscalateCommentBodyHistoryEntry } from '../realmode-composer/escalation-loader.ts'

/**
 * Polling cadence — every 30s the watcher walks every active project
 * looking for new user comments. File-level constant per Plan
 * Enhancement Summary § 4 (no per-call config; add a knob when a
 * real reason emerges).
 */
const POLL_INTERVAL_MS = 30_000

/**
 * Per-tick cap on the number of user comments any single project
 * will drive to the LLM. Guards against a malicious commit-bomb
 * (e.g. a script appends 10,000 user comments) from starving the
 * rest of the instance. The remaining events spill to the next tick.
 */
const PER_TICK_MAX_REPLIES = 20

/**
 * Wall-clock budget for one LLM reply. `AbortSignal.timeout(...)`
 * cancels the upstream fetch when this expires; the watcher then
 * appends an `agent_reply_skipped` event with `reason='timeout'`.
 */
const REPLY_TIMEOUT_MS = 90_000

/**
 * Case-insensitive substring triggers for "agent says we should
 * continue this in chat". When the reply matches ANY of these
 * phrases, the watcher writes `escalate_to_chat` INSTEAD of an
 * agent reply. Frozen list per Plan Part B — substring + lowercase
 * is robust to model phrasing variation, and Sam can ratchet up to
 * a real classifier in a future sprint.
 */
const ESCALATION_KEYWORDS: ReadonlyArray<string> = [
  "let's continue in chat",
  "let's move this to chat",
  'we should chat about this',
  'this is beyond my scope here',
  "i can't help with this here",
  'this needs a real conversation',
]

/**
 * Width of the doc excerpt window the watcher hands to the LLM,
 * measured in lines centred on the anchor. ±100 lines around the
 * anchor line is plenty of context for a 4-sentence reply without
 * blowing the per-tick token budget.
 */
const EXCERPT_CONTEXT_LINES = 100

/**
 * Max tokens the watcher asks Anthropic to generate for one reply.
 * The system prompt locks the model to ≤4 sentences; 400 tokens is a
 * safety ceiling, NOT the target length.
 */
const REPLY_MAX_TOKENS = 400

/**
 * Author identity stamped on every watcher-emitted event. Same
 * convention the walker uses (`anchor-walker.ts` stamps `system` for
 * walker events); for COMMENT replies we stamp `agent` because the
 * side-pane UI distinguishes user / agent / system author kinds.
 */
const AGENT_AUTHOR_KIND = 'agent' as const
const AGENT_AUTHOR_ID = 'gateway-agent' as const

/**
 * Structured-reason vocabulary written into `agent_reply_skipped`'s
 * `metadata_json.reason`. Closed enum so the side-pane + telemetry can
 * map each reason to a stable UX message without parsing free-form
 * strings.
 */
export type SkipReason =
  | 'doc_missing'
  | 'timeout'
  | 'rate_limited'
  | 'llm_error'
  | 'no_credentials'

/**
 * LLM call closure shape — same as
 * `AgentWatcherLlmCall` exported from `build-agent-watcher-llm-call.ts`.
 * Re-declared here so the watcher module doesn't pull a hard import
 * cycle on the composer module (the production wiring passes the
 * built closure in via options).
 */
export type AgentWatcherLlmCall = (call: {
  system: string
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
  max_tokens: number
  signal?: AbortSignal
}) => Promise<{ text: string }>

export interface AgentWatcherOptions {
  comment_store: CommentStore
  llm_call: AgentWatcherLlmCall
  /** Absolute path to the per-instance `<owner_home>` dir. */
  owner_home: string
  /**
   * Read the doc body for `(project_id, doc_path)`. Returns `null`
   * when the doc has been deleted between comment-post and watcher-
   * tick. Production wires
   *   `(pid, path) => doc_store.readDoc(pid, path).then(r => r?.body ?? null)`.
   */
  doc_read: (project_id: string, doc_path: string) => Promise<string | null>
  /** Enumerate every active project id in this instance. */
  list_active_projects: () => Promise<string[]>
  /**
   * SHARED per-project async mutex (same instance the anchor-walker
   * uses). Production wires `anchor_walker.withProjectLockExternal`.
   * Wraps the ENTIRE per-tick body — cursor read, listUserCommentsAfter,
   * the LLM call, the appendEvent write, and the cursor-file write —
   * see file-header concurrency notes (the LLM call is INSIDE the
   * lock so the watcher serialises against the anchor walker on the
   * same project).
   */
  with_project_lock: <T>(
    project_id: string,
    fn: () => Promise<T>,
  ) => Promise<T>
  /**
   * ISSUE #44 — per-instance chat-session project tracker shared with the
   * docs surface + the chat composer's phase-spec resolver. When the
   * watcher writes an `escalate_to_chat` event (auto-escalation path —
   * the LLM-classified twin of the user-clicked path in
   * `app-docs-surface.ts:handleEscalateComment`) it calls
   * `setActive(user_event.author_id, project_id)` so the chat
   * composer's next turn for that user sources the
   * `<escalated_comment_threads>` envelope from THIS project's sidecar
   * instead of falling back to the hardcoded `'default'`.
   *
   * Optional: legacy boot paths and the existing
   * `agent-watcher.test.ts` harness pass nothing — the auto-escalate
   * event still lands in the sidecar (same shape as pre-#44), only
   * the registry-pin side-effect is skipped.
   */
  chat_session_projects?: WebChatSessionProjectRegistry
  /** Override the wall clock — tests inject a monotonic stub. */
  now?: () => number
  /**
   * Override the polling cadence for tests. Production runs at
   * `POLL_INTERVAL_MS`. Not exposed via the public options API
   * because file-level constants are the locked design; tests opt
   * in via the test-only options interface.
   */
  poll_interval_ms?: number
  /**
   * Override the per-reply LLM timeout for tests. Production runs at
   * `REPLY_TIMEOUT_MS` (90s); the LLM timeout case in the test
   * suite passes a much smaller value (200ms) so the test doesn't
   * wait 90s for the AbortController to fire.
   */
  reply_timeout_ms?: number
  /**
   * Override `setInterval` for fake-timer tests. Production uses
   * the global.
   */
  setInterval?: (handler: () => void, ms: number) => NodeJS.Timeout
  /**
   * Override `clearInterval` for fake-timer tests. Production uses
   * the global.
   */
  clearInterval?: (handle: NodeJS.Timeout) => void
}

/**
 * Per-comment pipeline outcome. Surfaced from `tickOnce` so tests
 * can assert exact counts without re-querying the events log.
 */
export interface AgentTickResult {
  processed_projects: number
  processed_comments: number
  agent_replies: number
  escalations: number
  skipped: number
}

interface CursorFileContent {
  last_processed_event_id: string | null
}

export class AgentWatcher {
  private readonly comment_store: CommentStore
  private readonly llm_call: AgentWatcherLlmCall
  private readonly owner_home: string
  private readonly doc_read: (
    project_id: string,
    doc_path: string,
  ) => Promise<string | null>
  private readonly list_active_projects: () => Promise<string[]>
  private readonly with_project_lock: <T>(
    project_id: string,
    fn: () => Promise<T>,
  ) => Promise<T>
  private readonly chat_session_projects: WebChatSessionProjectRegistry | null
  private readonly nowFn: () => number
  private readonly poll_interval_ms: number
  private readonly reply_timeout_ms: number
  private readonly setIntervalFn: (
    handler: () => void,
    ms: number,
  ) => NodeJS.Timeout
  private readonly clearIntervalFn: (handle: NodeJS.Timeout) => void

  private interval: NodeJS.Timeout | null = null
  private running = false
  private stopped = false

  constructor(opts: AgentWatcherOptions) {
    this.comment_store = opts.comment_store
    this.llm_call = opts.llm_call
    this.owner_home = opts.owner_home
    this.doc_read = opts.doc_read
    this.list_active_projects = opts.list_active_projects
    this.with_project_lock = opts.with_project_lock
    this.chat_session_projects = opts.chat_session_projects ?? null
    this.nowFn = opts.now ?? ((): number => Date.now())
    this.poll_interval_ms = opts.poll_interval_ms ?? POLL_INTERVAL_MS
    this.reply_timeout_ms = opts.reply_timeout_ms ?? REPLY_TIMEOUT_MS
    this.setIntervalFn =
      opts.setInterval ??
      ((h, ms): NodeJS.Timeout =>
        setInterval(h, ms) as unknown as NodeJS.Timeout)
    this.clearIntervalFn =
      opts.clearInterval ??
      ((handle): void =>
        clearInterval(handle as unknown as ReturnType<typeof setInterval>))
  }

  /** Begin the polling interval. Idempotent — repeated `start()` is a no-op. */
  start(): void {
    if (this.interval !== null) return
    this.stopped = false
    this.interval = this.setIntervalFn(() => {
      void this.runTickGuarded()
    }, this.poll_interval_ms)
  }

  /**
   * Clear the polling interval. In-flight ticks drain naturally —
   * `stop()` does NOT block on the LLM call. Matches the existing
   * reminders/tick.ts pattern.
   */
  stop(): void {
    this.stopped = true
    if (this.interval !== null) {
      this.clearIntervalFn(this.interval)
      this.interval = null
    }
  }

  /**
   * Single-shot tick — exposed for tests. Production normally drives
   * this via the `setInterval` loop. Safe to call concurrently with
   * a running interval: the `running` boolean drops the second call
   * on the floor (single-flight) per the file-header tick mechanics.
   */
  async tickOnce(): Promise<AgentTickResult> {
    return this.runTick()
  }

  /* ─── internals ──────────────────────────────────────────────── */

  private async runTickGuarded(): Promise<void> {
    if (this.running || this.stopped) return
    this.running = true
    try {
      await this.runTick()
    } catch (err) {
      // Top-level guard — the per-project body already catches; this
      // is defense-in-depth so an enumeration failure can never
      // crash the gateway.
      structuredLog('warn', 'agent_watcher.tick_threw', {
        error_message: stringifyError(err),
      })
    } finally {
      this.running = false
    }
  }

  private async runTick(): Promise<AgentTickResult> {
    const result: AgentTickResult = {
      processed_projects: 0,
      processed_comments: 0,
      agent_replies: 0,
      escalations: 0,
      skipped: 0,
    }
    let projects: string[]
    try {
      projects = await this.list_active_projects()
    } catch (err) {
      structuredLog('warn', 'agent_watcher.list_projects_failed', {
        error_message: stringifyError(err),
      })
      return result
    }
    for (const project_id of projects) {
      if (this.stopped) break
      try {
        const per_project = await this.processProject(project_id)
        result.processed_projects += 1
        result.processed_comments += per_project.processed_comments
        result.agent_replies += per_project.agent_replies
        result.escalations += per_project.escalations
        result.skipped += per_project.skipped
      } catch (err) {
        // Per Plan Part B "Critical: the watcher must NEVER throw
        // uncaught — wrap every per-project tick in try/catch; log
        // + skip on error; cursor does NOT advance on uncaught
        // error". A thrown processProject means the cursor for THAT
        // project did not advance (the advance lives INSIDE the
        // per-comment loop and only fires on a successful append).
        structuredLog('warn', 'agent_watcher.project_threw', {
          project_id,
          error_message: stringifyError(err),
        })
      }
    }
    return result
  }

  private async processProject(
    project_id: string,
  ): Promise<{
    processed_comments: number
    agent_replies: number
    escalations: number
    skipped: number
  }> {
    const counts = {
      processed_comments: 0,
      agent_replies: 0,
      escalations: 0,
      skipped: 0,
    }
    const cursorPath = this.cursorPathFor(project_id)
    // Serialise the entire per-tick body via the shared project mutex.
    // Different projects still run concurrently (the mutex is keyed by
    // project_id). The LLM call happens INSIDE the locked region — this
    // is intentional: it serialises the watcher against the anchor
    // walker on the same project (prevents stale doc reads + double
    // cursor advance under concurrent tickOnce calls). The trade-off
    // against blocking unrelated HTTP POSTs is acceptable because the
    // HTTP POST path does NOT acquire this mutex (see plan Part B).
    return await this.with_project_lock(project_id, async () => {
      const cursor = await readCursorFile(cursorPath)
      let last_event_id = cursor.last_processed_event_id
      const events = await this.comment_store.listUserCommentsAfter(
        project_id,
        last_event_id,
        { limit: PER_TICK_MAX_REPLIES },
      )
      // Compute the high-water mark across ALL events past the cursor
      // (including agent-authored comments, walker events, escalations).
      // The cursor advances past these even when no user comments
      // exist, so the next tick doesn't re-scan them.
      const high_water = await this.comment_store.maxEventIdAfter(
        project_id,
        last_event_id,
      )
      if (events.length === 0) {
        if (high_water !== null && high_water !== last_event_id) {
          await writeCursorFile(cursorPath, {
            last_processed_event_id: high_water,
          })
        }
        return counts
      }
      for (const event of events) {
        if (this.stopped) break
        const outcome = await this.processOneComment(project_id, event)
        counts.processed_comments += 1
        if (outcome === 'agent_reply') counts.agent_replies += 1
        else if (outcome === 'escalation') counts.escalations += 1
        else counts.skipped += 1
        last_event_id = event.event_id
        await writeCursorFile(cursorPath, {
          last_processed_event_id: last_event_id,
        })
      }
      // After processing the user batch, advance to the high-water
      // mark to absorb any non-user events that happened to land at the
      // tail of the log between our user events. SAFETY: only do this
      // when we did NOT hit PER_TICK_MAX_REPLIES — if we did, there
      // may be unprocessed user comments past `last_event_id` (e.g.
      // the 21st user comment when the cap is 20), and `high_water`
      // (which is computed across ALL event kinds past the cursor)
      // would silently jump the cursor past them. Argus r2 BLOCKER:
      // leave the cursor at the last processed event_id when the cap
      // is hit so the next tick picks up the remainder.
      if (
        events.length < PER_TICK_MAX_REPLIES &&
        high_water !== null &&
        last_event_id !== null &&
        high_water > last_event_id
      ) {
        await writeCursorFile(cursorPath, {
          last_processed_event_id: high_water,
        })
      }
      return counts
    })
  }

  /**
   * Run the reply pipeline for ONE user comment. Returns the outcome
   * shape so the per-project counter can tally agent_replies vs
   * escalations vs skipped.
   *
   * Concurrency model (post-Argus P7.2 S3 round 1):
   *   - This method runs INSIDE `with_project_lock` (acquired by the
   *     outer `processProject` tick body). The LLM call, the doc read,
   *     and the terminal `appendEvent` all happen inside that lock so
   *     a walker event on the same project can't interleave with the
   *     watcher's read-build-write sequence.
   *   - Different projects still run concurrently (the mutex is keyed
   *     by `project_id`).
   */
  private async processOneComment(
    project_id: string,
    event: DocCommentEvent,
  ): Promise<'agent_reply' | 'escalation' | 'skipped'> {
    // doc_read happens inside the outer per-project lock too —
    // serialising against the walker on the same project prevents
    // stale doc reads while a concurrent walker mutation is in flight.
    let body: string | null = null
    try {
      body = await this.doc_read(project_id, event.doc_path)
    } catch (err) {
      structuredLog('warn', 'agent_watcher.doc_read_threw', {
        project_id,
        doc_path: event.doc_path,
        user_event_id: event.event_id,
        error_message: stringifyError(err),
      })
      body = null
    }
    if (body === null) {
      await this.appendSkipped(project_id, event, {
        reason: 'doc_missing',
        thread_root_id: event.thread_root_id ?? event.event_id,
        user_event_id: event.event_id,
      })
      return 'skipped'
    }
    const excerpt_block = buildDocExcerpt(body, event.anchor_start)
    const anchor_excerpt = event.anchor_text_excerpt ?? ''
    const thread_root_id = event.thread_root_id ?? event.event_id
    const prior_thread =
      thread_root_id === event.event_id
        ? '(this is the root of a new thread; no prior replies)'
        : await this.formatPriorThread(project_id, thread_root_id, event.event_id)
    const system = buildWatcherSystemPrompt({
      doc_path: event.doc_path,
      anchor_excerpt,
      doc_excerpt_with_line_numbers: excerpt_block,
      thread_replies_concat: prior_thread,
    })
    const user_body = event.body ?? ''

    let reply_text: string
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => {
        controller.abort()
      }, this.reply_timeout_ms)
      try {
        const result = await this.llm_call({
          system,
          messages: [{ role: 'user', content: user_body }],
          max_tokens: REPLY_MAX_TOKENS,
          signal: controller.signal,
        })
        reply_text = (result.text ?? '').trim()
      } finally {
        clearTimeout(timeout)
      }
    } catch (err) {
      const reason = classifySkipReason(err)
      await this.appendSkipped(project_id, event, {
        reason,
        thread_root_id,
        user_event_id: event.event_id,
        error_message: stringifyError(err),
      })
      return 'skipped'
    }

    if (reply_text.length === 0) {
      await this.appendSkipped(project_id, event, {
        reason: 'llm_error',
        thread_root_id,
        user_event_id: event.event_id,
        error_message: 'empty_reply',
      })
      return 'skipped'
    }

    if (matchesEscalation(reply_text)) {
      try {
        await this.appendEscalation(project_id, event, {
          thread_root_id,
          reply_text,
        })
        return 'escalation'
      } catch (err) {
        // Escalation event write failed — fall through to a skip event
        // so the side-pane shows the failure instead of hanging the
        // thread in "agent thinking…" forever.
        await this.appendSkipped(project_id, event, {
          reason: 'llm_error',
          thread_root_id,
          user_event_id: event.event_id,
          error_message: stringifyError(err),
        })
        return 'skipped'
      }
    }

    try {
      await this.appendAgentReply(project_id, event, {
        thread_root_id,
        reply_text,
      })
      return 'agent_reply'
    } catch (err) {
      // Agent reply write failed — fall through to a skip event so the
      // side-pane shows the failure instead of hanging the thread in
      // "agent thinking…" forever. If appendSkipped ALSO fails, we let
      // the error propagate so the outer tick body abandons the cursor
      // advance for this project.
      await this.appendSkipped(project_id, event, {
        reason: 'llm_error',
        thread_root_id,
        user_event_id: event.event_id,
        error_message: stringifyError(err),
      })
      return 'skipped'
    }
  }

  private async formatPriorThread(
    project_id: string,
    thread_root_id: string,
    exclude_event_id: string,
  ): Promise<string> {
    // Best-effort — a failure here should not abort the reply pipeline.
    let tree
    try {
      tree = await this.comment_store.getThread(project_id, thread_root_id)
    } catch {
      return '(prior thread unavailable)'
    }
    const ordered = [tree.root, ...tree.replies].filter(
      (e) => e.event_id !== exclude_event_id && (e.body ?? '').length > 0,
    )
    if (ordered.length === 0) return '(no prior replies)'
    const lines: string[] = []
    for (const e of ordered) {
      const body = (e.body ?? '').replace(/\s+/g, ' ').trim()
      lines.push(`${e.author_kind}:${e.author_id} — ${body}`)
    }
    return lines.join('\n---\n')
  }

  private async appendAgentReply(
    project_id: string,
    user_event: DocCommentEvent,
    fields: { thread_root_id: string; reply_text: string },
  ): Promise<void> {
    const input: AppendEventInput = {
      event_kind: 'comment_posted',
      doc_path: user_event.doc_path,
      thread_root_id: fields.thread_root_id,
      parent_event_id: user_event.event_id,
      anchor_start: null,
      anchor_end: null,
      anchor_text_excerpt: null,
      anchor_ctx_before: null,
      anchor_ctx_after: null,
      based_on_modified_at: null,
      author_kind: AGENT_AUTHOR_KIND,
      author_id: AGENT_AUTHOR_ID,
      body: fields.reply_text,
      metadata_json: null,
    }
    // Lock is already held by the outer tick body — direct call.
    await this.comment_store.appendEvent(project_id, input)
  }

  private async appendEscalation(
    project_id: string,
    user_event: DocCommentEvent,
    fields: { thread_root_id: string; reply_text: string },
  ): Promise<void> {
    // Pull the existing thread context to stamp into metadata_json so
    // the chat-surface seed has self-contained context (the chat
    // composer will read this metadata via the escalation-loader).
    //
    // Schema upgrade (ISSUE #42): `comment_body_history` is now an
    // ARRAY of `{author, body, timestamp}` entries (was a bare string
    // pre-#42). The renderer in `escalation-loader.ts` reads this on
    // agent-triggered escalations so it can label each `<comment>` tag
    // with `author="user"` vs `author="agent"`. The watcher's own
    // reply is NOT going to land in `doc_comment_events` as a
    // `comment_posted` row (intentional — self-reply guard prevents a
    // feedback loop), so this array is the ONLY surface where the
    // chat composer sees the agent's last word. Legacy bare-string
    // records still render via the back-compat parser in the loader.
    const reply_trimmed = fields.reply_text.replace(/\s+/g, ' ').trim()
    let comment_body_history: EscalateCommentBodyHistoryEntry[]
    try {
      const tree = await this.comment_store.getThread(
        project_id,
        fields.thread_root_id,
      )
      const ordered = [tree.root, ...tree.replies]
      const history: EscalateCommentBodyHistoryEntry[] = []
      for (const e of ordered) {
        const body = (e.body ?? '').replace(/\s+/g, ' ').trim()
        if (body.length === 0) continue
        history.push({
          author: e.author_kind === 'user' ? 'user' : 'agent',
          body,
          timestamp: e.created_at,
        })
      }
      // Append the just-generated reply too so the chat composer sees
      // the FULL context. The watcher's reply timestamp uses the
      // injected clock (test seam parity with other side effects).
      history.push({
        author: 'agent',
        body: reply_trimmed,
        timestamp: this.nowFn(),
      })
      comment_body_history = history
    } catch {
      // Best-effort — fall back to just the new reply.
      comment_body_history = [
        { author: 'agent', body: reply_trimmed, timestamp: this.nowFn() },
      ]
    }
    const metadata: Record<string, unknown> = {
      thread_root_id: fields.thread_root_id,
      doc_path: user_event.doc_path,
      anchor_excerpt: user_event.anchor_text_excerpt ?? '',
      comment_body_history,
      trigger: 'agent_escalation',
    }
    const input: AppendEventInput = {
      event_kind: 'escalate_to_chat',
      doc_path: user_event.doc_path,
      thread_root_id: fields.thread_root_id,
      parent_event_id: user_event.event_id,
      anchor_start: null,
      anchor_end: null,
      anchor_text_excerpt: null,
      anchor_ctx_before: null,
      anchor_ctx_after: null,
      based_on_modified_at: null,
      author_kind: AGENT_AUTHOR_KIND,
      author_id: AGENT_AUTHOR_ID,
      body: null,
      metadata_json: JSON.stringify(metadata),
    }
    // Lock is already held by the outer tick body — direct call.
    await this.comment_store.appendEvent(project_id, input)
    // ISSUE #44 — pin the comment author's "current chat project_id" to
    // the project we just auto-escalated from. Mirrors the user-clicked
    // path in `app-docs-surface.ts:handleEscalateComment`; the chat
    // composer's per-turn LLM wrapper reads this on the very next chat
    // turn (via the closure threaded into `buildPhaseSpecResolver`) so
    // the rendered `<escalated_comment_threads>` envelope sources from
    // THIS sidecar, not the hardcoded `default` project the pre-#41
    // wiring assumed. user_event.author_id is the user_id of the
    // comment poster: `listUserCommentsAfter` filters for
    // `author_kind='user'`, so `author_id` IS the canonical user_id.
    // When chat_session_projects is null (legacy boot paths, the
    // existing watcher-only test harness that exercises only the
    // comments surface) the escalate event still lands in the
    // sidecar — same shape as before this fix.
    if (this.chat_session_projects !== null) {
      this.chat_session_projects.setActive(user_event.author_id, project_id)
    }
  }

  private async appendSkipped(
    project_id: string,
    user_event: DocCommentEvent,
    fields: {
      reason: SkipReason
      thread_root_id: string
      user_event_id: string
      error_message?: string
    },
  ): Promise<void> {
    const metadata: Record<string, unknown> = {
      reason: fields.reason,
      thread_root_id: fields.thread_root_id,
      user_event_id: fields.user_event_id,
    }
    if (fields.error_message !== undefined) {
      metadata.error_message = fields.error_message
    }
    const input: AppendEventInput = {
      event_kind: 'agent_reply_skipped',
      doc_path: user_event.doc_path,
      thread_root_id: fields.thread_root_id,
      parent_event_id: user_event.event_id,
      anchor_start: null,
      anchor_end: null,
      anchor_text_excerpt: null,
      anchor_ctx_before: null,
      anchor_ctx_after: null,
      based_on_modified_at: null,
      author_kind: AGENT_AUTHOR_KIND,
      author_id: AGENT_AUTHOR_ID,
      body: null,
      metadata_json: JSON.stringify(metadata),
    }
    // Lock is already held by the outer tick body — direct call.
    await this.comment_store.appendEvent(project_id, input)
  }

  private cursorPathFor(project_id: string): string {
    return join(
      this.owner_home,
      'Projects',
      project_id,
      '.comments',
      'watcher-cursor.json',
    )
  }
}

/* ─── pure helpers (exported for tests) ──────────────────────────── */

/**
 * Build the doc excerpt block the watcher hands to the LLM as
 * `SURROUNDING CONTEXT`. Takes ±EXCERPT_CONTEXT_LINES around the line
 * containing `anchor_start`; falls back to the whole body when the
 * anchor offset is missing or the body is shorter.
 *
 * Lines are 1-indexed in the output so the model can reason about
 * "line 42" without an off-by-one mental tax.
 */
export function buildDocExcerpt(
  body: string,
  anchor_start: number | null,
): string {
  const lines = body.split('\n')
  if (lines.length === 0) return ''
  let anchor_line = 0
  if (anchor_start !== null && anchor_start > 0) {
    let consumed = 0
    for (let i = 0; i < lines.length; i++) {
      const line_len = (lines[i] ?? '').length + 1 // +1 for '\n'
      if (consumed + line_len > anchor_start) {
        anchor_line = i
        break
      }
      consumed += line_len
    }
  }
  const start = Math.max(0, anchor_line - EXCERPT_CONTEXT_LINES)
  const end = Math.min(lines.length, anchor_line + EXCERPT_CONTEXT_LINES + 1)
  const out: string[] = []
  for (let i = start; i < end; i++) {
    const line_num = i + 1
    out.push(`${line_num.toString().padStart(5, ' ')}: ${lines[i] ?? ''}`)
  }
  return out.join('\n')
}

/**
 * Build the watcher's full system prompt — concatenates the locked
 * preamble + the per-comment doc context. Exported so the test suite
 * can assert specific substrings without re-implementing the prompt
 * template.
 */
export function buildWatcherSystemPrompt(input: {
  doc_path: string
  anchor_excerpt: string
  doc_excerpt_with_line_numbers: string
  thread_replies_concat: string
}): string {
  return [
    'You are the project\'s inline-comment reply agent. A user has commented',
    'on an excerpt of a document. Your job is to answer the comment with a',
    'SHORT, single-paragraph reply (max 4 sentences) appropriate for an',
    'inline comment thread.',
    '',
    'GUIDELINES:',
    '- If the comment is a question about the document, answer it using the',
    '  context provided.',
    '- If the comment is an observation or "FYI", acknowledge briefly OR',
    '  defer with "noted".',
    '- If the comment opens a topic that needs deeper discussion than a',
    '  single paragraph can cover, end your reply with "Let\'s continue in',
    '  chat." — the user can then move the thread to a full chat',
    '  conversation via the escalate button.',
    '- NEVER reply with markdown formatting (no bold, no code fences, no',
    '  bullets). Plain prose only — comments render as plain text.',
    '- NEVER include the user\'s body in your reply verbatim.',
    '',
    `DOCUMENT PATH: ${input.doc_path}`,
    `ANCHORED EXCERPT: ${input.anchor_excerpt}`,
    'SURROUNDING CONTEXT (±100 lines around anchor):',
    input.doc_excerpt_with_line_numbers,
    '',
    'PRIOR THREAD (if any):',
    input.thread_replies_concat,
  ].join('\n')
}

/**
 * Case-insensitive substring match against `ESCALATION_KEYWORDS`.
 * Exported so the test suite can assert keyword behavior without
 * re-implementing the matcher.
 */
export function matchesEscalation(reply_text: string): boolean {
  const lowered = reply_text.toLowerCase()
  for (const keyword of ESCALATION_KEYWORDS) {
    if (lowered.includes(keyword)) return true
  }
  return false
}

/* ─── cursor file I/O ────────────────────────────────────────────── */

/**
 * Read the persisted cursor file. Returns
 * `{last_processed_event_id: null}` on any of:
 *   - File missing (first run for this project).
 *   - File is a symlink (ISSUE #37 parity — never follow owner-
 *     writable symlinks).
 *   - File is malformed JSON.
 *
 * Mirrors `persona-loader.ts`'s lstat + O_NOFOLLOW rejection pattern.
 */
async function readCursorFile(path: string): Promise<CursorFileContent> {
  let st: Awaited<ReturnType<typeof lstat>>
  try {
    st = await lstat(path)
  } catch {
    return { last_processed_event_id: null }
  }
  if (st.isSymbolicLink()) {
    structuredLog('warn', 'agent_watcher.cursor_rejected_symlink', {
      path,
    })
    return { last_processed_event_id: null }
  }
  let raw: string
  let fh: Awaited<ReturnType<typeof open>>
  try {
    fh = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  } catch (err) {
    structuredLog('warn', 'agent_watcher.cursor_open_failed', {
      path,
      error_message: stringifyError(err),
    })
    return { last_processed_event_id: null }
  }
  try {
    raw = await fh.readFile('utf8')
  } catch (err) {
    structuredLog('warn', 'agent_watcher.cursor_read_failed', {
      path,
      error_message: stringifyError(err),
    })
    return { last_processed_event_id: null }
  } finally {
    await fh.close()
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'last_processed_event_id' in parsed
    ) {
      const value = (parsed as Record<string, unknown>).last_processed_event_id
      if (typeof value === 'string' && value.length > 0) {
        return { last_processed_event_id: value }
      }
      if (value === null) {
        return { last_processed_event_id: null }
      }
    }
  } catch (err) {
    structuredLog('warn', 'agent_watcher.cursor_parse_failed', {
      path,
      error_message: stringifyError(err),
    })
  }
  return { last_processed_event_id: null }
}

/**
 * Atomically persist the cursor — write to `<path>.tmp-<rand>` and
 * rename over the target. Mirrors `doc-store.ts:509-523`. Best-effort:
 * a failure logs + throws so the calling tick body can let the lock
 * release without retrying — the next tick will re-discover the same
 * tail of events and try again.
 */
async function writeCursorFile(
  path: string,
  content: CursorFileContent,
): Promise<void> {
  const tempPath = `${path}.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const body = JSON.stringify(content)
  await writeFile(tempPath, body, 'utf8')
  try {
    await rename(tempPath, path)
  } catch (err) {
    try {
      await unlink(tempPath)
    } catch {
      /* ignore */
    }
    throw err
  }
}

/* ─── error / log helpers ────────────────────────────────────────── */

function classifySkipReason(err: unknown): SkipReason {
  if (err === null || err === undefined) return 'llm_error'
  // AbortController-driven timeout — DOMException name is 'AbortError'
  // when the signal was aborted by the watcher's timeout.
  if (typeof err === 'object' && err !== null && 'name' in err) {
    const name = (err as { name?: unknown }).name
    if (name === 'AbortError' || name === 'TimeoutError') return 'timeout'
  }
  // Loose shape match: errors thrown by `selectCredential(...) === null`
  // path from `build-agent-watcher-llm-call.ts`.
  if (err instanceof Error) {
    const msg = err.message
    if (msg.includes('no credential available')) return 'no_credentials'
    if (/429|rate.?limit|rate_limited|too many requests/i.test(msg)) {
      return 'rate_limited'
    }
  }
  // Shaped error object — common in tests + the runtime resilience
  // layer: `{kind: 'rate_limited'}` or `{kind: 'api_error'}`.
  if (typeof err === 'object' && err !== null && 'kind' in err) {
    const kind = (err as { kind?: unknown }).kind
    if (kind === 'rate_limited') return 'rate_limited'
    if (kind === 'timeout') return 'timeout'
  }
  return 'llm_error'
}

function structuredLog(
  level: 'info' | 'warn',
  event: string,
  fields: Record<string, unknown>,
): void {
  // Neutron's gateway uses console.warn / console.info with structured
  // JSON appended — see `gateway/index.ts:3923` (anchor-walker wiring)
  // for the same shape. No `gateway/logging.ts` module exists; the
  // structured format is convention-by-grep.
  const line = `[${event}] ${JSON.stringify(fields)}`
  if (level === 'warn') console.warn(line)
  else console.info(line)
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message
  try {
    return String(err)
  } catch {
    return '<unstringifiable>'
  }
}
