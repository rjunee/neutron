/**
 * S1/S2 — wide-bind owner-bearer gate for the upload surfaces.
 *
 * The `/api/upload/*` routes are in the NON-GATED HTTP route set, so the
 * wide-bind fail-closed guarantee is enforced at the handler `auth` seam via
 * `buildUploadOwnerBearerAuth`. These tests pin the mutation-killing behaviour:
 *
 *   (a) WIDE bind (0.0.0.0) + NO bearer     → REJECTED (401), nothing written to
 *       `<owner_home>/imports/`, engine (import pipeline) NOT kicked.
 *   (b) WIDE bind + VALID owner bearer       → accepted (200), file written.
 *   (c) LOOPBACK bind + no bearer            → accepted (unchanged dev behaviour).
 *
 * The shim is exercised BOTH directly (unit) and end-to-end through the
 * production `buildImportUploadHandler` factory (the exact seam the composer
 * wires), so a mutation that drops the `auth` thread-through or flips the
 * loopback branch is caught.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildUploadOwnerBearerAuth } from '../upload-auth.ts'
import {
  buildImportUploadHandler,
  type BuildImportUploadHandlerInput,
} from '../import-upload-handler.ts'
import {
  buildChunkedUploadHandler,
  type BuildChunkedUploadHandlerInput,
} from '../chunked-upload-handler.ts'
import type {
  CreateUploadSessionInput,
  UploadSessionRow,
  UploadSessionStore,
} from '../upload-session-store.ts'
import type { AdvanceResult } from '@neutronai/onboarding/interview/engine.ts'

const OWNER_BEARER = 'owner-secret-bearer-9f3a2b7c1d4e6f'
// Local-file-header magic + a non-NUL tail (bun's formData parser drops
// trailing NUL bytes — mirror import-upload-handler.test.ts).
const ZIP_MAGIC = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x01])

let tmpRoots: string[] = []
afterEach(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true })
  tmpRoots = []
})

function mkOwnerHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'neutron-upload-auth-test-'))
  tmpRoots.push(dir)
  return dir
}

function multipart(bytes: Uint8Array, filename: string): FormData {
  const form = new FormData()
  const ab = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(ab).set(bytes)
  form.append('file', new File([ab], filename, { type: 'application/zip' }))
  return form
}

function req(opts: { source: string; bearer?: string }): Request {
  const init: RequestInit = { method: 'POST', body: multipart(ZIP_MAGIC, 'export.zip') }
  if (opts.bearer !== undefined) init.headers = { authorization: `Bearer ${opts.bearer}` }
  return new Request(`http://box.local/api/upload/${opts.source}`, init)
}

interface EngineRecorder {
  calls: number
}

function buildHandler(
  owner_home: string,
  recorder: EngineRecorder,
  auth: BuildImportUploadHandlerInput['auth'],
): (r: Request) => Promise<Response> {
  const input: BuildImportUploadHandlerInput = {
    owner_home,
    uid: process.getuid?.() ?? 0,
    gid: process.getgid?.() ?? 0,
    project_slug: 'test-project',
    engine: {
      notifyImportUpload: async (): Promise<AdvanceResult> => {
        recorder.calls += 1
        return {
          outcome: 'advanced',
          state: {
            project_slug: 'test-project',
            phase: 'import_running',
            phase_state: { import_job_id: 'job-abc' },
            last_advanced_at: 0,
          } as unknown as AdvanceResult['state'],
        }
      },
    },
  }
  if (auth !== undefined) input.auth = auth
  return buildImportUploadHandler(input)
}

// ── Shim unit behaviour ──────────────────────────────────────────────────────

describe('buildUploadOwnerBearerAuth', () => {
  test('wide bind + no bearer → rejected', async () => {
    const auth = buildUploadOwnerBearerAuth({ bindIsLoopback: false, ownerBearer: OWNER_BEARER })
    expect((await auth(new Request('http://box.local/api/upload/chatgpt', { method: 'POST' }))).ok).toBe(
      false,
    )
  })

  test('wide bind + valid owner bearer → accepted', async () => {
    const auth = buildUploadOwnerBearerAuth({ bindIsLoopback: false, ownerBearer: OWNER_BEARER })
    expect((await auth(req({ source: 'chatgpt', bearer: OWNER_BEARER }))).ok).toBe(true)
  })

  test('wide bind + WRONG bearer → rejected', async () => {
    const auth = buildUploadOwnerBearerAuth({ bindIsLoopback: false, ownerBearer: OWNER_BEARER })
    expect((await auth(req({ source: 'chatgpt', bearer: 'dev:owner' }))).ok).toBe(false)
    expect((await auth(req({ source: 'chatgpt', bearer: `${OWNER_BEARER}x` }))).ok).toBe(false)
  })

  test('wide bind + malformed / empty Authorization → rejected', async () => {
    const auth = buildUploadOwnerBearerAuth({ bindIsLoopback: false, ownerBearer: OWNER_BEARER })
    const mk = (h: Record<string, string>): Request =>
      new Request('http://box.local/api/upload/chatgpt', { method: 'POST', headers: h })
    expect((await auth(mk({ authorization: OWNER_BEARER }))).ok).toBe(false) // no "Bearer " prefix
    expect((await auth(mk({ authorization: 'Bearer ' }))).ok).toBe(false) // empty token
  })

  test('wide bind + blank configured owner bearer → rejects everything', async () => {
    const auth = buildUploadOwnerBearerAuth({ bindIsLoopback: false, ownerBearer: '' })
    expect((await auth(req({ source: 'chatgpt', bearer: '' }))).ok).toBe(false)
    expect((await auth(req({ source: 'chatgpt', bearer: 'anything' }))).ok).toBe(false)
  })

  test('loopback bind → allow-all regardless of bearer', async () => {
    const auth = buildUploadOwnerBearerAuth({ bindIsLoopback: true, ownerBearer: OWNER_BEARER })
    expect((await auth(new Request('http://box.local/api/upload/chatgpt', { method: 'POST' }))).ok).toBe(
      true,
    )
    expect((await auth(req({ source: 'chatgpt', bearer: 'dev:owner' }))).ok).toBe(true)
  })
})

// ── End-to-end through the production handler factory ────────────────────────

describe('buildImportUploadHandler + wide-bind gate', () => {
  test('(a) wide bind + no bearer → 401, nothing written, pipeline NOT kicked', async () => {
    const owner_home = mkOwnerHome()
    const recorder: EngineRecorder = { calls: 0 }
    const auth = buildUploadOwnerBearerAuth({ bindIsLoopback: false, ownerBearer: OWNER_BEARER })
    const handler = buildHandler(owner_home, recorder, auth)

    const res = await handler(req({ source: 'chatgpt' })) // no Authorization header
    expect(res.status).toBe(401)

    // Reject path must write NOTHING to disk and NOT touch the engine.
    expect(existsSync(join(owner_home, 'imports'))).toBe(false)
    // (defensive) if the dir somehow exists it must at least be empty
    if (existsSync(join(owner_home, 'imports'))) {
      expect(readdirSync(join(owner_home, 'imports'))).toEqual([])
    }
    expect(recorder.calls).toBe(0)
  })

  test('(b) wide bind + valid owner bearer → 200, file written, pipeline kicked', async () => {
    const owner_home = mkOwnerHome()
    const recorder: EngineRecorder = { calls: 0 }
    const auth = buildUploadOwnerBearerAuth({ bindIsLoopback: false, ownerBearer: OWNER_BEARER })
    const handler = buildHandler(owner_home, recorder, auth)

    const res = await handler(req({ source: 'chatgpt', bearer: OWNER_BEARER }))
    expect(res.status).toBe(200)

    const dest = join(owner_home, 'imports', 'chatgpt.zip')
    expect(statSync(dest).isFile()).toBe(true)
    expect(recorder.calls).toBe(1)
  })

  test('(c) loopback bind + no bearer → 200, unchanged dev behaviour', async () => {
    const owner_home = mkOwnerHome()
    const recorder: EngineRecorder = { calls: 0 }
    const auth = buildUploadOwnerBearerAuth({ bindIsLoopback: true, ownerBearer: OWNER_BEARER })
    const handler = buildHandler(owner_home, recorder, auth)

    const res = await handler(req({ source: 'chatgpt' })) // no Authorization header
    expect(res.status).toBe(200)

    const dest = join(owner_home, 'imports', 'chatgpt.zip')
    expect(statSync(dest).isFile()).toBe(true)
    expect(recorder.calls).toBe(1)
  })
})

// ── End-to-end through the CHUNKED handler factory ───────────────────────────
// The chunked path (`/start`, PATCH, HEAD) is the one the web client actually
// uses, so it shares the SAME hole + `auth` seam. A fake store records `create`
// so the reject path can assert NO session was minted; the auth check runs
// before route dispatch so no DB is needed.

class RecordingStore implements UploadSessionStore {
  createCalls = 0
  async create(_input: CreateUploadSessionInput): Promise<void> {
    this.createCalls += 1
  }
  async get(_upload_id: string): Promise<UploadSessionRow | null> {
    return null
  }
  async updateBytesReceived(_upload_id: string, _candidate_offset: number): Promise<number | null> {
    return null
  }
  async markExpired(_upload_id: string): Promise<boolean> {
    return false
  }
  async deleteSession(_upload_id: string): Promise<boolean> {
    return false
  }
  async listExpiredUploading(_now_ms: number, _limit: number): Promise<UploadSessionRow[]> {
    return []
  }
}

function buildChunked(
  owner_home: string,
  store: UploadSessionStore,
  recorder: EngineRecorder,
  auth: BuildChunkedUploadHandlerInput['auth'],
): (r: Request) => Promise<Response | null> {
  const input: BuildChunkedUploadHandlerInput = {
    owner_home,
    uid: process.getuid?.() ?? 0,
    gid: process.getgid?.() ?? 0,
    project_slug: 'test-project',
    store,
    engine: {
      notifyImportUpload: async (): Promise<AdvanceResult> => {
        recorder.calls += 1
        return {
          outcome: 'advanced',
          state: {
            project_slug: 'test-project',
            phase: 'import_running',
            phase_state: { import_job_id: 'job-abc' },
            last_advanced_at: 0,
          } as unknown as AdvanceResult['state'],
        }
      },
    },
  }
  if (auth !== undefined) input.auth = auth
  return buildChunkedUploadHandler(input)
}

function startReq(bearer?: string): Request {
  const init: RequestInit = {
    method: 'POST',
    body: JSON.stringify({ filename: 'export.zip', total_bytes: 4096, mime_type: 'application/zip' }),
  }
  if (bearer !== undefined) init.headers = { authorization: `Bearer ${bearer}` }
  return new Request('http://box.local/api/upload/chatgpt/start', init)
}

describe('buildChunkedUploadHandler + wide-bind gate', () => {
  test('wide bind + no bearer → 401 on start/PATCH/HEAD, no session, pipeline NOT kicked', async () => {
    const owner_home = mkOwnerHome()
    const recorder: EngineRecorder = { calls: 0 }
    const store = new RecordingStore()
    const auth = buildUploadOwnerBearerAuth({ bindIsLoopback: false, ownerBearer: OWNER_BEARER })
    const handler = buildChunked(owner_home, store, recorder, auth)

    // /start — the write-minting route.
    const start = await handler(startReq()) // no Authorization header
    expect(start?.status).toBe(401)
    // PATCH + HEAD reject at the SAME auth gate (before route logic).
    const patch = await handler(
      new Request('http://box.local/api/upload/chatgpt/some-id', { method: 'PATCH' }),
    )
    expect(patch?.status).toBe(401)
    const head = await handler(
      new Request('http://box.local/api/upload/chatgpt/some-id', { method: 'HEAD' }),
    )
    expect(head?.status).toBe(401)

    // Reject path must mint NO session, write NOTHING, and NOT touch the engine.
    expect(store.createCalls).toBe(0)
    expect(existsSync(join(owner_home, 'imports'))).toBe(false)
    expect(recorder.calls).toBe(0)
  })

  test('wide bind + valid owner bearer → start accepted, session minted', async () => {
    const owner_home = mkOwnerHome()
    const recorder: EngineRecorder = { calls: 0 }
    const store = new RecordingStore()
    const auth = buildUploadOwnerBearerAuth({ bindIsLoopback: false, ownerBearer: OWNER_BEARER })
    const handler = buildChunked(owner_home, store, recorder, auth)

    const res = await handler(startReq(OWNER_BEARER))
    expect(res?.status).toBe(200)
    expect(store.createCalls).toBe(1)
  })

  test('loopback bind + no bearer → start accepted (unchanged dev behaviour)', async () => {
    const owner_home = mkOwnerHome()
    const recorder: EngineRecorder = { calls: 0 }
    const store = new RecordingStore()
    const auth = buildUploadOwnerBearerAuth({ bindIsLoopback: true, ownerBearer: OWNER_BEARER })
    const handler = buildChunked(owner_home, store, recorder, auth)

    const res = await handler(startReq()) // no Authorization header
    expect(res?.status).toBe(200)
    expect(store.createCalls).toBe(1)
  })
})
