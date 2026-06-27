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

import { describe, expect, test, mock } from 'bun:test'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  createLandingServer,
  renderChatAuthGateHtml,
  type ChatBridge,
  type PendingChatClaim,
} from '../server.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const STATIC_DIR = dirname(HERE) // landing/ — contains chat-react.html + assets

function makeBridge(overrides: Partial<ChatBridge> = {}): ChatBridge {
  return {
    validateStartToken: mock(async ({ start_token }: { start_token: string }) =>
      start_token === 'good'
        ? ({
            project_slug: 'alice',
            user_id: 'u-1',
            jti: 'jti-1',
            expires_at_ms: Date.now() + 60_000,
          } satisfies PendingChatClaim)
        : null,
    ),
    startSession: mock(async () => true),
    handleInbound: mock(async () => {}),
    ...overrides,
  }
}

const FAKE_SERVER = { upgrade: () => true } as unknown as import('bun').Server<unknown>

async function getChat(handler: ReturnType<typeof createLandingServer>): Promise<Response> {
  return handler.fetch(new Request('http://x.test/chat'), FAKE_SERVER)
}

describe('GET /chat — Claude-auth gate (ISSUES #318)', () => {
  test('no substrate credential → 503 auth-gate page, NOT the chat shell', async () => {
    const handler = createLandingServer({
      static_dir: STATIC_DIR,
      bridge: makeBridge(),
      chatAuthGate: { isUnauthenticated: () => true },
    })
    const res = await getChat(handler)
    // Intentionally unavailable, not a 200 "here's chat" lie.
    expect(res.status).toBe(503)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(res.headers.get('cache-control')).toContain('no-store')
    const body = await res.text()
    // The gate copy mirrors the installer's setup-token guidance.
    expect(body).toContain('Authenticate Claude to continue')
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
      bridge: makeBridge(),
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
      bridge: makeBridge(),
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
      bridge: makeBridge(),
      chatAuthGate: { isUnauthenticated: () => !authed },
    })
    expect((await getChat(handler)).status).toBe(503)
    authed = true
    expect((await getChat(handler)).status).toBe(200)
  })
})

describe('renderChatAuthGateHtml — self-contained, CSP-safe page', () => {
  test('no inline <script> and no external asset dependency', () => {
    const html = renderChatAuthGateHtml()
    // The gate must not itself depend on the unauthenticated substrate or any
    // external asset; a single inline <style> is allowed, scripts are not.
    expect(html).not.toContain('<script')
    expect(html).not.toContain('src=')
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('noindex')
  })
})
