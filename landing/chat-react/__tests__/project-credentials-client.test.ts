/**
 * Unit test for the web PROJECT CREDENTIALS API client (Settings tab). Pure over
 * an injected `fetchImpl` — no DOM, no network. Asserts each method targets the
 * right path/method/body, carries the bearer, splits the list by scope, and
 * surfaces a coded error. The token value is write-only, so the list never
 * exposes one — the rows are metadata.
 */

import { describe, expect, it } from 'bun:test'

import {
  WebProjectCredentialsClient,
  CredentialsClientError,
  type Rec,
} from '../project-credentials-client.ts'

const BASE = 'https://sam.neutron.test'
const TOKEN = 'dev:sam'

function rec(over: Partial<Rec> = {}): Rec {
  return {
    id: 'c1',
    owner_slug: 'sam',
    project_id: 'acme',
    scope: 'project',
    service: 'openai',
    label: null,
    created_at: '2026-06-20T00:00:00Z',
    updated_at: '2026-06-20T00:00:00Z',
    expires_at: null,
    ...over,
  }
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** Capture the single fetch call + serve a canned response. */
function capture(res: Response): {
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>
  calls: Array<{ url: string; method: string; body: unknown; auth: string | null }>
} {
  const calls: Array<{ url: string; method: string; body: unknown; auth: string | null }> = []
  return {
    calls,
    fetchImpl: async (url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      calls.push({
        url,
        method: init?.method ?? 'GET',
        body: init?.body !== undefined ? JSON.parse(init.body as string) : undefined,
        auth: headers['authorization'] ?? null,
      })
      return res
    },
  }
}

function makeClient(res: Response) {
  const cap = capture(res)
  const client = new WebProjectCredentialsClient({ base_url: BASE, token: TOKEN, fetchImpl: cap.fetchImpl })
  return { client, calls: cap.calls }
}

describe('WebProjectCredentialsClient', () => {
  it('list GETs /credentials with the bearer and splits project + global', async () => {
    const { client, calls } = makeClient(
      jsonRes({
        ok: true,
        project_id: 'acme',
        project: [rec()],
        global: [rec({ id: 'g1', scope: 'global', service: 'github' })],
      }),
    )
    const list = await client.list('acme')
    expect(list.project).toHaveLength(1)
    expect(list.global).toHaveLength(1)
    expect(list.global[0]!.scope).toBe('global')
    expect(calls[0]!.url).toBe(`${BASE}/api/app/projects/acme/credentials`)
    expect(calls[0]!.method).toBe('GET')
    expect(calls[0]!.auth).toBe(`Bearer ${TOKEN}`)
  })

  it('list defaults missing arrays to empty', async () => {
    const { client } = makeClient(jsonRes({ ok: true, project_id: 'acme' }))
    const list = await client.list('acme')
    expect(list).toEqual({ project: [], global: [] })
  })

  it('set POSTs the credential and returns the row', async () => {
    const { client, calls } = makeClient(jsonRes({ ok: true, credential: rec({ label: 'prod' }), project_id: 'acme' }, 201))
    const out = await client.set('acme', { service: 'openai', token: 'sk-xyz', scope: 'project', label: 'prod' })
    expect(out.label).toBe('prod')
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.url).toBe(`${BASE}/api/app/projects/acme/credentials`)
    expect(calls[0]!.body).toEqual({ service: 'openai', token: 'sk-xyz', scope: 'project', label: 'prod' })
    expect(calls[0]!.auth).toBe(`Bearer ${TOKEN}`)
  })

  it('remove DELETEs /credentials/<service> with the scope query param', async () => {
    const { client, calls } = makeClient(jsonRes({ ok: true, deleted: true, scope: 'global' }))
    await client.remove('acme', 'github', 'global')
    expect(calls[0]!.method).toBe('DELETE')
    expect(calls[0]!.url).toBe(`${BASE}/api/app/projects/acme/credentials/github?scope=global`)
  })

  it('encodes the project + service ids in the path', async () => {
    const { client, calls } = makeClient(jsonRes({ ok: true, deleted: true, scope: 'project' }))
    await client.remove('a/b', 'my service', 'project')
    expect(calls[0]!.url).toBe(`${BASE}/api/app/projects/a%2Fb/credentials/my%20service?scope=project`)
  })

  it('throws a coded CredentialsClientError on a non-2xx', async () => {
    const { client } = makeClient(jsonRes({ ok: false, code: 'invalid_service', message: 'bad' }, 400))
    await expect(client.set('acme', { service: '', token: 't', scope: 'project' })).rejects.toBeInstanceOf(
      CredentialsClientError,
    )
  })
})
