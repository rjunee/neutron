/**
 * @neutronai/trident — the inner-loop launcher (Trident v2).
 *
 * Phase 2 hard cutover: the inner Forge→Argus→fix loop is now ONE native CC
 * Dynamic Workflow (`trident/inner-workflow.mjs`). This module is the durable
 * OUTER loop's bridge to it: `buildWorkflowInnerLoop(...)` returns a
 * `TridentInnerLoop` that, per call, runs the inner-workflow to a TERMINAL
 * result and reports it back as one `InnerLoopResult`.
 *
 * ── INVOCATION MODEL (the 2026-06-29 fix) ────────────────────────────────────
 * The launcher is a BLOCKING `claude -p` (print-mode / headless one-shot)
 * subprocess — NOT a turn on the persistent interactive-REPL substrate.
 *
 * WHY: the CC `Workflow` tool is BACKGROUND / multi-turn. Invoking it returns a
 * runId IMMEDIATELY; the workflow's completion arrives LATER as a
 * `<task-notification>` (a NEW turn). The persistent-REPL substrate bridges each
 * turn's FIRST `reply()` to one `completion` Event and (in `ephemeral` mode)
 * disposes the REPL right after — so the launcher turn settled in ~30s while the
 * background workflow was still building, the disposable REPL was killed, and the
 * workflow was ABORTED (observed: status:killed / "Workflow aborted"). Argus
 * review, synthesis, SQLite checkpoints, and worktree cleanup NEVER ran, no
 * TRIDENT_RESULT was produced, and the inner loop returned failed/null on EVERY
 * real run. (CI's unit tests passed because a FAKE substrate replayed a scripted
 * `completion` synchronously; they never exercised a live background Workflow.)
 *
 * `claude -p` is the proven path: print-mode DRAINS in-flight background tasks
 * (the Workflow run + its `agent()` workers) to completion BEFORE the process
 * exits, so TRIDENT_RESULT lands in the process's stdout. This is exactly what
 * made the proto-2 pipeline run succeed (`docs/research/trident-v2-prototype2-*`,
 * run `wf_13f3e3c8-726`). The thin DURABLE OUTER loop still owns cross-session
 * survival/scheduling; only the inner launcher is a blocking one-shot.
 *
 * The per-turn `claude -p` substrate transport was hard-deleted in the S3
 * rip-replace, so this module spawns the print-mode process DIRECTLY (mirroring
 * the model-update probe's `child_process.spawn` discipline) via an injectable
 * `LaunchInnerWorkflow` seam. Production wires `buildClaudePrintLauncher`, which
 * resolves the scrubbed Anthropic auth env per call (rotated-token safe) and
 * spawns `claude -p … --dangerously-skip-permissions --model <model>` rooted at
 * the run's repo. Tests inject a fake `launch` and never touch a live `claude`.
 *
 * FALSE-COMPLETION discipline (paused ≠ finished; Vajra fleet-premature-
 * completion reconciliation #160/#164) is preserved: a launcher is `completed`
 * ONLY when the process exits CLEANLY (code 0) AND its stdout carries a parseable
 * `TRIDENT_RESULT=<json>` line. A timeout → `timed_out`; a spawn error, nonzero
 * exit, or a clean exit with no result line → `failed`. Never a silent success.
 */

import { spawn } from 'node:child_process'
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

/** Input to one print-mode launcher invocation. */
export interface LaunchInnerWorkflowInput {
  /** The launcher user message (passed as `claude -p`'s positional prompt). */
  prompt: string
  /** Working directory for the spawned process — the run's repo/worktree root. */
  cwd: string
  /** Wall-clock budget; the launcher SIGKILLs the child when it elapses. */
  timeout_ms: number
}

/** The terminal outcome of one print-mode launcher invocation. */
export interface LaunchInnerWorkflowResult {
  /** Captured stdout (where the model's final `TRIDENT_RESULT=` line lands). */
  stdout: string
  /** Captured stderr (audit only). */
  stderr: string
  /** Process exit code, or null if it never cleanly exited (killed / errored). */
  exit_code: number | null
  /** True iff the wall-clock budget elapsed and the child was SIGKILLed. */
  timed_out: boolean
  /** Non-null iff the process could not be spawned (or auth-env resolution threw). */
  spawn_error: string | null
}

/**
 * The print-mode launcher seam. Production = `buildClaudePrintLauncher`; tests
 * inject a fake. It MUST resolve only AFTER the spawned process exits (i.e. after
 * print-mode has drained the background Workflow to completion) — never early.
 */
export type LaunchInnerWorkflow = (
  input: LaunchInnerWorkflowInput,
) => Promise<LaunchInnerWorkflowResult>

export interface BuildWorkflowInnerLoopOptions {
  /**
   * PRODUCTION launcher — a blocking `claude -p` print-mode invocation that
   * drains the inner-workflow to a terminal result. Build it with
   * `buildClaudePrintLauncher`. Tests inject a fake `LaunchInnerWorkflow`.
   */
  launch: LaunchInnerWorkflow
  /** Absolute path to the inner-workflow script. Defaults to the sibling
   *  `inner-workflow.mjs` resolved via `import.meta.url`. */
  workflow_script_path?: string
  /** Wall-clock budget for the whole inner loop. Default 2 h. */
  timeout_ms?: number
}

const DEFAULT_TIMEOUT_MS = 2 * 60 * 60_000

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
 * The launcher's user message: invoke the `Workflow` tool on the inner-workflow
 * script with the JSON args, WAIT for it to return, then emit EXACTLY one final
 * unfenced line `TRIDENT_RESULT=<compact JSON of the workflow's return value>`.
 */
export function buildLauncherMessage(scriptPath: string, input: InnerLoopInput): string {
  const argsJson = JSON.stringify(buildWorkflowArgs(input))
  return `You are the trident-v2 inner-loop LAUNCHER, running headless via \`claude -p\`. You run UNATTENDED — NEVER ask for input; on any blocker, finish with the result line below carrying a REQUEST_CHANGES verdict rather than hanging.

Do EXACTLY this, nothing else:
1. Invoke the \`Workflow\` tool with:
   scriptPath = ${scriptPath}
   args = ${argsJson}
   Pass \`args\` as a STRUCTURED JSON OBJECT (the parsed value), NOT as a JSON-encoded string — a stringified value reaches the workflow as one string and breaks every \`args.*\` field.
2. The \`Workflow\` tool runs in the BACKGROUND: it returns a runId immediately and the workflow's completion arrives LATER as a \`<task-notification>\`. Do NOT emit your final result until that notification arrives. WAIT for the workflow to fully finish; it drives Forge build → parallel Argus review → synthesis → bounded fix loop and RETURNS an object like {ok, prNumber, branch, verdict, round, checkpoint}.
3. ONLY after the workflow has returned, emit EXACTLY ONE final line, UNFENCED, with NO trailing text after it:
   TRIDENT_RESULT=<the workflow's returned object as compact one-line JSON>

The TRIDENT_RESULT= line MUST be the very last line of your response.`
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

// ── Production print-mode launcher (`claude -p`) ──────────────────────────────

export interface ClaudePrintLauncherOptions {
  /**
   * Resolve the scrubbed Anthropic auth env overlay for the spawned `claude`.
   * Re-run on EVERY launch so a rotated OAuth token is picked up without a
   * restart (production wires `() => resolveScrubbedAuthEnv({pool}).then(r => r.env)`).
   * The result is layered over `base_env`; per ISSUES #49 it explicitly UNSETS
   * the three Anthropic auth vars and sets exactly one to the live secret.
   */
  resolve_auth_env: () => Promise<Record<string, string | undefined>>
  /** Binary path. Default `base_env.CLAUDE_BIN` → `process.env.CLAUDE_BIN` → `claude`. */
  claude_bin?: string
  /** `--model` value. Default `opus` (so the workflow's `agent()` workers run
   *  on the current top-tier alias). */
  model?: string
  /** Base environment the auth overlay is layered over. Default `process.env`. */
  base_env?: NodeJS.ProcessEnv
  /** Extra argv appended after the standard flags (e.g. `--add-dir <repo>`). */
  extra_args?: ReadonlyArray<string>
  /** DI: a `child_process.spawn`-shaped function (tests inject a fake). */
  spawn?: typeof spawn
  /** Timer seam (tests). Defaults to `setTimeout`. */
  set_timer?: (fn: () => void, ms: number) => unknown
  /** Timer-clear seam (tests). Defaults to `clearTimeout`. */
  clear_timer?: (handle: unknown) => void
}

/**
 * Build the `claude -p` argv. Print-mode one-shot (`-p` with the prompt as the
 * positional), `--dangerously-skip-permissions` so the unattended launcher +
 * every Workflow `agent()` worker it spawns auto-execute (proto-2 Q2: subagents
 * inherit the launcher's permission mode), and `--model` LAST so nothing shadows
 * it. No `--tools` restriction: this is a TRUSTED build path (owner-authored
 * task), and the workflow needs the full built-in surface incl. `Workflow`,
 * `Agent`, `Bash`, `Edit`, `Read`, `Write`.
 */
export function buildClaudePrintArgs(
  prompt: string,
  model: string,
  extra?: ReadonlyArray<string>,
): string[] {
  const args = ['-p', prompt, '--dangerously-skip-permissions']
  if (extra !== undefined && extra.length > 0) args.push(...extra)
  args.push('--model', model)
  return args
}

/**
 * Production `LaunchInnerWorkflow`: spawn a blocking `claude -p` process, capture
 * its stdout/stderr, and resolve ONLY when the process closes — by which point
 * print-mode has drained the background Workflow (and its `agent()` workers) to
 * completion. SIGKILLs the child on timeout. Never rejects.
 *
 * Mirrors the model-update probe's async-spawn discipline
 * (`model-update-watchdog.ts realProbeModel`): `child_process.spawn` (not
 * `spawnSync`) so a multi-hour build never blocks the gateway event loop, output
 * aggregated via `.on('data')`, terminal handling on `close` (not `exit`).
 */
export function buildClaudePrintLauncher(opts: ClaudePrintLauncherOptions): LaunchInnerWorkflow {
  const spawnFn = opts.spawn ?? spawn
  const model = opts.model ?? 'opus'
  const setTimer =
    opts.set_timer ?? ((fn: () => void, ms: number): unknown => setTimeout(fn, ms))
  const clearTimer =
    opts.clear_timer ??
    ((handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>))

  return function launch(input: LaunchInnerWorkflowInput): Promise<LaunchInnerWorkflowResult> {
    return new Promise<LaunchInnerWorkflowResult>((resolve) => {
      void (async (): Promise<void> => {
        // Resolve the auth env per-call (rotated-token safe). A throw here is a
        // crashed launcher — surface it as a spawn_error, never a silent success.
        let authEnv: Record<string, string | undefined>
        try {
          authEnv = await opts.resolve_auth_env()
        } catch (e) {
          resolve({
            stdout: '',
            stderr: '',
            exit_code: null,
            timed_out: false,
            spawn_error: `auth env resolution failed: ${e instanceof Error ? e.message : String(e)}`,
          })
          return
        }

        const baseEnv = opts.base_env ?? process.env
        const bin = opts.claude_bin ?? baseEnv['CLAUDE_BIN'] ?? 'claude'
        const args = buildClaudePrintArgs(input.prompt, model, opts.extra_args)
        const env = { ...baseEnv, ...authEnv }

        let child: ReturnType<typeof spawn>
        try {
          // stdin: 'ignore' — the launcher feeds the whole task via the `-p`
          // positional prompt; leaving stdin as an open pipe makes `claude -p`
          // stall ~3s ("no stdin data received") and risks it blocking on stdin.
          child = spawnFn(bin, args, { cwd: input.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
        } catch (e) {
          resolve({
            stdout: '',
            stderr: '',
            exit_code: null,
            timed_out: false,
            spawn_error: `claude -p spawn failed: ${e instanceof Error ? e.message : String(e)}`,
          })
          return
        }

        let out = ''
        let err = ''
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
          try {
            child.kill('SIGKILL')
          } catch {
            /* already gone */
          }
          finish({ stdout: out, stderr: err, exit_code: null, timed_out: true, spawn_error: null })
        }, input.timeout_ms)
        // Don't let the launcher's pipes keep the event loop alive on their own.
        ;(timer as { unref?: () => void })?.unref?.()

        child.stdout?.on('data', (d: Buffer | string) => {
          out += d.toString()
        })
        child.stderr?.on('data', (d: Buffer | string) => {
          err += d.toString()
        })
        child.on('error', (e: Error) =>
          finish({
            stdout: out,
            stderr: err,
            exit_code: null,
            timed_out: timedOut,
            spawn_error: `claude -p error: ${e.message}`,
          }),
        )
        child.on('close', (code: number | null) =>
          finish({ stdout: out, stderr: err, exit_code: code, timed_out: timedOut, spawn_error: null }),
        )
      })()
    })
  }
}

/**
 * Build a production `TridentInnerLoop`. Each call spawns ONE blocking `claude -p`
 * launcher that drives the inner-workflow to a terminal result, then resolves a
 * parsed `InnerLoopResult` under the false-completion discipline.
 */
export function buildWorkflowInnerLoop(opts: BuildWorkflowInnerLoopOptions): TridentInnerLoop {
  const scriptPath = opts.workflow_script_path ?? DEFAULT_INNER_WORKFLOW_PATH
  const timeoutMs = opts.timeout_ms ?? DEFAULT_TIMEOUT_MS

  return async function innerLoop(input: InnerLoopInput): Promise<InnerLoopResult> {
    const cwd = input.run.worktree ?? input.run.repo_path
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
    // The print-mode process exiting CLEANLY (code 0) — after draining the
    // background Workflow to completion — is the terminal signal (the `claude -p`
    // analogue of a `completion` event). A nonzero exit is a crashed launcher;
    // paused ≠ finished, so it is a FAILURE, never a silent success.
    if (res.exit_code !== 0) return FAILED(res.stdout)

    return finalize(res.stdout, 'completed')
  }

  function finalize(raw: string, status: 'completed'): InnerLoopResult {
    const parsed = parseTridentResult(raw)
    if (parsed === null) {
      // A clean exit that never emitted a parseable result line is a FAILURE (no
      // silent success): the workflow result is unknown — this is exactly the
      // pre-fix symptom (process exited before TRIDENT_RESULT existed).
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
