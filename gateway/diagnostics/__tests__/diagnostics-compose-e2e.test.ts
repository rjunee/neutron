/**
 * O5 — composed-handler boundary test. Proves `/api/app/admin/diagnostics` is
 * reachable AND protected THROUGH the real route-slot registry + `compose.ts`
 * (not just the surface in isolation), and that it never shadows `/healthz`.
 *
 * Dispatches through `composeHttpHandler` exactly as production does (the
 * `appDiagnostics` slot promotes `app_diagnostics_surface.handler`), using the
 * in-process no-socket call the sibling surface suites use.
 */

import { describe, expect, it } from 'bun:test'
import { createAppWsAuthResolver } from '@neutronai/channels/index.ts'
import { composeHttpHandler, type ComposedHttpHandler } from '../../http/compose.ts'
import { createAppDiagnosticsSurface } from '../../http/app-diagnostics-surface.ts'
import { composeDiagnostics } from '../diagnostics-report.ts'

const SLUG = 'demo'

function composed(resolverSlug: string = SLUG): ComposedHttpHandler {
  const surface = createAppDiagnosticsSurface({
    // dev-bypass binds the resolved identity to `resolverSlug`; when that ≠ the
    // surface's `project_slug` we exercise the 403 instance-boundary path.
    auth: createAppWsAuthResolver({ project_slug: resolverSlug, bypass: true }),
    project_slug: SLUG,
    diagnostics: () => composeDiagnostics({ project_slug: SLUG, now: () => 1 }),
  })
  return composeHttpHandler({
    appDiagnostics: { handler: surface.handler },
    defaultHandler: (req) =>
      new URL(req.url).pathname === '/healthz'
        ? new Response('healthz-served-by-default', { status: 200 })
        : new Response('not found', { status: 404 }),
  })
}

function hit(c: ComposedHttpHandler, path: string, headers: Record<string, string> = {}): Promise<Response> {
  return Promise.resolve(c.fetch(new Request(`http://gw.test${path}`, { headers }), undefined as never))
}

describe('diagnostics — composed Open handler boundary', () => {
  it('owner bearer → 200 with the composed report', async () => {
    const res = await hit(composed(), '/api/app/admin/diagnostics', { authorization: 'Bearer dev:owner' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; diagnostics: { project_slug: string } }
    expect(body.ok).toBe(true)
    expect(body.diagnostics.project_slug).toBe(SLUG)
  })

  it('missing bearer → 401 through the chain', async () => {
    const res = await hit(composed(), '/api/app/admin/diagnostics')
    expect(res.status).toBe(401)
  })

  it('bearer for a different project → 403 through the chain', async () => {
    const res = await hit(composed('other-owner'), '/api/app/admin/diagnostics', {
      authorization: 'Bearer dev:owner',
    })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('project_mismatch')
  })

  it('/healthz is NOT shadowed — falls through to the default handler', async () => {
    const res = await hit(composed(), '/healthz')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('healthz-served-by-default')
  })
})
