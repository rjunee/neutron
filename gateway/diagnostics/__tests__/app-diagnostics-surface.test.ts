/**
 * O5 — read-only diagnostics surface tests.
 *
 *  - the endpoint returns each section (round-trips the composed report),
 *  - it is OWNER-gated: no bearer → 401, wrong-slug bearer → 403,
 *  - only GET is allowed, and
 *  - the surface disclaims every non-diagnostics path (returns null) so it
 *    never shadows a sibling — including `/healthz`.
 */

import { describe, expect, it } from 'bun:test'
import type { AppWsAuthResolver } from '@neutronai/channels/adapters/app-ws/auth.ts'
import { createAppDiagnosticsSurface } from '../../http/app-diagnostics-surface.ts'
import { composeDiagnostics } from '../diagnostics-report.ts'

const GATEWAY_SLUG = 'demo'

/** Minimal resolver: `good` → owner of THIS slug; `other` → a different slug;
 *  anything else → an auth error. */
const auth: AppWsAuthResolver = {
  mode: 'dev-bypass',
  resolve: async (token: string) => {
    if (token === 'good')
      return { user_id: 'owner', project_slug: GATEWAY_SLUG, mode: 'dev-bypass' as const }
    if (token === 'other')
      return { user_id: 'someone', project_slug: 'not-demo', mode: 'dev-bypass' as const }
    return { code: 'malformed_token' as const, message: 'nope' }
  },
}

function surface(diagnostics: () => ReturnType<typeof composeDiagnostics> = () =>
  composeDiagnostics({
    project_slug: GATEWAY_SLUG,
    now: () => 123,
    credentials: () => ({ hasUsable: true, soonestCooldownUntil: null }),
  }),
) {
  return createAppDiagnosticsSurface({ auth, project_slug: GATEWAY_SLUG, diagnostics })
}

const URL_BASE = 'http://x/api/app/admin/diagnostics'
function req(headers: Record<string, string> = {}, method = 'GET'): Request {
  return new Request(URL_BASE, { method, headers })
}

describe('app-diagnostics-surface', () => {
  it('returns the composed report with every section for an owner bearer', async () => {
    const res = await surface().handler(req({ authorization: 'Bearer good' }))
    expect(res).not.toBeNull()
    expect(res!.status).toBe(200)
    const body = (await res!.json()) as { ok: boolean; diagnostics: Record<string, unknown> }
    expect(body.ok).toBe(true)
    const d = body.diagnostics
    expect(d.project_slug).toBe(GATEWAY_SLUG)
    for (const key of [
      'gbrain',
      'credentials',
      'core_install',
      'repl_sessions',
      'cron_jobs',
      'import_jobs',
      'recent_events',
    ]) {
      expect(d[key]).toBeDefined()
      expect((d[key] as { available: boolean }).available).toBeDefined()
    }
    // the wired section reflects its source
    expect((d.credentials as { has_usable: boolean }).has_usable).toBe(true)
  })

  it('rejects an unauthenticated request with 401', async () => {
    const res = await surface().handler(req())
    expect(res!.status).toBe(401)
    const body = (await res!.json()) as { ok: boolean; code: string }
    expect(body.ok).toBe(false)
    expect(body.code).toBe('missing_bearer')
  })

  it('rejects a bearer that resolves to a different instance slug with 403', async () => {
    const res = await surface().handler(req({ authorization: 'Bearer other' }))
    expect(res!.status).toBe(403)
    const body = (await res!.json()) as { code: string }
    expect(body.code).toBe('project_mismatch')
  })

  it('rejects an invalid token with 401', async () => {
    const res = await surface().handler(req({ authorization: 'Bearer garbage' }))
    expect(res!.status).toBe(401)
    const body = (await res!.json()) as { code: string }
    expect(body.code).toBe('malformed_token')
  })

  it('allows only GET (405 on POST)', async () => {
    const res = await surface().handler(req({ authorization: 'Bearer good' }, 'POST'))
    expect(res!.status).toBe(405)
  })

  it('disclaims non-diagnostics paths (returns null) — never shadows /healthz', async () => {
    const s = surface()
    expect(await s.handler(new Request('http://x/healthz'))).toBeNull()
    expect(await s.handler(new Request('http://x/api/app/admin/memory'))).toBeNull()
    expect(await s.handler(new Request('http://x/api/app/chat/send'))).toBeNull()
  })

  it('surfaces a composition throw as 500 without crashing', async () => {
    const s = surface(() => {
      throw new Error('kaboom')
    })
    const res = await s.handler(req({ authorization: 'Bearer good' }))
    expect(res!.status).toBe(500)
    const body = (await res!.json()) as { code: string }
    expect(body.code).toBe('diagnostics_failed')
  })
})
