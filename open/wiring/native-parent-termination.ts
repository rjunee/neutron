import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { isTerminalPhase } from '@neutronai/trident/state-machine.ts'
import { classifyRecordedPid, currentBootId } from '@neutronai/runtime/adapters/claude-code/persistent/process-identity.ts'
import { resolveLiveProjectSessions } from '@neutronai/runtime/adapters/claude-code/persistent/live-project-sessions.ts'
import { inspectConversationQuarantine, quarantinePersistentConversation } from '@neutronai/runtime/adapters/claude-code/persistent/conversation-quarantine.ts'
import { readClaudeNativeDispatchReceipt } from '@neutronai/runtime/workers/claude-native-dispatch-receipt.ts'
import { verifyHostBootObservation } from '@neutronai/runtime/workers/native-host-termination.ts'
import { verifyNativeParentTerminationPreparation, verifyNativeParentTerminationCompletion,
  type NativeParentTerminationPreparation } from '@neutronai/runtime/workers/native-parent-termination.ts'
import type { CompletedConversationQuarantine } from '@neutronai/runtime/adapters/claude-code/persistent/quarantined-chat.ts'
import type { PlannerAuthorityRetirementOptions } from './planner-authority-retirement.ts'

export interface NativeParentTerminationOptions extends PlannerAuthorityRetirementOptions {
  /** Offline test seams; production uses the actual pool and kernel. */
  inspect?: typeof inspectConversationQuarantine
  quarantine?: typeof quarantinePersistentConversation
  resolve?: typeof resolveLiveProjectSessions
  processVerdict?: typeof classifyRecordedPid
}

function original(options: NativeParentTerminationOptions, body: NativeParentTerminationPreparation): boolean {
  try {
    for (const { lease, dispatch } of body.children) {
      const request = dispatch.body.request, run = options.runs.get(request.run_id)
      if (lease.scope.ownerHandle !== options.admission.ownerHandle || lease.scope.projectId === null
        || !options.listProjectIds().includes(lease.scope.projectId) || !run || !isTerminalPhase(run.phase)
        || options.projectIdForRun(run) !== lease.scope.projectId || dispatch.body.deadlineMs! > Date.now()) return false
      const saved = readClaudeNativeDispatchReceipt(join(options.stateRoot, encodeURIComponent(request.run_id)), request)
      if (!isDeepStrictEqual(saved, dispatch)) return false
      const attempt = options.attempts.get({ run_id: request.run_id, step_id: request.step_id, attempt_id: 'dispatch' })
      if (!attempt || attempt.provider !== 'anthropic' || attempt.placement !== 'in-repl'
        || attempt.role !== request.role || attempt.resolved_model !== request.model_id
        || attempt.prepared_at === null || attempt.started_at === null || attempt.ended_at === null
        || attempt.outcome === 'completed') return false
    }
    return true
  } catch { return false }
}

async function boot(options: NativeParentTerminationOptions, expected: string): Promise<boolean> {
  if (!options.authority || (options.kernelBootId ?? currentBootId)() !== expected) return false
  const challenge = randomUUID(), controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const observation = await Promise.race([options.authority.attestBoot(challenge, controller.signal),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Error('Boot observation timed out')) }, 5000) })])
    return verifyHostBootObservation(observation, options.authority, challenge, expected)
      && (options.kernelBootId ?? currentBootId)() === expected
  } finally { clearTimeout(timer) }
}

export async function prepareNativeParentTermination(options: NativeParentTerminationOptions, raw: unknown):
  Promise<{ status: 'prepared' | 'refused' }> {
  const refused = { status: 'refused' as const }
  try {
    if (!options.authority || !verifyNativeParentTerminationPreparation(raw, options.authority)) return refused
    const preparation = JSON.stringify(raw), body = structuredClone(raw.body)
    if (!await boot(options, body.bootId) || !original(options, body)) return refused
    const store = options.admission.maintenance, scope = body.children[0]!.lease.scope
    const rows = body.children.map(child => child.lease)
    const requests = body.children.map(child => child.dispatch.body.request)
    if (!store.matchesScopeLeases(scope, rows)) return refused
    const predicate = (sessionId: string) => store.isConversationQuarantined(sessionId)
    const sessions = await (options.resolve ?? resolveLiveProjectSessions)([scope.projectId!],
      { excludeConversationScopesOtherThan: scope.projectId })
    if (sessions.unresolved !== 0 || sessions.live.length > 1
      || sessions.live.some(({ session }) => session.sessionId !== body.parent.sessionId)
      || sessions.live.length === 0 && !predicate(body.parent.sessionId)) return refused
    const eligible = () => (options.kernelBootId ?? currentBootId)() === body.bootId && original(options, body)
      && (options.inspect ?? inspectConversationQuarantine)(body.parent, predicate, { requests })
    if (!eligible() || !await store.prepareNativeParentTermination(body.operationId, rows, preparation, body.parent.sessionId, eligible)) return refused
    // The durable fence is already visible to all constructors and replay paths.
    // Detachment makes no native input and cannot turn failure into completion.
    if (!(options.quarantine ?? quarantinePersistentConversation)(body.parent, predicate, { requests })) return refused
    return { status: 'prepared' }
  } catch { return refused }
}

export async function consumeNativeParentTermination(options: NativeParentTerminationOptions, raw: unknown):
  Promise<{ status: 'released' | 'already-retired' | 'refused' }> {
  const refused = { status: 'refused' as const }
  try {
    if (!raw || typeof raw !== 'object' || !options.authority) return refused
    const { preparation, completion } = raw as { preparation?: unknown; completion?: unknown }
    if (!verifyNativeParentTerminationPreparation(preparation, options.authority)
      || !verifyNativeParentTerminationCompletion(completion, preparation, options.authority)) return refused
    const authorization = JSON.stringify(preparation), evidence = JSON.stringify(completion)
    const body = structuredClone(preparation.body)
    if (!await boot(options, body.bootId)) return refused
    const store = options.admission.maintenance
    const eligible = () => (options.kernelBootId ?? currentBootId)() === body.bootId && original(options, body)
      && store.isConversationQuarantined(body.parent.sessionId)
      && (options.processVerdict ?? classifyRecordedPid)(body.parent.pid, body.parent.processIdentity) === 'confirmed-gone'
    if (!eligible()) return refused
    return { status: await store.consumeNativeParentTermination(body.operationId, body.children.map(child => child.lease),
      authorization, body.parent.sessionId, evidence, eligible) }
  } catch { return refused }
}

/** Permanent, verified successor authority after the complete batch committed.
 * A newer boot does not revive a parent whose exit was already authenticated. */
export function completedNativeParentTermination(options: Pick<NativeParentTerminationOptions, 'authority' | 'admission'>,
  projectId: string | null, sessionId: string): CompletedConversationQuarantine | undefined {
  try {
    if (!options.authority) return
    const scope = { ownerHandle: options.admission.ownerHandle, projectId }
    const row = options.admission.maintenance.completedConversationQuarantine(scope, sessionId)
    if (!row) return
    const preparation: unknown = JSON.parse(row.authorization), completion: unknown = JSON.parse(row.completion)
    if (!verifyNativeParentTerminationPreparation(preparation, options.authority)
      || !verifyNativeParentTerminationCompletion(completion, preparation, options.authority)
      || preparation.body.operationId !== row.operationId || preparation.body.parent.sessionId !== sessionId
      || !isDeepStrictEqual(preparation.body.children[0]!.lease.scope, scope)) return
    const records = options.admission.maintenance.listPlannerRetirements()
      .filter(item => item.operationId === row.operationId || item.operationId.startsWith(`${row.operationId}:`))
    if (records.length !== preparation.body.children.length || !preparation.body.children.every(child =>
      records.some(item => isDeepStrictEqual(item.lease, child.lease)
        && item.authorization === row.authorization && item.completion === row.completion))) return
    return { operationId: row.operationId, parent: preparation.body.parent, nativeLoop: 'terminated' }
  } catch { return }
}
