/**
 * @neutronai/gateway/wiring — escalate-to-chat context loader (P7.2 S3).
 *
 * Per docs/plans/2026-05-23-003-feat-p7-2-s3-inline-comments-ui-watcher-escalate-plan.md
 * Part C ("Escalate-to-chat event + chat-surface seed").
 *
 * The chat composer wires `loadPendingEscalations(comment_store,
 * project_id)` into its per-turn LLM-call wrapper (mirror of the
 * persona-loader pattern at `build-phase-spec-resolver.ts:212-234`).
 * On every chat turn the loader:
 *
 *   1. Atomically pulls UNCONSUMED `escalate_to_chat` events from the
 *      per-project sidecar AND inserts consumption-markers in the same
 *      `BEGIN IMMEDIATE` transaction. Two concurrent chat turns for
 *      the same project can NEVER both see the same pending event
 *      because `INSERT OR IGNORE` against the
 *      `escalate_consumption_state` PRIMARY KEY collapses the second
 *      writer to a no-op.
 *   2. Renders the events into an `<escalated_comment_threads>` XML
 *      envelope mirroring the existing `<persona_file>` framing from
 *      `persona-loader.ts:154`. The model is trained on that shape in
 *      this gateway's outputs.
 *
 * `markEscalationsConsumed` is an idempotent no-op confirm — the rows
 * were already written by `loadPendingEscalations`'s transaction. It
 * exists in the API to (a) preserve the persona-loader-style "load
 * then confirm-after-LLM" seam shape and (b) absorb a future cases
 * where LLM-call failure should rollback consumption (today the
 * consumption is best-effort: an LLM failure leaves the rows
 * consumed; the events themselves stay in the log).
 *
 * No factory / interface ceremony — two exported functions in the
 * persona-loader file-layout convention. Per the Enhancement Summary
 * § 3, this collapses the original `EscalationContextLoader`
 * interface + factory design into something far smaller without
 * losing the "where does escalation logic live?" smell test.
 */

import type { Database, Statement } from 'bun:sqlite'
import { parseJsonColumn } from '@neutronai/persistence/index.ts'

import type { CommentStore } from '../comments/comment-store.ts'

/**
 * Maximum number of pending escalations rendered into the chat
 * composer's system prompt on any single turn. Beyond this we let the
 * remaining events spill to the next turn (FIFO via `created_at ASC`
 * + the consumed-on-read guarantee). 5 is enough headroom for a heavy
 * comment-thread session without ballooning the prompt prefix; the
 * model can always read the underlying doc via the docs tool if a
 * thread needs more context than the rendered envelope carries.
 */
export const ESCALATION_RENDER_LIMIT = 5

/**
 * Result of `loadPendingEscalations`. `rendered` is either the empty
 * string (no pending escalations) or a fully-formed
 * `<escalated_comment_threads>...</escalated_comment_threads>` block.
 * `consumed_event_ids` lists the events whose consumption-markers
 * were inserted in the same transaction — passed to
 * `markEscalationsConsumed` after the LLM call to preserve the
 * load-then-confirm seam (today it's a no-op confirm).
 */
export interface LoadedEscalations {
  rendered: string
  consumed_event_ids: string[]
}

interface EscalationRow {
  event_id: string
  thread_root_id: string | null
  doc_path: string
  metadata_json: string | null
  created_at: number
}

interface ThreadReplyRow {
  author_kind: string
  author_id: string
  body: string | null
  created_at: number
}

/**
 * Structured `comment_body_history` entry (ISSUE #42). The agent-
 * watcher's escalate path stamps this array into
 * `escalate_to_chat.metadata_json.comment_body_history` so the
 * renderer can label each `<comment>` tag with `author="user"` vs
 * `author="agent"` — without this distinction the chat composer can
 * confuse its own prior reply text with user input on an auto-
 * escalation turn.
 *
 * Back-compat: the loader's `normaliseHistory` defensively accepts the
 * pre-#42 shapes (bare string, array of strings) and treats unknown
 * authors as `user` so a legacy escalate row written by the
 * pre-upgrade agent-watcher still renders without crashing the chat
 * composer.
 */
export interface EscalateCommentBodyHistoryEntry {
  author: 'user' | 'agent'
  body: string
  timestamp: number
}

interface NormalisedComment {
  author: 'user' | 'agent'
  body: string
  timestamp: number | null
}

/**
 * Atomic consumed-on-read. Wraps the SELECT for pending escalations +
 * the consumption-marker INSERT in a single `BEGIN IMMEDIATE`
 * transaction. Two concurrent chat turns for the same project will
 * serialise on the sidecar's writer mutex; whichever turn gets the
 * lock second sees the first turn's INSERTs and reads zero rows.
 *
 * On any DB error the transaction rolls back and the function rethrows
 * — the chat composer catches + logs + proceeds without escalation
 * context (a transient DB blip should never bring the chat surface
 * down). See `build-phase-spec-resolver.ts` wrapper for the catch.
 */
export async function loadPendingEscalations(
  comment_store: CommentStore,
  project_id: string,
  opts: { now?: () => number } = {},
): Promise<LoadedEscalations> {
  const nowFn = opts.now ?? ((): number => Date.now())
  return comment_store.withProjectDb(project_id, (db: Database) => {
    db.exec('BEGIN IMMEDIATE')
    try {
      const rows = db
        .prepare<EscalationRow, [number]>(
          `SELECT e.event_id, e.thread_root_id, e.doc_path,
                  e.metadata_json, e.created_at
             FROM doc_comment_events e
             LEFT JOIN escalate_consumption_state c
                    ON c.event_id = e.event_id
            WHERE e.event_kind = 'escalate_to_chat'
              AND c.event_id IS NULL
            ORDER BY e.created_at ASC, e.event_id ASC
            LIMIT ?`,
        )
        .all(ESCALATION_RENDER_LIMIT)
      const consumed_event_ids: string[] = []
      if (rows.length > 0) {
        const insert_consumed = db.prepare<
          unknown,
          [string, number]
        >(
          'INSERT OR IGNORE INTO escalate_consumption_state(event_id, consumed_at) VALUES (?, ?)',
        )
        const consumed_at = nowFn()
        for (const row of rows) {
          const result = insert_consumed.run(row.event_id, consumed_at)
          // bun:sqlite returns a `changes` count on `.run()` — > 0
          // means this transaction actually inserted the marker (and
          // therefore owns the consumption of this event_id). A
          // concurrent turn that already inserted will return 0 and
          // we skip — that turn already rendered the event into its
          // own system prompt.
          if (result.changes > 0) {
            consumed_event_ids.push(row.event_id)
          }
        }
      }
      const rendered = renderEscalationBlock(db, rows)
      db.exec('COMMIT')
      return { rendered, consumed_event_ids }
    } catch (err) {
      try {
        db.exec('ROLLBACK')
      } catch {
        /* ignore — the original error is the one that matters */
      }
      throw err
    }
  })
}

/**
 * Idempotent no-op confirm. Today the consumption-markers are
 * inserted inside `loadPendingEscalations`'s transaction so this
 * function has nothing to do. Kept in the API so the resolver-side
 * "load then confirm-after-LLM" seam stays in place — a future
 * refactor that wants to roll back consumption on LLM failure can
 * flip the transaction shape in this file without touching the
 * resolver call site.
 *
 * Signature accepts the event ids so a future implementation can
 * still operate on the same data without breaking callers.
 */
export async function markEscalationsConsumed(
  _comment_store: CommentStore,
  _project_id: string,
  _event_ids: string[],
): Promise<void> {
  // Intentional no-op — see file header. The `_` prefixes silence
  // unused-arg lint without removing the documented signature.
  return
}

/**
 * Render the `<escalated_comment_threads>` envelope. Mirrors the
 * `<persona_file name="…">` framing the persona loader uses so the
 * model sees a familiar XML shape. Each thread is wrapped in
 * `<thread doc_path="…" anchor_excerpt="…">` and carries one
 * `<comment author="user|agent" timestamp="…">body</comment>` per
 * reply (ISSUE #42 — the `author` attribute is what lets the chat
 * agent reason about who said what; without it the agent confuses its
 * own prior reply text with user input on an auto-escalation turn).
 *
 * Source priority per thread:
 *   - `metadata.trigger === 'agent_escalation'` (auto-escalation from
 *     the watcher) → the new
 *     `metadata.comment_body_history` array is authoritative; the
 *     watcher already stitched the full user-then-agent context into
 *     it AND the agent's own reply is intentionally NOT a
 *     `comment_posted` row (self-reply guard at
 *     `agent-watcher.ts:processOneComment` prevents the watcher from
 *     reading its own output on the next tick). The legacy bare-
 *     string / array-of-strings shapes still render via
 *     `normaliseHistory` defaulting unknown authors to `user`.
 *   - Otherwise (user-clicked escalation, `trigger === 'user_button'`
 *     or absent) → the `comment_posted` rows on the thread are the
 *     complete + canonical source. The metadata's
 *     `comment_body_history` (when present) is a redundant string
 *     copy in this path; ignoring it avoids double-rendering.
 *
 * Pulls thread replies via a small per-thread query against
 * `doc_comment_events`. Cost is bounded by `ESCALATION_RENDER_LIMIT`
 * × <reply count per thread>; in practice a chat turn fires this
 * loader O(1) times so the total cost is negligible.
 */
function renderEscalationBlock(db: Database, rows: EscalationRow[]): string {
  if (rows.length === 0) return ''
  const fetchReplies = db.prepare<ThreadReplyRow, [string, string]>(
    `SELECT author_kind, author_id, body, created_at
       FROM doc_comment_events
      WHERE event_kind = 'comment_posted'
        AND (event_id = ? OR thread_root_id = ?)
      ORDER BY created_at ASC, event_id ASC`,
  )
  const lines: string[] = []
  lines.push('<escalated_comment_threads>')
  lines.push(
    `The user escalated ${rows.length} inline comment thread(s) from a doc into this chat.`,
  )
  lines.push(
    'Continue the conversation here; you can read the underlying doc via the docs tool if needed.',
  )
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (row === undefined) continue
    const meta = parseMetadata(row.metadata_json)
    const anchor_excerpt =
      typeof meta.anchor_excerpt === 'string' && meta.anchor_excerpt.length > 0
        ? meta.anchor_excerpt
        : '(no anchor excerpt)'
    const comments = commentsForThread(row, meta, fetchReplies)
    lines.push('')
    lines.push(
      `<thread doc_path="${escapeXmlAttr(row.doc_path)}" anchor_excerpt="${escapeXmlAttr(anchor_excerpt)}">`,
    )
    if (comments.length === 0) {
      lines.push('  <!-- no replies on record -->')
    } else {
      for (const c of comments) {
        const tsAttr =
          c.timestamp !== null ? ` timestamp="${c.timestamp}"` : ''
        lines.push(
          `  <comment author="${c.author}"${tsAttr}>${escapeXmlText(c.body)}</comment>`,
        )
      }
    }
    lines.push('</thread>')
  }
  lines.push('</escalated_comment_threads>')
  return lines.join('\n')
}

/**
 * Pick the source of truth for a thread's `<comment>` entries
 * according to `metadata.trigger` (see the renderer's source-priority
 * comment for the rationale). Always returns trimmed, body-non-empty
 * comments — empty bodies pollute the system prompt without adding
 * signal.
 */
function commentsForThread(
  row: EscalationRow,
  meta: Record<string, unknown>,
  fetchReplies: Statement<ThreadReplyRow, [string, string]>,
): NormalisedComment[] {
  const trigger = typeof meta.trigger === 'string' ? meta.trigger : ''
  if (trigger === 'agent_escalation') {
    // Agent-triggered: metadata history is the only place that carries
    // the watcher's own reply text (self-reply guard keeps it out of
    // `comment_posted`). Renders the legacy bare-string / array-of-
    // strings shapes too via `normaliseHistory`.
    return normaliseHistory(meta.comment_body_history)
  }
  // User-triggered (or missing trigger — legacy escalate rows written
  // before #41/#42 left the field unset; defaulting to the
  // comment_posted source preserves their original behaviour).
  const thread_root_id = row.thread_root_id ?? row.event_id
  const replies: ThreadReplyRow[] = fetchReplies.all(
    thread_root_id,
    thread_root_id,
  )
  const out: NormalisedComment[] = []
  for (const reply of replies) {
    const body = (reply.body ?? '').replace(/\s+/g, ' ').trim()
    if (body.length === 0) continue
    out.push({
      author: reply.author_kind === 'user' ? 'user' : 'agent',
      body,
      timestamp: reply.created_at,
    })
  }
  return out
}

/**
 * Defensive parser for `metadata.comment_body_history` (ISSUE #42).
 * Accepts three shapes:
 *   1. Array of `{author, body, timestamp}` objects — the new
 *      write-time format from `agent-watcher.ts:appendEscalation`.
 *   2. Array of bare strings — a legacy intermediate format some test
 *      fixtures use; treats each entry as a user comment per the
 *      brief's back-compat rule.
 *   3. Bare string — the original pre-#42 production format the
 *      pre-upgrade agent-watcher wrote. Treated as ONE user comment
 *      containing the entire concatenated history. The chat agent
 *      sees the dump; this only spans the deploy window because
 *      escalate events are consumed-on-read and the upgrade writes
 *      the new shape going forward.
 *
 * Unknown / malformed entries are dropped silently — the chat surface
 * must never crash on a stale escalate row.
 */
function normaliseHistory(raw: unknown): NormalisedComment[] {
  if (typeof raw === 'string') {
    const trimmed = raw.replace(/\s+/g, ' ').trim()
    if (trimmed.length === 0) return []
    return [{ author: 'user', body: trimmed, timestamp: null }]
  }
  if (!Array.isArray(raw)) return []
  const out: NormalisedComment[] = []
  for (const entry of raw) {
    if (typeof entry === 'string') {
      const trimmed = entry.replace(/\s+/g, ' ').trim()
      if (trimmed.length === 0) continue
      out.push({ author: 'user', body: trimmed, timestamp: null })
      continue
    }
    if (entry === null || typeof entry !== 'object') continue
    const obj = entry as Record<string, unknown>
    const rawBody = obj.body
    if (typeof rawBody !== 'string') continue
    const body = rawBody.replace(/\s+/g, ' ').trim()
    if (body.length === 0) continue
    const author: 'user' | 'agent' = obj.author === 'agent' ? 'agent' : 'user'
    const timestamp =
      typeof obj.timestamp === 'number' && Number.isFinite(obj.timestamp)
        ? obj.timestamp
        : null
    out.push({ author, body, timestamp })
  }
  return out
}

function parseMetadata(raw: string | null): Record<string, unknown> {
  if (raw === null || raw.length === 0) return {}
  // Corrupt-policy: fallback to {} (also the non-object result below).
  const parsed: unknown = parseJsonColumn(raw, { onCorrupt: 'fallback', fallback: {} })
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>
  }
  return {}
}

/**
 * Escape XML attribute values — covers the five predefined entity
 * references. The escalation envelope is consumed by an LLM, not a
 * strict XML parser, so the goal here is "no syntactic confusion that
 * could let user text inject sibling `<comment>` tags" rather than
 * full schema validity.
 */
function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * Escape XML text content — `<`, `>`, `&` only (quotes are legal
 * inside element bodies and quoting them would just bloat the prompt).
 * Same anti-injection rationale as `escapeXmlAttr`.
 */
function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
