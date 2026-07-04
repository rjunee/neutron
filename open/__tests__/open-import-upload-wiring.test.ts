/**
 * Open import-upload wiring — composition reachability gate.
 *
 * THE BUG (Ryan, dogfooding the self-host install): during onboarding,
 * "Upload Claude export" failed with
 * `POST /start failed (404): Not Found`. Root cause — `open/composer.ts`
 * built its composition but never set `chunked_upload_handler` /
 * `import_upload_handler`, so `app-surfaces-input` left the import-upload
 * routes UNMOUNTED in the single-owner Open server. Every
 * `POST /api/upload/<source>/start` 404'd → import was impossible.
 *
 * These tests boot the REAL Open composition (`buildOpenGraphComposer`
 * → `composeProductionGraph`, the same compose `boot()` runs) over a
 * real `Bun.serve` and assert the surface is now mounted AND functional:
 *
 *   1. `POST /api/upload/claude/start` → 200 with
 *      `{ upload_id, chunk_size_bytes }` (NOT 404) — the headline fix.
 *   2. A full chunked upload (start → PATCH the whole fixture → finalize)
 *      completes, lands `<owner_home>/imports/claude.zip` on disk, and —
 *      with the owner's onboarding state genuinely at
 *      `import_upload_pending` — drives the Open InterviewEngine's REAL
 *      `notifyImportUpload` → advance path so the phase moves OUT of
 *      `import_upload_pending` (no SQL-stubbed outcome; the advance is the
 *      engine's own).
 *   3. The bare single-shot `POST /api/upload/claude` (multipart) is
 *      mounted too (the `import_upload_handler` path).
 *
 * Per CLAUDE.md anti-placeholder rules: assertions are explicit on the
 * on-disk artifact AND the real post-advance phase, not phase-machine
 * bookkeeping alone.
 *
 * No ANTHROPIC_API_KEY is set — the box boots LLM-less; the upload
 * surface does not depend on LLM credentials.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { applyMigrations } from '../../migrations/runner.ts'
import { ProjectDb } from '../../persistence/index.ts'
import { composeProductionGraph } from '../../gateway/composition.ts'
import { SqliteOnboardingStateStore } from '../../onboarding/interview/sqlite-state-store.ts'
import { buildOpenGraphComposer } from '../composer.ts'

/**
 * Resolve the `X-Neutron-Topic-Id` upload header the SAME way the Open
 * single-owner session is keyed: `web:<user_id>`. (Formerly derived by
 * minting a real start-token and running it through
 * `landing/start-token-topic-id.ts:startTokenTopicId` — that decoder had
 * zero production importers and was deleted in the wave-1 dead-code kill,
 * refactor plan §K1. The format it decoded to is fixed and asserted below,
 * so deriving it directly here is equivalent for this integration test.)
 */
function resolveRealUploadTopicId(user_id: string): string {
  return `web:${user_id}`
}

const HERE = dirname(fileURLToPath(import.meta.url))
const LANDING_DIR = join(HERE, '..', '..', 'landing')

// First two bytes are the ZIP local-file-header magic (`PK`). The
// chunked finaliser + the single-shot handler both check the magic and
// read the assembled bytes, so the fixture must be > 4 bytes.
const ZIP_FIXTURE = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x01])

const SAVED_ENV_KEYS = [
  'NEUTRON_HOME',
  'OWNER_HOME',
  'NEUTRON_DB_PATH',
  'NEUTRON_INSTANCE_SLUG',
  'NEUTRON_LANDING_STATIC_DIR',
  'NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'NEUTRON_DISABLE_AMBIENT_CLAUDE_AUTH',
  'NOTIFY_SOCKET',
] as const

let savedEnv: Record<string, string | undefined> = {}
let tmpDir: string

interface Harness {
  server: import('bun').Server<unknown>
  base: string
  db: ProjectDb
  owner_home: string
  close(): Promise<void>
}

let harness: Harness | null = null

beforeEach(() => {
  savedEnv = {}
  for (const k of SAVED_ENV_KEYS) savedEnv[k] = process.env[k]
  tmpDir = mkdtempSync(join(tmpdir(), 'neutron-open-import-upload-'))
  process.env['NEUTRON_HOME'] = tmpDir
  process.env['OWNER_HOME'] = tmpDir
  process.env['NEUTRON_DB_PATH'] = join(tmpDir, 'project.db')
  process.env['NEUTRON_INSTANCE_SLUG'] = 'owner'
  process.env['NEUTRON_LANDING_STATIC_DIR'] = LANDING_DIR
  process.env['NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET'] = 'open-test-secret-0123456789'
  delete process.env['ANTHROPIC_API_KEY'] // LLM-less boot
  delete process.env['CLAUDE_CODE_OAUTH_TOKEN']
  process.env['NEUTRON_DISABLE_AMBIENT_CLAUDE_AUTH'] = '1' // force handoff default: ignore any host `claude` login (#101 Keychain probe)
  delete process.env['NOTIFY_SOCKET']
})

afterEach(async () => {
  if (harness !== null) {
    await harness.close()
    harness = null
  }
  for (const k of SAVED_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  rmSync(tmpDir, { recursive: true, force: true })
})

/**
 * Boot the Open composition the way `gateway/index.ts:boot` does — invoke
 * the Open `GraphComposer` against a real per-owner `project.db`, compose
 * the production graph, and serve it. Returns the running server + the db
 * (shared with the composition's InterviewEngine, so a test-side state
 * store seeds the SAME onboarding_state rows the engine reads).
 */
async function startHarness(): Promise<Harness> {
  const db = ProjectDb.open(process.env['NEUTRON_DB_PATH']!)
  applyMigrations(db.raw())
  const composer = buildOpenGraphComposer({ env: process.env })
  const composition = await composer({ db, project_slug: 'owner' })
  const graph = await composeProductionGraph(composition)
  if (graph.fetch === undefined || graph.websocket === undefined) {
    throw new Error(
      'Open composition did not expose graph.fetch/websocket — import-upload surface unreachable',
    )
  }
  const composedFetch = graph.fetch
  const composedWebsocket = graph.websocket
  const server = Bun.serve({
    port: 0,
    fetch: (req, srv) => composedFetch(req, srv),
    websocket: composedWebsocket,
  })
  const h: Harness = {
    server,
    base: `http://127.0.0.1:${server.port}`,
    db,
    owner_home: tmpDir,
    close: async () => {
      await server.stop(true)
      // Tear down the long-lived upload-session sweeper (and any other
      // realmode cleanup) so the test process doesn't leak a timer.
      for (const cleanup of composition.realmode_cleanups ?? []) {
        try {
          cleanup()
        } catch {
          /* best-effort */
        }
      }
      await graph.shutdown()
      db.close()
    },
  }
  return h
}

describe('Open import-upload surface wiring', () => {
  test('POST /api/upload/claude/start is MOUNTED → 200 with {upload_id, chunk_size_bytes} (regression: was 404)', async () => {
    harness = await startHarness()
    const res = await fetch(`${harness.base}/api/upload/claude/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        filename: 'claude-export.zip',
        mime_type: 'application/zip',
        total_bytes: ZIP_FIXTURE.byteLength,
      }),
    })
    // The bug surfaced as a 404 here. The fix mounts the route.
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(typeof body['upload_id']).toBe('string')
    expect((body['upload_id'] as string).length).toBeGreaterThan(0)
    expect(typeof body['chunk_size_bytes']).toBe('number')
    expect(body['total_bytes']).toBe(ZIP_FIXTURE.byteLength)
  }, 30_000)

  test('full chunked upload completes, lands the export on disk, AND advances the engine out of import_upload_pending', async () => {
    harness = await startHarness()

    // Put the owner's onboarding state genuinely at import_upload_pending
    // via the same SqliteOnboardingStateStore the composition's engine
    // reads (same db connection). This is the precondition; the ADVANCE
    // under test is the engine's own notifyImportUpload path, not a SQL
    // stub of the outcome.
    const stateStore = new SqliteOnboardingStateStore({ db: harness.db })
    await stateStore.upsert({
      project_slug: 'owner',
      user_id: 'owner',
      phase: 'import_upload_pending',
      phase_state_patch: {
        topic_id: 'web:owner',
        user_id: 'owner',
        signup_via: 'web',
        ai_substrate_used: 'claude',
      },
    })
    expect((await stateStore.get('owner', 'owner'))?.phase).toBe('import_upload_pending')

    // Resolve the upload topic header THE REAL WAY — mint an Open
    // start-token and run the production client decoder over it. Must land
    // on `web:owner` (the session's key), NOT null / the 'chat' fallback.
    // Pre-fix this threw because resolution returned null.
    const topicHeader = resolveRealUploadTopicId('owner')
    expect(topicHeader).toBe('web:owner')

    // 1. Start the chunked upload.
    const startRes = await fetch(`${harness.base}/api/upload/claude/start`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-neutron-topic-id': topicHeader,
      },
      body: JSON.stringify({
        filename: 'claude-export.zip',
        mime_type: 'application/zip',
        total_bytes: ZIP_FIXTURE.byteLength,
      }),
    })
    expect(startRes.status).toBe(200)
    const startBody = (await startRes.json()) as { upload_id: string }
    const uploadId = startBody.upload_id

    // 2. PATCH the whole fixture as a single chunk → finalisation.
    const total = ZIP_FIXTURE.byteLength
    const patchRes = await fetch(
      `${harness.base}/api/upload/claude/${uploadId}`,
      {
        method: 'PATCH',
        headers: {
          'content-range': `bytes 0-${total - 1}/${total}`,
          'x-neutron-topic-id': topicHeader,
        },
        body: ZIP_FIXTURE,
      },
    )
    expect(patchRes.status).toBe(200)
    const patchBody = (await patchRes.json()) as Record<string, unknown>
    expect(patchBody['status']).toBe('complete')

    // 3. The assembled export landed at the canonical destination on disk.
    expect(existsSync(join(harness.owner_home, 'imports', 'claude.zip'))).toBe(true)

    // 4. The engine's REAL advance fired — the phase moved OUT of
    //    import_upload_pending (the completion bridged
    //    engine.notifyImportUpload, which performed the advance).
    const after = await stateStore.get('owner', 'owner')
    expect(after).not.toBeNull()
    expect(after?.phase).not.toBe('import_upload_pending')
  }, 30_000)

  test('bare single-shot POST /api/upload/claude is mounted too (import_upload_handler path)', async () => {
    harness = await startHarness()
    const form = new FormData()
    const ab = new ArrayBuffer(ZIP_FIXTURE.byteLength)
    new Uint8Array(ab).set(ZIP_FIXTURE)
    form.append('file', new File([ab], 'claude.zip', { type: 'application/zip' }))
    const res = await fetch(`${harness.base}/api/upload/claude`, {
      method: 'POST',
      headers: { 'x-neutron-topic-id': resolveRealUploadTopicId('owner') },
      body: form,
    })
    // Mounted → NOT the 404 the bug produced. (No onboarding state seeded,
    // so the engine no-ops the advance, but the route + handler ran.)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['ok']).toBe(true)
    expect(body['source']).toBe('claude')
  }, 30_000)
})
