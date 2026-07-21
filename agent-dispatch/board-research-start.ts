/**
 * @neutronai/agent-dispatch — the ▶ RESEARCH starter (Work Board #379).
 *
 * The Work Board play button routes BY TASK TYPE: a 'build' card fires an
 * autonomous Trident run; a 'research' card fires an Atlas research/analysis
 * agent through the general `DispatchService`. This factory is the RESEARCH half
 * — extracted from the composer so the real ▶-research completion wiring (route →
 * dispatch, deliver the result to chat, mark the card terminal on success AND
 * failure) is unit-testable without booting the whole graph.
 *
 * What it guarantees (the #379 research LIFECYCLE):
 *   - ROUTE: dispatches `kind: 'research'` bound to the card (never Trident).
 *   - GUARD: a per-card `spawn_key` (+ `on_duplicate: 'coalesce'`) so a
 *     concurrent / double-▶ coalesces onto the in-flight run — no duplicate Atlas
 *     run. (The HTTP surface's `already_running` 409 is the first line of
 *     defence; this is the second.)
 *   - ASK-BEFORE-ACTING: an underspecified card is rejected at the dispatch
 *     chokepoint (`DispatchValidationError` code `underspecified`); we post a
 *     short clarifying question to the CHAT and leave the card pending, never
 *     surfacing the raw guard text.
 *   - TERMINAL: on completion (success OR crash/cancel/timeout) mark the card
 *     terminal — `done` on `finished`, else `failed` — so the desktop pane
 *     auto-closes and the card is NEVER stranded in_progress. The dispatch's own
 *     terminal reconcile already cleared `linked_run_id` (clearRun), so setting
 *     the status here (with the run's outcome as the fail-guard) cannot strand it.
 *   - DELIVER: the Atlas result is delivered back to the ORIGINATING chat through
 *     the durable app-ws poster (persisted → renders in React), not a raw
 *     ephemeral registry send.
 */

import { DispatchValidationError } from './service.ts'
import type { DispatchHandle, DispatchRequest } from './service.ts'

/** Result shape shared with the HTTP surface's `WorkBoardStartResult`. */
export type BoardResearchStartResult =
  | { ok: true; run_id: string }
  | {
      ok: false
      code: 'missing_board_item' | 'unknown_board_item' | 'underspecified' | 'backend_error'
      message: string
    }

/** The minimal card slice the starter needs (id + spec inputs). */
export interface BoardResearchItem {
  id: string
  title: string
  design_doc_ref: string | null
}

export interface BoardResearchStarterDeps {
  /** `DispatchService.dispatch` (bound). Throws `DispatchValidationError` on a
   *  missing/unknown/underspecified board item. */
  dispatch: (req: DispatchRequest) => Promise<DispatchHandle>
  /** Resolve the research task text for a card (its plans/ doc, else its title). */
  resolveTask: (scope: string, item: BoardResearchItem) => Promise<string>
  /** Mark the card terminal (`done` | `failed`) + clear the inline marker. */
  markCardTerminal: (scope: string, id: string, status: 'done' | 'failed') => Promise<void>
  /** Deliver text to the originating chat (durable → renders in React). */
  deliver: (chatId: string, text: string) => void
  /** Map a board scope → its originating app-ws chat topic id. */
  chatIdForScope: (scope: string) => string
  /**
   * Schedule the (fire-and-forget) terminal handling. Defaults to attaching a
   * bare `.catch`. Tests inject a collector so the terminal path can be awaited
   * deterministically.
   */
  schedule?: (work: Promise<unknown>) => void
  /** Optional structured warn for a terminal-handling failure. */
  onError?: (err: unknown) => void
}

/**
 * Build the `start_research` closure for the Work Board surface. Returns a
 * `(scope, item) => Promise<BoardResearchStartResult>` that dispatches the Atlas
 * research run and wires its terminal lifecycle.
 */
export function createBoardResearchStarter(
  deps: BoardResearchStarterDeps,
): (scope: string, item: BoardResearchItem) => Promise<BoardResearchStartResult> {
  const schedule = deps.schedule ?? ((work: Promise<unknown>) => void work.catch(() => {}))

  return async (scope, item) => {
    const chatId = deps.chatIdForScope(scope)
    const task = await deps.resolveTask(scope, item)

    let handle: DispatchHandle
    try {
      handle = await deps.dispatch({
        kind: 'research',
        task,
        board_item_id: item.id,
        board_scope: scope,
        delivery_target: { channel: 'app_socket', binding_id: chatId },
        // Coalesce a concurrent / double-▶ onto the live run — no twin Atlas run.
        spawn_key: `wb-research:${scope}:${item.id}`,
        on_duplicate: 'coalesce',
      })
    } catch (err) {
      if (err instanceof DispatchValidationError) {
        if (err.code === 'underspecified') {
          // Post a short clarifying question to the CHAT (not the raw guard text
          // into the work pane) and leave the card pending — #337, research-flavoured.
          deps.deliver(
            chatId,
            `🔎 "${item.title}" needs a bit more detail before I can research it — ` +
              `what specifically should I find out, and any sources or constraints? ` +
              `Add that (or link a design doc) and hit ▶ again.`,
          )
          return { ok: false, code: 'underspecified', message: err.message }
        }
        const code = err.code === 'missing_board_item' ? 'missing_board_item' : 'unknown_board_item'
        return { ok: false, code, message: err.message }
      }
      return {
        ok: false,
        code: 'backend_error',
        message: err instanceof Error ? err.message : String(err),
      }
    }

    // Terminal reconcile + delivery — fire-and-forget; the ▶ returns as soon as
    // the run is dispatched, the result arrives later.
    schedule(
      handle.completion
        .then(async (outcome) => {
          const ok = outcome.status === 'finished'
          try {
            await deps.markCardTerminal(scope, item.id, ok ? 'done' : 'failed')
          } catch {
            // a board write outage never breaks delivery
          }
          const result = typeof outcome.result === 'string' ? outcome.result.trim() : ''
          const body = ok
            ? result.length > 0
              ? result
              : `🔎 Research "${item.title}" finished (no summary returned).`
            : `🔎 Research "${item.title}" didn't finish (${outcome.status}).`
          deps.deliver(chatId, body)
        })
        .catch((err: unknown) => {
          deps.onError?.(err)
        }),
    )

    return { ok: true, run_id: handle.run_id }
  }
}
