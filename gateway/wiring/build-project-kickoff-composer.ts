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

/** Output budget for the opening MESSAGE — a 2-3 sentence chat bubble (#377). */
export const OPENING_MESSAGE_MAX_TOKENS = 350

/** Per-call wall-clock budget. The kickoff rides the fire-and-forget finalize
 *  (latency-tolerant) but must not hold a project's opening hostage. */
export const KICKOFF_COMPOSE_TIMEOUT_MS = 90_000

/** What the kickoff composer is asked to draft. */
export interface KickoffComposeInput {
  /**
   * `draft_doc` = a work project's starting plan; `interest_brief` = a hobby's
   * light-research / starting notes; `opening_message` = the short, fully
   * LLM-composed opening CHAT BUBBLE that presents the drafted doc to the owner
   * (replaces the retired hardcoded lead scaffolds — #377).
   */
  kind: 'draft_doc' | 'interest_brief' | 'opening_message'
  /**
   * The project's canonical bind id — used ONLY to resolve this project's
   * ISOLATED compose session (`clientForProject(project_id)`). Every compose call
   * for one project keys the SAME per-project session → its docs + opening are
   * grounded in that project alone, never a session shared across projects (#378).
   */
  project_id: string
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
  /**
   * PER-PROJECT compose-client factory (#377/#378, Approach A). Resolves the
   * `AnthropicMessagesClient` bound to ONE project's ISOLATED compose session
   * (keyed by `project_id`, a DISTINCT pool key from the live-chat `cc-agent-*`
   * session, TOOLLESS). Routing the kickoff DOC + opening MESSAGE synthesis
   * through each project's own session is what stops project 2/3's starting plan
   * / opener from echoing project 1 (#378), and never touches the owner's live
   * chat REPL (B1). Production wires `composeClientForProject` (open/composer.ts);
   * tests inject a factory over a recording stub. Called with `doc.project_id`.
   */
  clientForProject: (project_id: string) => AnthropicMessagesClient
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
    // Resolve THIS project's isolated compose session — every kickoff compose for
    // one project keys the same per-project session; never shared across projects.
    const client = input.clientForProject(doc.project_id)
    // The opening MESSAGE is a short chat bubble, not a 1-2 screen doc.
    const call_max_tokens = doc.kind === 'opening_message' ? OPENING_MESSAGE_MAX_TOKENS : max_tokens
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout_ms)
    try {
      const response = await client.messages.create({
        model: input.model ?? getBestModel(),
        system: systemPrompt(doc.kind),
        messages: [{ role: 'user', content: userPrompt(doc) }],
        max_tokens: call_max_tokens,
        signal: controller.signal,
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
  if (kind === 'opening_message') {
    // #377 — the WHOLE opening bubble is LLM-composed + unique per project (no
    // hardcoded lead). This composes the short chat message that presents the
    // starting doc the kickoff just drafted; the caller appends the tappable
    // doc link, so DO NOT emit a link/URL/markdown-link yourself.
    // The beats below (lead with THIS project's specifics, mention the drafted
    // doc so the appended link lands, invite the owner to steer) are FUNCTIONAL,
    // not a verbatim template — the prompt bans stock phrasing + fixed sentence
    // order so two projects never read like the same message with nouns swapped.
    return (
      'You are Neutron, a calm, grounded personal-AI workspace agent. You are writing the ' +
      'OPENING chat message the workspace owner sees the first time they open this freshly ' +
      'created project, right after you drafted a starting document for it. Output ONLY the ' +
      'message text (plain text, no markdown headings, no bullet lists, no code fences, no ' +
      'preamble, no links or URLs). Write in second person ("you"), warm and terse, 2-3 ' +
      'sentences, grounded ONLY in the provided context - never invent facts, names, ' +
      'numbers, or deadlines. Lead with the most specific, interesting thing about THIS ' +
      'project from the context (an open thread, a concrete angle from the drafted ' +
      'document, why it matters now), mention naturally that you drafted a starting ' +
      'document for it, and close by inviting the owner to steer - review it, correct it, ' +
      'or point you at what matters most. Vary the wording to fit this project: do NOT ' +
      'reuse stock template phrases (for example "I took a first pass", "I drafted a ' +
      'starting document", "tell me what to change"), and do not follow a fixed sentence ' +
      'order - two projects should never read like the same message with nouns swapped. ' +
      'Never use em dashes; use hyphens. No greetings, no "Hi", no meta narration. Do NOT ' +
      'include a link or the document filename - a tappable link is appended after your text.'
    )
  }
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
