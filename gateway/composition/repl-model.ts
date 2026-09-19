import type { AppWsAuthResolver } from '@neutronai/channels/adapters/app-ws/auth.ts'
import type { Provider } from '@neutronai/runtime/provider.ts'
import { ReplModelError, type ReplModelState, type ReplModelSwitch } from '@neutronai/runtime/repl-model.ts'
import { createAppReplModelSurface, type ReplModelScope } from '../http/app-repl-model-surface.ts'

export function composeReplModelSurface(opts: {
  auth: AppWsAuthResolver
  ownerUserId: string
  ownerSlug: string
  projectExists(projectId: string): Promise<boolean>
  provider(projectId: string | null): Provider
  readClaude(scope: ReplModelScope): Promise<ReplModelState>
  switchClaude(scope: ReplModelScope, request: ReplModelSwitch): Promise<ReplModelState>
  readCodex?(projectId: string): Promise<ReplModelState>
  switchCodex?(projectId: string, request: ReplModelSwitch): Promise<ReplModelState>
}) {
  return createAppReplModelSurface({
    auth: opts.auth,
    canAccess: async ({ userId, ownerSlug, projectId }) =>
      userId === opts.ownerUserId && ownerSlug === opts.ownerSlug &&
      (projectId === null || await opts.projectExists(projectId)),
    read: async (scope) => {
      const provider = opts.provider(scope.projectId)
      if (provider === 'anthropic') return opts.readClaude(scope)
      if (provider === 'openai-codex') {
        if (scope.projectId !== null && opts.readCodex) return opts.readCodex(scope.projectId)
        return { harness: 'codex', sessionId: '', currentModel: null, availableModels: [],
          status: 'unsupported', detail: 'No live Codex conversation session is available.' }
      }
      throw new ReplModelError('unsupported', 'The selected provider has no native conversation model control.')
    },
    switch: async (scope, request) => {
      if (opts.provider(scope.projectId) === 'openai-codex' && scope.projectId !== null && opts.switchCodex) {
        return opts.switchCodex(scope.projectId, request)
      }
      if (opts.provider(scope.projectId) !== 'anthropic') {
        throw new ReplModelError('unsupported', 'No live supported conversation session is available for this provider.')
      }
      return opts.switchClaude(scope, request)
    },
  })
}
