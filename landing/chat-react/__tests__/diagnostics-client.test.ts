import { describe, expect, test } from 'bun:test'

import { WebDiagnosticsClient, type WebClientReport } from '../diagnostics-client.ts'

describe('WebDiagnosticsClient', () => {
  test('posts the report with bearer only in Authorization', async () => {
    let request: { url: string; init: RequestInit | undefined } | undefined
    const client = new WebDiagnosticsClient({
      base_url: 'https://example.invalid/',
      token: 'secret-bearer',
      fetchImpl: async (url, init) => {
        request = { url: String(url), init }
        return new Response('{}', { status: 200 })
      },
    })
    const report: WebClientReport = {
      schema: 1,
      report_id: 'r1',
      created_at: 1,
      origin: 'https://example.invalid',
      reason: 'perf',
      app: { version: 'web', build: null, platform: 'web', os_version: null },
      session: { signed_in: true },
      events: [],
    }

    await client.sendReport(report)

    expect(request?.url).toBe('https://example.invalid/api/app/admin/diagnostics/reports')
    expect((request?.init?.headers as Record<string, string>).authorization)
      .toBe('Bearer secret-bearer')
    expect(request?.init?.body).toBe(JSON.stringify({ reports: [report] }))
    expect(String(request?.init?.body)).not.toContain('secret-bearer')
  })
})
