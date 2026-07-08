/**
 * @neutronai/gateway/__tests__ — chat-attachment upload surface (P5.1).
 *
 * Closes Argus r1 BLOCKING #1 — the client (`app/lib/upload-client.ts`)
 * has always POSTed to `${base_url}/api/app/upload` but no production
 * route existed; every image attach 404'd in real deployments while
 * the client-side test suite happily passed via `fetch_impl` stubs.
 *
 * These tests pin the real route end-to-end against the existing
 * `composeHttpHandler` so any future regression that unmounts the
 * upload surface OR drops it out of the compose chain lights up here
 * BEFORE the client lands on a busted production deploy.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAppWsAuthResolver } from '@neutronai/channels/index.ts'
import { composeHttpHandler } from '../http/compose.ts'
import { createAppUploadSurface } from '../http/app-upload-surface.ts'

interface Harness {
  server: import('bun').Server<unknown>
  base: string
  owner_home: string
  close(): Promise<void>
}

/**
 * Real 1x1 PNG (89-50-4E-47 + IHDR + IDAT + IEND). Hex-encoded so the
 * source diff stays grepable; the bytes round-trip through
 * `magicByteSniff` → 'image/png' under the surface's image whitelist.
 */
const TINY_PNG_HEX =
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
  '0000000d49444154789c63000100000005000100' +
  '0d0a2db40000000049454e44ae426082'

const TINY_JPEG_HEX = 'ffd8ffe000104a46494600010100000100010000ffd9'

/** Decode a hex string into a Uint8Array. */
function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('hex length must be even')
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

async function startGateway(): Promise<Harness> {
  const owner_home = mkdtempSync(join(tmpdir(), 'neutron-upload-'))
  const auth = createAppWsAuthResolver({ project_slug: 'demo', bypass: true })
  const upload = createAppUploadSurface({ auth, project_slug: 'demo', owner_home })
  const composed = composeHttpHandler({
    appUpload: { handler: upload.handler },
    defaultHandler: () => new Response('not found', { status: 404 }),
  })
  const server = Bun.serve({
    port: 0,
    fetch: (req, srv) => composed.fetch(req, srv),
    websocket: composed.websocket,
  })
  return {
    server,
    base: `http://127.0.0.1:${server.port}`,
    owner_home,
    close: async () => {
      await server.stop(true)
      try {
        rmSync(owner_home, { recursive: true, force: true })
      } catch {
        /* ignore — test cleanup */
      }
    },
  }
}

function makeMultipart(bytes: Uint8Array, name: string, type: string): FormData {
  const form = new FormData()
  // The DOM `Blob` ctor's `BlobPart` typing under @types/bun isn't
  // happy with a generic Uint8Array (`SharedArrayBuffer` slots in via
  // ArrayBufferLike). Round-trip via the underlying ArrayBuffer slice
  // to land on a plain `ArrayBuffer`.
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer
  form.append('file', new Blob([buf], { type }), name)
  return form
}

describe('app-upload gateway surface — POST /api/app/upload', () => {
  let harness: Harness

  beforeEach(async () => {
    harness = await startGateway()
  })
  afterEach(async () => {
    await harness.close()
  })

  it('uploads a PNG and returns the canonical URL', async () => {
    const bytes = fromHex(TINY_PNG_HEX)
    const form = makeMultipart(bytes, 'pic.png', 'image/png')
    const res = await fetch(`${harness.base}/api/app/upload`, {
      method: 'POST',
      headers: { authorization: 'Bearer dev:sam' },
      body: form,
    })
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      ok: boolean
      url: string
      content_type: string
      size_bytes: number
    }
    expect(json.ok).toBe(true)
    expect(json.content_type).toBe('image/png')
    expect(json.size_bytes).toBe(bytes.length)
    expect(json.url.startsWith('/api/app/upload/sam/')).toBe(true)
    expect(json.url.endsWith('.png')).toBe(true)
  })

  it('rejects requests without a Bearer token (401)', async () => {
    const form = makeMultipart(fromHex(TINY_PNG_HEX), 'pic.png', 'image/png')
    const res = await fetch(`${harness.base}/api/app/upload`, {
      method: 'POST',
      body: form,
    })
    expect(res.status).toBe(401)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('missing_bearer')
  })

  it('rejects non-image MIMEs via magic-byte sniffing (415)', async () => {
    // Random non-image bytes the sniffer will return null for.
    const random = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    const form = makeMultipart(random, 'pic.png', 'image/png')
    const res = await fetch(`${harness.base}/api/app/upload`, {
      method: 'POST',
      headers: { authorization: 'Bearer dev:sam' },
      body: form,
    })
    expect(res.status).toBe(415)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('unsupported_type')
  })

  it('rejects content-type spoofing (PNG bytes declared as JPEG) with 400', async () => {
    const png = fromHex(TINY_PNG_HEX)
    const form = makeMultipart(png, 'pic.jpg', 'image/jpeg')
    const res = await fetch(`${harness.base}/api/app/upload`, {
      method: 'POST',
      headers: { authorization: 'Bearer dev:sam' },
      body: form,
    })
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('content_type_spoof')
  })

  it('round-trips JPEG bytes through the surface', async () => {
    const bytes = fromHex(TINY_JPEG_HEX)
    const form = makeMultipart(bytes, 'pic.jpg', 'image/jpeg')
    const res = await fetch(`${harness.base}/api/app/upload`, {
      method: 'POST',
      headers: { authorization: 'Bearer dev:sam' },
      body: form,
    })
    expect(res.status).toBe(200)
    const json = (await res.json()) as { url: string; content_type: string }
    expect(json.content_type).toBe('image/jpeg')
    expect(json.url.endsWith('.jpg')).toBe(true)
  })

  it('returns a 413 when the body exceeds the wire cap', async () => {
    // Build a 1MB cap and shove 2MB through — exercises the
    // Content-Length pre-check.
    await harness.close()
    const owner_home = mkdtempSync(join(tmpdir(), 'neutron-upload-'))
    const auth = createAppWsAuthResolver({ project_slug: 'demo', bypass: true })
    const upload = createAppUploadSurface({
      auth,
      project_slug: 'demo',
      owner_home,
      max_bytes: 1024,
    })
    const composed = composeHttpHandler({
      appUpload: { handler: upload.handler },
      defaultHandler: () => new Response('not found', { status: 404 }),
    })
    const server = Bun.serve({
      port: 0,
      fetch: (req, srv) => composed.fetch(req, srv),
      websocket: composed.websocket,
    })
    harness = {
      server,
      base: `http://127.0.0.1:${server.port}`,
      owner_home,
      close: async () => {
        await server.stop(true)
        try {
          rmSync(owner_home, { recursive: true, force: true })
        } catch {
          /* ignore */
        }
      },
    }
    const big = new Uint8Array(64 * 1024)
    big.set(fromHex(TINY_PNG_HEX), 0)
    const form = makeMultipart(big, 'pic.png', 'image/png')
    const res = await fetch(`${harness.base}/api/app/upload`, {
      method: 'POST',
      headers: { authorization: 'Bearer dev:sam' },
      body: form,
    })
    expect(res.status).toBe(413)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('upload_too_large')
  })

  it('rejects non-POST methods with 405', async () => {
    const res = await fetch(`${harness.base}/api/app/upload`, { method: 'GET' })
    expect(res.status).toBe(405)
  })

  it('falls through to default handler on unrelated paths', async () => {
    const res = await fetch(`${harness.base}/api/something-else`)
    expect(res.status).toBe(404)
  })

  it('streams uploaded bytes back on the auth-gated GET', async () => {
    const bytes = fromHex(TINY_PNG_HEX)
    const form = makeMultipart(bytes, 'pic.png', 'image/png')
    const up = await fetch(`${harness.base}/api/app/upload`, {
      method: 'POST',
      headers: { authorization: 'Bearer dev:sam' },
      body: form,
    })
    expect(up.status).toBe(200)
    const { url } = (await up.json()) as { url: string }
    // Read back with the matching Bearer.
    const get = await fetch(`${harness.base}${url}`, {
      headers: { authorization: 'Bearer dev:sam' },
    })
    expect(get.status).toBe(200)
    expect(get.headers.get('content-type')).toBe('image/png')
    const round_tripped = new Uint8Array(await get.arrayBuffer())
    expect(round_tripped.length).toBe(bytes.length)
    for (let i = 0; i < bytes.length; i++) {
      expect(round_tripped[i]).toBe(bytes[i])
    }
  })

  it('rejects cross-user GET with 403 (token leak doesn\'t enable enumeration)', async () => {
    const bytes = fromHex(TINY_PNG_HEX)
    const form = makeMultipart(bytes, 'pic.png', 'image/png')
    const up = await fetch(`${harness.base}/api/app/upload`, {
      method: 'POST',
      headers: { authorization: 'Bearer dev:sam' },
      body: form,
    })
    const { url } = (await up.json()) as { url: string }
    // Use a different user token to GET — must be 403.
    const get = await fetch(`${harness.base}${url}`, {
      headers: { authorization: 'Bearer dev:other' },
    })
    expect(get.status).toBe(403)
    const json = (await get.json()) as { code: string }
    expect(json.code).toBe('user_mismatch')
  })

  it('returns 304 on a matching ETag (content-addressed cache)', async () => {
    const bytes = fromHex(TINY_PNG_HEX)
    const form = makeMultipart(bytes, 'pic.png', 'image/png')
    const up = await fetch(`${harness.base}/api/app/upload`, {
      method: 'POST',
      headers: { authorization: 'Bearer dev:sam' },
      body: form,
    })
    const { url } = (await up.json()) as { url: string }
    // url shape: /api/app/upload/sam/<hash>.png
    const hash = url.split('/').pop()?.replace(/\.png$/, '') ?? ''
    expect(hash.length).toBe(64)
    const get = await fetch(`${harness.base}${url}`, {
      headers: { authorization: 'Bearer dev:sam', 'if-none-match': `"${hash}"` },
    })
    expect(get.status).toBe(304)
  })

  it('is idempotent — same bytes return the same URL', async () => {
    const bytes = fromHex(TINY_PNG_HEX)
    const u1 = await fetch(`${harness.base}/api/app/upload`, {
      method: 'POST',
      headers: { authorization: 'Bearer dev:sam' },
      body: makeMultipart(bytes, 'pic.png', 'image/png'),
    })
    const u2 = await fetch(`${harness.base}/api/app/upload`, {
      method: 'POST',
      headers: { authorization: 'Bearer dev:sam' },
      body: makeMultipart(bytes, 'pic.png', 'image/png'),
    })
    expect(u1.status).toBe(200)
    expect(u2.status).toBe(200)
    const j1 = (await u1.json()) as { url: string }
    const j2 = (await u2.json()) as { url: string }
    expect(j1.url).toBe(j2.url)
  })
})
