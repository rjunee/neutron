/**
 * @neutronai/work-board — the ONE card-removal chokepoint.
 *
 * WHY this module exists (Ryan, 2026-08-14): "add a card to build the function
 * to delete cards, so you don't have to ask me to X them." The capability
 * already existed — but only inline in `gateway/http/work-board-surface.ts`'s
 * `handleDelete`, behind the UI's X. The agent's only removal lever was
 * `complete`, so deprioritised cards had to be misreported as `done`. Extracting
 * the logic HERE gives the agent tool (T2) and the HTTP DELETE the SAME path,
 * run-cancellation and all — one implementation, not two that drift.
 *
 * The removal ORDER is the invariant:
 *
 *   1. resolve the card in scope (absent → `{ removed: false }`, a 404 upstream)
 *   2. CANCEL a live bound run FIRST — deleting the row first would orphan a
 *      trident build (it keeps building headless) or an Atlas research
 *      subprocess. Best-effort: a cancel failure never blocks the delete.
 *   3. DISPOSE the card's plan doc by the removal REASON — shipped/cancelled/
 *      moved are three different fates and only the remover knows which. The doc
 *      MOVES to `plans/<reason>/<basename>`; it stays under the docs root, so it
 *      is still readable + tappable in the Documents tab. NO implicit path ever
 *      deletes a doc (the 2026-08-14 counter-example: the removed Forge publish
 *      card's doc held designs the owner was building from in another session at
 *      that moment). Only an explicit `plan_doc: 'delete'` destroys one.
 *   4. HARD-delete the row (`store.delete` is a real `DELETE FROM` — removed is
 *      really gone, not hidden behind a filter a later `list` resurrects).
 *
 * Layering: `work-board/package.json` has NO trident dep and must not gain one.
 * Every dep here is STRUCTURAL — a run-access slice, an `is_terminal_phase`
 * predicate, a doc mover — exactly the shapes `open/composer.ts`'s
 * `boardRunAccess` facade and the surface's `TridentRunAccess` already have.
 */

import { createLogger } from '@neutronai/logger'
import { docPathFromDesignRef, PLANS_DIR } from './spec-doc.ts'
import type { WorkBoardStore } from './store.ts'

/**
 * Why the card left the board. Not a status — the card is GONE either way; this
 * only records the fate so the plan doc's disposition can follow it.
 */
export type WorkBoardRemovalReason = 'shipped' | 'cancelled' | 'moved'

/** The accepted reasons, for enum validation at the HTTP + agent-tool edges. */
export const WORK_BOARD_REMOVAL_REASONS: WorkBoardRemovalReason[] = [
  'shipped',
  'cancelled',
  'moved',
]

/**
 * The trident-run slice the removal needs: read a bound run's phase, and cancel
 * it. Satisfied STRUCTURALLY by the surface's `TridentRunAccess` and the
 * composer's `boardRunAccess` facade — no trident import here.
 */
export interface RemovalRunAccess {
  get(id: string): { phase: string } | null
  update(id: string, patch: { phase: 'stopped' }): Promise<unknown>
  /**
   * §F6a — the terminal-write CHOKEPOINT. Writes the terminal phase AND runs the
   * terminal-observer chain (delivery + board reconcile), the SAME chain the
   * tick loop fires for a loop-reaped run. Returns `{ won }` — whether the
   * ATOMIC transition actually landed. A lost race cancelled nothing, so no
   * `cancelled_run` is reported for it (Codex r3). Absent on observer-less boots
   * → fall back to a bare `update`.
   */
  terminate?(id: string, phase: 'stopped', reason?: string): Promise<{ won: boolean }>
}

/** The `DocStore` slice the removal needs (move a doc; delete one on request). */
export interface RemovalDocStore {
  moveDoc(project_id: string, from: string, to: string): Promise<unknown>
  deleteDoc(
    project_id: string,
    path: string,
    opts?: { expected_modified_at?: number },
  ): Promise<unknown>
}

export interface RemovalLog {
  warn(message: string): void
}

export interface WorkBoardRemovalDeps {
  store: Pick<WorkBoardStore, 'get' | 'delete'>
  /** Absent (board-less / trident-less boot) → the trident-cancel branch is skipped entirely. */
  trident_runs?: RemovalRunAccess
  /** The gateway passes trident's `isTerminalPhase`. Absent → same degradation as above. */
  is_terminal_phase?: (phase: string) => boolean
  /** #379 — stop a NON-trident (agent-dispatch) run bound to a research card. */
  cancel_dispatch?: (run_id: string) => Promise<void>
  /** Absent → doc disposition degrades to `left_in_place` (nothing is ever destroyed). */
  docs?: RemovalDocStore
  log?: RemovalLog
}

export interface WorkBoardRemovalResult {
  /** `false` ⇢ no such item in this scope (the caller maps it to a 404). */
  removed: boolean
  /** Set ONLY when a cancellation actually landed. */
  cancelled_run?: string
  /** What happened to the card's own `plans/` doc, when it had one. */
  plan_doc?: {
    path: string
    disposition: 'moved' | 'deleted' | 'left_in_place'
    to?: string
  }
}

export interface WorkBoardRemovalOptions {
  reason: WorkBoardRemovalReason
  /**
   * The ONLY way a plan doc is destroyed. Deliberate, never implied by a reason.
   */
  plan_doc?: 'delete'
}

const removalLog = createLogger('work-board-removal')

export class WorkBoardRemovalService {
  private readonly deps: WorkBoardRemovalDeps
  private readonly log: RemovalLog

  constructor(deps: WorkBoardRemovalDeps) {
    this.deps = deps
    this.log = deps.log ?? removalLog
  }

  /**
   * Remove a card from `scope`. `docs_project_id` is the DOCS project id, a
   * SEPARATE argument from the board scope key on purpose — collapsing the two
   * is the phantom-directory conflation documented in `spec-doc-service.ts`.
   */
  async remove(
    scope: string,
    docs_project_id: string,
    item_id: string,
    opts: WorkBoardRemovalOptions,
  ): Promise<WorkBoardRemovalResult> {
    const item = this.deps.store.get(scope, item_id)
    if (item === null) return { removed: false }

    const cancelled_run = await this.cancelBoundRun(item.task_type, item.linked_run_id)
    const plan_doc = await this.disposePlanDoc(
      docs_project_id,
      scope,
      item_id,
      item.design_doc_ref,
      opts,
    )
    await this.deps.store.delete(scope, item_id)
    return {
      removed: true,
      ...(cancelled_run !== undefined ? { cancelled_run } : {}),
      ...(plan_doc !== undefined ? { plan_doc } : {}),
    }
  }

  /**
   * Step 2 — cancel a LIVE bound run before the row goes. Deleting the row first
   * would leave a trident build running headless / an Atlas subprocess orphaned.
   * Every branch is best-effort: a cancel failure never blocks the delete (the
   * row is disposable; the run reap backstops liveness).
   */
  private async cancelBoundRun(
    task_type: string,
    runId: string | null,
  ): Promise<string | undefined> {
    if (runId === null || runId.length === 0) return undefined
    const { trident_runs, is_terminal_phase, cancel_dispatch } = this.deps

    // #379 — a RESEARCH card's linked run is an agent-dispatch run (not a trident
    // row), so the trident cancel below no-ops for it. Cancel it via the dispatch
    // stop hook so the Atlas subprocess isn't orphaned. Best-effort + a no-op for
    // an unknown/terminal run id (DispatchService.stop returns false).
    if (task_type === 'research') {
      if (cancel_dispatch === undefined) return undefined
      try {
        await cancel_dispatch(runId)
        return runId
      } catch {
        // dispatch cancel is best-effort — proceed with the delete
        return undefined
      }
    }

    if (trident_runs === undefined || is_terminal_phase === undefined) return undefined
    try {
      const run = trident_runs.get(runId)
      if (run === null || is_terminal_phase(run.phase)) return undefined
      // §F6a — route the cancel through the ONE `terminate()` chokepoint when
      // wired, so the terminal-observer chain (delivery + board reconcile) fires
      // for an X-cancel exactly as it does for a loop-reaped run.
      if (trident_runs.terminate !== undefined) {
        // Only claim a cancellation the ATOMIC transition actually won — the
        // pre-check above can go stale in the await gap (the tick loop finishes
        // the run first), and a lost race cancelled nothing (Codex r3).
        const { won } = await trident_runs.terminate(runId, 'stopped')
        return won ? runId : undefined
      }
      // Bare `update` does NOT retract a stale `subagent_status='running'` the
      // way `terminalTransition` does, so a run cancelled on a board-less boot
      // can still read as in-flight. Accepted: unreachable in a normal boot
      // (`open/composer.ts` binds the terminator unconditionally), and passing
      // `subagent_status: null` here would trip `update()`'s crash veto and
      // refuse the phase write outright on an already-crashed row.
      await trident_runs.update(runId, { phase: 'stopped' })
      return runId
    } catch {
      // Cancel is best-effort — proceed with the delete regardless.
      return undefined
    }
  }

  /**
   * Step 3 — the plan doc's fate follows the removal REASON. Only a doc that is
   * the card's OWN spec doc (an in-app ref under `plans/`) is touched: an
   * `https:` ref points at something we don't own, and a doc outside `plans/` is
   * an owner-authored doc that a "removal" must not relocate.
   */
  private async disposePlanDoc(
    docs_project_id: string,
    scope: string,
    item_id: string,
    design_doc_ref: string | null,
    opts: WorkBoardRemovalOptions,
  ): Promise<WorkBoardRemovalResult['plan_doc']> {
    const path = docPathFromDesignRef(design_doc_ref)
    if (path === null || !path.startsWith(`${PLANS_DIR}/`)) return undefined
    const docs = this.deps.docs
    if (docs === undefined) return { path, disposition: 'left_in_place' }

    if (opts.plan_doc === 'delete') {
      // The ONLY code path that may destroy a plan doc — explicit, never implied.
      try {
        await docs.deleteDoc(docs_project_id, path)
        return { path, disposition: 'deleted' }
      } catch (err) {
        this.warnDocFailure('plan_doc_delete_failed', docs_project_id, scope, item_id, path, err)
        return { path, disposition: 'left_in_place' }
      }
    }

    const destDir = `${PLANS_DIR}/${opts.reason}/`
    // Already filed under this disposition (an idempotent re-removal): it IS at
    // the destination, so report that without a redundant rename.
    if (path.startsWith(destDir)) return { path, disposition: 'moved', to: path }
    const to = `${destDir}${basename(path)}`
    try {
      // `moveDoc` mkdir-recursives the destination parent, so `plans/<reason>/`
      // need not exist yet. It refuses to clobber an existing destination
      // (`doc_destination_exists`) — which lands in the catch below, leaving the
      // doc in place rather than destroying either side.
      await docs.moveDoc(docs_project_id, path, to)
      return { path, disposition: 'moved', to }
    } catch (err) {
      this.warnDocFailure('plan_doc_disposition_failed', docs_project_id, scope, item_id, path, err)
      // NEVER fall through to a delete, and never block the row delete.
      return { path, disposition: 'left_in_place' }
    }
  }

  private warnDocFailure(
    event: string,
    docs_project_id: string,
    scope: string,
    item_id: string,
    path: string,
    err: unknown,
  ): void {
    this.log.warn(
      `[work-board] event=${event} project=${docs_project_id} scope=${scope} item=${item_id} path=${path} err=${errText(err)}`,
    )
  }
}

function basename(path: string): string {
  return path.split('/').pop() ?? path
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
