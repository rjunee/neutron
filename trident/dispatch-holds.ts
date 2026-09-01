/**
 * @neutronai/trident — the dispatch HOLD QUEUE (migration 0124).
 *
 * A build blocked by a declared card dependency, or by a file another LIVE run
 * already claims, is HELD — not rejected. A rejection would put the owner back
 * in the loop (re-fire it by hand once the blocker clears), and hand-serialising
 * lanes is exactly what this card exists to delete.
 *
 * The durable state of a held dispatch is EXACTLY ONE row in
 * `code_trident_dispatch_holds`, keyed `(project_slug, board_item_id)` — no
 * `code_trident_runs` row exists (the chokepoint's "a dispatch that does not
 * return ok:true writes zero run state" invariant is preserved). The row carries
 * the task + the originating chat payload, so the build that eventually fires
 * reports back to the place the human dispatched it from.
 *
 * THE QUEUE DRAINS ON THE TRIDENT TERMINAL OBSERVER ({@link buildDispatchHoldSweep}),
 * composed AFTER `buildBoardReconcileObserver` so a blocker card's `status='done'`
 * is already written when its dependents re-evaluate. Re-dispatch goes back
 * through `dispatchBoardBoundBuild` itself, so EVERY gate re-runs and a card that
 * is still held simply refreshes its hold row.
 *
 * AND ON THE TICK'S OWN CADENCE, because a terminal event is not the only way a
 * hold clears. A `branch_live` hold can be created for a holder that is NOT a
 * run at all — a live worktree lock naming a bare pid, held_on_run_id null. That
 * pid exiting fires no terminal observer, so on an instance with nothing else
 * running the card would sit queued indefinitely. `TridentTickLoop`'s
 * `drain_dispatch_holds` therefore calls the same sweep once per tick, sharing
 * the tick's single-flight and cadence rather than adding a timer.
 */

import type { ProjectDb } from '@neutronai/persistence/index.ts'
import type { Topic } from '@neutronai/channels/types.ts'
import { createLogger } from '@neutronai/logger'
import {
  dispatchBoardBoundBuild,
  type BoardBoundBuildDeps,
  type TridentBoardBinder,
} from './board-dispatch.ts'
import type { TridentRun } from './store.ts'

const log = createLogger('trident')

/** The chat/limits context the held dispatch was fired with, replayed verbatim. */
export interface DispatchHoldPayload {
  chat_id?: string | null
  thread_id?: string | null
  channel_kind?: Topic['channel_kind']
  max_rounds?: number
  max_ralph_rounds?: number
}

export interface DispatchHold {
  id: string
  project_slug: string
  board_item_id: string
  task: string
  payload: DispatchHoldPayload | null
  claimed_paths: string[]
  hold_kind: 'blocker' | 'path'
  hold_reason: string
  held_on_run_id: string | null
  held_on_blocker_id: string | null
  created_at: string
  updated_at: string
}

export interface DispatchHoldInput {
  project_slug: string
  board_item_id: string
  task: string
  payload?: DispatchHoldPayload | null
  claimed_paths?: string[]
  hold_kind: 'blocker' | 'path'
  hold_reason: string
  held_on_run_id?: string | null
  held_on_blocker_id?: string | null
}

interface DispatchHoldDbRow {
  id: string
  project_slug: string
  board_item_id: string
  task: string
  payload: string | null
  claimed_paths: string | null
  hold_kind: 'blocker' | 'path'
  hold_reason: string
  held_on_run_id: string | null
  held_on_blocker_id: string | null
  created_at: string
  updated_at: string
}

const COLS =
  'id, project_slug, board_item_id, task, payload, claimed_paths, hold_kind, ' +
  'hold_reason, held_on_run_id, held_on_blocker_id, created_at, updated_at'

function parseJsonObject(raw: string | null): DispatchHoldPayload | null {
  if (raw === null || raw === '') return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as DispatchHoldPayload)
      : null
  } catch {
    return null
  }
}

function parseJsonStrings(raw: string | null): string[] {
  if (raw === null || raw === '') return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((p): p is string => typeof p === 'string' && p.length > 0)
  } catch {
    return []
  }
}

function rowToHold(row: DispatchHoldDbRow): DispatchHold {
  return {
    id: row.id,
    project_slug: row.project_slug,
    board_item_id: row.board_item_id,
    task: row.task,
    payload: parseJsonObject(row.payload),
    claimed_paths: parseJsonStrings(row.claimed_paths),
    hold_kind: row.hold_kind,
    hold_reason: row.hold_reason,
    held_on_run_id: row.held_on_run_id,
    held_on_blocker_id: row.held_on_blocker_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

/**
 * CRUD over `code_trident_dispatch_holds`. Mirrors `TridentRunStore`: a thin
 * typed wrapper over `ProjectDb`, async writes, sync reads.
 */
export class DispatchHoldStore {
  constructor(
    private readonly db: ProjectDb,
    /** Injectable clock for tests; defaults to wall-clock ISO-8601. */
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  /**
   * Record (or refresh) the hold for one card. A card that is dispatched again
   * and held again UPDATES its row rather than queueing twice — the unique index
   * on `(project_slug, board_item_id)` is the conflict target. `created_at` is
   * preserved so the sweep's oldest-first order stays FIFO across refreshes.
   */
  async upsert(input: DispatchHoldInput): Promise<void> {
    const ts = this.now()
    await this.db.run(
      `INSERT INTO code_trident_dispatch_holds (${COLS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_slug, board_item_id) DO UPDATE SET
         task = excluded.task,
         payload = excluded.payload,
         claimed_paths = excluded.claimed_paths,
         hold_kind = excluded.hold_kind,
         hold_reason = excluded.hold_reason,
         held_on_run_id = excluded.held_on_run_id,
         held_on_blocker_id = excluded.held_on_blocker_id,
         updated_at = excluded.updated_at`,
      [
        crypto.randomUUID(),
        input.project_slug,
        input.board_item_id,
        input.task,
        input.payload === undefined || input.payload === null
          ? null
          : JSON.stringify(input.payload),
        JSON.stringify(input.claimed_paths ?? []),
        input.hold_kind,
        input.hold_reason,
        input.held_on_run_id ?? null,
        input.held_on_blocker_id ?? null,
        ts,
        ts,
      ],
    )
  }

  /** Every held card, oldest first (the sweep drains in FIFO order). */
  list(): DispatchHold[] {
    return this.db
      .prepare<DispatchHoldDbRow, []>(
        `SELECT ${COLS} FROM code_trident_dispatch_holds ORDER BY created_at ASC, id ASC`,
      )
      .all()
      .map(rowToHold)
  }

  /**
   * Every held card on ONE board, oldest first. The READ-ONLY join the board
   * surfaces use: `work_board_list` and the `<work_board>` per-turn fragment
   * call this once per render and mark the cards that have a row, so a hold is
   * still legible long after the dispatch-time chat message has scrolled away.
   * Scoped by `project_slug` — which for a board-bound dispatch IS the work-board
   * scope key (`workBoardScopeKey(slug, project_id)`), so project A's holds can
   * never surface on project B's board.
   */
  listByProject(project_slug: string): DispatchHold[] {
    return this.db
      .prepare<DispatchHoldDbRow, [string]>(
        `SELECT ${COLS} FROM code_trident_dispatch_holds
          WHERE project_slug = ? ORDER BY created_at ASC, id ASC`,
      )
      .all(project_slug)
      .map(rowToHold)
  }

  getByItem(project_slug: string, board_item_id: string): DispatchHold | null {
    const row = this.db
      .prepare<DispatchHoldDbRow, [string, string]>(
        `SELECT ${COLS} FROM code_trident_dispatch_holds
          WHERE project_slug = ? AND board_item_id = ?`,
      )
      .get(project_slug, board_item_id)
    return row === null ? null : rowToHold(row)
  }

  /** Drop a card's hold — it dispatched, finished, or left the board. */
  async deleteByItem(project_slug: string, board_item_id: string): Promise<void> {
    await this.db.run(
      `DELETE FROM code_trident_dispatch_holds WHERE project_slug = ? AND board_item_id = ?`,
      [project_slug, board_item_id],
    )
  }
}

/**
 * Build the trident TERMINAL OBSERVER that drains the hold queue: every time a
 * run goes terminal, re-dispatch every held card through the SAME chokepoint.
 *
 * A run going terminal is exactly the moment a path claim is released AND (via
 * the board reconcile composed BEFORE this observer) the moment a blocker card's
 * `status='done'` lands — so it is the one event that can unblock either kind of
 * hold. Ordering is load-bearing: composed before the reconcile, a dependent card
 * would re-evaluate against a blocker still marked in_progress and just refresh
 * its hold.
 *
 * NO RECURSION: the queue is snapshotted ONCE per fire. A card dispatched here
 * will enqueue its own terminal event later, which drains whatever it unblocks —
 * the queue converges without this function ever calling itself.
 *
 * Each hold is handled in its own try/catch so one bad row can never block the
 * rest, and a non-`held` REJECTION drops the hold with a warn log: the card is
 * not silently lost (it sits un-dispatched on the board and the reason is in the
 * log), but neither is it retried forever against a rejection that will not
 * change on its own.
 */
export function buildDispatchHoldSweep(deps: {
  holds: DispatchHoldStore
  board: TridentBoardBinder
  /**
   * Rebuild the dispatch deps for one queued hold. `preflight` is REQUIRED here
   * even though `BoardBoundBuildDeps` leaves it optional, and that narrowing is
   * deliberate.
   *
   * This sweep is a fourth production entry into `dispatchBoardBoundBuild`, and
   * it is the one entry not written by hand at a call site — it re-fires builds
   * later, unattended, with nobody watching. An unattended re-dispatch onto a
   * known-dead executor is strictly worse than an interactive one: it spawns a
   * lane that dies ~15 minutes later and no one asked for it just then.
   *
   * Requiring it in the TYPE is also what lets the executor-liveness wiring
   * guard count this file as a properly gated entry. The guard greps for the
   * word; this type is what makes the word true.
   */
  makeDispatchDeps: (hold: DispatchHold) => BoardBoundBuildDeps & {
    preflight: NonNullable<BoardBoundBuildDeps['preflight']>
  }
}): (run?: TridentRun) => Promise<void> {
  // THE RUN ARGUMENT IS OPTIONAL BECAUSE THE SWEEP HAS TWO TRIGGERS. As a
  // terminal observer it is handed the run that just terminalized (and ignores
  // it — the queue is re-evaluated whole). The tick's per-cadence drain calls it
  // with NO run at all, which is the only trigger a WORKTREE-ONLY holder can
  // ever have: a `branch_live` hold whose `held_on_run_id` is null is waiting on
  // a pid, and a pid exiting emits no terminal event, so on a quiet instance the
  // observer alone would never fire again and the card would queue forever.
  return async (_run?: TridentRun): Promise<void> => {
    const queued = deps.holds.list()
    for (const hold of queued) {
      try {
        const item = deps.board.get(hold.project_slug, hold.board_item_id)
        if (item === null || item.status === 'done') {
          // The card was deleted off the board or finished by hand — a hold with
          // nothing to dispatch must be dropped, not retried forever.
          await deps.holds.deleteByItem(hold.project_slug, hold.board_item_id)
          continue
        }
        const dispatchDeps = deps.makeDispatchDeps(hold)
        if (item.linked_run_id !== null && item.linked_run_id !== undefined) {
          const linked = dispatchDeps.store.get(item.linked_run_id)
          if (linked !== null && !['done', 'failed', 'stopped'].includes(linked.phase)) {
            // A successful dispatch through any entry point owns the card now.
            // Drop a stale hold rather than attaching a second concurrent run.
            await deps.holds.deleteByItem(hold.project_slug, hold.board_item_id)
            continue
          }
        }
        const result = await dispatchBoardBoundBuild(
          { task: hold.task, board_item_id: hold.board_item_id },
          dispatchDeps,
        )
        if (result.ok) {
          // The dispatch itself already cleared the hold; the delete is
          // idempotent and keeps this path honest if that ever changes.
          await deps.holds.deleteByItem(hold.project_slug, hold.board_item_id)
          continue
        }
        if (result.code === 'held') continue // still blocked; the gate refreshed the row
        // `branch_live` IS TRANSIENT, EXACTLY LIKE `held`. The dispatch gate
        // refuses when a live worktree lock (or a non-terminal same-branch run)
        // holds the card's branch — a condition that ends the moment that lane
        // finishes. Deleting the hold there would silently drop a QUEUED card
        // that nothing ever re-dispatches, converting "wait for the live lane"
        // into "this card is gone". Keep it queued and let the next sweep ask
        // again; the ONLY codes that delete are the permanent ones below.
        //
        // BUT SAY SO, WITH ITS AGE. `held` refreshes a row an operator can read;
        // a silent `continue` made a branch-held card indistinguishable from one
        // nobody queued. The age is the point: this sweep only runs when some
        // run terminalizes, so a hold that keeps re-refusing is the signal that
        // the "live" holder is a stale worktree lock nothing will ever release.
        if (result.code === 'branch_live') {
          log.warn('dispatch_hold_branch_live', {
            project: hold.project_slug,
            item: hold.board_item_id,
            held_since: hold.created_at,
            error: result.message,
          })
          continue
        }
        log.warn('dispatch_hold_rejected', {
          project: hold.project_slug,
          item: hold.board_item_id,
          code: result.code,
          error: result.message,
        })
        await deps.holds.deleteByItem(hold.project_slug, hold.board_item_id)
      } catch (err) {
        log.warn('dispatch_hold_sweep_failed', {
          project: hold.project_slug,
          item: hold.board_item_id,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }
}
