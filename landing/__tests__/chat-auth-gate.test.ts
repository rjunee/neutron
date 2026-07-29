/**
 * ISSUES #318 — app-level Claude-auth gate (defense in depth for the installer
 * gate). When the Open box boots with NO working Claude substrate credential
 * (`CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` both unset), `GET /chat`
 * must render a clear "Authenticate Claude to continue" page INSTEAD of the
 * interactive-looking chat shell that silently produces nothing.
 *
 * The gate is opt-in via `LandingServerOptions.chatAuthGate`: the Open composer
 * wires `isUnauthenticated: () => resolveOpenLlmPool(env) === null`; Managed
 * leaves it unset so the shell serves as before (its substrate is resolved
 * elsewhere, not from this process's env).
 */

import { describe, expect, test } from 'bun:test'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  createLandingServer,
  renderChatAuthGateHtml,
  chatAuthGateCsp,
} from '../server.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const STATIC_DIR = dirname(HERE) // landing/ — contains chat-react.html + assets

const FAKE_SERVER = { upgrade: () => true } as unknown as import('bun').Server<unknown>

async function getChat(handler: ReturnType<typeof createLandingServer>): Promise<Response> {
  return handler.fetch(new Request('http://x.test/chat'), FAKE_SERVER)
}

describe('GET /chat — Claude-auth gate (ISSUES #318)', () => {
  test('no substrate credential → 503 auth-gate page, NOT the chat shell', async () => {
    const handler = createLandingServer({
      static_dir: STATIC_DIR,
      chatAuthGate: { isUnauthenticated: () => true },
    })
    const res = await getChat(handler)
    // Intentionally unavailable, not a 200 "here's chat" lie.
    expect(res.status).toBe(503)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(res.headers.get('cache-control')).toContain('no-store')
    // The functional handoff carries a hashed-script CSP (no 'unsafe-inline').
    const csp = res.headers.get('content-security-policy') ?? ''
    expect(csp).toContain('script-src')
    expect(csp).toContain('sha256-')
    const body = await res.text()
    // The functional handoff drives the install-token routes…
    expect(body).toContain('Authenticate Claude to continue')
    expect(body).toContain('/oauth/max/install-token')
    // …and keeps the manual setup-token guidance as the secondary/fallback path.
    expect(body).toContain('claude setup-token')
    expect(body).toContain('CLAUDE_CODE_OAUTH_TOKEN')
    expect(body).toContain('ANTHROPIC_API_KEY')
    // Crucially: the interactive chat shell is NOT served.
    expect(body).not.toContain('/chat-react.js')
    expect(body).not.toContain('id="log"')
  })

  test('substrate credential present → 200 chat shell (gate inert)', async () => {
    const handler = createLandingServer({
      static_dir: STATIC_DIR,
      chatAuthGate: { isUnauthenticated: () => false },
    })
    const res = await getChat(handler)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    const body = await res.text()
    // The real chat shell, not the gate.
    expect(body).toContain('/chat-react.js')
    expect(body).not.toContain('Authenticate Claude to continue')
  })

  test('chatAuthGate unset (Managed) → 200 chat shell, gate never consulted', async () => {
    const handler = createLandingServer({
      static_dir: STATIC_DIR,
    })
    const res = await getChat(handler)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('/chat-react.js')
    expect(body).not.toContain('Authenticate Claude to continue')
  })

  test('isUnauthenticated is evaluated PER REQUEST (restart-with-token clears the gate)', async () => {
    // A live credential flips from absent → present (e.g. operator added the
    // token and the process re-read env). The same server must stop gating
    // WITHOUT a rebuild — the predicate is a closure read on each GET.
    let authed = false
    const handler = createLandingServer({
      static_dir: STATIC_DIR,
      chatAuthGate: { isUnauthenticated: () => !authed },
    })
    expect((await getChat(handler)).status).toBe(503)
    authed = true
    expect((await getChat(handler)).status).toBe(200)
  })
})

describe('renderChatAuthGateHtml — functional handoff, CSP-safe', () => {
  test('one inline <script>, no external asset dependency, hash matches CSP', () => {
    const html = renderChatAuthGateHtml()
    // The handoff needs ONE inline script to drive the install-token routes,
    // but must not pull any EXTERNAL asset (no <script src> / <link>/<img src>)
    // so it never depends on the unauthenticated substrate.
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('noindex')
    expect(html).toContain('<script>')
    expect(html).not.toContain('src=')
    expect((html.match(/<script/g) ?? []).length).toBe(1)
    // The CSP's sha256 must match the actual inline script bytes, or browsers
    // would refuse to run it.
    const scriptBody = html.slice(html.indexOf('<script>') + '<script>'.length, html.lastIndexOf('</script>'))
    const { createHash } = require('node:crypto') as typeof import('node:crypto')
    const hash = createHash('sha256').update(scriptBody, 'utf8').digest('base64')
    expect(chatAuthGateCsp()).toContain(`sha256-${hash}`)
  })
})
