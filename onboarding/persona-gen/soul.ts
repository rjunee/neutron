/**
 * @neutronai/onboarding — SOUL.md generator (P2 S2).
 *
 * Per docs/plans/P2-onboarding.md § 2.6. Composes the user's SOUL.md
 * from:
 *   1. The archetype blend (voice / comm / decision sections from the
 *      curated 24 + any LLM extensions).
 *   2. The interview transcript voice signals (preferred verbosity,
 *      structure preference, contemplative phrases captured).
 *   3. Optional Pass-2 import-derived voice signals (for users who
 *      imported history) — left empty in S2 since import lands in S3.
 *
 * The output is a complete SOUL.md document conforming to the @-import
 * contract: it can be loaded directly into a Claude Code session by
 * adding `@SOUL.md` to a project's CLAUDE.md.
 *
 * No em-dashes. No validating-opening templates. The cringe-check pass
 * (cringe-check.ts) enforces both as a regen trigger.
 */

import type { BlendedArchetype } from '../archetypes/compose.ts'

/**
 * P2 v2 § 7 — InterviewSignals shape extended for v2 collected_data.
 *
 * v2 adds: `agent_personality` (free-text phrase the user typed at
 * `personality_offered`), `agent_name` (the explicit name picked at
 * `agent_name_chosen` — replaces the v1 "slug doubles as agent name"
 * shortcut), `primary_projects` (≥3 entries audited before
 * `persona_synthesizing`), `non_work_interests` (≥1 entry — required),
 * and optional `companies` + `work_themes`. v1's `display_name` becomes
 * optional; v2 prefers `agent_name`.
 */
export interface InterviewSignals {
  /** The user's chosen self-name (v1 legacy — v2 prefers `user_first_name`). */
  display_name: string
  /** P2 v2 § 4.1 — the user's first name captured at signup. */
  user_first_name?: string
  /**
   * P2 v2 § 4.1 — explicit agent name captured at `agent_name_chosen`.
   * Used as the SOUL.md voice subject ("You are <name>..."). When absent
   * the generator falls through to a generic "You are a personal agent."
   * opener so v1 fixtures keep rendering.
   */
  agent_name?: string
  /**
   * P2 v2 § 2.6 — free-text personality phrase captured at
   * `personality_offered`. Threaded into the SOUL.md "Archetypal Blend"
   * section verbatim when the curated library returns no match (see
   * `composeFromFreeText` in `../archetypes/compose.ts`).
   */
  agent_personality?: string
  /** P2 v2 § 4.1 — primary projects (≥3 required) surfaced for the agent's awareness. */
  primary_projects?: ReadonlyArray<string>
  /**
   * P2 v2 § 4.1 — non-work interests (≥1 required). Fuels the
   * "Dharma Thread" / interest-check-in cadence (wow action 06, S9).
   */
  non_work_interests?: ReadonlyArray<string>
  /** P2 v2 § 4.1 — optional work themes (Atlas demoted to soft hint). */
  work_themes?: ReadonlyArray<string>
  /** P2 v2 § 4.1 — companies the user runs / leads (optional). */
  companies?: ReadonlyArray<string>
  /** What the user said about how they work (rituals_captured, etc). */
  rituals?: ReadonlyArray<string>
  /** Free-text phrases captured from the work-pattern phase. */
  work_pattern?: string
  /** What the user said about time style (async / real-time / daily). */
  time_style?: string
  /** Captured contemplative tradition phrases (regex-matched in interview). */
  contemplative_phrases?: ReadonlyArray<string>
  /** Captured names of people the user mentioned (for relationship awareness). */
  inner_circle?: ReadonlyArray<string>
  /**
   * T1 (2026-05-13) — restart hint captured on the `persona_reviewed`
   * Restart sub-flow (the user's freeform reply to "What should be
   * different this time?"). When set, the generator surfaces it
   * inline so the redraft visibly reflects the user's ask. Threaded
   * through `PersonaComposer.compose({ regen_hint })`.
   */
  regen_hint?: string
}

export interface SoulGenInput {
  archetype_blend: BlendedArchetype
  signals: InterviewSignals
}

/**
 * Pure synthesizer — deterministic given the same inputs. The cringe-
 * check loop sits ABOVE this function and re-runs with adjusted prompts
 * if the output trips the flag threshold. We keep this file pure (no
 * substrate calls) so unit tests can lock the output shape.
 */
export function generateSoulMd(input: SoulGenInput): string {
  const { archetype_blend, signals } = input
  const lines: string[] = []
  lines.push(`# SOUL.md`)
  lines.push('')
  lines.push(`_${composeOpenerSentence(signals)}_`)
  lines.push('')
  lines.push(`## Archetypal Blend`)
  lines.push('')
  lines.push(archetype_blend.voice_md)
  if (
    typeof signals.agent_personality === 'string' &&
    signals.agent_personality.trim().length > 0 &&
    archetype_blend.slugs[0] !== 'free-text' &&
    !archetype_blend.voice_md.includes(signals.agent_personality.trim())
  ) {
    lines.push('')
    lines.push(
      `In the user's own words, the disposition is: "${signals.agent_personality.trim()}". ` +
        `Use the archetypal voice as the base, the phrase as the temperature.`,
    )
  }
  lines.push('')
  lines.push(`## Operating Principles`)
  lines.push('')
  const principles = derivePrinciples(signals)
  for (let i = 0; i < principles.length; i++) {
    lines.push(`${i + 1}. ${principles[i]}`)
  }
  lines.push('')
  lines.push(`## Communication Style`)
  lines.push('')
  lines.push(archetype_blend.comm_md)
  if (signals.time_style !== undefined && signals.time_style.length > 0) {
    lines.push('')
    lines.push(`Time cadence: ${humanizeTimeStyle(signals.time_style)}.`)
  }
  lines.push('')
  lines.push(`## Decision Style`)
  lines.push('')
  lines.push(archetype_blend.decision_md)
  if (signals.contemplative_phrases !== undefined && signals.contemplative_phrases.length > 0) {
    lines.push('')
    lines.push(`## Dharma Thread`)
    lines.push('')
    lines.push(
      `Surface a brief reframe at the right moment when the user signals: ${signals.contemplative_phrases.join(', ')}. ` +
        `Tone: natural, grounded, brief. Never forced.`,
    )
  }
  if (typeof signals.regen_hint === 'string' && signals.regen_hint.length > 0) {
    lines.push('')
    lines.push(`## User Direction (Restart)`)
    lines.push('')
    lines.push(
      `On regenerate the user asked for: ${signals.regen_hint.trim()}`,
    )
  }
  lines.push('')
  return lines.join('\n')
}

function composeOpenerSentence(signals: InterviewSignals): string {
  const agent =
    typeof signals.agent_name === 'string' && signals.agent_name.trim().length > 0
      ? signals.agent_name.trim()
      : null
  const user =
    typeof signals.user_first_name === 'string' && signals.user_first_name.trim().length > 0
      ? signals.user_first_name.trim()
      : null
  if (agent !== null && user !== null) {
    return `You are ${agent}. Voice and disposition below. You work with ${user}.`
  }
  if (agent !== null) {
    return `You are ${agent}. Voice and disposition below.`
  }
  return `You are a personal agent. Voice and disposition below.`
}

function derivePrinciples(signals: InterviewSignals): string[] {
  const out: string[] = []
  out.push(`Truth first. State reality clearly. No fluff or appeasement.`)
  out.push(`Essence over excess. Find the vital move; cut the rest.`)
  out.push(`Wisdom in action. Insight must become execution.`)
  if (signals.primary_projects !== undefined && signals.primary_projects.length > 0) {
    out.push(
      `Keep the primary projects in view: ${signals.primary_projects.join(', ')}.`,
    )
  }
  if (signals.rituals !== undefined && signals.rituals.length > 0) {
    out.push(`Honor rituals. Surface ${signals.rituals.join(', ')} at the right cadence.`)
  }
  if (signals.inner_circle !== undefined && signals.inner_circle.length > 0) {
    out.push(`Hold the inner circle in view: ${signals.inner_circle.join(', ')}.`)
  }
  if (signals.non_work_interests !== undefined && signals.non_work_interests.length > 0) {
    out.push(
      `Remember life outside work (${signals.non_work_interests.join(', ')}); weave check-ins on these when the moment fits.`,
    )
  }
  out.push(`Finish strongly. Half-solutions are unfinished karma.`)
  return out
}

function humanizeTimeStyle(s: string): string {
  switch (s) {
    case 'async-low':
      return 'async first, low interruption'
    case 'real-time':
      return 'real-time when the user is working'
    case 'daily-only':
      return 'daily check-ins only'
    default:
      return s
  }
}
