/** Narrow native capability; model ids are the harness's offered selector ids. */
export interface ReplModelState {
  harness: 'claude-code' | 'codex'
  sessionId: string
  currentModel: string | null
  availableModels: { id: string; label: string }[]
  status: 'ready' | 'busy' | 'unsupported' | 'unknown'
  detail?: string
}

export interface ReplModelSwitch { sessionId: string; model: string }

export class ReplModelError extends Error {
  constructor(readonly code: 'busy' | 'session-changed' | 'invalid-model' | 'unavailable' | 'unsupported' | 'unknown', message: string) {
    super(message)
    this.name = 'ReplModelError'
  }
}
