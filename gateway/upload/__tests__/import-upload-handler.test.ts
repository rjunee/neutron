/**
 * P2 v2 § 6.1 / § 9.1 — import-upload handler unit tests.
 *
 * Covers the validation chain (auth → source enum → file presence →
 * size → magic bytes), the on-disk write contract (mode 0600, parent
 * dir mode 0700, chown to instance uid/gid), and the engine-bridge call
 * that fires after the bytes land.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  extractTopicIdFromRequest,
  handleImportUpload,
  isUploadSource,
  isValidTopicId,
  TOPIC_ID_FALLBACK,
  TOPIC_ID_HEADER,
  type ImportUploadDeps,
  type ImportUploadInstanceContext,
} from '../import-upload-handler.ts'
import type { AdvanceResult } from '../../../onboarding/interview/engine.ts'

// First 4 bytes are the local-file-header magic; trailing bytes keep
// the fixture > 4 bytes so the magic check + the full-file write both
// have something to read. NB: bun's `Request.formData()` parser drops
// trailing NUL (0x00) bytes from binary multipart parts (observed on
// bun 1.3.9, May 2026), so we pad with a non-NUL tail rather than the
// real ZIP local-file-header version field (`0x14 0x00 …`).
const ZIP_MAGIC = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x01])
const NOT_ZIP = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0x06])

let tmpRoots: string[] = []
afterEach(() => {
  for (const dir of tmpRoots) {
    rmSync(dir, { recursive: true, force: true })
  }
  tmpRoots = []
})

function mkOwnerHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'neutron-upload-test-'))
  tmpRoots.push(dir)
  return dir
}

interface RecorderResult {
  calls: Array<{
    project_slug: string
    topic_id: string
    source: 'chatgpt' | 'claude'
  }>
  result?: AdvanceResult
}

function buildDeps(opts: {
  owner_home: string
  uid?: number
  gid?: number
  project_slug?: string
  topic_id?: string
  channel_kind?: 'app-socket' | 'telegram' | 'webhook'
  recorder: RecorderResult
  notifyResult?: AdvanceResult
  notifyThrows?: Error
  auth?: ImportUploadDeps['auth']
  maxBytes?: number
}): ImportUploadDeps {
  const ctx: ImportUploadInstanceContext = {
    owner_home: opts.owner_home,
    uid: opts.uid ?? process.getuid?.() ?? 0,
    gid: opts.gid ?? process.getgid?.() ?? 0,
    project_slug: opts.project_slug ?? 'test-project',
    topic_id: opts.topic_id ?? 'chat',
    channel_kind: opts.channel_kind ?? 'app-socket',
  }
  const deps: ImportUploadDeps = {
    resolveInstanceContext: async () => ctx,
    engine: {
      notifyImportUpload: async (input) => {
        opts.recorder.calls.push({
          project_slug: input.project_slug,
          topic_id: input.topic_id,
          source: input.source,
        })
        if (opts.notifyThrows !== undefined) throw opts.notifyThrows
        const r: AdvanceResult =
          opts.notifyResult ?? {
            outcome: 'advanced',
            state: {
              project_slug: ctx.project_slug,
              phase: 'import_running',
              phase_state: { import_job_id: 'job-abc' },
              last_advanced_at: 0,
            } as unknown as AdvanceResult['state'],
          }
        opts.recorder.result = r
        return r
      },
    },
  }
  if (opts.auth !== undefined) deps.auth = opts.auth
  if (opts.maxBytes !== undefined) deps.maxBytes = opts.maxBytes
  return deps
}

function buildRequest(opts: {
  source: string
  body?: FormData
  url?: string
  topic_id_header?: string
}): Request {
  const url = opts.url ?? `http://test.local/api/upload/${opts.source}`
  const init: RequestInit = { method: 'POST' }
  if (opts.body !== undefined) init.body = opts.body
  if (opts.topic_id_header !== undefined) {
    init.headers = { [TOPIC_ID_HEADER]: opts.topic_id_header }
  }
  return new Request(url, init)
}

function multipartWith(bytes: Uint8Array, filename: string): FormData {
  const form = new FormData()
  // Materialise a dedicated ArrayBuffer to dodge the SharedArrayBuffer
  // variance issue TS5.4+ surfaces on `Uint8Array.buffer` (lib.dom
  // typings require `ArrayBuffer`, not `ArrayBufferLike`).
  const ab = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(ab).set(bytes)
  form.append('file', new File([ab], filename, { type: 'application/zip' }))
  return form
}

describe('isUploadSource', () => {
  test('accepts chatgpt and claude only', () => {
    expect(isUploadSource('chatgpt')).toBe(true)
    expect(isUploadSource('claude')).toBe(true)
    expect(isUploadSource('both')).toBe(false)
    expect(isUploadSource('gmail')).toBe(false)
    expect(isUploadSource('')).toBe(false)
  })
})

describe('handleImportUpload', () => {
  test('200 on valid chatgpt upload — writes file mode 0600, calls engine', async () => {
    const owner_home = mkOwnerHome()
    const recorder: RecorderResult = { calls: [] }
    const deps = buildDeps({ owner_home, recorder })
    const res = await handleImportUpload(
      buildRequest({
        source: 'chatgpt',
        body: multipartWith(ZIP_MAGIC, 'export.zip'),
      }),
      deps,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['ok']).toBe(true)
    expect(body['source']).toBe('chatgpt')
    expect(body['outcome']).toBe('advanced')
    expect(body['job_id']).toBe('job-abc')

    const dest = join(owner_home, 'imports', 'chatgpt.zip')
    const stat = statSync(dest)
    expect(stat.isFile()).toBe(true)
    // POSIX mode bottom 9 bits — owner-only rw.
    expect((stat.mode & 0o777)).toBe(0o600)

    expect(recorder.calls).toEqual([
      { project_slug: 'test-project', topic_id: 'chat', source: 'chatgpt' },
    ])

    const written = readFileSync(dest)
    expect(written.length).toBe(ZIP_MAGIC.length)
    expect(written[0]).toBe(0x50)
  })

  test('200 on valid claude upload — destination is claude.zip', async () => {
    const owner_home = mkOwnerHome()
    const recorder: RecorderResult = { calls: [] }
    const deps = buildDeps({ owner_home, recorder })
    const res = await handleImportUpload(
      buildRequest({
        source: 'claude',
        body: multipartWith(ZIP_MAGIC, 'claude.zip'),
      }),
      deps,
    )
    expect(res.status).toBe(200)
    const dest = join(owner_home, 'imports', 'claude.zip')
    expect(statSync(dest).isFile()).toBe(true)
    expect(recorder.calls[0]?.source).toBe('claude')
  })

  test('400 on invalid source', async () => {
    const owner_home = mkOwnerHome()
    const recorder: RecorderResult = { calls: [] }
    const deps = buildDeps({ owner_home, recorder })
    const res = await handleImportUpload(
      buildRequest({
        source: 'gmail',
        body: multipartWith(ZIP_MAGIC, 'export.zip'),
        url: 'http://test.local/api/upload/gmail',
      }),
      deps,
    )
    expect(res.status).toBe(400)
    expect(recorder.calls.length).toBe(0)
  })

  test('400 on missing file field', async () => {
    const owner_home = mkOwnerHome()
    const recorder: RecorderResult = { calls: [] }
    const deps = buildDeps({ owner_home, recorder })
    const form = new FormData()
    form.append('not-file', new File([ZIP_MAGIC], 'x.zip'))
    const res = await handleImportUpload(
      buildRequest({ source: 'chatgpt', body: form }),
      deps,
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as Record<string, unknown>
    expect((body['error'] as string).toLowerCase()).toContain('missing file')
    expect(recorder.calls.length).toBe(0)
  })

  test('413 on file exceeding size cap', async () => {
    const owner_home = mkOwnerHome()
    const recorder: RecorderResult = { calls: [] }
    const deps = buildDeps({ owner_home, recorder, maxBytes: 8 })
    // 16 bytes — exceeds the 8-byte test cap.
    const big = new Uint8Array(16)
    big.set(ZIP_MAGIC, 0)
    const res = await handleImportUpload(
      buildRequest({
        source: 'chatgpt',
        body: multipartWith(big, 'export.zip'),
      }),
      deps,
    )
    expect(res.status).toBe(413)
    expect(recorder.calls.length).toBe(0)
  })

  test('400 on non-zip magic bytes', async () => {
    const owner_home = mkOwnerHome()
    const recorder: RecorderResult = { calls: [] }
    const deps = buildDeps({ owner_home, recorder })
    const res = await handleImportUpload(
      buildRequest({
        source: 'chatgpt',
        body: multipartWith(NOT_ZIP, 'export.zip'),
      }),
      deps,
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as Record<string, unknown>
    expect((body['error'] as string).toLowerCase()).toContain('not a zip')
    expect(recorder.calls.length).toBe(0)
  })

  test('401 when auth shim rejects', async () => {
    const owner_home = mkOwnerHome()
    const recorder: RecorderResult = { calls: [] }
    const deps = buildDeps({
      owner_home,
      recorder,
      auth: async () => ({ ok: false }),
    })
    const res = await handleImportUpload(
      buildRequest({
        source: 'chatgpt',
        body: multipartWith(ZIP_MAGIC, 'x.zip'),
      }),
      deps,
    )
    expect(res.status).toBe(401)
    expect(recorder.calls.length).toBe(0)
  })

  test('404 when instance context resolver returns null', async () => {
    const owner_home = mkOwnerHome()
    const recorder: RecorderResult = { calls: [] }
    const deps: ImportUploadDeps = {
      resolveInstanceContext: async () => null,
      engine: { notifyImportUpload: async () => {
        recorder.calls.push({ project_slug: 'x', topic_id: 'y', source: 'chatgpt' })
        return { outcome: 'advanced', state: null }
      } },
    }
    const res = await handleImportUpload(
      buildRequest({
        source: 'chatgpt',
        body: multipartWith(ZIP_MAGIC, 'x.zip'),
      }),
      deps,
    )
    expect(res.status).toBe(404)
    expect(recorder.calls.length).toBe(0)
  })

  test('500 when filesystem write throws', async () => {
    const owner_home = mkOwnerHome()
    const recorder: RecorderResult = { calls: [] }
    const baseDeps = buildDeps({ owner_home, recorder })
    const deps: ImportUploadDeps = {
      ...baseDeps,
      fs: {
        mkdir: async () => undefined,
        writeFile: async () => {
          throw new Error('disk full')
        },
        chown: async () => undefined,
      },
    }
    const res = await handleImportUpload(
      buildRequest({
        source: 'chatgpt',
        body: multipartWith(ZIP_MAGIC, 'x.zip'),
      }),
      deps,
    )
    expect(res.status).toBe(500)
    expect(recorder.calls.length).toBe(0)
  })

  test('500 when engine notify throws', async () => {
    const owner_home = mkOwnerHome()
    const recorder: RecorderResult = { calls: [] }
    const deps = buildDeps({
      owner_home,
      recorder,
      notifyThrows: new Error('engine bad'),
    })
    const res = await handleImportUpload(
      buildRequest({
        source: 'chatgpt',
        body: multipartWith(ZIP_MAGIC, 'x.zip'),
      }),
      deps,
    )
    expect(res.status).toBe(500)
    // Engine WAS called (and threw); the file still landed on disk.
    expect(recorder.calls.length).toBe(1)
    const dest = join(owner_home, 'imports', 'chatgpt.zip')
    expect(statSync(dest).isFile()).toBe(true)
  })

  test('threads project_slug, topic_id, channel_kind into engine call', async () => {
    const owner_home = mkOwnerHome()
    const recorder: RecorderResult = { calls: [] }
    const deps = buildDeps({
      owner_home,
      recorder,
      project_slug: 'casey',
      topic_id: 'chat-42',
      channel_kind: 'app-socket',
    })
    const res = await handleImportUpload(
      buildRequest({
        source: 'chatgpt',
        body: multipartWith(ZIP_MAGIC, 'x.zip'),
      }),
      deps,
    )
    expect(res.status).toBe(200)
    expect(recorder.calls).toEqual([
      { project_slug: 'casey', topic_id: 'chat-42', source: 'chatgpt' },
    ])
  })

  // ── S11 — X-Neutron-Topic-Id contract ───────────────────────────
  //
  // The handler's `resolveInstanceContext` is the seam the per-instance
  // gateway boots wire with the production header-reading closure. We
  // pin the through-flow by building a resolver here that mirrors the
  // gateway/index.ts implementation: read the header, fall back to
  // 'chat' on miss. The engine recorder then asserts the topic_id the
  // engine actually saw.
  test('S11: resolver reads X-Neutron-Topic-Id header and threads it into engine call', async () => {
    const owner_home = mkOwnerHome()
    const recorder: RecorderResult = { calls: [] }
    const headerResolver: ImportUploadDeps['resolveInstanceContext'] = async (
      req,
    ) => {
      const topicId = extractTopicIdFromRequest(req) ?? TOPIC_ID_FALLBACK
      const ctx: ImportUploadInstanceContext = {
        owner_home,
        uid: process.getuid?.() ?? 0,
        gid: process.getgid?.() ?? 0,
        project_slug: 'casey',
        topic_id: topicId,
        channel_kind: 'app-socket',
      }
      return ctx
    }
    const baseDeps = buildDeps({ owner_home, recorder })
    const deps: ImportUploadDeps = {
      ...baseDeps,
      resolveInstanceContext: headerResolver,
    }
    const res = await handleImportUpload(
      buildRequest({
        source: 'chatgpt',
        body: multipartWith(ZIP_MAGIC, 'x.zip'),
        topic_id_header: 'web:synthetic:e2e:m2-walk-20260517T030139Z',
      }),
      deps,
    )
    expect(res.status).toBe(200)
    expect(recorder.calls).toEqual([
      {
        project_slug: 'casey',
        topic_id: 'web:synthetic:e2e:m2-walk-20260517T030139Z',
        source: 'chatgpt',
      },
    ])
  })

  test('S11: resolver falls back to TOPIC_ID_FALLBACK when header is absent', async () => {
    const owner_home = mkOwnerHome()
    const recorder: RecorderResult = { calls: [] }
    const headerResolver: ImportUploadDeps['resolveInstanceContext'] = async (
      req,
    ) => ({
      owner_home,
      uid: process.getuid?.() ?? 0,
      gid: process.getgid?.() ?? 0,
      project_slug: 'casey',
      topic_id: extractTopicIdFromRequest(req) ?? TOPIC_ID_FALLBACK,
      channel_kind: 'app-socket',
    })
    const baseDeps = buildDeps({ owner_home, recorder })
    const deps: ImportUploadDeps = {
      ...baseDeps,
      resolveInstanceContext: headerResolver,
    }
    const res = await handleImportUpload(
      buildRequest({
        source: 'chatgpt',
        body: multipartWith(ZIP_MAGIC, 'x.zip'),
      }),
      deps,
    )
    expect(res.status).toBe(200)
    expect(recorder.calls[0]?.topic_id).toBe(TOPIC_ID_FALLBACK)
  })

  test('S11: resolver rejects an invalid header (whitespace) and falls back', async () => {
    const owner_home = mkOwnerHome()
    const recorder: RecorderResult = { calls: [] }
    const headerResolver: ImportUploadDeps['resolveInstanceContext'] = async (
      req,
    ) => ({
      owner_home,
      uid: process.getuid?.() ?? 0,
      gid: process.getgid?.() ?? 0,
      project_slug: 'casey',
      topic_id: extractTopicIdFromRequest(req) ?? TOPIC_ID_FALLBACK,
      channel_kind: 'app-socket',
    })
    const baseDeps = buildDeps({ owner_home, recorder })
    const deps: ImportUploadDeps = {
      ...baseDeps,
      resolveInstanceContext: headerResolver,
    }
    const res = await handleImportUpload(
      buildRequest({
        source: 'chatgpt',
        body: multipartWith(ZIP_MAGIC, 'x.zip'),
        topic_id_header: 'web:bad user',
      }),
      deps,
    )
    expect(res.status).toBe(200)
    // Invalid → null → fallback. Not the spoofed value.
    expect(recorder.calls[0]?.topic_id).toBe(TOPIC_ID_FALLBACK)
  })
})

describe('isValidTopicId (S11)', () => {
  test('accepts the documented topic_id shapes', () => {
    expect(isValidTopicId('web:user-123')).toBe(true)
    expect(isValidTopicId('web:synthetic:e2e:m2-walk-20260517T030139Z')).toBe(true)
    expect(isValidTopicId('tg:1234567890')).toBe(true)
    expect(isValidTopicId('tg:1234567890:42')).toBe(true)
    expect(isValidTopicId('chat')).toBe(true) // fallback shape — accepted
  })

  test('rejects empty / non-string / oversize / illegal-char values', () => {
    expect(isValidTopicId('')).toBe(false)
    expect(isValidTopicId(undefined)).toBe(false)
    expect(isValidTopicId(null)).toBe(false)
    expect(isValidTopicId(42)).toBe(false)
    expect(isValidTopicId('web:has whitespace')).toBe(false)
    expect(isValidTopicId('web:has\nnewline')).toBe(false)
    expect(isValidTopicId('web:semi;colon')).toBe(false)
    expect(isValidTopicId('web:slash/path')).toBe(false)
    expect(isValidTopicId('web:' + 'a'.repeat(300))).toBe(false)
  })

  // ISSUES #24 — alphabet must accept `@` and `+` so an email-shaped sub
  // (forward-compat with non-UUID JWT subs) round-trips through the
  // header validator without dropping to TOPIC_ID_FALLBACK and stranding
  // the user in `import_upload_pending`.
  test('accepts email-shaped subs (`@` + `+`) under ISSUES #24', () => {
    expect(isValidTopicId('web:user@example.com')).toBe(true)
    expect(isValidTopicId('web:first.last+tag@example.com')).toBe(true)
    // Defence in depth — shell metachars and grammar splitters still rejected.
    expect(isValidTopicId('web:user@example.com;rm -rf /')).toBe(false)
    expect(isValidTopicId('web:user@example.com&id=1')).toBe(false)
  })
})

describe('extractTopicIdFromRequest (S11)', () => {
  test('returns the header value when valid', () => {
    const req = new Request('http://test/api/upload/chatgpt', {
      method: 'POST',
      headers: { [TOPIC_ID_HEADER]: 'web:abc-123' },
    })
    expect(extractTopicIdFromRequest(req)).toBe('web:abc-123')
  })

  test('returns null when header is absent', () => {
    const req = new Request('http://test/api/upload/chatgpt', { method: 'POST' })
    expect(extractTopicIdFromRequest(req)).toBeNull()
  })

  test('returns null when header is present but invalid', () => {
    const req = new Request('http://test/api/upload/chatgpt', {
      method: 'POST',
      headers: { [TOPIC_ID_HEADER]: 'web:has whitespace' },
    })
    expect(extractTopicIdFromRequest(req)).toBeNull()
  })

  test('header lookup is case-insensitive', () => {
    const req = new Request('http://test/api/upload/chatgpt', {
      method: 'POST',
      headers: { 'X-Neutron-Topic-Id': 'web:case-ok' },
    })
    expect(extractTopicIdFromRequest(req)).toBe('web:case-ok')
  })
})

describe('handleImportUpload — CSRF / Origin guard', () => {
  function csrfRequest(headers: Record<string, string>): Request {
    return new Request('http://test.local/api/upload/chatgpt', {
      method: 'POST',
      headers,
      body: multipartWith(ZIP_MAGIC, 'export.zip'),
    })
  }

  test('rejects a cross-site request with 403 BEFORE any disk write or engine call', async () => {
    const owner_home = mkOwnerHome()
    const recorder: RecorderResult = { calls: [] }
    const deps = buildDeps({ owner_home, recorder })
    const res = await handleImportUpload(
      csrfRequest({ 'Sec-Fetch-Site': 'cross-site' }),
      deps,
    )
    expect(res.status).toBe(403)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['ok']).toBe(false)
    expect(String(body['error'])).toContain('cross-site')
    // No engine bridge fired.
    expect(recorder.calls).toEqual([])
    // No file landed on disk.
    expect(() => statSync(join(owner_home, 'imports', 'chatgpt.zip'))).toThrow()
  })

  test('rejects a cross-origin request (Origin host mismatch, no Sec-Fetch) with 403', async () => {
    const owner_home = mkOwnerHome()
    const recorder: RecorderResult = { calls: [] }
    const deps = buildDeps({ owner_home, recorder })
    const res = await handleImportUpload(
      csrfRequest({
        Origin: 'https://evil.example.com',
        'X-Forwarded-Host': 'acme.example.com',
      }),
      deps,
    )
    expect(res.status).toBe(403)
    expect(recorder.calls).toEqual([])
  })

  test('allows a same-origin request (Sec-Fetch-Site: same-origin)', async () => {
    const owner_home = mkOwnerHome()
    const recorder: RecorderResult = { calls: [] }
    const deps = buildDeps({ owner_home, recorder })
    const res = await handleImportUpload(
      csrfRequest({ 'Sec-Fetch-Site': 'same-origin' }),
      deps,
    )
    expect(res.status).toBe(200)
    expect(recorder.calls.length).toBe(1)
  })

  test('allows an Origin-host-matching request', async () => {
    const owner_home = mkOwnerHome()
    const recorder: RecorderResult = { calls: [] }
    const deps = buildDeps({ owner_home, recorder })
    const res = await handleImportUpload(
      csrfRequest({
        Origin: 'https://acme.example.com',
        'X-Forwarded-Host': 'acme.example.com',
      }),
      deps,
    )
    expect(res.status).toBe(200)
    expect(recorder.calls.length).toBe(1)
  })

  test('allows a non-browser request with neither Origin nor Sec-Fetch (harness / curl)', async () => {
    const owner_home = mkOwnerHome()
    const recorder: RecorderResult = { calls: [] }
    const deps = buildDeps({ owner_home, recorder })
    const res = await handleImportUpload(
      csrfRequest({}),
      deps,
    )
    expect(res.status).toBe(200)
    expect(recorder.calls.length).toBe(1)
  })
})
