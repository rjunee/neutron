/**
 * landing/server — React chat client serving.
 *
 * The vanilla web chat client has been removed; React is now the only
 * chat client. `GET /chat` ALWAYS serves the React shell (no flag, no
 * `?client=` branch, no env default) and `GET /chat-react.js` serves the
 * bundle.
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

function get(url: string) {
  const handler = createLandingServer({ static_dir: STATIC_DIR, bridge: makeBridge() })
  return handler.fetch(new Request(url), fakeServer)
}

describe('GET /chat — React is the only chat client', () => {
  test('serves the React shell unconditionally', async () => {
    const res = await get('http://x.test/chat')
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('id="root"')
    expect(body).toContain('/chat-react.js')
    // No vanilla client remains.
    expect(body).not.toContain('id="log"')
  })

  test('ignores any legacy ?client= query and still serves React', async () => {
    const res = await get('http://x.test/chat?client=vanilla')
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('id="root"')
    expect(body).toContain('/chat-react.js')
    expect(body).not.toContain('id="log"')
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
