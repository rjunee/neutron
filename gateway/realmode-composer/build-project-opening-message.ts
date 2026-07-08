/**
 * @neutronai/gateway/realmode-composer — Item 5 project opening-message
 * composer (ISSUES #208).
 *
 * Per docs/plans/project-opening-message-redesign-2026-06-10.md +
 * docs/plans/post-onboarding-experience-spec-2026-06-10.md § ITEM 5
 * (Sam: scrap the templated rationale + Summarise-X button wall; each
 * project opens with a free-form LLM paragraph on what the project IS,
 * then exactly ONE next move, and the user just types).
 *
 * Given a single project's name + its Item 4 MATERIALIZED docs
 * (Projects/<slug>/README.md + docs/transcript-summary.md — the primary
 * source) + the matching Pass-2 import row (fallback signal), call the
 * best model to produce the opening bubble:
 *
 *   {
 *     body: "<2-4 sentence paragraph on what the project is>
 *
 *            <ONE next move: suggested action OR reminder offer OR
 *             'What would you like to do next?'>"
 *   }
 *
 * Output is PLAIN TEXT (no JSON envelope — there are no button fields
 * any more), which also kills the strict-JSON parse-failure mode the
 * old seed composer carried.
 *
 * HARD RULE — the `anthropicClient` here is the CC-substrate-backed
 * shim (`buildGatewayAnthropicMessagesClient` → `substrate.start`,
 * gateway/index.ts); NO direct api.anthropic.com (memory
 * feedback_cc_subprocess_substrate.md).
 *
 * Model: BEST_MODEL (latest Opus) per Sam's standing "use the best
 * model" directive — the body lands in front of the user as their FIRST
 * chat-surface impression of each project; quality matters more than
 * latency at this volume (memory feedback_default_to_opus.md).
 *
 * Discipline mirrors the retired `build-project-seed-composer.ts`:
 *   - AbortController-backed hard timeout (8 s — slightly above the old
 *     6 s because the prompt now carries materialized-doc context)
 *   - swallow-errors → deterministic prose fallback (caller's emit loop
 *     ALSO falls back, belt-and-braces) — never emit nothing
 *
 * Cost: ~2-4 K input + ~200 output tokens per call, once per primary
 * project, once per onboarding (typically 3-8 projects ≈ ≤ $0.40).
 * Eager generation at the wow→completed transition was Sam-approved
 * over lazy-on-open (no first-open spinner).
 */

import { getBestModel } from '@neutronai/runtime/models.ts'
import type { AnthropicMessagesClient } from '@neutronai/onboarding/interview/anthropic-client.ts'
import {
  OPENING_MESSAGE_MAX_CHARS,
  buildDeterministicProjectOpening,
  type ComposeProjectOpeningFn,
  type ComposeProjectOpeningInput,
  type ProjectOpeningComposition,
} from './build-onboarding-handoff.ts'

// ---------------------------------------------------------------------------
// Options + factory
// ---------------------------------------------------------------------------

export const PROJECT_OPENING_COMPOSER_TIMEOUT_MS_DEFAULT = 8_000
export const PROJECT_OPENING_COMPOSER_MAX_TOKENS_DEFAULT = 350

/** Per-doc char budget inside the prompt (README / transcript summary). */
export const OPENING_PROMPT_DOC_MAX_CHARS = 6_000

export interface BuildProjectOpeningMessageComposerOptions {
  /** CC-substrate-backed messages shim (NO direct api.anthropic.com). */
  anthropicClient: AnthropicMessagesClient
  /** Override the model id. Defaults to `BEST_MODEL` (latest Opus). */
  model?: string
  /** Per-call timeout. Defaults to 8 s. */
  timeout_ms?: number
  /** Max output tokens. Defaults to 350 — a ≤700-char body fits easily. */
  max_tokens?: number
}

const SYSTEM_PROMPT = [
  'You are Neutron, a calm, grounded personal-AI workspace agent. You are composing the OPENING message for a project workspace the user is about to read for the first time after onboarding.',
  '',
  'Output PLAIN TEXT only: no markdown headings, no bullet lists, no JSON, no code fences, no preamble or commentary -- the text you return IS the chat bubble.',
  '',
  'Shape (exactly two parts, separated by ONE blank line):',
  '1) A free-form paragraph, 2-4 sentences, that tells the user what this project actually IS in their own context: what it covers, who and what is involved, and where things stand. When a STATUS.md document is provided, SUMMARIZE it: lead with its one-liner and current standing (status, priority, open threads), then add ONE short line inviting the user to correct anything that is stale or wrong (e.g. "Tell me what is off and I will update it."). Draw ONLY on the provided project documents and import signal -- never invent facts, names, or numbers. If the material is thin, say so honestly in one sentence and ask for the context you are missing.',
  '2) Exactly ONE next move, picked by judgment:',
  '   - an offer to take the single most useful concrete action (e.g. "Want me to pull together where the convertible note landed and what is still open?"), OR',
  '   - when the material shows a deadline, cadence, or follow-up obligation: an OFFER to set a reminder for it (offer only -- never claim a reminder was created), OR',
  '   - when nothing obvious surfaces: the plain question "What would you like to do next?"',
  '',
  'Rules:',
  '- NEVER lead with mention counts or statistics ("84 LLC mentions..." is exactly the opener being retired). Counts may inform the prose but never headline it.',
  '- Never use em dashes; use hyphens.',
  '- No greetings, no "Hi!", no filler, no meta narration like "Based on your imports...". State things directly, warm and terse.',
  `- Maximum ${OPENING_MESSAGE_MAX_CHARS} characters total.`,
  '- There are NO buttons. The user replies by typing, so the next move must read naturally as something they can answer in text.',
].join('\n')

/**
 * Build the production opening-message composer.
 *
 * Per-project flow:
 *   1. Compose the user-content payload: project name + the materialized
 *      README / transcript-summary (primary) + the import row (fallback
 *      signal) + cross-import facts.
 *   2. Call the model with `SYSTEM_PROMPT` + payload, hard timeout.
 *   3. Take the response as plain text (strip stray code fences), reject
 *      empty / absurdly oversize.
 *   4. Return `{ body }` — the emit site finalizes (em-dash
 *      normalization + 700-char clamp).
 *
 * On ANY failure (timeout / network / empty / oversize), return the
 * deterministic composition so the caller still ships a usable opening.
 */
export function buildProjectOpeningMessageComposer(
  opts: BuildProjectOpeningMessageComposerOptions,
): ComposeProjectOpeningFn {
  const timeout_ms = opts.timeout_ms ?? PROJECT_OPENING_COMPOSER_TIMEOUT_MS_DEFAULT
  const max_tokens = opts.max_tokens ?? PROJECT_OPENING_COMPOSER_MAX_TOKENS_DEFAULT
  return async (input: ComposeProjectOpeningInput): Promise<ProjectOpeningComposition> => {
    // Resolve the model PER-CALL (not at builder-build) so the model-update
    // watchdog's adopted id reaches this onboarding-path composer; an explicit
    // `opts.model` still wins. Frozen capture here would strand a post-boot flip.
    const model = opts.model ?? getBestModel()
    const userContent = buildOpeningUserContent(input)
    const controller = new AbortController()
    const timeoutHandle = setTimeout(() => controller.abort(), timeout_ms)
    let text: string
    try {
      const response = await opts.anthropicClient.messages.create({
        model,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userContent }],
        max_tokens,
        signal: controller.signal,
      })
      text = response.content.map((b) => b.text).join('').trim()
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err ?? 'unknown')
      console.warn(
        `[project-opening-composer] LLM call failed for instance=${input.project_slug} user=${input.user_id} project="${input.name}" model=${model} reason=${reason} -- falling back to deterministic prose`,
      )
      return buildDeterministicProjectOpening(input.name, input.imported_project, input.project_docs)
    } finally {
      clearTimeout(timeoutHandle)
    }
    const body = extractOpeningBody(text)
    if (body === null) {
      console.warn(
        `[project-opening-composer] LLM returned unusable body for instance=${input.project_slug} user=${input.user_id} project="${input.name}" -- falling back to deterministic prose`,
      )
      return buildDeterministicProjectOpening(input.name, input.imported_project, input.project_docs)
    }
    return { body }
  }
}

/**
 * Compose the user-content payload. Conservative on prompt-injection:
 * every user-derived field is sanitized plain text; the multi-line doc
 * bodies are fenced in named tags so a crafted README can't masquerade
 * as instructions. (The docs were themselves written by Item 4's
 * composer or its deterministic template, but a user can edit them on
 * disk between materialization and a re-fire.)
 *
 * Exported for unit testing.
 */
export function buildOpeningUserContent(input: ComposeProjectOpeningInput): string {
  const lines: string[] = []
  lines.push('Compose the opening message for this project.')
  lines.push('')
  lines.push(`Project name: ${sanitiseInline(input.name)}`)
  // BUG #308 fix (2026-06-19) — STATUS.md is the highest-signal source:
  // it carries the project's one-liner, status, priority, and open
  // threads. Feed it FIRST so the model summarizes the project's actual
  // standing rather than the README's overview prose.
  const status_md = input.project_docs.status_md
  if (status_md !== null && status_md.trim().length > 0) {
    lines.push('')
    lines.push('Project status document (STATUS.md) -- summarize THIS first:')
    lines.push('<project-status>')
    lines.push(sanitiseDoc(status_md))
    lines.push('</project-status>')
  }
  const readme = input.project_docs.readme
  if (readme !== null && readme.trim().length > 0) {
    lines.push('')
    lines.push('Project overview document (README.md):')
    lines.push('<project-readme>')
    lines.push(sanitiseDoc(readme))
    lines.push('</project-readme>')
  }
  const summary = input.project_docs.transcript_summary
  if (summary !== null && summary.trim().length > 0) {
    lines.push('')
    lines.push('Imported-history summary (docs/transcript-summary.md):')
    lines.push('<transcript-summary>')
    lines.push(sanitiseDoc(summary))
    lines.push('</transcript-summary>')
  }
  if (input.imported_project !== null) {
    lines.push('')
    const rationale = sanitiseInline(input.imported_project.rationale)
    lines.push(`Import synthesis rationale: ${rationale.length > 0 ? rationale : '(none)'}`)
    const topics = input.imported_project.suggested_topics
      .map((t) => sanitiseInline(t))
      .filter((t) => t.length > 0)
      .slice(0, 6)
    if (topics.length > 0) {
      lines.push('Suggested topics from the history import:')
      for (const t of topics) lines.push(`  - ${t}`)
    }
  }
  if (
    readme === null &&
    summary === null &&
    (status_md === null || status_md.trim().length === 0) &&
    input.imported_project === null
  ) {
    lines.push('')
    lines.push('Import history: NONE.')
    lines.push(
      'The user added this project without any imported history; you have no material to summarize. Say so plainly and ask what it is and what they want you to track.',
    )
  }
  // Cross-import facts — small grounding so names render correctly.
  if (input.import_result !== null) {
    const r = input.import_result
    const people = (r.facts?.key_people ?? []).slice(0, 5).map(sanitiseInline).filter((s) => s.length > 0)
    const companies = (r.facts?.companies ?? []).slice(0, 5).map(sanitiseInline).filter((s) => s.length > 0)
    if (people.length > 0) lines.push(`Key people across imports: ${people.join(', ')}`)
    if (companies.length > 0) lines.push(`Companies across imports: ${companies.join(', ')}`)
  }
  lines.push('')
  lines.push('Return ONLY the opening message text.')
  return lines.join('\n')
}

/**
 * Plain-text body extraction. The composer asks for raw prose, but
 * models occasionally wrap output in a code fence anyway — strip it.
 * Rejects (→ null) empty bodies and bodies more than 4× the cap (a
 * runaway that truncation would mangle into nonsense).
 *
 * Exported for unit testing.
 */
export function extractOpeningBody(text: string): string | null {
  if (typeof text !== 'string') return null
  let body = text.trim()
  if (body.startsWith('```')) {
    const fenceMatch = body.match(/^```[a-z]*\s*\n([\s\S]*?)\n```\s*$/)
    if (fenceMatch !== null && fenceMatch[1] !== undefined) {
      body = fenceMatch[1].trim()
    } else {
      body = body.replace(/^```[a-z]*\s*\n?/, '').replace(/\n?```\s*$/, '').trim()
    }
  }
  if (body.length === 0) return null
  if (body.length > OPENING_MESSAGE_MAX_CHARS * 4) return null
  return body
}

// ---------------------------------------------------------------------------
// Sanitizers
// ---------------------------------------------------------------------------

/**
 * Control-char strip built at runtime via `RegExp` + `String.fromCharCode`
 * so the source file stays free of literal control-byte escapes (which
 * tooling tends to mangle). Matches U+0000-U+0008, U+000B-U+001F, U+007F
 * (i.e. everything except \t and \n, which the doc sanitizer preserves).
 */
const CONTROL_CHAR_EXCEPT_WHITESPACE_REGEX = new RegExp(
  '[' +
    String.fromCharCode(0) +
    '-' +
    String.fromCharCode(8) +
    String.fromCharCode(0x0b) +
    '-' +
    String.fromCharCode(0x1f) +
    String.fromCharCode(0x7f) +
    ']+',
  'g',
)

/** Single-line field sanitizer — strips control chars, collapses ALL
 *  whitespace (incl. newlines) to single spaces, caps length. */
function sanitiseInline(s: string): string {
  if (typeof s !== 'string') return ''
  return s
    .replace(CONTROL_CHAR_EXCEPT_WHITESPACE_REGEX, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 600)
}

/** Multi-line doc sanitizer — preserves paragraph structure (newlines),
 *  strips other control chars, collapses 3+ blank lines, caps length so
 *  the per-doc prompt budget holds even if the reader's cap drifts. */
function sanitiseDoc(s: string): string {
  if (typeof s !== 'string') return ''
  return s
    .replace(/\r\n/g, '\n')
    .replace(CONTROL_CHAR_EXCEPT_WHITESPACE_REGEX, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, OPENING_PROMPT_DOC_MAX_CHARS)
}
