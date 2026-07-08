/**
 * @neutronai/agent-dispatch — cancellable substrate-turn runner.
 *
 * The production `DispatchTurn` for the dispatch service. It mirrors
 * `trident/substrate-dispatch.ts:buildSubstrateTridentDispatch` (build a FRESH
 * ephemeral CC-subprocess substrate per turn, rooted at `repo_path`; coalesce
 * `token` events into the terminal text; map `completion`/`error`/timeout onto
 * a terminal status) but adds the one thing the Trident closure lacks and that
 * a general dispatcher needs: HONORING AN ABORT SIGNAL.
 *
 * Why a dedicated runner instead of reusing `buildSubstrateTridentDispatch`:
 * the Trident closure owns its `SessionHandle` internally and only cancels it
 * on its own wall-clock timeout — there is no external cancel channel. So a
 * `/dispatch stop` (or a watchdog reap) could mark the registry terminal while
 * the spawned `claude` kept running + editing files until it finished on its
 * own. This runner takes `input.signal`: on abort it calls `handle.cancel()`,
 * actually terminating the subprocess, and returns `status: 'cancelled'`. The
 * substrate spawn rule is unchanged — it still goes through the injected
 * `build_substrate` factory (the CC-subprocess REPL), NEVER a direct
 * api.anthropic.com call.
 */

import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { AgentSpec, Substrate } from '@neutronai/runtime/substrate.ts'
import type { DispatchTurn, DispatchTurnResult } from './service.ts'

export interface CancellableDispatchTurnOptions {
  /**
   * PRODUCTION substrate factory — called ONCE PER TURN with the dispatch's
   * working dir (`input.repo_path`) as the cwd, so each agent runs on a fresh
   * ephemeral REPL rooted there (the same per-call factory shape the Trident
   * loop uses).
   */
  build_substrate: (cwd: string) => Substrate
  /** Upper bound on completion tokens per turn. Omitted → the substrate's own ceiling. */
  max_tokens?: number
  /** Timer seam (tests). Defaults to `setTimeout`. */
  set_timer?: (fn: () => void, ms: number) => unknown
  /** Timer-clear seam (tests). Defaults to `clearTimeout`. */
  clear_timer?: (handle: unknown) => void
}

/** Build a cancellable `DispatchTurn` over a per-cwd substrate factory. */
export function buildCancellableDispatchTurn(
  opts: CancellableDispatchTurnOptions,
): DispatchTurn {
  const setTimer =
    opts.set_timer ?? ((fn: () => void, ms: number): unknown => setTimeout(fn, ms))
  const clearTimer =
    opts.clear_timer ??
    ((handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>))

  return async (input): Promise<DispatchTurnResult> => {
    const spec: AgentSpec = {
      prompt: input.user_message,
      tools: [],
      model_preference: [input.model],
      ...(opts.max_tokens !== undefined ? { max_tokens: opts.max_tokens } : {}),
    }

    let handle: SessionHandle
    try {
      handle = opts.build_substrate(input.repo_path).start(spec)
    } catch {
      // A substrate that can't even start (e.g. empty credential pool) is a
      // crashed dispatch — same as a start() throw in the Trident closure.
      return { result: '', status: 'failed' }
    }

    let text = ''
    let timedOut = false
    let aborted = false
    let timer: unknown = null
    if (input.timeout_ms > 0) {
      timer = setTimer(() => {
        timedOut = true
        void handle.cancel().catch(() => {})
      }, input.timeout_ms)
    }

    const onAbort = (): void => {
      aborted = true
      // Actually terminate the subprocess — this is the fix for "stop didn't stop".
      void handle.cancel().catch(() => {})
    }
    const signal = input.signal
    if (signal !== undefined) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }

    try {
      for await (const ev of handle.events) {
        if (ev.kind === 'token') {
          text += ev.text
        } else if (ev.kind === 'completion') {
          return { result: text, status: 'completed' }
        } else if (ev.kind === 'error') {
          void handle.cancel().catch(() => {})
          return { result: text, status: 'failed' }
        }
        // thinking / status / tool_* carry no terminal text — ignored.
      }
    } catch {
      // Iterator threw (cancellation or transport error). Abort wins over
      // timeout wins over a generic failure.
      return { result: text, status: aborted ? 'cancelled' : timedOut ? 'timed_out' : 'failed' }
    } finally {
      if (timer !== null) clearTimer(timer)
      if (signal !== undefined) signal.removeEventListener('abort', onAbort)
    }

    // Stream ended WITHOUT a terminal `completion` — paused ≠ finished (the
    // persistent-REPL substrate always settles a real turn with completion/error
    // before closing). Report the most specific non-success terminal.
    return { result: text, status: aborted ? 'cancelled' : timedOut ? 'timed_out' : 'failed' }
  }
}
