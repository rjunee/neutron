/**
 * @neutronai/work-board — the ask-before-acting dispatch gate (Phase 2b).
 *
 * Ryan-locked hard rule (2026-06-29): when the orchestrator goes to WORK a
 * board item by dispatching an autonomous build / sub-agent against it, the
 * item must carry enough specification to act on. A human can drop a one-line
 * pointer onto the board ("auth", "fix the import bug") and the agent sees it
 * next turn — but it must NOT silently guess at intent and dispatch on
 * assumptions. It must either follow the item's design doc, or ASK the owner a
 * clarifying question first.
 *
 * This is the DETERMINISTIC half of that gate: a pure predicate the dispatch
 * chokepoints (`/code` → `executeDispatch`, `dispatch_agent` →
 * `DispatchService.dispatch`) call BEFORE creating a run. When it returns
 * `ready:false` the chokepoint REJECTS the dispatch (no run row, no sub-agent)
 * and hands the `reason` back to the agent, whose contract is then to ask the
 * owner rather than proceed. The agent half (actually asking) lives in the
 * agent's prompt + the rejection message; the block itself is enforced here in
 * TypeScript so it can never be a no-op the model talks past.
 *
 * "Enough specification" = a `design_doc_ref` (the item points at a full design
 * doc) OR a title detailed enough to stand on its own. A bare stub title with
 * no design doc is treated as underspecified. The detail threshold is a word
 * count: a real task description ("Add SSO + MFA to the login flow with a
 * fallback to email codes") clears it; a pointer ("auth", "fix login") does
 * not. Crude by design — the cost of a false "ready" is the agent acting on a
 * thin spec; the cost of a false "not ready" is one clarifying question. We
 * bias toward asking.
 */

/** The minimal shape the gate inspects (a `WorkBoardItem`, or any subset). */
export interface DispatchReadinessTarget {
  title: string
  design_doc_ref: string | null
}

export interface DispatchReadiness {
  ready: boolean
  /** Present ONLY when `ready:false` — the clarifying-question guidance handed
   *  back to the agent at the rejected chokepoint. */
  reason?: string
}

/**
 * A title with at least this many whitespace-separated words is considered to
 * carry enough detail to dispatch on without a design doc. Eight words is a
 * full descriptive sentence ("Wire the export button to the new CSV endpoint")
 * vs a pointer ("fix the export"). Tunable; documented in SYSTEM-OVERVIEW.
 */
export const MIN_DETAIL_WORDS = 8

/** Word count over a title (collapses runs of whitespace, ignores empties). */
function wordCount(title: string): number {
  return title.trim().split(/\s+/).filter((w) => w.length > 0).length
}

/**
 * Assess whether a board item is specified enough to dispatch an autonomous
 * build / sub-agent against. Pure + deterministic — the gate's TS half.
 */
export function assessDispatchReadiness(item: DispatchReadinessTarget): DispatchReadiness {
  const ref = item.design_doc_ref
  if (typeof ref === 'string' && ref.trim().length > 0) {
    return { ready: true }
  }
  if (wordCount(item.title) >= MIN_DETAIL_WORDS) {
    return { ready: true }
  }
  return {
    ready: false,
    reason:
      `Plan item "${item.title.trim()}" is underspecified — it has no design_doc_ref and ` +
      `its title is too terse to act on safely. Per the ask-before-acting rule, do NOT ` +
      `dispatch on assumptions: ask the owner a clarifying question about what they want, ` +
      `then either attach a design_doc_ref (work_board_update) or expand the item's title ` +
      `with the agreed scope before dispatching again.`,
  }
}
