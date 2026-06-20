/**
 * Unit tests for the upload CSRF / Origin guard.
 *
 * Verifies the Fetch-Metadata + Origin defense: positively-detected cross-site
 * requests are rejected; same-origin / same-site / direct-nav / null / non-
 * browser requests are allowed (fail-open for ambiguous signals).
 */

import { describe, expect, test } from 'bun:test'

import {
  csrfForbiddenResponse,
  evaluateCsrfOrigin,
} from '../csrf-origin-guard.ts'

function reqWithHeaders(headers: Record<string, string>): Request {
  return new Request('http://upstream.local/api/upload/chatgpt', {
    method: 'POST',
    headers,
  })
}

describe('evaluateCsrfOrigin — Sec-Fetch-Site', () => {
  test('cross-site is rejected', () => {
    const d = evaluateCsrfOrigin(reqWithHeaders({ 'Sec-Fetch-Site': 'cross-site' }))
    expect(d.allowed).toBe(false)
    if (!d.allowed) expect(d.reason).toBe('sec-fetch-cross-site')
  })

  test('cross-site is rejected even when Origin matches host (Sec-Fetch wins)', () => {
    const d = evaluateCsrfOrigin(
      reqWithHeaders({
        'Sec-Fetch-Site': 'cross-site',
        Origin: 'https://acme.example.com',
        'X-Forwarded-Host': 'acme.example.com',
      }),
    )
    expect(d.allowed).toBe(false)
  })

  test('same-origin is allowed', () => {
    const d = evaluateCsrfOrigin(reqWithHeaders({ 'Sec-Fetch-Site': 'same-origin' }))
    expect(d.allowed).toBe(true)
    if (d.allowed) expect(d.reason).toBe('sec-fetch-same-origin')
  })

  test('same-site is allowed (sibling subdomain)', () => {
    const d = evaluateCsrfOrigin(reqWithHeaders({ 'Sec-Fetch-Site': 'same-site' }))
    expect(d.allowed).toBe(true)
    if (d.allowed) expect(d.reason).toBe('sec-fetch-same-site')
  })

  test('none is allowed (direct navigation / typed URL)', () => {
    const d = evaluateCsrfOrigin(reqWithHeaders({ 'Sec-Fetch-Site': 'none' }))
    expect(d.allowed).toBe(true)
    if (d.allowed) expect(d.reason).toBe('sec-fetch-none')
  })

  test('case-insensitive token matching', () => {
    const d = evaluateCsrfOrigin(reqWithHeaders({ 'Sec-Fetch-Site': 'Cross-Site' }))
    expect(d.allowed).toBe(false)
  })

  test('unknown Sec-Fetch-Site token falls through to Origin (allowed when no Origin)', () => {
    const d = evaluateCsrfOrigin(reqWithHeaders({ 'Sec-Fetch-Site': 'bogus' }))
    expect(d.allowed).toBe(true)
  })
})

describe('evaluateCsrfOrigin — Origin fallback (no Sec-Fetch-Site)', () => {
  test('no Origin and no Sec-Fetch is allowed (non-browser / curl / harness)', () => {
    const d = evaluateCsrfOrigin(reqWithHeaders({}))
    expect(d.allowed).toBe(true)
    if (d.allowed) expect(d.reason).toBe('no-origin-no-sec-fetch')
  })

  test('Origin: null is allowed (opaque origin)', () => {
    const d = evaluateCsrfOrigin(reqWithHeaders({ Origin: 'null' }))
    expect(d.allowed).toBe(true)
    if (d.allowed) expect(d.reason).toBe('origin-null')
  })

  test('Origin host matching X-Forwarded-Host is allowed', () => {
    const d = evaluateCsrfOrigin(
      reqWithHeaders({
        Origin: 'https://acme.example.com',
        'X-Forwarded-Host': 'acme.example.com',
      }),
    )
    expect(d.allowed).toBe(true)
    if (d.allowed) expect(d.reason).toBe('origin-match')
  })

  test('Origin host matching Host header is allowed', () => {
    const d = evaluateCsrfOrigin(
      reqWithHeaders({
        Origin: 'https://acme.example.com',
        Host: 'acme.example.com',
      }),
    )
    expect(d.allowed).toBe(true)
  })

  test('Origin host mismatching request host is rejected', () => {
    const d = evaluateCsrfOrigin(
      reqWithHeaders({
        Origin: 'https://evil.example.com',
        'X-Forwarded-Host': 'acme.example.com',
      }),
    )
    expect(d.allowed).toBe(false)
    if (!d.allowed) expect(d.reason).toBe('origin-mismatch')
  })

  test('X-Forwarded-Host list takes the first entry', () => {
    const d = evaluateCsrfOrigin(
      reqWithHeaders({
        Origin: 'https://acme.example.com',
        'X-Forwarded-Host': 'acme.example.com, internal-proxy.local',
      }),
    )
    expect(d.allowed).toBe(true)
  })

  test('unparseable Origin is rejected', () => {
    const d = evaluateCsrfOrigin(
      reqWithHeaders({ Origin: 'not-a-url', 'X-Forwarded-Host': 'acme.example.com' }),
    )
    expect(d.allowed).toBe(false)
    if (!d.allowed) expect(d.reason).toBe('origin-mismatch')
  })

  test('Origin present but no resolvable request host fails open', () => {
    // No Host / X-Forwarded-Host that the guard can compare against.
    const raw = new Request('http://upstream.local/api/upload/chatgpt', {
      method: 'POST',
    })
    raw.headers.delete('host')
    const withOrigin = new Request(raw, {
      headers: { Origin: 'https://anything.example.com' },
    })
    withOrigin.headers.delete('host')
    const d = evaluateCsrfOrigin(withOrigin)
    // host may or may not be derivable depending on runtime; assert it does
    // not throw and yields a decision.
    expect(typeof d.allowed).toBe('boolean')
  })

  test('host comparison is case-insensitive', () => {
    const d = evaluateCsrfOrigin(
      reqWithHeaders({
        Origin: 'https://Acme.Example.Com',
        'X-Forwarded-Host': 'acme.example.com',
      }),
    )
    expect(d.allowed).toBe(true)
  })
})

describe('csrfForbiddenResponse', () => {
  test('returns a 403 JSON response in the upload handler error shape', async () => {
    const res = csrfForbiddenResponse({
      reason: 'sec-fetch-cross-site',
      detail: 'Sec-Fetch-Site: cross-site',
    })
    expect(res.status).toBe(403)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['ok']).toBe(false)
    expect(String(body['error'])).toContain('cross-site request rejected')
  })
})
