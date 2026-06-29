/**
 * @neutronai/trident — the inner-loop launcher (Trident v2).
 *
 * Phase 2 hard cutover: the inner Forge→Argus→fix loop is now ONE native CC
 * Dynamic Workflow (`trident/inner-workflow.mjs`). This module is the durable
 * OUTER loop's bridge to it: `buildWorkflowInnerLoop(...)` returns a
 * `TridentInnerLoop` that, per call, runs the inner-workflow to a TERMINAL
 * result and reports it back as one `InnerLoopResult`.
 *
 * ── INVOCATION MODEL (the 2026-06-29 BILLING fix) ────────────────────────────
 * The launcher is ONE turn on the persistent INTERACTIVE-REPL substrate — NOT a
 * `claude -p` (print-mode) subprocess. There is no `claude -p` / `--print`
 * anywhere in the trident inner loop.
 *
 * WHY (billing): `claude -p` is API-BILLED (a separate capped credit at API
 * rates since 2026-06-15), NOT covered by the Max subscription — even with an
 * OAuth token set. The billing-EXEMPT boundary is INVOCATION MODE: only an
 * INTERACTIVE PTY/REPL session draws on the Max subscription, which is why the
 * whole Neutron substrate is persistent interactive REPLs. So the inner launcher
 * MUST run on the same interactive substrate the rest of Neutron uses for
 * billing-exempt LLM work (`buildLlmCallSubstrate` → `createClaudeCodeSubstrateAuto`
 * → the persistent dev-channel REPL), NEVER a `-p` one-shot.
 *
 * THE DRAIN PROBLEM (and how the interactive path solves it): the CC `Workflow`
 * tool is BACKGROUND. Invoking it returns a runId IMMEDIATELY; the run completes
 * later. The persistent-REPL substrate settles a turn on the FIRST dev-channel
 * `reply()` — so a naive launcher turn that replies straight after invoking
 * `Workflow` settles in ~30s, ENDING the launcher's only turn before Argus /
 * synthesis / checkpoints / cleanup run; the launcher then reports an incomplete
 * (or empty) result and, on the prior EPHEMERAL substrate, the REPL was disposed
 * right after settle, hard-ABORTING the still-running workflow (the original
 * real-run bug). The fix is option (b): the launcher holds its ONE interactive
 * turn OPEN — after invoking `Workflow` it POLLS the background run to terminal
 * (the `Task*`/`Monitor` tools + `sleep` cadence) and only emits its single
 * `reply()` (carrying `TRIDENT_RESULT=`) once the run has fully finished. The
 * held-open turn keeps the launcher driving the run until it drains to completion
 * — the interactive analogue of print-mode's process-lifetime drain — WITHOUT any
 * `claude -p`.
 *
 * WHICH SUBSTRATE — a WARM, POOLED, NON-EPHEMERAL interactive `cc-trident-*` REPL
 * on the SAME credential pool and (owner, project) dimensions as this project's
 * chat session, REUSED across runs (it just can't be chat's exact child: chat's
 * restricted `--tools` surface omits `Workflow`, and the substrate's tool-surface
 * reuse guard would evict+respawn chat's child if the unrestricted launcher landed
 * on its key — see open/composer.ts). Non-ephemeral is load-bearing: a warm child
 * SURVIVES turn-settle, so an early/abnormal settle no longer disposes the REPL
 * mid-build (the #102 disposal class). The substrate is supplied via an injectable
 * `build_substrate(cwd)` factory (production: that warm trident REPL, built with
 * the FULL built-in tool surface incl. `Workflow`, a raised `turnTimeoutMs`
 * spanning the whole inner loop, and auto-mode dontAsk + allowlist + deny-guard).
 * The launcher seam (`LaunchInnerWorkflow`) is unchanged in shape, so
 * `buildWorkflowInnerLoop` and the durable OUTER loop are untouched; production
 * wires `buildSubstrateInnerLauncher`. Tests inject a fake `launch` / `Substrate`
 * and never touch a live `claude`.
 *
 * FALSE-COMPLETION discipline (paused ≠ finished; Vajra fleet-premature-
 * completion reconciliation #160/#164) is preserved: a launcher is `completed`
 * ONLY when the turn settles with a `completion` event AND its reply carries a
 * parseable `TRIDENT_RESULT=<json>` line. A timeout → `timed_out`; a substrate
 * `error`, a start() throw, or a settled turn with no result line → `failed`.
 * Never a silent success.
 */

import type { AgentSpec, Substrate } from '../runtime/substrate.ts'
import type { SessionHandle } from '../runtime/session-handle.ts'
import { assertAutoModeModelFloor } from './auto-mode.ts'
import type { TridentRun } from './store.ts'

export interface InnerLoopInput {
  run: TridentRun
  base_branch: string
  /** Absolute sqlite file path the workflow's checkpoint Bash steps write to. */
  db_path: string
  max_rounds: number
  /** Last persisted `inner_checkpoint` (idempotent crash-resume), or null. */
  resume_checkpoint?: string | null
}

export interface InnerLoopResult {
  /** `completed` = the launcher process exited cleanly and a result line parsed;
   *  `failed` = spawn error / nonzero exit / no parseable result; `timed_out` =
   *  wall-clock budget elapsed (the child was SIGKILLed). */
  status: 'completed' | 'failed' | 'timed_out'
  verdict: 'APPROVE' | 'REQUEST_CHANGES' | null
  pr_number: number | null
  branch: string | null
  round: number
  checkpoint: string | null
  /** The launcher process's captured stdout (audit / debugging). */
  raw: string
}

export type TridentInnerLoop = (input: InnerLoopInput) => Promise<InnerLoopResult>

/** Input to one interactive-substrate launcher invocation. */
export interface LaunchInnerWorkflowInput {
  /** The launcher user message (the interactive turn's prompt). */
  prompt: string
  /** Working directory for the launcher REPL — the run's repo/worktree root. */
  cwd: string
  /** Wall-clock budget; the launcher cancels the turn when it elapses. */
  timeout_ms: number
}

/**
 * The terminal outcome of one launcher invocation. Field names are retained from
 * the prior print-mode seam so `buildWorkflowInnerLoop` is unchanged: for the
 * interactive substrate, `stdout` carries the turn's coalesced reply text (where
 * the model's `TRIDENT_RESULT=` line lands) and `exit_code` is `0` on a clean
 * `completion` event / `null` otherwise.
 */
export interface LaunchInnerWorkflowResult {
  /** The turn's coalesced reply text (where the model's `TRIDENT_RESULT=` lands). */
  stdout: string
  /** Diagnostic detail (a substrate `error` message), audit only. */
  stderr: string
  /** `0` iff the turn settled with a `completion` event; `null` otherwise. */
  exit_code: number | null
  /** True iff the wall-clock budget elapsed and the turn was cancelled. */
  timed_out: boolean
  /** Non-null iff the turn failed to start / errored / settled with no terminal
   *  completion (paused ≠ finished). */
  spawn_error: string | null
}

/**
 * The launcher seam. Production = `buildSubstrateInnerLauncher` (one interactive
 * substrate turn). Tests inject a fake. It MUST resolve only AFTER the turn has
 * fully settled (i.e. after the launcher polled the background Workflow to
 * terminal and replied) — never early.
 */
export type LaunchInnerWorkflow = (
  input: LaunchInnerWorkflowInput,
) => Promise<LaunchInnerWorkflowResult>

export interface BuildWorkflowInnerLoopOptions {
  /**
   * PRODUCTION launcher — one interactive-substrate turn that drains the
   * inner-workflow to a terminal result. Build it with
   * `buildSubstrateInnerLauncher`. Tests inject a fake `LaunchInnerWorkflow`.
   */
  launch: LaunchInnerWorkflow
  /** Absolute path to the inner-workflow script. Defaults to the sibling
   *  `inner-workflow.mjs` resolved via `import.meta.url`. */
  workflow_script_path?: string
  /** Wall-clock budget for the whole inner loop. Default 2 h. */
  timeout_ms?: number
}

/** Wall-clock budget for the whole inner loop (the launcher turn + its drained
 *  background Workflow). The trident substrate's `turnTimeoutMs` is aligned to
 *  this so the substrate never times the held-open turn out before the loop. */
export const DEFAULT_INNER_LOOP_TIMEOUT_MS = 2 * 60 * 60_000
const DEFAULT_TIMEOUT_MS = DEFAULT_INNER_LOOP_TIMEOUT_MS

/** The default abs path of the sibling inner-workflow script. */
export const DEFAULT_INNER_WORKFLOW_PATH = new URL('./inner-workflow.mjs', import.meta.url).pathname

/**
 * Build the args object the launcher passes to the `Workflow` tool. Mirrors the
 * `inner-workflow.mjs` `args` destructure exactly.
 */
function buildWorkflowArgs(input: InnerLoopInput): Record<string, unknown> {
  const run = input.run
  return {
    repoPath: run.repo_path,
    task: run.task,
    baseBranch: input.base_branch,
    slug: run.slug,
    maxRounds: input.max_rounds,
    ralph: run.ralph,
    // Thread the run's git-mode so the workflow's Forge prompt matches it: a
    // `local` run (no GitHub origin / no `gh`) must NOT be told to push to
    // origin + `gh pr create` (that would fail Forge); it commits on the branch
    // and the OUTER loop's `mergeLocal` takes it from there.
    mergeMode: run.merge_mode,
    prNumber: run.pr,
    branch: run.branch,
    dbPath: input.db_path,
    runId: run.id,
    resumeCheckpoint: input.resume_checkpoint ?? null,
  }
}

/**
 * The launcher's user message for the INTERACTIVE substrate turn. The launcher
 * invokes the `Workflow` tool, then HOLDS THE TURN OPEN — polling the background
 * run to terminal — and only at the very end emits its single `reply()` carrying
 * the `TRIDENT_RESULT=<compact JSON>` line.
 *
 * Why the held-open turn matters: the substrate settles this turn the instant the
 * launcher calls `reply()`, ENDING the launcher's only turn — after which it can
 * no longer poll the background run to terminal, so it would report an INCOMPLETE
 * (or empty) result before Argus / synthesis / checkpoints run. So the cardinal
 * rule is: do NOT reply until the Workflow has fully finished. Holding the turn
 * open (by polling) keeps the launcher driving the run until it drains — the
 * interactive analogue of the old print-mode drain, with no `claude -p` and no API
 * billing. (The warm `cc-trident-*` REPL is non-ephemeral, so an early settle no
 * longer hard-disposes the process — but a premature reply still loses the result,
 * so the rule stands.)
 */
export function buildLauncherMessage(scriptPath: string, input: InnerLoopInput): string {
  const argsJson = JSON.stringify(buildWorkflowArgs(input))
  return `You are the trident-v2 inner-loop LAUNCHER, running as ONE unattended interactive session turn. NEVER ask for input; on any blocker, finish with the result line below carrying a REQUEST_CHANGES verdict rather than hanging.

⚠️ CARDINAL RULE — DO NOT call the dev-channel \`reply()\` tool until the Workflow has FULLY FINISHED. Calling \`reply()\` ENDS this turn; once the turn ends you can no longer observe the background Workflow, so its result (Argus review, PR, checkpoints) is LOST — you'd report an incomplete run. Hold this turn OPEN by polling (step 2) until the run is terminal, THEN reply exactly once (step 3).

Do EXACTLY this, nothing else:
1. Invoke the \`Workflow\` tool with:
   scriptPath = ${scriptPath}
   args = ${argsJson}
   Pass \`args\` as a STRUCTURED JSON OBJECT (the parsed value), NOT as a JSON-encoded string — a stringified value reaches the workflow as one string and breaks every \`args.*\` field.
   The tool returns a runId IMMEDIATELY and runs in the BACKGROUND. It drives Forge build → parallel Argus review → synthesis → bounded fix loop and RETURNS an object like {ok, prNumber, branch, verdict, round, checkpoint}.
2. POLL the background run to terminal WITHOUT ending the turn. Do NOT reply yet. Repeatedly check the run with the task tools — \`TaskList\`, then \`TaskGet <runId>\` / \`TaskOutput <runId>\` — pausing about 30s between checks with \`sleep 30\` (Bash). Keep polling until the run has FINISHED and you can read its returned object. (Equivalently you may use a \`Monitor\` until-loop.) Never end the turn while the run is still in progress.
3. ONLY after the run has fully finished, call \`reply()\` EXACTLY ONCE. The reply body's FINAL line MUST be, unfenced, with NO trailing text after it:
   TRIDENT_RESULT=<the workflow's returned object as compact one-line JSON>

The TRIDENT_RESULT= line MUST be the very last line of your reply.`
}

/**
 * Parse the `TRIDENT_RESULT=<json>` line, walking from the END of the captured
 * stdout so trailing preamble can't shadow it. Returns null when no parseable
 * result line is present.
 */
export function parseTridentResult(raw: string): {
  ok?: boolean
  prNumber?: number | null
  branch?: string | null
  verdict?: string | null
  round?: number
  checkpoint?: string | null
} | null {
  const lines = raw.split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = (lines[i] ?? '').trim()
    if (!line.startsWith('TRIDENT_RESULT=')) continue
    const json = line.slice('TRIDENT_RESULT='.length).trim()
    try {
      const parsed = JSON.parse(json)
      if (parsed !== null && typeof parsed === 'object') return parsed as Record<string, unknown>
    } catch {
      // keep walking — a malformed line earlier could be shadowed by a good one
    }
  }
  return null
}

function normalizeVerdict(v: unknown): 'APPROVE' | 'REQUEST_CHANGES' | null {
  if (v === 'APPROVE') return 'APPROVE'
  if (v === 'REQUEST_CHANGES') return 'REQUEST_CHANGES'
  return null
}

const FAILED = (raw: string): InnerLoopResult => ({
  status: 'failed',
  verdict: null,
  pr_number: null,
  branch: null,
  round: 0,
  checkpoint: null,
  raw,
})

// ── Production interactive-substrate launcher ─────────────────────────────────

export interface SubstrateInnerLauncherOptions {
  /**
   * PRODUCTION substrate factory — the billing-EXEMPT persistent interactive REPL
   * (`buildLlmCallSubstrate` → `createClaudeCodeSubstrateAuto`). Resolves a WARM,
   * POOLED, NON-EPHEMERAL `cc-trident-*` REPL keyed on the SAME (owner, project,
   * credential) dimensions as chat (a SIBLING of the `cc-agent-*` chat pool, not
   * its exact child — chat's restricted surface can't host `Workflow`). The
   * passed `cwd` is the STABLE repo root, so the warm child a later run reuses is
   * never sitting in a removed worktree. Production wires the trident substrate
   * with the FULL built-in tool surface (so `Workflow` + the `Task*`/`Monitor`
   * poll tools are present), a `turnTimeoutMs` spanning the whole inner loop, and
   * auto-mode dontAsk + allowlist + deny-guard. Tests inject a fake `Substrate`.
   */
  build_substrate: (cwd: string) => Substrate
  /**
   * `--model` value, threaded as `spec.model_preference[0]` AND checked against
   * the auto-mode floor. Default `opus` (current top-tier alias). The workflow's
   * `agent()` workers inherit it.
   */
  model?: string
  /**
   * Auto-mode model-floor guard. Default `assertAutoModeModelFloor` — a
   * positively-below-floor model (auto mode wants Opus 4.6+/Sonnet 4.6+) fails the
   * launch LOUDLY (no turn, no silent bad run). Tests inject a no-op.
   */
  assert_model_floor?: (model: string) => void
  /** Upper bound on completion tokens for the turn. Omitted → substrate ceiling. */
  max_tokens?: number
  /** Timer seam (tests). Defaults to `setTimeout`. */
  set_timer?: (fn: () => void, ms: number) => unknown
  /** Timer-clear seam (tests). Defaults to `clearTimeout`. */
  clear_timer?: (handle: unknown) => void
}

/**
 * Production `LaunchInnerWorkflow`: run ONE turn on the interactive substrate and
 * resolve ONLY when the turn has fully settled — by which point the launcher has
 * (per `buildLauncherMessage`) held its turn open, polled the background Workflow
 * to terminal, and replied with `TRIDENT_RESULT=`. This is the billing-EXEMPT
 * path: the invocation is an interactive REPL turn, NOT a `claude -p` subprocess.
 *
 * Mirrors the proven billing-exempt substrate event loop in
 * `trident/substrate-dispatch.ts`: coalesce `token` events into the reply text,
 * map `completion` → success (`exit_code: 0`), `error` → failure, the wall-clock
 * timer → `timed_out` (cancelling the turn), and a stream that ends with NO
 * terminal `completion` → failure (paused ≠ finished — never a silent success).
 * Never rejects.
 */
export function buildSubstrateInnerLauncher(
  opts: SubstrateInnerLauncherOptions,
): LaunchInnerWorkflow {
  const model = opts.model ?? 'opus'
  const assertFloor = opts.assert_model_floor ?? assertAutoModeModelFloor
  const setTimer =
    opts.set_timer ?? ((fn: () => void, ms: number): unknown => setTimeout(fn, ms))
  const clearTimer =
    opts.clear_timer ??
    ((handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>))

  return function launch(input: LaunchInnerWorkflowInput): Promise<LaunchInnerWorkflowResult> {
    return new Promise<LaunchInnerWorkflowResult>((resolve) => {
      void (async (): Promise<void> => {
        // Auto-mode model floor (Opus 4.6+/Sonnet 4.6+). A positively-below-floor
        // model fails the launch LOUDLY (no turn, no silent bad run).
        try {
          assertFloor(model)
        } catch (e) {
          resolve({
            stdout: '',
            stderr: '',
            exit_code: null,
            timed_out: false,
            spawn_error: e instanceof Error ? e.message : String(e),
          })
          return
        }

        const spec: AgentSpec = {
          prompt: input.prompt,
          tools: [],
          model_preference: [model],
          ...(opts.max_tokens !== undefined ? { max_tokens: opts.max_tokens } : {}),
        }

        let handle: SessionHandle
        try {
          // Build a fresh substrate rooted at THIS run's worktree so the turn runs
          // in `input.cwd`. A factory throw (e.g. an empty credential pool) is a
          // crashed launcher — surface it as a spawn_error, never a silent success.
          handle = opts.build_substrate(input.cwd).start(spec)
        } catch (e) {
          resolve({
            stdout: '',
            stderr: '',
            exit_code: null,
            timed_out: false,
            spawn_error: `substrate start failed: ${e instanceof Error ? e.message : String(e)}`,
          })
          return
        }

        let text = ''
        let timedOut = false
        let settled = false
        const finish = (r: LaunchInnerWorkflowResult): void => {
          if (settled) return
          settled = true
          clearTimer(timer)
          resolve(r)
        }
        const timer = setTimer(() => {
          timedOut = true
          // Cancel the turn — actually terminate the REPL turn so the held-open
          // launcher can't keep the budget burning past the wall-clock cap.
          void handle.cancel().catch(() => {})
          finish({ stdout: text, stderr: '', exit_code: null, timed_out: true, spawn_error: null })
        }, input.timeout_ms)
        // Don't let the turn timer keep the event loop alive on its own.
        ;(timer as { unref?: () => void })?.unref?.()

        try {
          for await (const ev of handle.events) {
            if (ev.kind === 'token') {
              // The only coalesce-OK event — the launcher's reply text.
              text += ev.text
            } else if (ev.kind === 'completion') {
              finish({ stdout: text, stderr: '', exit_code: 0, timed_out: false, spawn_error: null })
              return
            } else if (ev.kind === 'error') {
              void handle.cancel().catch(() => {})
              finish({
                stdout: text,
                stderr: ev.message,
                exit_code: null,
                timed_out: timedOut,
                spawn_error: `substrate error: ${ev.message}`,
              })
              return
            }
            // thinking / status / tool_* carry no terminal text — ignored.
          }
        } catch (e) {
          // Iterator threw (cancellation or transport error). A timeout that
          // cancelled the stream is `timed_out`; anything else is a failure.
          finish({
            stdout: text,
            stderr: e instanceof Error ? e.message : String(e),
            exit_code: null,
            timed_out: timedOut,
            spawn_error: timedOut ? null : `substrate turn threw: ${e instanceof Error ? e.message : String(e)}`,
          })
          return
        }

        // Stream ended WITHOUT a terminal `completion` event. The persistent-REPL
        // substrate ALWAYS settles a real turn with `completion`/`error` before
        // closing — so a clean-but-terminal-less end is a paused / abnormally-closed
        // turn, NOT a confirmed finish (paused ≠ finished, #160/#164). Fail loudly.
        finish({
          stdout: text,
          stderr: '',
          exit_code: null,
          timed_out: timedOut,
          spawn_error: timedOut ? null : 'substrate turn ended without a terminal completion event',
        })
      })()
    })
  }
}

/**
 * Build a production `TridentInnerLoop`. Each call runs ONE interactive-substrate
 * launcher turn that drives the inner-workflow to a terminal result, then resolves
 * a parsed `InnerLoopResult` under the false-completion discipline.
 */
export function buildWorkflowInnerLoop(opts: BuildWorkflowInnerLoopOptions): TridentInnerLoop {
  const scriptPath = opts.workflow_script_path ?? DEFAULT_INNER_WORKFLOW_PATH
  const timeoutMs = opts.timeout_ms ?? DEFAULT_TIMEOUT_MS

  return async function innerLoop(input: InnerLoopInput): Promise<InnerLoopResult> {
    // STABLE cwd = the repo root, NOT the per-run worktree. The launcher runs on a
    // WARM, POOLED `cc-trident-*` REPL that is reused across runs; a warm child
    // keeps its spawn cwd, and the pool key does not include cwd — so handing a
    // per-run worktree path would leave a later run's reused child sitting in a
    // worktree the prior run already removed. The launcher itself only invokes the
    // `Workflow` tool (absolute scriptPath + absolute repoPath in args) and polls;
    // the Forge agent makes its OWN isolated worktree (`isolation:'worktree'`,
    // resolved from the repo at this cwd), so the repo root is the correct, stable,
    // always-present working dir.
    const cwd = input.run.repo_path
    const prompt = buildLauncherMessage(scriptPath, input)

    let res: LaunchInnerWorkflowResult
    try {
      res = await opts.launch({ prompt, cwd, timeout_ms: timeoutMs })
    } catch (e) {
      // A launch seam that REJECTS (rather than resolving a spawn_error) is a
      // crashed launcher — fail loudly, never silently advance.
      return FAILED(e instanceof Error ? e.message : String(e))
    }

    if (res.timed_out) return { ...FAILED(res.stdout), status: 'timed_out' }
    if (res.spawn_error !== null) return FAILED(res.stdout)
    // The turn settling with a `completion` event (`exit_code: 0`) — after the
    // launcher held its turn open, drained the background Workflow to completion,
    // and replied — is the terminal signal. Anything else is a crashed launcher;
    // paused ≠ finished, so it is a FAILURE, never a silent success.
    if (res.exit_code !== 0) return FAILED(res.stdout)

    return finalize(res.stdout, 'completed')
  }

  function finalize(raw: string, status: 'completed'): InnerLoopResult {
    const parsed = parseTridentResult(raw)
    if (parsed === null) {
      // A settled turn whose reply carried no parseable result line is a FAILURE
      // (no silent success): the workflow result is unknown — this is exactly the
      // pre-fix symptom (turn settled before TRIDENT_RESULT existed).
      return FAILED(raw)
    }
    return {
      status,
      verdict: normalizeVerdict(parsed.verdict),
      pr_number:
        typeof parsed.prNumber === 'number' && Number.isFinite(parsed.prNumber)
          ? parsed.prNumber
          : null,
      branch: typeof parsed.branch === 'string' ? parsed.branch : null,
      round: typeof parsed.round === 'number' && Number.isFinite(parsed.round) ? parsed.round : 0,
      checkpoint: typeof parsed.checkpoint === 'string' ? parsed.checkpoint : null,
      raw,
    }
  }
}
