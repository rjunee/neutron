/**
 * @neutronai/email-managed-core — Haiku-driven inbox triage.
 *
 * Per docs/plans/email-managed-core-tier1-brief.md § 3.4. Runs Haiku
 * 4.5 over the most-recent N inbox messages (default 50, capped by
 * Gmail's pagination) and returns a top-5 ranked list with one-line
 * reasons. Fired daily by the scheduler (default 08:00 local) AND
 * on-demand via `/email triage` chat-command + the `email_triage`
 * MCP tool.
 *
 * Mental-model lift from internal design notes
 * (Nova's existing triage), RE-IMPLEMENTED in-tree per § 8 of the
 * brief — ZERO external sources imports.
 *
 * Deterministic fallback: when the LLM call throws OR returns
 * malformed JSON, the function ranks by:
 *   1. is:important AND is:unread
 *   2. is:unread
 *   3. is:important
 *   4. chronological-newest
 * — so a transient Haiku outage never silently drops a daily triage.
 */

import { createHash } from 'node:crypto'

import type { GmailMessageMeta } from './backend.ts'

export const TRIAGE_PROMPT_TEMPLATE = `You are the user's email triage agent. The user has {{n}} unread/recent messages in their inbox. Pick the 5 they should look at TODAY, in priority order.

Selection rubric:
1. Anything with a clear ask/deadline from a known counterparty.
2. Anything from a person who is on the user's "important" axis (look for is:important label).
3. Anything that's a reply to a thread the user previously responded to (look for re: prefix or thread continuity).
4. De-prioritise newsletters, automated alerts, marketing — even if recent, even if unread.

For each pick, write ONE LINE explaining why it's #1-#5. No greetings, no filler.

Return JSON only — an array of exactly 5 objects:
  [{"message_id": "...", "rank": 1, "reason": "..."}, ...]

INBOX (newest first, label_ids in brackets):
{{inbox_bullets}}
` as const

/** Cap on triage size — the top-K. */
export const TRIAGE_TOP_K = 5
export const DEFAULT_LOOKBACK_MESSAGES = 50

export interface TriageItem {
  message_id: string
  thread_id: string
  from: string
  subject: string
  reason: string
  rank: number
}

export interface Triage {
  items: TriageItem[]
  prompt_hash: string
  model: string
  outcome: 'ok' | 'llm_error'
}

export interface ComposeTriageDeps {
  inbox: readonly GmailMessageMeta[]
  userTz: string
  llm: (prompt: string) => Promise<string>
  model: string
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

export function renderTriagePrompt(deps: {
  inbox: readonly GmailMessageMeta[]
}): string {
  const bullets =
    deps.inbox.length === 0
      ? '  (inbox is empty)'
      : deps.inbox
          .map(
            (m) =>
              `  - id=${m.id} thread=${m.thread_id} from=${m.from} subject="${m.subject}" snippet="${m.snippet.slice(0, 120)}" [${m.label_ids.join(',')}]`,
          )
          .join('\n')
  return TRIAGE_PROMPT_TEMPLATE.replaceAll('{{n}}', String(deps.inbox.length)).replaceAll(
    '{{inbox_bullets}}',
    bullets,
  )
}

interface RawTriageItem {
  message_id?: unknown
  rank?: unknown
  reason?: unknown
}

function deterministicRank(inbox: readonly GmailMessageMeta[]): TriageItem[] {
  const score = (m: GmailMessageMeta): number => {
    const isImportant = m.label_ids.includes('IMPORTANT')
    const isUnread = m.label_ids.includes('UNREAD')
    let s = 0
    if (isImportant && isUnread) s = 4
    else if (isUnread) s = 3
    else if (isImportant) s = 2
    else s = 1
    return s
  }
  const sorted = [...inbox].sort((a, b) => {
    const ds = score(b) - score(a)
    if (ds !== 0) return ds
    return Date.parse(b.internal_date) - Date.parse(a.internal_date)
  })
  return sorted.slice(0, TRIAGE_TOP_K).map((m, idx) => ({
    message_id: m.id,
    thread_id: m.thread_id,
    from: m.from,
    subject: m.subject,
    reason: deterministicReason(m),
    rank: idx + 1,
  }))
}

function deterministicReason(m: GmailMessageMeta): string {
  const flags: string[] = []
  if (m.label_ids.includes('IMPORTANT')) flags.push('important')
  if (m.label_ids.includes('UNREAD')) flags.push('unread')
  if (flags.length === 0) return 'recent inbox message'
  return flags.join(' + ')
}

/**
 * Compose triage. Returns the LLM-ranked top-5 on success, the
 * deterministic-fallback ranking on LLM error or malformed output.
 */
export async function composeTriage(deps: ComposeTriageDeps): Promise<Triage> {
  const prompt = renderTriagePrompt({ inbox: deps.inbox })
  const prompt_hash = sha256(prompt)
  if (deps.inbox.length === 0) {
    return { items: [], prompt_hash, model: deps.model, outcome: 'ok' }
  }
  let raw: string
  try {
    raw = await deps.llm(prompt)
  } catch {
    return {
      items: deterministicRank(deps.inbox),
      prompt_hash,
      model: deps.model,
      outcome: 'llm_error',
    }
  }
  const parsed = parseTriageResponse(raw)
  if (parsed === null) {
    return {
      items: deterministicRank(deps.inbox),
      prompt_hash,
      model: deps.model,
      outcome: 'llm_error',
    }
  }
  // Hydrate the LLM-ranked picks with the matching inbox metadata.
  // Drop any LLM picks pointing at a message id NOT in the inbox
  // (defence against hallucination); cap to TRIAGE_TOP_K.
  const idIndex = new Map<string, GmailMessageMeta>()
  for (const m of deps.inbox) idIndex.set(m.id, m)
  const items: TriageItem[] = []
  for (const p of parsed) {
    if (items.length >= TRIAGE_TOP_K) break
    const meta = idIndex.get(p.message_id)
    if (meta === undefined) continue
    items.push({
      message_id: meta.id,
      thread_id: meta.thread_id,
      from: meta.from,
      subject: meta.subject,
      reason: p.reason,
      rank: items.length + 1,
    })
  }
  if (items.length === 0) {
    return {
      items: deterministicRank(deps.inbox),
      prompt_hash,
      model: deps.model,
      outcome: 'llm_error',
    }
  }
  return { items, prompt_hash, model: deps.model, outcome: 'ok' }
}

interface ParsedPick {
  message_id: string
  rank: number
  reason: string
}

function parseTriageResponse(raw: string): ParsedPick[] | null {
  // Strip optional code fences.
  let body = raw.trim()
  if (body.startsWith('```')) {
    // Drop the first line + the trailing fence.
    const lines = body.split('\n')
    if (lines.length >= 2) {
      lines.shift()
      while (lines.length > 0 && (lines[lines.length - 1] ?? '').trim() === '```') {
        lines.pop()
      }
      body = lines.join('\n').trim()
    }
  }
  // Find the first '['
  const first = body.indexOf('[')
  if (first === -1) return null
  let jsonish = body.slice(first)
  // Trim anything after the last ']'.
  const last = jsonish.lastIndexOf(']')
  if (last === -1) return null
  jsonish = jsonish.slice(0, last + 1)
  let arr: unknown
  try {
    arr = JSON.parse(jsonish)
  } catch {
    return null
  }
  if (!Array.isArray(arr)) return null
  const out: ParsedPick[] = []
  for (const entry of arr) {
    if (entry === null || typeof entry !== 'object') continue
    const e = entry as RawTriageItem
    const id = typeof e.message_id === 'string' ? e.message_id : null
    const rank =
      typeof e.rank === 'number'
        ? Math.floor(e.rank)
        : typeof e.rank === 'string'
          ? Number.parseInt(e.rank, 10)
          : null
    const reason = typeof e.reason === 'string' ? e.reason : ''
    if (id === null || rank === null || Number.isNaN(rank)) continue
    out.push({ message_id: id, rank, reason })
  }
  if (out.length === 0) return null
  // Sort by rank ASC.
  return out.sort((a, b) => a.rank - b.rank)
}

export function triagePromptTemplateHash(): string {
  return sha256(TRIAGE_PROMPT_TEMPLATE)
}
