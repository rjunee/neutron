/**
 * Unit tests for the chat-attachment upload + authed-fetch client. Pure: a fake
 * `fetchImpl` stands in for the network, so no DOM / server is needed.
 */

import { describe, expect, it } from 'bun:test'

import {
  AttachmentUploadError,
  ACCEPTED_ATTACHMENT_TYPES,
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

/** One recorded request against the chunked upload protocol. */
interface ChunkedCall {
  url: string
  method: string
  auth: string
  topic: string
  contentRange: string | null
  bodyLen: number
}

/**
 * A scripted `fetchImpl` that plays the gateway's CHUNKED upload protocol
 * (`…/start` → per-chunk `PATCH` → terminal completion) so the tests exercise
 * the real path {@link importHistoryZip} now drives. `/start` mints a fixed
 * `upload_id` + the caller-chosen `chunk_size_bytes`; each `PATCH` advances a
 * high-water mark and returns `{ bytes_received }` until the final chunk lands,
 * when it returns the `completion` body (job_id / outcome / source).
 */
function chunkedFake(opts?: {
  chunkSize?: number
  completion?: Record<string, unknown>
  /** Force a non-2xx on the FIRST request (start) — the error-mapping test. */
  failStartWith?: { status: number; body: unknown }
}): { fetchImpl: (url: string, init?: RequestInit) => Promise<Response>; calls: ChunkedCall[] } {
  const calls: ChunkedCall[] = []
  const uploadId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  let total = 0
  const chunkSize = opts?.chunkSize ?? 4 * 1024 * 1024
  const completion = opts?.completion ?? { job_id: 'job-1', outcome: 'advanced', source: 'chatgpt' }
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    const method = (init?.method ?? 'GET').toUpperCase()
    const h = (init?.headers ?? {}) as Record<string, string>
    const contentRange = h['Content-Range'] ?? h['content-range'] ?? null
    const bodyLen =
      init?.body instanceof Blob
        ? init.body.size
        : typeof init?.body === 'string'
          ? init.body.length
          : 0
    calls.push({
      url,
      method,
      auth: String(h['authorization'] ?? ''),
      topic: String(h[IMPORT_TOPIC_HEADER] ?? ''),
      contentRange,
      bodyLen,
    })
    if (url.endsWith('/start') && method === 'POST') {
      if (opts?.failStartWith !== undefined) {
        return new Response(JSON.stringify(opts.failStartWith.body), { status: opts.failStartWith.status })
      }
      const body = JSON.parse(String(init?.body)) as { total_bytes: number }
      total = body.total_bytes
      return new Response(
        JSON.stringify({ upload_id: uploadId, chunk_size_bytes: chunkSize, total_bytes: total }),
        { status: 200 },
      )
    }
    // PATCH a chunk. Parse the end offset from the Content-Range header.
    const m = String(contentRange).match(/bytes (\d+)-(\d+)\/(\d+)/)
    const end = m?.[2] !== undefined ? Number(m[2]) : 0
    const received = end + 1
    if (received >= total) {
      return new Response(JSON.stringify({ ok: true, status: 'complete', ...completion }), { status: 200 })
    }
    return new Response(JSON.stringify({ ok: true, bytes_received: received }), { status: 200 })
  }
  return { fetchImpl, calls }
}

describe('BUG 4 — history-import ZIP upload (chunked)', () => {
  it('isExportZip detects zips by MIME or .zip extension, not images', () => {
    expect(isExportZip(new File(['x'], 'export.zip', { type: 'application/zip' }))).toBe(true)
    expect(isExportZip(new File(['x'], 'EXPORT.ZIP', { type: '' }))).toBe(true)
    expect(isExportZip(new File(['x'], 'archive', { type: 'application/x-zip-compressed' }))).toBe(true)
    expect(isExportZip(new File(['x'], 'shot.png', { type: 'image/png' }))).toBe(false)
  })

  it('drives the chunked protocol: POST …/start then PATCH …/<id>, with the bearer + topic header on BOTH', async () => {
    const { fetchImpl, calls } = chunkedFake()
    await importHistoryZip(new File(['PK'], 'export.zip', { type: 'application/zip' }), 'chatgpt', {
      token: 'dev:sam',
      topicId: 'app:sam',
      fetchImpl,
    })
    // First call mints the session at …/start; a PATCH (not a single-shot POST)
    // carries the bytes with a Content-Range.
    const start = calls[0]
    const patch = calls.find((c) => c.method === 'PATCH')
    expect(start?.url).toBe('/api/upload/chatgpt/start')
    expect(start?.method).toBe('POST')
    expect(patch?.url).toBe('/api/upload/chatgpt/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
    expect(patch?.contentRange).toBe('bytes 0-1/2')
    // Bearer + topic header ride EVERY request so the finaliser's engine notify
    // routes the post-upload prompt back to this socket.
    for (const c of calls) {
      expect(c.auth).toBe('Bearer dev:sam')
      expect(c.topic).toBe('app:sam')
    }
    // No single-shot multipart POST to the bare source path — this is the
    // chunked path only.
    expect(calls.some((c) => c.url === '/api/upload/chatgpt')).toBe(false)
  })

  it('routes the claude source to /api/upload/claude/start', async () => {
    const { fetchImpl, calls } = chunkedFake()
    await importHistoryZip(new File(['PK'], 'c.zip', { type: 'application/zip' }), 'claude', {
      token: 't',
      fetchImpl,
    })
    expect(calls[0]?.url).toBe('/api/upload/claude/start')
  })

  it('reports UPLOAD progress that reflects chunk progress and ends at total', async () => {
    // chunk_size 1 forces the 2-byte export into TWO chunks so progress is
    // observably incremental rather than a single 0→100 jump.
    const { fetchImpl } = chunkedFake({ chunkSize: 1 })
    const loaded: number[] = []
    let seenTotal = 0
    await importHistoryZip(new File(['PK'], 'export.zip', { type: 'application/zip' }), 'chatgpt', {
      token: 't',
      fetchImpl,
      onProgress: (l, t) => {
        loaded.push(l)
        seenTotal = t
      },
    })
    expect(seenTotal).toBe(2)
    // Starts at 0, ends at the full size, monotonically non-decreasing.
    expect(loaded[0]).toBe(0)
    expect(loaded[loaded.length - 1]).toBe(2)
    expect(loaded).toEqual([...loaded].sort((a, b) => a - b))
    // More than one distinct tick — the bar actually moves through the upload.
    expect(new Set(loaded).size).toBeGreaterThan(1)
  })

  it('ND2 — returns the completion job_id so the caller can tell a real start from a no-op', async () => {
    const { fetchImpl } = chunkedFake({ completion: { job_id: 'job-42', outcome: 'advanced', source: 'claude' } })
    const started = await importHistoryZip(new File(['PK'], 'export.zip', { type: 'application/zip' }), 'claude', {
      token: 't',
      fetchImpl,
    })
    expect(started.job_id).toBe('job-42')
    expect(started.outcome).toBe('advanced')
    expect(started.source).toBe('claude')
  })

  it('ND2 — a completion no-op (job_id null / absent) resolves with job_id:null, NOT a false success', async () => {
    // The engine declined to route the upload (e.g. stray / no affordance): the
    // terminal PATCH is 200 with `job_id: null`. The caller MUST see this so it
    // surfaces an honest "couldn't start" notice instead of "reading your
    // history now" (the banned silent-false-success).
    const noop = chunkedFake({ completion: { job_id: null, outcome: 'no_active_prompt', source: 'chatgpt' } })
    const res = await importHistoryZip(new File(['PK'], 'export.zip', { type: 'application/zip' }), 'chatgpt', {
      token: 't',
      fetchImpl: noop.fetchImpl,
    })
    expect(res.job_id).toBeNull()
    expect(res.outcome).toBe('no_active_prompt')

    // A completion body with job_id ABSENT also degrades to job_id:null.
    const bare = chunkedFake({ completion: {} })
    const bareRes = await importHistoryZip(new File(['PK'], 'export.zip', { type: 'application/zip' }), 'chatgpt', {
      token: 't',
      fetchImpl: bare.fetchImpl,
    })
    expect(bareRes.job_id).toBeNull()
  })

  it('surfaces the server error as an AttachmentUploadError on a non-ok start', async () => {
    const { fetchImpl } = chunkedFake({
      failStartWith: { status: 413, body: { error: 'total_bytes 999 exceeds cap 5' } },
    })
    const err = await importHistoryZip(new File(['PK'], 'x.zip', { type: 'application/zip' }), 'chatgpt', {
      token: 't',
      fetchImpl,
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AttachmentUploadError)
    expect((err as AttachmentUploadError).status).toBe(413)
    expect((err as AttachmentUploadError).code).toBe('http_413')
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
    const svg = { name: 'x.svg', type: 'image/svg+xml', size: 10 } as unknown as File
    await expect(
      uploadAttachment(svg, { token: 't', fetchImpl: async () => okUpload() }),
    ).rejects.toMatchObject({ code: 'unsupported_type' })
  })

  it('accepts a PDF (M2 documents) through the client guard', async () => {
    let called = false
    const pdf = { name: 'x.pdf', type: 'application/pdf', size: 10 } as unknown as File
    const res = await uploadAttachment(pdf, {
      token: 't',
      fetchImpl: async () => {
        called = true
        return okUpload()
      },
    })
    expect(called).toBe(true)
    expect(res.url.length).toBeGreaterThan(0)
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
    expect(ACCEPTED_ATTACHMENT_TYPES).toContain('image/webp')
    expect(ACCEPTED_ATTACHMENT_TYPES).toContain('application/pdf')
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
