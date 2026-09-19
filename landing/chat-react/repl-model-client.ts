/** Browser client for the active conversation's in-place REPL model. */
export interface ReplModelState {
  harness: 'claude-code' | 'codex'
  sessionId: string
  currentModel: string | null
  availableModels: { id: string; label: string }[]
  status: 'ready' | 'busy' | 'unsupported' | 'unknown'
  detail?: string
}

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>

export class ReplModelError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'ReplModelError'
  }
}

function decodeState(raw: unknown): ReplModelState {
  if (typeof raw !== 'object' || raw === null) throw new ReplModelError('Invalid model response', 0)
  const r = raw as Record<string, unknown>
  if (
    (r['harness'] !== 'claude-code' && r['harness'] !== 'codex') ||
    typeof r['sessionId'] !== 'string' ||
    (!r['sessionId'] && (r['status'] === 'ready' || r['status'] === 'busy')) ||
    (r['currentModel'] !== null && typeof r['currentModel'] !== 'string') ||
    !Array.isArray(r['availableModels']) ||
    !r['availableModels'].every((v: unknown) => typeof v === 'object' && v !== null &&
      typeof (v as Record<string, unknown>)['id'] === 'string' &&
      typeof (v as Record<string, unknown>)['label'] === 'string') ||
    !['ready', 'busy', 'unsupported', 'unknown'].includes(String(r['status']))
  ) throw new ReplModelError('Invalid model response', 0)
  return r as unknown as ReplModelState
}

export class WebReplModelClient {
  private readonly baseUrl: string
  private readonly token: string
  private readonly fetchImpl: FetchImpl

  constructor(opts: { base_url: string; token: string; fetchImpl?: FetchImpl }) {
    this.baseUrl = opts.base_url.replace(/\/+$/, '')
    this.token = opts.token
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init))
  }

  private path(projectId: string | null): string {
    return `/api/app/projects/${encodeURIComponent(projectId ?? '~general')}/repl-model`
  }

  async current(projectId: string | null): Promise<ReplModelState> {
    return this.request(this.path(projectId), { method: 'GET' })
  }

  async switch(projectId: string | null, model: string, sessionId: string): Promise<ReplModelState> {
    return this.request(this.path(projectId), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, sessionId }),
    })
  }

  private async request(path: string, init: RequestInit): Promise<ReplModelState> {
    let response: Response
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${this.token}`, ...init.headers },
      })
    } catch (error) {
      throw new ReplModelError(error instanceof Error ? error.message : 'Network error', 0)
    }
    let raw: unknown
    try { raw = await response.json() } catch { raw = null }
    if (!response.ok) {
      const detail = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>)['detail'] : null
      const error = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>)['error'] : null
      throw new ReplModelError(
        typeof detail === 'string' && detail ? detail : typeof error === 'string' && error ? error : `HTTP ${response.status}`,
        response.status,
      )
    }
    return decodeState(raw)
  }
}
