/**
 * merge-diff-limit.ts — the ONE place that authors "this diff is too big to
 * land", and the only place that recognises it again (#618).
 *
 * The merge path refuses a diff above a byte ceiling in CODE (`assessMergeDiff`,
 * `trident/merge.ts`). That refusal is a TERMINAL OUTCOME for the run, so it has
 * to arrive somewhere in the vocabulary that already classifies terminal
 * outcomes — `FailureClass` in `trident/delivery.ts`. Left unclassified it fell
 * through to the `merge failed:` catch-all in `trident/orchestrator.ts` and was
 * announced as "a git step failed while landing the branch … Reply to retry the
 * build": the summary names a step that did not fail, the authored reason is
 * discarded, and the advice sends the owner around a loop that re-measures the
 * same diff and refuses again. That is the cost of the default, and it is why
 * the marker is a constant here rather than a phrase repeated in three files.
 *
 * Writer: `mergeDiffTooLargeReason` (`trident/merge.ts`, via
 * `TridentMergeDiffHold`). Reader: `interpretFailure` (`trident/delivery.ts`),
 * which matches {@link MERGE_DIFF_TOO_LARGE_MARKER}. Never reword one half
 * alone; a test pins the composed sentence against the matcher.
 *
 * A LEAF ON PURPOSE. `delivery.ts` must not import `merge.ts` (the `no-cycles`
 * rule; `delivery → orchestrator → merge` is the existing direction), so the
 * shared wording lives in a module that imports nothing — the same shape as
 * `deploy-kill-reason.ts`.
 *
 * WORD CHOICE IS THE FEATURE, and it is constrained by the reader. The reason
 * must NOT contain `git `, `rebase`, `checkout`, `conflict`, `unmerged`,
 * `exhausted`, `stalled`, `missing` or `provenance`: `delivery.ts` routes on
 * those tokens and would answer a size refusal with merge-mechanics,
 * review-flavoured or infra-flavoured copy. It must also stay under 200
 * characters, which is the ceiling the unclassified fallback arm prints
 * verbatim — this reason is classified, but the two halves must not be one
 * reword away from the owner being told "The build did not complete."
 */

/**
 * The ceiling, in bytes, on the complete pre-merge diff.
 *
 * Deliberately equal to the reviewer seat's measured input ceiling
 * (`CODEX_INPUT_CHARACTER_LIMIT`, `trident/codex-review.sh`): a diff no reviewer
 * seat could have been shown in full is a diff nothing reviewed. The units
 * differ (characters there, bytes here), which makes ASCII the exact shared
 * boundary and non-ASCII refuse at merge slightly earlier than at review — the
 * safe direction.
 */
export const MERGE_DIFF_BYTES_MAX = 1_048_576

/** The authored token every too-large-diff refusal carries, and the only thing
 *  `interpretFailure` matches on. Never reword one half alone. */
export const MERGE_DIFF_TOO_LARGE_MARKER = 'above the reviewable merge-diff limit'

/**
 * Compose the durable `failure_reason` for a merge refused on size.
 *
 * MEASUREMENT ONLY — the remedy lives in the announce (`interpretFailure`),
 * which already appends "break the work into smaller cards". Saying it in both
 * halves printed the same instruction twice in one message.
 */
export function mergeDiffTooLargeReason(measured_bytes: number): string {
  return (
    `merge diff is ${measured_bytes} bytes, ${MERGE_DIFF_TOO_LARGE_MARKER} of ` +
    `${MERGE_DIFF_BYTES_MAX} bytes`
  )
}

/**
 * Recognise a stored reason authored by {@link mergeDiffTooLargeReason}.
 *
 * ANCHORED AT THE FRONT. The reason is written by this repository and never
 * embeds a branch name or any other caller-supplied string, so there is nothing
 * here to forge — but an UNANCHORED match would also fire on prose that merely
 * QUOTES the refusal (a model summary, an escalation question), and answering
 * one of those with "split the work" is the same class of misroute this module
 * exists to remove.
 */
export function isMergeDiffTooLargeReason(reason: string): boolean {
  return reason.trimStart().toLowerCase().startsWith('merge diff is ') &&
    reason.toLowerCase().includes(MERGE_DIFF_TOO_LARGE_MARKER)
}
