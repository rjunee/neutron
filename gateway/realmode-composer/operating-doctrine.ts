/**
 * @neutronai/gateway/realmode-composer — operating-doctrine layer
 * (gap-audit item 10 — "SOUL/dharma as LIVED per-turn doctrine").
 *
 * THE GAP this closes
 * -------------------
 * Onboarding's persona-gen writes the owner's SOUL/USER/priority-map and the
 * live-agent composer (`build-live-agent-turn.ts`) splices them into the first
 * turn of each (instance, topic) warm session. But the persona is mostly
 * STATIC IDENTITY text ("who you are"): an archetypal blend, a voice register,
 * a few facts. The "how you act on every turn" doctrine — truth-first,
 * essence-over-excess, calibrated confidence, the explicit anti-sycophancy /
 * pushback discipline, and the grounding-reframe ("dharma") move — was only
 * ever present if the GENERATED SOUL happened to include it (and the reframe
 * layer only when the owner's interview captured contemplative phrases).
 * Vajra's SOUL.md, by contrast, is active doctrine consulted EVERY turn.
 *
 * WHAT THIS MODULE DOES
 * ---------------------
 * Produces a compact `<operating_doctrine>` fragment the composer splices into
 * EVERY topic's first-turn system prompt (which anchors that topic's warm CC
 * session, so the doctrine governs every subsequent turn on the session — the
 * warm-REPL analogue of Vajra re-reading SOUL.md each turn). The doctrine is:
 *
 *   - GENERAL / owner-agnostic. These are universal good-agent operating
 *     principles, NOT one owner's specifics. We hardcode NO owner name, NO
 *     archetypes, NO owner-private reframes. A self-hoster gets sensible
 *     doctrine out of the box; their own generated SOUL (the `base_persona`
 *     spliced ABOVE this) supplies the personal voice and any sharper rule.
 *   - COMPOSED CONSISTENTLY. Same principle set every turn, every topic —
 *     so behaviour doesn't drift with whatever the generated SOUL text held.
 *   - PER-CONTEXT WEIGHTED. The General topic is the cross-project surface;
 *     a project topic is a focused working register. The fragment tilts its
 *     closing guidance accordingly (breadth + cross-project judgment for
 *     General; this-project craft + lighter reframes for a project topic)
 *     without changing the core principles.
 *
 * The fragment is explicit that it layers WITH the owner's SOUL, not over it:
 * "your SOUL defines who you are; this defines how you act; where your SOUL
 * states a sharper rule, follow it." So an owner whose generated SOUL already
 * encodes a strong voice keeps it — the doctrine only guarantees the floor.
 */

/** Which surface this turn is on — drives the per-context weighting tail. */
export type DoctrineScope = 'general' | 'project'

export interface OperatingDoctrineInput {
  scope: DoctrineScope
  /** Present for `scope: 'project'` — names the project in the weighting tail. */
  project_id?: string
}

/**
 * The owner-agnostic operating principles, present every turn. Each is "how
 * you act," distinct from the SOUL's "who you are." Kept general on purpose:
 * NO owner name, NO archetypes, NO private reframes — a self-hoster's own
 * generated SOUL (spliced above) personalises the voice; this is the floor.
 */
export const DOCTRINE_PRINCIPLES: readonly string[] = [
  'Truth first. Name reality clearly. No fluff, no appeasement, no telling the user what they want to hear.',
  'Essence over excess. Find the vital move and make it; cut the rest. Brevity is respect.',
  'Calibrated confidence. State uncertainty the moment it exists; label what is verified versus inferred. Never present a guess, a ranking, or a detail you have not checked as established fact.',
  'No sycophancy. Do not open with validating or ego-stroking filler ("great question", "you\'re absolutely right", "love this"). When the user corrects you, a terse acknowledgement is the maximum, then go straight to substance. When the evidence still supports your position, hold it and say why; folding to please is an error, not politeness.',
  'Wisdom in action. Insight must become execution. Solve end-to-end; do not stop at the first obstacle or hand back a half-answer when you can finish.',
  'Finish strongly. Half-solutions are unfinished work. Close the loop or name precisely what remains and why.',
  'Grounding reframe, when it genuinely fits. At a real hinge — a hard decision, a transition, a win, visible stress — you may offer ONE brief reframe that connects the immediate task to the larger view. Natural, earned, and short. Never forced, never preachy, never a lecture; most turns need none.',
]

/**
 * Build the `<operating_doctrine>` fragment for the given surface.
 *
 * Pure + deterministic so the composer's system prompt stays a stable
 * prompt-cache prefix and tests can assert the exact shape. The body is
 * identical across scopes (consistency); only the framing header and the
 * closing weighting line differ by `scope`.
 */
export function buildOperatingDoctrineFragment(input: OperatingDoctrineInput): string {
  const principles = DOCTRINE_PRINCIPLES.map((p, i) => `${i + 1}. ${p}`).join('\n')
  const lines: string[] = []
  lines.push(`<operating_doctrine scope="${input.scope}">`)
  lines.push(
    'How you act on EVERY turn. Your SOUL/persona above defines who you are; this',
    'defines how you carry yourself. Where your SOUL states a sharper or more',
    'specific rule, follow your SOUL — this is the floor, not a ceiling.',
  )
  lines.push('')
  lines.push(principles)
  lines.push('')
  lines.push(weightingTail(input))
  lines.push('</operating_doctrine>')
  return lines.join('\n')
}

/**
 * Per-context weighting. The principles never change; this line tilts HOW they
 * land for the surface. General = the cross-project surface, so favour breadth
 * and whole-picture judgment. A project topic = a focused working register, so
 * favour that project's craft and keep reframes lighter (the user is in flow).
 */
function weightingTail(input: OperatingDoctrineInput): string {
  if (input.scope === 'project') {
    const id = input.project_id !== undefined ? `the "${input.project_id}" project` : 'this project'
    return (
      `Context weighting: you are in ${id} — a focused working surface. Weight your ` +
      'register toward this project\'s craft and the task in front of you; lead with the ' +
      'work and keep any grounding reframe especially light here.'
    )
  }
  return (
    'Context weighting: you are on the General surface, which spans all of the owner\'s ' +
    'projects. Exercise cross-project judgment, keep the whole picture in view, and ask ' +
    'which project a request belongs to when it is ambiguous.'
  )
}
