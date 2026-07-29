/**
 * @neutronai/tasks-core — chat-command parser + dispatcher.
 *
 * The Tasks Core's headline UX wraps the canonical `tasks/` substrate
 * in four `/task ...` chat commands so a user can capture, mark done,
 * list, and pick-next without leaving the chat thread:
 *
 *   - `/task <body>`               — create an open task in the current project
 *   - `/task done <id_or_match>`   — mark a task done (id OR fuzzy substring)
 *   - `/task list [project_id?]`   — list open tasks (newest-first by focus_score)
 *   - `/task focus [project_id?]`  — LLM-driven pick-next (one most important)
 *   - `/task` / `/task help`       — emit the cheatsheet
 *
 * Disambiguation rule: when the first whitespace-separated token after
 * `/task ` matches one of the four verbs (`done` / `list` / `focus` /
 * `help`) AND the rest fits the verb's argument shape, route to the
 * verb. Otherwise treat the whole body as a capture (so a user typing
 * `/task list of follow-ups for Anna` still creates the right task).
 *
 * The parser is a pure function; only the dispatcher reaches the
 * `TaskStore` or the `PickNextService`. The dispatcher returns a
 * channel-agnostic `TaskCommandResponse` envelope that the chat-bridge
 * converts to the active channel's outbound shape (Telegram bullet
 * list vs Expo `agent_message` envelope vs MCP tool-call payload).
 *
 * Spec input: docs/plans/tasks-core-tier1-brief.md § 3.2.
 */

import type { TaskRow, TaskStore } from './backend.ts'
import type { PickNextService } from './pick-next.ts'

/** The four verbs the parser recognises plus the help and fallthrough cases. */
export type TaskCommand =
  | { kind: 'capture'; body: string }
  | { kind: 'done'; target: string }
  | { kind: 'list'; project_id?: string }
  | { kind: 'focus'; project_id?: string }
  | { kind: 'help' }
  | { kind: 'unrecognized'; reason: string }

/**
 * The `/task` literal — exported so the chat-bridge integration can
 * dispatch on the same constant the parser uses.
 */
export const TASK_COMMAND_PREFIX = '/task' as const

/**
 * Pure parser. Returns `null` when the raw body doesn't start with
 * the `/task` verb at all (the chat-bridge falls through to the LLM
 * path in that case). Otherwise returns a `TaskCommand` shape — the
 * dispatcher consumes the discriminated union.
 *
 * The parser only does shape work — it does not touch the store, it
 * does not resolve fuzzy matches, it does not validate project ids.
 * Those happen in `executeTaskCommand`.
 */
export function parseTaskCommand(raw: string): TaskCommand | null {
  const trimmed = raw.trimStart()
  if (!trimmed.toLowerCase().startsWith(TASK_COMMAND_PREFIX)) return null
  const afterPrefix = trimmed.slice(TASK_COMMAND_PREFIX.length)
  // Allow `/task` (no arg), `/task help`, `/task <verb> <args>`.
  // Any non-whitespace immediately after `/task` (e.g. `/taskish`)
  // means the body isn't a task command — fall through to the LLM.
  if (afterPrefix.length > 0 && !/^\s/.test(afterPrefix)) return null
  const rest = afterPrefix.trimStart()
  if (rest.length === 0) return { kind: 'help' }

  const firstSpace = rest.search(/\s/)
  const verb = (firstSpace === -1 ? rest : rest.slice(0, firstSpace)).toLowerCase()
  const args = firstSpace === -1 ? '' : rest.slice(firstSpace + 1).trim()

  switch (verb) {
    case 'help':
    case '--help':
    case '-h':
      return { kind: 'help' }
    case 'done':
    case 'complete':
    case 'finish':
      if (args.length === 0) {
        return { kind: 'unrecognized', reason: '`/task done <id_or_match>` requires a task id or partial title' }
      }
      return { kind: 'done', target: args }
    case 'list':
    case 'ls': {
      // `args` may carry a single project id token (no spaces, no
      // body). When it's empty we list the current chat project.
      if (args.length === 0) return { kind: 'list' }
      if (/\s/.test(args)) {
        // `/task list of follow-ups for Anna` was clearly a capture.
        return { kind: 'capture', body: rest }
      }
      return { kind: 'list', project_id: args }
    }
    case 'focus':
    case 'next':
    case 'pick': {
      if (args.length === 0) return { kind: 'focus' }
      if (/\s/.test(args)) return { kind: 'capture', body: rest }
      return { kind: 'focus', project_id: args }
    }
    default:
      // Anything else is a capture body — the user typed `/task ship
      // the cm-engine PR`.
      return { kind: 'capture', body: rest }
  }
}

/** One inline button on a `TaskCommandResponse`. */
export interface TaskCommandButton {
  id: string
  label: string
  /** Opaque token the channel surface routes back on click. */
  value: string
}

/** Error codes the parser/dispatcher emits on the response envelope. */
export type TaskCommandErrorCode =
  | 'malformed'
  | 'unknown_task'
  | 'multiple_matches'
  | 'empty_project'
  | 'capability_denied'
  | 'pick_next_unavailable'

export interface TaskCommandResponse {
  /** Short confirmation / result one-liner for the chat reply. */
  text: string
  /** Optional structured result (task row / list / pick-next envelope). */
  data?: unknown
  /** Optional deep-link the channel may surface as a tap target. */
  deep_link?: string
  /** Optional inline buttons (P5.1 button primitives) for the chat surface. */
  buttons?: TaskCommandButton[]
  /** True iff the command was malformed or the dispatcher refused. */
  error?: { code: TaskCommandErrorCode; message: string }
  /**
   * Tells the chat-bridge whether to short-circuit the LLM dispatch
   * (true; the response IS the reply) or fall through to the LLM
   * (false; the parser didn't recognise the body).
   */
  short_circuit_llm: boolean
}

export interface ExecuteTaskCommandContext {
  /** Substrate-backed TaskStore (Core's adapter). */
  store: TaskStore
  /** LLM-driven pick-next service — chat-bridge injects per instance. */
  pickNext: PickNextService
  /** project_id resolved from chat context (ProjectStateProvider). */
  project_id: string | undefined
  /** Identity for audit + future preference seeding. */
  user_id: string
}

/**
 * Dispatcher — calls the matching `TaskStore` method (via the Core's
 * substrate-backed adapter) and returns a render-ready envelope.
 */
export async function executeTaskCommand(
  cmd: TaskCommand,
  ctx: ExecuteTaskCommandContext,
): Promise<TaskCommandResponse> {
  switch (cmd.kind) {
    case 'help':
      return helpResponse()
    case 'unrecognized':
      return {
        text: `Couldn't parse /task input: ${cmd.reason}. Type \`/task help\` for the cheatsheet.`,
        error: { code: 'malformed', message: cmd.reason },
        short_circuit_llm: true,
      }
    case 'capture':
      return captureResponse(cmd.body, ctx)
    case 'done':
      return doneResponse(cmd.target, ctx)
    case 'list':
      return listResponse(cmd.project_id ?? ctx.project_id, ctx)
    case 'focus':
      return focusResponse(cmd.project_id, ctx)
  }
}

function helpResponse(): TaskCommandResponse {
  const lines = [
    '`/task <text>` — capture a task in the current project',
    '`/task done <id_or_match>` — mark a task complete',
    '`/task list [project_id]` — list open tasks (focus order)',
    '`/task focus [project_id]` — pick the one to do next (LLM)',
  ]
  return {
    text: `Tasks Core commands:\n${lines.join('\n')}`,
    short_circuit_llm: true,
  }
}

async function captureResponse(
  body: string,
  ctx: ExecuteTaskCommandContext,
): Promise<TaskCommandResponse> {
  const title = body.trim()
  if (title.length === 0) {
    return {
      text: 'Empty task body — `/task <text>` requires a title.',
      error: { code: 'malformed', message: 'empty body' },
      short_circuit_llm: true,
    }
  }
  try {
    const createInput: Parameters<TaskStore['create']>[0] = { title }
    if (ctx.project_id !== undefined) createInput.project_id = ctx.project_id
    const task = await ctx.store.create(createInput)
    // ISSUE #18 follow-up — capture intentionally does NOT set
    // `deep_link`. The client's `<ChatDeepLinkNavigator>` consumes any
    // top-level `deep_link` and pushes the route immediately, so
    // including it on the capture response would auto-navigate the
    // user the instant they hit Enter — bypassing the explicit "Open"
    // button. Navigation only happens when the user taps Open, which
    // sends the `task:open:<id>` postback through `openPostbackResponse`
    // where the deep_link is set.
    const response: TaskCommandResponse = {
      text: `✅ Captured: ${task.title}`,
      data: { task },
      buttons: [
        { id: 'open', label: 'Open', value: `task:open:${task.id}` },
        { id: 'done', label: 'Mark done', value: `task:done:${task.id}` },
      ],
      short_circuit_llm: true,
    }
    return response
  } catch (err) {
    return {
      text: `Couldn't capture task: ${errMessage(err)}`,
      error: { code: 'malformed', message: errMessage(err) },
      short_circuit_llm: true,
    }
  }
}

async function doneResponse(
  target: string,
  ctx: ExecuteTaskCommandContext,
): Promise<TaskCommandResponse> {
  // Try literal id first.
  try {
    const task = await ctx.store.complete(target)
    return {
      text: `✅ Done: ${task.title}`,
      data: { task },
      short_circuit_llm: true,
    }
  } catch {
    // Fall through to fuzzy match.
  }

  // Fuzzy match against open tasks in the current project (fall back
  // to cross-project if project_id is undefined).
  const listInput: Parameters<TaskStore['list']>[0] = { status: 'open' }
  if (ctx.project_id !== undefined) listInput.project_id = ctx.project_id
  const candidates = await ctx.store.list(listInput)
  const needle = target.toLowerCase()
  const matches = candidates.filter((c) => c.title.toLowerCase().includes(needle))
  if (matches.length === 0) {
    return {
      text: `No open task matches "${target}".`,
      error: { code: 'unknown_task', message: `no match for ${target}` },
      short_circuit_llm: true,
    }
  }
  if (matches.length > 1) {
    const lines = matches
      .slice(0, 5)
      .map((m, i) => `${i + 1}. ${m.title}`)
      .join('\n')
    return {
      text: `Multiple matches for "${target}":\n${lines}\nReply with the number to disambiguate, or pass the full id to \`/task done <id>\`.`,
      data: { matches: matches.slice(0, 5) },
      buttons: matches.slice(0, 5).map((m, i) => ({
        id: `done-${i}`,
        label: `${i + 1}`,
        value: `task:done:${m.id}`,
      })),
      error: { code: 'multiple_matches', message: `${matches.length} matches` },
      short_circuit_llm: true,
    }
  }
  const match = matches[0]
  if (match === undefined) {
    return {
      text: 'Internal error: empty match list after non-empty check.',
      error: { code: 'unknown_task', message: 'empty match list' },
      short_circuit_llm: true,
    }
  }
  const completed = await ctx.store.complete(match.id)
  return {
    text: `✅ Done: ${completed.title}`,
    data: { task: completed },
    short_circuit_llm: true,
  }
}

async function listResponse(
  project_id: string | undefined,
  ctx: ExecuteTaskCommandContext,
): Promise<TaskCommandResponse> {
  const listInput: Parameters<TaskStore['list']>[0] = {
    status: 'open',
    order: 'focus_score',
    limit: 20,
  }
  if (project_id !== undefined) listInput.project_id = project_id
  const rows = await ctx.store.list(listInput)
  if (rows.length === 0) {
    return {
      text: project_id !== undefined
        ? `No open tasks in this project.`
        : `No open tasks. Capture one with \`/task <text>\`.`,
      data: { results: [] },
      short_circuit_llm: true,
    }
  }
  const head = rows.slice(0, 20)
  const lines = head.map((r) => `• ${r.title}${r.due_date !== undefined ? ` (due ${r.due_date})` : ''}`)
  return {
    text: `${head.length} open task${head.length === 1 ? '' : 's'}:\n${lines.join('\n')}`,
    data: { results: head },
    short_circuit_llm: true,
  }
}

async function focusResponse(
  explicit_project_id: string | undefined,
  ctx: ExecuteTaskCommandContext,
): Promise<TaskCommandResponse> {
  // S1 default for the chat command: cross-project unless an explicit
  // project_id was passed (`/task focus my-project-slug`). Documented
  // in PR description; aligns with the owner's daily workflow per the
  // priority-map "one most important thing" framing.
  const pickInput: Parameters<PickNextService['pick']>[0] = { user_id: ctx.user_id }
  if (explicit_project_id !== undefined) pickInput.project_id = explicit_project_id
  let result
  try {
    result = await ctx.pickNext.pick(pickInput)
  } catch (err) {
    return {
      text: `Pick-next unavailable: ${errMessage(err)}`,
      error: { code: 'pick_next_unavailable', message: errMessage(err) },
      short_circuit_llm: true,
    }
  }
  if (result.candidate === null) {
    return {
      text: result.rationale,
      data: { candidate: null, rationale: result.rationale, alternatives: [] },
      short_circuit_llm: true,
    }
  }
  const candidate = result.candidate
  const altLines = result.alternatives.length > 0
    ? `\nAlso open:\n${result.alternatives.map((a) => `• ${a.title}`).join('\n')}`
    : ''
  return {
    text: `🎯 ${candidate.title}\n${result.rationale}${altLines}`,
    data: result,
    buttons: [
      { id: 'done', label: 'Mark done', value: `task:done:${candidate.id}` },
      { id: 'open', label: 'Open', value: `task:open:${candidate.id}` },
    ],
    short_circuit_llm: true,
  }
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
