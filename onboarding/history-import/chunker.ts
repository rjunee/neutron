/**
 * @neutronai/onboarding/history-import — chunker (P2 S3).
 *
 * Per docs/plans/P2-onboarding.md § 2.3 — the Pass-1 streaming step
 * processes `~50K-token` chunks. The chunker takes a conversation
 * stream (from any source: ChatGPT export, Claude.ai export, Gmail
 * threads, Calendar events) and emits `Chunk` records.
 *
 * Idempotency rule (locked § 2.3): the chunk_hash MUST be
 *   sha256(conversation_id + ':' + chunk_index + ':' + chunk_text_bytes)
 * truncated to 64 hex chars (32 bytes). Re-runs of the same import (or
 * a fresh re-import after the user uploads a newer zip) skip already-
 * analyzed chunks at $0 cost via the `import_pass1_chunks(chunk_hash)`
 * PRIMARY KEY.
 *
 * Token estimation: we use a coarse 4-chars-per-token proxy. Exact
 * tokenization would require pulling in tiktoken / claude-tokenizer
 * (heavyweight). The substrate's `TokenUsage` from each completion is
 * the source of truth for billed cost; the proxy here only matters
 * for chunk-boundary placement.
 *
 * Within a single conversation we may emit MANY chunks. Across
 * conversations we never merge: chunks always start at a conversation
 * boundary. This keeps Pass-2 dedupe semantically clean (one
 * conversation_id per analyzed unit) and means a long conversation
 * gets multiple `chunk_index` values while short ones get index 0.
 */

import { createHash } from 'node:crypto'
import {
  APPROX_CHARS_PER_TOKEN,
  CHUNK_TARGET_TOKENS,
  MIN_USER_CONTENT_CHARS,
  type Chunk,
  type ConversationMessage,
  type ConversationRecord,
} from './types.ts'

export interface ChunkerOptions {
  /** Override the per-chunk token target. Default 50_000. */
  target_tokens?: number
  /**
   * 2026-05-31 — override the `MIN_USER_CONTENT_CHARS` floor used to
   * stamp `skip_llm=true` on tiny chunks. Tests use this to drive the
   * pre-filter at a smaller threshold (e.g. 50 chars) so fixtures stay
   * compact. Production omits → the type constant default is honored.
   * Setting `min_user_content_chars: 0` disables the floor entirely
   * (legacy "every chunk LLM'd" shape). See `enable_skip_llm` below
   * for the source-aware kill-switch that production uses.
   */
  min_user_content_chars?: number
  /**
   * 2026-05-31 (Codex r3 fix, post-initial-commit) — source-aware
   * skip_llm kill-switch. When `false`, the chunker NEVER stamps
   * `skip_llm=true` regardless of `min_user_content_chars`. Defaults
   * to `true` for back-compat with tests + the chatgpt-zip /
   * claude-zip path, where conversations are bursty (one convo →
   * many messages → one or more chunks) and a 500-char floor
   * correctly drops "user said 'hi'" chunks.
   *
   * A caller can wire `false` for a source whose Conversations emit
   * one short body each (well under the 500-char floor) that IS the
   * signal the LLM should triage — skipping them would silently drop
   * the import's payload.
   */
  enable_skip_llm?: boolean
}

/**
 * Take an `AsyncIterable<ConversationRecord>` and emit `Chunk` records.
 * Pure async-generator pattern — the caller can consume one chunk at
 * a time and bail out without materializing the full chunk list.
 */
export async function* chunkConversations(
  source: AsyncIterable<ConversationRecord>,
  options: ChunkerOptions = {},
): AsyncIterable<Chunk> {
  const targetTokens = options.target_tokens ?? CHUNK_TARGET_TOKENS
  const targetChars = targetTokens * APPROX_CHARS_PER_TOKEN
  const enableSkip = options.enable_skip_llm !== false
  const minUserChars = enableSkip
    ? options.min_user_content_chars ?? MIN_USER_CONTENT_CHARS
    : 0
  for await (const convo of source) {
    yield* chunkOneConversation(convo, targetChars, minUserChars)
  }
}

function* chunkOneConversation(
  convo: ConversationRecord,
  target_chars: number,
  min_user_chars: number,
): IterableIterator<Chunk> {
  if (convo.messages.length === 0) return

  let buf: string[] = []
  let bufMessages: ConversationMessage[] = []
  let bufChars = 0
  let chunkIndex = 0

  const flush = (): Chunk | null => {
    if (buf.length === 0) return null
    const text = buf.join('\n').trim()
    if (text.length === 0) return null
    const byteLength = Buffer.byteLength(text, 'utf8')
    const chunkHash = computeChunkHash(convo.conversation_id, chunkIndex, text)
    // 2026-05-31 — pre-filter floor. Sum the analyzable-signal text
    // length the chunker just walked through. "Analyzable signal" is
    // every role EXCEPT `assistant` — i.e. everything the user (or the
    // external world, in the form of calendar `event` rows / Gmail
    // received-message rows / tool calls / system messages) contributed
    // to the conversation. `assistant` text is the prior LLM reply and
    // is not what we're triaging.
    //
    // Codex r1 fix (2026-05-31, post-initial-commit): the v1 of this
    // filter counted ONLY `role === 'user'` text, which collapsed to 0
    // for any source whose signal lives entirely in non-`user` roles
    // (e.g. all-`event` chunks). Those imports would have been silently
    // 100% skipped, producing empty Pass-1 results and zero extracted
    // entities. Counting all non-assistant text fixes those shapes
    // without breaking the original ChatGPT/Claude "user said 'hi'"
    // intent (since `'user'` text is still counted).
    //
    // Threshold defaults to MIN_USER_CONTENT_CHARS (500); the field
    // name stays as-is for back-compat with the constructor seam,
    // even though the new meaning is "minimum non-assistant chars".
    const signalChars = bufMessages
      .filter((m) => m.role !== 'assistant')
      .reduce((acc, m) => acc + m.text.length, 0)
    const chunk: Chunk = {
      chunk_hash: chunkHash,
      conversation_id: convo.conversation_id,
      chunk_index: chunkIndex,
      text,
      byte_length: byteLength,
      approx_tokens: Math.ceil(text.length / APPROX_CHARS_PER_TOKEN),
    }
    if (min_user_chars > 0 && signalChars < min_user_chars) {
      chunk.skip_llm = true
      chunk.skip_llm_user_chars = signalChars
    }
    chunkIndex++
    buf = []
    bufMessages = []
    bufChars = 0
    return chunk
  }

  for (const m of convo.messages) {
    const piece = renderMessage(m)
    const pieceChars = piece.length
    // If the running buffer plus this piece would blow the target AND
    // the buffer is non-empty, flush first. Always emit at least one
    // message into a chunk so the worst-case (one giant message) still
    // makes progress (the chunk just exceeds the target).
    if (bufChars > 0 && bufChars + pieceChars > target_chars) {
      const out = flush()
      if (out !== null) yield out
    }
    buf.push(piece)
    bufMessages.push(m)
    bufChars += pieceChars + 1 // +1 for the join newline
  }
  const final = flush()
  if (final !== null) yield final
}

function renderMessage(m: ConversationMessage): string {
  const ts = m.created_at !== undefined ? ` [${new Date(m.created_at).toISOString()}]` : ''
  return `${m.role.toUpperCase()}${ts}: ${m.text}`
}

/**
 * Stable chunk hash per § 2.3 — Codex r1 fix:
 *   sha256(conversation_id + ':' + chunk_index + ':' + chunk_text_bytes)
 *
 * The locked spec says `chunk_text_bytes`. Pass-1 of this implementation
 * read that as "byte LENGTH"; Codex caught that a same-length edit
 * (re-export of an edited message preserving char count) would collide
 * with the prior hash and reuse stale Pass-1 results at $0. § 2.3's
 * intent is content-addressed dedupe, not position-addressed, so we
 * hash the actual chunk text bytes.
 *
 * Returns the full 64-char hex digest. Stored in
 * `import_pass1_chunks(chunk_hash PRIMARY KEY)`. Two re-runs of the
 * same import on the same content produce the same hash; an edit to
 * any character in the chunk breaks the cache and forces re-analysis.
 */
export function computeChunkHash(
  conversation_id: string,
  chunk_index: number,
  text: string,
): string {
  const h = createHash('sha256')
  h.update(conversation_id)
  h.update(':')
  h.update(String(chunk_index))
  h.update(':')
  h.update(text, 'utf8')
  return h.digest('hex')
}
