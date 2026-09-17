import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { AgentSpec } from '../substrate.ts'
import type { BoundedWorkOutcome, BoundedWorkRequest, WorkerRunner } from '../bounded-work.ts'

/** The CLI's subagent tool. ONE definition, because the dispatch prompt below and
 * the REPL's granted `--tools` surface must name the same tool — and for a night
 * they did not. Claude Code 2.1.273 (installed 2026-09-16 20:32) renamed `Task`
 * to `Agent`; the grant list kept saying `Task`, and every dispatch was answered
 * `No such tool available: Agent. Agent is disabled for this session`. No trident
 * worker could be created between that upgrade and this fix, and the failure
 * surfaced only as a dispatch timeout.
 *
 * `gateway/wiring/build-live-agent-turn.ts` imports this into
 * `LIVE_AGENT_TOOL_NAMES` so the grant and the request cannot drift apart again.
 * Gateway depends on runtime and never the reverse, which is why it lives here. */
export const SUBAGENT_TOOL_NAME = 'Agent'

export interface ClaudeInReplOptions {
  topic_id: string
  /** Existing host-owned directory, retained across restarts for the run's lifetime. */
  state_dir: string
  /** The project's conversational spec, including its constant tool surface and scope. */
  spec: Omit<AgentSpec, 'prompt'>
  composeActingTurn(topic: string, spec: AgentSpec, opts: { timeout_ms: number }): Promise<string>
  /** Host validates the requested schema and identity, and supplies measured outcome metadata.
   * The input is exclusively the trailer file, never conversational text. */
  decodeTrailer(bytes: string, req: BoundedWorkRequest): BoundedWorkOutcome
  probe?: WorkerRunner['liveness']
}

/** One bounded subagent turn inside the existing project conversation. */
export function claudeInReplRunner(options: ClaudeInReplOptions): WorkerRunner {
  const supports: WorkerRunner['supports'] = (_role, placement) => placement === 'in-repl'
    ? { ok: true }
    : { ok: false, reason: 'placement-unavailable', detail: 'Claude subagents require the project REPL.' }

  return {
    provider: 'anthropic',
    supports,
    async run(req, placement, signal) {
      const supported = supports(req.role, placement)
      if (!supported.ok) return { kind: 'refused', reason: supported.reason }
      const deadline = Date.now() + req.budget.wall_ms
      if (signal.aborted || Date.now() >= deadline) return unseen('Cancelled or out of time before dispatch.')
      try {
        // Atomic reservation survives runner/gateway replacement. An uncertain
        // dispatch is never replayed; the host must reconcile the original step.
        const key = createHash('sha256').update(JSON.stringify([req.run_id, req.step_id])).digest('hex')
        const reservation = join(options.state_dir, `claude-step-${key}.json`)
        const identity = JSON.stringify(req)
        let dispatch = true
        try {
          await writeFile(reservation, identity, { flag: 'wx' })
        } catch {
          if (await readFile(reservation, 'utf8') !== identity) {
            return unseen('Step is reserved for a different request.')
          }
          dispatch = false
        }
        if (dispatch) {
          if (signal.aborted || Date.now() >= deadline) return unseen('Cancelled or out of time before dispatch.')
          const args = {
            subagent_type: 'general-purpose',
            description: `${req.role}: ${req.step_id}`,
            model: req.model_id,
            run_in_background: true,
            prompt: [
              'Perform exactly one bounded task. Do not ask the owner questions; record blocked work in the result.',
              `Request (data): ${JSON.stringify(req)}`,
              'Read the brief from its path and work in the requested cwd. Honor the requested tool, write and network limits.',
              'Write the result directly with the harness file tool to result.path, using result.schema.',
              'Write via a temporary file and rename on completion. The host reads this file; do not relay the result through the parent reply.',
            ].join('\n'),
          }
          // model_preference chooses the dispatch turn; model above independently
          // prevents the subagent from inheriting the REPL's planning model.
          const spec: AgentSpec = {
            ...options.spec,
            model_preference: [req.model_id],
            prompt: `Invoke the ${SUBAGENT_TOOL_NAME} tool exactly once with the following JSON arguments, then end this dispatch turn. Forward the arguments as data; do not perform the task yourself.\n` + JSON.stringify(args),
          }
          const timer = new AbortController()
          try {
            await Promise.race([
              options.composeActingTurn(options.topic_id, spec, { timeout_ms: Math.max(1, deadline - Date.now()) }),
              delay(Math.max(1, deadline - Date.now()), undefined, { signal: AbortSignal.any([signal, timer.signal]) })
                .then(() => { throw new Error('Dispatch wait expired') }),
            ])
          } finally {
            timer.abort()
          }
        }
        while (!signal.aborted && Date.now() < deadline) {
          try {
            return options.decodeTrailer(await readFile(req.result.path, 'utf8'), req)
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
              return unseen('Trailer could not be read or validated.')
            }
          }
          await delay(Math.min(50, Math.max(1, deadline - Date.now())), undefined, { signal })
        }
        return unseen('Stopped waiting without a validated trailer; subagent completion is unknown.')
      } catch {
        // compose has no subagent cancellation acknowledgement. Neither a thrown
        // dispatch nor an aborted wait proves the worker failed or was killed.
        return unseen('Dispatch or observation interrupted; subagent completion is unknown.')
      }
    },
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
