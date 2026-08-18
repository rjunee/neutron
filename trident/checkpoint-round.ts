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
  const published = /^outer-published:[0-9a-f]{40}:\d+:(\d+)(:deviated)?$/.exec(name)
  if (published !== null) return Number(published[1])
  return null
}
