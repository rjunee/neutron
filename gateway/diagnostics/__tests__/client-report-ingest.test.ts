/**
 * Remote app diagnostics — the gateway ingest + read routes.
 *
 * Three properties matter here and each is pinned below:
 *
 *   1. THE WRITE ENDPOINT IS AUTHENTICATED. There is no anonymous path. That
 *      constraint is why the app carries a persisted queue instead — an open
 *      write endpoint would be a log-injection sink on the owner's gateway.
 *   2. NO CREDENTIAL REACHES DISK. The gateway re-redacts on arrival, including
 *      the presented bearer as an exact needle, so an old / modified / buggy
 *      client cannot write a token into the operator's log.
 *   3. IT IS BOUNDED. Body size, batch size, events per report, and retained
 *      history all have ceilings.
 *
 * Uses the REAL `FileClientReportStore` on a throwaway directory — the store is
 * the thing an operator reads, so a fake here would test nothing.
 *
 * MUTATION-VERIFIED: neutralise `sanitizeBatch`'s scrub (return the payload
 * unchanged) and the redaction cases go red. Evidence is in the PR body.
 */

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'bun:test'
import type { AppWsAuthResolver } from '@neutronai/channels/adapters/app-ws/auth.ts'

import { createAppDiagnosticsSurface, MAX_REPORT_BODY_BYTES } from '../../http/app-diagnostics-surface.ts'
import { composeDiagnostics } from '../diagnostics-report.ts'
import { FileClientReportStore, type ClientReportRecord } from '../client-report-store.ts'

const SLUG = 'demo'
const BEARER =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJvd25lciJ9.s3cr3tS1gnatureV4lueTh4tMustNeverLeak'

const auth: AppWsAuthResolver = {
  mode: 'dev-bypass',
  resolve: async (token: string) => {
    if (token === BEARER)
      return { user_id: 'owner', project_slug: SLUG, mode: 'dev-bypass' as const }
    if (token === 'other')
      return { user_id: 'someone', project_slug: 'not-demo', mode: 'dev-bypass' as const }
    return { code: 'malformed_token' as const, message: 'nope' }
  },
}

const REPORTS_URL = 'http://x/api/app/admin/diagnostics/reports'

function harness(): { handler: (req: Request) => Promise<Response | null>; path: string } {
  const path = join(mkdtempSync(join(tmpdir(), 'neutron-diag-ingest-')), 'client-reports.jsonl')
  const surface = createAppDiagnosticsSurface({
    auth,
    project_slug: SLUG,
    diagnostics: () => composeDiagnostics({ project_slug: SLUG, now: () => 1 }),
    client_reports: new FileClientReportStore({ path, max_records: 5 }),
    now: () => 4_242,
  })
  return { handler: surface.handler, path }
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(REPORTS_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

function reportCarryingTheToken(): unknown {
  return {
    schema: 1,
    report_id: 'r1',
    created_at: 10,
    reason: 'js_error',
    app: { version: '1.0.0', build: '42', platform: 'android', os_version: '14' },
    session: { signed_in: true },
    events: [
      { at: 1, level: 'error', kind: 'js_error', message: `failed with Bearer ${BEARER}` },
      {
        at: 2,
        level: 'error',
        kind: 'js_error',
        message: 'nested',
        stack: `at authedFetch\n  token=${BEARER}`,
        context: { headers: { authorization: `Bearer ${BEARER}` }, keep: 'visible' },
      },
    ],
  }
}

describe('POST /api/app/admin/diagnostics/reports — authentication', () => {
  it('401s an unauthenticated write — there is NO anonymous ingest path', async () => {
    const { handler, path } = harness()
    const res = await handler(post({ reports: [reportCarryingTheToken()] }))
    expect(res!.status).toBe(401)
    expect(() => readFileSync(path, 'utf8')).toThrow()
  })

  it('403s a bearer that belongs to a different instance', async () => {
    const { handler } = harness()
    const res = await handler(
      post({ reports: [reportCarryingTheToken()] }, { authorization: 'Bearer other' }),
    )
    expect(res!.status).toBe(403)
  })

  it('405s a method it does not serve', async () => {
    const { handler } = harness()
    const res = await handler(
      new Request(REPORTS_URL, { method: 'DELETE', headers: { authorization: `Bearer ${BEARER}` } }),
    )
    expect(res!.status).toBe(405)
  })
})

describe('POST /api/app/admin/diagnostics/reports — redaction', () => {
  it('writes NO part of the presented bearer to disk', async () => {
    const { handler, path } = harness()
    const res = await handler(
      post({ reports: [reportCarryingTheToken()] }, { authorization: `Bearer ${BEARER}` }),
    )
    expect(res!.status).toBe(200)

    const written = readFileSync(path, 'utf8')
    expect(written).not.toContain(BEARER)
    expect(written).not.toContain(BEARER.split('.')[2])
    expect(written).not.toContain(BEARER.slice(0, 40))
    // …and the diagnostic content around it survives.
    expect(written).toContain('at authedFetch')
    expect(written).toContain('visible')
  })

  it('redacts a token the request never presented (an OLD session in a stack)', async () => {
    const { handler, path } = harness()
    const stale = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvbGQifQ.oldSess1onSignatureValueRightHere'
    await handler(
      post(
        {
          reports: [
            {
              report_id: 'r2',
              events: [{ at: 1, level: 'error', kind: 'js_error', message: `stale ${stale}` }],
            },
          ],
        },
        { authorization: `Bearer ${BEARER}` },
      ),
    )
    expect(readFileSync(path, 'utf8')).not.toContain(stale)
  })

  it('stamps the SERVER-observed identity + time, never the payload’s claim', async () => {
    const { handler, path } = harness()
    await handler(
      post(
        { reports: [{ report_id: 'r3', user_id: 'impostor', received_at: 1, events: [] }] },
        { authorization: `Bearer ${BEARER}` },
      ),
    )
    const record = JSON.parse(readFileSync(path, 'utf8').trim()) as ClientReportRecord
    expect(record.user_id).toBe('owner')
    expect(record.received_at).toBe(4_242)
  })
})

describe('POST /api/app/admin/diagnostics/reports — bounds', () => {
  it('413s a body over the ceiling instead of parsing it', async () => {
    const { handler } = harness()
    const huge = 'x'.repeat(MAX_REPORT_BODY_BYTES + 1_000)
    const res = await handler(
      post(JSON.stringify({ reports: [{ report_id: 'big', events: [], reason: huge }] }), {
        authorization: `Bearer ${BEARER}`,
      }),
    )
    expect(res!.status).toBe(413)
  })

  it('400s a body that is not JSON', async () => {
    const { handler } = harness()
    const res = await handler(post('{not json', { authorization: `Bearer ${BEARER}` }))
    expect(res!.status).toBe(400)
  })

  it('400s a batch with no usable reports', async () => {
    const { handler } = harness()
    const res = await handler(post({ reports: [] }, { authorization: `Bearer ${BEARER}` }))
    expect(res!.status).toBe(400)
  })

  it('truncates an over-long batch and SAYS how much it dropped', async () => {
    const { handler } = harness()
    const reports = Array.from({ length: 25 }, (_v, i) => ({ report_id: `r${i}`, events: [] }))
    const res = await handler(post({ reports }, { authorization: `Bearer ${BEARER}` }))
    const body = (await res!.json()) as { accepted: number; dropped: number }
    expect(body.accepted).toBe(10)
    expect(body.dropped).toBe(15)
  })

  it('retains a bounded history — a crash loop cannot fill the disk', async () => {
    const { handler, path } = harness() // max_records: 5
    for (let i = 0; i < 12; i += 1) {
      await handler(
        post({ reports: [{ report_id: `r${i}`, events: [] }] }, { authorization: `Bearer ${BEARER}` }),
      )
    }
    const lines = readFileSync(path, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(5)
    const ids = lines.map((line) => (JSON.parse(line) as ClientReportRecord).report.report_id)
    expect(ids).toEqual(['r7', 'r8', 'r9', 'r10', 'r11'])
  })
})

describe('GET /api/app/admin/diagnostics/reports', () => {
  it('returns the history newest-first to an owner bearer', async () => {
    const { handler } = harness()
    for (const id of ['a', 'b', 'c']) {
      await handler(post({ reports: [{ report_id: id, events: [] }] }, { authorization: `Bearer ${BEARER}` }))
    }
    const res = await handler(
      new Request(REPORTS_URL, { headers: { authorization: `Bearer ${BEARER}` } }),
    )
    expect(res!.status).toBe(200)
    const body = (await res!.json()) as { reports: ClientReportRecord[] }
    expect(body.reports.map((r) => r.report.report_id)).toEqual(['c', 'b', 'a'])
  })

  it('401s an unauthenticated read', async () => {
    const { handler } = harness()
    const res = await handler(new Request(REPORTS_URL))
    expect(res!.status).toBe(401)
  })

  it('honours ?limit', async () => {
    const { handler } = harness()
    for (const id of ['a', 'b', 'c']) {
      await handler(post({ reports: [{ report_id: id, events: [] }] }, { authorization: `Bearer ${BEARER}` }))
    }
    const res = await handler(
      new Request(`${REPORTS_URL}?limit=2`, { headers: { authorization: `Bearer ${BEARER}` } }),
    )
    const body = (await res!.json()) as { reports: ClientReportRecord[] }
    expect(body.reports.map((r) => r.report.report_id)).toEqual(['c', 'b'])
  })
})

describe('route ownership', () => {
  it('still serves the O5 read route and disclaims everything else', async () => {
    const { handler } = harness()
    const o5 = await handler(
      new Request('http://x/api/app/admin/diagnostics', {
        headers: { authorization: `Bearer ${BEARER}` },
      }),
    )
    expect(o5!.status).toBe(200)
    expect(await handler(new Request('http://x/healthz'))).toBeNull()
    expect(await handler(new Request('http://x/api/app/admin/diagnostics/other'))).toBeNull()
  })
})
