/**
 * The outer loop's published-checkpoint shape, written by the orchestrator when
 * it pushes: `outer-published:<40-hex-oid>:<remaining_tasks>:<round>[:deviated]`.
 *
 * THE ONE COPY (Argus r6, minor). It used to be spelled twice — here, and again
 * in `trident/fire-evidence.ts`, whose capturing form the settle-timeout gate
 * needs to RENDER the fields rather than merely test them. The two diverged in
 * the round's bound, so this one accepted a round the other classified as "not
 * published"; `fire-evidence.ts` now imports and re-exports this constant, and
 * this leaf module owns it because it is the copy already on `main` and it
 * imports nothing.
 *
 * The round field is BOUNDED (`\d{1,9}`) ON PURPOSE: it matches what
 * `checkpointRound` / `checkpoint.sh` can actually write, so an absurd
 * pseudo-round cannot pass as a published checkpoint. That bound is tighter than
 * the RESUME sites' `(\d+)` (`orchestrator.ts`, `inner-workflow.mjs`), and the
 * divergence is deliberate: a ≥10-digit round would resume as a review there and
 * read as "no round" / "not published" here.
 *
 * AND THE BOUND IS NOW ENFORCED AT THE WRITER (Argus r10, minor). The claim used
 * to be "no writer in this repo can emit such a round", justified by a fallback
 * argument that PREDATES the settle-timeout gate: "not published" is no longer
 * merely recoverable, it now feeds terminalization of a run that DID publish.
 * The round on the write side comes from `parseInnerResult`, i.e. from substrate
 * JSON, which can carry any number at all — so `checkpointRoundField` below
 * clamps it into this bound and every writer of the marker goes through it.
 *
 * Groups: 1 = sha, 2 = remaining tasks, 3 = round.
 */
export const OUTER_PUBLISHED_CHECKPOINT = /^outer-published:([0-9a-f]{40}):(\d+):(\d{1,9})(?::deviated)?$/

/** The largest round `OUTER_PUBLISHED_CHECKPOINT` accepts — nine digits. */
export const MAX_CHECKPOINT_ROUND = 999_999_999 as const

/**
 * The round to WRITE into an `outer-published:…` marker: a non-negative integer
 * inside {@link OUTER_PUBLISHED_CHECKPOINT}'s own bound.
 *
 * CLAMP, DO NOT REFUSE. The round is a label on a real, already-pushed commit;
 * a hostile or garbled value must not cost the marker its meaning, because the
 * settle-timeout gate reads the marker's PRESENCE to decide that a run which
 * built and published is not written off as `failed`. A wrong round number is a
 * cosmetic loss; an unparseable marker is a lost build. Anything not a finite
 * number (NaN, ±Infinity, a non-integer, a negative) reads as round 0 — the
 * same "carries no round" answer `checkpointRound` already gives.
 */
export function checkpointRoundField(round: number | null | undefined): number {
  if (round === null || round === undefined || !Number.isFinite(round)) return 0
  const floored = Math.floor(round)
  if (floored <= 0) return 0
  return Math.min(floored, MAX_CHECKPOINT_ROUND)
}

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
 */
export function checkpointRound(checkpoint: string | null): number | null {
  if (checkpoint === null) return null
  const name = checkpoint.trim()
  const fix = /^fix-round-(\d+)$/.exec(name)
  if (fix !== null) return Number(fix[1])
  const published = OUTER_PUBLISHED_CHECKPOINT.exec(name)
  if (published !== null) return Number(published[3])
  return null
}
