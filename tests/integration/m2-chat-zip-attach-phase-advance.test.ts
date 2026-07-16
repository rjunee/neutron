/**
 * M2 chat-upload UX — engine-side phase contract for ZIP uploads
 * arriving during the onboarding import flow.
 *
 * Per docs/plans/P2-onboarding-v2.md § 3.4 advance criterion: an
 * uploaded export ZIP must transition the user out of
 * `import_upload_pending` into `import_running` without a follow-up
 * button tap. Per § 3.3 (`ai_substrate_offered`), an upload that lands
 * before the user has chosen a substrate is intentionally NOT a
 * sideways trigger — the engine returns `no_active_prompt` and the
 * caller is expected to log + surface a notice (today the landing
 * client's drag-drop is gated by `upload_affordance`, which is only
 * set on `import_upload_pending`).
 *
 * The M2 chat-upload UX brief (this sprint) wires the Expo client's
 * drag-drop / picker / paste flow to `/api/upload/<source>`, which is
 * the production caller of `engine.notifyImportUpload`. This test
 * pins the engine contract those callers depend on so a future refactor
 * doesn't silently change the phase advance shape:
 *
 *   1. user in `import_upload_pending` + ZIP arrives →
 *        outcome = 'advanced', state.phase = 'import_running'.
 *   2. user in `ai_substrate_offered` + ZIP arrives with NO recorded
 *      substrate (or one that differs from the upload) → outcome =
 *      'no_active_prompt' (engine refuses the sideways transition) BUT a
 *      visible confirm/re-pick notice is sent so the file is never silently
 *      dropped behind an ok-looking response.
 *   3. payload resolver returns null (the upload landed somewhere
 *      else, or the bytes vanished from disk between upload and the
 *      engine call) → still advances to `import_running` but with the
 *      `import_failure` failed-sub-step marker, so the user sees a
 *      visible recovery path.
 *   4. CONCURRENT-UPLOAD RACE (Argus r1 blocker): user typed freeform at
 *      `import_upload_pending` while a ZIP was still uploading → Fix 1
 *      flipped phase to `ai_substrate_offered` (non-destructive —
 *      `ai_substrate_used` preserved). When the upload finishes with a
 *      source MATCHING the retained substrate, the import MUST still start
 *      (phase → `import_running`, runner.start called) rather than orphan
 *      the staged zip behind a silent `no_active_prompt`.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { ButtonStore } from '@neutronai/channels/button-store.ts'
import {
  InterviewEngine,
  type ImportJobRunnerHook,
  type ImportPayloadResolver,
} from '@neutronai/onboarding/interview/engine.ts'
import type { ImportJob } from '@neutronai/onboarding/history-import/types.ts'
import { InMemoryOnboardingStateStore } from '@neutronai/onboarding/interview/state-store.ts'
import { TranscriptWriter } from '@neutronai/onboarding/interview/transcript.ts'

const OWNER = 'm2-chat-zip-attach'
const TOPIC = 'web:user-1'
const USER = 'user-1'

interface TestEnv {
  engine: InterviewEngine
  stateStore: InMemoryOnboardingStateStore
  sentBodies: string[]
  startCalls: number
  cleanup: () => void
}

function buildEnv(opts: {
  resolverReturnsNull?: boolean
}): TestEnv {
  const tmp = mkdtempSync(join(tmpdir(), 'm2-chat-zip-attach-'))
  const db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
  const buttonStore = new ButtonStore({ db })
  const stateStore = new InMemoryOnboardingStateStore()
  const transcript = new TranscriptWriter({
    path: join(tmp, 'persona', 'onboarding-transcript.jsonl'),
  })
  const sentBodies: string[] = []
  let startCalls = 0
  const runner: ImportJobRunnerHook = {
    start: async () => {
      startCalls += 1
      return {
        job_id: 'job-zip-attach',
      } as unknown as { job_id: string }
    },
    status: async (): Promise<ImportJob | null> => null,
    cancel: async () => undefined,
    synthesizeOnDemand: async () => null,
  }
  const resolver: ImportPayloadResolver = {
    resolve: async () => {
      if (opts.resolverReturnsNull === true) return null
      // Minimal ChunkerInput shape — the engine only needs SOMETHING
      // non-null to proceed to runner.start.
      return {
        conversations: [],
        source: 'chatgpt-zip',
      } as unknown as ReturnType<ImportPayloadResolver['resolve']> extends Promise<infer R>
        ? R
        : never
    },
  }
  const engine = new InterviewEngine({
    buttonStore,
    stateStore,
    transcript,
    sendButtonPrompt: async ({ prompt }) => {
      sentBodies.push(prompt.body)
      return { message_id: 'mid', was_new: true }
    },
    importJobRunner: runner,
    importPayloadResolver: resolver,
  })
  return {
    engine,
    stateStore,
    get sentBodies() {
      return sentBodies
    },
    get startCalls() {
      return startCalls
    },
    cleanup: () => {
      db.close()
      rmSync(tmp, { recursive: true, force: true })
    },
  }
}

let env: TestEnv

describe('M2 chat-upload UX — engine ZIP attach phase contract', () => {
  afterEach(() => {
    env?.cleanup()
  })

  beforeEach(() => {
    env = buildEnv({})
  })

  test('user in import_upload_pending + ZIP upload → advances to import_running', async () => {
    await env.stateStore.upsert({
      user_id: USER,
      owner_slug: OWNER,
      phase: 'import_upload_pending',
      phase_state_patch: { ai_substrate_used: 'chatgpt' },
      advanced_at: 1,
    })
    const result = await env.engine.notifyImportUpload({
      owner_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app_socket',
      source: 'chatgpt',
    })
    // The engine ALWAYS transitions phase out of `import_upload_pending`
    // when a ZIP lands during that phase — the outcome label may be
    // `advanced` (atomic) OR `reemitted_current` (engine re-emitted the
    // import_running status prompt on the same tick after advancing).
    // Both are valid; the contract we pin is the phase transition.
    expect(result.state).not.toBeNull()
    expect(result.state?.phase).toBe('import_running')
  })

  test('user in ai_substrate_offered + ZIP upload with NO recorded substrate → no_active_prompt + visible notice (no silent drop)', async () => {
    await env.stateStore.upsert({
      user_id: USER,
      owner_slug: OWNER,
      phase: 'ai_substrate_offered',
      phase_state_patch: {},
      advanced_at: 1,
    })
    const result = await env.engine.notifyImportUpload({
      owner_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app_socket',
      source: 'chatgpt',
    })
    expect(result.outcome).toBe('no_active_prompt')
    // Phase stays put — the engine MUST NOT transition until the user
    // explicitly answers the substrate offer.
    expect(result.state?.phase).toBe('ai_substrate_offered')
    // The import must NOT have started against an un-chosen source...
    expect(env.startCalls).toBe(0)
    // ...but the file is NOT silently dropped: a visible confirm/re-pick
    // notice went out (banned silent-no-op-that-looks-like-success).
    expect(env.sentBodies.length).toBeGreaterThan(0)
    expect(env.sentBodies.some((b) => /upload/i.test(b))).toBe(true)
  })

  test('CONCURRENT-UPLOAD RACE: freeform reroute to ai_substrate_offered, then late MATCHING upload → import STILL starts (no silent no-op)', async () => {
    // Simulate the non-destructive reroute end-state: the user picked
    // ChatGPT (so `ai_substrate_used: 'chatgpt'` is preserved), started
    // uploading, then typed freeform mid-upload — Fix 1 flipped the phase
    // to `ai_substrate_offered` while preserving the substrate. The upload
    // POST now completes and lands here.
    await env.stateStore.upsert({
      user_id: USER,
      owner_slug: OWNER,
      phase: 'ai_substrate_offered',
      phase_state_patch: { ai_substrate_used: 'chatgpt' },
      advanced_at: 1,
    })
    const result = await env.engine.notifyImportUpload({
      owner_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app_socket',
      source: 'chatgpt',
    })
    // The import MUST start — NOT a silent no_active_prompt that orphans
    // the staged zip. Phase advances to import_running and the runner fired.
    expect(result.state?.phase).toBe('import_running')
    expect(result.outcome).not.toBe('no_active_prompt')
    expect(env.startCalls).toBe(1)
  })

  test('CONCURRENT-UPLOAD RACE mismatch: late upload source differs from preserved substrate → visible notice, no stale import', async () => {
    // The user moved to a DIFFERENT source after the reroute (recorded
    // substrate is claude) but an old chatgpt upload completes. We must NOT
    // silently import the stale source — and must NOT silently drop it.
    await env.stateStore.upsert({
      user_id: USER,
      owner_slug: OWNER,
      phase: 'ai_substrate_offered',
      phase_state_patch: { ai_substrate_used: 'claude' },
      advanced_at: 1,
    })
    const result = await env.engine.notifyImportUpload({
      owner_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app_socket',
      source: 'chatgpt',
    })
    expect(result.outcome).toBe('no_active_prompt')
    expect(result.state?.phase).toBe('ai_substrate_offered')
    // The stale chatgpt upload was NOT imported...
    expect(env.startCalls).toBe(0)
    // ...but a visible notice surfaced (file acknowledged, user can re-pick).
    const notice = env.sentBodies.find((b) => /upload/i.test(b))
    expect(notice).toBeDefined()
    // COPY HONESTY (Argus r2 BLOCKER): tapping a service re-emits upload
    // instructions for the CHOSEN service and does NOT auto-run the ZIP that
    // just landed. The notice must NOT promise auto-run, and must tell the
    // user they need to upload the chosen service's export again.
    expect(notice).not.toMatch(/I will run it/i)
    expect(notice).toMatch(/again/i)
  })

  test('payload resolver returns null → still advances but surfaces failure', async () => {
    env.cleanup()
    env = buildEnv({ resolverReturnsNull: true })
    await env.stateStore.upsert({
      user_id: USER,
      owner_slug: OWNER,
      phase: 'import_upload_pending',
      phase_state_patch: { ai_substrate_used: 'chatgpt' },
      advanced_at: 1,
    })
    const result = await env.engine.notifyImportUpload({
      owner_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app_socket',
      source: 'chatgpt',
    })
    // The engine still transitions to import_running but stamps a
    // failure reason on phase_state so the user sees a recovery prompt
    // rather than a stuck import_upload_pending screen. Outcome label
    // may be `advanced` OR `reemitted_current` depending on whether the
    // failure prompt re-uses the same prompt_id.
    expect(result.state?.phase).toBe('import_running')
    expect(result.state?.phase_state).toBeDefined()
    const phase_state = result.state?.phase_state as Record<string, unknown> | undefined
    expect(phase_state?.['import_failure_reason']).toBeTruthy()
  })
})
