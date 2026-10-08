import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { ProjectAdmission } from '@neutronai/gateway/project-admission.ts'
import type { TridentRun, TridentRunStore } from '@neutronai/trident/store.ts'
import type { TridentAttemptLedger } from '@neutronai/trident/attempt-ledger.ts'
import type { BoundedWorkRequest } from '@neutronai/runtime/bounded-work.ts'
import { isTerminalPhase } from '@neutronai/trident/state-machine.ts'
import { currentBootId } from '@neutronai/runtime/adapters/claude-code/persistent/process-identity.ts'
import { resolveLiveProjectSessions } from '@neutronai/runtime/adapters/claude-code/persistent/live-project-sessions.ts'
import { readClaudeNativeDispatchReceipt, verifyNativeDispatchChildBound, type SignedNativeDispatchRecord } from '@neutronai/runtime/workers/claude-native-dispatch-receipt.ts'
import { verifyPlannerAuthorityRetirement, plannerRetirementDigest, type PlannerAuthorityRetirement } from '@neutronai/runtime/workers/planner-authority-retirement.ts'
import { verifyHostBootObservation, type NativeHostRecoveryAuthority } from '@neutronai/runtime/workers/native-host-termination.ts'
import { retirePlannerWork, PLANNER_ROLE, PLANNER_NATIVE_TOOL } from '@neutronai/runtime/workers/planner-work.ts'
import { retireNativeChildWorkspaceRequest } from '@neutronai/runtime/workers/native-child-workspace.ts'

export interface PlannerAuthorityRetirementOptions {
  authority?: NativeHostRecoveryAuthority | undefined
  stateRoot: string
  admission: ProjectAdmission
  runs: Pick<TridentRunStore, 'get'>
  attempts: Pick<TridentAttemptLedger, 'get'>
  projectIdForRun(run: TridentRun): string | null
  listProjectIds(): readonly string[]
  /** Offline test seams. Composition uses the local kernel and real grant registry. */
  kernelBootId?: () => string | undefined
  drain?: (request: BoundedWorkRequest) => Promise<void>
}

function original(options: PlannerAuthorityRetirementOptions, body: PlannerAuthorityRetirement): BoundedWorkRequest | undefined {
  try {
    const lease = body.lease
    if (lease.scope.ownerHandle !== options.admission.ownerHandle
      || (lease.scope.projectId !== null && !options.listProjectIds().includes(lease.scope.projectId))) return
    const identity: unknown = JSON.parse(lease.workRef)
    if (!Array.isArray(identity) || identity.length !== 2 || identity.some(v => typeof v !== 'string' || !v.trim())) return
    const [runId, stepId] = identity as [string, string]
    const run = options.runs.get(runId)
    if (!run || !isTerminalPhase(run.phase) || options.projectIdForRun(run) !== lease.scope.projectId) return
    const dispatch = readClaudeNativeDispatchReceipt(join(options.stateRoot, encodeURIComponent(runId)), { run_id: runId, step_id: stepId }) as SignedNativeDispatchRecord | undefined
    const request = dispatch?.body?.request
    if (!request || !verifyNativeDispatchChildBound(dispatch, request, lease)
      || request.run_id !== runId || request.step_id !== stepId || request.role !== 'plan'
      || request.tools !== 'edit' || request.network !== false || request.writable !== true
      || plannerRetirementDigest(request) !== body.requestDigest || plannerRetirementDigest(dispatch) !== body.dispatchDigest
      || !isDeepStrictEqual(body.parent, dispatch!.body.parent) || body.nativeAgentId !== dispatch!.body.nativeAgentId
      || !Number.isSafeInteger(dispatch!.body.deadlineMs) || dispatch!.body.deadlineMs! > body.observation.observedAt
      || dispatch!.body.deadlineMs! > Date.now()) return
    const parent = body.parent, launch = parent.launch
    if (!launch || launch.sessionId !== parent.sessionId || launch.childGeneration !== parent.childGeneration
      || !Array.isArray(launch.argv) || !parent.processIdentity || parent.processIdentity.boot_id !== body.bootId
      || body.observation.originalExecutor.bootId !== body.bootId
      || body.observation.originalExecutor.pid === process.pid || body.observation.originalExecutor.pid === parent.pid) return
    const agentFlags = launch.argv.flatMap((arg, i) => arg === '--agents' ? [i] : [])
    if (agentFlags.length !== 1) return
    const profiles = JSON.parse(launch.argv[agentFlags[0]! + 1]!)
    const profile: unknown = profiles?.[PLANNER_ROLE]
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return
    const fields = profile as Record<string, unknown>
    if (Object.keys(fields).some(field => !['description', 'prompt', 'tools'].includes(field))
      || typeof fields.description !== 'string' || typeof fields.prompt !== 'string'
      || !isDeepStrictEqual(fields.tools, [PLANNER_NATIVE_TOOL])) return
    const attempt = options.attempts.get({ run_id: runId, step_id: stepId, attempt_id: 'dispatch' })
    if (!attempt || attempt.provider !== 'anthropic' || attempt.placement !== 'in-repl'
      || attempt.role !== request.role || attempt.resolved_model !== request.model_id
      || attempt.prepared_at === null || attempt.started_at === null
      || attempt.outcome === 'completed' || attempt.outcome === 'blocked') return
    return request
  } catch { return }
}

/** Explicit operator entrypoint only. No automatic inference from unknown work,
 * no native messages/signals, and no result/outcome fabrication. */
export async function retirePlannerAuthority(options: PlannerAuthorityRetirementOptions, raw: unknown): Promise<{
  status: 'released' | 'already-retired' | 'refused'
}> {
  const refused = { status: 'refused' as const }
  try {
    const authority = options.authority
    if (!authority || !verifyPlannerAuthorityRetirement(raw, authority)) return refused
    const authorization = JSON.stringify(raw), body = structuredClone(raw.body)
    const kernel = options.kernelBootId ?? currentBootId
    if (kernel() !== body.bootId) return refused
    const challenge = randomUUID(), controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const observation = await Promise.race([authority.attestBoot(challenge, controller.signal),
        new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Error('Boot observation timed out')) }, 5_000) })])
      if (!verifyHostBootObservation(observation, authority, challenge, body.bootId) || kernel() !== body.bootId) return refused
    } finally { clearTimeout(timer) }
    const request = original(options, body)
    if (!request) return refused
    const store = options.admission.maintenance
    const completion = JSON.stringify({ version: 1, kind: 'planner-authority-retirement-consumed', operationId: body.operationId,
      authorizationDigest: plannerRetirementDigest(JSON.parse(authorization)), nativeLoop: 'unknown', outcome: 'unknown' })
    const eligible = () => kernel() === body.bootId && original(options, body) !== undefined
    const prior = store.listPlannerRetirements().find(row => row.operationId === body.operationId)
    if (prior?.completion !== null && prior !== undefined) {
      const status = await store.consumePlannerRetirement(body.operationId, body.lease, authorization, completion, eligible)
      if (status !== 'refused') await releaseWorkspace(body, request)
      return { status }
    }
    const matches = options.admission.listLeases('liveChild').filter(row => row.scope.ownerHandle === body.lease.scope.ownerHandle
      && row.scope.projectId === body.lease.scope.projectId && row.workRef === body.lease.workRef)
    if (matches.length !== 1 || !isDeepStrictEqual(matches[0], body.lease)) return refused
    if (!await store.preparePlannerRetirement(body.operationId, body.lease, authorization, eligible)) return refused
    // Durable fencing precedes the process-local barrier. New constructors and
    // queued operations cannot race this drain to reinstall a matching grant.
    let drainTimer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([(options.drain ?? retirePlannerWork)(request), new Promise<never>((_, reject) => {
        drainTimer = setTimeout(() => reject(Error('Planner grant drain unavailable')), 10_000)
      })])
    } finally { clearTimeout(drainTimer) }
    const status = await store.consumePlannerRetirement(body.operationId, body.lease, authorization, completion, eligible)
    if (status !== 'refused') await releaseWorkspace(body, request)
    return { status }
  } catch { return refused }
}

/** Cleanup cannot turn a committed release into a refusal. Exact retries repeat
 * it; durable authority remains retired if a pooled session cannot be observed. */
async function releaseWorkspace(body: PlannerAuthorityRetirement, request: BoundedWorkRequest): Promise<void> {
  try {
    const sessions = await resolveLiveProjectSessions(body.lease.scope.projectId === null ? ['general', undefined] : [body.lease.scope.projectId])
    for (const { session } of sessions.live) retireNativeChildWorkspaceRequest(session, request)
  } catch { /* A subsequent authenticated retry can finish local cleanup. */ }
}
