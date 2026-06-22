/**
 * Unit tests for the chat-attachment upload + authed-fetch client. Pure: a fake
 * `fetchImpl` stands in for the network, so no DOM / server is needed.
 */

import { describe, expect, it } from 'bun:test'

import {
  AttachmentUploadError,
  ACCEPTED_IMAGE_TYPES,
  MAX_ATTACHMENT_BYTES,
  fetchAttachmentObjectUrl,
  isAuthedAttachmentUrl,
  uploadAttachment,
} from '../uploads.ts'

const okUpload = () =>
  new Response(
    JSON.stringify({ ok: true, url: '/api/app/upload/sam/abc.png', content_type: 'image/png', size_bytes: 3 }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )

describe('uploadAttachment', () => {
  it('POSTs a multipart file with the bearer and returns the url', async () => {
    let seenUrl = ''
    let seenAuth = ''
    let bodyIsForm = false
    const res = await uploadAttachment(new File(['png'], 'shot.png', { type: 'image/png' }), {
      token: 'dev:sam',
      fetchImpl: async (url, init) => {
        seenUrl = url
        seenAuth = String((init?.headers as Record<string, string>)['authorization'])
        bodyIsForm = init?.body instanceof FormData
        return okUpload()
      },
    })
    expect(seenUrl).toBe('/api/app/upload')
    expect(seenAuth).toBe('Bearer dev:sam')
    expect(bodyIsForm).toBe(true)
    expect(res.url).toBe('/api/app/upload/sam/abc.png')
    expect(res.contentType).toBe('image/png')
  })

  it('pre-rejects an oversized file before any network call', async () => {
    let called = false
    const big = { name: 'big.png', type: 'image/png', size: MAX_ATTACHMENT_BYTES + 1 } as unknown as File
    await expect(
      uploadAttachment(big, {
        token: 't',
        fetchImpl: async () => {
          called = true
          return okUpload()
        },
      }),
    ).rejects.toMatchObject({ code: 'upload_too_large' })
    expect(called).toBe(false)
  })

  it('pre-rejects an unsupported declared type', async () => {
    const pdf = { name: 'x.pdf', type: 'application/pdf', size: 10 } as unknown as File
    await expect(
      uploadAttachment(pdf, { token: 't', fetchImpl: async () => okUpload() }),
    ).rejects.toMatchObject({ code: 'unsupported_type' })
  })

  it('surfaces the server error code + status on a non-ok response', async () => {
    const err = await uploadAttachment(new File(['x'], 'a.png', { type: 'image/png' }), {
      token: 't',
      fetchImpl: async () =>
        new Response(JSON.stringify({ ok: false, code: 'content_type_spoof', message: 'nope' }), {
          status: 400,
        }),
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AttachmentUploadError)
    expect((err as AttachmentUploadError).code).toBe('content_type_spoof')
    expect((err as AttachmentUploadError).status).toBe(400)
  })

  it('maps an AbortError to code aborted', async () => {
    await expect(
      uploadAttachment(new File(['x'], 'a.png', { type: 'image/png' }), {
        token: 't',
        fetchImpl: async () => {
          const e = new Error('aborted')
          e.name = 'AbortError'
          throw e
        },
      }),
    ).rejects.toMatchObject({ code: 'aborted' })
  })

  it('rejects a malformed (non-JSON) response body', async () => {
    await expect(
      uploadAttachment(new File(['x'], 'a.png', { type: 'image/png' }), {
        token: 't',
        fetchImpl: async () => new Response('<html>500</html>', { status: 200 }),
      }),
    ).rejects.toMatchObject({ code: 'malformed_response' })
  })

  it('exposes the server-mirrored constants', () => {
    expect(MAX_ATTACHMENT_BYTES).toBe(10 * 1024 * 1024)
    expect(ACCEPTED_IMAGE_TYPES).toContain('image/webp')
  })
})

describe('isAuthedAttachmentUrl', () => {
  const ORIGIN = 'https://sam.neutron.test'
  it('matches relative + SAME-ORIGIN attachment URLs only', () => {
    expect(isAuthedAttachmentUrl('/api/app/upload/sam/abc.png', ORIGIN)).toBe(true)
    expect(isAuthedAttachmentUrl(`${ORIGIN}/api/app/upload/sam/abc.png`, ORIGIN)).toBe(true)
    expect(isAuthedAttachmentUrl('data:image/png;base64,AAAA', ORIGIN)).toBe(false)
    expect(isAuthedAttachmentUrl('https://cdn.example.com/x.png', ORIGIN)).toBe(false)
    expect(isAuthedAttachmentUrl('blob:abc', ORIGIN)).toBe(false)
  })
  it('NEVER authed-fetches a cross-origin URL even when its path mimics ours (no bearer leak)', () => {
    // Crafted external attachment whose path starts with /api/app/upload/.
    expect(isAuthedAttachmentUrl('https://evil.example/api/app/upload/sam/abc.png', ORIGIN)).toBe(false)
    // Fail closed when the page origin is unknown.
    expect(isAuthedAttachmentUrl('https://sam.neutron.test/api/app/upload/sam/abc.png')).toBe(false)
  })
})

describe('fetchAttachmentObjectUrl', () => {
  it('GETs with the bearer and returns an object URL', async () => {
    let seenAuth = ''
    const url = await fetchAttachmentObjectUrl('/api/app/upload/sam/abc.png', {
      token: 'dev:sam',
      fetchImpl: async (_u, init) => {
        seenAuth = String((init?.headers as Record<string, string>)['authorization'])
        return new Response(new Blob([new Uint8Array([1, 2, 3])]), { status: 200 })
      },
      createObjectURL: () => 'blob:fake-123',
    })
    expect(seenAuth).toBe('Bearer dev:sam')
    expect(url).toBe('blob:fake-123')
  })

  it('throws with the http status on a non-ok GET', async () => {
    await expect(
      fetchAttachmentObjectUrl('/api/app/upload/sam/abc.png', {
        token: 't',
        fetchImpl: async () => new Response('forbidden', { status: 403 }),
        createObjectURL: () => 'blob:x',
      }),
    ).rejects.toMatchObject({ code: 'http_403', status: 403 })
  })
})
