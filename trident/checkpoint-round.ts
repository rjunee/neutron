import { trimAsciiWs } from './ascii-trim.ts'

/**
 * checkpointRound — map an `inner_checkpoint` string to the fix-loop round it
 * records, or null when the shape carries none (do NOT guess).
 *
 * The two shapes that carry a round — anything else returns null:
 *   `fix-round-N`                                                → N
 *   `outer-published:<40-hex-oid>:<remaining>:<round>[:deviated]` → <round>
 *
 * FIELD ORDER, pinned: the outer publisher builds
 * `outer-published:${head}:${remaining_tasks}:${round}` (orchestrator.ts
 * applyResult) and the resume parse reads the round from the SECOND numeric
 * (`round = Number(publishedResume[3])`, inner-workflow.mjs). The card that
 * asked for this wrote `<oid>:R:T`, which is TRANSPOSED relative to the code —
 * the round is the LAST numeric field. Regex group 3, never group 2.
 *
 * `argus-request-changes-round-N` also names a round but is deliberately NOT
 * parsed: the spec enumerates exactly the two shapes above and forbids guessing.
 *
 * THE ROUND IS AT MOST NINE DIGITS, IN BOTH COPIES, and that bound is the whole
 * reason it is written into the pattern rather than checked afterwards. The bash
 * mirror computes `$(( 10#$digits ))`, which WRAPS at 2^63 — `fix-round-<2^63>`
 * came back NEGATIVE, and that value was interpolated straight into
 * `round=MAX(round, -N)` — while this copy would return the mathematical value
 * (and, past 2^53, a rounded one). Clamping the DOMAIN is what makes "the two
 * copies agree" a total claim instead of one bounded by the test corpus: outside
 * nine digits neither copy matches, both answer "no round", and the column is left
 * alone. No real checkpoint is anywhere near it — a round is bounded by
 * `max_rounds`.
 *
 * AND THE TRIM IS THE SIX ASCII WHITESPACE CHARACTERS, NOT JAVASCRIPT'S SET
 * (Argus r4). `String.prototype.trim` also strips NBSP, the Unicode space
 * separators and the BOM, so `checkpointRound('<NBSP>fix-round-3')` answered 3
 * while the bash mirror answered "no round" — an equivalence bounded by the corpus
 * that happened not to contain one. The mirror in `checkpoint.sh` was ALSO wrong in
 * the other direction (its `[[:space:]]` matched U+2003 under glibc's UTF-8
 * locales, measured), so both copies now name the same six characters explicitly,
 * as the canonical disposition SQL's `TRIM(col, ' '||CHAR(9)||…)` already did.
 * `trident/ascii-trim.ts` now holds the single TS copy of that set, and it is a
 * LINEAR two-pointer scan rather than a regex: the old
 * `/^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g` backtracked quadratically on a long
 * interior whitespace run (CodeQL js/polynomial-redos HIGH, Argus r7) and the
 * input here is `inner_checkpoint`, which comes from stored state. Same six
 * characters; only the scanning strategy changed.
 */
export function checkpointRound(checkpoint: string | null): number | null {
  if (checkpoint === null) return null
  const name = trimAsciiWs(checkpoint)
  const fix = /^fix-round-(\d{1,9})$/.exec(name)
  if (fix !== null) return Number(fix[1])
  const published = /^outer-published:[0-9a-f]{40}:\d+:(\d{1,9})(:deviated)?$/.exec(name)
  if (published !== null) return Number(published[1])
  return null
}
