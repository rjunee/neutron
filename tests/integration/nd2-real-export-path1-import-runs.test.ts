/**
 * ND2 (dogfood 2026-06-27) — REAL-EXPORT acceptance for the Path-1 import fix.
 *
 * Proves end-to-end, through the ACTUAL `/api/upload/<source>` HTTP handler and
 * the FIXED `notifyImportUpload` routing, that a real Claude export uploaded
 * during live Path-1 (conversational) onboarding actually STARTS an import job
 * that ingests the real `conversations.json` — the exact scenario that was
 * silently orphaned pre-fix (`import_jobs` empty, `in_flight_imports=0` forever
 * behind a false "reading your history now" banner).
 *
 * Uses Ryan's REAL export (`~/Downloads/Claude Data Batch (1).zip`, ~14MB
 * conversations.json). The LLM synthesis pass is the only thing stubbed (a
 * recording runner) so this runs deterministically with NO Max-quota burn — it
 * proves the TRIGGER + real-bytes INGESTION (the part that was broken). The
 * synthesis→materialize stages are covered by the existing import-pipeline
 * suites (entity-populator, pass1-triage, pass2-synthesis) and require a real
 * Max substrate, documented in the PR for an owner-run live verification.
 *
 * Guarded: skips when the real export isn't on disk (CI / other machines).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
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
import { parseClaudeExport } from '@neutronai/onboarding/history-import/claude-export.ts'
import { InMemoryOnboardingStateStore } from '@neutronai/onboarding/interview/state-store.ts'
import { TranscriptWriter } from '@neutronai/onboarding/interview/transcript.ts'

const REAL_EXPORT = join(homedir(), 'Downloads', 'Claude Data Batch (1).zip')
const HAVE_EXPORT = existsSync(REAL_EXPORT)

let tmp: string
let owner_home: string
let db: ProjectDb
let buttonStore: ButtonStore
let stateStore: InMemoryOnboardingStateStore
let transcript: TranscriptWriter
let engine: InterviewEngine
let runnerCalls: Array<{ source: string; payload: unknown }>
let sentPrompts: Array<{ prompt: ButtonPrompt }>

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-nd2-real-export-'))
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

  // Records the source + the REAL payload bytes the engine hands the runner, so
  // the test can prove the real export flowed all the way through the trigger.
  const runner: ImportJobRunnerHook = {
    start: async (input) => {
      runnerCalls.push({ source: input.source, payload: input.payload })
      return { job_id: `job-${runnerCalls.length}` }
    },
    status: async (job_id: string): Promise<ImportJob | null> => ({
      job_id,
      project_slug: 'test-owner',
      source: 'claude-zip',
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

  // Production-shape resolver: reads the staged bytes back off disk under
  // <owner_home>/imports/<source>.zip (where the upload handler wrote them).
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
    // Path-1 live onboarding: open mode + the upload affordance is offered (an
    // import substrate is wired). This is the exact condition the fix keys on.
    deploymentMode: 'open',
    importAffordanceOffered: true,
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

describe('ND2 real-export — Path-1 conversational upload STARTS the import', () => {
  test.skipIf(!HAVE_EXPORT)(
    "Ryan's real Claude export at work_interview_gap_fill kicks a real import job ingesting the real conversations.json",
    async () => {
      // Live Path-1, fresh install: there is NO onboarding_state row yet. The
      // open-mode live-agent flow never calls the engine `start` drive, and #130 offers
      // the import right after the name — BEFORE the fire-and-forget post-turn
      // extractor has lazily/async created the row. This test deliberately does
      // NOT seed a row (it previously SQL-seeded one, which manufactured the
      // precondition the live flow never creates — so it could never catch the
      // #130 regression). The upload itself must seed the row + start the import.
      expect(await stateStore.get('test-owner', 'test-user')).toBeNull()

      // POST the REAL export to the web affordance's hardcoded /chatgpt route;
      // the handler's sniffer re-routes it to the Claude parser.
      const bytes = readFileSync(REAL_EXPORT)
      const ab = new ArrayBuffer(bytes.byteLength)
      new Uint8Array(ab).set(bytes)
      const form = new FormData()
      form.append('file', new File([ab], 'Claude Data Batch (1).zip', { type: 'application/zip' }))
      const req = new Request('http://test.local/api/upload/chatgpt', { method: 'POST', body: form })

      const res = await handleImportUpload(req, {
        resolveInstanceContext: async () => ({
          owner_home,
          uid: process.getuid?.() ?? 0,
          gid: process.getgid?.() ?? 0,
          project_slug: 'test-owner',
          topic_id: 'chat',
          channel_kind: 'app_socket',
          user_id: 'test-user',
        }),
        engine,
      })

      expect(res.status).toBe(200)
      const body = (await res.json()) as Record<string, unknown>
      expect(body['ok']).toBe(true)
      // Sniffer re-routed the /chatgpt POST to the real Claude source.
      expect(body['source']).toBe('claude')
      // THE FIX: not the old silent no-op. A real job started (job_id present).
      expect(body['outcome']).not.toBe('no_active_prompt')
      expect(typeof body['job_id']).toBe('string')
      expect((body['job_id'] as string).length).toBeGreaterThan(0)

      // The staged file on disk is the real ~14MB export.
      const dest = join(owner_home, 'imports', 'claude.zip')
      expect(statSync(dest).isFile()).toBe(true)
      expect(statSync(dest).size).toBe(bytes.byteLength)
      expect(bytes.byteLength).toBeGreaterThan(3_000_000)

      // The engine kicked the runner with the real claude-zip source + payload.
      expect(runnerCalls.length).toBe(1)
      expect(runnerCalls[0]?.source).toBe('claude-zip')

      // The runner received the REAL export bytes — parsing them yields the
      // real conversation history (a heavy user has many conversations). This
      // is the ingestion that was silently dropped pre-fix.
      const payload = runnerCalls[0]?.payload
      expect(Buffer.isBuffer(payload)).toBe(true)
      let convoCount = 0
      let sawRealMessage = false
      for await (const record of parseClaudeExport(payload as Buffer)) {
        convoCount += 1
        if (!sawRealMessage && record.messages.some((m) => (m.text ?? '').trim().length > 0)) {
          sawRealMessage = true
        }
      }
      expect(convoCount).toBeGreaterThan(20)
      expect(sawRealMessage).toBe(true)

      // The state machine advanced into import_running with a real job_id —
      // `in_flight_imports` is now > 0 (vs. the pre-fix "0 forever").
      const state = await stateStore.get('test-owner', 'test-user')
      expect(state?.phase).toBe('import_running')
      expect((state?.phase_state as Record<string, unknown>)['import_job_id']).toBe('job-1')
      expect((state?.phase_state as Record<string, unknown>)['import_source']).toBe('claude-zip')

      // eslint-disable-next-line no-console
      console.info(
        `[nd2-real-export] PROVEN: real export (${(bytes.byteLength / 1_000_000).toFixed(1)}MB) ` +
          `→ ${convoCount} conversations parsed → import job=${body['job_id']} started at ` +
          `work_interview_gap_fill (was: silent no_active_prompt no-op).`,
      )
    },
  )
})
