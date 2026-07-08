/**
 * @neutronai/chat-core — full-text MESSAGE search over the local transcript.
 *
 * The complement to `@neutronai/doc-search` (which searches the owner's
 * project markdown): this searches the user's CHAT HISTORY — every message
 * in the local {@link Store} — so the user (and the live agent) can find
 * "where did we talk about X" across their conversations.
 *
 * Two facets, ONE contract:
 *
 *   - The durable {@link SqliteChatStore} (op-sqlite on RN, bun:sqlite in
 *     tests, wasm-SQLite on web when it lands) implements search with a real
 *     SQLite **FTS5** virtual table kept in sync with the message table, so
 *     ranking is BM25 and snippets come from SQLite's `snippet()`.
 *   - The pure-JS {@link InMemoryStore} (the always-available fallback, and
 *     the substrate behind today's OPFS web store) implements the SAME
 *     {@link MessageSearchHit} contract with {@link searchMessagesInMemory} —
 *     a tokenised, AND-of-terms scan with the same `[`…`]` highlight markers.
 *
 * Both return identical shapes so a query API on the {@link Store} interface
 * behaves the same regardless of which durable substrate is underneath — the
 * sync engine, send-queue, and UI never branch on it.
 *
 * Query grammar parity: free-text queries are turned into a safe FTS5 MATCH
 * expression by {@link sanitizeFtsQuery} (no operator injection); the JS path
 * tokenises the same way so "alpha beta" means "both terms present" on both.
 */

import type { ChatMessage, MessageRole } from './types.ts'

/** How a message-search is scoped + bounded. */
export interface MessageSearchOptions {
  /** Restrict to a single topic. Omit (or pass '') to search ALL topics. */
  topic_id?: string
  /** Restrict to a single project. Omit to search across every project. */
  project_id?: string
  /** Max hits to return. Default {@link DEFAULT_SEARCH_LIMIT}; clamped to
   *  [1, {@link MAX_SEARCH_LIMIT}]. */
  limit?: number
}

/** One ranked, highlighted message-search result. */
export interface MessageSearchHit {
  topic_id: string
  /** Stable identity (`message_id` when present, else `client_msg_id`). */
  id: string
  message_id: string | null
  client_msg_id: string
  role: MessageRole
  project_id: string | null
  seq: number | null
  created_at: number
  /** Relevance in [0,1]; higher is better. */
  score: number
  /** Excerpt of the body with `[`…`]` markers around the matched terms. */
  snippet: string
  /** The full message body (so a caller can render the whole turn). */
  body: string
}

export const DEFAULT_SEARCH_LIMIT = 20
export const MAX_SEARCH_LIMIT = 100

/** Clamp a caller-supplied limit into the allowed range. */
export function clampSearchLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return DEFAULT_SEARCH_LIMIT
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_SEARCH_LIMIT)
}

/**
 * Turn free text into a safe FTS5 MATCH expression. Adapted from
 * `doc-search/query.ts` (itself lifted from `cores/free/research`'s
 * `vault-search`): every whitespace token passes through verbatim ONLY when
 * it is purely `[A-Za-z0-9_]+`; anything else (hyphenated terms, punctuation,
 * a stray `"`) is double-quoted as a phrase literal so FTS5's grammar
 * (`NEAR`, `NOT`, `-`, parens) can never be triggered by user/agent input.
 * Returns '' for empty/whitespace-only input (callers treat that as "no
 * results").
 */
export function sanitizeFtsQuery(raw: string): string {
  if (typeof raw !== 'string') return ''
  const trimmed = raw.trim()
  if (trimmed.length === 0) return ''
  const tokens = trimmed.split(/\s+/).filter((t) => t.length > 0)
  const cleaned = tokens.map((t) => {
    if (/^[A-Za-z0-9_]+$/.test(t)) return t
    return '"' + t.replace(/"/g, '""') + '"'
  })
  return cleaned.join(' ')
}

/**
 * Split free text into the lowercased search terms used by the JS path. A
 * "term" is a maximal run of `[a-z0-9_]` (after lowercasing) — the same
 * shape `unicode61` produces for the FTS path on ASCII input, so the two
 * paths agree on what "matches".
 */
export function queryTerms(raw: string): string[] {
  if (typeof raw !== 'string') return []
  const matches = raw.toLowerCase().match(/[a-z0-9_]+/g)
  return matches === null ? [] : matches
}

/** Tokenise a body the same way {@link queryTerms} tokenises the query. */
function bodyTerms(body: string): string[] {
  const matches = body.toLowerCase().match(/[a-z0-9_]+/g)
  return matches === null ? [] : matches
}

const SNIPPET_RADIUS = 60
const ELLIPSIS = ' … '

/**
 * Build a `[`…`]`-highlighted excerpt of `body` around the first occurrence
 * of any `term`. Every whole-word occurrence of a term within the window is
 * wrapped, mirroring FTS5's `snippet(..., '[', ']', …)` output so the two
 * store backends render highlights the same way.
 */
export function buildSnippet(body: string, terms: string[]): string {
  if (body.length === 0) return ''
  if (terms.length === 0) return body.length > SNIPPET_RADIUS * 2
    ? body.slice(0, SNIPPET_RADIUS * 2).trimEnd() + ELLIPSIS.trimEnd()
    : body

  const lower = body.toLowerCase()
  // Earliest whole-word match position across all terms.
  let firstAt = -1
  for (const term of terms) {
    const at = wholeWordIndexOf(lower, term, 0)
    if (at !== -1 && (firstAt === -1 || at < firstAt)) firstAt = at
  }
  if (firstAt === -1) {
    // No whole-word hit (e.g. only matched as a sub-token) — head excerpt.
    return body.length > SNIPPET_RADIUS * 2
      ? body.slice(0, SNIPPET_RADIUS * 2).trimEnd() + ELLIPSIS.trimEnd()
      : body
  }

  const start = Math.max(0, firstAt - SNIPPET_RADIUS)
  const end = Math.min(body.length, firstAt + SNIPPET_RADIUS)
  let window = body.slice(start, end)

  // Highlight every whole-word term occurrence inside the window.
  window = highlightTerms(window, terms)

  const prefix = start > 0 ? ELLIPSIS.trimStart() : ''
  const suffix = end < body.length ? ELLIPSIS.trimEnd() : ''
  return `${prefix}${window}${suffix}`
}

/** Wrap each whole-word occurrence of any term in `text` with `[`…`]`. */
function highlightTerms(text: string, terms: string[]): string {
  // Build a single alternation regex of the (escaped) terms, longest first
  // so "abcd" wins over "ab" when both are present.
  const escaped = [...new Set(terms)]
    .filter((t) => t.length > 0)
    .sort((a, b) => b.length - a.length)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  if (escaped.length === 0) return text
  const re = new RegExp(`(?<![a-z0-9_])(${escaped.join('|')})(?![a-z0-9_])`, 'gi')
  return text.replace(re, '[$1]')
}

/** Index of the first whole-word occurrence of `term` in `lower` at/after
 *  `from`, or -1. `lower` and `term` must already be lowercased. */
function wholeWordIndexOf(lower: string, term: string, from: number): number {
  let at = lower.indexOf(term, from)
  while (at !== -1) {
    const before = at === 0 ? '' : lower[at - 1]!
    const after = at + term.length >= lower.length ? '' : lower[at + term.length]!
    if (!isWordChar(before) && !isWordChar(after)) return at
    at = lower.indexOf(term, at + 1)
  }
  return -1
}

function isWordChar(ch: string): boolean {
  return ch.length === 1 && /[a-z0-9_]/.test(ch)
}

/**
 * The pure-JS message search used by {@link InMemoryStore} (and therefore by
 * the OPFS web store + the offline fallback). AND-of-terms over the body
 * tokens, scored by term frequency normalised for body length (a compact
 * BM25 stand-in), blended with a mild recency boost, then min-max normalised
 * to a [0,1] relevance. Ties break by recency (newest first).
 *
 * `messages` is the candidate set the caller has already scoped by
 * topic/project; this function owns ONLY the match + rank + highlight.
 */
export function searchMessagesInMemory(
  messages: readonly ChatMessage[],
  rawQuery: string,
  limit: number,
): MessageSearchHit[] {
  const terms = queryTerms(rawQuery)
  if (terms.length === 0) return []

  interface Scored {
    msg: ChatMessage
    relevance: number
  }
  const scored: Scored[] = []
  for (const msg of messages) {
    const tokens = bodyTerms(msg.body)
    if (tokens.length === 0) continue
    const freq = new Map<string, number>()
    for (const tok of tokens) freq.set(tok, (freq.get(tok) ?? 0) + 1)
    // AND semantics: every query term must appear at least once.
    let total = 0
    let allPresent = true
    for (const term of terms) {
      const c = freq.get(term) ?? 0
      if (c === 0) {
        allPresent = false
        break
      }
      total += c
    }
    if (!allPresent) continue
    // TF normalised by body length — short, dense matches outrank long ones.
    const relevance = total / Math.sqrt(tokens.length)
    scored.push({ msg, relevance })
  }
  if (scored.length === 0) return []

  // Recency: newer messages get a mild boost so equally-relevant turns
  // surface the most recent first (the "recency/relevance" ordering).
  const newest = Math.max(...scored.map((s) => s.msg.created_at))
  const oldest = Math.min(...scored.map((s) => s.msg.created_at))
  const span = newest - oldest

  const relevances = scored.map((s) => s.relevance)
  const relNorm = minMaxNormalise(relevances)

  const blended = scored.map((s, i) => {
    const recency = span > 0 ? (s.msg.created_at - oldest) / span : 1
    return {
      msg: s.msg,
      score: RELEVANCE_WEIGHT * relNorm[i]! + (1 - RELEVANCE_WEIGHT) * recency,
    }
  })

  return blended
    .sort((a, b) => b.score - a.score || b.msg.created_at - a.msg.created_at)
    .slice(0, limit)
    .map(({ msg, score }) => toHit(msg, score, buildSnippet(msg.body, terms)))
}

/** How much relevance dominates recency in the blended JS score. */
const RELEVANCE_WEIGHT = 0.7

/** Project a {@link ChatMessage} + score + snippet into a {@link MessageSearchHit}. */
export function toHit(msg: ChatMessage, score: number, snippet: string): MessageSearchHit {
  return {
    topic_id: msg.topic_id,
    id: msg.message_id !== null && msg.message_id.length > 0 ? msg.message_id : msg.client_msg_id,
    message_id: msg.message_id,
    client_msg_id: msg.client_msg_id,
    role: msg.role,
    project_id: msg.project_id,
    seq: msg.seq,
    created_at: msg.created_at,
    score: Number(score.toFixed(4)),
    snippet,
    body: msg.body,
  }
}

/** Min-max normalise to [0,1]; an all-equal (or single-element) set maps to 1. */
export function minMaxNormalise(values: number[]): number[] {
  if (values.length === 0) return []
  let min = Infinity
  let max = -Infinity
  for (const v of values) {
    if (v < min) min = v
    if (v > max) max = v
  }
  const span = max - min
  if (span <= 0) return values.map(() => 1)
  return values.map((v) => (v - min) / span)
}
