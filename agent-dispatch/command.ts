/**
 * @neutronai/agent-dispatch — the `/dispatch` chat command.
 *
 * The owner-facing twin of the `dispatch_agent` tool (`tool.ts`). Agent-native
 * parity: this command and the tool call the SAME `DispatchService.dispatch`
 * backend — neither owns dispatch logic. Mirrors the `/code` command shape
 * (`trident/code-command.ts`) so the parser/executor split + the chat-bridge
 * `ChatCommandFilter` wiring carry over unchanged.
 *
 * Grammar:
 *   /dispatch research <task>   → dispatch the Atlas research specialist
 *   /dispatch review   <task>   → dispatch the Sentinel review specialist
 *   /dispatch <anything else>   → dispatch an ad-hoc agent on the whole body
 *   /dispatch stop [run_id]     → stop a live dispatch (most-recent, or by id)
 *   /dispatch                   → help
 *   /dispatch help              → help
 */

import type { DispatchKind } from './prompts.ts'
import type { DispatchService } from './service.ts'

export type DispatchCommand =
  | { kind: 'dispatch'; dispatch_kind: DispatchKind; task: string }
  | { kind: 'stop'; run_ref?: string }
  | { kind: 'help' }
  | { kind: 'unrecognized'; reason: string }

export type DispatchCommandErrorCode = 'malformed' | 'unknown_run' | 'backend_error'

export interface DispatchCommandResponse {
  text: string
  data?: unknown
  error?: { code: DispatchCommandErrorCode; message: string }
}

const VERB = '/dispatch'
const NAMED_KINDS: ReadonlyArray<Exclude<DispatchKind, 'adhoc'>> = ['research', 'review']

/**
 * Pure parser. `/dispatch` alone → help; `/dispatch stop [id]` → stop;
 * `/dispatch research|review <task>` → a named dispatch; anything else → an
 * ad-hoc dispatch on the whole body.
 */
export function parseDispatchCommand(raw: string): DispatchCommand {
  const trimmed = raw.trimStart()
  if (!trimmed.startsWith(VERB)) return { kind: 'unrecognized', reason: 'not_a_dispatch_command' }
  const after = trimmed.slice(VERB.length)
  if (after.length > 0 && !/^\s/.test(after)) {
    return { kind: 'unrecognized', reason: 'not_a_dispatch_command' }
  }
  const body = after.trim()
  if (body.length === 0) return { kind: 'help' }

  const m = /^(\S+)(?:\s+([\s\S]*))?$/.exec(body)
  if (m === null) return { kind: 'unrecognized', reason: 'malformed' }
  const sub = (m[1] ?? '').toLowerCase()
  const rest = (m[2] ?? '').trim()

  if (sub === 'help') return { kind: 'help' }
  if (sub === 'stop' || sub === 'cancel') {
    return rest.length === 0 ? { kind: 'stop' } : { kind: 'stop', run_ref: rest }
  }
  for (const named of NAMED_KINDS) {
    if (sub === named) {
      if (rest.length === 0) {
        return {
          kind: 'unrecognized',
          reason: `\`/dispatch ${named}\` needs a task — try \`/dispatch ${named} <what to do>\`.`,
        }
      }
      return { kind: 'dispatch', dispatch_kind: named, task: rest }
    }
  }
  // No recognised sub-verb → the whole body is an ad-hoc task.
  return { kind: 'dispatch', dispatch_kind: 'adhoc', task: body }
}

export interface DispatchCommandContext {
  service: DispatchService
  /** Where the dispatch result should report back (the originating topic). */
  delivery_target?: { channel: string; binding_id: string }
}

/** Dispatch the parsed command against the service. */
export async function executeDispatchCommand(
  cmd: DispatchCommand,
  ctx: DispatchCommandContext,
): Promise<DispatchCommandResponse> {
  switch (cmd.kind) {
    case 'help':
      return { text: HELP_TEXT }
    case 'unrecognized':
      return {
        text: `Sorry, I couldn't parse that \`/dispatch\` command (${cmd.reason}). Try \`/dispatch help\`.`,
        error: { code: 'malformed', message: cmd.reason },
      }
    case 'dispatch':
      return executeDispatch(cmd, ctx)
    case 'stop':
      return executeStop(cmd, ctx)
  }
}

/**
 * Top-level entry the chat bridge calls per inbound message. Returns `null`
 * when the body isn't a `/dispatch` command (so the bridge falls through to the
 * LLM path) — same contract as `/code`'s `parseAndExecuteCodeCommand`.
 */
export async function parseAndExecuteDispatchCommand(
  raw: string,
  ctx: DispatchCommandContext,
): Promise<DispatchCommandResponse | null> {
  const cmd = parseDispatchCommand(raw)
  if (cmd.kind === 'unrecognized' && cmd.reason === 'not_a_dispatch_command') return null
  return executeDispatchCommand(cmd, ctx)
}

async function executeDispatch(
  cmd: Extract<DispatchCommand, { kind: 'dispatch' }>,
  ctx: DispatchCommandContext,
): Promise<DispatchCommandResponse> {
  try {
    const req: Parameters<DispatchService['dispatch']>[0] = {
      kind: cmd.dispatch_kind,
      task: cmd.task,
    }
    if (ctx.delivery_target !== undefined) req.delivery_target = ctx.delivery_target
    const handle = await ctx.service.dispatch(req)
    const label = LABEL_BY_KIND[cmd.dispatch_kind]
    return {
      text:
        `🛠 Dispatched ${label} \`${handle.run_id.slice(0, 8)}\` on: ` +
        `\`${truncate(cmd.task, 60)}\`. It runs autonomously and I'll surface the result here. ` +
        `Send \`/dispatch stop ${handle.run_id.slice(0, 8)}\` to cancel.`,
      data: { run_id: handle.run_id, kind: cmd.dispatch_kind, agent_kind: handle.record.agent_kind },
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      text: `🛠 \`/dispatch\` could not start the agent: ${message}`,
      error: { code: 'backend_error', message },
    }
  }
}

async function executeStop(
  cmd: Extract<DispatchCommand, { kind: 'stop' }>,
  ctx: DispatchCommandContext,
): Promise<DispatchCommandResponse> {
  const live = ctx.service.liveDispatches()
  if (live.length === 0) {
    return cmd.run_ref !== undefined
      ? {
          text: `🛠 No live dispatch matching \`${cmd.run_ref}\`.`,
          error: { code: 'unknown_run', message: `no live dispatch ${cmd.run_ref}` },
        }
      : { text: '🛠 No live dispatch to stop.' }
  }
  const run_ref = cmd.run_ref
  const target =
    run_ref !== undefined
      ? live.find((r) => r.run_id === run_ref || r.run_id.startsWith(run_ref))
      : // No id → the most-recently-started live dispatch.
        [...live].sort((a, b) => a.started_at - b.started_at).at(-1)
  if (target === undefined) {
    return {
      text: `🛠 No live dispatch matching \`${cmd.run_ref ?? ''}\`.`,
      error: { code: 'unknown_run', message: `no live dispatch ${cmd.run_ref ?? ''}` },
    }
  }
  const stopped = await ctx.service.stop(target.run_id)
  if (!stopped) {
    return {
      text: `🛠 Dispatch \`${target.run_id.slice(0, 8)}\` was already finished.`,
      error: { code: 'unknown_run', message: `dispatch ${target.run_id} not live` },
    }
  }
  return {
    text: `🛠 Stopped dispatch \`${target.run_id.slice(0, 8)}\` (${target.agent_kind}).`,
    data: { run_id: target.run_id },
  }
}

const LABEL_BY_KIND: Readonly<Record<DispatchKind, string>> = {
  research: 'research agent (Atlas)',
  review: 'review agent (Sentinel)',
  adhoc: 'ad-hoc agent',
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`
}

const HELP_TEXT = `Dispatch a background agent — \`/dispatch\` cheatsheet:

- \`/dispatch research <task>\` — Atlas: research / analysis / ops / strategy / writing.
- \`/dispatch review <task>\` — Sentinel: an independent quality check of non-code work.
- \`/dispatch <task>\` — an ad-hoc background agent that just runs the task.
- \`/dispatch stop\` — stop the most-recent live dispatch.
- \`/dispatch stop <run_id>\` — stop a specific dispatch by id (prefix ok).

Each agent runs autonomously in its own session and reports its result back here when done. Concurrency is capped and every dispatch is supervised by the watchdog.`
