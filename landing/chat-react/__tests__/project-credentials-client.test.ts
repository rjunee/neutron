/**
 * Unit test for the web CREDENTIALS API client. Pure over an injected
 * `fetchImpl` — no DOM, no network. Asserts each method targets the right
 * path/method/body, carries the bearer, splits the list by scope, and surfaces
 * a coded error. The token value is write-only, so the list never exposes one —
 * the rows are metadata.
 *
 * The load-bearing assertions here are the PATHS (ISSUES #486): the project
 * methods must only ever address `/api/app/projects/<id>/credentials`, and the
 * global ones only `/api/app/credentials`. There is no `scope` argument left to
 * point one at the other.
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
    const out = await client.set('acme', { service: 'openai', token: 'sk-xyz', label: 'prod' })
    expect(out.label).toBe('prod')
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.url).toBe(`${BASE}/api/app/projects/acme/credentials`)
    expect(calls[0]!.body).toEqual({ service: 'openai', token: 'sk-xyz', label: 'prod' })
    expect(calls[0]!.auth).toBe(`Bearer ${TOKEN}`)
  })

  // #486 — the project write path carries NO scope. Not "defaults to project":
  // there is no field on the wire that a caller could set to 'global'.
  it('set never puts a scope on the wire, so a project write cannot ask for global', async () => {
    const { client, calls } = makeClient(jsonRes({ ok: true, credential: rec(), project_id: 'acme' }, 201))
    await client.set('acme', { service: 'openai', token: 'sk-xyz' })
    expect(calls[0]!.body).toEqual({ service: 'openai', token: 'sk-xyz' })
    expect(Object.keys(calls[0]!.body as object)).not.toContain('scope')
    expect(calls[0]!.url).toBe(`${BASE}/api/app/projects/acme/credentials`)
  })

  it('remove DELETEs the project path, with no scope query param', async () => {
    const { client, calls } = makeClient(jsonRes({ ok: true, deleted: 'github', scope: 'project' }))
    await client.remove('acme', 'github')
    expect(calls[0]!.method).toBe('DELETE')
    expect(calls[0]!.url).toBe(`${BASE}/api/app/projects/acme/credentials/github`)
    expect(calls[0]!.url).not.toContain('scope=')
  })

  it('encodes the project + service ids in the path', async () => {
    const { client, calls } = makeClient(jsonRes({ ok: true, deleted: 'my service', scope: 'project' }))
    await client.remove('a/b', 'my service')
    expect(calls[0]!.url).toBe(`${BASE}/api/app/projects/a%2Fb/credentials/my%20service`)
  })

  it('throws a coded CredentialsClientError on a non-2xx', async () => {
    const { client } = makeClient(jsonRes({ ok: false, code: 'invalid_service', message: 'bad' }, 400))
    await expect(client.set('acme', { service: '', token: 't' })).rejects.toBeInstanceOf(
      CredentialsClientError,
    )
  })

  // ── the GLOBAL family (Admin tab) — the only writer of instance-wide state ──

  it('listGlobal GETs the project-less path', async () => {
    const { client, calls } = makeClient(
      jsonRes({ ok: true, global: [rec({ id: 'g1', scope: 'global', project_id: '', service: 'github' })] }),
    )
    const rows = await client.listGlobal()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.scope).toBe('global')
    expect(calls[0]!.url).toBe(`${BASE}/api/app/credentials`)
    expect(calls[0]!.method).toBe('GET')
    expect(calls[0]!.auth).toBe(`Bearer ${TOKEN}`)
  })

  it('listGlobal defaults a missing array to empty', async () => {
    const { client } = makeClient(jsonRes({ ok: true }))
    expect(await client.listGlobal()).toEqual([])
  })

  it('setGlobal POSTs the project-less path — no project id can be involved', async () => {
    const { client, calls } = makeClient(
      jsonRes({ ok: true, credential: rec({ scope: 'global', project_id: '' }) }, 201),
    )
    const out = await client.setGlobal({ service: 'openai', token: 'sk-xyz' })
    expect(out.scope).toBe('global')
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.url).toBe(`${BASE}/api/app/credentials`)
    expect(calls[0]!.url).not.toContain('/projects/')
  })

  it('removeGlobal DELETEs the project-less path', async () => {
    const { client, calls } = makeClient(jsonRes({ ok: true, deleted: 'github', scope: 'global' }))
    await client.removeGlobal('my service')
    expect(calls[0]!.method).toBe('DELETE')
    expect(calls[0]!.url).toBe(`${BASE}/api/app/credentials/my%20service`)
  })
})
