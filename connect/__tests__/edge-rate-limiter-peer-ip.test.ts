/**
 * Per-IP rate-limit keying on the PUBLIC Connect edge (ISSUES #421).
 *
 * `clientIpFromRequest` used to read `X-Forwarded-For` unconditionally, with the
 * documented justification "the connect node sits behind Caddy, which sets
 * X-Forwarded-For". That was a CONFIG-COUPLED invariant, not a code-enforced
 * one, and it was only ever true of a hosted box behind a known edge. Serving
 * Connect from every self-hosted install — many with a port forwarded straight
 * at the process and no reverse proxy anywhere — makes the header fully
 * attacker-controlled, and the per-IP cap on the two UNAUTHENTICATED endpoints
 * (`/connect/guest-auth`, `/connect/invite-preview`) evaporates: vary the header,
 * get a fresh window, every request.
 *
 * The rule now: the real TCP peer wins whenever it is not local; only a
 * loopback/RFC-1918 peer — a reverse proxy on the same host or LAN, i.e. exactly
 * the Managed Caddy shape — is allowed to speak for someone else.
 */

import { describe, expect, test } from 'bun:test'

import {
  clientIpFromRequest,
  createEdgeRateLimiter,
  isLocalPeerAddress,
} from '../api/edge-rate-limiter.ts'

const req = (headers: Record<string, string> = {}): Request =>
  new Request('http://node.example.com/connect/v1/connect/guest-auth', { headers })

describe('clientIpFromRequest — header trust', () => {
  test('a DIRECT internet peer cannot spoof its key with X-Forwarded-For', () => {
    // The exact bypass: same TCP peer, different header per request.
    const a = clientIpFromRequest(req({ 'x-forwarded-for': '1.1.1.1' }), '203.0.113.9')
    const b = clientIpFromRequest(req({ 'x-forwarded-for': '2.2.2.2' }), '203.0.113.9')
    expect(a).toBe('203.0.113.9')
    expect(b).toBe('203.0.113.9')
    expect(a).toBe(b)
  })

  test('X-Real-IP is equally ignored from a direct peer', () => {
    expect(clientIpFromRequest(req({ 'x-real-ip': '9.9.9.9' }), '203.0.113.9')).toBe('203.0.113.9')
  })

  test('a LOOPBACK peer (a local reverse proxy) may still speak for the client', () => {
    // Preserves the Managed posture byte for byte: Caddy on 127.0.0.1 forwards
    // the real client address and per-IP limiting stays meaningful.
    expect(clientIpFromRequest(req({ 'x-forwarded-for': '198.51.100.7, 10.0.0.2' }), '127.0.0.1')).toBe(
      '198.51.100.7',
    )
    expect(clientIpFromRequest(req({ 'x-real-ip': '198.51.100.8' }), '::1')).toBe('198.51.100.8')
  })

  test('an RFC-1918 peer (proxy on the LAN / in a container network) is trusted too', () => {
    expect(clientIpFromRequest(req({ 'x-forwarded-for': '198.51.100.7' }), '172.18.0.4')).toBe(
      '198.51.100.7',
    )
  })

  test('a local peer with NO forwarding header keys on the peer, not the shared bucket', () => {
    expect(clientIpFromRequest(req(), '127.0.0.1')).toBe('127.0.0.1')
  })

  test('no socket address at all falls back to the legacy header order, then a constant', () => {
    expect(clientIpFromRequest(req({ 'x-forwarded-for': '1.1.1.1' }))).toBe('1.1.1.1')
    expect(clientIpFromRequest(req())).toBe('unknown')
  })
})

describe('isLocalPeerAddress', () => {
  test('classifies loopback / private / link-local as local', () => {
    for (const ip of [
      '127.0.0.1',
      '127.15.2.9',
      '::1',
      '10.4.4.4',
      '192.168.1.20',
      '172.16.0.1',
      '172.31.255.254',
      '169.254.1.1',
      'fe80::1',
      'fd00::1',
      '::ffff:127.0.0.1',
    ]) {
      expect(isLocalPeerAddress(ip)).toBe(true)
    }
  })

  test('classifies public addresses as NOT local — including the 172.x near-misses', () => {
    for (const ip of ['203.0.113.9', '8.8.8.8', '172.15.0.1', '172.32.0.1', '2606:4700::1111', '']) {
      expect(isLocalPeerAddress(ip)).toBe(false)
    }
  })
})

describe('the limiter actually bites on a spoofing direct peer', () => {
  test('a header-rotating flood from one peer is capped', () => {
    const limiter = createEdgeRateLimiter({ windowMs: 60_000, max: { 'guest-auth': 3 } })
    const results: boolean[] = []
    for (let i = 0; i < 5; i += 1) {
      const key = clientIpFromRequest(req({ 'x-forwarded-for': `5.5.5.${i}` }), '203.0.113.9')
      results.push(limiter.check('guest-auth', key))
    }
    expect(results).toEqual([true, true, true, false, false])
  })
})
