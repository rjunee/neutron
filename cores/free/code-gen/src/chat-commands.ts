/**
 * @neutronai/codegen-core — `/code` chat-command parser + dispatcher.
 *
 * Code-Gen Core S2 (owner-clarified 2026-05-22): the user-facing chat
 * surface is intentionally TWO commands only:
 *
 *   /code <task>            — autonomous Forge → Argus → merge loop.
 *                             The user receives ONE notification when
 *                             the task lands OR a genuine blocker
 *                             surfaces. Auto-merge is ON by default.
 *
 *   /code stop              — emergency stop the most-recent in-flight
 *   /code cancel [<id>]       task in this project; or a specific id.
 *
 * The previous S1 eight-sub-command surface (`status` / `review` /
 * `merge` / `judge` / `history` / `automerge`) was over-engineered for
 * a chat workflow and is GONE. Status questions are answered by the
 * LLM by reading the per-project sidecar (NOT via a sub-command).
 *
 * The parser still recognizes the deleted sub-verb tokens (`status` /
 * `review` / `merge` / `judge` / `history` / `automerge`) so a user who
 * types the old form gets a friendly reject pointing at the new shape
 * instead of accidentally dispatching `/code status` as a task.
 */

import {
  CodegenInputError,
  CodegenTaskNotFoundError,
  type CodegenOrchestrator,
} from './backend.ts'
import type { CodegenSidecar } from './sidecar/store.ts'

const VERB = '/code'

/**
 * Notifier the orchestrator calls when an autonomous task lands
 * (completed / failed / cancelled) so the chat surface can push the
 * single notification promised by the S2 spec. The Core defines this
 * interface; the gateway wires a concrete implementation that posts
 * back into the active chat thread.
 */
export interface CodegenChatNotifier {
  notifyTaskComplete(input: {
    task_id: string
    project_id: string
    user_id: string
    status: 'completed' | 'failed' | 'cancelled'
    summary: string
    pr_number?: number
    pr_url?: string
    sidecar_path?: string
    error_code?: string
    error_message?: string
  }): Promise<void>
}

export type CodeCommand =
  | { kind: 'dispatch'; task: string }
  | { kind: 'stop'; task_id?: string }
  | { kind: 'help' }
  | { kind: 'unrecognized'; reason: string }

export type CodeCommandErrorCode =
  | 'malformed'
  | 'unknown_task'
  | 'unknown_pr'
  | 'worktree_not_resolved'
  | 'subagent_timeout'
  | 'max_rounds_reached'
  | 'gh_unavailable'
  | 'capability_denied'
  | 'backend_error'
  | 'no_credential'

export interface CodeCommandResponse {
  text: string
  data?: unknown
  deep_link?: string
  error?: { code: CodeCommandErrorCode; message: string }
}

/* ============== parser ============== */

/** Sub-verbs that USED to map to dedicated handlers in S1. Typing one
 *  of these now returns a friendly reject pointing at the new shape,
 *  rather than letting the body fall through to `dispatch` (which would
 *  silently kick off a task with `task: 'status'` — bad UX). */
const RETIRED_SUBVERBS = new Set([
  'status',
  'review',
  'merge',
  'judge',
  'history',
  'automerge',
])

/**
 * Pure parser. Splits on whitespace exactly once for the verb;
 * everything after the verb (and a single space) is the body.
 * `/code` alone (no arg) → `{kind:'help'}` so users get a cheatsheet
 * when they discover the command.
 *
 * `stop` / `cancel` parsing:
 *   `/code stop`           → {kind:'stop'} (no task_id; resolved to most-recent in-flight)
 *   `/code cancel`         → {kind:'stop'}
 *   `/code stop <id>`      → {kind:'stop', task_id: '<id>'}
 *   `/code cancel <id>`    → {kind:'stop', task_id: '<id>'}
 */
export function parseCodeCommand(raw: string): CodeCommand {
  const trimmed = raw.trimStart()
  if (!trimmed.startsWith(VERB)) {
    return { kind: 'unrecognized', reason: 'not_a_code_command' }
  }
  const after = trimmed.slice(VERB.length)
  // Must be EOL or whitespace after `/code` — `/codefoo` is not a
  // /code command.
  if (after.length > 0 && !/^\s/.test(after)) {
    return { kind: 'unrecognized', reason: 'not_a_code_command' }
  }
  const body = after.trim()
  if (body.length === 0) return { kind: 'help' }
  // Peel off the sub-verb.
  const m = /^(\S+)(?:\s+([\s\S]*))?$/.exec(body)
  if (m === null) return { kind: 'unrecognized', reason: 'malformed' }
  const sub = (m[1] ?? '').toLowerCase()
  const rest = (m[2] ?? '').trim()
  switch (sub) {
    case 'help':
      return { kind: 'help' }
    case 'stop':
    case 'cancel': {
      if (rest.length === 0) return { kind: 'stop' }
      return { kind: 'stop', task_id: rest }
    }
    default: {
      if (RETIRED_SUBVERBS.has(sub)) {
        return {
          kind: 'unrecognized',
          reason: `\`${sub}\` is no longer a /code sub-command — just type \`/code <your task description>\` to kick off an autonomous build, or \`/code stop\` to cancel.`,
        }
      }
      // No sub-verb match → treat the whole body as a free-form task
      // description (the headline `/code <task>` shape).
      return { kind: 'dispatch', task: body }
    }
  }
}

/* ============== dispatcher ============== */

export interface CodeCommandContext {
  /** Tied to the orchestrator's in-memory tracker for dispatch/cancel. */
  orchestrator: CodegenOrchestrator
  /** Sidecar for the active project; resolved lazily so a parser-only
   *  `/code help` doesn't allocate a SQLite handle. */
  resolve_sidecar: (project_id: string) => Promise<CodegenSidecar>
  /** Active project id (chat-bridge populates from session context). */
  project_id: string
  user_id: string
  now: Date
  /** Optional notifier — the orchestrator's autonomous merge loop calls
   *  this when the run reaches a terminal state. Wired in production;
   *  tests may omit. */
  chat_notifier?: CodegenChatNotifier
  /**
   * S2 (Phase 4) — when the gateway's `buildCodeGenLlmCall` resolved no
   * Anthropic credential, the wiring helper threads the friendly
   * install-hint message through every `CodeCommandContext`. The
   * dispatch path short-circuits with the message BEFORE invoking the
   * orchestrator so the user gets a single clean reply instead of a
   * pending row + a delayed sub-agent dispatch failure.
   *
   * `/code stop` still works in the unavailable state — cancelling a
   * pending row doesn't need a credential.
   */
  unavailable_message?: string
}

/**
 * Dispatch the parsed command. Returns a render-ready envelope; the
 * chat-bridge converts to the channel's message format.
 */
export async function executeCodeCommand(
  cmd: CodeCommand,
  ctx: CodeCommandContext,
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
 * Top-level entry point the chat-bridge calls per inbound message.
 * Returns `null` if the body isn't a `/code` command (so the bridge
 * falls through to the LLM path).
 */
export async function parseAndExecuteCodeCommand(
  raw: string,
  ctx: CodeCommandContext,
): Promise<CodeCommandResponse | null> {
  const cmd = parseCodeCommand(raw)
  if (cmd.kind === 'unrecognized' && cmd.reason === 'not_a_code_command') {
    return null
  }
  return executeCodeCommand(cmd, ctx)
}

/* ============== per-verb implementations ============== */

async function executeDispatch(
  cmd: Extract<CodeCommand, { kind: 'dispatch' }>,
  ctx: CodeCommandContext,
): Promise<CodeCommandResponse> {
  // S2 (Phase 4) — short-circuit when no Anthropic credential resolved
  // at wiring time. Surface the friendly install hint as a `no_credential`
  // error response BEFORE we mint a task_id or touch the orchestrator;
  // there's nothing the runner can do without a credential.
  if (ctx.unavailable_message !== undefined) {
    return {
      text: ctx.unavailable_message,
      error: { code: 'no_credential', message: ctx.unavailable_message },
    }
  }
  try {
    const result = await ctx.orchestrator.dispatch({ task: cmd.task })
    return {
      text: `🛠 Building \`${truncate(cmd.task, 60)}\` — task ${result.task_id.slice(0, 8)}. I'll ping back when it lands or hits a blocker. Send \`/code stop\` to cancel.`,
      data: { task_id: result.task_id },
    }
  } catch (err) {
    if (err instanceof CodegenInputError) {
      return {
        text: `\`/code\` rejected: ${err.message}`,
        error: { code: 'malformed', message: err.message },
      }
    }
    throw err
  }
}

async function executeStop(
  cmd: Extract<CodeCommand, { kind: 'stop' }>,
  ctx: CodeCommandContext,
): Promise<CodeCommandResponse> {
  // Resolve the task_id: either the explicit argument, or the most-
  // recent in-flight task in this project's sidecar.
  let task_id: string | undefined = cmd.task_id
  if (task_id === undefined) {
    try {
      const sidecar = await ctx.resolve_sidecar(ctx.project_id)
      // The sidecar's `list` does not support a status filter; pull a
      // small page and scan in-memory. Anything older than 50 rows back
      // that is still `running`/`pending` is exotic enough to require
      // the explicit-id form.
      const recent = sidecar.tasks.list({ limit: 50 })
      const inflight = recent.find(
        (r) => r.status === 'running' || r.status === 'pending',
      )
      if (inflight !== undefined) {
        task_id = inflight.task_id
      }
    } catch {
      /* sidecar errors fall through to the no-in-flight reply */
    }
    if (task_id === undefined) {
      return {
        text: `🛠 No in-flight Code-Gen task to stop in project \`${ctx.project_id}\`.`,
      }
    }
  }

  try {
    const res = ctx.orchestrator.cancel({ task_id })
    // Persist the cancellation in the sidecar too — the orchestrator's
    // in-memory tracker is the auth source for the chat reply, but the
    // sidecar holds the durable row.
    try {
      const sidecar = await ctx.resolve_sidecar(ctx.project_id)
      if (sidecar.tasks.get(task_id) !== null) {
        sidecar.tasks.update(task_id, {
          status: 'cancelled',
          error_code: 'user_cancelled',
          error_message: 'cancelled via /code stop',
        })
      }
    } catch {
      /* sidecar errors here are best-effort */
    }
    if (!res.cancelled) {
      return {
        text: `Task \`${task_id.slice(0, 8)}\` is already in terminal state (${res.prior_status}).`,
        data: { cancelled: false, prior_status: res.prior_status, task_id },
      }
    }
    return {
      text: `🛠 Cancelled task \`${task_id.slice(0, 8)}\` (was ${res.prior_status}).`,
      data: { cancelled: true, prior_status: res.prior_status, task_id },
    }
  } catch (err) {
    if (err instanceof CodegenTaskNotFoundError) {
      return {
        text: `No task \`${task_id}\` known.`,
        error: { code: 'unknown_task', message: err.message },
      }
    }
    throw err
  }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s
  return `${s.slice(0, n - 1)}…`
}

const HELP_TEXT = `Code-Gen Core — \`/code\` cheatsheet:

- \`/code <task description>\` — autonomous Forge → Argus → merge loop. You get ONE notification when it lands OR a blocker surfaces.
- \`/code stop\` (alias \`/code cancel\`) — emergency stop the most-recent in-flight task in this project.
- \`/code cancel <task_id>\` — cancel a specific task by id.

Auto-merge is ON by default. Argus APPROVE triggers a squash-merge automatically.`
