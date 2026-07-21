/**
 * @neutronai/gateway/wiring — agentic per-project KICKOFF composer.
 *
 * The doc-synthesis half of the one-time agentic kickoff a project gets at
 * onboarding completion (build-project-kickoff.ts). When a materialized project
 * carries enough signal, the kickoff drafts a GENUINELY useful starting doc (a
 * work project's starting plan, or a hobby's light-research notes) instead of
 * emitting the old one-liner "want me to X?" opening.
 *
 * Deliberately a SIBLING of `build-project-doc-composer.ts` (the materializer's
 * README/transcript-summary composer) rather than an extension of it: this reuses
 * that module's exact CC-substrate discipline (the `AnthropicMessagesClient` shim
 * → `substrate.start`; NO direct api.anthropic.com — memory
 * feedback_cc_subprocess_substrate.md; `getBestModel()`, never pre-downgraded;
 * AbortController wall-clock budget; throw-on-empty so the CALLER falls back), but
 * its `kind`s (`draft_doc` | `interest_brief`) and prompts are kickoff-specific and
 * must not leak into the materializer's `ComposeProjectDocInput` type.
 *
 * Failure contract: throw freely. `build-project-kickoff.ts` catches and, per the
 * "better nothing than a bad job" rule (Ryan, 2026-07-01), degrades to the
 * deterministic prompt-the-user opening (work) or engaging questions (hobby) —
 * never a half-baked doc.
 */

import type { AnthropicMessagesClient } from '@neutronai/onboarding/interview/anthropic-client.ts'
import { getBestModel } from '@neutronai/runtime/models.ts'

/** Output budget per kickoff doc — a starting plan / research brief is 1-2
 *  screens, not a book (mirrors build-project-doc-composer's DOC_MAX_TOKENS). */
export const KICKOFF_DOC_MAX_TOKENS = 2_000

/** Per-call wall-clock budget. The kickoff rides the fire-and-forget finalize
 *  (latency-tolerant) but must not hold a project's opening hostage. */
export const KICKOFF_COMPOSE_TIMEOUT_MS = 90_000

/** What the kickoff composer is asked to draft. */
export interface KickoffComposeInput {
  /** `draft_doc` = a work project's starting plan; `interest_brief` = a hobby's
   *  light-research / starting notes. */
  kind: 'draft_doc' | 'interest_brief'
  /**
   * The materialized project's id. Threaded onto the substrate dispatch as
   * `metering_context.project_id` (ISSUES #378) so THIS project's kickoff-doc
   * synthesis lands on its OWN warm `cc-agent-*` REPL — never the shared session
   * that let one project's draft leak into the next. Concurrency-safe (per
   * dispatch). Empty/absent falls back to the substrate's shared namespace.
   */
  project_id?: string
  project_name: string
  /** The doc's working title (drives the `# <title>` heading). */
  doc_title: string
  /**
   * Redacted context lines the composer grounds in — STATUS one-liner, open
   * threads, README overview excerpt, import-derived topics/rationale. NEVER
   * raw transcript / email content (extends the WowSelectorCollectedData
   * redaction discipline). Empty is tolerated; the composer then writes a
   * thoughtful starting scaffold from the name + title alone.
   */
  context_lines: readonly string[]
}

/** The composer surface `build-project-kickoff.ts` consumes. Returns the doc
 *  markdown body (no code fences, no preamble). Throws on empty / LLM error. */
export type ProjectKickoffComposer = (input: KickoffComposeInput) => Promise<string>

export interface BuildProjectKickoffComposerInput {
  client: AnthropicMessagesClient
  /** Override the client's factory default model. Omit in production. */
  model?: string
  max_tokens?: number
  timeout_ms?: number
}

export function buildProjectKickoffComposer(
  input: BuildProjectKickoffComposerInput,
): ProjectKickoffComposer {
  const max_tokens = input.max_tokens ?? KICKOFF_DOC_MAX_TOKENS
  const timeout_ms = input.timeout_ms ?? KICKOFF_COMPOSE_TIMEOUT_MS
  return async (doc: KickoffComposeInput): Promise<string> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout_ms)
    try {
      const response = await input.client.messages.create({
        model: input.model ?? getBestModel(),
        system: systemPrompt(doc.kind),
        messages: [{ role: 'user', content: userPrompt(doc) }],
        max_tokens,
        signal: controller.signal,
        // Route THIS project's doc synthesis to its OWN per-project warm session
        // (ISSUES #378) — folded into `spec.metering_context.project_id`.
        ...(doc.project_id !== undefined && doc.project_id.length > 0
          ? { project_id: doc.project_id }
          : {}),
      })
      const text = (response.content[0]?.text ?? '').trim()
      if (text.length === 0) {
        throw new Error(`project-kickoff-composer: empty ${doc.kind} synthesis`)
      }
      return text
    } finally {
      clearTimeout(timer)
    }
  }
}

function systemPrompt(kind: KickoffComposeInput['kind']): string {
  const shared =
    'You draft a starting document for a personal AI workspace, on behalf of the ' +
    'assistant, for the workspace owner to read the moment they open a freshly ' +
    'created project. Output ONLY the markdown document body (no code fences ' +
    'around it, no preamble, no explanation). Write in second person to the owner ' +
    '("you"). Never use em dashes; use hyphens. Be concrete and genuinely useful; ' +
    'ground every claim in the provided context and never invent facts, names, ' +
    'numbers, deadlines, or links. If the context is thin, write a thoughtful ' +
    'starting scaffold and pose sharp questions rather than padding with filler.'
  if (kind === 'draft_doc') {
    return (
      `${shared}\n\n` +
      'Draft a short STARTING PLAN: a 1-2 sentence framing of what this project is ' +
      'about, then a "Next steps" section of 3-6 concrete, checkable first moves ' +
      'drawn from the context (open threads, suggested topics, the overview), then ' +
      'a brief "Open questions" section naming what you would need from the owner ' +
      'to go deeper. Start with a `# <title>` heading. Keep it tight and actionable.'
    )
  }
  return (
    `${shared}\n\n` +
    'Draft LIGHT STARTING NOTES for this interest/hobby: a warm 1-2 sentence framing, ' +
    'then a short "Worth exploring" section of 3-5 genuinely interesting angles, ' +
    'directions, or beginner-to-deeper paths grounded in the context, then a brief ' +
    '"To get you going" section with a couple of concrete first things to try or ' +
    'look into. Start with a `# <title>` heading. Be curious and encouraging, never ' +
    'generic; if you truly have nothing to ground on, ask engaging questions instead.'
  )
}

function userPrompt(doc: KickoffComposeInput): string {
  const lines: string[] = [
    `Project name: ${doc.project_name}`,
    `Document title: ${doc.doc_title}`,
  ]
  if (doc.context_lines.length > 0) {
    lines.push('', 'Context to ground the document in:')
    for (const line of doc.context_lines) {
      const trimmed = line.trim()
      if (trimmed.length > 0) lines.push(`- ${trimmed}`)
    }
  } else {
    lines.push('', 'No additional context is available beyond the project name.')
  }
  return lines.join('\n')
}
