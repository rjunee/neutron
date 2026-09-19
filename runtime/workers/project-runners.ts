import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentSpec } from '../substrate.ts'
import { placementFor, type BoundedWorkOutcome, type BoundedWorkRequest, type WorkerRunner } from '../bounded-work.ts'
import { PROVIDERS, type Provider } from '../provider.ts'
import { claudeInReplRunner } from './claude-in-repl.ts'
import { codexInReplRunner, type CodexResultTransport } from './codex-in-repl.ts'
import { piInReplRunner } from './pi-in-repl.ts'
import { unknownCause } from '../refusal-cause.ts'

export interface ProjectConversation {
  readonly project_id: string
  readonly topic_id: string
  readonly provider: Provider
  readonly spec: Omit<AgentSpec, 'prompt'>
}

/** Claude implementation: createClaudeActingTurn in claude-acting-turn.ts. Resume this exact project session,
 * verify available grants and pass model/effort in the dispatch specification.
 * Claude observes the trailer within the host budget. Acceptance, empty output and child exit 0
 * are insufficient. Throw on uncertainty; never retry the dispatch here.
 * Pi must bind subagent to the request and supply an out-of-grant trailer writer.
 * Child success still requires the file; a correlated provider terminal error
 * can establish a block without authoring a worker result. */
export type ProjectActingTurn = (input: {
  conversation: ProjectConversation
  request: BoundedWorkRequest
  spec: AgentSpec
  timeout_ms: number
  signal: AbortSignal
  subagent?: string
}) => Promise<{ kind: 'turn-ended' } | { kind: 'unknown'; detail: string } | Extract<BoundedWorkOutcome, { kind: 'blocked' }> | (Extract<BoundedWorkOutcome, { kind: 'refused' }> & { detail: string })>

type Completed = Extract<BoundedWorkOutcome, { kind: 'completed' }>
export interface ProjectTrailerDecoder {
  /** Registered host validators for completed result payloads. No permissive default. */
  schemas: ReadonlyMap<string, (result: unknown) => boolean>
  /** Host observations keyed by the original request, never trailer usage/model claims. */
  metadata(request: BoundedWorkRequest): Omit<Completed, 'kind' | 'result'> | undefined
}

export type ProjectTrailerOutcome = BoundedWorkOutcome | { kind: 'not-current-step' }

const unknown = (detail: string): BoundedWorkOutcome => ({ kind: 'unknown', detail })

/** A well-formed identity for another request is stale, not unreadable. */
export function projectTrailerStep(bytes: string, request: BoundedWorkRequest): 'current-or-unreadable' | 'not-current-step' {
  try {
    const value = JSON.parse(bytes)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return 'current-or-unreadable'
    if (typeof value.run_id !== 'string' || typeof value.step_id !== 'string') return 'current-or-unreadable'
    return value.run_id === request.run_id && value.step_id === request.step_id ? 'current-or-unreadable' : 'not-current-step'
  } catch {
    return 'current-or-unreadable'
  }
}

/** Common envelope: { schema, run_id, step_id, kind, result? , on? }.
 * Schema names and domain payload validators are supplied by the host. */
export function decodeProjectTrailer(bytes: string, request: BoundedWorkRequest, host: ProjectTrailerDecoder): ProjectTrailerOutcome {
  try {
    const value = JSON.parse(bytes)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return unknown('Trailer object missing.')
    if (typeof value.run_id !== 'string') return unknown('Trailer run_id missing or unreadable.')
    if (typeof value.step_id !== 'string') return unknown('Trailer step_id missing or unreadable.')
    if (value.run_id !== request.run_id || value.step_id !== request.step_id) return { kind: 'not-current-step' }
    if (value.schema !== request.result.schema) return unknown('Trailer schema missing or mismatched.')
    const validate = host.schemas.get(request.result.schema)
    if (!validate) return unknown('Trailer schema has no host validator.')
    if (value.kind === 'blocked') {
      if (typeof value.on !== 'string' || value.on.trim() === '') return unknown('Trailer blocked reason missing.')
      return { kind: 'blocked', on: value.on }
    }
    if (value.kind !== 'completed') return unknown('Trailer outcome kind missing or unsupported.')
    if (!validate(value.result)) return unknown('Trailer result failed host schema validation.')
    let metadata: ReturnType<ProjectTrailerDecoder['metadata']>
    try { metadata = host.metadata(request) } catch { /* Telemetry cannot invalidate a validated result. */ }
    metadata ??= { usage: null, model_reported: null, thread_id: null }
    return { kind: 'completed', result: value.result, ...metadata }
  } catch (error) {
    return unknown(unknownCause('Trailer JSON or host validation could not be read.', error, request.run_id))
  }
}

export interface ProjectRunnersOptions {
  conversation: ProjectConversation
  run_id: string
  /** Existing host-owned per-run directory, retained across gateway restarts.
   * Never a temporary dispatch directory. Exclusive identity binding below also
   * prevents silently reusing this directory for another conversation or run. */
  state_dir: string
  actingTurn: ProjectActingTurn
  trailer: ProjectTrailerDecoder
  /** Codex child-only file transport; canonical request/reservation stays intact. */
  codexResultTransport?: CodexResultTransport
  /** Explicitly constructed headless runners. Missing capabilities stay unavailable. */
  headless: Partial<Record<Provider, WorkerRunner>>
}

/** Structurally satisfies ProjectBuildHostOptions.substrate without a runtime→driver import.
 * Does not construct a live bridge or missing headless harness implementations. */
export async function createProjectRunners(options: ProjectRunnersOptions) {
  const conversation = structuredClone(options.conversation)
  const runId = options.run_id
  const stateDir = options.state_dir
  const binding = JSON.stringify([conversation.project_id, conversation.topic_id, conversation.provider, runId])
  const path = join(stateDir, 'project-run-binding.json')
  try { await writeFile(path, binding, { flag: 'wx', mode: 0o600 }) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    if (await readFile(path, 'utf8') !== binding) throw new Error('State directory belongs to a different project conversation or run')
  }

  const constructors = {
    anthropic: claudeInReplRunner,
    'openai-codex': codexInReplRunner,
    pi: piInReplRunner,
    openai: undefined,
  }
  const construct = constructors[conversation.provider]
  const guard = (runner: WorkerRunner): WorkerRunner => ({
    provider: runner.provider,
    supports(role, placement) {
      if (placement !== placementFor(runner.provider, conversation.provider)) {
        return { ok: false, reason: 'placement-unavailable', detail: 'Placement does not match the project provider.' }
      }
      return runner.supports(role, placement)
    },
    async run(request, placement, signal) {
      const supported = this.supports(request.role, placement)
      if (!supported.ok) return { kind: 'refused', reason: supported.reason }
      if (request.run_id !== runId) return unknown('Request run_id does not match the host run.')
      return runner.run(request, placement, signal)
    },
    liveness: handle => runner.liveness(handle),
  })
  const common = {
    topic_id: conversation.topic_id, state_dir: stateDir, spec: conversation.spec, subagent: 'bounded-worker',
    decodeTrailer: (bytes: string, req: BoundedWorkRequest) => decodeProjectTrailer(bytes, req, options.trailer),
  }
  const admission = construct?.({ ...common, composeActingTurn: async () => { throw new Error('Admission runner cannot dispatch') } })
  const inRepl = construct && admission ? guard({
    provider: conversation.provider,
    supports: admission.supports,
    async run(request, placement, signal) {
      let uncertainty: string | undefined
      let refusal: Extract<BoundedWorkOutcome, { kind: 'refused' }> | undefined
      let blocked: Extract<BoundedWorkOutcome, { kind: 'blocked' }> | undefined
      const runner = construct({
        ...common,
        ...(conversation.provider === 'openai-codex' && options.codexResultTransport ? { resultTransport: options.codexResultTransport } : {}),
        async composeActingTurn(_topic, spec, turn: { timeout_ms: number; subagent?: string; childResultPath?: string }) {
          const actingRequest = conversation.provider === 'openai-codex' && turn.childResultPath
            ? { ...request, result: { ...request.result, path: turn.childResultPath } } : request
          const observation = await options.actingTurn({ conversation, request: actingRequest, spec, signal, timeout_ms: turn.timeout_ms,
            ...(turn.subagent === undefined ? {} : { subagent: turn.subagent }) })
          if (observation.kind === 'blocked') {
            blocked = observation
            throw new Error('Provider observed a blocked child')
          }
          if (observation.kind === 'refused') {
            refusal = { kind: 'refused', reason: observation.reason }
            throw new Error(observation.detail)
          }
          if (observation.kind !== 'turn-ended') {
            uncertainty = observation.detail
            throw new Error('Dispatch turn completion unknown')
          }
          return ''
        },
      })
      const outcome = await runner.run(request, placement, signal)
      return blocked ?? refusal ?? (uncertainty === undefined ? outcome : unknown(`Dispatch turn completion unknown: ${uncertainty}`))
    },
    liveness: async () => 'unknown',
  }) : undefined
  const headless: Partial<Record<Provider, WorkerRunner>> = {}
  for (const provider of PROVIDERS) {
    if (placementFor(provider, conversation.provider) !== 'headless') continue
    const runner = options.headless[provider]
    if (!runner) continue
    if (runner.provider !== provider) throw new Error('Headless runner provider does not match its key')
    headless[provider] = guard(runner)
  }
  return { provider: conversation.provider, inRepl, headless }
}
