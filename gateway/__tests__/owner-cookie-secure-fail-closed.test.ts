/**
 * ISSUES #392 — the owner session cookie's `Secure` flag must FAIL CLOSED.
 *
 * Before this, `Secure` was derived from `resolveRequestScheme`, which prefers
 * `X-Forwarded-Proto` — so a client-supplied `X-Forwarded-Proto: http` could
 * strip `Secure` off the owner's session cookie. Not exploitable on the hosted
 * box (Caddy overwrites the client value; verified live 2026-07-25), but Open
 * is self-hosted and we do not control every proxy placed in front of it.
 *
 * The invariant these lock in: the ONLY way to get a cookie without `Secure` is
 * to be a plain-http request to a loopback host with no proxy in front. Every
 * other shape — including every hostile or merely surprising one — is Secure.
 */
import { describe, expect, test } from 'bun:test'
import { isLoopbackHost, shouldSetSecureCookie } from '../http/app-ws-surface.ts'

function req(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { headers })
}

describe('owner cookie Secure fails closed (#392)', () => {
  test('THE ATTACK: a client-supplied X-Forwarded-Proto: http cannot strip Secure', () => {
    // The exact regression. Pre-fix this returned false and the owner's session
    // cookie went out without `Secure`, free to ride a plain-http downgrade.
    expect(
      shouldSetSecureCookie(
        req('http://127.0.0.1:7800/chat', {
          host: 'juno.example.com',
          'x-forwarded-proto': 'http',
        }),
      ),
    ).toBe(true)
  })

  test('a proxied request is Secure even when the header value is junk', () => {
    // Presence of any x-forwarded-* means a proxy is in front, so this is not a
    // direct dev session no matter what the value claims.
    expect(
      shouldSetSecureCookie(req('http://127.0.0.1:7800/chat', { 'x-forwarded-proto': 'gopher' })),
    ).toBe(true)
    expect(
      shouldSetSecureCookie(req('http://127.0.0.1:7800/chat', { 'x-forwarded-host': 'evil' })),
    ).toBe(true)
  })

  test('the hosted shape (TLS proxy → loopback bind) is Secure', () => {
    expect(
      shouldSetSecureCookie(
        req('http://127.0.0.1:7800/chat', {
          host: 'juno.example.com',
          'x-forwarded-proto': 'https',
        }),
      ),
    ).toBe(true)
  })

  test('plain http to a NON-loopback host is Secure — an unexpected deployment fails closed', () => {
    // The deliberate trade: a LAN-http self-hoster gets a cookie the browser
    // refuses, and a visible failure, rather than an unprotected cookie and a
    // silent one.
    expect(shouldSetSecureCookie(req('http://192.168.1.10:7800/chat', { host: '192.168.1.10' }))).toBe(
      true,
    )
    expect(shouldSetSecureCookie(req('http://neutron.example.com/chat', { host: 'neutron.example.com' }))).toBe(
      true,
    )
  })

  test('with no Host header the request URL decides — a direct loopback bind is exempt', () => {
    // A constructed Request carries no `Host`, and so does a client that omits
    // it; the URL host is then the only evidence available. This is safe
    // because any proxied request was already forced Secure above.
    expect(shouldSetSecureCookie(req('http://127.0.0.1:7800/chat'))).toBe(false)
    expect(shouldSetSecureCookie(req('http://localhost/chat'))).toBe(false)
    // ...but a non-loopback URL with no Host header still fails closed.
    expect(shouldSetSecureCookie(req('http://neutron.example.com/chat'))).toBe(true)
  })

  test('THE ONE EXEMPTION: plain-http loopback dev keeps working', () => {
    // A `Secure` cookie is dropped by browsers over plain http, so requiring it
    // here would lock a self-hoster out of `bun start` on 127.0.0.1.
    for (const host of ['127.0.0.1:7800', 'localhost:7800', 'localhost', '[::1]:7800']) {
      expect(shouldSetSecureCookie(req('http://127.0.0.1:7800/chat', { host }))).toBe(false)
    }
  })

  test('https loopback is still Secure', () => {
    expect(shouldSetSecureCookie(req('https://localhost:7800/chat', { host: 'localhost:7800' }))).toBe(
      true,
    )
  })
})

describe('isLoopbackHost', () => {
  test('accepts the whole 127.0.0.0/8 block, not just 127.0.0.1', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true)
    expect(isLoopbackHost('127.1.2.3:8080')).toBe(true)
  })

  test('accepts localhost and IPv6 loopback', () => {
    expect(isLoopbackHost('localhost')).toBe(true)
    expect(isLoopbackHost('LOCALHOST:7800')).toBe(true)
    expect(isLoopbackHost('[::1]:7800')).toBe(true)
  })

  test('rejects lookalikes that are NOT the local machine', () => {
    // These are the ones an attacker would reach for.
    expect(isLoopbackHost('127.0.0.1.evil.com')).toBe(false)
    expect(isLoopbackHost('localhost.evil.com')).toBe(false)
    expect(isLoopbackHost('notlocalhost')).toBe(false)
    expect(isLoopbackHost('1270.0.0.1')).toBe(false)
    expect(isLoopbackHost('127.0.0.999')).toBe(false)
    expect(isLoopbackHost('')).toBe(false)
    expect(isLoopbackHost(null)).toBe(false)
  })
})
