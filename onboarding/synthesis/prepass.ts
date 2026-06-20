/**
 * @neutronai/onboarding/synthesis — deterministic export pre-pass (Step 2).
 *
 * NO LLM. Per the design: Ryan's real export ≈ 14.4MB / ~3.6M tokens /
 * 3,385 conversations, so it cannot all sit in one 200K context. This
 * pre-pass streams the WHOLE export once, cheaply extracting high-signal
 * structure (titles, recency, length, term frequency) and persisting every
 * raw transcript to the `RawTranscriptStore` (kept on disk — the per-project
 * source corpus + gbrain feed). The output organizes the history so the
 * synthesis session reads it in a HANDFUL of passes, not ~170 per-chunk
 * spawns.
 *
 * "LLMs handle judgment; scripts handle everything else" (Sarver's rule):
 * this whole file is the scripts half — parsing, counting, bucketing into
 * read batches. The session does the judgment (what's a project, who's who).
 */

import type { ConversationMessage, ConversationRecord } from '../history-import/types.ts'
import { APPROX_CHARS_PER_TOKEN } from '../history-import/types.ts'
import type { RawTranscriptStore } from './raw-store.ts'
import type { ConversationSignal, PrepassResult, ReadingBatch } from './types.ts'

/**
 * Default conversations per read batch.
 *
 * 2026-06-18 (synthesis-completes root-cause fix): LOWERED 150 -> 25. The big
 * batch was the head of the production hang cascade: a single read pass over
 * ~87 conversations (the 12 000-token budget was the binding constraint on
 * Ryan's 173-convo export -> ~2 fat passes) took > 90 s, breached the synthesis
 * turn budget, ABANDON-POISONED the warm REPL (cancel -> respawn), and the next
 * pass paid a cold spawn + another fat read -> timed out again -> thrash.
 * Nothing completed; the import "finished" with an empty user-model -> the blank
 * "here's what I see:" wow. SMALLER batches make every read pass return well
 * under the budget (target each pass < ~45 s incl. a possible cold spawn), so no
 * pass times out -> no eviction -> the warm session PERSISTS and subsequent
 * passes are warm + fast. More passes, each fast (and finer progress
 * granularity as a bonus: the bar ticks per pass). 25 conversations/pass still
 * covers Ryan's 3,385-conversation export in reused warm passes, never
 * per-chunk spawns. Env-overridable.
 */
export const BATCH_TARGET_CONVERSATIONS_DEFAULT = readEnvInt(
  'NEUTRON_SYNTHESIS_BATCH_CONVERSATIONS',
  25,
)

/**
 * Upper bound on a batch's summary token estimate, so a batch of unusually
 * long snippets still fits the read prompt alongside the running model.
 *
 * 2026-06-18: LOWERED 12 000 -> 4 000 alongside the conversation-count drop so
 * the token budget (the binding constraint on a dense export) also keeps each
 * read pass small + fast. A ~4 000-token read prompt + the bounded routing JSON
 * it generates settles well inside the synthesis budget even on a cold spawn.
 */
export const BATCH_SUMMARY_TOKEN_BUDGET_DEFAULT = readEnvInt(
  'NEUTRON_SYNTHESIS_BATCH_SUMMARY_TOKENS',
  4_000,
)

/** Chars of the first substantive user message kept as a read-prompt snippet. */
export const SNIPPET_CHARS = 240

/** Top content terms retained per conversation. */
export const TOP_TERMS_PER_CONVERSATION = 8

/** Global top-terms retained on the pre-pass result. */
export const GLOBAL_TOP_TERMS = 60

export interface RunPrepassDeps {
  rawStore: RawTranscriptStore
  batch_target_conversations?: number
  batch_summary_token_budget?: number
}

/**
 * Stream an export's `ConversationRecord`s, persist raw transcripts, and
 * emit the organized `PrepassResult`. Conversations with zero messages are
 * still counted but contribute no raw transcript / terms.
 */
export async function runDeterministicPrepass(
  records: AsyncIterable<ConversationRecord>,
  deps: RunPrepassDeps,
): Promise<PrepassResult> {
  const signals: ConversationSignal[] = []
  const globalTerms = new Map<string, number>()
  let totalTokens = 0

  for await (const rec of records) {
    const id = rec.conversation_id
    if (typeof id !== 'string' || id.length === 0) continue
    const rendered = renderTranscript(rec.messages)
    if (rendered.length > 0) deps.rawStore.put(id, rendered)

    const approxTokens = Math.ceil(rendered.length / APPROX_CHARS_PER_TOKEN)
    totalTokens += approxTokens

    const termCounts = countTerms(rendered)
    for (const [term, n] of termCounts) {
      globalTerms.set(term, (globalTerms.get(term) ?? 0) + n)
    }
    const topTerms = rankTop(termCounts, TOP_TERMS_PER_CONVERSATION)

    const signal: ConversationSignal = {
      conversation_id: id,
      title: (rec.title ?? '').trim(),
      created_at: typeof rec.created_at === 'number' ? rec.created_at : null,
      message_count: rec.messages.length,
      approx_tokens: approxTokens,
      top_terms: topTerms,
      snippet: firstUserSnippet(rec.messages),
    }
    signals.push(signal)
  }

  // Recency-first read order: a fresh owner cares most about what's current,
  // and the accumulating model is strongest when recent context lands first.
  signals.sort((a, b) => recencyKey(b) - recencyKey(a))

  const batches = buildReadingBatches(
    signals,
    deps.batch_target_conversations ?? BATCH_TARGET_CONVERSATIONS_DEFAULT,
    deps.batch_summary_token_budget ?? BATCH_SUMMARY_TOKEN_BUDGET_DEFAULT,
  )

  return {
    total_conversations: signals.length,
    total_approx_tokens: totalTokens,
    conversations: signals,
    reading_batches: batches,
    top_terms: rankTopEntries(globalTerms, GLOBAL_TOP_TERMS),
  }
}

/** Sort key: timestamp when present, else 0 (undated sinks to the end). */
function recencyKey(s: ConversationSignal): number {
  return s.created_at ?? 0
}

/**
 * Group recency-sorted signals into read batches. Each batch is bounded by
 * BOTH a conversation count AND a summary-token budget so a run of unusually
 * long snippets splits early rather than overflowing the read prompt.
 */
export function buildReadingBatches(
  signals: ReadonlyArray<ConversationSignal>,
  targetCount: number,
  tokenBudget: number,
): ReadingBatch[] {
  const batches: ReadingBatch[] = []
  let current: string[] = []
  let currentTokens = 0
  const flush = (): void => {
    if (current.length === 0) return
    batches.push({ index: batches.length, conversation_ids: current, approx_tokens: currentTokens })
    current = []
    currentTokens = 0
  }
  for (const s of signals) {
    const summaryTokens = estimateSummaryTokens(s)
    if (
      current.length > 0 &&
      (current.length >= targetCount || currentTokens + summaryTokens > tokenBudget)
    ) {
      flush()
    }
    current.push(s.conversation_id)
    currentTokens += summaryTokens
  }
  flush()
  return batches
}

/** ~4-chars-per-token over the rendered read-summary of one conversation. */
function estimateSummaryTokens(s: ConversationSignal): number {
  const chars = s.title.length + s.snippet.length + s.top_terms.join(' ').length + 40
  return Math.ceil(chars / APPROX_CHARS_PER_TOKEN)
}

/** Render a conversation's message stream to a `ROLE: text` transcript. */
export function renderTranscript(messages: ReadonlyArray<ConversationMessage>): string {
  const lines: string[] = []
  for (const m of messages) {
    const text = m.text.trim()
    if (text.length === 0) continue
    lines.push(`${m.role.toUpperCase()}: ${text}`)
  }
  return lines.join('\n\n')
}

/** First substantive user message, trimmed to a snippet. */
function firstUserSnippet(messages: ReadonlyArray<ConversationMessage>): string {
  for (const m of messages) {
    if (m.role !== 'user') continue
    const text = m.text.replace(/\s+/g, ' ').trim()
    if (text.length === 0) continue
    return text.length <= SNIPPET_CHARS ? text : `${text.slice(0, SNIPPET_CHARS - 3).trimEnd()}...`
  }
  return ''
}

// ── Term extraction ────────────────────────────────────────────────────────

const STOPWORDS = new Set<string>([
  'the', 'and', 'for', 'that', 'this', 'with', 'you', 'your', 'are', 'was', 'have', 'has', 'had',
  'not', 'but', 'can', 'will', 'would', 'should', 'could', 'what', 'when', 'where', 'which', 'who',
  'how', 'why', 'про', 'from', 'they', 'them', 'their', 'there', 'here', 'about', 'into', 'out',
  'just', 'like', 'get', 'got', 'one', 'two', 'all', 'any', 'some', 'more', 'most', 'than', 'then',
  'now', 'also', 'been', 'being', 'were', 'its', 'it', 'is', 'in', 'on', 'of', 'to', 'a', 'an', 'as',
  'at', 'be', 'by', 'or', 'if', 'so', 'do', 'does', 'did', 'i', 'me', 'my', 'we', 'us', 'he', 'she',
  'his', 'her', 'user', 'assistant', 'system', 'okay', 'ok', 'yes', 'no', 'thanks', 'please', 'want',
  'need', 'make', 'made', 'use', 'using', 'used', 'see', 'know', 'think', 'going', 'let',
])

/** Count content terms (lowercased, 3+ chars, non-stopword) in a body. */
export function countTerms(body: string): Map<string, number> {
  const counts = new Map<string, number>()
  const tokens = body.toLowerCase().match(/[a-zа-я0-9][a-zа-я0-9'-]{2,}/giu)
  if (tokens === null) return counts
  for (const raw of tokens) {
    const term = raw.replace(/^[''-]+|[''-]+$/g, '')
    if (term.length < 3) continue
    if (STOPWORDS.has(term)) continue
    counts.set(term, (counts.get(term) ?? 0) + 1)
  }
  return counts
}

function rankTop(counts: Map<string, number>, n: number): string[] {
  return rankTopEntries(counts, n).map((e) => e.term)
}

function rankTopEntries(
  counts: Map<string, number>,
  n: number,
): Array<{ term: string; count: number }> {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([term, count]) => ({ term, count }))
}

function readEnvInt(envKey: string, fallback: number): number {
  const raw = process.env[envKey]
  if (raw === undefined) return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n >= 1 ? n : fallback
}
