/**
 * @neutronai/trident — the `/code` chat command, Trident-native.
 *
 * This is the THIN entry the Trident-port retires the Code-Gen Core
 * wrapper onto: `/code <task>` no longer drives a separate
 * `CodegenOrchestrator` + in-memory `CodegenTaskTracker` + sidecar task
 * store. It simply CREATES a `code_trident_runs` row and returns — the
 * foundational tick loop (`trident/tick.ts` → `buildTridentOrchestrator`)
 * picks the row up on its next sweep and drives it end-to-end: forge-init
 * (or the Ralph plan↔task loop for governed repos) → Argus review → fix
 * loop → merge (per git-mode) → done. State lives in SQLite, so the run
 * survives a control-plane restart and resumes from its persisted phase.
 *
 * The command surface intentionally matches the Code-Gen Core's S2 shape
 * (`/code <task>`, `/code stop [id]`, `/code help`) so the user-facing UX
 * and the existing `/code` tests carry over unchanged — only the engine
 * behind it changes from the Core wrapper to foundational Trident.
 *
 * Layering: this module is owned by the foundational runtime and depends
 * only on the run store (`TridentRunStore`) + the git-mode/ralph detection
 * helpers — never on `cores/free/code-gen`. The gateway wraps
 * `parseAndExecuteCodeCommand` in a `ChatCommandFilter` at the boot layer.
 */

import type { Topic } from '@neutronai/channels/types.ts'
import type { MergeMode, TridentRun, TridentRunStore } from './store.ts'
import { buildTridentTerminator } from './terminate.ts'
import { buildBoardReconcileObserver, type TridentBoardReconciler } from './board-reconcile.ts'
import { composeTerminalHook } from './terminal-observer.ts'
import { dispatchBoardBoundBuild, type TridentBoardBinder } from './board-dispatch.ts'

export type CodeCommand =
  | { kind: 'dispatch'; task: string; board_item_id?: string }
  | { kind: 'stop'; run_ref?: string }
  | { kind: 'help' }
  | { kind: 'unrecognized'; reason: string }

export type CodeCommandErrorCode = 'malformed' | 'unknown_run' | 'backend_error'

export interface CodeCommandResponse {
  text: string
  data?: unknown
  error?: { code: CodeCommandErrorCode; message: string }
}

const VERB = '/code'

/** Sub-verbs the Code-Gen Core S1 surface used to expose; typing one now
 *  returns a friendly reject (keeps the user from accidentally dispatching
 *  `/code status` as a build task). Verbatim from the Core's parser so the
 *  rewired UX is identical. */
const RETIRED_SUBVERBS = new Set(['status', 'review', 'merge', 'judge', 'history', 'automerge'])

/**
 * Pure parser — same grammar as the Code-Gen Core's `parseCodeCommand`
 * (so `/code` UX is unchanged across the engine swap). `/code` alone →
 * help; `/code stop [id]` / `/code cancel [id]` → stop; anything else →
 * a free-form dispatch task.
 */
export function parseCodeCommand(raw: string): CodeCommand {
  const trimmed = raw.trimStart()
  if (!trimmed.startsWith(VERB)) return { kind: 'unrecognized', reason: 'not_a_code_command' }
  const after = trimmed.slice(VERB.length)
  if (after.length > 0 && !/^\s/.test(after)) {
    return { kind: 'unrecognized', reason: 'not_a_code_command' }
  }
  const body = after.trim()
  if (body.length === 0) return { kind: 'help' }
  const m = /^(\S+)(?:\s+([\s\S]*))?$/.exec(body)
  if (m === null) return { kind: 'unrecognized', reason: 'malformed' }
  const sub = (m[1] ?? '').toLowerCase()
  const rest = (m[2] ?? '').trim()
  switch (sub) {
    case 'help':
      return { kind: 'help' }
    case 'stop':
    case 'cancel':
      return rest.length === 0 ? { kind: 'stop' } : { kind: 'stop', run_ref: rest }
    default:
      if (RETIRED_SUBVERBS.has(sub)) {
        return {
          kind: 'unrecognized',
          reason: `\`${sub}\` is no longer a /code sub-command — just type \`/code <your task description>\` to kick off an autonomous build, or \`/code stop\` to cancel.`,
        }
      }
      return parseDispatch(body)
  }
}

/**
 * Parse a dispatch body, pulling an optional `--item <id>` / `--item=<id>`
 * flag (the Work Board item the build binds to) out of the free-form task
 * text. The flag may appear anywhere; the remaining text is the task. Phase 2b:
 * the executor REJECTS a dispatch with no board_item_id (no untracked builds).
 */
function parseDispatch(body: string): Extract<CodeCommand, { kind: 'dispatch' }> {
  let board_item_id: string | undefined
  const stripped = body
    .replace(/(?:^|\s)--item[=\s]+(\S+)/, (_m, id: string) => {
      board_item_id = id
      return ' '
    })
    .replace(/\s+/g, ' ')
    .trim()
  return board_item_id !== undefined
    ? { kind: 'dispatch', task: stripped, board_item_id }
    : { kind: 'dispatch', task: stripped }
}

// `slugifyTask` moved to `./slugify-task.ts` (L3, 2026-07) to cut the
// `board-dispatch.ts` ↔ `code-command.ts` cycle; re-exported here so existing
// import specifiers (barrel + tests) stay valid (test-policy §2.2 barrel rule).
export { slugifyTask } from './slugify-task.ts'

export interface TridentCodeContext {
  /** The run store the `/code` row is written to (instance-scoped). */
  store: TridentRunStore
  /**
   * The Work Board binder (Phase 2b). Every `/code` build MUST bind to a Plan
   * item: the executor looks the item up here for the existence + ask-gate
   * checks and binds the created run to it (`attachRun`). Satisfied by the
   * shared `WorkBoardStore` at the composition root.
   */
  work_board: TridentBoardBinder
  /** Project this `/code` belongs to → the run's `project_slug`. */
  project_slug: string
  /**
   * The owner HOME base. The dispatch chokepoint resolves this project's own
   * git-initialized workspace `<home>/Projects/<project_slug>/code` under it —
   * NOT the git repo directly — so a brand-new project (no repo yet) still
   * builds. That resolved path becomes the run row's `repo_path`.
   */
  repo_path: string
  /**
   * Resolve (and git-init-with-commit, idempotently) the per-project build
   * workspace under `repo_path` (the HOME base), returning its absolute path.
   * Defaults to `ensureProjectBuildWorkspace`. Tests inject a stub.
   */
  resolveBuildRepo?: (owner_home: string, project_slug: string) => Promise<string>
  /**
   * Resolve the git-mode for this repo. Defaults to `detectMergeMode` over
   * the production probe (GitHub origin + `gh` → `'pr'`, else `'local'`).
   * Tests inject a deterministic resolver.
   */
  resolveMergeMode?: () => Promise<MergeMode>
  /**
   * Resolve whether this build is governed (Ralph one-task-per-context
   * loop). Defaults to `detectRalphMode` (see board-dispatch.ts) — a
   * `SPEC.md` at the git root governs; an explicit resolver still wins.
   */
  resolveRalph?: () => Promise<boolean>
  /** Chat thread context persisted on the run for status posts. */
  chat_id?: string | null
  thread_id?: string | null
  /**
   * Channel the `chat_id`/`thread_id` belong to (#317) — persisted on the run
   * so terminal-result delivery routes back to the originating surface instead
   * of hard-coding Telegram. Omitted → the store defaults to `'telegram'`
   * (the Telegram webhook `/code` path; app-WS callers pass `'app_socket'`).
   */
  channel_kind?: Topic['channel_kind']
  /** Round caps (else the store defaults: 8 / 20). */
  max_rounds?: number
  max_ralph_rounds?: number
}

/** Dispatch the parsed command. */
export async function executeCodeCommand(
  cmd: CodeCommand,
  ctx: TridentCodeContext,
): Promise<CodeCommandResponse> {
  switch (cmd.kind) {
    case 'help':
      return { text: HELP_TEXT }
    case 'unrecognized':
      return {
        text: `Sorry, I didn't recognise that \`/code\` command (${cmd.reason}). Try \`/code help\`.`,
        error: { code: 'malformed', message: cmd.reason },
      }
    case 'dispatch':
      return executeDispatch(cmd, ctx)
    case 'stop':
      return executeStop(cmd, ctx)
  }
}

/**
 * Top-level entry the chat bridge calls per inbound message. Returns
 * `null` when the body isn't a `/code` command (so the bridge falls
 * through to the LLM path) — same contract as the Core's parser.
 */
export async function parseAndExecuteCodeCommand(
  raw: string,
  ctx: TridentCodeContext,
): Promise<CodeCommandResponse | null> {
  const cmd = parseCodeCommand(raw)
  if (cmd.kind === 'unrecognized' && cmd.reason === 'not_a_code_command') return null
  return executeCodeCommand(cmd, ctx)
}

async function executeDispatch(
  cmd: Extract<CodeCommand, { kind: 'dispatch' }>,
  ctx: TridentCodeContext,
): Promise<CodeCommandResponse> {
  if (cmd.task.length === 0) {
    return {
      text: '`/code` needs a task description: `/code --item <plan-item-id> <what to build>`.',
      error: { code: 'malformed', message: 'empty task' },
    }
  }
  const deps = {
    store: ctx.store,
    board: ctx.work_board,
    project_slug: ctx.project_slug,
    repo_path: ctx.repo_path,
    ...(ctx.resolveBuildRepo !== undefined ? { resolveBuildRepo: ctx.resolveBuildRepo } : {}),
    ...(ctx.resolveMergeMode !== undefined ? { resolveMergeMode: ctx.resolveMergeMode } : {}),
    ...(ctx.resolveRalph !== undefined ? { resolveRalph: ctx.resolveRalph } : {}),
    ...(ctx.chat_id !== undefined ? { chat_id: ctx.chat_id } : {}),
    ...(ctx.thread_id !== undefined ? { thread_id: ctx.thread_id } : {}),
    ...(ctx.channel_kind !== undefined ? { channel_kind: ctx.channel_kind } : {}),
    ...(ctx.max_rounds !== undefined ? { max_rounds: ctx.max_rounds } : {}),
    ...(ctx.max_ralph_rounds !== undefined ? { max_ralph_rounds: ctx.max_ralph_rounds } : {}),
  }
  const result = await dispatchBoardBoundBuild({ task: cmd.task, board_item_id: cmd.board_item_id }, deps)

  if (!result.ok) {
    if (result.code === 'missing_board_item') {
      return {
        text:
          '`/code` builds must be bound to a Plan item — pass `--item <plan-item-id>`. ' +
          'Add the work to the Plan first, then `/code --item <id> <task>`.',
        error: { code: 'malformed', message: result.message },
      }
    }
    if (result.code === 'unknown_board_item') {
      return { text: `\`/code\`: ${result.message}`, error: { code: 'unknown_run', message: result.message } }
    }
    if (result.code === 'underspecified') {
      // The ask-before-acting gate. The dispatch is BLOCKED; the caller asks.
      return { text: `🛠 ${result.message}`, error: { code: 'malformed', message: result.message } }
    }
    return {
      text: `\`/code\` ${result.message}`,
      error: { code: 'backend_error', message: result.message },
    }
  }

  const mode = result.ralph ? 'governed (Ralph)' : result.merge_mode === 'pr' ? 'PR' : 'local'
  return {
    text: `🛠 Building \`${truncate(cmd.task, 60)}\` — Trident run \`${result.run.id.slice(0, 8)}\` (${mode} mode), bound to Plan item \`${cmd.board_item_id}\`. Forge → Argus → merge runs autonomously; I'll surface the result. Send \`/code stop\` to cancel.`,
    data: { run_id: result.run.id, slug: result.run.slug, merge_mode: result.merge_mode, ralph: result.ralph },
  }
}

async function executeStop(
  cmd: Extract<CodeCommand, { kind: 'stop' }>,
  ctx: TridentCodeContext,
): Promise<CodeCommandResponse> {
  const target = resolveStopTarget(cmd.run_ref, ctx)
  if (target === null) {
    return cmd.run_ref !== undefined
      ? {
          text: `No in-flight Trident run matching \`${cmd.run_ref}\` in project \`${ctx.project_slug}\`.`,
          error: { code: 'unknown_run', message: `no run ${cmd.run_ref}` },
        }
      : { text: `🛠 No in-flight \`/code\` build to stop in project \`${ctx.project_slug}\`.` }
  }
  // §F6a — route the terminal write through the ONE `terminate()` chokepoint.
  // `/code stop` replies to the user synchronously (below), so firing the DELIVERY
  // observer would DOUBLE-notify — but the bound board card MUST still be
  // reconciled (marked failed, retry binding preserved), exactly as the board
  // DELETE path does (Codex r6). So run the NON-delivery board-reconcile observer
  // under a NO-OP delivery hook: the card reconciles without a second chat post.
  const reconcile =
    typeof ctx.work_board.detachRun === 'function'
      ? buildBoardReconcileObserver(ctx.work_board as TridentBoardReconciler)
      : null
  const observer =
    reconcile !== null ? composeTerminalHook({ onTerminal: async (): Promise<void> => {} }, [reconcile]) : null
  const result = await buildTridentTerminator({ store: ctx.store, observer }).terminate(target.id, 'stopped', {})
  // The `resolveStopTarget` read can go stale in the await gap: the tick loop may
  // finish the run first, so the atomic transition LOSES (`won:false`). Report
  // accurately rather than claim a stop that never happened (Codex r4, mirrors the
  // board DELETE `won` contract).
  if (!result.won) {
    const priorPhase = result.run?.phase ?? 'terminal'
    return {
      text: `🛠 Trident run \`${target.id.slice(0, 8)}\` already finished (${priorPhase}) before it could be stopped — nothing to cancel.`,
      data: { run_id: target.id, prior_phase: priorPhase, already_terminal: true },
    }
  }
  return {
    text: `🛠 Stopped Trident run \`${target.id.slice(0, 8)}\` (was ${target.phase}). The PR/branch (if any) stays for manual review.`,
    data: { run_id: target.id, prior_phase: target.phase },
  }
}

/** Resolve which non-terminal run a `/code stop` targets: an explicit id
 *  (prefix or exact), else the most-recently-started non-terminal run in
 *  this project. */
function resolveStopTarget(run_ref: string | undefined, ctx: TridentCodeContext): TridentRun | null {
  const active = ctx.store
    .listNonTerminal(200)
    .filter((r) => r.project_slug === ctx.project_slug)
  if (run_ref !== undefined) {
    const match = active.find((r) => r.id === run_ref || r.id.startsWith(run_ref) || r.slug === run_ref)
    return match ?? null
  }
  if (active.length === 0) return null
  // `listNonTerminal` orders by `last_advanced_at ASC` with insertion
  // order as the tiebreak, so the LAST active row is the most recent —
  // robust even when several runs share a millisecond timestamp.
  return active[active.length - 1] ?? null
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`
}

const HELP_TEXT = `Code build — \`/code\` cheatsheet (powered by foundational Trident):

- \`/code <task description>\` — autonomous Forge → Argus → merge loop.
- \`/code stop\` (alias \`/code cancel\`) — stop the most-recent in-flight build in this project.
- \`/code stop <run_id>\` — stop a specific run by id (prefix ok).

Governed repos (a \`SPEC.md\` at the root) run the Ralph plan↔task loop automatically.

The build runs autonomously and survives restarts — state lives in the \`code_trident_runs\` table, driven by the tick loop.`
