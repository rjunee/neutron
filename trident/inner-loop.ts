/**
 * @neutronai/trident — the inner-loop launcher (Trident v2).
 *
 * Phase 2 hard cutover: the inner Forge→Argus→fix loop is now ONE native CC
 * Dynamic Workflow (`trident/inner-workflow.mjs`). This module is the durable
 * OUTER loop's bridge to it: `buildWorkflowInnerLoop(...)` returns a
 * `TridentInnerLoop` that, per call, runs a SINGLE substrate turn whose job is
 * to invoke the `Workflow` tool on the inner-workflow script and report the
 * workflow's structured result back as one `TRIDENT_RESULT=<json>` line.
 *
 * The dispatch MECHANICS are copied verbatim from the proven
 * `buildSubstrateTridentDispatch` (`trident/substrate-dispatch.ts`): build a
 * FRESH substrate per call rooted at the run's worktree, start one turn,
 * coalesce `token` events, resolve on `completion`, time out via `set_timer`,
 * and apply the FALSE-COMPLETION discipline (a stream that ends with NO terminal
 * `completion`/`error` event is `failed` — paused ≠ finished, never a silent
 * success; Vajra fleet-premature-completion reconciliation #160/#164).
 *
 * TOOL SURFACE (the v2 enablement): the v1 trident substrate ran tool-less
 * (`AgentSpec.tools: []` → `--tools ""`, the untrusted-import security gate). The
 * v2 LAUNCHER is a TRUSTED build path that MUST invoke `Workflow` (which itself
 * spawns the `Agent`/`Bash`/`Edit`/`Read` workers). The tool surface is a
 * PER-TURN property of the spec (`persistent-repl-substrate` reads
 * `spec.tools.map(t => t.name)` into `--tools`), so the launcher enables it by
 * declaring those built-ins on ITS OWN spec — no substrate surgery, and the
 * untrusted import/conversational REPLs are untouched (each fresh disposable
 * `cc-trident-*` REPL is keyed on this surface, so it never reuses a different
 * one). The ToolDef shape is contract filler — the REPL only consumes `.name`
 * (mirrors `build-live-agent-turn.ts` / `reminders/dispatcher.ts`).
 */

import type { ToolDef } from '../core-sdk/types.ts'
import type { AgentSpec, Substrate } from '../runtime/substrate.ts'
import type { SessionHandle } from '../runtime/session-handle.ts'
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
  /** `completed` = the launcher turn settled and a result line parsed; `failed`
   *  = no terminal completion OR no parseable result; `timed_out` = wall-clock. */
  status: 'completed' | 'failed' | 'timed_out'
  verdict: 'APPROVE' | 'REQUEST_CHANGES' | null
  pr_number: number | null
  branch: string | null
  round: number
  checkpoint: string | null
  /** The coalesced terminal text (audit / debugging). */
  raw: string
}

export type TridentInnerLoop = (input: InnerLoopInput) => Promise<InnerLoopResult>

export interface BuildWorkflowInnerLoopOptions {
  /**
   * PRODUCTION substrate factory — built ONCE PER CALL rooted at the run's
   * worktree (`run.worktree ?? run.repo_path`) as cwd, so the workflow's
   * worktree/git ops run in the run's own repo on a fresh disposable REPL.
   */
  build_substrate: (cwd: string) => Substrate
  /** Absolute path to the inner-workflow script. Defaults to the sibling
   *  `inner-workflow.mjs` resolved via `import.meta.url`. */
  workflow_script_path?: string
  /** Wall-clock budget for the whole inner loop. Default 2 h. */
  timeout_ms?: number
  /** Upper bound on completion tokens for the launcher turn. Omitted by default. */
  max_tokens?: number
  /** Timer seam (tests). Defaults to `setTimeout`. */
  set_timer?: (fn: () => void, ms: number) => unknown
  /** Timer-clear seam (tests). Defaults to `clearTimeout`. */
  clear_timer?: (handle: unknown) => void
}

const DEFAULT_TIMEOUT_MS = 2 * 60 * 60_000

/** Built-in tools the launcher turn must be able to call to drive the workflow.
 *  Only `.name` reaches `--tools`; the rest is locked-interface filler. */
const LAUNCHER_TOOL_NAMES = ['Workflow', 'Agent', 'Bash', 'Edit', 'Read'] as const

function launcherTools(): ToolDef[] {
  return LAUNCHER_TOOL_NAMES.map((name) => ({
    name,
    description: `Built-in Claude Code tool '${name}' (trident-v2 inner-workflow launcher surface)`,
    input_schema: { type: 'object' },
    output_schema: { type: 'object' },
    capability_required: 'fs:project_data',
  }))
}

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
 * The launcher turn's user message: invoke the `Workflow` tool on the
 * inner-workflow script with the JSON args, then emit EXACTLY one final
 * unfenced line `TRIDENT_RESULT=<compact JSON of the workflow's return value>`.
 */
export function buildLauncherMessage(scriptPath: string, input: InnerLoopInput): string {
  const argsJson = JSON.stringify(buildWorkflowArgs(input))
  return `You are the trident-v2 inner-loop LAUNCHER. You run UNATTENDED — NEVER ask for input; on any blocker, finish with the result line below carrying a REQUEST_CHANGES verdict rather than hanging.

Do EXACTLY this, nothing else:
1. Invoke the \`Workflow\` tool with:
   scriptPath = ${scriptPath}
   args = ${argsJson}
   Pass \`args\` as a STRUCTURED JSON OBJECT (the parsed value), NOT as a JSON-encoded string — a stringified value reaches the workflow as one string and breaks every \`args.*\` field.
2. The workflow drives Forge build → parallel Argus review → synthesis → bounded fix loop and RETURNS an object like {ok, prNumber, branch, verdict, round, checkpoint}. Wait for it to return.
3. Emit EXACTLY ONE final line, UNFENCED, with NO trailing text after it:
   TRIDENT_RESULT=<the workflow's returned object as compact one-line JSON>

The TRIDENT_RESULT= line MUST be the very last line of your response.`
}

/**
 * Parse the `TRIDENT_RESULT=<json>` line, walking from the END of the terminal
 * text so trailing preamble can't shadow it. Returns null when no parseable
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

/**
 * Build a production `TridentInnerLoop` over a runtime `Substrate`. Each call
 * runs ONE launcher turn that drives the inner-workflow and resolves a parsed
 * `InnerLoopResult`.
 */
export function buildWorkflowInnerLoop(opts: BuildWorkflowInnerLoopOptions): TridentInnerLoop {
  const scriptPath = opts.workflow_script_path ?? DEFAULT_INNER_WORKFLOW_PATH
  const timeoutMs = opts.timeout_ms ?? DEFAULT_TIMEOUT_MS
  const setTimer =
    opts.set_timer ?? ((fn: () => void, ms: number): unknown => setTimeout(fn, ms))
  const clearTimer =
    opts.clear_timer ??
    ((handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>))

  return async function innerLoop(input: InnerLoopInput): Promise<InnerLoopResult> {
    const cwd = input.run.worktree ?? input.run.repo_path
    const spec: AgentSpec = {
      prompt: buildLauncherMessage(scriptPath, input),
      tools: launcherTools(),
      // The launcher doesn't pin a model — the workflow's own agent()s pick.
      model_preference: [],
      ...(opts.max_tokens !== undefined ? { max_tokens: opts.max_tokens } : {}),
    }

    let handle: SessionHandle
    try {
      handle = opts.build_substrate(cwd).start(spec)
    } catch {
      // The factory throwing (e.g. an empty credential pool) is a crashed turn.
      return FAILED('')
    }

    let text = ''
    let timedOut = false
    let timer: unknown = null
    if (timeoutMs > 0) {
      timer = setTimer(() => {
        timedOut = true
        void handle.cancel().catch(() => {})
      }, timeoutMs)
    }

    try {
      for await (const ev of handle.events) {
        if (ev.kind === 'token') {
          text += ev.text
        } else if (ev.kind === 'completion') {
          return finalize(text, 'completed')
        } else if (ev.kind === 'error') {
          void handle.cancel().catch(() => {})
          return FAILED(text)
        }
        // thinking / status / tool_* events carry no terminal text — ignored.
      }
    } catch {
      // Iterator threw (cancellation / transport). A timeout that cancelled the
      // stream surfaces as timed_out; anything else as failed.
      return timedOut
        ? { ...FAILED(text), status: 'timed_out' }
        : FAILED(text)
    } finally {
      if (timer !== null) clearTimer(timer)
    }

    // Stream ended WITHOUT a terminal completion event — paused ≠ finished. NEVER
    // a silent success: timed_out if the timer tripped, else failed.
    return timedOut ? { ...FAILED(text), status: 'timed_out' } : FAILED(text)
  }

  function finalize(raw: string, status: 'completed'): InnerLoopResult {
    const parsed = parseTridentResult(raw)
    if (parsed === null) {
      // A completed turn that never emitted a parseable result line is a FAILURE
      // (no silent success): the workflow result is unknown.
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
