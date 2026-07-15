/**
 * surface-kit-wire.test.ts — BEHAVIOURAL coverage for the O7-centralized
 * gateway/http surface boilerplate (resolveBearer / readJsonBody / jsonResponse /
 * jsonOk / jsonError). The source-regex guard (owner-slug-timing-safe.test.ts)
 * proves surfaces ROUTE through here; this file EXECUTES the shared code so a wire
 * regression in the one canonical implementation is caught (Codex).
 */

import { describe, expect, it } from 'bun:test'
import type { AppWsAuthResolver } from '@neutronai/channels/adapters/app-ws/auth.ts'
import { resolveBearer, readJsonBody, jsonResponse, jsonOk, jsonError } from '../surface-kit.ts'

/** A resolver that succeeds, recording the exact token it was handed. */
function okResolver(seen: string[]): AppWsAuthResolver {
  return {
    resolve: async (token: string) => {
      seen.push(token)
      return { ok: true as const, user_id: 'u1', project_slug: 'owner' }
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

/** A resolver that fails with its own code/message (must pass through verbatim). */
function failResolver(): AppWsAuthResolver {
  return {
    resolve: async () => ({ code: 'bad_token', message: 'token expired' }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

const bearerReq = (header?: string): Request =>
  new Request('http://x/', header === undefined ? {} : { headers: { authorization: header } })

describe('resolveBearer', () => {
  it('a missing Authorization header → missing_bearer failure', async () => {
    const r = await resolveBearer(bearerReq(), okResolver([]))
    expect(r).toEqual({ code: 'missing_bearer', message: 'expected Authorization: Bearer <token>' })
  })

  it('a non-bearer scheme → missing_bearer failure', async () => {
    const r = await resolveBearer(bearerReq('Basic abc'), okResolver([]))
    expect((r as { code: string }).code).toBe('missing_bearer')
  })

  it('the "bearer " prefix is case-INSENSITIVE + the token is trimmed', async () => {
    const seen: string[] = []
    const r = await resolveBearer(bearerReq('BeArEr    dev:owner   '), okResolver(seen))
    expect(seen).toEqual(['dev:owner']) // resolver saw the trimmed token
    expect(r).toEqual({ user_id: 'u1', project_slug: 'owner' })
  })

  it('a bare "Bearer" with no token → missing_bearer, resolver never reached', async () => {
    // The Headers API normalizes away trailing whitespace, so `Bearer ` collapses
    // to `Bearer` — no `bearer ` prefix → missing_bearer before the resolver.
    const seen: string[] = []
    const r = await resolveBearer(bearerReq('Bearer'), okResolver(seen))
    expect((r as { code: string }).code).toBe('missing_bearer')
    expect(seen).toEqual([])
  })

  it('propagates the resolver failure code/message verbatim (no wrapping)', async () => {
    const r = await resolveBearer(bearerReq('Bearer t'), failResolver())
    expect(r).toEqual({ code: 'bad_token', message: 'token expired' })
  })

  it('a success resolves to exactly { user_id, project_slug }', async () => {
    const r = await resolveBearer(bearerReq('Bearer t'), okResolver([]))
    expect(r).toEqual({ user_id: 'u1', project_slug: 'owner' })
    expect(Object.keys(r as object)).toEqual(['user_id', 'project_slug'])
  })
})

describe('readJsonBody', () => {
  it('parses a valid JSON body', async () => {
    const req = new Request('http://x/', { method: 'POST', body: JSON.stringify({ a: 1 }) })
    expect(await readJsonBody(req)).toEqual({ a: 1 })
  })

  it('returns null on malformed JSON', async () => {
    const req = new Request('http://x/', { method: 'POST', body: '{ not json' })
    expect(await readJsonBody(req)).toBeNull()
  })

  it('returns null on an empty body', async () => {
    const req = new Request('http://x/', { method: 'POST', body: '' })
    expect(await readJsonBody(req)).toBeNull()
  })
})

describe('jsonResponse / jsonOk / jsonError — exact wire shape', () => {
  it('jsonResponse defaults to application/json + preserves the status', async () => {
    const res = jsonResponse(201, { x: 1 })
    expect(res.status).toBe(201)
    expect(res.headers.get('content-type')).toBe('application/json')
    expect(await res.json()).toEqual({ x: 1 })
  })

  it('jsonResponse honours a custom content-type (the charset-pinning call sites)', () => {
    const res = jsonResponse(200, {}, 'application/json; charset=utf-8')
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8')
  })

  it('jsonOk → { ok: true, ...body }, default status 200, custom status preserved', async () => {
    const res = jsonOk({ item: 'a' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, item: 'a' })
    expect(jsonOk({}, 202).status).toBe(202)
  })

  it('jsonError → { ok: false, code, message } with the field ORDER ok,code,message', async () => {
    const res = jsonError(404, 'not_found', 'nope')
    expect(res.status).toBe(404)
    const text = await res.text()
    expect(text).toBe('{"ok":false,"code":"not_found","message":"nope"}') // exact serialized bytes
  })

  it('jsonError merges `extra` AFTER the base fields (field key add)', async () => {
    const res = jsonError(400, 'invalid', 'bad', { field: 'name' })
    expect(await res.json()).toEqual({ ok: false, code: 'invalid', message: 'bad', field: 'name' })
    expect(await jsonError(400, 'invalid', 'bad', { field: 'name' }).text()).toBe(
      '{"ok":false,"code":"invalid","message":"bad","field":"name"}',
    )
  })

  it('an `extra` key colliding with a base field OVERRIDES it (spread-after semantics)', async () => {
    // Documented behaviour: `extra` is spread last, so a colliding key wins. Pins
    // it so a future reorder is a deliberate, test-visible change.
    const res = jsonError(400, 'base', 'msg', { code: 'override' })
    expect(((await res.json()) as { code: string }).code).toBe('override')
  })
})
