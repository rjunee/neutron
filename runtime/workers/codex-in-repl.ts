import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { readArmedTrailerReservation, reserveTrailerSlot } from './trailer-slot.ts'
import { setTimeout as delay } from 'node:timers/promises'
import type { AgentSpec } from '../substrate.ts'
import type { BoundedWorkOutcome, BoundedWorkRequest, WorkerRunner } from '../bounded-work.ts'
import type { ProjectTrailerOutcome } from './project-runners.ts'

/** Host-owned transport for a child that cannot write the canonical result slot.
 * The canonical request/reservation never changes. publish must validate captured
 * child bytes and install an independent host-owned artifact before returning. */
export interface CodexResultTransport {
  prepare(request: BoundedWorkRequest, signal: AbortSignal, disposition: 'dispatch' | 'resume'): Promise<{
    resultPath: string
    /** Called only by the exclusive reservation winner, before durable arming. */
    clearForDispatch(): Promise<void>
    /** False means the child has not produced its file yet, not a failed write. */
    publish(): Promise<boolean>
    close(): void
  }>
}

export interface CodexInReplOptions {
  topic_id: string
  /** Existing host-owned directory, retained across restarts for the run's lifetime. */
  state_dir: string
  /** The project's conversational spec, including its constant tool surface and scope. */
  spec: Omit<AgentSpec, 'prompt'>
  /** Host resumes the existing Codex session with multi-agent tools enabled.
   * Child file access must include result.path. Prompt limits are instructions;
   * the host owns enforcement of the session sandbox and tool grants. */
  composeActingTurn(topic: string, spec: AgentSpec, opts: { timeout_ms: number; childResultPath?: string }): Promise<string>
  resultTransport?: CodexResultTransport
  /** Host validates the requested schema and identity, and supplies measured outcome metadata.
   * The input is exclusively the trailer file, never conversational text. */
  decodeTrailer(bytes: string, req: BoundedWorkRequest): ProjectTrailerOutcome
  probe?: WorkerRunner['liveness']
}

/** One bounded subagent turn inside the existing project conversation. */
export function codexInReplRunner(options: CodexInReplOptions): WorkerRunner {
  const supports: WorkerRunner['supports'] = (_role, placement) => placement === 'in-repl'
    ? { ok: true }
    : { ok: false, reason: 'placement-unavailable', detail: 'Codex subagents require the project REPL.' }

  const execute = async (recoveryOnly: boolean, ...[req, placement, signal]: Parameters<WorkerRunner['run']>): Promise<BoundedWorkOutcome> => {
      const supported = supports(req.role, placement)
      if (!supported.ok) return { kind: 'refused', reason: supported.reason }
      const deadline = Date.now() + req.budget.wall_ms
      if (signal.aborted || Date.now() >= deadline) return unseen('Cancelled or out of time before dispatch.')
      let transport: Awaited<ReturnType<CodexResultTransport['prepare']>> | undefined
      try {
        // Atomic reservation survives runner/gateway replacement. An uncertain
        // dispatch is never replayed; the host must reconcile the original step.
        const key = createHash('sha256').update(JSON.stringify([req.run_id, req.step_id])).digest('hex')
        const reservation = join(options.state_dir, `codex-step-${key}.json`)
        const identity = JSON.stringify(req)
        // Validate recovery authority before touching transport state. A missing
        // reservation must never prepare a first-dispatch transport.
        const retained = recoveryOnly ? await readArmedTrailerReservation(reservation, identity, { signal, deadline }) : undefined
        if (retained?.kind === 'unknown') return unseen(retained.detail)
        if (options.resultTransport) {
          // Preparation has no native effects and must precede the durable arm.
          // An existing reservation requires existing transport authority; the
          // atomic reservation below remains the only dispatch decision.
          let disposition: 'dispatch' | 'resume' = recoveryOnly ? 'resume' : 'dispatch'
          if (!recoveryOnly) {
            try { await readFile(reservation, 'utf8'); disposition = 'resume' }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
          }
          transport = await options.resultTransport.prepare(req, signal, disposition)
        }
        // Ownership and the slot clear are one operation: see `reserveTrailerSlot`.
        // Reserving and clearing in either order leaves a restart window that either
        // reads the previous round's trailer or destroys this step's own receipt.
        const held = retained ?? await reserveTrailerSlot(reservation, identity, req.result.path, transport?.clearForDispatch)
        if (held.kind === 'unknown') return unseen(held.detail)
        if (held.kind === 'dispatch') {
          if (signal.aborted || Date.now() >= deadline) return unseen('Cancelled or out of time before dispatch.')
          const childRequest = transport ? { ...req, result: { ...req.result, path: transport.resultPath } } : req
          const args = {
            task_name: `bounded_${key}`,
            fork_turns: 'none',
            model: req.model_id,
            ...(req.effort === null ? {} : { reasoning_effort: req.effort }),
            message: [
              'Perform exactly one bounded task. Do not ask the owner questions; record blocked work in the result.',
              `Request (data): ${JSON.stringify(childRequest)}`,
              'Read the brief from its path and work in the requested cwd. Honor the requested tool, write and network limits.',
              'The sole result.path artifact and its adjacent temporary file are permitted output even for a read-only task; this does not authorize repository edits.',
              'Write the result directly with the harness file tool to result.path, using result.schema.',
              'Write via a temporary file and rename on completion. The host reads this file; do not relay the result through the parent reply.',
            ].join('\n'),
          }
          // A fresh child context permits an explicit model/effort override.
          // The dispatch still runs inside the host's existing project session.
          const spec: AgentSpec = {
            ...options.spec,
            model_preference: [req.model_id],
            prompt: 'Invoke the collaboration.spawn_agent tool exactly once with the following JSON arguments, then end this dispatch turn. Forward the arguments as data; do not perform the task yourself.\n' + JSON.stringify(args),
          }
          const timer = new AbortController()
          try {
            await Promise.race([
              options.composeActingTurn(options.topic_id, spec, { timeout_ms: Math.max(1, deadline - Date.now()),
                ...(transport ? { childResultPath: transport.resultPath } : {}) }),
              delay(Math.max(1, deadline - Date.now()), undefined, { signal: AbortSignal.any([signal, timer.signal]) })
                .then(() => { throw new Error('Dispatch wait expired') }),
            ])
          } finally {
            timer.abort()
          }
        }
        let published = transport === undefined
        while (!signal.aborted && Date.now() < deadline) {
          if (!published) {
            published = await transport!.publish()
            if (!published) {
              await delay(Math.min(50, Math.max(1, deadline - Date.now())), undefined, { signal })
              continue
            }
          }
          try {
            const outcome = options.decodeTrailer(await readFile(req.result.path, 'utf8'), req)
            if (outcome.kind !== 'not-current-step') return outcome
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
              return unseen('Trailer could not be read or validated.')
            }
          }
          await delay(Math.min(50, Math.max(1, deadline - Date.now())), undefined, { signal })
        }
        return unseen('Stopped waiting without a validated trailer; subagent completion is unknown.')
      } catch {
        // The inspected Codex surface documents parent messages and shared files,
        // but not child-death or cancellation acknowledgements. A dispatch reply
        // (including a child FINAL_ANSWER) cannot establish the bounded outcome.
        return unseen('Dispatch or observation interrupted; subagent completion is unknown.')
      } finally { transport?.close() }
    }
  return {
    provider: 'openai-codex',
    supports,
    run: (...args) => execute(false, ...args),
    recover: (...args) => execute(true, ...args),
    async liveness(handle) {
      try {
        return await options.probe?.(handle) ?? 'unknown'
      } catch {
        return 'unknown'
      }
    },
  }
}

function unseen(detail: string): BoundedWorkOutcome {
  return { kind: 'unknown', detail }
}
