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
import { drainToOutcome } from '@neutronai/runtime/substrate-text.ts'
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

    let timedOut = false
    let timer: unknown = null
    if (input.timeout_ms > 0) {
      timer = setTimer(() => {
        timedOut = true
        void handle.cancel().catch(() => {})
      }, input.timeout_ms)
    }

    // O8 — the drain loop is now the ONE `drainToOutcome` (capture mode: a
    // substrate error/abort is RETURNED as a status, not thrown, so we map it onto
    // this runner's terminal `DispatchTurnResult`). `signal` (a `/dispatch stop`
    // or watchdog reap) drives the abort; `keepAliveExempt` preserves this
    // runner's fix for "stop didn't stop" — a fired signal calls `handle.cancel()`
    // to actually terminate the subprocess. The wall-clock timeout stays a LOCAL
    // timer (it cancels the handle), and `timedOut` still wins over a generic
    // failure exactly as before.
    let outcome
    try {
      outcome = await drainToOutcome(handle, {
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
        treatErrorAs: 'capture',
        keepAliveExempt: true,
      })
    } finally {
      if (timer !== null) clearTimer(timer)
    }

    if (outcome.status === 'completed') return { result: outcome.text, status: 'completed' }
    // Precedence — abort (a real `/dispatch stop`) wins, then the wall-clock
    // timeout, then any other non-success terminal (error event / paused stream
    // that closed without a completion; paused ≠ finished → failed).
    if (outcome.status === 'aborted') return { result: outcome.text, status: 'cancelled' }
    if (timedOut) return { result: outcome.text, status: 'timed_out' }
    return { result: outcome.text, status: 'failed' }
  }
}
