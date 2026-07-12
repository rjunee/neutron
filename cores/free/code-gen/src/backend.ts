/**
 * @neutronai/codegen-core — CodegenRunner interface + in-memory orchestrator.
 *
 * The Code-Gen Core productizes the trident/forge/argus surface for
 * non-technical chat-driven users: instead of opening a terminal and
 * invoking a CLI-side spawn script, a launcher session calls
 * `codegen_dispatch({task: '...'})`, polls `codegen_status({task_id})`
 * until terminal, then `codegen_fetch({task_id})` to read back the
 * PR / branch / worktree the runner produced.
 *
 * The Core programs against a narrow `CodegenRunner` (a single
 * `run(input) -> Promise<CodegenRunResult>` surface). Two reference
 * implementations live here:
 *
 *   - `buildInMemoryCodegenRunner(...)` — deterministic fake used by
 *     every test in `__tests__/`. Either consumes a static list of
 *     prepared results (one per dispatch, FIFO) or invokes a caller-
 *     supplied async function so tests can model arbitrary success /
 *     failure / latency shapes without spawning Forge or touching the
 *     filesystem.
 *
 *   - The production substrate-backed runner — the LLM-driven path
 *     that builds an AgentSpec against Sonnet 4.6, applies the patch
 *     to a fresh git branch in the worktree, runs `bun test`, opens
 *     the draft PR via the gateway's existing `gh` helper, and
 *     returns the PR number. That path lives in a follow-up sprint
 *     (see "Out of scope" in the sprint brief — the full Forge ->
 *     Argus -> merge loop is the Tier 2 paid Coding Core, NOT this
 *     Core). Tier 1 is the minimum surface the launcher needs to
 *     dispatch + observe a job; the orchestrator below is shape-
 *     compatible with the production runner once it lands.
 *
 * Status machine
 *
 *   pending  → runner queued but `run()` not yet invoked. Initial
 *              state immediately after `dispatch()`; transitions to
 *              `running` once the orchestrator pulls the task off the
 *              schedule queue (one event-loop tick later — see the
 *              `setImmediate` in `dispatch` below).
 *   running  → runner is executing. The Core's external surface
 *              treats this as "still in flight; poll again later".
 *   completed → runner resolved with a CodegenRunResult. `fetch`
 *              returns the result; further dispatches with the same
 *              task_id are impossible (ids are freshly minted).
 *   failed   → runner threw. `fetch` throws `CodegenTaskFailedError`
 *              carrying the structured error metadata (code, message)
 *              the caller can surface in chat.
 *
 * Synchronous v1
 *
 * Per the brief's "Synchronous run for v1" lock: the runner is a
 * single round-trip (one LLM call → one branch → one PR). Real-time
 * progress streaming, parallel orchestration, and the Forge worktree
 * + Argus review + merge loop are deliberately deferred. A `pending`
 * state is exposed so chat clients can render "queued" UX while the
 * dispatch microtask flushes; in practice the transition to `running`
 * happens within a single event-loop tick.
 *
 * Why `setImmediate` for the kickoff
 *
 * If `dispatch` invoked the runner synchronously, every caller that
 * awaited `dispatch` would see the task already in `running` state
 * (the `markRunning` write happens before the first `await
 * runner.run(...)` suspension point inside the orchestrator's async
 * function). The `pending` state would never be observable. Deferring
 * the orchestrator kick to `setImmediate` puts it on the macrotask
 * queue, so `await dispatch(...)` (which only drains microtasks)
 * returns with the task still in `pending`. Tests + chat clients can
 * therefore render the queued state truthfully. The runtime hands
 * `setImmediate` to the launcher's event loop; nothing here blocks.
 */

import { randomUUID } from 'node:crypto'
import { fireAndForget } from '@neutronai/logger/fire-and-forget.ts'

/**
 * Terminal + non-terminal states the Core surfaces through
 * `codegen_status`. Mirrors the manifest's `status` enum 1:1.
 *
 * S1 adds the `cancelled` terminal state — `codegen_cancel` calls into
 * the sub-agent control surface to cancel the in-flight run, then
 * marks the row `cancelled`.
 */
export type CodegenTaskStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface CodegenDispatchInput {
  /** Plain-language description of the code change to attempt. */
  task: string
  /** Optional absolute repo path; defaults applied by the orchestrator
   *  when omitted (`process.cwd()` or a runtime-provided default). */
  repo_path?: string
  /** Optional feature-branch name; orchestrator auto-generates from
   *  the task slug when omitted. */
  target_branch?: string
}

export interface CodegenStatusInput {
  task_id: string
}

export interface CodegenFetchInput {
  task_id: string
}

export interface CodegenRunInput extends CodegenDispatchInput {
  /** Task id the orchestrator minted at dispatch time. Surfaced to the
   *  runner so production implementations can stamp it on log lines /
   *  audit rows / git commit trailers. */
  task_id: string
}

export interface CodegenRunResult {
  /** PR number assigned by the host (GitHub / Gitea / Forgejo). */
  pr_number: number
  /** Feature branch the runner pushed. */
  branch: string
  /** Absolute path to the worktree the runner committed against. */
  worktree: string
  /** One-line human-readable summary of what shipped. */
  summary: string
}

/**
 * Structured error a `CodegenRunner` can throw to record a failure
 * with a stable error code the caller can branch on. Plain `Error`
 * throws are coerced to `code: 'unknown_error'` by the orchestrator.
 */
export class CodegenRunError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'CodegenRunError'
    this.code = code
  }
}

export interface CodegenRunner {
  /** Execute the code-gen job and resolve with the produced PR/branch
   *  metadata, or reject (any Error / `CodegenRunError`). */
  run(input: CodegenRunInput): Promise<CodegenRunResult>
}

/**
 * The internal task record the orchestrator keeps per dispatch. Not
 * surfaced through the tool contract — `codegen_status` returns just
 * the status string, `codegen_fetch` returns just the run result.
 * Kept here so tests and the production runner can inspect / persist
 * the history (when a follow-up sprint adds a sidecar DB this struct
 * is the row shape).
 */
export interface CodegenTaskRecord {
  task_id: string
  request: CodegenDispatchInput
  status: CodegenTaskStatus
  /** Populated once status reaches `completed`. */
  result?: CodegenRunResult
  /** Populated once status reaches `failed`. */
  error?: { code: string; message: string }
  created_at: number
  updated_at: number
}

/**
 * Thrown by `codegen_fetch` when the task_id is unknown. Distinct
 * from `failed` (the task ran, the run threw) and from `pending` /
 * `running` (the task exists but hasn't reached a terminal state).
 */
export class CodegenTaskNotFoundError extends Error {
  readonly code = 'codegen_task_not_found' as const
  readonly task_id: string
  constructor(task_id: string) {
    super(`code-gen task not found: ${task_id}`)
    this.name = 'CodegenTaskNotFoundError'
    this.task_id = task_id
  }
}

/**
 * Thrown by `codegen_fetch` when the task is still pre-terminal.
 * Callers (chat clients, the launcher) treat this as "poll again
 * later" — the underlying error code stays stable across versions so
 * the UI can match on it without parsing prose.
 */
export class CodegenTaskPendingError extends Error {
  readonly code = 'codegen_task_pending' as const
  readonly task_id: string
  readonly status: CodegenTaskStatus
  constructor(task_id: string, status: CodegenTaskStatus) {
    super(`code-gen task ${task_id} is not yet terminal (status=${status})`)
    this.name = 'CodegenTaskPendingError'
    this.task_id = task_id
    this.status = status
  }
}

/**
 * Thrown by `codegen_fetch` when the task is in `failed` state.
 * Carries the structured `{code, message}` the runner reported so
 * the chat client can render a typed-error message instead of a
 * stack trace.
 */
export class CodegenTaskFailedError extends Error {
  readonly code = 'codegen_task_failed' as const
  readonly task_id: string
  readonly run_error: { code: string; message: string }
  constructor(
    task_id: string,
    run_error: { code: string; message: string },
  ) {
    super(`code-gen task ${task_id} failed (${run_error.code}): ${run_error.message}`)
    this.name = 'CodegenTaskFailedError'
    this.task_id = task_id
    this.run_error = run_error
  }
}

/**
 * Thrown when a tool handler receives a payload that cannot be coerced
 * into the documented input shape. Mirrors `ResearchInputError` from the
 * Research Core — `McpServer.dispatch` passes raw JSON straight through
 * to handlers without enforcing the manifest's `input_schema`, so the
 * orchestrator MUST reject malformed payloads BEFORE they reach the
 * tracker or runner. Distinguishable from `CodegenTaskNotFoundError` so
 * a tool-call client (LLM, MCP inspector) can self-correct on bad input
 * rather than retrying the same wrong-shape payload forever (which is
 * what happens when bad input gets misreported as "task not found").
 *
 * Surfaced via the `CapabilityGuard` wrapper as `outcome='error'` in the
 * audit log; the caller sees the message verbatim.
 */
export class CodegenInputError extends Error {
  readonly code = 'codegen_invalid_input' as const
  readonly tool: string
  readonly field: string
  constructor(tool: string, field: string, message: string) {
    super(`${tool}: ${field}: ${message}`)
    this.name = 'CodegenInputError'
    this.tool = tool
    this.field = field
  }
}

/**
 * Coerce an unknown runtime payload to a typed `CodegenDispatchInput`.
 * Throws `CodegenInputError` on any structural mismatch — the message
 * names the offending tool + field + reason so a tool-call client (LLM,
 * MCP inspector, test harness) can correct and retry.
 *
 * Returns a fresh object containing only the validated fields; the
 * caller is expected to deep-clone before storing or passing further
 * (see `CodegenOrchestrator.dispatch`).
 */
export function validateDispatchInput(input: unknown): CodegenDispatchInput {
  const TOOL = 'codegen_dispatch'
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new CodegenInputError(TOOL, 'input', 'must be an object')
  }
  const obj = input as Record<string, unknown>

  if (typeof obj['task'] !== 'string') {
    throw new CodegenInputError(TOOL, 'task', 'must be a string')
  }
  const task = (obj['task'] as string).trim()
  if (task === '') {
    throw new CodegenInputError(TOOL, 'task', 'must be a non-empty string')
  }

  const out: CodegenDispatchInput = { task }

  if (obj['repo_path'] !== undefined && obj['repo_path'] !== null) {
    if (typeof obj['repo_path'] !== 'string') {
      throw new CodegenInputError(TOOL, 'repo_path', 'must be a string when set')
    }
    if ((obj['repo_path'] as string).trim() === '') {
      throw new CodegenInputError(
        TOOL,
        'repo_path',
        'must be a non-empty string when set',
      )
    }
    out.repo_path = obj['repo_path'] as string
  }

  if (obj['target_branch'] !== undefined && obj['target_branch'] !== null) {
    if (typeof obj['target_branch'] !== 'string') {
      throw new CodegenInputError(
        TOOL,
        'target_branch',
        'must be a string when set',
      )
    }
    if ((obj['target_branch'] as string).trim() === '') {
      throw new CodegenInputError(
        TOOL,
        'target_branch',
        'must be a non-empty string when set',
      )
    }
    out.target_branch = obj['target_branch'] as string
  }

  return out
}

/**
 * Shared validator for `{task_id: string}` shapes — used by both
 * `codegen_status` and `codegen_fetch`. The tool name is included in
 * the error so a misshaped payload routes to the right diagnostic.
 */
function validateTaskIdInput(input: unknown, tool: string): { task_id: string } {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new CodegenInputError(tool, 'input', 'must be an object')
  }
  const obj = input as Record<string, unknown>
  if (typeof obj['task_id'] !== 'string') {
    throw new CodegenInputError(tool, 'task_id', 'must be a string')
  }
  if ((obj['task_id'] as string).trim() === '') {
    throw new CodegenInputError(tool, 'task_id', 'must be a non-empty string')
  }
  return { task_id: obj['task_id'] as string }
}

export function validateStatusInput(input: unknown): CodegenStatusInput {
  return validateTaskIdInput(input, 'codegen_status')
}

export function validateFetchInput(input: unknown): CodegenFetchInput {
  return validateTaskIdInput(input, 'codegen_fetch')
}

/**
 * Thrown when a task dispatched against the default skeleton runner
 * runs. Tier 1 Code-Gen ships as a SKELETON Core: the manifest,
 * orchestrator, capability gates, and audit wiring are real, but the
 * production code-authoring path (Sonnet 4.6 + git + bun test + gh
 * draft PR) lives in the Tier 2 paid Coding Core. The host gateway
 * may inject a custom `CodegenRunner` at install time; otherwise the
 * Core's `codegen_dispatch` calls fail with this error so the chat
 * client can render an actionable "install Tier 2 Coding Core" prompt
 * instead of a confusing generic failure.
 *
 * Extends `CodegenRunError` so the orchestrator's failure-coercion path
 * surfaces the stable `codegen_not_configured` error code through
 * `CodegenTaskFailedError.run_error.code`.
 */
/**
 * Thrown when the worktree resolver cannot establish the per-project
 * git worktree + remote — typically because `gh` is unavailable, the
 * host has no write permission on the GitHub org, or fs is read-only.
 */
export class CodegenWorktreeNotResolvedError extends Error {
  readonly code = 'worktree_not_resolved' as const
  readonly project_id: string
  readonly reason: string
  constructor(project_id: string, reason: string) {
    super(`Worktree not resolved for project ${project_id}: ${reason}`)
    this.name = 'CodegenWorktreeNotResolvedError'
    this.project_id = project_id
    this.reason = reason
  }
}

/**
 * Thrown when a sub-agent run exceeds the per-run wall-clock budget
 * (default 30 min, settable via `RuntimeCodegenRunnerOptions.subagent_timeout_ms`).
 */
export class CodegenSubagentTimeoutError extends CodegenRunError {
  readonly run_id: string
  readonly budget_ms: number
  constructor(run_id: string, budget_ms: number) {
    super(
      'subagent_timeout',
      `sub-agent run ${run_id} exceeded ${budget_ms}ms budget`,
    )
    this.name = 'CodegenSubagentTimeoutError'
    this.run_id = run_id
    this.budget_ms = budget_ms
  }
}

/**
 * Thrown when the Argus-rounds loop hits `max_argus_rounds` without an
 * APPROVE verdict. Surfaces the cap so the chat client can render the
 * "Argus didn't converge — manual review" UX.
 */
export class CodegenMaxRoundsReachedError extends CodegenRunError {
  readonly task_id: string
  readonly max_rounds: number
  constructor(task_id: string, max_rounds: number) {
    super(
      'max_argus_rounds_reached',
      `Argus did not APPROVE after ${max_rounds} rounds (task=${task_id})`,
    )
    this.name = 'CodegenMaxRoundsReachedError'
    this.task_id = task_id
    this.max_rounds = max_rounds
  }
}

export class CodegenNotConfiguredError extends CodegenRunError {
  constructor() {
    super(
      'codegen_not_configured',
      'Code-Gen Tier 1 ships as a SKELETON Core: no production code-authoring ' +
        'runner is bundled. Install the Tier 2 paid Coding Core for the full ' +
        'Forge → Argus → merge loop, or inject a custom CodegenRunner via ' +
        'CodegenOrchestratorOptions.runner.',
    )
    this.name = 'CodegenNotConfiguredError'
  }
}

/**
 * Default runner used when the host gateway does NOT inject a real
 * `CodegenRunner` at install time. Every dispatched task fails with
 * `CodegenNotConfiguredError` (code = `codegen_not_configured`) so the
 * chat client can route users to the Tier 2 paid Coding Core rather
 * than silently hanging or returning a generic failure.
 */
export function buildSkeletonCodegenRunner(): CodegenRunner {
  return {
    async run(_input: CodegenRunInput): Promise<CodegenRunResult> {
      throw new CodegenNotConfiguredError()
    },
  }
}

/**
 * Orchestrator-side options. The host wires these once per Core
 * install; tests pass mocks directly.
 */
export interface CodegenOrchestratorOptions {
  /**
   * Code-authoring runner. Optional: when omitted the orchestrator
   * uses `buildSkeletonCodegenRunner()` whose `run(...)` throws
   * `CodegenNotConfiguredError`. Tier 1 ships without a production
   * runner — the host gateway must inject one (or install the Tier 2
   * paid Coding Core) to get real code-authoring behaviour. Tests
   * inject the in-memory runner from `buildInMemoryCodegenRunner`.
   */
  runner?: CodegenRunner
  /** Mint a fresh task id. Tests override for determinism; production
   *  defaults to `randomUUID()`. */
  mint_task_id?: () => string
  /** Wall-clock provider. Tests override for deterministic
   *  `created_at` / `updated_at`; production defaults to `Date.now()`. */
  now?: () => number
  /**
   * Schedule the runner kickoff. Defaults to `setImmediate` so
   * `await dispatch(...)` returns with the task still in `pending`
   * (microtask vs macrotask scheduling — see top-of-file docstring).
   * Tests that need fully synchronous transitions can pass a
   * `(fn) => fn()` shim, but the production default ALWAYS uses
   * `setImmediate` to keep the `pending` state observable.
   */
  schedule_kickoff?: (fn: () => void) => void
}

/**
 * In-memory task tracker the orchestrator + `codegen_status` /
 * `codegen_fetch` tools share. Surfaced as a class (not a plain
 * object) so the production runner can subclass it for the durable-
 * persistence path without touching the orchestrator contract.
 */
export class CodegenTaskTracker {
  private readonly rows = new Map<string, CodegenTaskRecord>()
  private readonly now_fn: () => number

  constructor(options: { now?: () => number } = {}) {
    this.now_fn = options.now ?? ((): number => Date.now())
  }

  create(task_id: string, request: CodegenDispatchInput): CodegenTaskRecord {
    if (this.rows.has(task_id)) {
      throw new Error(`codegen task tracker: duplicate task_id ${task_id}`)
    }
    const now = this.now_fn()
    const rec: CodegenTaskRecord = {
      task_id,
      request,
      status: 'pending',
      created_at: now,
      updated_at: now,
    }
    this.rows.set(task_id, rec)
    return rec
  }

  markRunning(task_id: string): void {
    this.transition(task_id, 'running', (rec) => rec)
  }

  markCompleted(task_id: string, result: CodegenRunResult): void {
    this.transition(task_id, 'completed', (rec) => {
      rec.result = result
      return rec
    })
  }

  markFailed(task_id: string, error: { code: string; message: string }): void {
    this.transition(task_id, 'failed', (rec) => {
      rec.error = error
      return rec
    })
  }

  /**
   * Mark a task as cancelled. Used by `codegen_cancel` after the
   * sub-agent control surface confirms the in-flight run was killed.
   * Idempotent: cancelling an already-terminal task is a no-op.
   */
  markCancelled(task_id: string): void {
    const rec = this.rows.get(task_id)
    if (rec === undefined) {
      throw new Error(`codegen task tracker: unknown task_id ${task_id}`)
    }
    if (
      rec.status === 'completed' ||
      rec.status === 'failed' ||
      rec.status === 'cancelled'
    ) {
      return
    }
    this.transition(task_id, 'cancelled', (r) => r)
  }

  get(task_id: string): CodegenTaskRecord | null {
    const rec = this.rows.get(task_id)
    if (rec === undefined) return null
    // Return a defensive shallow copy so callers cannot mutate the
    // tracker's interior state through the returned record. Cheap:
    // these rows are flat objects with one or two nested literals.
    return {
      ...rec,
      ...(rec.result !== undefined ? { result: { ...rec.result } } : {}),
      ...(rec.error !== undefined ? { error: { ...rec.error } } : {}),
    }
  }

  /** Snapshot of every task id the tracker has seen. Used by tests
   *  and the future durable-persistence pass; not surfaced through
   *  the tool contract. */
  ids(): string[] {
    return [...this.rows.keys()]
  }

  private transition(
    task_id: string,
    next: CodegenTaskStatus,
    patch: (rec: CodegenTaskRecord) => CodegenTaskRecord,
  ): void {
    const rec = this.rows.get(task_id)
    if (rec === undefined) {
      throw new Error(`codegen task tracker: unknown task_id ${task_id}`)
    }
    const patched = patch(rec)
    patched.status = next
    patched.updated_at = this.now_fn()
    this.rows.set(task_id, patched)
  }
}

/**
 * The orchestrator owns the `dispatch / status / fetch` semantics.
 * Wires a `CodegenRunner` to a `CodegenTaskTracker` and exposes the
 * three operations the tools dispatch against.
 *
 * Constructed once per Core install and passed into `buildTools`.
 * Tests construct directly with stub runners; production wires a
 * substrate-backed runner that fans out to Sonnet 4.6 + git + gh.
 */
export class CodegenOrchestrator {
  readonly tracker: CodegenTaskTracker
  private readonly runner: CodegenRunner
  private readonly mintId: () => string
  private readonly schedule: (fn: () => void) => void
  /**
   * Single-slot mutex. Per the sprint brief lock ("one task at a
   * time" for v1), dispatched tasks are serialized FIFO: at most one
   * task is in `running` state at any moment. Subsequent dispatches
   * acknowledge immediately (mint a task_id, persist a `pending` row,
   * return), and their `executeTask` chains onto this promise so the
   * next task starts only after the prior task hits a terminal state.
   *
   * Why a chain (not a queue + pump): the chain is the queue. Each
   * `dispatch(...)` synchronously appends its `executeTask` to the
   * tail of the chain. The `.then(...)` continuation fires when the
   * previous task's `executeTask` resolves — which is AFTER
   * `markCompleted` / `markFailed` runs (see `executeTask`'s try /
   * catch). No risk of two tasks being `running` simultaneously.
   *
   * The chain runs forever as long as the orchestrator is alive;
   * settled promises hold no state worth GCing.
   */
  private dispatchChain: Promise<void> = Promise.resolve()

  constructor(opts: CodegenOrchestratorOptions = {}) {
    // When no runner is injected the orchestrator defaults to the
    // skeleton runner whose `run(...)` throws `CodegenNotConfiguredError`.
    // This makes Tier 1 Code-Gen safe to install in a host gateway that
    // hasn't wired a real code-authoring substrate yet — dispatches
    // fail loudly + actionably (route the user to Tier 2 Coding Core)
    // rather than silently hanging on a missing dependency.
    this.runner = opts.runner ?? buildSkeletonCodegenRunner()
    this.mintId = opts.mint_task_id ?? ((): string => randomUUID())
    this.tracker = new CodegenTaskTracker(
      opts.now !== undefined ? { now: opts.now } : {},
    )
    this.schedule = opts.schedule_kickoff ?? defaultScheduleKickoff
  }

  /**
   * Mint a task_id, record it as `pending`, schedule the runner
   * kickoff on the next macrotask tick, and return the id.
   *
   * Runtime validation: malformed payloads (the McpServer dispatches
   * raw JSON without enforcing the manifest input_schema) are rejected
   * with `CodegenInputError` BEFORE the task_id is minted, so the
   * tracker never sees a half-formed row.
   *
   * Snapshot semantics: the validated input is `structuredClone`-d
   * before being stored on the tracker or passed to the runner, so a
   * caller that mutates the input object after `dispatch` returns
   * cannot leak the mutation into the in-flight run or the persisted
   * task record. The brief flagged this as a MINOR finding from
   * Argus r1.
   *
   * Serialization: subsequent dispatches do NOT run in parallel.
   * Their `executeTask` chains onto `dispatchChain` (the single-slot
   * mutex) so at most one task is in `running` state at any moment.
   * The other tasks remain in `pending` until the slot frees up.
   */
  async dispatch(input: CodegenDispatchInput): Promise<{ task_id: string }> {
    const validated = validateDispatchInput(input)
    // Deep-clone the validated payload so caller-side mutation after
    // dispatch cannot reach into the tracker / runner. structuredClone
    // is available in every supported runtime (Bun, Node 17+).
    const snapshot = structuredClone(validated)
    const task_id = this.mintId()
    this.tracker.create(task_id, snapshot)
    // Chain the executeTask onto the single-slot mutex. The first
    // task's `.then(...)` continuation fires on the microtask boundary
    // after the prior chain link resolves; we wrap it in a
    // `schedule()` (default = `setImmediate`) so the `pending` state
    // is observable across the dispatch microtask flush for every
    // task in the chain, not just the head.
    this.dispatchChain = this.dispatchChain.then(
      () =>
        new Promise<void>((resolve) => {
          this.schedule(() => {
            fireAndForget('backend.executeTask', this.executeTask(task_id, snapshot).then(resolve, resolve))
          })
        }),
    )
    return { task_id }
  }

  /**
   * Look up the current state of a task. Throws
   * `CodegenInputError` on shape mismatch (rejected BEFORE the tracker
   * lookup so chat clients can distinguish bad input from a real miss),
   * `CodegenTaskNotFoundError` for unknown ids.
   */
  status(input: CodegenStatusInput): { status: CodegenTaskStatus } {
    const { task_id } = validateStatusInput(input)
    const rec = this.tracker.get(task_id)
    if (rec === null) throw new CodegenTaskNotFoundError(task_id)
    return { status: rec.status }
  }

  /**
   * Fetch the result of a completed task. Throws
   * `CodegenInputError`, `CodegenTaskNotFoundError`,
   * `CodegenTaskPendingError`, or `CodegenTaskFailedError` per the
   * docstrings above.
   */
  fetch(input: CodegenFetchInput): CodegenRunResult {
    const { task_id } = validateFetchInput(input)
    const rec = this.tracker.get(task_id)
    if (rec === null) throw new CodegenTaskNotFoundError(task_id)
    if (rec.status === 'pending' || rec.status === 'running') {
      throw new CodegenTaskPendingError(task_id, rec.status)
    }
    if (rec.status === 'failed') {
      const err = rec.error ?? { code: 'unknown_error', message: 'failed' }
      throw new CodegenTaskFailedError(task_id, err)
    }
    if (rec.status === 'cancelled') {
      throw new CodegenTaskFailedError(task_id, {
        code: 'user_cancelled',
        message: 'task cancelled by user',
      })
    }
    if (rec.result === undefined) {
      // Defensive: a `completed` row with no result is a tracker bug.
      throw new Error(
        `codegen orchestrator: task ${task_id} marked completed but has no result`,
      )
    }
    return rec.result
  }

  /**
   * Mark a task `cancelled`. Surfaced through `codegen_cancel`. The
   * caller is expected to have already cancelled the underlying sub-
   * agent run via the runtime/subagent/control surface; this method
   * only updates the tracker state. Returns the prior status (so the
   * tool can render "you cancelled a `running` task" / "task was
   * already completed").
   */
  cancel(input: { task_id: string }): { cancelled: boolean; prior_status: CodegenTaskStatus } {
    const task_id = input.task_id
    const rec = this.tracker.get(task_id)
    if (rec === null) throw new CodegenTaskNotFoundError(task_id)
    const prior = rec.status
    if (prior === 'completed' || prior === 'failed' || prior === 'cancelled') {
      return { cancelled: false, prior_status: prior }
    }
    this.tracker.markCancelled(task_id)
    return { cancelled: true, prior_status: prior }
  }

  private async executeTask(
    task_id: string,
    input: CodegenDispatchInput,
  ): Promise<void> {
    this.tracker.markRunning(task_id)
    try {
      const result = await this.runner.run({ ...input, task_id })
      this.tracker.markCompleted(task_id, result)
    } catch (err) {
      const code = err instanceof CodegenRunError
        ? err.code
        : 'unknown_error'
      const message = err instanceof Error ? err.message : String(err)
      this.tracker.markFailed(task_id, { code, message })
    }
  }
}

/**
 * Default kickoff scheduler — uses `setImmediate` so the `pending`
 * state is observable across the dispatch microtask flush. Falls
 * back to `setTimeout(fn, 0)` in environments without `setImmediate`
 * (e.g. some test runners patch it out).
 */
function defaultScheduleKickoff(fn: () => void): void {
  if (typeof globalThis.setImmediate === 'function') {
    globalThis.setImmediate(fn)
    return
  }
  setTimeout(fn, 0)
}

/**
 * Options accepted by `buildInMemoryCodegenRunner`. Either pass a
 * static `results` queue (one entry consumed per dispatch FIFO) or a
 * `respond` function for arbitrary per-call behaviour. When both are
 * supplied `respond` wins.
 */
export interface InMemoryCodegenRunnerOptions {
  /**
   * Static FIFO queue of run results. Each `run(...)` call shifts
   * the next entry off the front. A `CodegenRunError` entry is
   * thrown; a `CodegenRunResult` is resolved. Once the queue is
   * empty the runner throws `CodegenRunError('runner_queue_empty',
   * ...)` — tests that don't queue enough responses see a fast
   * failure rather than a hang.
   */
  results?: Array<CodegenRunResult | CodegenRunError>
  /**
   * Arbitrary response function. Called with the runner input;
   * resolved or rejected promise determines the task's terminal
   * state. Wins over `results` when both are set.
   */
  respond?: (input: CodegenRunInput) => Promise<CodegenRunResult>
}

/**
 * Build a deterministic in-memory runner. Used by every test in
 * `__tests__/`; never touches the filesystem or spawns a real Forge
 * agent. Production wires a substrate-backed runner that talks to
 * Sonnet 4.6 + git + gh (deferred to a follow-up sprint per the
 * brief's "Out of scope" lock).
 */
export function buildInMemoryCodegenRunner(
  options: InMemoryCodegenRunnerOptions = {},
): CodegenRunner {
  const queue = options.results !== undefined ? [...options.results] : []
  const respond = options.respond
  return {
    async run(input: CodegenRunInput): Promise<CodegenRunResult> {
      if (respond !== undefined) {
        return respond(input)
      }
      const next = queue.shift()
      if (next === undefined) {
        throw new CodegenRunError(
          'runner_queue_empty',
          'in-memory runner ran out of queued responses',
        )
      }
      if (next instanceof CodegenRunError) throw next
      return next
    },
  }
}

/**
 * Surface-level summary of a code-gen task — the row shape exposed to
 * chat commands, the diff-viewer app-tab, and external observability.
 * Mirrors the per-project sidecar's `code_tasks` columns (see
 * `migrations/0001_*.sql` in this package), but is a separate type so
 * the public surface stays stable independent of schema details.
 */
export interface CodegenTaskRow {
  task_id: string
  project_id: string
  request: string
  status: CodegenTaskStatus
  runner_kind: 'runtime' | 'in_memory' | 'skeleton'
  branch: string | null
  pr_number: number | null
  worktree: string | null
  summary: string | null
  error_code: string | null
  error_message: string | null
  created_at: number
  updated_at: number
}

/** Project-level Code-Gen settings persisted in the per-project sidecar.
 *
 * The S1 `automerge_enabled` gate column was REMOVED in S2 (auto-merge
 * default ON, no per-project toggle — see migrations/0002_*.sql).
 */
export interface CodegenSettings {
  project_id: string
  default_branch: string
  repo_slug: string | null
  gh_owner: string | null
  max_argus_rounds: number
  subagent_timeout_ms: number
  updated_at: number
}

/**
 * Convenience helper for tests that need to await the next
 * macrotask boundary so the orchestrator's `setImmediate`-scheduled
 * kickoff has a chance to fire. Resolves on the next tick of the
 * event loop's `setImmediate` phase, which runs AFTER the current
 * microtask queue drains. Two ticks are sometimes needed: one for
 * the kickoff to fire, one for the runner's first await to land.
 */
export function nextMacrotaskTick(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof globalThis.setImmediate === 'function') {
      globalThis.setImmediate(() => resolve())
      return
    }
    setTimeout(() => resolve(), 0)
  })
}
