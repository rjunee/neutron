/**
 * Upload Resume Phase 2 — chunked-upload client unit tests.
 *
 * The client (`landing/upload-client.ts`) drives the gateway's three
 * routes via `fetch`. Tests mock `fetch` + `sleep` so we exercise:
 *
 *   1. End-to-end chunked upload — 4 chunks, ordered, with the right
 *      Content-Range; per-chunk onProgress fires; final completion.
 *   2. Network error on chunk 2 — exponential backoff retries.
 *   3. Page reload mid-upload — caller passes `resumeUploadId` → HEAD
 *      returns Upload-Offset → PATCH resumes from that offset.
 */

import { describe, expect, test } from 'bun:test'

import {
  uploadChunked,
  UploadChunkedError,
  type UploadChunkedOptions,
} from '../upload-client.ts'

/** Construct a `File` (happy-dom + bun both provide the global).
 *
 *  Materialise a dedicated ArrayBuffer to dodge the SharedArrayBuffer
 *  variance issue TS 5.4+ surfaces on `Uint8Array.buffer` (lib.dom
 *  typings require `ArrayBuffer`, not `ArrayBufferLike`). Mirrors the
 *  pattern in `gateway/upload/__tests__/import-upload-handler.test.ts`.
 */
function fileOf(bytes: Uint8Array, name = 'export.zip', type = 'application/zip'): File {
  const ab = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(ab).set(bytes)
  return new File([ab], name, { type })
}

interface RecordedRequest {
  url: string
  method: string
  headers: Record<string, string>
  body: ArrayBuffer | null
  contentRange: string | null
}

interface FetchScript {
  /** Sequenced responses. Each call shifts the head. Tests assert
   *  every script entry is consumed (no leftover responses). */
  responses: Array<
    | { kind: 'response'; status: number; headers?: Record<string, string>; json?: unknown; body?: ArrayBuffer | null }
    | { kind: 'throw'; error: Error }
  >
  recorded: RecordedRequest[]
  fetch: typeof fetch
}

function scriptedFetch(
  responses: FetchScript['responses'],
): FetchScript {
  const recorded: RecordedRequest[] = []
  const queue = [...responses]
  const fetchImpl: typeof fetch = (async (input, init) => {
    const url = typeof input === 'string' ? input : (input as Request).url
    const method = (init?.method ?? 'GET').toUpperCase()
    const headersRecord: Record<string, string> = {}
    const ih = init?.headers
    if (ih !== undefined) {
      if (ih instanceof Headers) {
        ih.forEach((value, name) => {
          headersRecord[name.toLowerCase()] = value
        })
      } else if (Array.isArray(ih)) {
        for (const [name, value] of ih) {
          headersRecord[String(name).toLowerCase()] = String(value)
        }
      } else {
        for (const [name, value] of Object.entries(ih)) {
          headersRecord[name.toLowerCase()] = String(value)
        }
      }
    }
    let body: ArrayBuffer | null = null
    if (init?.body !== undefined && init.body !== null) {
      if (init.body instanceof ArrayBuffer) body = init.body
      else if (init.body instanceof Blob) body = await init.body.arrayBuffer()
      else if (typeof init.body === 'string') {
        body = new TextEncoder().encode(init.body).buffer as ArrayBuffer
      }
    }
    recorded.push({
      url,
      method,
      headers: headersRecord,
      body,
      contentRange: headersRecord['content-range'] ?? null,
    })
    const next = queue.shift()
    if (next === undefined) {
      throw new Error(`scriptedFetch: no response queued for ${method} ${url}`)
    }
    if (next.kind === 'throw') throw next.error
    const responseInit: ResponseInit = {
      status: next.status,
      headers: next.headers ?? {},
    }
    if (next.json !== undefined) {
      return new Response(JSON.stringify(next.json), {
        ...responseInit,
        headers: { ...(next.headers ?? {}), 'Content-Type': 'application/json' },
      })
    }
    if (next.body !== undefined && next.body !== null) {
      return new Response(next.body, responseInit)
    }
    return new Response(null, responseInit)
  }) as typeof fetch
  return { responses, recorded, fetch: fetchImpl }
}

const SLEEP_NO_OP = async (_ms: number): Promise<void> => {
  // Tests advance "wall-clock time" by simply not waiting; the retry
  // loop's mechanics are independent of the actual sleep duration.
}

describe('uploadChunked — happy path', () => {
  test('4-chunk upload — chunks sent in order, onProgress per chunk', async () => {
    const bytes = new Uint8Array(16) // 16 bytes total
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = i
    const file = fileOf(bytes)
    const chunkSize = 4 // 4 chunks of 4 bytes
    const script = scriptedFetch([
      // POST /start
      {
        kind: 'response',
        status: 200,
        json: { upload_id: 'upload-x', chunk_size_bytes: chunkSize, total_bytes: 16 },
      },
      // PATCH chunk 1 (bytes 0-3/16)
      { kind: 'response', status: 200, json: { ok: true, bytes_received: 4 } },
      // PATCH chunk 2 (bytes 4-7/16)
      { kind: 'response', status: 200, json: { ok: true, bytes_received: 8 } },
      // PATCH chunk 3 (bytes 8-11/16)
      { kind: 'response', status: 200, json: { ok: true, bytes_received: 12 } },
      // PATCH chunk 4 (bytes 12-15/16) — final
      {
        kind: 'response',
        status: 200,
        json: { ok: true, status: 'complete', bytes_received: 16, source: 'chatgpt' },
      },
    ])
    const progress: Array<[number, number]> = []
    const opts: UploadChunkedOptions = {
      url: '/api/upload/chatgpt',
      file,
      fetchImpl: script.fetch,
      sleep: SLEEP_NO_OP,
      onProgress: (loaded, total) => progress.push([loaded, total]),
    }
    const result = await uploadChunked(opts)
    expect(result.upload_id).toBe('upload-x')
    expect(result.status).toBe('complete')
    expect(result.bytes).toBe(16)

    // Recorded fetches: 1 POST /start + 4 PATCH /upload-x.
    expect(script.recorded.length).toBe(5)
    expect(script.recorded[0]?.method).toBe('POST')
    expect(script.recorded[0]?.url.endsWith('/start')).toBe(true)
    const ranges = script.recorded.slice(1).map((r) => r.contentRange)
    expect(ranges).toEqual([
      'bytes 0-3/16',
      'bytes 4-7/16',
      'bytes 8-11/16',
      'bytes 12-15/16',
    ])
    // onProgress: initial 0, then after each chunk (4, 8, 12, 16),
    // then a final settle (16, 16).
    expect(progress.length).toBeGreaterThanOrEqual(5)
    expect(progress[0]).toEqual([0, 16])
    const finalProg = progress[progress.length - 1] as [number, number]
    expect(finalProg).toEqual([16, 16])
  })

  test('forwards headers + credentials on every request', async () => {
    const bytes = new Uint8Array(4)
    const file = fileOf(bytes)
    const script = scriptedFetch([
      {
        kind: 'response',
        status: 200,
        json: { upload_id: 'u-1', chunk_size_bytes: 4 },
      },
      {
        kind: 'response',
        status: 200,
        json: { ok: true, status: 'complete', bytes_received: 4 },
      },
    ])
    await uploadChunked({
      url: '/api/upload/chatgpt',
      file,
      fetchImpl: script.fetch,
      sleep: SLEEP_NO_OP,
      headers: { 'X-Neutron-Topic-Id': 'web:user-7' },
    })
    for (const r of script.recorded) {
      expect(r.headers['x-neutron-topic-id']).toBe('web:user-7')
    }
  })
})

describe('uploadChunked — retry on transient failures', () => {
  test('network error on chunk 2 → exponential backoff → eventually succeeds', async () => {
    const bytes = new Uint8Array(8) // 2 chunks of 4 bytes
    const file = fileOf(bytes)
    const sleepCalls: number[] = []
    const sleep = async (ms: number): Promise<void> => {
      sleepCalls.push(ms)
    }
    const script = scriptedFetch([
      // /start
      {
        kind: 'response',
        status: 200,
        json: { upload_id: 'u-2', chunk_size_bytes: 4 },
      },
      // PATCH chunk 1 succeeds
      { kind: 'response', status: 200, json: { ok: true, bytes_received: 4 } },
      // PATCH chunk 2 — three transient failures then success.
      { kind: 'throw', error: new TypeError('network drop') },
      { kind: 'response', status: 500, body: null },
      { kind: 'throw', error: new TypeError('connection reset') },
      {
        kind: 'response',
        status: 200,
        json: { ok: true, status: 'complete', bytes_received: 8 },
      },
    ])
    const result = await uploadChunked({
      url: '/api/upload/chatgpt',
      file,
      fetchImpl: script.fetch,
      sleep,
      retryOpts: { maxAttempts: 5, initialDelayMs: 1000, maxDelayMs: 30000 },
    })
    expect(result.status).toBe('complete')
    // Three transient failures → three sleeps of 1s, 2s, 4s (backoff).
    expect(sleepCalls).toEqual([1000, 2000, 4000])
  })

  test('exhausting retries surfaces UploadChunkedError with the last status', async () => {
    const bytes = new Uint8Array(4)
    const file = fileOf(bytes)
    const script = scriptedFetch([
      // /start
      { kind: 'response', status: 200, json: { upload_id: 'u-3', chunk_size_bytes: 4 } },
      // PATCH 1 fails twice with 503.
      { kind: 'response', status: 503, body: null },
      { kind: 'response', status: 503, body: null },
    ])
    let thrown: unknown = null
    try {
      await uploadChunked({
        url: '/api/upload/chatgpt',
        file,
        fetchImpl: script.fetch,
        sleep: SLEEP_NO_OP,
        retryOpts: { maxAttempts: 2, initialDelayMs: 10, maxDelayMs: 10 },
      })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(UploadChunkedError)
    if (thrown instanceof UploadChunkedError) {
      expect(thrown.opts.status).toBe(503)
      expect(thrown.opts.phase).toBe('patch')
    }
  })
})

describe('uploadChunked — resume from existing upload_id', () => {
  test('HEAD returns Upload-Offset=8 → PATCH resumes from byte 8', async () => {
    const bytes = new Uint8Array(16) // 16 bytes total, 4-byte chunks
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = 0xa0 + i
    const file = fileOf(bytes)
    const script = scriptedFetch([
      // HEAD on the existing upload_id — already has 8/16 bytes.
      {
        kind: 'response',
        status: 200,
        headers: { 'Upload-Offset': '8', 'Upload-Length': '16' },
      },
      // PATCH 3rd chunk (bytes 8-11/16)
      { kind: 'response', status: 200, json: { ok: true, bytes_received: 12 } },
      // PATCH 4th chunk (bytes 12-15/16) — final
      {
        kind: 'response',
        status: 200,
        json: { ok: true, status: 'complete', bytes_received: 16 },
      },
    ])
    const result = await uploadChunked({
      url: '/api/upload/chatgpt',
      file,
      fetchImpl: script.fetch,
      sleep: SLEEP_NO_OP,
      resumeUploadId: 'u-resume',
      chunkSizeBytes: 4,
    })
    expect(result.upload_id).toBe('u-resume')
    expect(result.status).toBe('complete')

    // 1 HEAD + 2 PATCHes (no /start).
    expect(script.recorded.length).toBe(3)
    expect(script.recorded[0]?.method).toBe('HEAD')
    expect(script.recorded[1]?.method).toBe('PATCH')
    expect(script.recorded[1]?.contentRange).toBe('bytes 8-11/16')
    expect(script.recorded[2]?.contentRange).toBe('bytes 12-15/16')
  })

  test('HEAD 404 → falls back to fresh /start', async () => {
    const bytes = new Uint8Array(4)
    const file = fileOf(bytes)
    const script = scriptedFetch([
      // HEAD on stale upload_id — 404
      { kind: 'response', status: 404 },
      // Fallback /start
      { kind: 'response', status: 200, json: { upload_id: 'u-fresh', chunk_size_bytes: 4 } },
      // Single chunk completes
      {
        kind: 'response',
        status: 200,
        json: { ok: true, status: 'complete', bytes_received: 4 },
      },
    ])
    const result = await uploadChunked({
      url: '/api/upload/chatgpt',
      file,
      fetchImpl: script.fetch,
      sleep: SLEEP_NO_OP,
      resumeUploadId: 'stale-id',
    })
    expect(result.upload_id).toBe('u-fresh')
    expect(script.recorded[0]?.method).toBe('HEAD')
    expect(script.recorded[1]?.method).toBe('POST')
    expect(script.recorded[1]?.url.endsWith('/start')).toBe(true)
  })
})
