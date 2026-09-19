import { readFile, stat } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { ToolGrant } from '../bounded-work.ts'
import { unknownCause } from '../refusal-cause.ts'
import { CodexApprovalRefusedError, type CodexProjectSession } from '../adapters/codex-cli/persistent/project-session.ts'
import { projectTrailerStep, type ProjectActingTurn } from './project-runners.ts'

/** Host-owned session observation. The bound thread is supplied by the host that
 * owns conversation continuity; pane handles are not Codex thread identifiers. */
export interface CodexActingSession {
  project_id: string
  topic_id: string
  thread_id: string
  cwd: string
  session?: (Pick<CodexProjectSession, 'projectId' | 'isLive' | 'screenPrompt' | 'answerApproval'> & {
    /** Resolve only after native parent completion. The host owns exact-turn
     * cancellation and must retain uncertain delivery until reconciliation. */
    submitLine(prompt: string, turn: { signal: AbortSignal; timeout_ms: number }): Promise<void>
  }) | undefined
  grants: { tools: ToolGrant; writable: boolean; network: boolean; roots: readonly string[] }
}

const toolRank: Record<ToolGrant, number> = { none: 0, 'read-only': 1, edit: 2, 'edit-and-run': 3 }

type ActingSession = NonNullable<CodexActingSession['session']>
interface DispatchState {
  tail: Promise<void>
  attempted: Set<string>
  uncertain: boolean
}
// State follows the host-owned session, including across reconstructed bindings.
// Only host reconciliation may replace that session after uncertain delivery.
const dispatchStates = new WeakMap<ActingSession, DispatchState>()

/** Continue the bound Codex project conversation. Transcript text is never completion. */
export function createCodexActingTurn(binding: CodexActingSession): ProjectActingTurn {
  const { project_id, topic_id, thread_id, cwd } = binding
  const grants = { ...binding.grants, roots: [...binding.grants.roots] }
  const roots = [cwd, ...grants.roots].map(root => resolve(root))
  const session = binding.session
  return async ({ conversation, request, spec, timeout_ms, signal }) => {
    const refuse = (detail: string) => ({ kind: 'refused' as const, reason: 'capability-unsupported' as const, detail })
    if (conversation.provider !== 'openai-codex') return refuse(`Codex acting turn refuses provider ${conversation.provider}.`)
    if (conversation.project_id !== project_id || conversation.topic_id !== topic_id) return refuse('Project conversation does not match the bound Codex session.')
    if (request.thread !== null && request.thread.id !== thread_id) return refuse('Requested thread does not match the bound Codex session.')
    if (!roots.some(root => {
      const path = relative(root, resolve(request.cwd))
      return path.split(sep)[0] !== '..'
    })) return refuse('Requested cwd unavailable outside the granted roots of the project Codex session.')
    if (toolRank[request.tools] > toolRank[grants.tools]) return refuse(`Requested tools ${request.tools} unavailable in Codex session.`)
    if (request.writable && !grants.writable) return refuse('Requested writable access unavailable in Codex session.')
    if (request.network && !grants.network) return refuse('Requested network access unavailable in Codex session.')
    if (session === undefined) return refuse('Codex project session is unavailable.')
    if (session.projectId !== project_id) return refuse('Codex project session does not match the bound project.')
    if (!session.isLive()) return refuse('Codex project session is not live.')

    let state = dispatchStates.get(session)
    if (!state) {
      state = { tail: Promise.resolve(), attempted: new Set(), uncertain: false }
      dispatchStates.set(session, state)
    }
    if (state.uncertain) return { kind: 'unknown', detail: 'Codex session requires reconciliation after an uncertain dispatch.' }
    const previous = state.tail
    let release!: () => void
    state.tail = new Promise<void>(resolve => { release = resolve })
    const dispatchId = JSON.stringify([request.run_id, request.step_id])
    let dispatched = false
    let completed = false
    const deadline = Date.now() + Math.min(timeout_ms, request.budget.wall_ms)
    const timer = new AbortController()
    const stopped = AbortSignal.any([signal, timer.signal])
    const expired = () => stopped.aborted || Date.now() >= deadline
    const unknown = () => ({ kind: 'unknown' as const, detail: 'Codex submission completion and child trailer were not both observed before cancellation or host budget expiry.' })
    const answerPrompt = async () => {
      const prompt = session.screenPrompt()
      if (prompt?.kind === 'trust') return refuse('Codex directory trust requires setup outside the bounded worker.')
      if (prompt?.kind === 'approval') {
        // Bounded workers cannot request owner decisions or grant escalation.
        // Deny explicitly so the pane does not remain stuck awaiting a key.
        try { await session.answerApproval('deny') }
        catch (error) {
          if (error instanceof CodexApprovalRefusedError) return refuse(error.message)
          throw error
        }
        return refuse('Codex requested approval outside the bounded worker grants; denied.')
      }
      return undefined
    }
    const observe = async () => {
      await previous
      if (expired()) return unknown()
      if (state.uncertain) return { kind: 'unknown' as const, detail: 'Codex session requires reconciliation after an uncertain dispatch.' }
      if (state.attempted.has(dispatchId)) return { kind: 'unknown' as const, detail: 'Codex run/step was already dispatched; replay requires reconciliation.' }
      if (!session.isLive()) return refuse('Codex project session is not live.')
      const initialPrompt = await answerPrompt()
      if (initialPrompt) return initialPrompt
      if (expired()) return unknown()
      // Record before calling: an acknowledgement can be lost after delivery.
      state.attempted.add(dispatchId)
      dispatched = true
      // JSON escapes newlines. The native owner adapter resolves submission only
      // after parent completion; the legacy pane adapter only acknowledges input.
      // A child trailer must never bypass whichever submission is still pending.
      await session.submitLine('Execute the prompt in this JSON dispatch specification: ' + JSON.stringify({ ...spec, effort: request.effort }), {
        signal: stopped, timeout_ms: Math.max(1, deadline - Date.now()),
      })
      while (!expired()) {
        const approval = await answerPrompt()
        if (approval) return approval
        try {
          const trailer = await stat(request.result.path)
          if (trailer.isFile()) {
            if (projectTrailerStep(await readFile(request.result.path, 'utf8'), request) !== 'not-current-step') {
              if (expired()) return unknown()
              return { kind: 'turn-ended' as const }
            }
          } else {
            throw new Error('Codex trailer path is not a file')
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        await delay(Math.min(25, Math.max(1, deadline - Date.now())), undefined, { signal: stopped })
      }
      return unknown()
    }
    try {
      const result = await Promise.race([
        // Keep queued calls behind the actual observation, even when the caller
        // has returned on timeout. They recheck cancellation before any write.
        observe().then(result => {
          if (dispatched && result.kind !== 'turn-ended') state.uncertain = true
          return result
        }, error => {
          if (dispatched) state.uncertain = true
          throw error
        }).finally(release),
        delay(Math.max(1, deadline - Date.now()), undefined, { signal: stopped }).then(unknown, () => {
          if (signal.aborted) return unknown()
          throw new Error('Codex trailer wait interrupted')
        }),
      ])
      completed = result.kind === 'turn-ended'
      return result
    } catch (error) {
      return { kind: 'unknown', detail: unknownCause('Codex dispatch or trailer observation failed; completion is unknown.', error, request.run_id) }
    } finally {
      if (dispatched && !completed) state.uncertain = true
      timer.abort()
    }
  }
}
