export type PersonaFilename = 'SOUL.md' | 'USER.md' | 'priority-map.md'
export const PERSONA_FILENAMES: readonly PersonaFilename[] = ['SOUL.md', 'USER.md', 'priority-map.md']
export interface PersonaFileBody { filename: PersonaFilename; content: string; mtime: number }
type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>

export class WebPersonalityClientError extends Error {
  override readonly name = 'WebPersonalityClientError'
  constructor(public readonly status: number, public readonly code: string, message: string, public readonly currentMtime?: number) {
    super(`${code}: ${message}`)
  }
}

/** Web twin of the mobile persona client; both call the same gateway surface. */
export class WebPersonalityClient {
  private readonly baseUrl: string
  private readonly token: string
  private readonly fetchImpl: FetchImpl
  constructor(opts: { base_url: string; token: string; fetchImpl?: FetchImpl }) {
    this.baseUrl = opts.base_url.replace(/\/+$/, '')
    this.token = opts.token
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init))
  }
  async getFile(filename: PersonaFilename): Promise<PersonaFileBody> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/app/persona/file?name=${encodeURIComponent(filename)}`, { headers: this.headers() })
    if (!res.ok) throw await this.toError(res)
    const parsed = Number(res.headers.get('x-mtime') ?? '0')
    return { filename, content: await res.text(), mtime: Number.isFinite(parsed) ? parsed : 0 }
  }
  async saveFile(input: { filename: PersonaFilename; content: string; expected_mtime: number }): Promise<{ ok: true; mtime: number }> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/app/persona/file?name=${encodeURIComponent(input.filename)}`, {
      method: 'PATCH', headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ content: input.content, expected_mtime: input.expected_mtime }),
    })
    if (!res.ok) throw await this.toError(res)
    return (await res.json()) as { ok: true; mtime: number }
  }
  private headers(extra: Record<string, string> = {}): Headers {
    const headers = new Headers(extra); headers.set('authorization', `Bearer ${this.token}`); return headers
  }
  private async toError(res: Response): Promise<WebPersonalityClientError> {
    const body = (await res.json().catch(() => null)) as { code?: unknown; message?: unknown; current_mtime?: unknown } | null
    return new WebPersonalityClientError(res.status, typeof body?.code === 'string' ? body.code : `http_${res.status}`, typeof body?.message === 'string' ? body.message : res.statusText, typeof body?.current_mtime === 'number' ? body.current_mtime : undefined)
  }
}
