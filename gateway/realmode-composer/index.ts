/**
 * @neutronai/gateway/realmode-composer — aggregator entry-point.
 *
 * Sprint A — GBrain methodology integration v2 (2026-05-12).
 * Plan: docs/plans/2026-05-09-gbrain-methodology-integration-v2.md § 9.1.
 *
 * The realmode-composer module historically has been a collection of
 * factory files (`build-landing-stack`, `build-telegram-webhook`,
 * `build-phase-spec-resolver`, `resolve-*`). This file gives the module
 * a single import point and exports the system-prompt composer that the
 * factories call to splice loaded skills/conventions into the LLM's
 * system prompt.
 *
 * `composeSystemPrompt` is intentionally synchronous and pure — the
 * async work (filesystem reads, mtime stats) lives behind
 * `skills-loader.ts:loadSkills` and `persona-loader.ts:PersonaPromptLoader`,
 * which factories call per-turn (or once at build-time and cache, in the
 * skills case). The composer just merges the pre-loaded bodies with the
 * upstream system prompt at each LLM call.
 *
 * Regression contract (Sprint A gate 4 + ISSUE #30 gate): when BOTH
 * `conventions` AND `persona` are missing or empty, the composed prompt
 * is BYTE-IDENTICAL to `base`. This preserves the pre-Sprint-A prompt-
 * cache anchor for instances whose `skills/` AND `persona/` directories
 * are both empty.
 *
 * Splice order (top → bottom):
 *   1. Persona block (SOUL / USER / priority-map) — sets agent identity
 *   2. Conventions block (GBrain methodology) — cross-cutting rules
 *   3. Upstream base prompt (per-phase emission)
 *
 * Persona sits ABOVE conventions because identity primes everything
 * downstream — the agent's voice should be set before the methodology
 * rules apply. Both blocks sit ABOVE the base so the cacheable prefix
 * stays stable across turns where identity + methodology don't change.
 */

export {
  loadSkills,
  SkillsLoaderError,
  MAX_BODY_BYTES,
  type LoadedSkills,
  type SkillsLoaderOptions,
} from './skills-loader.ts'

export {
  PersonaPromptLoader,
  PERSONA_FILENAMES,
  type PersonaFilename,
  type PersonaPromptLoaderOptions,
} from './persona-loader.ts'

export interface ComposeSystemPromptInput {
  /** Upstream system prompt (e.g. `buildSystemPrompt(...)`'s output). */
  base: string
  /**
   * Pre-loaded skills body from `loadSkills(...).body`. Pass `undefined`
   * / empty string when the instance has no skills/ directory or has
   * opted out — the composer then returns `base` byte-identical.
   */
  conventions?: string | null | undefined
  /**
   * Pre-loaded persona body from `PersonaPromptLoader.load()`. Pass
   * `undefined` / empty string when the instance has no `persona/` directory
   * yet (pre-onboarding-commit) — the composer omits the persona section.
   * When BOTH `persona` and `conventions` are empty, returns `base`
   * byte-identical (prompt-cache anchor stays stable).
   *
   * Wired by ISSUE #30 (PR v0.1.85) so admin-tab edits to SOUL.md / USER.md
   * / priority-map.md land on the very next agent turn.
   */
  persona?: string | null | undefined
}

/**
 * Splice the persona + conventions blocks (when present) above the upstream
 * system prompt under stable headers. The placement above the upstream
 * prompt mirrors `gbrain_skills_RESOLVER.md`'s "always-on" section — both
 * blocks are cross-cutting rules the agent applies regardless of phase.
 *
 * Order is intentional:
 *   - Persona FIRST  → sets agent identity (voice, archetypal blend)
 *   - Conventions    → cross-cutting methodology (brain-first, friction, …)
 *   - Base prompt    → per-phase emission body
 *
 * Both prefix blocks remain a stable prompt-cache anchor across LLM calls
 * as long as their inputs don't change between turns.
 */
export function composeSystemPrompt(input: ComposeSystemPromptInput): string {
  const persona = trimOrNull(input.persona)
  const conv = trimOrNull(input.conventions)
  if (persona === null && conv === null) {
    // Back-compat: byte-identical to `base` when nothing to splice — keeps
    // the pre-Sprint-A / pre-#30 prompt-cache anchor stable.
    return input.base
  }
  const parts: string[] = []
  if (persona !== null) {
    parts.push(`# Persona\n\n${persona}`)
  }
  if (conv !== null) {
    parts.push(`# Conventions\n\n${conv}`)
  }
  return `${parts.join('\n\n---\n\n')}\n\n---\n\n${input.base}`
}

/**
 * Trim trailing newlines + reject empty / nullish so the splice loop can
 * use a single null-check instead of two flavour checks (undefined / null /
 * empty all collapse to null).
 */
function trimOrNull(s: string | null | undefined): string | null {
  if (s === null || s === undefined || s.length === 0) return null
  const trimmed = s.endsWith('\n') ? s.slice(0, -1) : s
  if (trimmed.length === 0) return null
  return trimmed
}
