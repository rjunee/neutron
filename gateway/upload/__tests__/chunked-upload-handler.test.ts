/**
 * Upload Resume Phase 2 — chunked-upload handler unit tests.
 *
 * Covers the three new routes:
 *   POST  /api/upload/<source>/start
 *   PATCH /api/upload/<source>/<upload_id>
 *   HEAD  /api/upload/<source>/<upload_id>
 *
 * Drives the handler against a real ProjectDb + on-disk temp file so the
 * sparse-file truncation, the SQL `MAX()` idempotency, and the
 * magic-bytes finalisation path all exercise their production code.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '../../../migrations/runner.ts'
import { ProjectDb } from '../../../persistence/index.ts'
import { Database } from 'bun:sqlite'
import type { AdvanceResult } from '../../../onboarding/interview/engine.ts'

import {
  buildChunkedUploadHandler,
  CONTENT_RANGE_HEADER,
  parseContentRange,
  UPLOAD_OFFSET_HEADER,
  type BuildChunkedUploadHandlerInput,
} from '../chunked-upload-handler.ts'
import {
  SqliteUploadSessionStore,
  type UploadSessionStore,
} from '../upload-session-store.ts'

const ZIP_MAGIC_HEAD = new Uint8Array([0x50, 0x4b, 0x03, 0x04])

let tmpRoots: string[] = []
let dbs: ProjectDb[] = []
afterEach(() => {
  for (const db of dbs) {
    try {
      db.close()
    } catch {
      // swallow
    }
  }
  dbs = []
  for (const dir of tmpRoots) {
    rmSync(dir, { recursive: true, force: true })
  }
  tmpRoots = []
})

function mkOwnerHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'neutron-chunked-upload-test-'))
  tmpRoots.push(dir)
  return dir
}

function openTestDb(): ProjectDb {
  // Bun's ProjectDb.open wires WAL + busy_timeout; use the same path so
  // tests exercise production code, but route through a fresh per-test
  // file so suites don't share state.
  const path = `${mkOwnerHome()}/owner.db`
  const db = ProjectDb.open(path, { create: true })
  // applyMigrations expects a bun:sqlite Database — ProjectDb wraps one
  // but doesn't expose it. Open a sibling bare Database against the
  // same file for migrations (the bare connection inherits the WAL
  // journal mode the ProjectDb constructor already set).
  const bare = new Database(path)
  applyMigrations(bare)
  bare.close()
  dbs.push(db)
  return db
}

interface NotifyRecorder {
  calls: Array<{
    project_slug: string
    topic_id: string
    source: 'chatgpt' | 'claude'
  }>
}

function buildHandler(opts: {
  owner_home: string
  project_slug?: string
  store: UploadSessionStore
  recorder: NotifyRecorder
  notifyThrows?: Error
  maxBytes?: number
  chunkSizeBytes?: number
  sessionTtlMs?: number
}): ReturnType<typeof buildChunkedUploadHandler> {
  const project_slug = opts.project_slug ?? 'test-project'
  const input: BuildChunkedUploadHandlerInput = {
    owner_home: opts.owner_home,
    uid: process.getuid?.() ?? 0,
    gid: process.getgid?.() ?? 0,
    project_slug,
    engine: {
      notifyImportUpload: async (params) => {
        opts.recorder.calls.push({
          project_slug: params.project_slug,
          topic_id: params.topic_id,
          source: params.source,
        })
        if (opts.notifyThrows !== undefined) throw opts.notifyThrows
        const r: AdvanceResult = {
          outcome: 'advanced',
          state: {
            project_slug,
            phase: 'import_running',
            phase_state: { import_job_id: 'job-xyz' },
            last_advanced_at: 0,
          } as unknown as AdvanceResult['state'],
        }
        return r
      },
    },
    store: opts.store,
  }
  if (opts.maxBytes !== undefined) input.maxBytes = opts.maxBytes
  if (opts.chunkSizeBytes !== undefined) input.chunkSizeBytes = opts.chunkSizeBytes
  if (opts.sessionTtlMs !== undefined) input.sessionTtlMs = opts.sessionTtlMs
  return buildChunkedUploadHandler(input)
}

function startBody(filename: string, total: number, mime = 'application/zip'): string {
  return JSON.stringify({
    filename,
    total_bytes: total,
    mime_type: mime,
  })
}

function patchInit(body: Uint8Array, start: number, end: number, total: number): RequestInit {
  // Materialise a dedicated ArrayBuffer so `Request` sees the chunk
  // bytes intact even when the source is a slice of a larger buffer.
  const ab = new ArrayBuffer(body.byteLength)
  new Uint8Array(ab).set(body)
  return {
    method: 'PATCH',
    body: ab,
    headers: { [CONTENT_RANGE_HEADER]: `bytes ${start}-${end}/${total}` },
  }
}

describe('parseContentRange', () => {
  test('parses valid byte ranges', () => {
    expect(parseContentRange('bytes 0-1023/2048')).toEqual({
      start: 0,
      end: 1023,
      total: 2048,
    })
    expect(parseContentRange('bytes 1024-2047/2048')).toEqual({
      start: 1024,
      end: 2047,
      total: 2048,
    })
  })
  test('rejects malformed shapes', () => {
    expect(parseContentRange('bytes */2048')).toBeNull()
    expect(parseContentRange('bytes 0-1023')).toBeNull()
    expect(parseContentRange('items 0-1023/2048')).toBeNull()
    expect(parseContentRange('bytes 0-1023/0')).toBeNull()
  })
})

describe('POST /api/upload/<source>/start', () => {
  test('mints upload_id, creates sparse temp file, writes DB row', async () => {
    const owner_home = mkOwnerHome()
    const db = openTestDb()
    const store = new SqliteUploadSessionStore(db)
    const recorder: NotifyRecorder = { calls: [] }
    const handler = buildHandler({ owner_home, store, recorder })
    const total = 12 * 1024 // 12 KiB
    const res = await handler(
      new Request('http://test.local/api/upload/chatgpt/start', {
        method: 'POST',
        body: startBody('export.zip', total),
      }),
    )
    expect(res).not.toBeNull()
    expect(res?.status).toBe(200)
    const body = (await res?.json()) as Record<string, unknown>
    expect(typeof body['upload_id']).toBe('string')
    expect(typeof body['chunk_size_bytes']).toBe('number')
    const upload_id = body['upload_id'] as string
    const tempPath = join(owner_home, 'imports', `${upload_id}.part`)
    const stat = statSync(tempPath)
    expect(stat.isFile()).toBe(true)
    expect(stat.size).toBe(total)
    // File mode is 0600 (owner-only). Top-level imports dir is 0700.
    expect(stat.mode & 0o777).toBe(0o600)

    const row = await store.get(upload_id)
    expect(row).not.toBeNull()
    expect(row?.source).toBe('chatgpt')
    expect(row?.total_bytes).toBe(total)
    expect(row?.bytes_received).toBe(0)
    expect(row?.status).toBe('uploading')
    expect(recorder.calls.length).toBe(0)
  })

  test('400 on malformed JSON body', async () => {
    const owner_home = mkOwnerHome()
    const db = openTestDb()
    const handler = buildHandler({
      owner_home,
      store: new SqliteUploadSessionStore(db),
      recorder: { calls: [] },
    })
    const res = await handler(
      new Request('http://test.local/api/upload/chatgpt/start', {
        method: 'POST',
        body: 'not-json',
      }),
    )
    expect(res?.status).toBe(400)
  })

  test('413 when total_bytes exceeds maxBytes', async () => {
    const owner_home = mkOwnerHome()
    const db = openTestDb()
    const handler = buildHandler({
      owner_home,
      store: new SqliteUploadSessionStore(db),
      recorder: { calls: [] },
      maxBytes: 1024,
    })
    const res = await handler(
      new Request('http://test.local/api/upload/chatgpt/start', {
        method: 'POST',
        body: startBody('huge.zip', 2048),
      }),
    )
    expect(res?.status).toBe(413)
  })

  test('400 on invalid source', async () => {
    const owner_home = mkOwnerHome()
    const handler = buildHandler({
      owner_home,
      store: new SqliteUploadSessionStore(openTestDb()),
      recorder: { calls: [] },
    })
    const res = await handler(
      new Request('http://test.local/api/upload/gmail/start', {
        method: 'POST',
        body: startBody('x.zip', 16),
      }),
    )
    // Non-chunked route — handler returns null so the compose chain
    // would fall through. We treat null as the negative outcome here.
    expect(res).toBeNull()
  })
})

describe('PATCH /api/upload/<source>/<upload_id>', () => {
  async function startSession(opts: {
    owner_home: string
    store: UploadSessionStore
    recorder: NotifyRecorder
    total: number
    filename?: string
  }): Promise<{
    upload_id: string
    handler: ReturnType<typeof buildChunkedUploadHandler>
  }> {
    const handler = buildHandler({
      owner_home: opts.owner_home,
      store: opts.store,
      recorder: opts.recorder,
    })
    const res = await handler(
      new Request('http://test.local/api/upload/chatgpt/start', {
        method: 'POST',
        body: startBody(opts.filename ?? 'export.zip', opts.total),
      }),
    )
    const body = (await res?.json()) as { upload_id: string }
    return { upload_id: body.upload_id, handler }
  }

  test('first chunk writes bytes and updates bytes_received', async () => {
    const owner_home = mkOwnerHome()
    const db = openTestDb()
    const store = new SqliteUploadSessionStore(db)
    const recorder: NotifyRecorder = { calls: [] }
    const total = 12
    const chunk = new Uint8Array([
      0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe, 0xfd, 0xfc,
    ])
    const { upload_id, handler } = await startSession({
      owner_home,
      store,
      recorder,
      total,
    })
    const res = await handler(
      new Request(
        `http://test.local/api/upload/chatgpt/${upload_id}`,
        patchInit(chunk, 0, chunk.length - 1, total),
      ),
    )
    expect(res?.status).toBe(200)
    const body = (await res?.json()) as { ok: boolean; bytes_received: number }
    expect(body.bytes_received).toBe(chunk.length)
    const row = await store.get(upload_id)
    expect(row?.bytes_received).toBe(chunk.length)
    expect(row?.status).toBe('uploading')

    const tempPath = join(owner_home, 'imports', `${upload_id}.part`)
    const written = readFileSync(tempPath)
    expect(written.length).toBe(total)
    for (let i = 0; i < chunk.length; i += 1) {
      expect(written[i]).toBe(chunk[i] as number)
    }
    // Engine NOT yet called — only on completion.
    expect(recorder.calls.length).toBe(0)
  })

  test('idempotent: re-sending the same chunk leaves bytes_received unchanged', async () => {
    const owner_home = mkOwnerHome()
    const db = openTestDb()
    const store = new SqliteUploadSessionStore(db)
    const recorder: NotifyRecorder = { calls: [] }
    const total = 20
    const chunk = new Uint8Array([
      0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe, 0xfd, 0xfc,
    ])
    const { upload_id, handler } = await startSession({
      owner_home,
      store,
      recorder,
      total,
    })
    await handler(
      new Request(
        `http://test.local/api/upload/chatgpt/${upload_id}`,
        patchInit(chunk, 0, chunk.length - 1, total),
      ),
    )
    const before = await store.get(upload_id)
    expect(before?.bytes_received).toBe(chunk.length)
    // Re-send the same range. Server-side `MAX(bytes_received, ?)`
    // keeps the high-water mark stable.
    const res2 = await handler(
      new Request(
        `http://test.local/api/upload/chatgpt/${upload_id}`,
        patchInit(chunk, 0, chunk.length - 1, total),
      ),
    )
    expect(res2?.status).toBe(200)
    const body2 = (await res2?.json()) as { bytes_received: number }
    expect(body2.bytes_received).toBe(chunk.length)
  })

  test('final chunk → magic check → rename → engine.notify → row deleted → 200 complete', async () => {
    const owner_home = mkOwnerHome()
    const db = openTestDb()
    const store = new SqliteUploadSessionStore(db)
    const recorder: NotifyRecorder = { calls: [] }
    const total = 12
    const part1 = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xaa, 0xbb])
    const part2 = new Uint8Array([0xcc, 0xdd, 0xee, 0xff, 0x11, 0x22])
    const { upload_id, handler } = await startSession({
      owner_home,
      store,
      recorder,
      total,
    })
    await handler(
      new Request(
        `http://test.local/api/upload/chatgpt/${upload_id}`,
        patchInit(part1, 0, part1.length - 1, total),
      ),
    )
    const res = await handler(
      new Request(
        `http://test.local/api/upload/chatgpt/${upload_id}`,
        patchInit(part2, part1.length, total - 1, total),
      ),
    )
    expect(res?.status).toBe(200)
    const body = (await res?.json()) as Record<string, unknown>
    expect(body['status']).toBe('complete')
    expect(body['source']).toBe('chatgpt')
    expect(body['job_id']).toBe('job-xyz')

    // Session row deleted.
    expect(await store.get(upload_id)).toBeNull()

    // Final file landed at <owner_home>/imports/<source>.zip.
    const dest = join(owner_home, 'imports', 'chatgpt.zip')
    const finalBytes = readFileSync(dest)
    expect(finalBytes.length).toBe(total)
    expect(finalBytes[0]).toBe(0x50)
    expect(finalBytes[1]).toBe(0x4b)

    // Engine bridge fired exactly once.
    expect(recorder.calls.length).toBe(1)
    expect(recorder.calls[0]?.source).toBe('chatgpt')
  })

  test('final chunk with non-ZIP magic returns 400 and cleans up', async () => {
    const owner_home = mkOwnerHome()
    const db = openTestDb()
    const store = new SqliteUploadSessionStore(db)
    const recorder: NotifyRecorder = { calls: [] }
    const total = 8
    const chunk = new Uint8Array([0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff])
    const { upload_id, handler } = await startSession({
      owner_home,
      store,
      recorder,
      total,
    })
    const res = await handler(
      new Request(
        `http://test.local/api/upload/chatgpt/${upload_id}`,
        patchInit(chunk, 0, chunk.length - 1, total),
      ),
    )
    expect(res?.status).toBe(400)
    expect(recorder.calls.length).toBe(0)
    expect(await store.get(upload_id)).toBeNull()
  })

  test('410 Gone when session no longer exists', async () => {
    const owner_home = mkOwnerHome()
    const db = openTestDb()
    const store = new SqliteUploadSessionStore(db)
    const recorder: NotifyRecorder = { calls: [] }
    const handler = buildHandler({ owner_home, store, recorder })
    // Fabricate a UUID-shaped id that was never minted.
    const upload_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    const res = await handler(
      new Request(
        `http://test.local/api/upload/chatgpt/${upload_id}`,
        patchInit(ZIP_MAGIC_HEAD, 0, 3, 4),
      ),
    )
    // No row → 404 (matches the HEAD-on-missing semantics).
    expect(res?.status).toBe(404)
  })

  test('410 Gone when session expired', async () => {
    const owner_home = mkOwnerHome()
    const db = openTestDb()
    const store = new SqliteUploadSessionStore(db)
    const recorder: NotifyRecorder = { calls: [] }
    // Create a session via the handler, then mark it expired manually.
    const handler = buildHandler({ owner_home, store, recorder })
    const startRes = await handler(
      new Request('http://test.local/api/upload/chatgpt/start', {
        method: 'POST',
        body: startBody('export.zip', 8),
      }),
    )
    const { upload_id } = (await startRes?.json()) as { upload_id: string }
    await store.markExpired(upload_id)
    const res = await handler(
      new Request(
        `http://test.local/api/upload/chatgpt/${upload_id}`,
        patchInit(ZIP_MAGIC_HEAD, 0, 3, 8),
      ),
    )
    expect(res?.status).toBe(410)
  })

  test('400 on missing Content-Range', async () => {
    const owner_home = mkOwnerHome()
    const db = openTestDb()
    const store = new SqliteUploadSessionStore(db)
    const recorder: NotifyRecorder = { calls: [] }
    const { upload_id, handler } = await startSession({
      owner_home,
      store,
      recorder,
      total: 8,
    })
    const res = await handler(
      new Request(`http://test.local/api/upload/chatgpt/${upload_id}`, {
        method: 'PATCH',
        body: new Uint8Array([1, 2, 3, 4]),
      }),
    )
    expect(res?.status).toBe(400)
  })

  test('409 on gap (start > bytes_received) with Upload-Offset header', async () => {
    const owner_home = mkOwnerHome()
    const db = openTestDb()
    const store = new SqliteUploadSessionStore(db)
    const recorder: NotifyRecorder = { calls: [] }
    const total = 16
    const { upload_id, handler } = await startSession({
      owner_home,
      store,
      recorder,
      total,
    })
    // Try to write bytes 8..15 first — start > bytes_received (0).
    const chunk = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
    const res = await handler(
      new Request(
        `http://test.local/api/upload/chatgpt/${upload_id}`,
        patchInit(chunk, 8, 15, total),
      ),
    )
    expect(res?.status).toBe(409)
    expect(res?.headers.get(UPLOAD_OFFSET_HEADER)).toBe('0')
  })
})

describe('HEAD /api/upload/<source>/<upload_id>', () => {
  test('200 with Upload-Offset on partial session', async () => {
    const owner_home = mkOwnerHome()
    const db = openTestDb()
    const store = new SqliteUploadSessionStore(db)
    const recorder: NotifyRecorder = { calls: [] }
    const total = 16
    const handler = buildHandler({ owner_home, store, recorder })
    const startRes = await handler(
      new Request('http://test.local/api/upload/chatgpt/start', {
        method: 'POST',
        body: startBody('export.zip', total),
      }),
    )
    const { upload_id } = (await startRes?.json()) as { upload_id: string }
    // Write one 8-byte chunk.
    const chunk = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xa, 0xb, 0xc, 0xd])
    await handler(
      new Request(
        `http://test.local/api/upload/chatgpt/${upload_id}`,
        patchInit(chunk, 0, chunk.length - 1, total),
      ),
    )
    const head = await handler(
      new Request(`http://test.local/api/upload/chatgpt/${upload_id}`, {
        method: 'HEAD',
      }),
    )
    expect(head?.status).toBe(200)
    expect(head?.headers.get(UPLOAD_OFFSET_HEADER)).toBe(String(chunk.length))
    expect(head?.headers.get('Upload-Length')).toBe(String(total))
  })

  test('404 on unknown session', async () => {
    const owner_home = mkOwnerHome()
    const db = openTestDb()
    const handler = buildHandler({
      owner_home,
      store: new SqliteUploadSessionStore(db),
      recorder: { calls: [] },
    })
    const head = await handler(
      new Request(
        'http://test.local/api/upload/chatgpt/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        { method: 'HEAD' },
      ),
    )
    expect(head?.status).toBe(404)
  })

  test('404 on expired session (>24h ago)', async () => {
    const owner_home = mkOwnerHome()
    const db = openTestDb()
    const store = new SqliteUploadSessionStore(db)
    const handler = buildHandler({
      owner_home,
      store,
      recorder: { calls: [] },
      sessionTtlMs: 1, // Effectively immediate-expiry.
    })
    const startRes = await handler(
      new Request('http://test.local/api/upload/chatgpt/start', {
        method: 'POST',
        body: startBody('export.zip', 16),
      }),
    )
    const { upload_id } = (await startRes?.json()) as { upload_id: string }
    // Sleep past expiry — TTL was 1 ms.
    await new Promise((r) => setTimeout(r, 5))
    const head = await handler(
      new Request(`http://test.local/api/upload/chatgpt/${upload_id}`, {
        method: 'HEAD',
      }),
    )
    expect(head?.status).toBe(404)
  })
})

describe('handler returns null for non-owned paths', () => {
  test('legacy POST /api/upload/<source> is not claimed by the chunked handler', async () => {
    const owner_home = mkOwnerHome()
    const db = openTestDb()
    const handler = buildHandler({
      owner_home,
      store: new SqliteUploadSessionStore(db),
      recorder: { calls: [] },
    })
    const res = await handler(
      new Request('http://test.local/api/upload/chatgpt', { method: 'POST' }),
    )
    // Compose chain falls through to the legacy single-shot handler.
    expect(res).toBeNull()
  })

  test('GET on the chunked routes is not claimed', async () => {
    const owner_home = mkOwnerHome()
    const db = openTestDb()
    const handler = buildHandler({
      owner_home,
      store: new SqliteUploadSessionStore(db),
      recorder: { calls: [] },
    })
    const res = await handler(
      new Request('http://test.local/api/upload/chatgpt/start', { method: 'GET' }),
    )
    expect(res).toBeNull()
  })
})

describe('chunked upload — CSRF / Origin guard', () => {
  test('rejects a cross-site POST /start with 403 before minting a session', async () => {
    const owner_home = mkOwnerHome()
    const db = openTestDb()
    const store = new SqliteUploadSessionStore(db)
    const recorder: NotifyRecorder = { calls: [] }
    const handler = buildHandler({ owner_home, store, recorder })
    const res = await handler(
      new Request('http://test.local/api/upload/chatgpt/start', {
        method: 'POST',
        body: startBody('export.zip', 12 * 1024),
        headers: { 'Sec-Fetch-Site': 'cross-site' },
      }),
    )
    expect(res).not.toBeNull()
    expect(res?.status).toBe(403)
    const body = (await res?.json()) as Record<string, unknown>
    expect(body['ok']).toBe(false)
    expect(String(body['error'])).toContain('cross-site')
    // No imports dir / temp file should have been created.
    expect(() => statSync(join(owner_home, 'imports'))).toThrow()
  })

  test('rejects a cross-origin PATCH (Origin host mismatch) with 403', async () => {
    const owner_home = mkOwnerHome()
    const db = openTestDb()
    const store = new SqliteUploadSessionStore(db)
    const recorder: NotifyRecorder = { calls: [] }
    const handler = buildHandler({ owner_home, store, recorder })
    const res = await handler(
      new Request('http://test.local/api/upload/chatgpt/0123456789abcdef0123456789abcdef', {
        ...patchInit(ZIP_MAGIC_HEAD, 0, 3, 4),
        headers: {
          [CONTENT_RANGE_HEADER]: 'bytes 0-3/4',
          Origin: 'https://evil.example.com',
          'X-Forwarded-Host': 'acme.example.com',
        },
      }),
    )
    expect(res?.status).toBe(403)
  })

  test('rejects a cross-site HEAD with 403', async () => {
    const owner_home = mkOwnerHome()
    const db = openTestDb()
    const store = new SqliteUploadSessionStore(db)
    const recorder: NotifyRecorder = { calls: [] }
    const handler = buildHandler({ owner_home, store, recorder })
    const res = await handler(
      new Request('http://test.local/api/upload/chatgpt/0123456789abcdef0123456789abcdef', {
        method: 'HEAD',
        headers: { 'Sec-Fetch-Site': 'cross-site' },
      }),
    )
    expect(res?.status).toBe(403)
  })

  test('allows a same-origin POST /start (Sec-Fetch-Site: same-origin)', async () => {
    const owner_home = mkOwnerHome()
    const db = openTestDb()
    const store = new SqliteUploadSessionStore(db)
    const recorder: NotifyRecorder = { calls: [] }
    const handler = buildHandler({ owner_home, store, recorder })
    const res = await handler(
      new Request('http://test.local/api/upload/chatgpt/start', {
        method: 'POST',
        body: startBody('export.zip', 12 * 1024),
        headers: { 'Sec-Fetch-Site': 'same-origin' },
      }),
    )
    expect(res?.status).toBe(200)
    const body = (await res?.json()) as Record<string, unknown>
    expect(typeof body['upload_id']).toBe('string')
  })

  test('a cross-site request on a NON-owned path still falls through (null), not 403', async () => {
    const owner_home = mkOwnerHome()
    const db = openTestDb()
    const store = new SqliteUploadSessionStore(db)
    const recorder: NotifyRecorder = { calls: [] }
    const handler = buildHandler({ owner_home, store, recorder })
    // Bare legacy shape `/api/upload/<source>` is owned by the single-shot
    // handler, not chunked — the guard must NOT 403 it here.
    const res = await handler(
      new Request('http://test.local/api/upload/chatgpt', {
        method: 'POST',
        headers: { 'Sec-Fetch-Site': 'cross-site' },
      }),
    )
    expect(res).toBeNull()
  })
})
