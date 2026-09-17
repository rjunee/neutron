import { open, readdir, readFile, stat } from 'node:fs/promises'
import { SUBAGENT_TOOL_NAME } from './claude-tool-contract.ts'
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
  session: Pick<ReplSession, 'sessionId' | 'cwd' | 'child' | 'acquireTurn' | 'toolSurface'>
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

type DispatchConsumption = 'consumed' | 'not-consumed' | 'unreadable'
type TranscriptBoundary = { offset: number; identity?: { dev: number; ino: number } } | undefined

/** Capture under the turn lock, before Enter. Missing files can start at zero;
 * other failures cannot establish a boundary. */
async function transcriptBoundary(transcript: string): Promise<TranscriptBoundary> {
  try {
    const info = await stat(transcript)
    return info.isFile() ? { offset: info.size, identity: { dev: info.dev, ino: info.ino } } : undefined
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { offset: 0 } : undefined
  }
}

/** One read at expiry, never per poll. Persistent history is not evidence of
 * this submission. Replacement or truncation invalidates the captured boundary. */
async function dispatchConsumption(transcript: string, dispatch: string, boundary: TranscriptBoundary, signal: AbortSignal, remainingMs: number): Promise<DispatchConsumption> {
  if (!boundary) return 'unreadable'
  const controller = new AbortController()
  const stopped = AbortSignal.any([signal, controller.signal])
  const timeout = setTimeout(() => controller.abort(), Math.max(1, remainingMs))
  let cancel!: () => void
  const cancelled = new Promise<DispatchConsumption>(resolve => {
    cancel = () => resolve('unreadable')
    stopped.addEventListener('abort', cancel, { once: true })
    if (stopped.aborted) cancel()
  })
  const read = async (): Promise<DispatchConsumption> => {
    let bytes: Buffer
    try {
      const file = await open(transcript, 'r')
      try {
        // A late open owns only cleanup, never a read after the slot was released.
        stopped.throwIfAborted()
        const info = await file.stat()
        stopped.throwIfAborted()
        if (info.size < boundary.offset || (boundary.identity &&
          (info.dev !== boundary.identity.dev || info.ino !== boundary.identity.ino))) return 'unreadable'
        bytes = (await file.readFile({ signal: stopped })).subarray(boundary.offset)
      } finally { await file.close() }
    } catch { return 'unreadable' }
    for (const line of bytes.toString('utf8').split('\n')) {
      try {
        const record = JSON.parse(line) as { type?: unknown; message?: { content?: unknown } }
        if (record.type !== 'user') continue
        const content = record.message?.content
        if (content === dispatch) return 'consumed'
        if (Array.isArray(content) && content.some(block => block !== null && typeof block === 'object'
          && block.type === 'text' && block.text === dispatch)) return 'consumed'
      } catch { /* Partial and unrelated records do not prove consumption. */ }
    }
    return 'not-consumed'
  }
  try {
    return await Promise.race([read(), cancelled])
  } finally {
    clearTimeout(timeout)
    stopped.removeEventListener('abort', cancel)
  }
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
    // A SESSION THAT CANNOT SPAWN A SUBAGENT IS A REFUSAL, NOT AN UNKNOWN. The
    // dispatch submits directly to the pooled child, so this inspects the very
    // session that will receive the line. `toolSurface` is the comma-joined
    // spawn-time surface (`repl-session.ts:172-176`); if it lacks the subagent
    // tool, no worker can be created and polling for one until the budget
    // expires only converts a KNOWN failure into an unknown. Three runs spent
    // 35s each learning nothing this way (#1112).
    // ABSENT IS NOT THE SAME AS LACKING. A surface the host cannot read does not
    // establish that the session is incapable — it establishes that the host
    // cannot tell. Both refuse (dispatching blind is worse), but they are
    // different facts and an operator acts on them differently.
    if (typeof session.toolSurface !== 'string') {
      return refuse(`Claude session tool surface is unreadable (${typeof session.toolSurface}); cannot establish whether ${SUBAGENT_TOOL_NAME} is available.`)
    }
    if (!session.toolSurface.split(',').includes(SUBAGENT_TOOL_NAME)) {
      return refuse(`Claude session cannot create a subagent: its tool surface (${session.toolSurface || '<empty>'}) does not carry ${SUBAGENT_TOOL_NAME}.`)
    }

    const deadline = clock.now() + Math.min(timeout_ms, request.budget.wall_ms)
    const timer = new AbortController()
    const stopped = AbortSignal.any([signal, timer.signal])
    const expired = () => stopped.aborted || clock.now() >= deadline
    const unknown = () => ({ kind: 'unknown' as const, detail: 'Claude trailer not observed before cancellation or host budget expiry.' })
    // The late-acquired slot releases itself, and checks the deadline before any
    // actuation. Racing acquisition must never dispatch after the caller times out.
    let readingConsumption = false
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
        const dispatch = 'Execute the prompt in this JSON dispatch specification: ' + JSON.stringify({ ...spec, effort: request.effort })
        const boundary = await transcriptBoundary(transcript)
        if (expired()) return unknown()
        await child.submitLine!(dispatch, stopped)
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
            readingConsumption = true
            const consumption = await dispatchConsumption(transcript, dispatch, boundary, stopped, deadline - clock.now())
            const detail = consumption === 'consumed'
              ? 'The REPL consumed the dispatch, but no worker was observed within its budget.'
              : consumption === 'not-consumed'
                ? 'The dispatch line was never consumed by the REPL within its budget.'
                : 'The session transcript could not be read across the dispatch boundary; REPL consumption is unknown.'
            const where = seen.directory === 'readable'
              ? `directory exists with ${seen.metaFiles} agent metadata file(s), none naming this step`
              : seen.directory === 'absent'
                ? 'directory does not exist'
                : `directory could not be read (${seen.reason})`
            return { kind: 'unknown' as const, detail: `${detail} No worker was observed for this dispatch within its budget; subagent completion is unknown. Terminal acknowledged text and Enter, which is not evidence the REPL acted; polled ${subagents} — ${where}.` }
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
      const observation = observe()
      const interrupted = () => {
        if (readingConsumption) {
          timer.abort()
          return observation
        }
        return unknown()
      }
      return await Promise.race([
        observation,
        delay(Math.max(1, deadline - clock.now()), undefined, { signal: stopped }).then(interrupted, () => {
          if (signal.aborted) return interrupted()
          throw new Error('Claude trailer wait interrupted')
        }),
      ])
    } finally {
      timer.abort()
    }
  }
}
