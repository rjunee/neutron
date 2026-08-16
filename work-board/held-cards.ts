/**
 * @neutronai/work-board — the READ-ONLY join between a board card and its
 * dispatch HOLD (migration 0124, `code_trident_dispatch_holds`).
 *
 * A build that collides with a declared blocker or with a file another live run
 * already claims is HELD, not rejected: the dispatch posts one chat message
 * naming the card/path/blocker, and then the chat scrolls away. The STANDING
 * state has to be legible where the owner and the orchestrator actually look —
 * `work_board_list` and the per-turn `<work_board>` fragment — which is what
 * this join is for.
 *
 * DELIBERATELY STRUCTURAL: `work-board` does not import `trident`. The lookup is
 * the smallest shape `DispatchHoldStore.listByProject` already satisfies, so the
 * composer passes the store itself and no dependency edge is added between the
 * two packages.
 *
 * READ-ONLY, ALWAYS: nothing here writes, deletes or expires a hold row. The
 * hold's lifecycle stays entirely in `trident/board-dispatch.ts` (write) and the
 * terminal-observer sweep (drain).
 */

/** The one method the board surfaces need off the hold store. */
export interface WorkBoardHoldLookup {
  listByProject(
    project_slug: string,
  ): ReadonlyArray<{ board_item_id: string; hold_reason: string }>
}

/**
 * Card id → the hold's stored reason text, for one board scope.
 *
 * The reason is rendered VERBATIM by both surfaces: `trident/board-dispatch.ts`
 * already composed it to name the blocking card / path / holding run, and
 * re-deriving it here would let the two messages drift apart.
 *
 * Total: an unwired lookup, an empty table, or a lookup that throws all collapse
 * to an EMPTY map, so a holds outage degrades the board to its pre-0124 output
 * instead of failing the read.
 */
export function heldReasonsByItem(
  lookup: WorkBoardHoldLookup | undefined,
  project_slug: string,
): ReadonlyMap<string, string> {
  if (lookup === undefined) return EMPTY
  try {
    const rows = lookup.listByProject(project_slug)
    if (rows.length === 0) return EMPTY
    const out = new Map<string, string>()
    for (const row of rows) out.set(row.board_item_id, row.hold_reason)
    return out
  } catch {
    return EMPTY
  }
}

const EMPTY: ReadonlyMap<string, string> = new Map<string, string>()
