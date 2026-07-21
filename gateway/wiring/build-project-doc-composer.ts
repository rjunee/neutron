/**
 * @neutronai/gateway/wiring — Item 4 project-doc composer.
 *
 * Production `ProjectDocComposer` for the project materializer
 * (onboarding/wow-moment/project-materializer.ts): synthesizes a
 * project's README.md and docs/transcript-summary.md from the import
 * signal + retained transcript excerpts.
 *
 * HARD RULE — all synthesis dispatches over the CC substrate via the
 * `AnthropicMessagesClient` shim (`buildGatewayAnthropicMessagesClient`
 * → `substrate.start`); NO direct api.anthropic.com (memory
 * feedback_cc_subprocess_substrate.md). Credentials resolve per dispatch
 * through the substrate's `resolveLlmCredentials` pool (owner Max OAuth
 * first) — the same path Item 1's live-agent turn uses.
 *
 * Model: the client's factory default (BEST_MODEL, latest Opus) — never
 * pre-emptively downgraded (memory feedback_default_to_opus.md).
 *
 * Failure contract: throw freely — the materializer's
 * `composeOrFallback` catches and falls back to the deterministic
 * template (spec § 4.2c failure isolation). This module never needs its
 * own fallback path.
 */

import type {
  ComposeProjectDocInput,
  ProjectDocComposer,
} from '@neutronai/onboarding/wow-moment/project-materializer.ts'
import type { AnthropicMessagesClient } from '@neutronai/onboarding/interview/anthropic-client.ts'
import { getBestModel } from '@neutronai/runtime/models.ts'

/** Output budget per doc — a README/summary is 1-2 screens, not a book. */
export const DOC_MAX_TOKENS = 2_000

/** Per-call wall-clock budget. Doc-gen rides the wow→completed transition
 *  (latency-tolerant) but must not hold the dispatch hostage. */
export const DOC_COMPOSE_TIMEOUT_MS = 90_000

export interface BuildProjectDocComposerInput {
  client: AnthropicMessagesClient
  /** Override the client's factory default model. Omit in production. */
  model?: string
  max_tokens?: number
  timeout_ms?: number
}

export function buildProjectDocComposer(
  input: BuildProjectDocComposerInput,
): ProjectDocComposer {
  const max_tokens = input.max_tokens ?? DOC_MAX_TOKENS
  const timeout_ms = input.timeout_ms ?? DOC_COMPOSE_TIMEOUT_MS
  return async (doc: ComposeProjectDocInput): Promise<string> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout_ms)
    try {
      const response = await input.client.messages.create({
        model: input.model ?? getBestModel(),
        system: systemPrompt(doc.kind),
        messages: [{ role: 'user', content: userPrompt(doc) }],
        max_tokens,
        signal: controller.signal,
        // ISSUES #378 — route THIS project's README / transcript-summary synthesis
        // to its OWN per-project warm session (folded into
        // `spec.metering_context.project_id`). `doc.slug` is the project's
        // canonical bind id (materializer: `slug: bind_id` = the openings'
        // `project_id`), so the doc + opening + kickoff for one project all land on
        // the SAME isolated session — never the shared one that let one project's
        // draft leak into the next.
        ...(doc.slug.length > 0 ? { project_id: doc.slug } : {}),
      })
      const text = (response.content[0]?.text ?? '').trim()
      if (text.length === 0) {
        throw new Error(`project-doc-composer: empty ${doc.kind} synthesis`)
      }
      return text
    } finally {
      clearTimeout(timer)
    }
  }
}

function systemPrompt(kind: ComposeProjectDocInput['kind']): string {
  const shared =
    'You write project documents for a personal AI workspace. Output ONLY the ' +
    'markdown document body (no code fences around it, no preamble, no ' +
    'explanation). Write in second person to the workspace owner ("you"). ' +
    'Never use em dashes; use hyphens. Be concrete; cite only what the ' +
    'provided material supports — never invent facts, names, or numbers.'
  if (kind === 'readme') {
    return (
      `${shared}\n\n` +
      'Write a README.md for the project: a 2-4 paragraph overview of what ' +
      'this project is, what the owner is trying to accomplish, and the ' +
      'currently-live threads, drawn from the context and transcript ' +
      'excerpts. Start with a `# <project name>` heading. If transcript ' +
      'excerpts are present, ground the overview in them.'
    )
  }
  return (
    `${shared}\n\n` +
    'Write a transcript-summary document: synthesize the provided raw ' +
    'conversation excerpts into what this project has been discussed as. ' +
    'Structure: `# Transcript summary - <project name>` heading, then ' +
    'short sections for key decisions, open threads, and recurring topics ' +
    '(omit a section when the material has nothing for it). End with a ' +
    'one-line pointer to `research/transcripts/imported-transcript-slices.md` ' +
    'as the raw source.'
  )
}

function userPrompt(doc: ComposeProjectDocInput): string {
  const lines: string[] = [
    `Project name: ${doc.project_name}`,
    `Project context: ${doc.context}`,
  ]
  const signal: string[] = []
  if (doc.related.topics.length > 0) signal.push(`topics: ${doc.related.topics.join(', ')}`)
  if (doc.related.entities.length > 0) signal.push(`entities: ${doc.related.entities.join(', ')}`)
  if (doc.related.interests.length > 0) {
    signal.push(`interests: ${doc.related.interests.join(', ')}`)
  }
  if (signal.length > 0) {
    lines.push(`Related signal from the history import: ${signal.join('; ')}`)
  }
  if (doc.transcript_excerpt.length > 0) {
    lines.push(
      '',
      'Raw transcript excerpts related to this project:',
      '<transcript-excerpts>',
      doc.transcript_excerpt,
      '</transcript-excerpts>',
    )
  } else {
    lines.push('', 'No transcript excerpts matched this project.')
  }
  return lines.join('\n')
}
