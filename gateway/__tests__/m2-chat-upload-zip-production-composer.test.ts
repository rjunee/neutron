/**
 * M2 chat-upload UX — ZIP-upload production-composer reachability gate
 * (Argus r1 BLOCKING #2).
 *
 * What this test guards: the per-instance gateway's `import_upload_handler`
 * resolver must thread the inbound topic_id (`app:<user_id>` or
 * `web:<user_id>`) into BOTH the engine's `topic_id` (so the post-upload
 * button emit lands on the user's live WebSocket) AND its `user_id`
 * (so the engine state lookup hits the instance-isolated
 * `(project_slug, user_id)` row instead of falling back to '' and
 * `noop_no_state` — the silent-stuck-in-`import_upload_pending`
 * regression Argus r1 first caught on `app:`, and PR #258 r1 caught
 * on `web:` once the landing client wired the header).
 *
 * Strategy: compose the SAME `composeHttpHandler` chain the production
 * gateway uses, with `importUploadHandler` built via
 * `buildImportUploadHandler` (also the same closure prod boots). Issue
 * a real HTTP `POST /api/upload/chatgpt` with multipart ZIP bytes +
 * `X-Neutron-Topic-Id: app:<user_id>`. Assert (a) 200 OK, (b) the
 * recorder engine saw `topic_id: 'app:<user_id>'`, (c) the recorder
 * engine saw `user_id: '<user_id>'` (NOT '') — the actual r1 BLOCKER,
 * (d) the response advances out of `import_upload_pending`.
 *
 * Mirrors the persona-gen incident guard documented in CLAUDE.md
 * ("Integration tests that only assert phase-machine bookkeeping" are
 * forbidden — assertions must be explicit on the module-invocation
 * arguments, not just the bookkeeping).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '../../migrations/runner.ts'
import { ProjectDb } from '../../persistence/index.ts'
import { composeProductionGraph } from '../composition.ts'
import { buildImportUploadHandler } from '../upload/import-upload-handler.ts'
import type { AdvanceResult } from '../../onboarding/interview/engine.ts'
import { STUB_PLATFORM } from '@neutronai/runtime/__tests__/stub-platform.ts'

// First 4 bytes are the local-file-header magic; trailing bytes keep
// the fixture > 4 bytes so the magic check + the full-file write both
// have something to read. bun's `Request.formData()` parser drops
// trailing NUL bytes from binary parts, so we pad with a non-NUL tail.
const ZIP_MAGIC = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x01])

interface EngineCall {
  project_slug: string
  topic_id: string
  user_id: string
  source: 'chatgpt' | 'claude'
}

interface Harness {
  server: import('bun').Server<unknown>
  base: string
  owner_home: string
  engineCalls: EngineCall[]
  topicMissingCount: number
  graph: Awaited<ReturnType<typeof composeProductionGraph>>
  db: ProjectDb
  close(): Promise<void>
}

const noOpInputBase = {
  topic_handler: async () => {},
  approval_notifier: { notify: async () => undefined },
  watchdog_notifier: { notify: async () => undefined },
  reminder_dispatcher: { dispatch: async () => undefined },
  heartbeat_tracker: { lastHeartbeatAt: () => Date.now() },
  platform: STUB_PLATFORM,
}

function makeMultipart(bytes: Uint8Array, name: string): FormData {
  const form = new FormData()
  const ab = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(ab).set(bytes)
  form.append('file', new File([ab], name, { type: 'application/zip' }))
  return form
}

async function startHarness(): Promise<Harness> {
  const owner_home = mkdtempSync(join(tmpdir(), 'neutron-m2-zip-prod-'))
  const db = ProjectDb.open(join(owner_home, 'owner.db'))
  applyMigrations(db.raw())
  const engineCalls: EngineCall[] = []
  let topicMissingCount = 0

  const importUploadHandler = buildImportUploadHandler({
    owner_home,
    uid: process.getuid?.() ?? 0,
    gid: process.getgid?.() ?? 0,
    project_slug: 'demo',
    engine: {
      notifyImportUpload: async (input) => {
        engineCalls.push({
          project_slug: input.project_slug,
          topic_id: input.topic_id,
          user_id: input.user_id,
          source: input.source,
        })
        // Mirror the engine's `import_running` advance outcome so the
        // handler response carries the transition signal the chat
        // client would render. If `user_id` were ever ''
        // (pre-BLOCKING-#2 behaviour), production would hit
        // `noop_no_state`. We assert against `engineCalls[0].user_id`
        // directly, but returning a realistic shape keeps the
        // response-body assertion meaningful too.
        const result: AdvanceResult = {
          outcome: 'advanced',
          state: {
            project_slug: input.project_slug,
            phase: 'import_running',
            phase_state: { import_job_id: 'job-test-001' },
            last_advanced_at: Date.now(),
          } as unknown as AdvanceResult['state'],
        }
        return result
      },
    },
    onTopicIdMissing: () => {
      topicMissingCount += 1
    },
  })

  // Boot the production graph with `import_upload_handler` threaded
  // through — the same contract `gateway/index.ts:boot` honors. If a
  // future CompositionInput field rename / removal drops
  // `import_upload_handler` from the typed shape, this construction
  // breaks at compile time BEFORE the runtime test runs.
  const graph = await composeProductionGraph({
    db,
    project_slug: 'demo',
    ...noOpInputBase,
    import_upload_handler: importUploadHandler,
  })

  // ISSUE #32 — serve `graph.fetch` directly. The composed handler is
  // built by `composeProductionGraph` from
  // `composition.import_upload_handler`, so the boot-wiring mapping IS
  // the only path exercised here. A deletion of the
  // `composeInput.importUploadHandler = …` line in
  // `gateway/composition.ts:buildComposedHttpFromComposition` provably
  // breaks this test (closing condition for ISSUE #32).
  if (graph.fetch === undefined || graph.websocket === undefined) {
    throw new Error(
      'composeProductionGraph did not expose graph.fetch — production-composer reachability gap (ISSUE #32)',
    )
  }
  const composedFetch = graph.fetch
  const composedWebsocket = graph.websocket

  const server = Bun.serve({
    port: 0,
    fetch: (req, srv) => composedFetch(req, srv),
    websocket: composedWebsocket,
  })

  return {
    server,
    base: `http://127.0.0.1:${server.port}`,
    owner_home,
    engineCalls,
    get topicMissingCount() {
      return topicMissingCount
    },
    graph,
    db,
    close: async () => {
      await server.stop(true)
      await graph.shutdown()
      db.close()
      try {
        rmSync(owner_home, { recursive: true, force: true })
      } catch {
        /* ignore — test cleanup */
      }
    },
  } as Harness
}

describe('M2 chat-upload UX — ZIP production composer reachability', () => {
  let harness: Harness
  beforeEach(async () => {
    harness = await startHarness()
  })
  afterEach(async () => {
    await harness.close()
  })

  it('parses app:<user_id> from X-Neutron-Topic-Id and threads user_id into engine.notifyImportUpload', async () => {
    const form = makeMultipart(ZIP_MAGIC, 'chatgpt-export.zip')
    const res = await fetch(`${harness.base}/api/upload/chatgpt`, {
      method: 'POST',
      headers: {
        'x-neutron-topic-id': 'app:test-user-abc-123',
      },
      body: form,
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['ok']).toBe(true)
    expect(body['source']).toBe('chatgpt')
    // The engine's recorder MUST have seen a single call with both
    // topic_id (for the WS routing) AND user_id (for the engine state
    // lookup). The BLOCKING #2 regression was `user_id: ''` here — the
    // engine then hit `noop_no_state` and the user stalled in
    // `import_upload_pending` with the 200 OK already returned to the
    // client.
    expect(harness.engineCalls).toHaveLength(1)
    const call = harness.engineCalls[0]
    expect(call?.project_slug).toBe('demo')
    expect(call?.topic_id).toBe('app:test-user-abc-123')
    expect(call?.user_id).toBe('test-user-abc-123')
    expect(call?.source).toBe('chatgpt')
    // The response carries the engine advance outcome so the chat
    // client can render "analyzing → done" without a follow-up RTT.
    expect(body['outcome']).toBe('advanced')
    expect(body['job_id']).toBe('job-test-001')
    // The header was present + valid → the deprecation hook MUST NOT
    // have fired.
    expect(harness.topicMissingCount).toBe(0)
  })

  it('falls back when X-Neutron-Topic-Id is missing AND leaves user_id unset (engine legacy fallback path)', async () => {
    const form = makeMultipart(ZIP_MAGIC, 'chatgpt-export.zip')
    const res = await fetch(`${harness.base}/api/upload/chatgpt`, {
      method: 'POST',
      body: form,
    })
    expect(res.status).toBe(200)
    expect(harness.engineCalls).toHaveLength(1)
    const call = harness.engineCalls[0]
    // No app:<user_id> in the header → user_id NOT parseable → defaults
    // to ''. The engine's legacy fallback handles this — we just
    // assert the resolver doesn't fabricate a user_id from the
    // fallback `'chat'` topic_id.
    expect(call?.user_id).toBe('')
    expect(call?.topic_id).toBe('chat')
    // The once-per-handler deprecation hook fired exactly once for the
    // missing-header path.
    expect(harness.topicMissingCount).toBe(1)
  })

  it('parses web:<user_id> from X-Neutron-Topic-Id and threads user_id into engine.notifyImportUpload', async () => {
    // PR #258 r1 BLOCKER #1 — the production landing client at
    // landing/chat.ts:1313 derives `web:<sub>` from the start-token's
    // `sub` claim and sends it through this header. Pre-fix the
    // resolver only recognised `app:<user_id>` (AppWs / Expo shape),
    // so `web:` shapes silently dropped into the engine's empty-string
    // user_id fallback and `notifyImportUpload` returned
    // `outcome=noop_no_state`. The shared `parseAnyTopicId` utility
    // closes the gap. THIS is the regression case that would have
    // FAILED on pre-fix code.
    const form = makeMultipart(ZIP_MAGIC, 'claude.zip')
    const res = await fetch(`${harness.base}/api/upload/claude`, {
      method: 'POST',
      headers: { 'x-neutron-topic-id': 'web:landing-user-9' },
      body: form,
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['ok']).toBe(true)
    expect(harness.engineCalls).toHaveLength(1)
    const call = harness.engineCalls[0]
    expect(call?.topic_id).toBe('web:landing-user-9')
    // Argus r1 PR #258 BLOCKER #1 — user_id MUST be the suffix
    // ('landing-user-9'), NOT '' (the pre-fix silent-noop_no_state
    // regression). The engine's state lookup hits the instance-isolated
    // `(project_slug, user_id)` row only when this is correct.
    expect(call?.user_id).toBe('landing-user-9')
    expect(call?.source).toBe('claude')
    expect(body['outcome']).toBe('advanced')
    expect(body['job_id']).toBe('job-test-001')
    expect(harness.topicMissingCount).toBe(0)
  })

  it('legacy `chat` placeholder is recognised but leaves user_id unset (engine fallback path)', async () => {
    const form = makeMultipart(ZIP_MAGIC, 'claude.zip')
    const res = await fetch(`${harness.base}/api/upload/claude`, {
      method: 'POST',
      headers: { 'x-neutron-topic-id': 'chat' },
      body: form,
    })
    expect(res.status).toBe(200)
    const call = harness.engineCalls[0]
    expect(call?.topic_id).toBe('chat')
    // `'chat'` carries no user_id — engine's legacy fallback handles it.
    expect(call?.user_id).toBe('')
  })
})
