/**
 * terminal-cause.ts — WHY THE INNER LOOP STOPPED, as a CLOSED VOCABULARY (#520).
 *
 * THE DEFECT THIS CLOSES. Every terminal exit of `trident/inner-workflow.mjs`
 * used to report WHERE it got to (`round`, `checkpoint`) and, on four paths out
 * of twelve, a sentence of measured prose (`terminalCause`). Nothing reported
 * WHY it stopped. So the outer loop had to deduce it, and deduction is how
 * `orchestrator.ts` came to tell four different failures in one night the same
 * sentence — see `docs/spec-items/a-terminal-cause-on-every-terminal-path.md`
 * and the R1/R2 notes in `innerTerminalFailureReason`. The phase reached is not
 * the reason for stopping: `argus-request-changes` is written for genuine budget
 * exhaustion, for a fix round whose work never landed, for a fix round that left
 * no diff, AND for an infra-only synthesis stop.
 *
 * SO THE WORKFLOW SAYS IT, at the exit, from the loop's own guard variables —
 * which are a MEASUREMENT, not an inference, because they are the very
 * conditions the loop exited on. This module is the vocabulary both ends share.
 *
 * TWO FIELDS, NOT ONE, AND THEY ANSWER DIFFERENT QUESTIONS.
 *   - `terminal_cause_kind` (this vocabulary) — WHICH of the known exits it was.
 *     Closed, decodable, routable.
 *   - `terminal_cause` (free prose, `inner-loop.ts` `TERMINAL_CAUSE_MAX`) — the
 *     probe's / lane's / thrown error's own words, redacted and capped. Open,
 *     quotable, never routable.
 * They are not two spellings of one fact and neither replaces the other: a kind
 * with no prose is still a real answer, and prose with no kind is still worth
 * quoting. The prose is what the existing measured-cause branches already carry;
 * this adds the missing half.
 *
 * AND WHY NOT `blockKind`, WHICH IS ALREADY A CLOSED SET ON THE SAME RESULT. Because it
 * answers a narrower question and only sometimes. It describes what kind of BLOCK a
 * review verdict was — and 7 of the 12 terminal paths are not review verdicts and emit no
 * `blockKind` at all (the throw, both publish handoffs, both resume shortcuts, the
 * wave-member build, the Ralph re-fire). Widening it to carry "the workflow threw" or
 * "the PR was already merged" would make one field mean two things, and `blockKind` is
 * load-bearing exactly where it is narrow: `'infra-only'` is the ONLY value licensed to
 * say no seat judged the code, and `recordedTerminalVerdict` and `isInfraDeath` both key
 * on it. A second meaning in that field is how a value that licenses a claim starts
 * licensing it for rows that never earned it.
 *
 * `'unknown'` IS A MEMBER, AND THAT IS THE POINT. A classifier whose vocabulary
 * cannot say "I could not establish which of these it was" has to pick a
 * determinate answer instead, and then "nothing happened" and "I could not find
 * out" arrive at the reader as the same value. They are different facts with
 * different next steps. Every composer below refuses to say anything specific
 * about `'unknown'` — it falls through to whatever generic story the caller
 * already had.
 *
 * NO IMPORTS, DELIBERATELY. `inner-loop.ts` decodes with it, `orchestrator.ts`
 * composes reasons with it and `delivery.ts` routes the owner-facing announce on
 * it; a leaf with no trident imports is the only shape that all three can reach
 * without a cycle (`.dependency-cruiser.cjs` `no-cycles`).
 */

/**
 * THE CLOSED SET OF TERMINAL CAUSES. Every `writeTerminalResult` call site in
 * `trident/inner-workflow.mjs` names exactly one of these, and
 * `inner-workflow-terminal-cause.test.ts` fails if a call site is added that
 * does not.
 *
 * MIRRORED AS A LITERAL IN `inner-workflow.mjs` (that file is a standalone
 * workflow script with no imports at all — see its header), and the mirror is
 * pinned by a test, exactly as `TERMINAL_CAUSE_MAX` is.
 */
export const TERMINAL_CAUSES = [
  // ── The review loop's own exit, read off the guards it exited on ────────────
  /** The panel APPROVED. The loop stopped because it had what it was waiting for. */
  'review-approved',
  /** `round >= max_rounds` with the verdict still REQUEST_CHANGES — the ONE exit
   *  for which "the rounds ran out" is a true statement rather than a template. */
  'round-budget-exhausted',
  /** The panel ran, judged the code, and everything it returned was already
   *  declared non-blocking — so the loop exits rather than buy a round to
   *  re-derive that. A reviewer DID speak; nothing it said was actionable. */
  'review-advisory-only',
  /** The panel could not run. No seat judged the code, so the stop says nothing
   *  about the diff. */
  'review-infra-only',
  /**
   * A REVIEWER DECLARED THE WORK UNBUILDABLE AS PLANNED AND THE LOOP STOPPED (#654).
   *
   * Added when #654 landed `escalation === null` in the fix loop's `while` head — a NEW
   * exit condition, and therefore a new answer to "why did the loop stop". Without it an
   * escalated run reported `'unknown'`, which is this vocabulary's word for "could not be
   * established" about an exit that is sitting in a variable at the exit. Saying "I could
   * not tell" when you can is the same defect as saying something determinate when you
   * cannot; both put a false value on the honest branch.
   *
   * It carries NO sentence and NO announce of its own — `escalationStopSentence` and
   * `deriveEscalationBlock` already own that story end to end, and both run ahead of this
   * field's readers. The member exists so the EXIT IS NAMED, not to tell it a second time.
   */
  'review-escalated',
  /** A fix round's work never reached the branch — the round is lost and the
   *  code was not re-judged. */
  'round-lost-work',
  /** A fix round committed, but against the reviewed code it produced no diff —
   *  so, again, the code was not re-judged. Distinct from `round-lost-work`
   *  because the recovery differs: one needs the work found, the other needs a
   *  diff regenerated against work already safely on the branch. */
  'round-lost-no-diff',

  // ── Terminal exits that never reach the review loop ─────────────────────────
  /** The PR was already merged when the workflow looked. The change shipped. */
  'pr-already-merged',
  /** A resume found a prior `argus-approved` against a head that has not moved,
   *  so it skipped build and review and handed the outer loop the merge. */
  'resume-approved-unchanged',
  /** A resume could not read the head of the branch its recorded work is on, and
   *  refused to rebuild committed work on the strength of a failed read. */
  'resume-head-unreadable',
  /** A completed build's head could not be read, or git and the builder named
   *  different commits and the run refused to believe either. */
  'built-head-unverified',
  /** A wave member finished its one pinned build; it has no review or publish
   *  path of its own. */
  'wave-member-built',
  /** The workflow built a commit and is handing the outer loop the publish. Not
   *  an ending so much as a baton — but it IS a terminal result, so it names
   *  itself rather than going out silent. */
  'handoff-publish',
  /** A Ralph run built one task and is handing the outer loop a re-fire for the
   *  next one. Same shape as the publish handoff. */
  'ralph-task-built',
  /** The workflow THREW. Not a review verdict; the prose cause carries the
   *  sentence it threw. */
  'workflow-threw',

  // ── The honest non-answer ───────────────────────────────────────────────────
  /**
   * COULD NOT BE ESTABLISHED. Emitted when a terminal result is written on a
   * path whose exit conditions match none of the above — including a terminal
   * result written by a path that forgot to name its cause at all, which
   * `writeTerminalResult` stamps rather than letting it travel bare.
   *
   * IT IS NOT "NOTHING WENT WRONG". It is "this run cannot tell you which of
   * these it was", and every consumer treats it as licence to say LESS, never
   * more. A composer that mapped it to any determinate sentence would be the
   * whole defect this vocabulary exists to close, arriving by the back door.
   */
  'unknown',
] as const

/** WHY the inner loop stopped — one of {@link TERMINAL_CAUSES}. */
export type TerminalCause = (typeof TERMINAL_CAUSES)[number]

const TERMINAL_CAUSE_SET: ReadonlySet<string> = new Set(TERMINAL_CAUSES)

/**
 * Decode a terminal cause FAIL-CLOSED: only the exact strings above decode.
 *
 * `null` MEANS "THE FIELD DID NOT ARRIVE", which is NOT the same fact as
 * `'unknown'` ("the workflow ran, looked, and could not tell"). A legacy row, a
 * truncated JSON, a value from a future writer and a garbled string all decode
 * `null`, and every consumer answers `null` by keeping the behaviour it had
 * before this field existed — byte for byte. A value that cannot be trusted must
 * buy nothing, and in particular must never be read as `'unknown'`, which is an
 * assertion this run made.
 */
export function parseTerminalCause(value: unknown): TerminalCause | null {
  if (typeof value !== 'string') return null
  const v = value.trim()
  return TERMINAL_CAUSE_SET.has(v) ? (v as TerminalCause) : null
}

/**
 * The orchestrator's terminal `failure_reason` for a measured cause — or `null`
 * where this vocabulary licenses NO specific sentence and the caller must keep
 * its generic one.
 *
 * WORD CHOICE IS LOAD-BEARING, and it is the same rule `deploy-kill-reason.ts`
 * states for its markers. `interpretFailure` (`delivery.ts`) routes an
 * unrecognised reason by bare `includes()` over tokens like `exhausted`,
 * `stalled`, `git `, `conflict`, `missing` and `provenance`. A row that carries
 * one of these sentences but whose STRUCTURED cause cannot be read (an
 * unharvested row, a force-terminated one) reaches those branches with the
 * sentence alone — so a sentence containing a routing token would be delivered
 * as a review, hang or merge-mechanics outcome that never happened.
 *
 * `terminal-cause.test.ts` pins the PROPERTY rather than the wording: every
 * sentence this function can produce must, with no structured cause available,
 * degrade to the honest verbatim fallback — which also means each must stay
 * inside that fallback's 200-character clamp. Asserted in EVERY disposition
 * where the prose is what decides (`not-terminal`, `died-before-build`,
 * `built-never-reviewed`), not just one: several of `interpretFailure`'s keyword
 * branches are gated on the disposition, so a single terminal-row fixture tests
 * the sentence against a classifier that was never going to look at it. That is
 * not hypothetical — it let a sentence carrying the word "exhausted" through.
 *
 * `null` FOR THE SUCCESS AND HANDOFF CAUSES ON PURPOSE. A failed row carrying
 * `'review-approved'` or `'handoff-publish'` failed for a reason this function
 * has not measured — downstream of the verdict, at the merge or the publish —
 * and naming the exit as the failure would be the inference this module exists
 * to refuse.
 */
export function terminalCauseReason(
  cause: TerminalCause,
  round: number,
  ceiling: number,
): string | null {
  const at = `at round ${round} of ${ceiling}`
  switch (cause) {
    case 'round-budget-exhausted':
      return `the fix loop used its whole round budget ${at} and never reached an approved review`
    case 'review-advisory-only':
      return `the review panel ran ${at} and raised nothing actionable, so the loop stopped with no approval to land`
    case 'round-lost-work':
      return `a fix round's work never reached the branch ${at}, so the code was not re-judged`
    case 'round-lost-no-diff':
      return `a fix round left the reviewed code unchanged ${at}, so there was nothing new to re-judge`
    // EVERY OTHER MEMBER DELIBERATELY SAYS NOTHING HERE.
    //
    //  - `review-infra-only`, `resume-head-unreadable`, `built-head-unverified`
    //    and `workflow-threw` already have a specific sentence UPSTREAM of this
    //    call, composed from the prose cause they carry (or `infraDeathSentence`
    //    when that prose did not survive redaction). A second sentence for the
    //    same exit is a second owner for one fact. `review-escalated` is the same
    //    rule for #654's `escalationStopSentence`, which fires above this line.
    //  - `review-approved`, `pr-already-merged`, `resume-approved-unchanged`,
    //    `wave-member-built`, `handoff-publish` and `ralph-task-built` are not
    //    failures. Reaching a terminal FAILURE reason with one of them means the
    //    run died after this exit, of something this function did not measure.
    //  - `unknown` is the whole reason `'unknown'` is a member: it buys silence.
    case 'review-approved':
    case 'review-infra-only':
    case 'review-escalated':
    case 'pr-already-merged':
    case 'resume-approved-unchanged':
    case 'resume-head-unreadable':
    case 'built-head-unverified':
    case 'wave-member-built':
    case 'handoff-publish':
    case 'ralph-task-built':
    case 'workflow-threw':
    case 'unknown':
      return null
  }
}
