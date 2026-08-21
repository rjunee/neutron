/**
 * Decode the findings a checkpoint was recorded with
 * (`code_trident_runs.inner_checkpoint_findings`) for the resumed fix round.
 *
 * Returns `[]` for null/empty/unparseable/non-array content, and that empty array
 * is load-bearing rather than merely tidy: the workflow treats "no recorded
 * findings" as a reason to RE-REVIEW instead of skipping forward, so a column
 * written by an older or garbled writer degrades into paying for the review again
 * — never into a fix round with nothing to fix. Entries are passed through
 * verbatim (the workflow embeds them in the fix prompt exactly as the synthesis
 * produced them); this decoder's only job is to guarantee an array.
 */
export function parseCheckpointFindings(raw: string | null | undefined): unknown[] {
  if (typeof raw !== 'string' || raw.trim().length === 0) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  return Array.isArray(parsed) ? parsed : []
}
