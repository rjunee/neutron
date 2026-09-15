export class EmailDigestClient {
  constructor(private readonly input: { base_url: string; token: string }) {}

  async status(): Promise<{ enabled: boolean }> { return this.request('GET') }
  async setEnabled(enabled: boolean): Promise<{ enabled: boolean }> {
    return this.request('PUT', { enabled })
  }

  private async request(method: string, body?: object): Promise<{ enabled: boolean }> {
    const response = await fetch(`${this.input.base_url}/api/app/email-digest`, {
      method,
      headers: { authorization: `Bearer ${this.input.token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (!response.ok) throw new Error(`email digest setting failed (${response.status})`)
    const payload = await response.json() as { enabled?: unknown }
    if (typeof payload.enabled !== 'boolean') throw new Error('email digest setting returned an invalid response')
    return { enabled: payload.enabled }
  }
}
