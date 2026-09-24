import { ReplModelError, type ReplModelState, type ReplModelSwitch } from '@neutronai/runtime/repl-model.ts'
import type { CodexOwnerBindingFacts, CodexOwnerBootstrap, CodexOwnerAttachment } from '@neutronai/runtime/adapters/codex-cli/persistent/project-control-bootstrap.ts'
import { ProjectControlAdmissionRefusal, type ProjectControlGateway } from '@neutronai/runtime/adapters/codex-cli/persistent/project-control-broker.ts'
import type { NativeOwnerAction, NativeOwnerIdentity } from '@neutronai/gateway/http/app-native-owner-control-surface.ts'

type RecordValue = Record<string, unknown>
const object = (value: unknown): value is RecordValue => typeof value === 'object' && value !== null && !Array.isArray(value)
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0
type RequestId = string | number
export interface NativeOwnerQuestion { requestId: RequestId; method: string; params: RecordValue }
export function nativeOwnerQuestionText(question: NativeOwnerQuestion): string {
  const detail = [question.params.reason, question.params.command,
    ...(Array.isArray(question.params.questions) ? question.params.questions.map(value => object(value) ? value.question : undefined) : [])]
    .filter(nonempty).join('\n').slice(0, 16_000)
  return `Codex is waiting for your answer in this project.\n${detail}\nNative approval and interrupt actions are available through the authenticated project controls API.`
}
export interface NativeOwnerControlState extends NativeOwnerIdentity {
  status: string
  pending: NativeOwnerQuestion[]
}
interface ActiveTurn {
  owner: CodexOwnerBootstrap
  gateway: ProjectControlGateway
  facts: CodexOwnerBindingFacts
  turnId?: string
  pending: Map<RequestId, NativeOwnerQuestion>
  seen: Set<RequestId>
  interrupted?: boolean
  interruptAcknowledgement?: Promise<void>
  clientId?: string | undefined
}

/** Controls consume the same opaque owner and original turn writer as chat.
 * Reads never bootstrap, resume, seed a turn, or infer identity from a topic. */
export class CodexOwnerControls {
  private readonly active = new Map<string, ActiveTurn>()
  private readonly switching = new Set<string>()
  private sequence = 0
  constructor(private readonly deps: {
    lookup(projectId: string): Promise<CodexOwnerBootstrap | undefined>
    authorize(projectId: string): Promise<void>
    facts(owner: CodexOwnerBootstrap): CodexOwnerBindingFacts
    busy(projectId: string): boolean
    refused(projectId: string): boolean
    fence(projectId: string): void
  }) {}

  isSwitching(projectId: string): boolean { return this.switching.has(projectId) }

  private identity(projectId: string, owner: CodexOwnerBootstrap): NativeOwnerIdentity {
    const facts = this.deps.facts(owner), state = owner.broker.state()
    return { projectId, threadId: facts.threadId, bindingRevision: facts.bindingRevision,
      generation: state.generation, epoch: state.epoch, turnId: state.activeTurnId }
  }
  private async owner(projectId: string): Promise<CodexOwnerBootstrap> {
    const owner = await this.deps.lookup(projectId)
    if (owner && 'refreshState' in owner) await (owner as CodexOwnerAttachment).refreshState()
    if (!owner || this.deps.refused(projectId) || ['closed', 'recovery'].includes(owner.broker.state().phase)) {
      throw new ReplModelError('unavailable', 'The native project owner is unavailable or needs reconciliation.')
    }
    return owner
  }
  private token(identity: NativeOwnerIdentity): string {
    return JSON.stringify([identity.projectId, identity.threadId, identity.bindingRevision, identity.generation, identity.epoch, identity.turnId])
  }
  private assertIdentity(expected: NativeOwnerIdentity, projectId: string, owner: CodexOwnerBootstrap): void {
    if (this.token(expected) !== this.token(this.identity(projectId, owner))) {
      throw new ReplModelError('session-changed', 'Native project, thread, turn or revision changed. Refresh the controls.')
    }
  }
  private async models(gateway: ProjectControlGateway): Promise<ReplModelState['availableModels']> {
    const models: ReplModelState['availableModels'] = [], cursors = new Set<string>()
    let cursor: string | undefined
    for (let page = 0; page < 20; page++) {
      const value = await gateway.request('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) })
      if (!object(value) || !Array.isArray(value.data)) throw new ReplModelError('unknown', 'Native model catalog is unreadable.')
      for (const item of value.data) {
        if (!object(item) || !nonempty(item.model) || !nonempty(item.displayName)) throw new ReplModelError('unknown', 'Native model catalog is unreadable.')
        if (item.hidden !== true && !models.some(model => model.id === item.model)) models.push({ id: item.model, label: item.displayName })
      }
      if (value.nextCursor == null) return models
      if (!nonempty(value.nextCursor) || cursors.has(value.nextCursor)) break
      cursor = value.nextCursor; cursors.add(cursor)
    }
    throw new ReplModelError('unknown', 'Native model catalog pagination was not completed.')
  }
  private async current(owner: CodexOwnerBootstrap, gateway: ProjectControlGateway): Promise<string> {
    const facts = this.deps.facts(owner)
    const value = await gateway.request('thread/read', { threadId: facts.threadId, includeTurns: false })
    if (!object(value) || !object(value.thread) || value.thread.id !== facts.threadId || value.thread.cwd !== facts.cwd
      || value.thread.sessionId !== facts.sessionId || value.thread.modelProvider !== facts.modelProvider || !nonempty(value.thread.model)) {
      throw new ReplModelError('unknown', 'Native model state did not attest this project thread.')
    }
    return value.thread.model
  }
  /** Carry the observed thread selection explicitly rather than relying on
   * implicit turn defaults; caller fences the native epoch before dispatch. */
  turnModel(owner: CodexOwnerBootstrap, gateway: ProjectControlGateway): Promise<string> {
    return this.current(owner, gateway)
  }
  async model(projectId: string, request?: ReplModelSwitch): Promise<ReplModelState> {
    await this.deps.authorize(projectId)
    const owner = await this.owner(projectId)
    const before = this.identity(projectId, owner)
    if (request && request.sessionId !== this.token(before)) throw new ReplModelError('session-changed', 'Native model state changed. Refresh before switching.')
    if (this.switching.has(projectId) || request && (this.deps.busy(projectId) || owner.broker.state().phase !== 'idle')) {
      throw new ReplModelError('busy', 'The native project owner is busy.')
    }
    const gateway = owner.broker.gateway(`owner-model-${++this.sequence}`)
    if (request) this.switching.add(projectId)
    let dispatched = false
    try {
      const availableModels = await this.models(gateway)
      let currentModel = await this.current(owner, gateway)
      this.assertIdentity(before, projectId, owner)
      if (request) {
        if (!availableModels.some(model => model.id === request.model)) throw new ReplModelError('invalid-model', 'Model is not offered by the native harness.')
        if (this.deps.busy(projectId) || owner.broker.state().phase !== 'idle') throw new ReplModelError('busy', 'The native project owner is busy.')
        dispatched = true
        await gateway.request('thread/settings/update', { threadId: before.threadId, model: request.model }, before.epoch)
        const acknowledged = this.identity(projectId, owner)
        if (acknowledged.threadId !== before.threadId || acknowledged.bindingRevision !== before.bindingRevision
          || acknowledged.generation !== before.generation || acknowledged.epoch !== before.epoch + 1 || owner.broker.state().phase !== 'idle') {
          throw new ReplModelError('unknown', 'Native model switch identity was not acknowledged.')
        }
        currentModel = await this.current(owner, gateway)
        this.assertIdentity(acknowledged, projectId, owner)
        if (currentModel !== request.model) throw new ReplModelError('unknown', 'Native model switch was not confirmed.')
      }
      return { harness: 'codex', sessionId: this.token(this.identity(projectId, owner)),
        conversationId: JSON.stringify([projectId, before.threadId, before.bindingRevision, before.generation]), currentModel, availableModels,
        status: this.deps.busy(projectId) || owner.broker.state().phase !== 'idle' ? 'busy' : 'ready' }
    } catch (error) {
      if (error instanceof ProjectControlAdmissionRefusal) throw new ReplModelError('busy', 'Native model switch was not admitted; refresh the current owner state.')
      if (dispatched) this.deps.fence(projectId)
      throw error
    } finally { gateway.close(); if (request) this.switching.delete(projectId) }
  }

  register(projectId: string, owner: CodexOwnerBootstrap, gateway: ProjectControlGateway, onQuestion: (question: NativeOwnerQuestion) => void, clientId?: string,
    onTool?: (request: { id: string | number; method: string; params: Record<string, unknown> }) => void) {
    const active: ActiveTurn = { owner, gateway, clientId, facts: this.deps.facts(owner), pending: new Map(), seen: new Set() }
    this.active.set(projectId, active)
    const unsubscribe = gateway.subscribe(message => {
      if (!(typeof message.id === 'string' || typeof message.id === 'number' && Number.isSafeInteger(message.id))) return
      const params = message.params
      if (!object(params) || params.threadId !== active.facts.threadId || !nonempty(params.turnId)
        || params.turnId !== owner.broker.state().activeTurnId || active.turnId && active.turnId !== params.turnId
        || !nonempty(message.method)) { this.deps.fence(projectId); return }
      if (message.method === 'item/tool/call') {
        onTool?.({ id: message.id, method: message.method, params })
        return
      }
      if (active.seen.has(message.id) || active.seen.size >= 64) { this.deps.fence(projectId); return }
      active.seen.add(message.id)
      const question = { requestId: message.id, method: message.method, params: structuredClone(params) }
      active.pending.set(message.id, question)
      onQuestion(question)
    })
    return {
      receipt: (turnId: string) => {
        active.turnId = turnId
        if ([...active.pending.values()].some(question => question.params.turnId !== turnId)) this.deps.fence(projectId)
      },
      interrupted: async () => {
        if (!active.interruptAcknowledgement) return false
        try { await active.interruptAcknowledgement; return true }
        catch { return false }
      },
      close: () => { unsubscribe(); if (this.active.get(projectId) === active) this.active.delete(projectId) },
    }
  }
  async state(projectId: string): Promise<NativeOwnerControlState> {
    const owner = await this.owner(projectId)
    const identity = this.identity(projectId, owner), active = this.active.get(projectId)
    return { ...identity, status: owner.broker.state().phase,
      pending: active?.turnId === identity.turnId ? structuredClone([...active.pending.values()]) : [] }
  }
  async act(projectId: string, action: NativeOwnerAction): Promise<NativeOwnerControlState> {
    const owner = await this.owner(projectId)
    this.assertIdentity(action, projectId, owner)
    const active = this.active.get(projectId)
    if (!active || !active.turnId || active.turnId !== action.turnId || active.owner !== owner
      || active.facts.bindingRevision !== action.bindingRevision || active.facts.threadId !== action.threadId
      || active.facts.brokerGeneration !== action.generation) {
      throw new ReplModelError('session-changed', 'No exact active native turn writer is available.')
    }
    if (action.action === 'interrupt') {
      if (active.interrupted) throw new ReplModelError('session-changed', 'Native interruption was already requested.')
      active.interrupted = true
      try {
        active.interruptAcknowledgement = active.gateway.request('turn/interrupt', { threadId: action.threadId, turnId: action.turnId }, action.epoch).then(() => {})
        await active.interruptAcknowledgement
      }
      catch (error) { this.deps.fence(projectId); throw error }
    } else {
      const question = active.pending.get(action.requestId)
      if (!question) throw new ReplModelError('session-changed', 'Native approval is stale or already answered.')
      const result = approvalResult(question, action.result)
      // Exact-turn interruption/decline remains available after a project grant
      // is removed. New approval or input requires the current credential grant.
      if (result.decision !== 'decline' && result.decision !== 'cancel') await this.deps.authorize(projectId)
      this.assertIdentity(action, projectId, owner)
      if (this.active.get(projectId) !== active || active.pending.get(action.requestId) !== question) {
        throw new ReplModelError('session-changed', 'Native approval is stale or already answered.')
      }
      // An uncertain reply may have reached native code. Consume before sending,
      // fence on transport failure, and never replay the answer.
      active.pending.delete(action.requestId)
      try {
        if ('replyApproval' in owner) {
          if (!active.clientId) throw new Error('Native approval writer identity missing')
          await (owner as CodexOwnerAttachment).replyApproval(active.clientId, action.requestId, result, action.epoch)
        } else await active.gateway.reply(action.requestId, result, action.epoch)
      }
      catch (error) { this.deps.fence(projectId); throw error }
    }
    return this.state(projectId)
  }
}

/** Deliberately no arbitrary RPC/result pass-through or session-wide grants. */
function approvalResult(question: NativeOwnerQuestion, result: unknown): RecordValue {
  if (!object(result)) throw new ReplModelError('unsupported', 'Native answer must be an object.')
  if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(question.method)) {
    if (Object.keys(result).length !== 1 || !['accept', 'decline', 'cancel'].includes(String(result.decision))) {
      throw new ReplModelError('unsupported', 'Only one-time accept, decline or cancel decisions are supported.')
    }
    const choices = question.params.availableDecisions
    if (Array.isArray(choices) && !choices.includes(result.decision)) throw new ReplModelError('unsupported', 'That decision was not offered by the native harness.')
    return { decision: result.decision }
  }
  if (question.method === 'item/tool/requestUserInput' && Array.isArray(question.params.questions) && object(result.answers)
    && Object.keys(result).length === 1) {
    const ids = question.params.questions.map(value => object(value) ? value.id : undefined)
    if (ids.every(nonempty) && Object.keys(result.answers).length === ids.length && ids.every(id => {
      const answer = (result.answers as RecordValue)[id]
      return object(answer) && Object.keys(answer).length === 1 && Array.isArray(answer.answers)
        && answer.answers.length > 0 && answer.answers.every(nonempty)
    })) return structuredClone(result)
  }
  throw new ReplModelError('unsupported', 'This native question requires an unsupported answer shape; it remains pending.')
}
