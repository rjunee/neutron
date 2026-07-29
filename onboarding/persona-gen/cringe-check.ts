/**
 * @neutronai/onboarding — persona-draft cringe-check (P2 S2).
 *
 * Per docs/plans/P2-onboarding.md § 2.6 + § 4.8. Each generated persona
 * file (SOUL.md / USER.md / priority-map.md) is run through this check
 * after generation. If `flags >= cringeThreshold` (default 3), the
 * compose loop regenerates the file. Hard-capped at 3 regen attempts
 * before falling back to a manual-review flag.
 *
 * The check is hybrid: a deterministic regex pass (catches em-dashes,
 * the most common AI tell, plus a curated list of corporate filler) +
 * an optional LLM pass that adds finer-grained pattern detection. The
 * deterministic pass alone is sufficient for the default cringe loop;
 * the LLM pass is wired through `prompts/onboarding/cringe-check.md`
 * when a substrate is available.
 *
 * The deterministic pass MUST flag em-dashes. Per CLAUDE.md and SOUL.md,
 * em-dashes are an AI tell. Generated files containing em-dashes get
 * regenerated until the LLM stops emitting them.
 */

export type PersonaFile = 'soul' | 'user' | 'priority_map'

export interface CringeCheckResult {
  flags: number
  reasons: string[]
}

export interface CringeCheckerDeps {
  /** Override threshold (default 3 — at this many flags the file regenerates). */
  threshold?: number
  /** Optional LLM-call layer that augments the deterministic flags. */
  llmCheck?: (input: { file: PersonaFile; content: string }) => Promise<{ flags: number; reasons: string[] }>
}

/**
 * Curated list of corporate filler words / AI tells to flag. Each match
 * counts as one flag; the threshold sums across categories.
 *
 * Sources: internal design notes "Forbidden phrases" + Wikipedia "Signs of AI
 * writing" + Nova cringe-check entity history.
 */
export const CRINGE_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /—/g, reason: 'em-dash (AI tell per Nova style)' },
  { pattern: /–/g, reason: 'en-dash (AI tell per Nova style)' },
  { pattern: /\bsynergistic\b/gi, reason: 'corporate filler: "synergistic"' },
  { pattern: /\bsynergy\b/gi, reason: 'corporate filler: "synergy"' },
  { pattern: /\bunlock\s+value\b/gi, reason: 'cliche: "unlock value"' },
  { pattern: /\bgame[-\s]?changer\b/gi, reason: 'cliche: "game-changer"' },
  { pattern: /\bcutting[-\s]?edge\b/gi, reason: 'cliche: "cutting-edge"' },
  { pattern: /\bworld[-\s]?class\b/gi, reason: 'cliche: "world-class"' },
  { pattern: /\bnext[-\s]?gen(eration)?\b/gi, reason: 'cliche: "next-gen"' },
  { pattern: /\brevolutionary\b/gi, reason: 'inflated: "revolutionary"' },
  { pattern: /\bseamlessly\b/gi, reason: 'AI tell: "seamlessly"' },
  { pattern: /\bdelve\s+into\b/gi, reason: 'AI tell: "delve into"' },
  { pattern: /\bnavigate\s+the\s+(complex|intricate)\s+landscape\b/gi, reason: 'AI tell: "navigate the (complex/intricate) landscape"' },
  { pattern: /\bintricate\s+tapestry\b/gi, reason: 'AI tell: "intricate tapestry"' },
  { pattern: /\bmultifaceted\b/gi, reason: 'AI tell: "multifaceted"' },
  { pattern: /\bin\s+today's\s+(fast[-\s]?paced|ever[-\s]?evolving)\b/gi, reason: 'AI tell: "in today\'s fast-paced/ever-evolving"' },
  { pattern: /\bI\s+just\s+LOVE\b/gi, reason: 'sycophantic emphasis' },
  { pattern: /\bawesome\b/gi, reason: 'validating filler: "awesome"' },
  { pattern: /\bgreat\s+(question|point|call)\b/gi, reason: 'validating opener (Nova forbidden phrase)' },
  { pattern: /\bhappy\s+to\s+help\b/gi, reason: 'validating filler: "happy to help"' },
  { pattern: /\blove\s+this\b/gi, reason: 'validating filler: "love this"' },
  { pattern: /\bcollaborating\s+with\s+\w+\s+partners\b/gi, reason: 'corporate filler: "collaborating with X partners"' },
]

export interface CringeChecker {
  check(input: { file: PersonaFile; content: string }): Promise<CringeCheckResult>
  readonly threshold: number
}

export function buildCringeChecker(deps: CringeCheckerDeps = {}): CringeChecker {
  const threshold = deps.threshold ?? 3
  const llmCheck = deps.llmCheck
  return {
    threshold,
    async check(input): Promise<CringeCheckResult> {
      const det = deterministicCringe(input.content)
      let flags = det.flags
      const reasons = [...det.reasons]
      if (llmCheck !== undefined) {
        const llm = await llmCheck(input)
        flags += llm.flags
        for (const r of llm.reasons) reasons.push(r)
      }
      return { flags, reasons }
    },
  }
}

/**
 * Pure regex-based pass — exported so unit tests can pin the deterministic
 * flag set without booting an LLM. Used by `buildCringeChecker` when no
 * LLM dep is wired.
 */
export function deterministicCringe(content: string): CringeCheckResult {
  const reasons: string[] = []
  let flags = 0
  for (const { pattern, reason } of CRINGE_PATTERNS) {
    pattern.lastIndex = 0
    const matches = content.match(pattern)
    if (matches !== null && matches.length > 0) {
      flags += matches.length
      reasons.push(`${reason} (${matches.length}×)`)
    }
  }
  return { flags, reasons }
}
