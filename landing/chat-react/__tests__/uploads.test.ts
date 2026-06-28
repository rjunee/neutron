/**
 * Unit tests for the chat-attachment upload + authed-fetch client. Pure: a fake
 * `fetchImpl` stands in for the network, so no DOM / server is needed.
 */

import { describe, expect, it } from 'bun:test'

import {
  AttachmentUploadError,
  ACCEPTED_IMAGE_TYPES,
  IMPORT_TOPIC_HEADER,
  MAX_ATTACHMENT_BYTES,
  fetchAttachmentObjectUrl,
  importHistoryZip,
  isAuthedAttachmentUrl,
  isExportZip,
  uploadAttachment,
} from '../uploads.ts'

const okUpload = () =>
  new Response(
    JSON.stringify({ ok: true, url: '/api/app/upload/sam/abc.png', content_type: 'image/png', size_bytes: 3 }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )

describe('BUG 4 — history-import ZIP upload', () => {
  it('isExportZip detects zips by MIME or .zip extension, not images', () => {
    expect(isExportZip(new File(['x'], 'export.zip', { type: 'application/zip' }))).toBe(true)
    expect(isExportZip(new File(['x'], 'EXPORT.ZIP', { type: '' }))).toBe(true)
    expect(isExportZip(new File(['x'], 'archive', { type: 'application/x-zip-compressed' }))).toBe(true)
    expect(isExportZip(new File(['x'], 'shot.png', { type: 'image/png' }))).toBe(false)
  })

  it('POSTs the zip multipart to /api/upload/<source> with the bearer + topic header', async () => {
    let seenUrl = ''
    let seenAuth = ''
    let seenTopic = ''
    let bodyIsForm = false
    await importHistoryZip(new File(['PK'], 'export.zip', { type: 'application/zip' }), 'chatgpt', {
      token: 'dev:sam',
      topicId: 'app:sam',
      fetchImpl: async (url, init) => {
        seenUrl = url
        const h = init?.headers as Record<string, string>
        seenAuth = String(h['authorization'])
        seenTopic = String(h[IMPORT_TOPIC_HEADER])
        bodyIsForm = init?.body instanceof FormData
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      },
    })
    expect(seenUrl).toBe('/api/upload/chatgpt')
    expect(seenAuth).toBe('Bearer dev:sam')
    expect(seenTopic).toBe('app:sam')
    expect(bodyIsForm).toBe(true)
  })

  it('routes the claude source to /api/upload/claude', async () => {
    let seenUrl = ''
    await importHistoryZip(new File(['PK'], 'c.zip', { type: 'application/zip' }), 'claude', {
      token: 't',
      fetchImpl: async (url) => {
        seenUrl = url
        return new Response('{}', { status: 200 })
      },
    })
    expect(seenUrl).toBe('/api/upload/claude')
  })

  it('ND2 — returns the server job_id so the caller can tell a real start from a no-op', async () => {
    const started = await importHistoryZip(new File(['PK'], 'export.zip', { type: 'application/zip' }), 'claude', {
      token: 't',
      fetchImpl: async () =>
        new Response(JSON.stringify({ ok: true, source: 'claude', outcome: 'advanced', job_id: 'job-42' }), {
          status: 200,
        }),
    })
    expect(started.job_id).toBe('job-42')
    expect(started.outcome).toBe('advanced')
  })

  it('ND2 — a 200 no-op (job_id null / absent) resolves with job_id:null, NOT a false success', async () => {
    // The engine declined to route the upload (e.g. stray / no affordance):
    // HTTP 200 with `job_id: null`. The caller MUST be able to see this so it
    // surfaces an honest "couldn't start" notice instead of "reading your
    // history now" (the banned silent-false-success).
    const noop = await importHistoryZip(new File(['PK'], 'export.zip', { type: 'application/zip' }), 'chatgpt', {
      token: 't',
      fetchImpl: async () =>
        new Response(JSON.stringify({ ok: true, source: 'chatgpt', outcome: 'no_active_prompt', job_id: null }), {
          status: 200,
        }),
    })
    expect(noop.job_id).toBeNull()
    expect(noop.outcome).toBe('no_active_prompt')

    // An empty / job_id-absent body also degrades to job_id:null (no false success).
    const bare = await importHistoryZip(new File(['PK'], 'export.zip', { type: 'application/zip' }), 'chatgpt', {
      token: 't',
      fetchImpl: async () => new Response('{}', { status: 200 }),
    })
    expect(bare.job_id).toBeNull()
  })

  it('surfaces the server error message on a non-ok response', async () => {
    const err = await importHistoryZip(new File(['PK'], 'x.zip', { type: 'application/zip' }), 'chatgpt', {
      token: 't',
      fetchImpl: async () =>
        new Response(JSON.stringify({ message: 'not a zip file (magic bytes mismatch)' }), { status: 400 }),
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AttachmentUploadError)
    expect((err as AttachmentUploadError).message).toContain('magic bytes')
    expect((err as AttachmentUploadError).status).toBe(400)
  })
})

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
