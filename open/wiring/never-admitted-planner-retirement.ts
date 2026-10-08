import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { BoundedWorkRequest } from '@neutronai/runtime/bounded-work.ts'
import { currentBootId } from '@neutronai/runtime/adapters/claude-code/persistent/process-identity.ts'
import { resolveLiveProjectSessions } from '@neutronai/runtime/adapters/claude-code/persistent/live-project-sessions.ts'
import { inspectConversationQuarantine, quarantinePersistentConversation } from '@neutronai/runtime/adapters/claude-code/persistent/conversation-quarantine.ts'
import { readClaudeNativeDispatchReceipt, verifyNativeDispatchSubmissionStarted, type SignedNativeDispatchRecord } from '@neutronai/runtime/workers/claude-native-dispatch-receipt.ts'
import { verifyNeverAdmittedPlannerRetirement, verifyNeverAdmittedPlannerPreparation, type NeverAdmittedPlannerRetirement, type NeverAdmittedPlannerAuthority } from '@neutronai/runtime/workers/never-admitted-planner-retirement.ts'
import { plannerRetirementDigest } from '@neutronai/runtime/workers/planner-authority-retirement.ts'
import { loadClaudeCapacityPin, verifyCurrentConversationQuarantine, type ClaudeCapacityPin } from '@neutronai/runtime/workers/claude-capacity-client.ts'
import { verifyHostBootObservation } from '@neutronai/runtime/workers/native-host-termination.ts'
import { retirePlannerWork } from '@neutronai/runtime/workers/planner-work.ts'
import { hasOtherNativeChildWorkspace, retireNativeChildWorkspaceRequest } from '@neutronai/runtime/workers/native-child-workspace.ts'
import { isTerminalPhase } from '@neutronai/trident/state-machine.ts'
import type { PlannerAuthorityRetirementOptions } from './planner-authority-retirement.ts'

export interface NeverAdmittedRetirementSeams {
  capacityPin?: ClaudeCapacityPin
  /** Test substitutions; production uses the configured capacity owner and pool. */
  quarantineCurrent?: (body: NeverAdmittedPlannerRetirement) => Promise<boolean>
  inspectConversation?: typeof inspectConversationQuarantine
  quarantineConversation?: typeof quarantinePersistentConversation
}
const OBSERVATION_TIMEOUT_MS = 5_000
const DRAIN_TIMEOUT_MS = 10_000

function original(options: PlannerAuthorityRetirementOptions, body: NeverAdmittedPlannerAuthority): BoundedWorkRequest | undefined {
  try {
    const lease = body.lease
    if (lease.scope.ownerHandle !== options.admission.ownerHandle || lease.scope.projectId === null
      || !options.listProjectIds().includes(lease.scope.projectId)) return
    const identity: unknown = JSON.parse(lease.workRef)
    if (!Array.isArray(identity) || identity.length !== 2 || identity.some(v => typeof v !== 'string' || !v.trim())) return
    const [runId, stepId] = identity as [string, string], run = options.runs.get(runId)
    if (!run || !isTerminalPhase(run.phase) || options.projectIdForRun(run) !== lease.scope.projectId) return
    const dispatch = readClaudeNativeDispatchReceipt(join(options.stateRoot, encodeURIComponent(runId)), { run_id: runId, step_id: stepId }) as SignedNativeDispatchRecord | undefined
    const request = dispatch?.body?.request
    if (!request || !verifyNativeDispatchSubmissionStarted(dispatch, request, lease)
      || request.run_id !== runId || request.step_id !== stepId || request.role !== 'plan'
      || request.tools !== 'edit' || request.network !== false || request.writable !== true
      || plannerRetirementDigest(request) !== body.requestDigest || plannerRetirementDigest(dispatch) !== body.dispatchDigest
      || !isDeepStrictEqual(dispatch!.body.parent, body.parent)
      || !Number.isSafeInteger(dispatch!.body.deadlineMs) || dispatch!.body.deadlineMs! > body.observation.observedAt
      || dispatch!.body.deadlineMs! > Date.now()) return
    const parent = body.parent
    if (parent.launch?.sessionId !== parent.sessionId || parent.launch.childGeneration !== parent.childGeneration
      || parent.launch.projectId !== lease.scope.projectId || !Array.isArray(parent.launch.argv)
      || body.observation.originalExecutor.pid === process.pid || body.observation.originalExecutor.pid === parent.pid) return
    const attempt = options.attempts.get({ run_id: runId, step_id: stepId, attempt_id: 'dispatch' })
    if (!attempt || attempt.provider !== 'anthropic' || attempt.placement !== 'in-repl'
      || attempt.role !== request.role || attempt.resolved_model !== request.model_id
      || attempt.prepared_at === null || attempt.started_at === null
      || attempt.outcome === 'completed' || attempt.outcome === 'blocked') return
    return request
  } catch { return }
}

/** No parent input or native task outcome is produced by this recovery. */
export async function retireNeverAdmittedPlanner(options: PlannerAuthorityRetirementOptions & NeverAdmittedRetirementSeams,
  raw: unknown): Promise<{ status: 'released' | 'already-retired' | 'refused' }> {
  const refused = { status: 'refused' as const }
  try {
    const authority = options.authority, capacity = options.capacityPin ?? loadClaudeCapacityPin()
    if (!authority || !capacity || !verifyNeverAdmittedPlannerRetirement(raw, authority, capacity)) return refused
    const authorization = JSON.stringify(raw.body.preparation), body = structuredClone(raw.body)
    const kernel = options.kernelBootId ?? currentBootId
    if (kernel() !== body.bootId) return refused
    const challenge = randomUUID()
    const boot = await bounded(() => authority.attestBoot(challenge, AbortSignal.timeout(OBSERVATION_TIMEOUT_MS)), OBSERVATION_TIMEOUT_MS)
    if (!verifyHostBootObservation(boot, authority, challenge, body.bootId) || kernel() !== body.bootId) return refused
    const request = original(options, body)
    if (!request) return refused
    const current = options.quarantineCurrent ?? (async (b: NeverAdmittedPlannerRetirement) =>
      verifyCurrentConversationQuarantine(capacity, { operationId: b.operationId, parentSessionId: b.parent.sessionId,
        originalScopeDigest: b.quarantine.body.originalScopeDigest }, plannerRetirementDigest(b.quarantine.body),
      AbortSignal.timeout(OBSERVATION_TIMEOUT_MS), Date.now() + OBSERVATION_TIMEOUT_MS))
    if (!await current(body)) return refused
    const store = options.admission.maintenance
    const predicate = (sessionId: string) => store.isConversationQuarantined(sessionId)
    const completion = JSON.stringify({ version: 1, kind: 'planner-authority-retirement-consumed', operationId: body.operationId,
      authorizationDigest: plannerRetirementDigest(raw), nativeLoop: 'unknown', outcome: 'unknown' })
    const eligible = () => kernel() === body.bootId && original(options, body) !== undefined
    const prior = store.listPlannerRetirements().find(row => row.operationId === body.operationId)
    if (prior?.completion !== null && prior !== undefined) {
      const status = await store.consumePlannerRetirement(body.operationId, body.lease, authorization, completion, eligible)
      if (status !== 'refused') await reopen()
      return { status }
    }
    const leases = options.admission.listLeases().filter(row => row.scope.projectId === body.lease.scope.projectId)
    if (leases.length !== 1 || !isDeepStrictEqual(leases[0], body.lease)) return refused
    const active = await resolveLiveProjectSessions([body.lease.scope.projectId!])
    if (active.unresolved !== 0) return refused
    const sessions = await resolveLiveProjectSessions([body.lease.scope.projectId!], { includeQuarantinedSessionId: body.parent.sessionId })
    if (sessions.live.some(({ session }) => hasOtherNativeChildWorkspace(session, request)
      || !session.hasOnlyQuarantineRequest(request))) return refused
    if (!(options.inspectConversation ?? inspectConversationQuarantine)(body.parent, predicate, { request })) return refused
    // Consumption cannot retrospectively prepare the irreversible relay operation.
    if (!predicate(body.parent.sessionId) || !store.operatorMaintenanceFor(body.lease.scope, body.operationId)
      || !await store.prepareConversationQuarantine(body.operationId, body.lease, authorization, body.parent.sessionId, eligible)) return refused
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([(options.drain ?? retirePlannerWork)(request), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error('Planner grant drain unavailable')), DRAIN_TIMEOUT_MS)
      })])
    } finally { clearTimeout(timer) }
    for (const { session } of sessions.live) retireNativeChildWorkspaceRequest(session, request)
    // Completion callbacks release only the exact retired workspace's slot.
    await Promise.resolve()
    if (!(options.quarantineConversation ?? quarantinePersistentConversation)(body.parent, predicate)) return refused
    if (!await current(body)) return refused
    const status = await store.consumePlannerRetirement(body.operationId, body.lease, authorization, completion, () =>
      eligible() && predicate(body.parent.sessionId) && store.operatorMaintenanceFor(body.lease.scope, body.operationId) !== null
      && options.admission.listLeases().filter(row => row.scope.projectId === body.lease.scope.projectId).length === 1)
    if (status !== 'refused') await reopen()
    return { status }

    async function reopen(): Promise<void> {
      // Failure after committed consumption must not be reported as no release.
      // The exact authenticated retry can finish reopening our own held epoch.
      try {
        const hold = store.operatorMaintenanceFor(body.lease.scope, body.operationId)
        if (hold) await store.releaseOperatorMaintenance(hold, () => predicate(body.parent.sessionId))
      } catch { /* Keep the durable maintenance hold on failed cleanup. */ }
    }
  } catch { return refused }
}

async function bounded<T>(work: () => Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([work(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Error('Recovery observation unavailable')), ms)
    })])
  } finally { clearTimeout(timer) }
}

/** First phase: freeze the complete canonical scope before a root operator may
 * disable its relay conversation. It neither disables the relay nor releases work. */
export async function prepareNeverAdmittedPlanner(options: PlannerAuthorityRetirementOptions & NeverAdmittedRetirementSeams,
  raw: unknown): Promise<{ status: 'prepared' | 'refused' }> {
  const refused = { status: 'refused' as const }
  try {
    const authority = options.authority, capacity = options.capacityPin ?? loadClaudeCapacityPin()
    if (!authority || !capacity || !verifyNeverAdmittedPlannerPreparation(raw, authority, capacity)) return refused
    const authorization = JSON.stringify(raw), body = structuredClone(raw.body)
    const kernel = options.kernelBootId ?? currentBootId
    if (kernel() !== body.bootId) return refused
    const challenge = randomUUID()
    const boot = await bounded(() => authority.attestBoot(challenge, AbortSignal.timeout(OBSERVATION_TIMEOUT_MS)), OBSERVATION_TIMEOUT_MS)
    if (!verifyHostBootObservation(boot, authority, challenge, body.bootId) || kernel() !== body.bootId) return refused
    const request = original(options, body)
    if (!request) return refused
    const store = options.admission.maintenance, predicate = (sessionId: string) => store.isConversationQuarantined(sessionId)
    const leases = options.admission.listLeases().filter(row => row.scope.projectId === body.lease.scope.projectId)
    if (leases.length !== 1 || !isDeepStrictEqual(leases[0], body.lease)) return refused
    const sessions = await resolveLiveProjectSessions([body.lease.scope.projectId!])
    if (sessions.unresolved !== 0 || sessions.live.some(({ session }) => hasOtherNativeChildWorkspace(session, request)
      || !session.hasOnlyQuarantineRequest(request))) return refused
    if (!(options.inspectConversation ?? inspectConversationQuarantine)(body.parent, predicate, { request })) return refused
    if (!await store.prepareConversationQuarantine(body.operationId, body.lease, authorization, body.parent.sessionId,
      () => kernel() === body.bootId && original(options, body) !== undefined
        && (options.inspectConversation ?? inspectConversationQuarantine)(body.parent, predicate, { request }))) return refused
    await bounded(() => (options.drain ?? retirePlannerWork)(request), DRAIN_TIMEOUT_MS)
    return { status: 'prepared' }
  } catch { return refused }
}
