import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { sessionJsonlPath } from '../adapters/claude-code/persistent/jsonl-resumability.ts'
import type { ToolGrant } from '../bounded-work.ts'
import type { ReplSession } from '../adapters/claude-code/persistent/repl-session.ts'
import type { ProjectActingTurn } from './project-runners.ts'

/** Host-owned launch observation, bound to this exact live session. The host must
 * replace this binding when the session is replaced; never derive it from a request.
 * The child must come from HerdrHost, whose submitLine uses herdrCall via its RPC. */
export interface ClaudeActingSession {
  project_id: string
  topic_id: string
  session: Pick<ReplSession, 'sessionId' | 'cwd' | 'child' | 'acquireTurn'>
  projects_dir?: string
  grants: { tools: ToolGrant; writable: boolean; network: boolean; roots: readonly string[] }
}

const toolRank: Record<ToolGrant, number> = { none: 0, 'read-only': 1, edit: 2, 'edit-and-run': 3 }

export const DISPATCH_TIMEOUT_MS = 35_000

interface ObservationClock {
  now(): number
  pause(ms: number, signal: AbortSignal): Promise<void>
}

/** Metadata proves creation, not current liveness or completion. */
async function subagentCreated(directory: string, description: string): Promise<boolean> {
  try {
    for (const name of await readdir(directory)) {
      if (!/^agent-.+\.meta\.json$/.test(name)) continue
      try {
        const meta = JSON.parse(await readFile(join(directory, name), 'utf8'))
        if (meta?.description === description) return true
      } catch { /* Partial writes and unreadable metadata are not proof. */ }
    }
  } catch { /* Missing or unreadable directory is not proof. */ }
  return false
}

/** Continue the bound project conversation. No spawn, retry or reply observation. */
export function createClaudeActingTurn(binding: ClaudeActingSession, clock: ObservationClock = { now: Date.now, pause: async (ms, signal) => { await delay(ms, undefined, { signal }) } }): ProjectActingTurn {
  const { project_id, topic_id, session } = binding
  const grants = { ...binding.grants, roots: [...binding.grants.roots] }
  const roots = [session.cwd, ...grants.roots].map(root => resolve(root))
  const child = session.child
  const transcript = sessionJsonlPath(session.sessionId, session.cwd, binding.projects_dir)
  const subagents = join(transcript.slice(0, -'.jsonl'.length), 'subagents')
  return async ({ conversation, request, spec, timeout_ms, signal }) => {
    const refuse = (detail: string) => ({ kind: 'refused' as const, reason: 'capability-unsupported' as const, detail })
    if (conversation.provider !== 'anthropic') return refuse(`Claude acting turn refuses provider ${conversation.provider}.`)
    if (conversation.project_id !== project_id || conversation.topic_id !== topic_id) return refuse('Project conversation does not match the bound Claude session.')
    if (request.thread !== null && request.thread.id !== session.sessionId) return refuse('Requested thread does not match the project Claude session.')
    if (!roots.some(root => {
      const path = relative(root, resolve(request.cwd))
      return path.split(sep)[0] !== '..'
    })) return refuse('Requested cwd unavailable outside the granted roots of the project Claude session.')
    if (toolRank[request.tools] > toolRank[grants.tools]) return refuse(`Requested tools ${request.tools} unavailable in Claude session.`)
    if (request.writable && !grants.writable) return refuse('Requested writable access unavailable in Claude session.')
    if (request.network && !grants.network) return refuse('Requested network access unavailable in Claude session.')
    if (!child.submitLine) return refuse('Claude session lacks acknowledged submitLine.')

    const deadline = clock.now() + Math.min(timeout_ms, request.budget.wall_ms)
    const timer = new AbortController()
    const stopped = AbortSignal.any([signal, timer.signal])
    const expired = () => stopped.aborted || clock.now() >= deadline
    const unknown = () => ({ kind: 'unknown' as const, detail: 'Claude trailer not observed before cancellation or host budget expiry.' })
    // The late-acquired slot releases itself, and checks the deadline before any
    // actuation. Racing acquisition must never dispatch after the caller times out.
    const observe = async () => {
      const release = await session.acquireTurn()
      try {
        if (expired()) return unknown()
        // JSON escapes newlines: submitLine accepts one line and owns text/Enter ordering.
        // Forward the complete dispatch spec and effort as data, not shell commands.
        await child.submitLine!(
          'Execute the prompt in this JSON dispatch specification: ' + JSON.stringify({ ...spec, effort: request.effort }),
          stopped,
        )
        const dispatchDeadline = Math.min(deadline, clock.now() + DISPATCH_TIMEOUT_MS)
        let accepted = false
        while (!expired()) {
          try {
            const trailer = await stat(request.result.path)
            if (trailer.isFile()) return { kind: 'turn-ended' as const }
            throw new Error('Claude trailer path is not a file')
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
          accepted ||= await subagentCreated(subagents, `${request.role}: ${request.step_id}`)
          if (!accepted && clock.now() >= dispatchDeadline) {
            return { kind: 'unknown' as const, detail: 'The REPL did not accept the dispatch within its budget; subagent completion is unknown.' }
          }
          const nextDeadline = accepted ? deadline : dispatchDeadline
          await clock.pause(Math.min(25, Math.max(1, nextDeadline - clock.now())), stopped)
        }
        return unknown()
      } finally {
        release()
      }
    }
    try {
      if (expired()) return unknown()
      return await Promise.race([
        observe(),
        delay(Math.max(1, deadline - clock.now()), undefined, { signal: stopped }).then(unknown, () => {
          if (signal.aborted) return unknown()
          throw new Error('Claude trailer wait interrupted')
        }),
      ])
    } finally {
      timer.abort()
    }
  }
}
