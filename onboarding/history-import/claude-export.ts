/**
 * @neutronai/onboarding/history-import — Claude.ai export parser (P2 S3).
 *
 * Claude.ai exports a zip with `conversations.json` at the top level.
 * The shape is FLATTER than ChatGPT's: a JSON array of conversation
 * objects, each with a `chat_messages` array in chronological order.
 *
 *   [
 *     {
 *       "uuid": "<conversation_id>",
 *       "name": "<title>",
 *       "created_at": "2024-..."  // ISO-8601 string
 *       "updated_at": "...",
 *       "chat_messages": [
 *         { "uuid": "...", "sender": "human" | "assistant",
 *           "text": "...", "created_at": "ISO" }
 *       ]
 *     }
 *   ]
 *
 * (Per Claude.ai data export shape verified 2026-04 — the format has
 * stayed stable since launch. If Anthropic adds a `branches` field for
 * regenerations later, we'll need to follow ChatGPT's mapping-walker
 * pattern; for now linear is enough.)
 */

import { ImportError, type ConversationMessage, type ConversationRecord } from './types.ts'
import { findEntry, listEntries, readEntry, ZipReadError } from './zip-reader.ts'

const CONVERSATIONS_FILE = 'conversations.json'

interface ClaudeChatMessage {
  uuid?: string
  sender?: string
  text?: string
  /** Some exports nest the actual text in `content[].text`. */
  content?: Array<{ type?: string; text?: string }>
  created_at?: string | number
}

interface ClaudeConversation {
  uuid?: string
  conversation_id?: string
  name?: string
  title?: string
  created_at?: string | number
  updated_at?: string | number
  chat_messages?: ClaudeChatMessage[]
  messages?: ClaudeChatMessage[]
}

export async function* parseClaudeExport(zipBuffer: Buffer): AsyncIterable<ConversationRecord> {
  let entries: ReturnType<typeof listEntries>
  try {
    entries = listEntries(zipBuffer)
  } catch (err) {
    throw new ImportError(
      'parse_failed',
      'claude-zip',
      `zip listEntries failed: ${err instanceof Error ? err.message : String(err)}`,
      err,
    )
  }
  const convosEntry = findEntry(entries, CONVERSATIONS_FILE)
  if (convosEntry === null) {
    throw new ImportError(
      'parse_failed',
      'claude-zip',
      `archive does not contain ${CONVERSATIONS_FILE}; got entries: ${entries.map((e) => e.name).join(', ')}`,
    )
  }
  let bytes: Buffer
  try {
    bytes = readEntry(zipBuffer, convosEntry)
  } catch (err) {
    if (err instanceof ZipReadError) {
      throw new ImportError(
        'parse_failed',
        'claude-zip',
        `${CONVERSATIONS_FILE} read failed (${err.code}): ${err.message}`,
        err,
      )
    }
    throw err
  }
  let convos: ClaudeConversation[]
  try {
    convos = JSON.parse(bytes.toString('utf8')) as ClaudeConversation[]
  } catch (err) {
    throw new ImportError(
      'parse_failed',
      'claude-zip',
      `${CONVERSATIONS_FILE} JSON parse failed: ${err instanceof Error ? err.message : String(err)}`,
      err,
    )
  }
  if (!Array.isArray(convos)) {
    throw new ImportError(
      'parse_failed',
      'claude-zip',
      `${CONVERSATIONS_FILE} root is not an array`,
    )
  }
  for (const convo of convos) {
    const id = convo.uuid ?? convo.conversation_id
    if (typeof id !== 'string' || id.length === 0) continue
    const msgs = convo.chat_messages ?? convo.messages ?? []
    const messages: ConversationMessage[] = []
    for (const m of msgs) {
      const role = mapRole(m.sender)
      if (role === null) continue
      const text = extractText(m)
      if (text === null) continue
      const out: ConversationMessage = { role, text }
      const ts = parseTimestamp(m.created_at)
      if (ts !== null) out.created_at = ts
      messages.push(out)
    }
    const rec: ConversationRecord = {
      conversation_id: id,
      title: convo.name ?? convo.title ?? '',
      messages,
    }
    const created = parseTimestamp(convo.created_at)
    if (created !== null) rec.created_at = created
    yield rec
  }
}

function mapRole(sender: string | undefined): ConversationMessage['role'] | null {
  if (sender === 'human' || sender === 'user') return 'user'
  if (sender === 'assistant' || sender === 'claude') return 'assistant'
  if (sender === 'system') return 'system'
  return null
}

function extractText(m: ClaudeChatMessage): string | null {
  if (typeof m.text === 'string' && m.text.length > 0) return m.text.trim() || null
  if (Array.isArray(m.content)) {
    const pieces = m.content
      .map((c) => (typeof c.text === 'string' ? c.text : ''))
      .filter((s) => s.length > 0)
    if (pieces.length === 0) return null
    const joined = pieces.join('\n').trim()
    return joined.length === 0 ? null : joined
  }
  return null
}

function parseTimestamp(v: string | number | undefined): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) {
    // Heuristic: values < 1e12 are seconds since epoch, otherwise ms.
    return v < 1e12 ? Math.round(v * 1_000) : Math.round(v)
  }
  if (typeof v === 'string' && v.length > 0) {
    const t = Date.parse(v)
    return Number.isFinite(t) ? t : null
  }
  return null
}
