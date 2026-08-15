/**
 * O5 — read-only diagnostics surface tests.
 *
 *  - the endpoint returns each section (round-trips the composed report),
 *  - it is OWNER-gated: no bearer → 401, wrong-slug bearer → 403,
 *  - only GET is allowed, and
 *  - the surface disclaims every non-diagnostics path (returns null) so it
 *    never shadows a sibling — including `/healthz`.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'bun:test'
import { SignJWT } from 'jose'
import type { AppWsAuthResolver } from '@neutronai/channels/adapters/app-ws/auth.ts'
import { createAppWsAuthResolver } from '@neutronai/channels/index.ts'
import { createAppDiagnosticsSurface } from '../../http/app-diagnostics-surface.ts'
import { composeDiagnostics } from '../diagnostics-report.ts'
import { FileClientReportStore } from '../client-report-store.ts'

const GATEWAY_SLUG = 'demo'

/** A REAL store on a throwaway path. These cases never touch the reports
 *  routes, but the dependency is required (remote diagnostics ships ON — there
 *  is no reports-disabled code path), so they get a real one rather than a
 *  stub that could drift from the interface. */
function tmpReportStore(): FileClientReportStore {
  return new FileClientReportStore({
    path: join(mkdtempSync(join(tmpdir(), 'neutron-diag-')), 'client-reports.jsonl'),
  })
}

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
  return createAppDiagnosticsSurface({
    auth,
    project_slug: GATEWAY_SLUG,
    diagnostics,
    client_reports: tmpReportStore(),
  })
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

  it('403s a wrong-project token via the REAL HS256 resolver (project_mismatch → 403, not 401)', async () => {
    // Production path: the HS256 resolver cross-checks the token's project_slug
    // claim against the gateway slug INTERNALLY and returns a `project_mismatch`
    // AUTH ERROR (never a resolved identity). The surface must map that to 403.
    const secret = 'test-secret-key'
    const realAuth = createAppWsAuthResolver({ project_slug: GATEWAY_SLUG, bypass: false, hs256_secret: secret })
    const token = await new SignJWT({ sub: 'owner', project_slug: 'not-demo' })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime(Math.floor(Date.now() / 1000) + 60)
      .sign(new TextEncoder().encode(secret))

    const s = createAppDiagnosticsSurface({
      auth: realAuth,
      project_slug: GATEWAY_SLUG,
      diagnostics: () => composeDiagnostics({ project_slug: GATEWAY_SLUG }),
      client_reports: tmpReportStore(),
    })
    const res = await s.handler(req({ authorization: `Bearer ${token}` }))
    expect(res!.status).toBe(403)
    const body = (await res!.json()) as { code: string }
    expect(body.code).toBe('project_mismatch')
  })

  it('401s a bad-signature token via the REAL HS256 resolver (authentication failure)', async () => {
    const realAuth = createAppWsAuthResolver({ project_slug: GATEWAY_SLUG, bypass: false, hs256_secret: 'right-secret' })
    const token = await new SignJWT({ sub: 'owner', project_slug: GATEWAY_SLUG })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime(Math.floor(Date.now() / 1000) + 60)
      .sign(new TextEncoder().encode('wrong-secret'))
    const s = createAppDiagnosticsSurface({
      auth: realAuth,
      project_slug: GATEWAY_SLUG,
      diagnostics: () => composeDiagnostics({ project_slug: GATEWAY_SLUG }),
      client_reports: tmpReportStore(),
    })
    const res = await s.handler(req({ authorization: `Bearer ${token}` }))
    expect(res!.status).toBe(401)
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

/**
 * A refused ingest must leave a trace ON THE BOX.
 *
 * Both sides of this route were silent: the web client is fire-and-forget, and
 * the operator's only view is the reports file — which stays EMPTY on refusal,
 * and an empty file reads exactly like "nothing to report". Measured on the
 * owner's instance 2026-08-15: four reports on disk, all mobile, not one web
 * switch timing, while he spent the day pasting those timings into chat by hand.
 * Nobody could tell the pipeline was rejecting everything, because rejecting
 * everything and having nothing to say produce the identical artefact.
 */
describe('app-diagnostics-surface — a refused ingest is logged, not silent', () => {
  const REPORTS_URL = `${URL_BASE.replace(/\/$/, '')}/reports`
  function postReq(headers: Record<string, string> = {}, body = '{"reports":[{"schema":1}]}'): Request {
    return new Request(REPORTS_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
    })
  }
  function captureLogs(): { lines: string[]; restore: () => void } {
    const lines: string[] = []
    const origWarn = console.warn
    const origErr = console.error
    const origLog = console.log
    const grab = (...args: unknown[]) => {
      lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
    }
    console.warn = grab
    console.error = grab
    console.log = grab
    return {
      lines,
      restore: () => {
        console.warn = origWarn
        console.error = origErr
        console.log = origLog
      },
    }
  }

  it('logs report_ingest_refused when the bearer is missing (401)', async () => {
    const cap = captureLogs()
    let res: Response | null
    try {
      res = await surface().handler(postReq())
    } finally {
      cap.restore()
    }
    expect(res!.status).toBe(401)
    expect(cap.lines.some((l) => l.includes('report_ingest_refused'))).toBe(true)
  })

  it('logs report_ingest_refused when the bearer belongs to another instance (403)', async () => {
    const cap = captureLogs()
    let res: Response | null
    try {
      res = await surface().handler(postReq({ authorization: 'Bearer other' }))
    } finally {
      cap.restore()
    }
    expect(res!.status).toBe(403)
    expect(cap.lines.some((l) => l.includes('report_ingest_refused'))).toBe(true)
  })

  it('never writes the presented bearer into the log line', async () => {
    const cap = captureLogs()
    try {
      await surface().handler(postReq({ authorization: 'Bearer super-secret-value' }))
    } finally {
      cap.restore()
    }
    expect(cap.lines.join('\n')).not.toContain('super-secret-value')
  })

  it('an ACCEPTED report logs no refusal', async () => {
    const cap = captureLogs()
    let res: Response | null
    try {
      res = await surface().handler(
        postReq({ authorization: 'Bearer good' }, '{"reports":[{"schema":1,"reason":"perf"}]}'),
      )
    } finally {
      cap.restore()
    }
    expect(res!.status).toBe(200)
    expect(cap.lines.some((l) => l.includes('report_ingest_refused'))).toBe(false)
  })
})
