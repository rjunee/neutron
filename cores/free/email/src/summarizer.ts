/**
 * @neutronai/email-managed-core — prose-brief summarizer (Haiku 4.5).
 *
 * Per docs/plans/email-managed-core-tier1-brief.md § 3.3. Composes a
 * 2-3 sentence prose brief over the structured row from the existing
 * `EmailSummarizer`. The MCP `email_summarize` tool exposes both
 * modes (structured-only when `as_brief:false`, structured + prose
 * brief when `as_brief:true`); the chat-command surface for
 * `/email summarize` always uses `as_brief:true`.
 *
 * Deterministic fallback: when the LLM call throws, returns a bullet-
 * style render of the structured row's `key_points` so the user never
 * sees an empty brief on a transient Haiku outage.
 */

import { createHash } from 'node:crypto'

import type { EmailSummary, GmailMessageFull } from './backend.ts'

/**
 * Locked v1 prompt template. The snapshot test in
 * `__tests__/summarizer.test.ts` asserts byte-stability so an
 * accidental template edit fails the suite at the unit level rather
 * than landing in prod silently.
 */
export const BRIEF_PROMPT_TEMPLATE = `You are the user's email-thread summarizer. Compose a 2-3 sentence prose brief covering:

1. What this email is about (one sentence — derived from subject + body below).
2. Who is involved (one sentence — sender + any clear addressee context).
3. The single most important thing the user should remember when they look at this (one sentence — the ask, the deadline, or the action expected).

Keep the tone direct, no filler, no greetings. The user is a busy operator — every sentence must earn its place.

EMAIL
- from: {{from}}
- to: {{to_csv}}
- subject: {{subject}}
- snippet: {{snippet}}
- body (first 1200 chars):
{{body_excerpt}}

STRUCTURED ANALYSIS
- key_points:
{{key_points_bullets}}
- sentiment: {{sentiment}}
- ask_or_response: {{ask_or_response}}
` as const

/** Body-excerpt length cap. Keeps prompts tractable for Haiku. */
export const BODY_EXCERPT_CHARS = 1200

export interface BriefSummary {
  text: string
  prompt_hash: string
  model: string
  outcome: 'ok' | 'llm_error'
}

export interface ComposeBriefSummaryDeps {
  structuredRow: EmailSummary
  rawMessage: GmailMessageFull
  /** Pluggable LLM call — production threads through the gateway's
   *  Haiku-fast substrate; tests inject a deterministic stub. */
  llm: (prompt: string) => Promise<string>
  /** Resolved Haiku-fast model id — stamped into the BriefSummary
   *  for audit. Production passes `FAST_MODEL` from `@neutronai/runtime`. */
  model: string
}

export function renderBriefPrompt(deps: {
  structuredRow: EmailSummary
  rawMessage: GmailMessageFull
}): string {
  const { structuredRow, rawMessage } = deps
  const toCsv = rawMessage.to.length === 0 ? '(none)' : rawMessage.to.join(', ')
  const keyPointsBullets =
    structuredRow.key_points.length === 0
      ? '  (none)'
      : structuredRow.key_points.map((p) => `  - ${p}`).join('\n')
  const bodyExcerpt =
    rawMessage.body_text.length > BODY_EXCERPT_CHARS
      ? `${rawMessage.body_text.slice(0, BODY_EXCERPT_CHARS)}…`
      : rawMessage.body_text
  return BRIEF_PROMPT_TEMPLATE.replaceAll('{{from}}', rawMessage.from)
    .replaceAll('{{to_csv}}', toCsv)
    .replaceAll('{{subject}}', rawMessage.subject)
    .replaceAll('{{snippet}}', rawMessage.snippet)
    .replaceAll('{{body_excerpt}}', bodyExcerpt)
    .replaceAll('{{key_points_bullets}}', keyPointsBullets)
    .replaceAll('{{sentiment}}', structuredRow.sentiment)
    .replaceAll('{{ask_or_response}}', structuredRow.ask_or_response)
}

function fallbackBrief(structuredRow: EmailSummary): string {
  if (structuredRow.key_points.length === 0) {
    return `Message from ${structuredRow.from}: ${structuredRow.subject}.`
  }
  const bullets = structuredRow.key_points
    .slice(0, 3)
    .map((p) => `- ${p}`)
    .join('\n')
  return `${structuredRow.subject}\n${bullets}`
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

export async function composeBriefSummary(
  deps: ComposeBriefSummaryDeps,
): Promise<BriefSummary> {
  const prompt = renderBriefPrompt({
    structuredRow: deps.structuredRow,
    rawMessage: deps.rawMessage,
  })
  const prompt_hash = sha256(prompt)
  try {
    const text = await deps.llm(prompt)
    const trimmed = text.trim()
    if (trimmed.length === 0) {
      return {
        text: fallbackBrief(deps.structuredRow),
        prompt_hash,
        model: deps.model,
        outcome: 'llm_error',
      }
    }
    return { text: trimmed, prompt_hash, model: deps.model, outcome: 'ok' }
  } catch {
    return {
      text: fallbackBrief(deps.structuredRow),
      prompt_hash,
      model: deps.model,
      outcome: 'llm_error',
    }
  }
}

/**
 * Hash the prompt template body (NOT the rendered prompt) so the
 * summary cache invalidates when the template changes but stays
 * stable across runs with the same template. Used as the cache key
 * suffix in `summary_cache.template_hash`.
 */
export function briefTemplateHash(): string {
  return sha256(BRIEF_PROMPT_TEMPLATE)
}
