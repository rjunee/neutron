/**
 * @neutronai/onboarding/history-import — ChatGPT export parser (P2 S3).
 *
 * ChatGPT exports a zip with these top-level entries:
 *   - `conversations.json`  — array of conversation objects, the bulk
 *     of the archive content. Each conversation has a `mapping`
 *     (graph of message nodes keyed by id with parent/child pointers)
 *     and a `current_node` pointer to the leaf of the active branch.
 *   - `chat.html`           — UI bundle (ignored)
 *   - `message_feedback.json` — per-message thumbs up/down (ignored
 *     for analysis, but kept around in `meta` as a future signal)
 *   - `model_comparisons.json` — A/B-test debug data (ignored)
 *   - `user.json`           — user info (ignored — we already have it)
 *
 * We parse `conversations.json` and yield one `ConversationRecord` per
 * conversation. Each conversation is reconstructed by walking the
 * `mapping` graph from `current_node` up to the root, then reversing
 * to get chronological order. This is the same algorithm OpenAI's own
 * export viewer uses.
 *
 * Streaming-friendly: the parser is an `AsyncIterable` so the chunker
 * can pull conversations one at a time and never hold the full
 * conversation list in memory beyond the JSON.parse window. For very
 * large exports (>100MB) we acknowledge that JSON.parse holds the
 * whole tree before we can iterate; a streaming JSON parser is a
 * follow-up — see § 7 risk row "history-import OOM on very large
 * exports". The chunker's per-chunk emit pattern still bounds the
 * post-parse working set.
 */

import { ImportError, type ConversationMessage, type ConversationRecord } from './types.ts'
import { findEntry, listEntries, readEntry, ZipReadError } from './zip-reader.ts'

const CONVERSATIONS_FILE = 'conversations.json'

/**
 * OpenAI shards `conversations.json` into `conversations-NNN.json` for
 * large exports as of ~2026-05 (Sam's 1.18 GB export 2026-05-25 had
 * `conversations-000.json` … `conversations-005.json`). The shards are
 * each independent JSON arrays of conversation objects; concatenating
 * them in numeric-suffix order reproduces the legacy single-file
 * structure. This regex matches the sharded entry shape and captures
 * the zero-padded index for stable ordering.
 */
const CONVERSATIONS_SHARD_RE = /^conversations-(\d+)\.json$/i

/** A single ChatGPT export node. */
interface ChatGptNode {
  id: string
  message: {
    id: string
    author?: { role?: string; name?: string | null }
    content?: { content_type?: string; parts?: Array<string | { text?: string }> }
    create_time?: number | null
    update_time?: number | null
    metadata?: Record<string, unknown>
    status?: string
    end_turn?: boolean
  } | null
  parent: string | null
  children?: string[]
}

interface ChatGptConversation {
  id?: string
  conversation_id?: string
  title?: string
  create_time?: number
  update_time?: number
  current_node?: string | null
  mapping: Record<string, ChatGptNode>
}

/**
 * Iterate conversations from a ChatGPT zip buffer. Yields one record
 * per conversation in the order they appear in `conversations.json`.
 *
 * Throws `ImportError{code:'parse_failed'}` on any malformed input —
 * caller decides whether to mark the job failed or skip the bad entry.
 */
export async function* parseChatgptExport(zipBuffer: Buffer): AsyncIterable<ConversationRecord> {
  let entries: ReturnType<typeof listEntries>
  try {
    entries = listEntries(zipBuffer)
  } catch (err) {
    throw new ImportError(
      'parse_failed',
      'chatgpt-zip',
      `zip listEntries failed: ${err instanceof Error ? err.message : String(err)}`,
      err,
    )
  }

  // Prefer the single-file legacy layout when present; fall back to the
  // sharded `conversations-NNN.json` layout OpenAI started shipping in
  // mid-2026 for large exports. Either layout produces the same flat
  // array of `ChatGptConversation`.
  const convos = readConversations(zipBuffer, entries)

  for (const convo of convos) {
    const id = convo.conversation_id ?? convo.id
    if (id === undefined || typeof id !== 'string' || id.length === 0) {
      // Skip degenerate entries; the export format guarantees one of
      // the two id fields, but real exports occasionally have a half-
      // baked draft conversation we'd rather drop than blow up on.
      continue
    }
    const messages = walkConversation(convo)
    const record: ConversationRecord = {
      conversation_id: id,
      title: convo.title ?? '',
      messages,
    }
    if (convo.create_time !== undefined && Number.isFinite(convo.create_time)) {
      record.created_at = Math.round(convo.create_time * 1_000)
    }
    yield record
  }
}

/**
 * Resolve the conversation list from either the legacy single-file
 * `conversations.json` OR the sharded `conversations-NNN.json` layout
 * (large-export format, observed 2026-05-25 on a 1.18 GB export with
 * 6 shards 000-005).
 *
 * Throws `ImportError{code:'parse_failed'}` on missing files, read
 * failures, JSON-parse failures, or non-array roots. The error message
 * includes the list of archive entries when no conversations file is
 * found at all — actionable for debugging unexpected export shapes.
 */
function readConversations(
  zipBuffer: Buffer,
  entries: ReturnType<typeof listEntries>,
): ChatGptConversation[] {
  const single = findEntry(entries, CONVERSATIONS_FILE)
  if (single !== null) {
    return [parseConversationsBuffer(readShard(zipBuffer, single, CONVERSATIONS_FILE), CONVERSATIONS_FILE)].flat()
  }

  // Collect sharded shards. Sort by the numeric suffix so message order
  // matches the export's internal chunking (OpenAI orders shards by
  // conversation create-time descending — preserving that order keeps
  // the downstream chunker's behaviour consistent with the legacy
  // single-file path).
  const shards: Array<{ index: number; entry: (typeof entries)[number] }> = []
  for (const entry of entries) {
    const m = CONVERSATIONS_SHARD_RE.exec(entry.name)
    if (m === null) continue
    const idx = Number.parseInt(m[1]!, 10)
    if (!Number.isFinite(idx)) continue
    shards.push({ index: idx, entry })
  }
  if (shards.length === 0) {
    throw new ImportError(
      'parse_failed',
      'chatgpt-zip',
      `archive does not contain ${CONVERSATIONS_FILE} or any conversations-NNN.json shards; got entries: ${entries.map((e) => e.name).join(', ')}`,
    )
  }
  shards.sort((a, b) => a.index - b.index)

  const all: ChatGptConversation[] = []
  for (const shard of shards) {
    const bytes = readShard(zipBuffer, shard.entry, shard.entry.name)
    const slice = parseConversationsBuffer(bytes, shard.entry.name)
    for (const c of slice) all.push(c)
  }
  return all
}

function readShard(
  zipBuffer: Buffer,
  entry: ReturnType<typeof listEntries>[number],
  display_name: string,
): Buffer {
  try {
    return readEntry(zipBuffer, entry)
  } catch (err) {
    if (err instanceof ZipReadError) {
      throw new ImportError(
        'parse_failed',
        'chatgpt-zip',
        `${display_name} read failed (${err.code}): ${err.message}`,
        err,
      )
    }
    throw err
  }
}

function parseConversationsBuffer(
  bytes: Buffer,
  display_name: string,
): ChatGptConversation[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString('utf8'))
  } catch (err) {
    throw new ImportError(
      'parse_failed',
      'chatgpt-zip',
      `${display_name} JSON parse failed: ${err instanceof Error ? err.message : String(err)}`,
      err,
    )
  }
  if (!Array.isArray(parsed)) {
    throw new ImportError(
      'parse_failed',
      'chatgpt-zip',
      `${display_name} root is not an array`,
    )
  }
  return parsed as ChatGptConversation[]
}

/**
 * Walk the conversation graph from `current_node` to the root, then
 * reverse so messages are in chronological order. ChatGPT graphs can
 * have branches (regenerations); `current_node` is the active leaf so
 * we only walk the active branch. This matches what the user sees in
 * the chat UI.
 */
function walkConversation(convo: ChatGptConversation): ConversationMessage[] {
  const out: ConversationMessage[] = []
  if (typeof convo.mapping !== 'object' || convo.mapping === null) return out
  let nodeId = convo.current_node ?? null
  if (nodeId === null) {
    // Fallback: pick the node with no children (a leaf) — works for
    // single-branch conversations missing `current_node`.
    const leaves = Object.values(convo.mapping).filter(
      (n) => Array.isArray(n.children) && n.children.length === 0,
    )
    nodeId = leaves[leaves.length - 1]?.id ?? null
  }
  const visited = new Set<string>()
  while (nodeId !== null && !visited.has(nodeId)) {
    visited.add(nodeId)
    const node = convo.mapping[nodeId]
    if (node === undefined) break
    const text = nodeText(node)
    const role = nodeRole(node)
    if (text !== null && role !== null) {
      const msg: ConversationMessage = { role, text }
      const ts = node.message?.create_time
      if (typeof ts === 'number' && Number.isFinite(ts)) {
        msg.created_at = Math.round(ts * 1_000)
      }
      out.push(msg)
    }
    nodeId = node.parent
  }
  out.reverse()
  return out
}

function nodeText(node: ChatGptNode): string | null {
  const parts = node.message?.content?.parts
  if (!Array.isArray(parts)) return null
  const pieces: string[] = []
  for (const p of parts) {
    if (typeof p === 'string') pieces.push(p)
    else if (typeof p === 'object' && p !== null && typeof p.text === 'string') {
      pieces.push(p.text)
    }
  }
  const joined = pieces.join('\n').trim()
  return joined.length === 0 ? null : joined
}

function nodeRole(node: ChatGptNode): ConversationMessage['role'] | null {
  const role = node.message?.author?.role
  if (role === 'user' || role === 'assistant' || role === 'system' || role === 'tool')
    return role
  return null
}
