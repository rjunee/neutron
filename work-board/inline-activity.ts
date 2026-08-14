/**
 * Aligned with `WEDGE_AFTER_MS` in `open/activity-inspector.ts`: a session with no
 * real (non-keepalive) activity for 90 s is not visibly working.
 *
 * Evidence is deliberately tier 1 only: the in-process ActivityInspector clock is
 * an O(1) Map read per project scope. Tiers 2–3 (branch commits and a dirty
 * worktree) would shell out per row per render and are non-goals on this read path.
 * The stored `inline_active` flag is only a hint; when it disagrees with evidence,
 * evidence wins. This module must remain display-only and never grow a blocking or
 * gating branch.
 */
export const INLINE_EVIDENCE_WINDOW_MS = 90_000

export interface InlineActivityScanItem {
  status: string
  inline_active: boolean
  linked_run_id: string | null
}

export interface InlineEvidence {
  /**
   * ms epoch of the last NON-synthetic inspector event for the item's project
   * scope; 0 = none ever recorded (including after a process restart, which is
   * correct: a crashed session's stale flag must read not-active).
   */
  last_real_activity_at: number
  /** Server clock (ms) at derivation time. */
  now: number
  /** Test override; defaults to {@link INLINE_EVIDENCE_WINDOW_MS}. */
  window_ms?: number
}

export function deriveInlineActive(
  item: InlineActivityScanItem,
  evidence: InlineEvidence,
): boolean {
  // R1 mutant: terminal cards must never claim live inline work.
  if (item.status === 'done' || item.status === 'failed') return false
  // R2 mutant: run-bound cards get their activity from the fork lane, not chat evidence.
  if (item.linked_run_id !== null && item.linked_run_id.length > 0) return false

  const windowMs = evidence.window_ms ?? INLINE_EVIDENCE_WINDOW_MS
  // R3 mutant: absent/stale evidence wins over the stored hint; the boundary is stale.
  if (
    evidence.last_real_activity_at === 0 ||
    evidence.now - evidence.last_real_activity_at >= windowMs
  ) {
    return false
  }

  // R4 mutant: fresh evidence activates current inline work without requiring a flag write.
  return item.inline_active === true || item.status === 'in_progress'
}

/** Late-bound evidence seam. The composer defines this holder BEFORE the
 *  ActivityInspector exists and binds `lastRealActivityAt` after construction;
 *  an unset holder reads as evidence 0 => never active (fail-soft, and exactly
 *  the correct post-restart semantics: a crashed session's stale flag heals). */
export interface InlineEvidenceReader {
  lastRealActivityAt?: (scope: string) => number
}

/** Map a board's items to carry the DERIVED `inline_active` on the wire.
 *  Cost bound (acceptance e): ONE O(1) evidence read per board, zero per extra
 *  row, no I/O — never call the reader inside the per-item loop. */
export function withDerivedInlineActive<T extends InlineActivityScanItem>(
  items: readonly T[],
  reader: InlineEvidenceReader,
  scope: string,
  now: number,
): T[] {
  const last_real_activity_at = reader.lastRealActivityAt?.(scope) ?? 0
  return items.map((it) => ({
    ...it,
    inline_active: deriveInlineActive(it, { last_real_activity_at, now }),
  }))
}
