/**
 * @neutronai/contracts — the RAIL DERIVATION both the server and the clients need.
 *
 * WHY IT LIVES HERE. These functions are pure (no DB, no clock, no imports) and
 * the SERVER derives with them while the CLIENTS assert against them: the
 * work-board row dot and the project-rail dot must agree, and a lockstep test
 * can only check that if both sides can see the same function. It previously
 * lived in `@neutronai/open`, which the app does not and should not depend on —
 * so a test reached across with a relative `../../open/...` import and the
 * cross-workspace lint gate refused it, correctly.
 *
 * Moving the two shared helpers here is the fix rather than moving the TEST:
 * the lockstep assertion legitimately spans both sides (it also needs the app's
 * own `railDotKind`), so there is no single package the test could live in
 * unless the derivation itself is shared. `@neutronai/open` re-exports these so
 * its ten existing consumers are untouched.
 */

/** The single per-project rail state. `attention` outranks `working`. */
export type ProjectActivity = 'idle' | 'working' | 'attention'

/** Who sent the previewed message, for the rail's `You: ` prefix. */
export type PreviewFrom = 'user' | 'agent' | null

/**
 * The observable signals that decide a project's activity. The composer collects
 * these from the project's Work-Board items + their bound runs + its live chat
 * turn; this function applies the precedence.
 */
export interface ProjectActivitySignals {
  /** A live chat turn is in progress for this project (composer-tracked). */
  chatTurnInProgress: boolean
  /** Count of the project's board items bound to a LIVE (non-terminal) run. */
  liveRunCount: number
  /** Any board item is `inline_active` (an inline agent action running). */
  hasInlineActive: boolean
  /** Any NOT-done board item whose bound run is `failed` (needs attention). */
  hasFailedNotDone: boolean
  /** Any live bound run has stalled past the display stall threshold. */
  hasStalledLiveRun: boolean
}

/**
 * Derive a project's rail activity from its signals. Precedence (spec):
 *   attention  — a bound run failed on a not-done item, OR a live run stalled.
 *   working    — a live chat turn, OR any live run, OR an inline-active item.
 *   idle       — none of the above.
 * `attention` deliberately WINS over `working`: a failed/stalled build is more
 * important to surface than the fact that something is also running.
 */
export function deriveProjectActivity(s: ProjectActivitySignals): ProjectActivity {
  if (s.hasFailedNotDone || s.hasStalledLiveRun) return 'attention'
  if (s.chatTurnInProgress || s.liveRunCount > 0 || s.hasInlineActive) return 'working'
  return 'idle'
}

/**
 * A minimal view of a Work-Board item for rail-signal derivation. Kept
 * deliberately broad (string `status`) so this pure module has no dependency
 * on the work-board store's concrete types.
 */
export interface RailScanItem {
  /** WorkBoardStatus string; 'failed' is written only by terminal reconcile. */
  status: string
  /** True when an inline agent action is running for this item. */
  inline_active: boolean
  /** Bound run id, or null when no run is attached. */
  linked_run_id: string | null
}

/**
 * Scan Work-Board items to produce the board-level `hasFailedNotDone` and
 * `hasInlineActive` signals for `ProjectActivitySignals`. Extracted as a PURE
 * function (no I/O) so the derivation logic is unit-testable in isolation;
 * the composer's `readProjectRailExtras` closure uses this and supplies the DB
 * look-up via `isRunTerminalFailed`.
 *
 * `isRunTerminalFailed(runId)` → true when the run exists AND its phase is
 * terminal-failed (e.g. 'failed'); false when not found, not terminal, or
 * terminal-but-not-failed (e.g. 'merged', 'cancelled').
 *
 * CONTRACT (defect 2026-08-12):
 *   - `status='failed'` is written ONLY by terminal reconcile (detachRun,
 *     work-board/store.ts #340). It is durable — not a brief window. A runless
 *     item with `status='failed'` (e.g. research/dispatch with cleared link) is
 *     caught HERE, before the linked-run check, so it is never missed.
 *   - A still-bound terminal-failed run on a not-done item is caught by the
 *     `isRunTerminalFailed` callback (brief pre-reconcile window or kept
 *     binding from #340 where the link is preserved after failure).
 */
export function scanItemsForRailSignals(
  items: readonly RailScanItem[],
  isRunTerminalFailed: (runId: string) => boolean,
): { hasFailedNotDone: boolean; hasInlineActive: boolean } {
  let hasFailedNotDone = false
  let hasInlineActive = false
  for (const item of items) {
    if (item.inline_active) hasInlineActive = true
    // Durable failure: status='failed' is written only by terminal reconcile.
    // Catches runless-but-failed items (cleared link, research/dispatch runs).
    if (item.status === 'failed') {
      hasFailedNotDone = true
      continue
    }
    const runId = item.linked_run_id
    if (runId === null || runId.length === 0) continue
    // Still-bound terminal-failed run on a not-done item → attention.
    if (isRunTerminalFailed(runId) && item.status !== 'done') {
      hasFailedNotDone = true
    }
  }
  return { hasFailedNotDone, hasInlineActive }
}

