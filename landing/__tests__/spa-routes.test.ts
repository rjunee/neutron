/**
 * landing/spa-routes — SPA client-route predicate (doc-link deep-link 404 fix).
 *
 * `isSpaClientRoute` gates which unknown browser navigations the gateway
 * delegates to the chat-react shell. It MUST match project-scoped deep links
 * (`GET /projects[/…]`, e.g. a shared `/projects/<id>/docs?path=…` doc URL) and
 * MUST NOT match any API / asset / operator / websocket path (those keep their
 * own real 404s) or any non-GET method.
 */

import { describe, expect, test } from 'bun:test'

import { isSpaClientRoute } from '../spa-routes.ts'

describe('isSpaClientRoute', () => {
  test('matches a project-scoped doc deep link (GET)', () => {
    expect(isSpaClientRoute('/projects/acme/docs', 'GET')).toBe(true)
  })

  test('matches the bare /projects path + nested project routes (GET)', () => {
    expect(isSpaClientRoute('/projects', 'GET')).toBe(true)
    expect(isSpaClientRoute('/projects/acme', 'GET')).toBe(true)
    expect(isSpaClientRoute('/projects/acme/docs/tree', 'GET')).toBe(true)
  })

  test('does NOT match non-GET methods (no SPA nav on POST/PATCH/etc.)', () => {
    expect(isSpaClientRoute('/projects/acme/docs', 'POST')).toBe(false)
    expect(isSpaClientRoute('/projects/acme/docs', 'HEAD')).toBe(false)
  })

  test('does NOT match API / asset / operator / websocket paths (real 404s preserved)', () => {
    for (const p of [
      '/api/app/projects/acme/docs/file',
      '/api/app/projects/acme/tabs',
      '/ws/app/chat',
      '/webhook/telegram',
      '/internal/cache-invalidate',
      '/admin/respawn-session',
      '/oauth/max/install-token/complete',
      '/.well-known/jwks.json',
      '/healthz',
      '/chat',
      '/chat-react.js',
      '/avatar.png',
      '/favicon.svg',
    ]) {
      expect(isSpaClientRoute(p, 'GET')).toBe(false)
    }
  })

  test('does NOT match a /projects lookalike prefix', () => {
    expect(isSpaClientRoute('/projectsx', 'GET')).toBe(false)
    expect(isSpaClientRoute('/xprojects/acme', 'GET')).toBe(false)
  })
})
