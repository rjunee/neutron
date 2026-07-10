/**
 * @neutronai/channels — DB-backed button-prompt registry.
 *
 * Per docs/plans/P2-onboarding.md § 4.2. One row per outbound button prompt
 * the agent emits; the channel layer writes on emit + reads on inbound
 * callback for routing.
 *
 * Idempotency: `(topic_id, idempotency_key)` is a UNIQUE index on
 * `button_prompts` (migration 0010). Re-emit with the same key returns the
 * existing row's `prompt_id` and was_new=false; the channel adapter SHOULD
 * skip the upstream `sendMessage` call so we don't double-render.
 *
 * Expiration: `sweepExpired(now)` walks unresolved prompts whose
 * `expires_at < now` and resolves them with `__timeout__`. The sweep
 * returns the synthesized `ButtonChoice[]` so the gateway tick can route
 * them into the agent's interview engine.
 */

import { randomUUID } from 'node:crypto'

import type { ProjectDb } from '@neutronai/persistence/index.ts'
import { parseJsonColumn } from '@neutronai/persistence/index.ts'
import {
  validateButtonPrompt,
  type ButtonChoice,
  type ButtonOption,
  type ButtonPrompt,
  type ChannelKindForButton,
  DEFAULT_EXPIRES_IN_MS,
} from './button-primitive.ts'

export type ButtonStoreErrorCode =
  | 'prompt_not_found'
  | 'expired'
  | 'project_mismatch'
  | 'db_write_failed'
  | 'invalid_prompt'

export class ButtonStoreError extends Error {
  override readonly name = 'ButtonStoreError'
  constructor(
    readonly code: ButtonStoreErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message)
  }
}

export interface ButtonStoreOptions {
  db: ProjectDb
  now?: () => number
}

export interface EmitInput {
  topic_id: string
}

export interface EmitResult {
  prompt_id: string
  was_new: boolean
  /** True when the prompt has already been marked delivered upstream. On a
   *  first emit this is always false; on an idempotent re-emit (was_new:
   *  false) callers MUST inspect this flag and re-render when it is also
   *  false — otherwise a row that landed in the DB but never reached
   *  Telegram (e.g. transient send failure on the prior call) would stay
   *  un-rendered forever. */
  was_delivered: boolean
  /** The persisted prompt — same shape as input but `prompt_id` may have
   *  been replaced when an idempotency hit collapsed onto an existing row. */
  prompt: ButtonPrompt
  expires_at: number
}

export interface ResolveInput {
  /** From the inbound channel callback. */
  choice: ButtonChoice
}

export interface ResolveResult {
  prompt: ButtonPrompt
  /** True on first resolve; false on duplicate channel callbacks (idempotent). */
  was_new: boolean
  /** The choice as persisted (may be the prior choice if was_new=false). */
  choice: ButtonChoice
}

interface PromptRow {
  prompt_id: string
  topic_id: string
  body: string
  options_json: string
  allow_freeform: number
  expires_at: number
  idempotency_key: string | null
  created_at: number
  delivered_at: number | null
  resolved_at: number | null
  resolution_value: string | null
  resolution_freeform_text: string | null
  resolution_speaker_user_id: string | null
  resolution_channel_kind: string | null
  /** Sprint 28 Codex r4 P2 — 'buttons' | 'image-gallery' | NULL. */
  kind: string | null
}

const SELECT_PROMPT_COLS = `prompt_id, topic_id, body, options_json, allow_freeform,
                            expires_at, idempotency_key, created_at, delivered_at,
                            resolved_at, resolution_value, resolution_freeform_text,
                            resolution_speaker_user_id, resolution_channel_kind, kind`

/** Resolution values that came from a synthetic (non-user) source. The
 *  expired-replace path treats only NON-synthetic resolutions as the
 *  audit trail of a real answer. */
const RESERVED_RESOLUTION_VALUES: ReadonlySet<string> = new Set([
  '__timeout__',
  '__cancel__',
])

export class ButtonStore {
  private readonly db: ProjectDb
  private readonly now: () => number

  constructor(opts: ButtonStoreOptions) {
    this.db = opts.db
    this.now = opts.now ?? ((): number => Date.now())
  }

  /**
   * Persist a new prompt. Idempotent on `(topic_id, idempotency_key)` — a
   * second emit with the same key returns the existing row and `was_new:
   * false`. Validates the input prompt before any DB work; a malformed
   * prompt throws `ButtonStoreError(code:'invalid_prompt')` so the caller
   * doesn't half-render an invalid keyboard.
   */
  async emit(prompt: ButtonPrompt, ctx: EmitInput): Promise<EmitResult> {
    try {
      validateButtonPrompt(prompt)
    } catch (err) {
      throw new ButtonStoreError(
        'invalid_prompt',
        err instanceof Error ? err.message : String(err),
        err,
      )
    }
    if (typeof ctx.topic_id !== 'string' || ctx.topic_id.length === 0) {
      throw new ButtonStoreError(
        'invalid_prompt',
        `ctx.topic_id required`,
      )
    }

    const idempotency_key = prompt.idempotency_key ?? null
    const now_for_emit = this.now()
    if (idempotency_key !== null) {
      const existing = this.db
        .prepare<PromptRow, [string, string]>(
          `SELECT ${SELECT_PROMPT_COLS}
             FROM button_prompts
            WHERE topic_id = ? AND idempotency_key = ?`,
        )
        .get(ctx.topic_id, idempotency_key)
      if (existing) {
        // Codex r4 + r6 — an expired row is REPLACED on re-emit unless
        // it carries a real user resolution (the audit trail of an
        // already-answered question). The replace cases:
        //   - undelivered + unresolved + expired: previous start()
        //     persisted but never sent (transient send failure); time
        //     passed; reusing the prompt_id would render an inert
        //     keyboard whose every tap returns delivered:false.
        //   - delivered + unresolved + expired: keyboard reached the
        //     user but expired before they tapped; reusing skips the
        //     send and the user is stuck looking at the old keyboard.
        //   - delivered + resolved-by-sweep (__timeout__) + expired:
        //     sweepExpired timed it out without a real answer; we
        //     want a fresh prompt for the next attempt.
        //   - delivered + resolved-by-app-socket-cancel + expired:
        //     same shape — no real answer landed.
        // The preserve case:
        //   - resolved-by-real-user-choice + expired: the user
        //     answered (option.value or freeform). The row IS the
        //     audit trail. Returned unchanged so a non-engine caller
        //     re-emitting with the same key surfaces "already
        //     answered" rather than overwriting history. (The engine
        //     itself never re-enters this path because state.phase
        //     advances past signup the moment the user answers.)
        const isUserResolved =
          existing.resolved_at !== null &&
          existing.resolution_value !== null &&
          !RESERVED_RESOLUTION_VALUES.has(existing.resolution_value)
        const expired = existing.expires_at <= now_for_emit
        if (expired && !isUserResolved) {
          await this.db.run(`DELETE FROM button_prompts WHERE prompt_id = ?`, [existing.prompt_id])
        } else {
          return {
            prompt_id: existing.prompt_id,
            was_new: false,
            was_delivered: existing.delivered_at !== null,
            prompt: rowToPrompt(existing),
            expires_at: existing.expires_at,
          }
        }
      }
    }

    const expires_in_ms = prompt.expires_in_ms ?? DEFAULT_EXPIRES_IN_MS
    const created_at = this.now()
    const expires_at = created_at + expires_in_ms
    const options_json = JSON.stringify(prompt.options)

    try {
      await this.db.run(
        `INSERT INTO button_prompts
           (prompt_id, topic_id, body, options_json, allow_freeform,
            expires_at, idempotency_key, created_at, kind)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          prompt.prompt_id,
          ctx.topic_id,
          prompt.body,
          options_json,
          prompt.allow_freeform ? 1 : 0,
          expires_at,
          idempotency_key,
          created_at,
          prompt.kind ?? null,
        ],
      )
    } catch (err) {
      // The UNIQUE (topic_id, idempotency_key) index can race with a
      // concurrent emit; re-read on conflict so the caller still gets a
      // deterministic { was_new: false } shape rather than a 500.
      if (idempotency_key !== null && isUniqueViolation(err)) {
        const existing = this.db
          .prepare<PromptRow, [string, string]>(
            `SELECT ${SELECT_PROMPT_COLS}
               FROM button_prompts
              WHERE topic_id = ? AND idempotency_key = ?`,
          )
          .get(ctx.topic_id, idempotency_key)
        if (existing) {
          return {
            prompt_id: existing.prompt_id,
            was_new: false,
            was_delivered: existing.delivered_at !== null,
            prompt: rowToPrompt(existing),
            expires_at: existing.expires_at,
          }
        }
      }
      throw new ButtonStoreError('db_write_failed', `insert failed`, err)
    }

    return {
      prompt_id: prompt.prompt_id,
      was_new: true,
      was_delivered: false,
      prompt: { ...prompt, expires_in_ms },
      expires_at,
    }
  }

  /**
   * 2026-06-20 (chat-polish A) — persist an already-delivered agent
   * statement as an INERT, already-RESOLVED history turn in a SINGLE
   * atomic INSERT. Used by the wow channel adapter's `sendText` to make
   * the first-week brief (and every wow text statement) survive a reload
   * via `GET /api/v1/chat/history`.
   *
   * Why a dedicated single-statement method rather than `emit()` +
   * `resolve()`: those are two separate writes. If `resolve()` threw,
   * timed out, or the process died between them, the emitted row would be
   * left UNRESOLVED — and an unresolved zero-option row is treated as the
   * topic's ACTIVE prompt by the history re-emit + live-agent user-turn
   * persistence paths, so the user's next message would attach to the
   * brief instead of the brief staying an inert history-only bubble
   * (Codex cross-model review, 2026-06-20). One INSERT means there is no
   * intermediate unresolved state to leak.
   *
   * Render shape: `resolved_at` set + empty `resolution_value` + no
   * freeform → `rowToHistoryTurn` returns `{resolved:true,
   * resolution_text:''}`, which `landing/chat.ts:renderHistoricalTurn`
   * paints as an agent-only bubble (no button keyboard, no user-side
   * bubble). `delivered_at` is stamped because the caller only persists
   * AFTER a confirmed live delivery.
   *
   * No idempotency key: matches action 01's "re-running re-emits the
   * brief; older briefs stay in chat" contract.
   */
  async persistInertAgentTurn(input: {
    topic_id: string
    body: string
  }): Promise<{ prompt_id: string }> {
    if (typeof input.topic_id !== 'string' || input.topic_id.length === 0) {
      throw new ButtonStoreError('invalid_prompt', `persistInertAgentTurn requires a non-empty topic_id`)
    }
    if (typeof input.body !== 'string' || input.body.length === 0) {
      throw new ButtonStoreError('invalid_prompt', `persistInertAgentTurn requires a non-empty body`)
    }
    const prompt_id = randomUUID()
    const now = this.now()
    await this.db.run(
      `INSERT INTO button_prompts
         (prompt_id, topic_id, body, options_json, allow_freeform,
          expires_at, idempotency_key, created_at, delivered_at,
          resolved_at, resolution_value, resolution_speaker_user_id,
          resolution_channel_kind, kind)
       VALUES (?, ?, ?, '[]', 1, ?, NULL, ?, ?, ?, '', '__system__', 'webhook', NULL)`,
      [prompt_id, input.topic_id, input.body, now + DEFAULT_EXPIRES_IN_MS, now, now, now],
    )
    return { prompt_id }
  }

  /**
   * 2026-06-26 (Connect engagement mode) — persist a member's chat message as
   * an INERT, already-RESOLVED USER-side history turn in a SINGLE atomic
   * INSERT. The mirror of `persistInertAgentTurn`: the user's text lands in
   * `resolution_freeform_text` (not `body`), so `rowToHistoryTurn` returns
   * `{resolved:true, resolution_text:<text>}` and the renderer paints a
   * user-side bubble with NO agent bubble (the empty `body` is skipped by
   * `landing/chat.ts:renderHistoricalTurn`).
   *
   * Why this exists: in a `tag_gated` Connect project a non-mention post must
   * persist to the shared transcript WITHOUT an agent turn (spec §2). The first
   * such message stamps onto the prior unresolved agent prompt, but consecutive
   * quiet messages have no unresolved row to attach to — without a self-
   * contained row they would silently drop from hydrated history (Codex cross-
   * model review, 2026-06-26). One atomic INSERT means each gated message is
   * durable on its own, independent of any prior row.
   *
   * `resolved_at` + `delivered_at` are stamped (the message was delivered + is
   * inert history); `resolution_value` is the standard `__freeform__` marker so
   * the freeform render path fires.
   */
  async persistInertUserTurn(input: {
    topic_id: string
    text: string
    speaker_user_id: string
    channel_kind: string
  }): Promise<{ prompt_id: string }> {
    if (typeof input.topic_id !== 'string' || input.topic_id.length === 0) {
      throw new ButtonStoreError('invalid_prompt', `persistInertUserTurn requires a non-empty topic_id`)
    }
    if (typeof input.text !== 'string' || input.text.length === 0) {
      throw new ButtonStoreError('invalid_prompt', `persistInertUserTurn requires non-empty text`)
    }
    const prompt_id = randomUUID()
    const now = this.now()
    await this.db.run(
      `INSERT INTO button_prompts
         (prompt_id, topic_id, body, options_json, allow_freeform,
          expires_at, idempotency_key, created_at, delivered_at,
          resolved_at, resolution_value, resolution_freeform_text,
          resolution_speaker_user_id, resolution_channel_kind, kind)
       VALUES (?, ?, '', '[]', 1, ?, NULL, ?, ?, ?, '__freeform__', ?, ?, ?, NULL)`,
      [
        prompt_id,
        input.topic_id,
        now + DEFAULT_EXPIRES_IN_MS,
        now,
        now,
        now,
        input.text,
        input.speaker_user_id,
        input.channel_kind,
      ],
    )
    return { prompt_id }
  }

  /**
   * Peek at a prompt's lifecycle metadata without round-tripping the
   * full ButtonPrompt shape. Returns null when the row is missing.
   * Used by `InterviewEngine.start` to decide between reuse / advance /
   * fresh-emit on duplicate starts and crash-recovery paths.
   */
  async peek(prompt_id: string): Promise<{
    delivered_at: number | null
    resolved_at: number | null
    resolution_value: string | null
    resolution_freeform_text: string | null
    expires_at: number
    topic_id: string
  } | null> {
    const row = this.db
      .prepare<
        {
          delivered_at: number | null
          resolved_at: number | null
          resolution_value: string | null
          resolution_freeform_text: string | null
          expires_at: number
          topic_id: string
        },
        [string]
      >(
        `SELECT delivered_at, resolved_at, resolution_value,
                resolution_freeform_text, expires_at, topic_id
           FROM button_prompts
          WHERE prompt_id = ?`,
      )
      .get(prompt_id)
    if (!row) return null
    return row
  }

  /**
   * Returns the persisted `delivered_at` for a prompt, or null when the
   * prompt is missing OR not yet marked delivered. Used by callers that
   * need to distinguish "row exists, not yet delivered" from "row exists,
   * already delivered" without round-tripping the full ButtonPrompt
   * shape.
   */
  async deliveredAt(prompt_id: string): Promise<number | null> {
    const row = this.db
      .prepare<{ delivered_at: number | null }, [string]>(
        `SELECT delivered_at FROM button_prompts WHERE prompt_id = ?`,
      )
      .get(prompt_id)
    if (!row) return null
    return row.delivered_at
  }

  /**
   * Mark the prompt as delivered upstream (e.g. Telegram sendMessage
   * accepted). Idempotent — calling twice is a no-op. The first call
   * sets `delivered_at`; subsequent calls leave it unchanged so the
   * audit trail reflects the FIRST delivery, not the latest re-render.
   */
  async markDelivered(prompt_id: string, when?: number): Promise<void> {
    const ts = when ?? this.now()
    await this.db.run(
      `UPDATE button_prompts
          SET delivered_at = COALESCE(delivered_at, ?)
        WHERE prompt_id = ?`,
      [ts, prompt_id],
    )
  }

  /**
   * S16 (2026-05-17) — rebind a prompt row's `topic_id` to the channel
   * the engine actually just re-emitted on. Used by
   * `InterviewEngine.start`'s reconnect re-emit branch after the slug-
   * rename WS-race recovery: the original emit landed on a topic_id
   * whose WS died mid-flow, the new WS reconnected on a different
   * topic_id, and the engine re-routed the re-emit to the live socket.
   * Persisting that rebind here is what keeps the NEXT reconnect from
   * spuriously re-firing the same prompt (`meta.topic_id !==
   * input.topic_id` would otherwise stay true forever and the user
   * would see a duplicate bubble on every refresh).
   *
   * Safety against the `(topic_id, idempotency_key)` UNIQUE index: the
   * idempotency_key itself folds `topic_id` into its hash input
   * (see `channels/button-primitive.ts:deriveIdempotencyKey`), so the
   * rebind cannot land on a tuple that already exists for a different
   * prompt — that would require a sha256 collision on
   * `sha256(project_slug:topic_id:seed) → sha256(project_slug:other_topic_id:seed)`.
   * Even so we guard with `WHERE prompt_id = ?` so the rebind only
   * touches the exact row the caller named.
   */
  async rebindTopicId(prompt_id: string, new_topic_id: string): Promise<void> {
    if (typeof new_topic_id !== 'string' || new_topic_id.length === 0) {
      throw new ButtonStoreError(
        'invalid_prompt',
        `rebindTopicId requires a non-empty new_topic_id (prompt_id=${prompt_id})`,
      )
    }
    await this.db.run(
      `UPDATE button_prompts
          SET topic_id = ?
        WHERE prompt_id = ?`,
      [new_topic_id, prompt_id],
    )
  }

  /**
   * Returns the persisted prompt for `prompt_id`, or null when absent OR
   * when the row exists, hasn't been resolved yet, AND is past its
   * `expires_at` at the supplied observation time. Already-resolved
   * expired prompts ARE returned so the router can surface "you already
   * answered this" idempotency. A prompt that expired without ever
   * being resolved is treated as inactive — a tap arriving in that
   * window returns `delivered: false` from the router (rather than
   * racing the cron-tick `sweepExpired`).
   *
   * `observed_at` is the wall clock the CALLER witnessed (e.g. the
   * Telegram callback's `chosen_at`). Threading it through avoids the
   * race Codex r2 P2.1 flagged: a callback observed at T<expires_at
   * could be rejected as expired if `get()` defaulted to a later
   * `Date.now()`, and vice versa. Defaults to `this.now()` when omitted
   * (legacy callers / sweep paths that don't yet have an observation).
   */
  async get(prompt_id: string, observed_at?: number): Promise<ButtonPrompt | null> {
    const row = this.db
      .prepare<PromptRow, [string]>(
        `SELECT ${SELECT_PROMPT_COLS}
           FROM button_prompts
          WHERE prompt_id = ?`,
      )
      .get(prompt_id)
    if (!row) return null
    const cutoff = observed_at ?? this.now()
    // The contract says a tap at `T >= expires_at` loses; use `<=` so
    // the exact deadline is rejected (Codex r3 P3).
    //
    // Codex r10 P2 — also hide expired rows that were resolved by a
    // sentinel (sweepExpired's __timeout__, app-socket's __cancel__).
    // Otherwise a late Telegram tap on a swept-out keyboard gets
    // routed as `delivered:true` replaying the synthetic resolution,
    // which masks the timeout/cancel semantics. Real user resolutions
    // (option.value or freeform) are still surfaced for idempotency
    // (the audit trail of "you already answered this").
    if (row.expires_at <= cutoff) {
      if (row.resolved_at === null) return null
      if (row.resolution_value !== null && RESERVED_RESOLUTION_VALUES.has(row.resolution_value)) {
        return null
      }
    }
    return rowToPrompt(row)
  }

  /**
   * Record a user's choice. Idempotent on duplicate channel callbacks:
   * a second resolve for the same `prompt_id` returns the prior choice
   * with `was_new: false`. Returns `{ prompt: <persisted shape> }` so the
   * caller can diff inputs vs persisted.
   */
  async resolve(input: ResolveInput): Promise<ResolveResult> {
    const choice = input.choice
    if (typeof choice.prompt_id !== 'string' || choice.prompt_id.length === 0) {
      throw new ButtonStoreError(
        'invalid_prompt',
        `choice.prompt_id required`,
      )
    }
    return await this.db.transaction(async (tx) => {
      const row = tx
        .prepare<PromptRow, [string]>(
          `SELECT ${SELECT_PROMPT_COLS}
             FROM button_prompts
            WHERE prompt_id = ?`,
        )
        .get(choice.prompt_id)
      if (!row) {
        throw new ButtonStoreError(
          'prompt_not_found',
          `no button_prompt for prompt_id=${choice.prompt_id}`,
        )
      }
      // Codex r2 P2.1 — expiry check uses the choice's observation time
      // (chosen_at) inside the transaction, so a callback observed at
      // T<expires_at always wins and a callback at T>=expires_at always
      // loses, regardless of how long routing took. Codex r3 P3 — `<=`
      // so the exact deadline rejects.
      if (row.resolved_at === null && row.expires_at <= choice.chosen_at) {
        throw new ButtonStoreError(
          'expired',
          `prompt_id=${choice.prompt_id} expired at ${row.expires_at}; tap observed at ${choice.chosen_at}`,
        )
      }
      if (row.resolved_at !== null) {
        const priorChoice: ButtonChoice = {
          prompt_id: row.prompt_id,
          choice_value: row.resolution_value ?? '',
          chosen_at: row.resolved_at,
          speaker_user_id: row.resolution_speaker_user_id ?? choice.speaker_user_id,
          channel_kind: (row.resolution_channel_kind as ChannelKindForButton | null) ?? choice.channel_kind,
        }
        if (row.resolution_freeform_text !== null) {
          priorChoice.freeform_text = row.resolution_freeform_text
        }
        return {
          prompt: rowToPrompt(row),
          was_new: false,
          choice: priorChoice,
        }
      }
      await tx.run(
        `UPDATE button_prompts
            SET resolved_at = ?,
                resolution_value = ?,
                resolution_freeform_text = ?,
                resolution_speaker_user_id = ?,
                resolution_channel_kind = ?
          WHERE prompt_id = ?`,
        [
          choice.chosen_at,
          choice.choice_value,
          choice.freeform_text ?? null,
          choice.speaker_user_id,
          choice.channel_kind,
          choice.prompt_id,
        ],
      )
      return {
        prompt: rowToPrompt(row),
        was_new: true,
        choice,
      }
    })
  }

  /**
   * Chat-history hydration (2026-05-28 sprint) — read paginated history
   * for a topic, oldest-first cursor walking via composite
   * `(created_at, prompt_id)` tuple to survive ms-collisions on
   * `created_at`. Used by `gateway/http/chat-history-surface.ts` to
   * serve `GET /api/v1/chat/history` on the per-instance chat surface.
   *
   * Selection rule:
   *   - resolved rows (`resolved_at IS NOT NULL`) — always included
   *     (they're the audit trail of historical turns)
   *   - unresolved rows — included ONLY when still alive
   *     (`expires_at > now`). Expired unresolved rows are "ghosts"
   *     that the next `emit()` will delete-and-replace; surfacing
   *     them would render a turn whose prompt_id no longer maps to
   *     anything live.
   *
   * Per-row `options_json` parse is defensive: on a JSON.parse
   * failure the row is still returned but its `resolution_text` for a
   * resolved row falls back to the raw `resolution_value` (or null
   * for unresolved). A single corrupt row does NOT 500 the batch.
   *
   * Server-side `resolution_text` precompute (per the deepening
   * pass on docs/plans/2026-05-28-001-feat-chat-history-hydration-plan.md):
   *   - resolved + freeform_text set → freeform_text wins
   *   - resolved + value set → look up matching option's `body`
   *     (then `label`, then `value` as ultimate fallback)
   *   - resolved + neither → null (defensive — shouldn't happen for
   *     real resolutions)
   *   - unresolved → null
   * The client renders `resolution_text` directly as a user-side
   * bubble; no need to ship `options_json` or `kind` on the wire.
   *
   * Cursor semantics:
   *   - `before`/`before_prompt_id` form a composite cursor. First page
   *     callers pass `before = now`, `before_prompt_id = null`. On
   *     subsequent calls they pass the last row's `created_at` +
   *     `prompt_id`. The query uses `WHERE (created_at, prompt_id) <
   *     (?, ?)` to skip past the boundary row even when N rows share
   *     the same `created_at` ms.
   *   - The query fetches `LIMIT + 1` to compute `has_more` without
   *     a second round trip.
   *
   * Project isolation is implicit: each instance has its own
   * `ProjectDb`, so `topic_id = web:<user_id>` only ever resolves
   * within the calling instance's DB. The caller (the surface handler)
   * is responsible for deriving `topic_id` server-side from a
   * verified `user_id` claim — never trusting client query params.
   */
  async listHistoryByTopic(input: {
    topic_id: string
    /** Composite cursor — the `created_at` of the last row on the
     *  previously-returned page, or the current clock for the first
     *  page. */
    before: number
    /** Composite cursor companion — the `prompt_id` of the last row
     *  on the previously-returned page, or null for the first page
     *  (the query collapses to a single-column compare when null,
     *  which is equivalent to "any prompt_id at or before this ms"). */
    before_prompt_id: string | null
    /** Maximum rows to return. Caller is responsible for clamping
     *  to a sane upper bound (the surface handler clamps to 100). */
    limit: number
    /** Wall clock the caller witnessed. Used to filter out expired
     *  unresolved "ghost" rows. */
    now: number
  }): Promise<{
    turns: ChatHistoryTurn[]
    has_more: boolean
  }> {
    if (typeof input.topic_id !== 'string' || input.topic_id.length === 0) {
      throw new ButtonStoreError(
        'invalid_prompt',
        `listHistoryByTopic requires a non-empty topic_id`,
      )
    }
    const limit = Math.max(1, Math.floor(input.limit))
    // SQLite tuple comparison: `(a, b) < (?, ?)` evaluates as
    // a < ? OR (a = ? AND b < ?). When `before_prompt_id` is null we
    // degenerate to a pure `created_at < ?` filter — the very first
    // page's `before = now` selects "everything strictly before
    // this ms", with ties handled on the NEXT page via the
    // composite path.
    //
    // The query asks for `LIMIT + 1` to compute has_more without a
    // second round-trip; we slice the trailing extra row off below.
    // First page (no composite cursor companion) uses INCLUSIVE
    // `created_at <= ?` so rows created in the same ms as the
    // wall-clock `before` boundary are included. The handler
    // defaults `before` to `Date.now()`, and a row emitted in the
    // current ms otherwise gets filtered out — that's the
    // "history fetch right after a phase transition shows N-1
    // turns" footgun. Subsequent pages use the strict composite
    // tuple `(created_at, prompt_id) < (?, ?)` so the boundary
    // row IS excluded (we already showed it on the previous
    // page).
    const sql = input.before_prompt_id === null
      ? `SELECT ${SELECT_PROMPT_COLS}
           FROM button_prompts
          WHERE topic_id = ?
            AND created_at <= ?
            AND (resolved_at IS NOT NULL OR expires_at > ?)
          ORDER BY created_at DESC, prompt_id DESC
          LIMIT ?`
      : `SELECT ${SELECT_PROMPT_COLS}
           FROM button_prompts
          WHERE topic_id = ?
            AND (
              created_at < ?
              OR (created_at = ? AND prompt_id < ?)
            )
            AND (resolved_at IS NOT NULL OR expires_at > ?)
          ORDER BY created_at DESC, prompt_id DESC
          LIMIT ?`
    const fetch_limit = limit + 1
    const rows = input.before_prompt_id === null
      ? this.db
          .prepare<PromptRow, [string, number, number, number]>(sql)
          .all(input.topic_id, input.before, input.now, fetch_limit)
      : this.db
          .prepare<PromptRow, [string, number, number, string, number, number]>(sql)
          .all(
            input.topic_id,
            input.before,
            input.before,
            input.before_prompt_id,
            input.now,
            fetch_limit,
          )
    const has_more = rows.length > limit
    const visible = has_more ? rows.slice(0, limit) : rows
    const turns: ChatHistoryTurn[] = visible.map((row) => rowToHistoryTurn(row))
    return { turns, has_more }
  }

  /**
   * The single MOST-RECENT turn for a topic by INSERTION ORDER — the latest row
   * at or before `now`, tie-broken by `rowid DESC` (monotonic with insertion) so
   * two rows minted in the SAME millisecond resolve deterministically to the one
   * inserted LAST. Distinct from {@link listHistoryByTopic}, whose `created_at
   * DESC, prompt_id DESC` ordering is a STABLE *pagination* cursor — correct for
   * paging, but its tiebreak is the random `prompt_id` UUID, so "most recent"
   * across a `created_at` collision is non-deterministic (it picks the
   * lexically-greatest UUID, NOT the last-written row). That ambiguity is the
   * reflection layer's `resolvePreviousRowWithUserText` bug: when the inert
   * user-turn row and the agent-reply row land in the same ms (e.g. a fast warm
   * turn, or any test that pins the clock), the lookup could return the EMPTY
   * inert row instead of the reply, so the "prior reply" judged on the next turn
   * came back blank. Recency must mean last-inserted, which only `rowid` encodes.
   * Same expiry/ghost filter as `listHistoryByTopic` (`resolved_at IS NOT NULL OR
   * expires_at > now`). Returns null when the topic has no qualifying row.
   */
  async latestTurnByTopic(input: {
    topic_id: string
    /** Upper bound (inclusive) on `created_at` — the caller's wall clock. */
    before: number
    /** Wall clock used to drop expired unresolved "ghost" rows. */
    now: number
  }): Promise<ChatHistoryTurn | null> {
    if (typeof input.topic_id !== 'string' || input.topic_id.length === 0) {
      throw new ButtonStoreError(
        'invalid_prompt',
        `latestTurnByTopic requires a non-empty topic_id`,
      )
    }
    const row = this.db
      .prepare<PromptRow, [string, number, number]>(
        `SELECT ${SELECT_PROMPT_COLS}
           FROM button_prompts
          WHERE topic_id = ?
            AND created_at <= ?
            AND (resolved_at IS NOT NULL OR expires_at > ?)
          ORDER BY created_at DESC, rowid DESC
          LIMIT 1`,
      )
      .get(input.topic_id, input.before, input.now)
    return row === undefined || row === null ? null : rowToHistoryTurn(row)
  }

  /**
   * Like {@link latestTurnByTopic} but returns the FULL persisted prompt
   * (crucially its parsed `options`), not the history-turn projection. The
   * onboarding deterministic-answer capture (button-backed-answer.ts) needs the
   * durable option set of the agent's last question — the `body` alone is not
   * enough because live-agent replies persist the `[[OPTIONS]]` block STRIPPED
   * from `body` (it lives in `options_json`). Same recency + ghost-filter rule
   * as `latestTurnByTopic` (`rowid DESC` same-ms tiebreak). Returns null when the
   * topic has no visible row.
   */
  async latestPromptByTopic(input: {
    topic_id: string
    /** Upper bound (inclusive) on `created_at` — the caller's wall clock. */
    before: number
    /** Wall clock used to drop expired unresolved "ghost" rows. */
    now: number
  }): Promise<ButtonPrompt | null> {
    if (typeof input.topic_id !== 'string' || input.topic_id.length === 0) {
      throw new ButtonStoreError(
        'invalid_prompt',
        `latestPromptByTopic requires a non-empty topic_id`,
      )
    }
    const row = this.db
      .prepare<PromptRow, [string, number, number]>(
        `SELECT ${SELECT_PROMPT_COLS}
           FROM button_prompts
          WHERE topic_id = ?
            AND created_at <= ?
            AND (resolved_at IS NOT NULL OR expires_at > ?)
          ORDER BY created_at DESC, rowid DESC
          LIMIT 1`,
      )
      .get(input.topic_id, input.before, input.now)
    return row === undefined || row === null ? null : rowToPrompt(row)
  }

  /**
   * Sidebar topic rail (2026-05-28 sprint) — enumerate the distinct
   * `topic_id`s for a user with per-topic metadata (latest body, latest
   * `created_at`, count of active unresolved prompts). Caller is the
   * `/api/v1/chat/topics` surface; one row per topic the user has at
   * least one button_prompts row in.
   *
   * Scope: rows whose `topic_id` is exactly the user's General topic
   * (`web:<user_id>`) OR a per-project descendant
   * (`web:<user_id>:<project_id>`). The prefix match is deliberately
   * strict — `web:<user_id>` followed by either end-of-string OR a
   * literal `:` — so an instance with two users `u-1` and `u-10` does
   * NOT see `u-10`'s topics leaked into `u-1`'s sidebar.
   *
   * The `project_id` for each row is derived from the topic_id:
   *   - exactly `web:<user_id>` → project_id = null (General)
   *   - `web:<user_id>:<rest>` → project_id = rest
   *
   * `last_body` precomputes the 50-char preview the sidebar renders.
   * Unresolved-and-unexpired rows count toward `unread_count` — the same
   * filter the chat-history surface uses for "active" prompts. Resolved
   * prompts never carry unread weight.
   */
  async listTopicsByUser(input: {
    /** Exact `webTopicId(user_id)` — matched via `topic_id = ?` for General, and a wildcard-free range `[<prefix>:, <prefix>;)` for project descendants. */
    user_id_prefix: string
    /** Wall clock used to gate unresolved rows by `expires_at > now`. */
    now: number
  }): Promise<
    Array<{
      topic_id: string
      project_id: string | null
      last_body: string | null
      last_created_at: number | null
      unread_count: number
    }>
  > {
    if (typeof input.user_id_prefix !== 'string' || input.user_id_prefix.length === 0) {
      throw new ButtonStoreError(
        'invalid_prompt',
        `listTopicsByUser requires a non-empty user_id_prefix`,
      )
    }
    const general = input.user_id_prefix
    // Argus r1 BLOCKER 2 (2026-05-28) — switched from `topic_id LIKE
    // 'web:<u>:%'` to a range-bound comparison so a user_id that
    // happens to contain SQL LIKE wildcards (`%` or `_`) cannot leak
    // another user's topics into this user's sidebar. Production
    // user_ids are UUIDs (no wildcard chars), but synthetic-e2e and
    // dev `sub` claims aren't enforced to be wildcard-free — `u_1`
    // would otherwise LIKE-match `uA1`, `u-1`, etc. Range comparison
    // sidesteps the wildcard semantics entirely:
    //   - `topic_id >= '<general>:'` excludes the General row itself
    //     (`'<general>' < '<general>:'`) and every shorter sibling
    //     (`'web:u_'` < `'web:u_1:'` is false for `'web:uA1'`).
    //   - `topic_id < '<general>;'` upper-bounds the scan by stepping
    //     `:` (0x3A) → `;` (0x3B) so every `'<general>:<rest>'` is
    //     strictly less than the bound, but `'<general>+anything'`
    //     where the next char isn't `:` falls outside the range.
    // The general row is matched with an explicit `topic_id = ?`.
    // The bounds are pure equality on the topic_id index — no LIKE
    // optimizer pessimization, no wildcard-escape complexity.
    const projectLowerBound = `${input.user_id_prefix}:`
    const projectUpperBound = `${input.user_id_prefix};`
    const rows = this.db
      .prepare<
        {
          topic_id: string
          last_body: string | null
          last_created_at: number | null
          unread_count: number
        },
        [number, string, string, string]
      >(
        `SELECT topic_id,
                -- Prefer the agent body, but fall back to the user's freeform
                -- text for an inert USER turn (Connect tag_gated quiet message,
                -- which stores an empty body + the text in resolution_freeform_text).
                -- Without the COALESCE the sidebar preview would blank out after
                -- such a turn (Codex review 2026-06-26).
                (SELECT CASE WHEN b2.body <> '' THEN b2.body
                             ELSE COALESCE(b2.resolution_freeform_text, b2.body) END
                   FROM button_prompts b2
                  WHERE b2.topic_id = bp.topic_id
                  ORDER BY b2.created_at DESC, b2.prompt_id DESC LIMIT 1) AS last_body,
                MAX(created_at) AS last_created_at,
                SUM(CASE WHEN resolved_at IS NULL AND expires_at > ? THEN 1 ELSE 0 END) AS unread_count
           FROM button_prompts bp
          WHERE topic_id = ? OR (topic_id >= ? AND topic_id < ?)
          GROUP BY topic_id`,
      )
      .all(input.now, general, projectLowerBound, projectUpperBound)
    return rows.map((row) => {
      const project_id = row.topic_id === general ? null : row.topic_id.slice(general.length + 1)
      return {
        topic_id: row.topic_id,
        project_id,
        last_body: row.last_body !== null ? truncatePreview(row.last_body) : null,
        last_created_at: row.last_created_at,
        unread_count: Number(row.unread_count ?? 0),
      }
    })
  }

  /**
   * Sweep prompts whose `expires_at < now` and that haven't been resolved.
   * Resolves each with `choice_value: '__timeout__'` and returns the
   * synthesized `ButtonChoice[]` so the caller can route them into the
   * agent's interview engine.
   *
   * Idempotent — a second sweep with the same `now` finds zero unresolved
   * expired rows (the prior sweep already resolved them).
   */
  async sweepExpired(now: number): Promise<{ resolved: ButtonChoice[] }> {
    const rows = this.db
      .prepare<PromptRow, [number]>(
        `SELECT ${SELECT_PROMPT_COLS}
           FROM button_prompts
          WHERE resolved_at IS NULL AND expires_at <= ?`,
      )
      .all(now)
    const resolved: ButtonChoice[] = []
    for (const row of rows) {
      // sweepExpired writes the resolution directly rather than routing
      // through resolve() because resolve()'s transactional expiry check
      // (Codex r2 P2.1) would reject the synthesized choice — its
      // chosen_at is post-expiry by definition. The sweep is the
      // authoritative path for timing out unresolved prompts.
      const synthesized: ButtonChoice = {
        prompt_id: row.prompt_id,
        choice_value: '__timeout__',
        chosen_at: now,
        speaker_user_id: '__system__',
        channel_kind: 'webhook',
      }
      try {
        const updated = await this.markResolved({
          prompt_id: row.prompt_id,
          choice: synthesized,
          require_unresolved: true,
        })
        if (updated) resolved.push(synthesized)
      } catch (err) {
        if (err instanceof ButtonStoreError && err.code === 'prompt_not_found') continue
        throw err
      }
    }
    return { resolved }
  }

  /**
   * Internal — write the resolution columns onto a row. Used by
   * sweepExpired (which can't route through resolve() because its
   * synthesized chosen_at is post-expiry by design) and by future
   * admin-only force-resolve paths. Returns true when the row was
   * updated, false when it was already resolved.
   */
  private async markResolved(input: {
    prompt_id: string
    choice: ButtonChoice
    require_unresolved: boolean
  }): Promise<boolean> {
    return await this.db.transaction(async (tx) => {
      const row = tx
        .prepare<{ resolved_at: number | null }, [string]>(
          `SELECT resolved_at FROM button_prompts WHERE prompt_id = ?`,
        )
        .get(input.prompt_id)
      if (!row) {
        throw new ButtonStoreError(
          'prompt_not_found',
          `no button_prompt for prompt_id=${input.prompt_id}`,
        )
      }
      if (input.require_unresolved && row.resolved_at !== null) return false
      await tx.run(
        `UPDATE button_prompts
            SET resolved_at = ?,
                resolution_value = ?,
                resolution_freeform_text = ?,
                resolution_speaker_user_id = ?,
                resolution_channel_kind = ?
          WHERE prompt_id = ?`,
        [
          input.choice.chosen_at,
          input.choice.choice_value,
          input.choice.freeform_text ?? null,
          input.choice.speaker_user_id,
          input.choice.channel_kind,
          input.prompt_id,
        ],
      )
      return true
    })
  }
}

/**
 * Wire shape returned by `ButtonStore.listHistoryByTopic` and
 * shipped on the `GET /api/v1/chat/history` response. Server pre-
 * computes `resolution_text` so the client doesn't need to ship
 * the (sometimes large) options list or re-parse `options_json`.
 * The discriminated `resolved` field lets the client renderer
 * narrow exhaustively.
 */
export type ChatHistoryTurn = {
  prompt_id: string
  body: string
  created_at: number
} & (
  | { resolved: false; resolution_text: null }
  | { resolved: true; resolution_text: string }
)

/**
 * Lift a `PromptRow` into the wire-shape used by the chat-history
 * endpoint. Defensive `options_json` parse: a single corrupt row
 * still ships (with `resolution_text` falling back to
 * `resolution_value` when present, or marked unresolved otherwise)
 * rather than 500'ing the whole batch.
 */
function rowToHistoryTurn(row: PromptRow): ChatHistoryTurn {
  const base = {
    prompt_id: row.prompt_id,
    body: row.body,
    created_at: row.created_at,
  }
  // Unresolved active prompt — server returns it so the client can
  // dedup against the live WS active-prompt re-emit, but there is no
  // resolution to render.
  if (row.resolved_at === null) {
    return { ...base, resolved: false, resolution_text: null }
  }
  // Codex r2 P2 (2026-05-28) — synthetic resolution sentinels
  // (`__timeout__`, `__cancel__`) MUST NOT render as user replies.
  // `sweepExpired()` writes these when an unresolved prompt
  // expires past its TTL, and the app-socket cancel path writes
  // `__cancel__` when the user dismisses the modal. Neither is a
  // historical user turn — surfacing them would render a bubble
  // saying "__timeout__" in the user's chat history. Treat the
  // turn as effectively unresolved (only the agent bubble
  // renders; no user-side bubble) IFF there's also no freeform
  // text (the user might have typed a reply that mapped to a
  // sentinel value through some other path, in which case the
  // freeform text IS the historical user turn worth showing).
  if (
    typeof row.resolution_value === 'string' &&
    RESERVED_RESOLUTION_VALUES.has(row.resolution_value) &&
    (row.resolution_freeform_text === null ||
      row.resolution_freeform_text.length === 0)
  ) {
    return { ...base, resolved: false, resolution_text: null }
  }
  // Freeform text wins when present (the user typed a reply instead
  // of tapping a button). Always already a plain string ready to
  // render via `textContent`.
  if (
    typeof row.resolution_freeform_text === 'string' &&
    row.resolution_freeform_text.length > 0
  ) {
    return {
      ...base,
      resolved: true,
      resolution_text: row.resolution_freeform_text,
    }
  }
  // Button choice — look up the matching option to surface its
  // `body` (the human-readable face) rather than the opaque
  // routing `value`. JSON.parse failure falls back to the raw
  // value so we still render *something*; a malformed
  // options_json is a data-corruption bug worth shipping to disk
  // with a console warning, but it should not blank the chat.
  const value = row.resolution_value
  if (typeof value === 'string' && value.length > 0) {
    let display = value
    try {
      // Corrupt-policy: log + fall through to raw resolution_value. The codec
      // rethrows the SyntaxError so the existing catch keeps the console.warn.
      const options = parseJsonColumn(row.options_json, { onCorrupt: 'throw' }) as ButtonOption[]
      if (Array.isArray(options)) {
        const match = options.find((opt) => opt?.value === value)
        if (match !== undefined) {
          if (typeof match.body === 'string' && match.body.length > 0) {
            display = match.body
          } else if (typeof match.label === 'string' && match.label.length > 0) {
            display = match.label
          }
        }
      }
    } catch (err) {
      console.warn(
        `[button-store] corrupt options_json on prompt_id=${row.prompt_id}; falling back to raw resolution_value:`,
        err,
      )
    }
    return { ...base, resolved: true, resolution_text: display }
  }
  // Defensive — resolved_at is set but neither freeform nor value.
  // Shouldn't happen for real resolutions (synthesized `__timeout__`
  // / `__cancel__` rows carry their sentinel as `resolution_value`),
  // but we ship a defensive "" rather than crashing.
  return { ...base, resolved: true, resolution_text: '' }
}

/**
 * Sidebar topic rail — truncate a button-prompts `body` to the 50-char
 * sidebar preview shape ("Hello there, this is" → "Hello there, this is…"
 * once over the limit). Word-boundary trim avoids cutting mid-token where
 * possible. Returns the trimmed text without trailing whitespace.
 */
function truncatePreview(body: string): string {
  const single = body.replace(/\s+/g, ' ').trim()
  if (single.length <= 50) return single
  const sliced = single.slice(0, 50)
  const lastSpace = sliced.lastIndexOf(' ')
  // Word-boundary fallback — but only when the boundary is in the
  // back half of the slice; an early space (< 25 chars) would yield
  // an aesthetically truncated preview ("Hello…" from a 50-char body)
  // that loses more signal than a hard-cut on the byte boundary.
  const trimmed = lastSpace > 25 ? sliced.slice(0, lastSpace) : sliced
  return `${trimmed.trimEnd()}…`
}

function rowToPrompt(row: PromptRow): ButtonPrompt {
  let options: ButtonOption[]
  try {
    // Corrupt-policy: rethrow as a typed ButtonStoreError. The codec rethrows
    // the SyntaxError so the existing catch performs the type conversion.
    options = parseJsonColumn(row.options_json, { onCorrupt: 'throw' }) as ButtonOption[]
  } catch (err) {
    throw new ButtonStoreError(
      'db_write_failed',
      `corrupt options_json for prompt_id=${row.prompt_id}`,
      err,
    )
  }
  const prompt: ButtonPrompt = {
    prompt_id: row.prompt_id,
    body: row.body,
    options,
    allow_freeform: row.allow_freeform === 1,
    expires_in_ms: Math.max(0, row.expires_at - row.created_at),
  }
  if (row.idempotency_key !== null) prompt.idempotency_key = row.idempotency_key
  // Sprint 28 Codex r4 P2 — round-trip the kind field. NULL maps to
  // undefined (back-compat with pre-Sprint-28 rows where the column
  // was added later but is unset).
  if (row.kind === 'buttons' || row.kind === 'image-gallery') {
    prompt.kind = row.kind
  }
  return prompt
}

function isUniqueViolation(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase()
    return msg.includes('unique') && (msg.includes('idempotency') || msg.includes('button_prompts'))
  }
  return false
}
