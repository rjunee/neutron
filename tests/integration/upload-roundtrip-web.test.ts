/**
 * P2 v2 § 6.1 + § 3.5 — end-to-end roundtrip for the web upload path.
 *
 * Provisions an in-memory engine landed at `import_upload_pending`,
 * POSTs a ZIP at the `/api/upload/<source>` handler, asserts:
 *   - File lands at `<owner_home>/imports/<source>.zip` with mode 0600
 *   - Engine kicked the runner and advanced phase to `import_running`
 *   - phase_state.import_job_id is populated
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { ButtonStore } from '@neutronai/channels/button-store.ts'
import type { ButtonPrompt } from '@neutronai/channels/button-primitive.ts'
import { handleImportUpload } from '@neutronai/gateway/upload/import-upload-handler.ts'
import {
  InterviewEngine,
  type ImportJobRunnerHook,
  type ImportPayloadResolver,
} from '@neutronai/onboarding/interview/engine.ts'
import type { ImportJob } from '@neutronai/onboarding/history-import/types.ts'
import { InMemoryOnboardingStateStore } from '@neutronai/onboarding/interview/state-store.ts'
import { TranscriptWriter } from '@neutronai/onboarding/interview/transcript.ts'

const ZIP_MAGIC = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x01])

let tmp: string
let owner_home: string
let db: ProjectDb
let buttonStore: ButtonStore
let stateStore: InMemoryOnboardingStateStore
let transcript: TranscriptWriter
let engine: InterviewEngine
let runnerCalls: Array<{ project_slug: string; source: string }>
let sentPrompts: Array<{ prompt: ButtonPrompt }>

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-upload-roundtrip-'))
  owner_home = join(tmp, 'owner_home')
  db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
  buttonStore = new ButtonStore({ db })
  stateStore = new InMemoryOnboardingStateStore()
  transcript = new TranscriptWriter({
    path: join(owner_home, 'persona', 'onboarding-transcript.jsonl'),
  })
  runnerCalls = []
  sentPrompts = []

  const runner: ImportJobRunnerHook = {
    start: async (input) => {
      runnerCalls.push({ project_slug: input.project_slug, source: input.source })
      return { job_id: `job-${runnerCalls.length}` }
    },
    status: async (job_id: string): Promise<ImportJob | null> => ({
      job_id,
      project_slug: 'test-owner',
      source: 'chatgpt-zip',
      status: 'pass1-running',
      dollars_spent: 0,
      pass1_chunks_done: 0,
      pass1_chunks_total: 1,
      chunks_total_known: false,
      started_at: Date.now(),
    }),
    cancel: async () => undefined,
    synthesizeOnDemand: async () => null,
  }

  // Resolver reads the bytes back off disk under <owner_home>/imports/
  // — same shape the production FilesystemImportPayloadResolver uses,
  // simplified for the integration test.
  const resolver: ImportPayloadResolver = {
    resolve: async ({ source }) => {
      const filename = source === 'chatgpt-zip' ? 'chatgpt.zip' : 'claude.zip'
      const path = join(owner_home, 'imports', filename)
      try {
        return readFileSync(path)
      } catch {
        return null
      }
    },
  }

  engine = new InterviewEngine({
    buttonStore,
    stateStore,
    transcript,
    sendButtonPrompt: async (input) => {
      sentPrompts.push({ prompt: input.prompt })
      return { message_id: `msg-${sentPrompts.length}`, was_new: true }
    },
    importJobRunner: runner,
    importPayloadResolver: resolver,
  })
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

describe('upload roundtrip — web', () => {
  test('POST /api/upload/chatgpt writes file + advances engine to import_running', async () => {
    // Land the owner at `import_upload_pending`.
    await stateStore.upsert({
      user_id: 'test-user',
      project_slug: 'test-owner',
      phase: 'import_upload_pending',
      phase_state_patch: { ai_substrate_used: 'chatgpt' },
      advanced_at: 1,
    })

    const ab = new ArrayBuffer(ZIP_MAGIC.byteLength)
    new Uint8Array(ab).set(ZIP_MAGIC)
    const form = new FormData()
    form.append('file', new File([ab], 'export.zip', { type: 'application/zip' }))
    const req = new Request('http://test.local/api/upload/chatgpt', {
      method: 'POST',
      body: form,
    })

    const res = await handleImportUpload(req, {
      resolveInstanceContext: async () => ({
        owner_home,
        uid: process.getuid?.() ?? 0,
        gid: process.getgid?.() ?? 0,
        project_slug: 'test-owner',
        topic_id: 'chat',
        channel_kind: 'app-socket',
        user_id: 'test-user',
      }),
      engine,
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['ok']).toBe(true)
    expect(body['source']).toBe('chatgpt')
    // The engine transitions to `import_running` and then re-emits the
    // live status prompt; outcome reads `'reemitted_current'` after
    // pollImportRunningAndAdvance fires on the runner's pass1-running
    // status. The phase advance itself (signal of correctness) is
    // asserted on state.phase below.
    expect(body['outcome']).toBe('reemitted_current')

    // File on disk: mode 0600, owner-readable.
    const dest = join(owner_home, 'imports', 'chatgpt.zip')
    const stat = statSync(dest)
    expect(stat.isFile()).toBe(true)
    expect((stat.mode & 0o777)).toBe(0o600)
    expect(stat.size).toBe(ZIP_MAGIC.byteLength)

    // Engine kicked the runner with the chatgpt-zip enum.
    expect(runnerCalls.length).toBe(1)
    expect(runnerCalls[0]?.source).toBe('chatgpt-zip')

    // State machine advanced to import_running.
    const state = await stateStore.get('test-owner', 'test-user')
    expect(state?.phase).toBe('import_running')
    expect((state?.phase_state as Record<string, unknown>)['import_job_id']).toBe('job-1')
    expect((state?.phase_state as Record<string, unknown>)['import_source']).toBe(
      'chatgpt-zip',
    )

    // The engine emitted an import_running status prompt over the
    // sendButtonPrompt sink.
    expect(sentPrompts.length).toBeGreaterThan(0)
  })

  test('upload on a owner not in import_upload_pending is a no-op advance', async () => {
    await stateStore.upsert({
      user_id: 'test-user',
      project_slug: 'test-owner',
      phase: 'signup',
      phase_state_patch: {},
      advanced_at: 1,
    })

    const ab = new ArrayBuffer(ZIP_MAGIC.byteLength)
    new Uint8Array(ab).set(ZIP_MAGIC)
    const form = new FormData()
    form.append('file', new File([ab], 'export.zip', { type: 'application/zip' }))
    const req = new Request('http://test.local/api/upload/chatgpt', {
      method: 'POST',
      body: form,
    })
    const res = await handleImportUpload(req, {
      resolveInstanceContext: async () => ({
        owner_home,
        uid: process.getuid?.() ?? 0,
        gid: process.getgid?.() ?? 0,
        project_slug: 'test-owner',
        topic_id: 'chat',
        channel_kind: 'app-socket',
        user_id: 'test-user',
      }),
      engine,
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    // The handler still 200s + writes the file, but the engine refuses
    // to advance off a non-`import_upload_pending` phase.
    expect(body['outcome']).toBe('no_active_prompt')
    expect(runnerCalls.length).toBe(0)
    const state = await stateStore.get('test-owner', 'test-user')
    expect(state?.phase).toBe('signup')
  })
})
