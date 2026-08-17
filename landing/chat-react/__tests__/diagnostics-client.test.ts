import { describe, expect, test } from 'bun:test'

import {
  DiagnosticsSendError,
  WebDiagnosticsClient,
  type WebClientReport,
} from '../diagnostics-client.ts'

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

/**
 * A rejected report used to be indistinguishable from a delivered one: the
 * client awaited the fetch and discarded the Response. Measured on the owner's
 * instance 2026-08-15 — four reports on disk, all mobile, not one web switch
 * timing — while he pasted the same numbers into chat by hand all day.
 */
describe('WebDiagnosticsClient — a refused report is not a delivered one', () => {
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

  for (const status of [400, 401, 403, 500]) {
    test(`HTTP ${status} throws, naming the status`, async () => {
      const client = new WebDiagnosticsClient({
        base_url: 'https://example.invalid',
        token: 't',
        fetchImpl: async () => new Response('{}', { status }),
      })
      let caught: unknown
      try {
        await client.sendReport(report)
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(DiagnosticsSendError)
      expect((caught as DiagnosticsSendError).status).toBe(status)
      // The status is the diagnosis — 401/403 is the bearer, 400 the payload —
      // so it has to survive into the message a human reads.
      expect((caught as Error).message).toContain(String(status))
    })
  }

  test('a 2xx still resolves silently', async () => {
    const client = new WebDiagnosticsClient({
      base_url: 'https://example.invalid',
      token: 't',
      fetchImpl: async () => new Response('{}', { status: 200 }),
    })
    expect(await client.sendReport(report)).toBeUndefined()
  })

  test('the bearer never appears in the thrown message', async () => {
    const client = new WebDiagnosticsClient({
      base_url: 'https://example.invalid',
      token: 'secret-bearer',
      fetchImpl: async () => new Response('{}', { status: 401 }),
    })
    let caught: unknown
    try {
      await client.sendReport(report)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(DiagnosticsSendError)
    expect((caught as Error).message).not.toContain('secret-bearer')
  })
})

/**
 * The default fetch must survive being stored and called as a method.
 *
 * `globalThis.fetch` assigned to a property and invoked as `this.fetchImpl(...)`
 * carries the CLIENT as its receiver, and a browser refuses: "Illegal
 * invocation". The request never leaves the page — which is why not one web
 * report ever reached the box, while the diagnosis chased bearers and payloads.
 *
 * Every other test in this file injects `fetchImpl`, so none of them ever
 * exercised the default. That is the gap this closes.
 */
describe('WebDiagnosticsClient — the DEFAULT fetch is called with the right receiver', () => {
  const report: WebClientReport = {
    schema: 1,
    report_id: 'r-default',
    created_at: 1,
    origin: 'https://example.invalid',
    reason: 'perf',
    app: { version: 'web', build: null, platform: 'web', os_version: null },
    session: { signed_in: true },
    events: [],
  }

  test('a receiver-checking global fetch is invoked correctly, not as a method of the client', async () => {
    // Stands in for the browser's real check: the DOM binding throws unless
    // `this` is the global object.
    const original = globalThis.fetch
    let sawUrl = ''
    const strict = function (this: unknown, url: string | URL | Request): Promise<Response> {
      if (this !== globalThis) {
        throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation")
      }
      sawUrl = String(url)
      return Promise.resolve(new Response('{}', { status: 200 }))
    }
    ;(globalThis as { fetch: unknown }).fetch = strict
    try {
      // No fetchImpl — this is the path production actually takes.
      const client = new WebDiagnosticsClient({ base_url: 'https://example.invalid', token: 't' })
      await client.sendReport(report)
      expect(sawUrl).toBe('https://example.invalid/api/app/admin/diagnostics/reports')
    } finally {
      ;(globalThis as { fetch: unknown }).fetch = original
    }
  })

  test('an injected fetchImpl is still used unchanged', async () => {
    // The binding must not steal the seam every other test depends on.
    let called = false
    const client = new WebDiagnosticsClient({
      base_url: 'https://example.invalid',
      token: 't',
      fetchImpl: async () => {
        called = true
        return new Response('{}', { status: 200 })
      },
    })
    await client.sendReport(report)
    expect(called).toBe(true)
  })
})
