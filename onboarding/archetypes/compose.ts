/**
 * @neutronai/onboarding — archetype blend composer (P2 S2).
 *
 * Per § 2.2: when the user picks 1-4 archetypes, compose their voice
 * fragments into a single persona-shape that downstream persona-gen uses.
 * Composition is deterministic, simple concatenation with provenance
 * markers — § 2.2 explicitly says "composes via simple concatenation."
 *
 * Composition output is a `BlendedArchetype` with:
 *   - a synthetic blend label (e.g. "Odin / Thoth / Padmasambhava")
 *   - voice_md / comm_md / decision_md sections that list each archetype's
 *     fragment under a sub-heading. The persona-synthesizer prompt
 *     consumes these sections directly.
 *
 * Stable across reorders: compose([Odin, Thoth]) and compose([Thoth, Odin])
 * yield the same blend label and section order — the composer sorts picks
 * by slug for determinism, so tests can assert blend identity without
 * caring about pick order.
 */

import type { Archetype, ArchetypeLibrary } from './library.ts'
import { ArchetypeError } from './library.ts'

export interface BlendedArchetype {
  slugs: string[]
  display_label: string
  voice_md: string
  comm_md: string
  decision_md: string
}

export const MIN_BLEND = 1
export const MAX_BLEND = 4

/**
 * P2 v2 § 2.6 + § 7.1 — derive a `BlendedArchetype` from a free-text
 * `agent_personality` phrase captured at `personality_offered`.
 *
 * The v2 personality phase no longer forces the user to pick from the
 * curated 24 — they type a free-text description ("a sharp strategist
 * who pushes back", "warm thinking-partner with a sharp edge", etc).
 * This helper scans the phrase for any curated archetype mention. If a
 * match is found, the curated archetype's voice/comm/decision fragments
 * become the blend (up to MAX_BLEND matches). If no curated mention
 * lands, the helper returns a free-text blend with the phrase itself
 * threaded through `voice_md` as the archetypal-blend body.
 *
 * Important: the curated library is a SOFT HINT pool here. The helper
 * does not require curated mentions. A phrase like "calm and direct"
 * lands a free-text blend that downstream `generateSoulMd` can render
 * as-is — no LLM round-trip required at compose time. (The persona-
 * synthesizer prompt remains as a regen-time tool the cringe-check loop
 * may call, see § 7.4.)
 *
 * Tests cover three cases: (a) phrase with one curated mention →
 * curated blend, (b) phrase with no curated mention → free-text blend
 * with the phrase preserved, (c) phrase with multiple curated mentions
 * → multi-blend up to MAX_BLEND.
 */
export interface ComposeFromFreeTextOptions {
  /** Curated library. When omitted the helper returns a pure free-text
   * blend (used by tests that don't want filesystem-backed library load). */
  library?: ArchetypeLibrary
  /** Cap on curated matches threaded into the blend. Defaults to MAX_BLEND. */
  max_blend?: number
}

export function composeFromFreeText(
  personality_phrase: string,
  options: ComposeFromFreeTextOptions = {},
): BlendedArchetype {
  const phrase = personality_phrase.trim()
  if (phrase.length === 0) {
    throw new ArchetypeError(
      'compose_failed',
      'composeFromFreeText requires a non-empty personality phrase',
    )
  }
  const cap = options.max_blend ?? MAX_BLEND
  const matches: Archetype[] = []
  if (options.library !== undefined) {
    const lib = options.library
    const phrase_lower = phrase.toLowerCase()
    const seen = new Set<string>()
    for (const arch of lib.list()) {
      if (seen.has(arch.slug)) continue
      const display_lower = arch.display_name.toLowerCase()
      const slug_tokens = arch.slug
        .split('-')
        .filter((t) => t.length > 2 && !FREE_TEXT_STOPWORDS.has(t))
      const name_tokens = display_lower
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length > 2 && !FREE_TEXT_STOPWORDS.has(t))
      const candidates = new Set<string>([display_lower, ...slug_tokens, ...name_tokens])
      for (const cand of candidates) {
        if (cand.length < 3) continue
        if (FREE_TEXT_STOPWORDS.has(cand)) continue
        const re = new RegExp(`(?:^|[^a-z0-9])${escapeRegex(cand)}(?:[^a-z0-9]|$)`, 'i')
        if (re.test(phrase_lower)) {
          matches.push(arch)
          seen.add(arch.slug)
          break
        }
      }
      if (matches.length >= cap) break
    }
  }
  if (matches.length > 0) {
    return composeArchetypeBlend(matches)
  }
  return composeFreeTextBlend(phrase)
}

function composeFreeTextBlend(phrase: string): BlendedArchetype {
  const trimmed = phrase.trim()
  return {
    slugs: ['free-text'],
    display_label: 'Free-text personality',
    voice_md: trimmed,
    comm_md:
      `Match the tone of: "${trimmed}". Default to clarity over cleverness; ` +
      `bullets when there are 3+ distinct items, prose when one idea needs to land.`,
    decision_md:
      `Hold the disposition above when stakes are unclear. When stakes are high, ` +
      `slow down, verify, then act cleanly. Solve end-to-end; do not stop at the first obstacle.`,
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Common-word filter for the free-text → curated archetype scan. Without
 * this filter, phrases like "the warm one who listens" would falsely
 * match `gandalf-the-white` off the "the" token. Stopwords here are
 * limited to the connective particles that appear inside multi-word
 * curated archetype slugs / display names (e.g. "Gandalf the White",
 * "Atticus Finch", "Captain Picard"). Curated proper nouns (Sherlock,
 * Picard, Atticus, etc.) MUST survive this filter.
 */
const FREE_TEXT_STOPWORDS: ReadonlySet<string> = new Set([
  'the',
  'and',
  'of',
  'da',
  'la',
  'le',
  'el',
  'van',
  'von',
])

/**
 * Compose 1-4 archetypes into one blend. Throws ArchetypeError when the
 * input is empty or exceeds MAX_BLEND. Picks are deduplicated by slug so a
 * caller passing the same archetype twice gets the single-archetype shape.
 */
export function composeArchetypeBlend(picks: Archetype[]): BlendedArchetype {
  if (picks.length === 0) {
    throw new ArchetypeError('compose_failed', 'compose requires at least 1 archetype')
  }
  const dedup = dedupeBySlug(picks)
  if (dedup.length > MAX_BLEND) {
    throw new ArchetypeError(
      'compose_failed',
      `compose accepts up to ${MAX_BLEND} archetypes, got ${dedup.length}`,
    )
  }
  const sorted = [...dedup].sort((a, b) => a.slug.localeCompare(b.slug))
  const display_label = sorted.map((a) => a.display_name).join(' / ')
  const voice_md = sorted
    .map((a) => `### ${a.display_name}\n\n${a.voice_md}`)
    .join('\n\n')
  const comm_md = sorted
    .map((a) => `- **${a.display_name}**: ${a.comm_md}`)
    .join('\n')
  const decision_md = sorted
    .map((a) => `- **${a.display_name}**: ${a.decision_md}`)
    .join('\n')
  return {
    slugs: sorted.map((a) => a.slug),
    display_label,
    voice_md,
    comm_md,
    decision_md,
  }
}

function dedupeBySlug(picks: Archetype[]): Archetype[] {
  const seen = new Set<string>()
  const out: Archetype[] = []
  for (const a of picks) {
    if (seen.has(a.slug)) continue
    seen.add(a.slug)
    out.push(a)
  }
  return out
}
