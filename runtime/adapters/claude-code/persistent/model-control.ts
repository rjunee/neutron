import { NativeModelPicker } from '../../native-model-picker.ts'
import { ReplModelError, type ReplModelState, type ReplModelSwitch } from '../../../repl-model.ts'
import { pool, supervisedBySessionKey } from './pool-state.ts'
import { withOwnedRegistry } from './repl-registry.ts'

export interface PersistentReplModelScope { userId: string; projectId: string | null; instanceSlug?: string }

export async function getPersistentReplModel(scope: PersistentReplModelScope): Promise<ReplModelState> {
  return control(scope)
}

export async function switchPersistentReplModel(scope: PersistentReplModelScope, request: ReplModelSwitch): Promise<ReplModelState> {
  return control(scope, request)
}

async function control(scope: PersistentReplModelScope, request?: ReplModelSwitch): Promise<ReplModelState> {
  const matches = [...supervisedBySessionKey.entries()].filter(([key, options]) =>
    options.user_id === scope.userId &&
    options.conversationProjectId !== undefined && options.conversationProjectId === scope.projectId &&
    (scope.instanceSlug === undefined || options.instance_slug === scope.instanceSlug) &&
    options.frontierModelFloor === true && pool.has(key))
  if (matches.length !== 1) throw new ReplModelError('unavailable', 'No unique live conversation session is available.')
  const [key, options] = matches[0]!
  const session = await pool.get(key)!
  if (request && request.sessionId !== session.sessionId) throw new ReplModelError('session-changed', 'Conversation session changed; refresh before switching.')
  if (session.activeTurn || session.turnSlotHeld > 0) {
    if (request) throw new ReplModelError('busy', 'Conversation has a turn in progress.')
    return { harness: 'claude-code', sessionId: session.sessionId, currentModel: null, availableModels: [], status: 'busy' }
  }
  const release = await session.acquireTurn()
  try {
    if (request && options.replRegistryPath === undefined) throw new ReplModelError('unavailable', 'Conversation has no durable model preference store.')
    const state = await new NativeModelPicker('claude-code', session.sessionId, session.child).run(request)
    if (request && state.status === 'ready' && state.currentModel !== null) {
      const model = state.currentModel
      // The explicit selection is scoped to this conversation, including resume.
      const result = withOwnedRegistry(options.replRegistryPath!, registry => {
        const row = registry[key]
        if (!row || row.sessionId !== session.sessionId || row.child_generation !== session.childGeneration) {
          return { registry, result: false, skipSave: true }
        }
        registry[key] = { ...row, model, owner_selected_model: model }
        return { registry, result: true }
      }, () => false)
      if (!result.persisted || !result.result) throw new ReplModelError('unknown', 'Native model changed, but its resume preference could not be persisted; refresh before continuing.')
    }
    return state
  } finally { release() }
}
