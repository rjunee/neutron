import { describe, it, expect } from 'bun:test'
import {
  GatewayHttpClient,
  GatewayClientError,
  type FetchImpl,
  type GatewayHttpClientOptions,
} from './index.ts'

/** A minimal `Response`-shaped stub good enough for the base's `req`. */
function res(
  status: number,
  body: unknown,
  opts: { nonJson?: boolean } = {},
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (opts.nonJson) throw new SyntaxError('not json')
      return body
    },
  } as unknown as Response
}

/** Capture the args the base passes to `fetchImpl`. */
interface Call {
  url: string
  init: RequestInit | undefined
}

/** A concrete subclass that exposes the protected `req` for testing. */
class TestClient extends GatewayHttpClient {
  readonly calls: Call[] = []
  constructor(opts: GatewayHttpClientOptions, guard = false) {
    super(opts)
    // @ts-expect-error — override the readonly guard for the test matrix.
    this.guardNetworkErrors = guard
  }
  call<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
    return this.req<T>(path, init)
  }
}

function recordingFetch(handler: (url: string, init?: RequestInit) => Response): {
  fetchImpl: FetchImpl
  calls: Call[]
} {
  const calls: Call[] = []
  const fetchImpl: FetchImpl = async (url, init) => {
    calls.push({ url, init })
    return handler(url, init)
  }
  return { fetchImpl, calls }
}

describe('GatewayClientError', () => {
  it('formats the message as `code: message` and carries code + status', () => {
    const err = new GatewayClientError('boom', 'it broke', 418)
    expect(err.message).toBe('boom: it broke')
    expect(err.code).toBe('boom')
    expect(err.status).toBe(418)
    expect(err.name).toBe('GatewayClientError')
    expect(err).toBeInstanceOf(Error)
  })
})

describe('GatewayHttpClient.req — request shape', () => {
  it('normalizes a trailing slash on base_url and attaches Bearer auth', async () => {
    const { fetchImpl, calls } = recordingFetch(() => res(200, { ok: true }))
    const client = new TestClient({ base_url: 'https://host//', token: 'tok', fetchImpl })
    await client.call('/api/app/x')
    expect(calls[0]?.url).toBe('https://host/api/app/x')
    expect((calls[0]?.init?.headers as Record<string, string>).authorization).toBe('Bearer tok')
  })

  it('GET sends no body and no content-type', async () => {
    const { fetchImpl, calls } = recordingFetch(() => res(200, { ok: true }))
    const client = new TestClient({ base_url: 'https://host', token: 't', fetchImpl })
    await client.call('/p')
    expect(calls[0]?.init?.method).toBe('GET')
    expect(calls[0]?.init?.body).toBeUndefined()
    expect((calls[0]?.init?.headers as Record<string, string>)['content-type']).toBeUndefined()
  })

  it('a present body is JSON-serialized with a content-type header', async () => {
    const { fetchImpl, calls } = recordingFetch(() => res(200, { ok: true }))
    const client = new TestClient({ base_url: 'https://host', token: 't', fetchImpl })
    await client.call('/p', { method: 'POST', body: { a: 1 } })
    expect(calls[0]?.init?.method).toBe('POST')
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ a: 1 }))
    expect((calls[0]?.init?.headers as Record<string, string>)['content-type']).toBe(
      'application/json',
    )
  })

  it('returns the parsed JSON payload on a 2xx', async () => {
    const { fetchImpl } = recordingFetch(() => res(200, { value: 42 }))
    const client = new TestClient({ base_url: 'https://host', token: 't', fetchImpl })
    expect(await client.call<{ value: number }>('/p')).toEqual({ value: 42 })
  })
})

describe('GatewayHttpClient.req — error mapping', () => {
  it('maps a coded non-2xx body to a GatewayClientError', async () => {
    const { fetchImpl } = recordingFetch(() =>
      res(409, { code: 'stale', message: 'try again' }),
    )
    const client = new TestClient({ base_url: 'https://host', token: 't', fetchImpl })
    await expect(client.call('/p')).rejects.toMatchObject({ code: 'stale', status: 409 })
  })

  it('falls back to request_failed / HTTP <status> when the body has no code', async () => {
    const { fetchImpl } = recordingFetch(() => res(500, null, { nonJson: true }))
    const client = new TestClient({ base_url: 'https://host', token: 't', fetchImpl })
    await expect(client.call('/p')).rejects.toMatchObject({
      code: 'request_failed',
      message: 'request_failed: HTTP 500',
      status: 500,
    })
  })
})

describe('GatewayHttpClient.req — network-error guard divergence', () => {
  it('guard OFF (RN shape) lets the raw fetch rejection propagate', async () => {
    const boom = new TypeError('Network request failed')
    const fetchImpl: FetchImpl = async () => {
      throw boom
    }
    const client = new TestClient({ base_url: 'https://host', token: 't', fetchImpl }, false)
    await expect(client.call('/p')).rejects.toBe(boom)
  })

  it('guard ON (web shape) rethrows a fetch rejection as a coded network error', async () => {
    const fetchImpl: FetchImpl = async () => {
      throw new TypeError('offline')
    }
    const client = new TestClient({ base_url: 'https://host', token: 't', fetchImpl }, true)
    await expect(client.call('/p')).rejects.toMatchObject({
      code: 'network',
      message: 'network: offline',
      status: 0,
    })
  })
})

describe('GatewayHttpClient.makeError — subclass factory', () => {
  class DocLikeError extends GatewayClientError {
    readonly current_modified_at: number | null
    constructor(code: string, message: string, status: number, current: number | null = null) {
      super(code, message, status)
      this.name = 'DocLikeError'
      this.current_modified_at = current
    }
  }
  class DocLikeClient extends GatewayHttpClient {
    protected override readonly guardNetworkErrors = true
    protected override makeError(
      code: string,
      message: string,
      status: number,
      body: Record<string, unknown>,
    ): GatewayClientError {
      const current =
        typeof body['current_modified_at'] === 'number'
          ? (body['current_modified_at'] as number)
          : null
      return new DocLikeError(code, message, status, current)
    }
    read(path: string): Promise<unknown> {
      return this.req(path)
    }
  }

  it('overridden makeError yields the named subclass and lifts an extra body field', async () => {
    const { fetchImpl } = recordingFetch(() =>
      res(409, { code: 'doc_changed_underfoot', message: 'stale', current_modified_at: 77 }),
    )
    const client = new DocLikeClient({ base_url: 'https://host', token: 't', fetchImpl })
    const err = await client.read('/p').then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(DocLikeError)
    expect(err).toBeInstanceOf(GatewayClientError)
    expect((err as DocLikeError).name).toBe('DocLikeError')
    expect((err as DocLikeError).code).toBe('doc_changed_underfoot')
    expect((err as DocLikeError).current_modified_at).toBe(77)
  })

  it('the guarded network path also routes through the subclass factory (current null)', async () => {
    const fetchImpl: FetchImpl = async () => {
      throw new Error('down')
    }
    const client = new DocLikeClient({ base_url: 'https://host', token: 't', fetchImpl })
    const err = await client.read('/p').then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(DocLikeError)
    expect((err as DocLikeError).code).toBe('network')
    expect((err as DocLikeError).current_modified_at).toBeNull()
  })
})
