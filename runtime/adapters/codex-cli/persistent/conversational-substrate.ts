import type { Event } from '../../../events.ts'
import type { SessionHandle } from '../../../session-handle.ts'
import type { Substrate } from '../../../substrate.ts'
import type { OpenCodexProjectSessionOptions } from './project-session.ts'
import { CodexRolloutObserver, type CodexRolloutIdentity, type CodexTurnReceipt } from './rollout-observer.ts'

/** Shared with build and model control; release(refused) must quarantine reuse.
 * An interrupted rollout is not completion: the host must independently prove
 * an acknowledged owner interrupt and settled native work before allowing reuse.
 */
export interface CodexConversationLease {
  readonly identity: CodexRolloutIdentity
  submitLine(prompt: string): Promise<void | CodexTurnReceipt>
  /** Must interrupt only this native turn, never a successor or the whole pane. */
  interrupt(turnId: string): Promise<void>
  isLive(): boolean
  release(outcome: 'completed' | 'interrupted' | 'refused'): Promise<void>
}

export interface CodexConversationHost {
  /**
   * Own the pane exclusively before resolving. Attest its native thread and
   * rollout; cwd/latest-file inference does not satisfy this contract. Abort
   * while queued must withdraw the request without acquiring a later lease.
   */
  acquireTurn(options: OpenCodexProjectSessionOptions, signal: AbortSignal): Promise<CodexConversationLease>
}

export interface CodexConversationalSubstrateOptions extends OpenCodexProjectSessionOptions {
  readonly host: CodexConversationHost
  readonly pollMs?: number
  readonly timeoutMs?: number
}

// An unresolved delivery cannot be retried by creating another wrapper around
// the same shared host. Recovery must provide a newly reconciled host.
const refusedProjects = new WeakMap<CodexConversationHost, Set<string>>()

function untilAborted<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const aborted = (): void => { reject(signal.reason) }
    signal.addEventListener('abort', aborted, { once: true })
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted))
    if (signal.aborted) aborted()
  })
}

/** No headless fallback. The injected shared host is responsible for recovery. */
export function createCodexConversationalSubstrate(options: CodexConversationalSubstrateOptions): Substrate {
  const pollMs = options.pollMs ?? 100
  const timeoutMs = options.timeoutMs ?? 120_000
  if (!(pollMs > 0) || !Number.isFinite(pollMs) || !(timeoutMs > 0) || !Number.isFinite(timeoutMs)) {
    throw new Error('codex conversation requires positive polling and timeout bounds')
  }
  return {
    start(spec): SessionHandle {
      const abort = new AbortController()
      let lease: CodexConversationLease | undefined
      let observer: CodexRolloutObserver | undefined
      let succeeded = false
      let interrupted = false
      let interrupt: Promise<void> | undefined
      let timedOut = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const cancel = async (): Promise<void> => {
        abort.abort(new Error('codex conversation cancelled'))
        if (!succeeded && observer?.turnId !== undefined && lease !== undefined) {
          interrupt ??= lease.interrupt(observer.turnId)
          await interrupt
        }
      }
      const events = (async function* (): AsyncGenerator<Event> {
        try {
          if (abort.signal.aborted) throw new Error('codex conversation cancelled')
          if (!spec.prompt || /\x1b/.test(spec.prompt)) {
            throw new Error('codex conversation refused: prompt must be nonempty and contain no terminal escape')
          }
          const ceiling = spec.turn_absolute_ceiling_ms ?? timeoutMs
          if (!(ceiling > 0) || !Number.isFinite(ceiling)) throw new Error('codex conversation refused: invalid turn bound')
          if (refusedProjects.get(options.host)?.has(options.projectId)) {
            throw new Error('codex conversation refused: project requires native reconciliation')
          }
          timer = setTimeout(() => {
            timedOut = true
            abort.abort(new Error('codex conversation refused: native completion timeout'))
          }, ceiling)
          const model = spec.model_preference[0] ?? options.model
          lease = await untilAborted<CodexConversationLease>(options.host.acquireTurn({ ...options, ...(model === undefined ? {} : { model }) }, abort.signal)
            .then(async (candidate) => {
              if (abort.signal.aborted) {
                await candidate.release('refused')
                throw abort.signal.reason
              }
              return candidate
            }), abort.signal)
          if (abort.signal.aborted) throw new Error('codex conversation cancelled')
          if (refusedProjects.get(options.host)?.has(options.projectId)) {
            throw new Error('codex conversation refused: project requires native reconciliation')
          }
          if (lease.identity.projectId !== options.projectId || lease.identity.cwd !== options.cwd
            || (spec.session !== undefined && spec.session.id !== lease.identity.threadId)) {
            throw new Error('codex conversation refused: host returned a different project or thread')
          }
          observer = new CodexRolloutObserver(lease.identity, spec.prompt)
          if (!lease.isLive()) throw new Error('codex conversation refused: pane is not live')
          observer.bindReceipt(await untilAborted(lease.submitLine(spec.prompt), abort.signal))
          // Acknowledgement is delivery only; the rollout alone can finish.
          yield { kind: 'status', message: 'Waiting for the native Codex turn' }
          while (true) {
            if (abort.signal.aborted) throw abort.signal.reason
            if (!lease.isLive()) throw new Error('codex conversation refused: pane exited before completion')
            const batch = observer.read()
            if (observer.completed) { succeeded = true; clearTimeout(timer) }
            if (observer.interrupted) { interrupted = true; clearTimeout(timer) }
            for (const event of batch) yield event
            if (succeeded || interrupted) return
            await new Promise<void>((resolve) => {
              const done = (): void => { clearTimeout(timer); abort.signal.removeEventListener('abort', done); resolve() }
              const timer = setTimeout(done, pollMs)
              abort.signal.addEventListener('abort', done, { once: true })
              if (abort.signal.aborted) done()
            })
          }
        } catch (error) {
          yield { kind: 'error', message: error instanceof Error ? error.message : 'codex conversation failed',
            retryable: false, ...(timedOut ? { code: 'turn_timeout' as const }
              : abort.signal.aborted ? { code: 'aborted' as const } : {}) }
        } finally {
          clearTimeout(timer)
          if (lease !== undefined && !succeeded && !interrupted) {
            const refused = refusedProjects.get(options.host) ?? new Set<string>()
            refused.add(options.projectId)
            refusedProjects.set(options.host, refused)
          }
          try { if (!succeeded && !interrupted) await cancel() }
          finally {
            observer?.close()
            await lease?.release(succeeded ? 'completed' : interrupted ? 'interrupted' : 'refused')
          }
        }
      })()
      return {
        events,
        cancel,
        tool_resolution: 'internal',
        isAlive: () => lease?.isLive() ?? false,
        async respondToTool() { throw new Error('Codex resolves tools internally') },
      }
    },
  }
}
