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
/** What the poll actually saw. A bare boolean could not say WHY it was false,
 * and that single bit cost two wrong root causes on #1100: "the directory does
 * not exist", "it exists and holds other work", and "it holds our worker" are
 * three different failures that read identically as `false`. */
interface SubagentObservation {
  /** ABSENT and UNREADABLE are not one fact. `absent` is a real ENOENT — no
   * worker has ever spawned here. `unreadable` is any other readdir failure
   * (ENOTDIR, permissions, I/O): the host could not find out, and reporting
   * that as absence asserts something it never established. */
  readonly directory: 'readable' | 'absent' | 'unreadable'
  /** Why it was unreadable, when it was. */
  readonly reason?: string
  /** `agent-*.meta.json` files present, whatever work they describe. */
  readonly metaFiles: number
  /** One of them names THIS step. */
  readonly matched: boolean
}

async function observeSubagents(directory: string, description: string): Promise<SubagentObservation> {
  let metaFiles = 0
  let matched = false
  let names: string[]
  try {
    names = await readdir(directory)
  } catch (error) {
    // KEY ON THE CODE, NOT ON THE FACT THAT IT THREW. Only ENOENT is absence.
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { directory: 'absent', metaFiles: 0, matched: false }
    return { directory: 'unreadable', reason: code ?? (error instanceof Error ? error.message : String(error)), metaFiles: 0, matched: false }
  }
  for (const name of names) {
    if (!/^agent-.+\.meta\.json$/.test(name)) continue
    metaFiles += 1
    try {
      const meta = JSON.parse(await readFile(join(directory, name), 'utf8'))
      if (meta?.description === description) matched = true
    } catch { /* Partial writes and unreadable metadata are not proof. */ }
  }
  return { directory: 'readable', metaFiles, matched }
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
        // A submit that THREW propagates, by an existing contract the suite pins
        // (`claude-acting-turn.test.ts` — a lost acknowledgement REJECTS). It is
        // already distinguishable downstream: the outer catch reports "Dispatch
        // or observation interrupted", not "did not accept the dispatch". Do not
        // swallow it here to add a detail that already exists.
        await child.submitLine!(
          'Execute the prompt in this JSON dispatch specification: ' + JSON.stringify({ ...spec, effort: request.effort }),
          stopped,
        )
        const dispatchDeadline = Math.min(deadline, clock.now() + DISPATCH_TIMEOUT_MS)
        let accepted = false
        let seen: SubagentObservation = { directory: 'absent', metaFiles: 0, matched: false }
        while (!expired()) {
          try {
            const trailer = await stat(request.result.path)
            if (trailer.isFile()) return { kind: 'turn-ended' as const }
            throw new Error('Claude trailer path is not a file')
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
          seen = await observeSubagents(subagents, `${request.role}: ${request.step_id}`)
          accepted ||= seen.matched
          if (!accepted && clock.now() >= dispatchDeadline) {
            // SAY WHAT WAS OBSERVED, NOT JUST THAT TIME RAN OUT. Still `unknown`:
            // none of this proves the worker did or did not run. It says WHICH
            // uncertainty this is, which the bare sentence could not.
            // `submitLine` resolving means the TERMINAL acknowledged text and
            // Enter — `pty-host.ts:194-195` says explicitly that neither backend
            // asserts the REPL acted. So this must not be reported as acceptance.
            const where = seen.directory === 'readable'
              ? `directory exists with ${seen.metaFiles} agent metadata file(s), none naming this step`
              : seen.directory === 'absent'
                ? 'directory does not exist'
                : `directory could not be read (${seen.reason})`
            return { kind: 'unknown' as const, detail: `The REPL did not accept the dispatch within its budget; subagent completion is unknown. Terminal acknowledged text and Enter, which is not evidence the REPL acted; polled ${subagents} — ${where}.` }
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
