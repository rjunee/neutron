/**
 * @neutronai/trident — production `Substrate` → `TridentDispatch` adapter.
 *
 * This is the FIRST prod-boot wiring of the foundational Trident runner. It
 * bridges the runtime `Substrate` (in production the CC-subprocess persistent-
 * REPL adapter the Open composer builds via `buildLlmCallSubstrate` →
 * `createClaudeCodeSubstrateAuto` — NEVER a direct api.anthropic.com call) onto
 * the foundational Trident `TridentDispatch` contract: run ONE Forge/Argus turn
 * to its terminal text.
 *
 * Before this adapter the Open composer never set `CompositionInput.trident`,
 * so the trident tick loop fell back to `stubAdvanceDeps()` (classify always
 * "running") and `/code <task>` could never dispatch a real build — the
 * `CodegenNotConfiguredError` class of "the production runner is not wired into
 * prod boot". Wiring `composition.trident = { dispatch }` with this adapter is
 * what makes `buildTridentOrchestrator`'s real Forge→Argus→merge step run.
 *
 * Division of labour — this closure does the MINIMUM:
 *   • The orchestrator (`trident/orchestrator.ts`) renders the full execution
 *     prompt into `user_message` and passes the bare kind label ('forge' /
 *     'argus') as `system`; the build agents' contract rides the user turn
 *     (see `trident/prompts.ts`).
 *   • `TridentSessionManager` (`trident/session.ts`) PARSES the terminal text
 *     per phase (Forge contract lines → remaining; Argus verdict → approved).
 *   So the adapter only has to faithfully run `{user_message, model,
 *   timeout_ms}` on the substrate and return the coalesced terminal text + a
 *   terminal status. It declares NO tools (the Forge/Argus subprocess drives
 *   its own built-in tools) and holds NO conversation state of its own.
 *
 * Status mapping (consumed by `TridentSessionManager.runDispatch`, which treats
 * any non-`completed` status as a crashed sub-agent):
 *   `completion` event       → 'completed'
 *   `error` event            → 'failed'
 *   `timeout_ms` elapsed     → 'timed_out'
 *   thrown / start() throws  → 'failed'
 *   stream ends, NO terminal → 'failed' (paused ≠ finished — a turn that closed
 *     `completion`/`error`     its channel WITHOUT a terminal event is NOT a
 *      event was seen          confirmed finish; never a silent success. See the
 *                              FALSE-COMPLETION race note at the return below.)
 *
 * SUBSTRATE RESOLUTION — two shapes, exactly one required:
 *   • `build_substrate(cwd)` — PRODUCTION. A factory called ONCE PER DISPATCH
 *     with the run's worktree (`input.repo_path`) as the cwd. This closes the
 *     two hardening items the first prod-boot wiring PR (#33) deferred:
 *       1. Per-worktree cwd — `AgentSpec` carries no per-call cwd, so the CC
 *          adapter's working dir is fixed at substrate construction. Building a
 *          FRESH substrate per turn with `cwd = input.repo_path` lands each
 *          Forge/Argus turn IN the run's own worktree instead of `owner_home`.
 *       2. Per-build context ISOLATION — a fresh (ephemeral) substrate per turn
 *          means one build never inherits another's working context, and build
 *          turns never bleed into the owner's warm conversational pool.
 *   • `substrate` — a single pre-built instance reused for every dispatch (its
 *     cwd is whatever it was constructed with). Back-compat / test shape; do NOT
 *     use in production for multi-worktree builds (every turn would run in the
 *     one fixed cwd). Retained so the adapter mechanics tests can drive a single
 *     recording substrate.
 */

import type { AgentSpec, Substrate } from '../runtime/substrate.ts'
import type { SessionHandle } from '../runtime/session-handle.ts'
import type {
  TridentDispatch,
  TridentDispatchInput,
  TridentDispatchResult,
} from './session.ts'

export interface BuildSubstrateTridentDispatchOptions {
  /**
   * PRODUCTION substrate factory — built ONCE PER DISPATCH with the run's
   * worktree (`input.repo_path`) as the cwd, so each Forge/Argus turn runs IN
   * the run's own worktree on a fresh (ephemeral) CC-subprocess REPL. Exactly
   * one of `build_substrate` / `substrate` must be supplied; `build_substrate`
   * wins when both are present.
   */
  build_substrate?: (cwd: string) => Substrate
  /**
   * Single pre-built backend reused for every dispatch (back-compat / tests).
   * Its cwd is fixed at construction, so it is NOT suitable for production
   * multi-worktree builds — prefer `build_substrate`.
   */
  substrate?: Substrate
  /**
   * Upper bound on completion tokens per turn. Omitted by default (the adapter
   * lets the substrate apply its own ceiling); set to bound long build turns.
   */
  max_tokens?: number
  /**
   * Timer seam (tests). Defaults to `setTimeout`. Must return a handle the
   * paired `clear_timer` understands.
   */
  set_timer?: (fn: () => void, ms: number) => unknown
  /** Timer-clear seam (tests). Defaults to `clearTimeout`. */
  clear_timer?: (handle: unknown) => void
}

/**
 * Build a production `TridentDispatch` over a runtime `Substrate`. Each call
 * starts one substrate turn, coalesces its `token` events into the terminal
 * text, and resolves with a terminal status (see file header for the mapping).
 */
export function buildSubstrateTridentDispatch(
  opts: BuildSubstrateTridentDispatchOptions,
): TridentDispatch {
  if (opts.build_substrate === undefined && opts.substrate === undefined) {
    throw new Error(
      'buildSubstrateTridentDispatch: exactly one of `build_substrate` (per-worktree, production) or `substrate` (single instance, tests) must be supplied',
    )
  }
  const setTimer =
    opts.set_timer ?? ((fn: () => void, ms: number): unknown => setTimeout(fn, ms))
  const clearTimer =
    opts.clear_timer ??
    ((handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>))

  return async function dispatch(
    input: TridentDispatchInput,
  ): Promise<TridentDispatchResult> {
    const spec: AgentSpec = {
      prompt: input.user_message,
      tools: [],
      model_preference: [input.model],
      ...(opts.max_tokens !== undefined ? { max_tokens: opts.max_tokens } : {}),
    }

    let handle: SessionHandle
    try {
      // PRODUCTION: build a fresh substrate rooted at THIS run's worktree so the
      // turn runs in `input.repo_path`, not the construction-time cwd. Tests may
      // pass a single `substrate` instead. The factory itself throwing (e.g. an
      // empty credential pool) is a crashed sub-agent, same as a start() throw.
      const substrate =
        opts.build_substrate !== undefined
          ? opts.build_substrate(input.repo_path)
          : opts.substrate!
      handle = substrate.start(spec)
    } catch {
      // A substrate that fails to even start the turn is a crashed sub-agent.
      return { result: '', status: 'failed' }
    }

    let text = ''
    let timedOut = false
    let timer: unknown = null
    if (input.timeout_ms > 0) {
      timer = setTimer(() => {
        timedOut = true
        // Propagate cancellation to the substrate; swallow — the loop below
        // resolves the turn regardless of how cancel settles.
        void handle.cancel().catch(() => {})
      }, input.timeout_ms)
    }

    try {
      for await (const ev of handle.events) {
        if (ev.kind === 'token') {
          // `token` is the only coalesce-OK event (runtime/events.ts § 2.2).
          text += ev.text
        } else if (ev.kind === 'completion') {
          return { result: text, status: 'completed' }
        } else if (ev.kind === 'error') {
          void handle.cancel().catch(() => {})
          return { result: text, status: 'failed' }
        }
        // thinking / status / tool_* events carry no terminal text for a
        // Trident build agent — ignored.
      }
    } catch {
      // Iterator threw (cancellation or transport error). A timeout that
      // cancelled the stream surfaces as 'timed_out'; anything else as failed.
      return { result: text, status: timedOut ? 'timed_out' : 'failed' }
    } finally {
      if (timer !== null) clearTimer(timer)
    }

    // Stream ended WITHOUT a terminal `completion` event. The persistent-REPL
    // substrate ALWAYS settles a real turn with a `completion` (success) or an
    // `error` (death) event before closing its channel — see
    // persistent-repl-substrate `onReply` (token + completion + close) and
    // `onDeath` (error + close). So reaching here means the channel closed with
    // NO terminal signal: a paused / abnormally-closed turn, NOT a confirmed
    // finish.
    //
    // FALSE-COMPLETION race (Vajra fleet-premature-completion reconciliation,
    // incidents 2026-06-23 "paused ≠ finished" #160 + cross-model-review wedge
    // #164): classifying this clean-but-terminal-less end as `completed` would
    // silently advance the build as if it succeeded — the exact failure mode
    // where a forge-fix/ralph-task turn that yielded mid-work (e.g. a Stop hook
    // held the turn, or it ended a turn to await an out-of-band review that
    // never resumes it) is mistaken for a finished one. Report `timed_out` if
    // the timeout tripped, else `failed`. The session manager treats any
    // non-`completed` status as a crashed sub-agent, so the run is recovered or
    // failed LOUDLY rather than falsely reported done. (forge-init was already
    // caught downstream by the no-contract-lines check; this closes the
    // forge-fix / ralph-task gap too.)
    return { result: text, status: timedOut ? 'timed_out' : 'failed' }
  }
}
