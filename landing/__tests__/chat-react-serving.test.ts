/**
 * landing/server — Track B Phase 3 flag-gated serving of the React chat client.
 *
 * Verifies the vanilla client stays the default and the React shell + bundle are
 * served only when the flag (env default or `?client=` query) selects them.
 */

import { describe, expect, test, mock } from 'bun:test'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createLandingServer, type ChatBridge } from '../server.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const STATIC_DIR = dirname(HERE) // the landing/ package dir (has chat-react.html + chat-react/)

function makeBridge(): ChatBridge {
  return {
    validateStartToken: mock(async () => null),
    startSession: mock(async () => true),
    handleInbound: mock(async () => {}),
  }
}

const fakeServer = { upgrade: () => true } as unknown as import('bun').Server<unknown>

function get(url: string, opts: { webChatClientDefault?: string } = {}) {
  const handler = createLandingServer({ static_dir: STATIC_DIR, bridge: makeBridge(), ...opts })
  return handler.fetch(new Request(url), fakeServer)
}

describe('GET /chat — web chat client flag', () => {
  test('serves the vanilla client by default (no flag)', async () => {
    const res = await get('http://x.test/chat')
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('id="log"') // vanilla chat.html marker
    expect(body).not.toContain('/chat-react.js')
  })

  test('serves the React shell when the env default is react', async () => {
    const res = await get('http://x.test/chat', { webChatClientDefault: 'react' })
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('id="root"')
    expect(body).toContain('/chat-react.js')
    expect(body).not.toContain('id="log"')
  })

  test('?client=react overrides a vanilla default', async () => {
    const res = await get('http://x.test/chat?client=react', { webChatClientDefault: 'vanilla' })
    const body = await res.text()
    expect(body).toContain('/chat-react.js')
  })

  test('?client=vanilla overrides a react default', async () => {
    const res = await get('http://x.test/chat?client=vanilla', { webChatClientDefault: 'react' })
    const body = await res.text()
    expect(body).toContain('id="log"')
    expect(body).not.toContain('/chat-react.js')
  })
})

describe('GET /chat-react.js', () => {
  test('bundles the React/assistant-ui client on first request', async () => {
    const res = await get('http://x.test/chat-react.js')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('javascript')
    const body = await res.text()
    // The bundle carries React + assistant-ui + chat-core — large + non-empty.
    expect(body.length).toBeGreaterThan(100_000)
  }, 30_000)
})
