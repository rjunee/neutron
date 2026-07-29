/**
 * ND2 (dogfood 2026-06-27) — a SOLICITED history-import upload that lands at a
 * Path-1 conversational onboarding phase MUST start an import job, not silently
 * no-op behind a 200-OK.
 *
 * Symptom this reproduces: in live Path-1 (open-mode, onboarding-as-CC-session)
 * the InterviewEngine sits at a conversational phase (observed
 * `work_interview_gap_fill`, `import_job_id=NULL`) while the live-agent
 * onboarding seam shows the 📎 zip-import affordance on every turn. Pre-fix
 * `notifyImportUpload` only started a job at the legacy `import_upload_pending`
 * (or recovered from `ai_substrate_offered`) phase; for any other phase it fell
 * through to `{ outcome: 'no_active_prompt' }` (HTTP 200, NO job). So every
 * solicited upload during the conversational interview was orphaned —
 * `import_jobs` empty, `in_flight_imports=0` forever — behind a false "reading
 * your history now" banner.
 *
 * The fix: in OPEN mode with `importJobRunner` wired (the EXACT condition under
 * which the live-agent seam offers the upload affordance — see
 * `LiveAgentOnboardingSeam.uploadAffordance()`, non-null iff `importSubstrate`
 * exists), a non-import-phase upload with no job already running is treated as
 * SOLICITED and routed through `startImportAndAdvanceToRunning`. A stray /
 * unsolicited upload still no-ops: managed mode, runner unwired, terminal
 * onboarding, or a job already in flight.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { ButtonStore } from '@neutronai/channels/button-store.ts'
import type { ButtonPrompt } from '@neutronai/channels/button-primitive.ts'
import {
  InterviewEngine,
  type ImportJobRunnerHook,
  type ImportPayloadResolver,
} from '../engine.ts'
import type { ImportJob } from '../../history-import/types.ts'
import { InMemoryOnboardingStateStore, type OnboardingStateStore } from '../state-store.ts'
import { TranscriptWriter } from '../transcript.ts'
import type { OnboardingDeploymentMode, OnboardingPhase } from '../phase.ts'

const OWNER = 't1'
const TOPIC = 'topic-1'
const USER = 'u-1'
const NOW_MS = Date.now()

let tmp: string
let db: ProjectDb
let buttonStore: ButtonStore
let stateStore: InMemoryOnboardingStateStore
let transcript: TranscriptWriter
let sentPrompts: Array<{ owner_slug: string; topic_id: string; prompt: ButtonPrompt }>

/** A runner + resolver that record the sources they're asked to import, so a
 *  test can assert an import was (or was NOT) actually started. */
function stubImportStack(): {
  importJobRunner: ImportJobRunnerHook
  importPayloadResolver: ImportPayloadResolver
  startedSources: string[]
} {
  const startedSources: string[] = []
  let jobSeq = 0
  const importJobRunner: ImportJobRunnerHook = {
    start: async (input) => {
      startedSources.push(input.source)
      jobSeq += 1
      return { job_id: `job-${jobSeq}` }
    },
    // Returning a still-running job keeps the engine in `import_running` after
    // the kickoff poll (no synthetic completion) so the test can assert the
    // job was started + the phase advanced.
    status: async (): Promise<ImportJob | null> => null,
    cancel: async () => undefined,
    synthesizeOnDemand: async () => null,
  }
  const importPayloadResolver: ImportPayloadResolver = {
    // A non-null payload routes the engine into the import-running path.
    resolve: async () => Buffer.from(''),
  }
  return { importJobRunner, importPayloadResolver, startedSources }
}

function buildEngine(opts: {
  deploymentMode: OnboardingDeploymentMode
  /** Mirrors build-landing-stack's `importSubstrate !== undefined` — the live
   *  Path-1 upload affordance is offered iff this is true. */
  importAffordanceOffered?: boolean
  importJobRunner?: ImportJobRunnerHook
  importPayloadResolver?: ImportPayloadResolver
}): InterviewEngine {
  const deps: ConstructorParameters<typeof InterviewEngine>[0] = {
    buttonStore,
    stateStore,
    transcript,
    deploymentMode: opts.deploymentMode,
    sendButtonPrompt: async (input) => {
      sentPrompts.push(input)
      return { message_id: `msg-${sentPrompts.length}`, was_new: true }
    },
  }
  if (opts.importAffordanceOffered !== undefined)
    deps.importAffordanceOffered = opts.importAffordanceOffered
  if (opts.importJobRunner !== undefined) deps.importJobRunner = opts.importJobRunner
  if (opts.importPayloadResolver !== undefined) deps.importPayloadResolver = opts.importPayloadResolver
  return new InterviewEngine(deps)
}

/** Seed onboarding state directly at `phase` (no LLM/router drive needed —
 *  `notifyImportUpload` reads state, not a live turn). */
async function seedPhase(
  phase: OnboardingPhase,
  phase_state_patch: Record<string, unknown> = {},
): Promise<void> {
  await stateStore.upsert({
    user_id: USER,
    owner_slug: OWNER,
    phase,
    phase_state_patch: {
      topic_id: TOPIC,
      user_id: USER,
      signup_via: 'web',
      ...phase_state_patch,
    },
    advanced_at: NOW_MS,
  })
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-path1-solicited-upload-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
  buttonStore = new ButtonStore({ db })
  stateStore = new InMemoryOnboardingStateStore()
  transcript = new TranscriptWriter({
    path: join(tmp, 'persona', 'onboarding-transcript.jsonl'),
  })
  sentPrompts = []
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

describe('ND2 — solicited Path-1 upload at a conversational phase starts a job', () => {
  test('open mode, work_interview_gap_fill: upload STARTS an import (not no_active_prompt)', async () => {
    const stack = stubImportStack()
    const engine = buildEngine({ deploymentMode: 'open', importAffordanceOffered: true, ...stack })

    // Live Path-1: the engine sits at a conversational phase with NO import job.
    await seedPhase('work_interview_gap_fill')

    const out = await engine.notifyImportUpload({
      owner_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app_socket',
      source: 'claude',
      observed_at: NOW_MS + 1_000,
    })

    // A real import job was started for the uploaded (sniffed) source.
    expect(stack.startedSources).toEqual(['claude-zip'])
    expect(out.outcome).not.toBe('no_active_prompt')

    // The engine advanced to import_running with a real job_id stamped.
    const next = await stateStore.get(OWNER, USER)
    expect(next?.phase).toBe('import_running')
    expect(next?.phase_state['import_job_id']).toBe('job-1')
    expect(next?.phase_state['import_source']).toBe('claude-zip')
  })

  test('open mode, NO onboarding_state row yet (#130 race): upload SEEDS the row + STARTS the import', async () => {
    // THE #130 BUG. The open-mode live-agent onboarding never calls
    // the engine `start` drive; the onboarding_state row is created lazily + async by
    // the fire-and-forget post-turn extractor. #130 moved the import offer to
    // right after the name, so a fresh-install owner uploads BEFORE the
    // background extractor has created the row → `notifyImportUpload` reads
    // state===null. Pre-fix this returned `noop_no_state` (job_id:null →
    // "Couldn't start the import"). NO `seedPhase` here — that is exactly the
    // precondition the live flow never creates, so we drive it for real.
    const stack = stubImportStack()
    const engine = buildEngine({ deploymentMode: 'open', importAffordanceOffered: true, ...stack })

    expect(await stateStore.get(OWNER, USER)).toBeNull()

    const out = await engine.notifyImportUpload({
      owner_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app_socket',
      source: 'claude',
      observed_at: NOW_MS + 1_000,
    })

    // The fix: a solicited no-state upload starts a real job (NOT the old
    // silent no-op).
    expect(out.outcome).not.toBe('no_active_prompt')
    expect(out.outcome).not.toBe('noop_no_state')
    expect(stack.startedSources).toEqual(['claude-zip'])

    // The engine SEEDED the row + advanced it to import_running with the real
    // job_id and the `signup_via` the import-running cron's channel-context
    // invariant needs (stamped because open Path-1 has no engine.start).
    const next = await stateStore.get(OWNER, USER)
    expect(next?.phase).toBe('import_running')
    expect(next?.phase_state['import_job_id']).toBe('job-1')
    expect(next?.phase_state['import_source']).toBe('claude-zip')
    expect(next?.phase_state['signup_via']).toBe('web')
  })

  test('open mode, NO row but affordance NOT offered → still no-op (stray upload, no row created)', async () => {
    // The no-state mirror of the affordance-off guard: a stray upload when no
    // substrate exists (affordance hidden) must NOT seed a row or start a job.
    const stack = stubImportStack()
    const engine = buildEngine({ deploymentMode: 'open', importAffordanceOffered: false, ...stack })

    expect(await stateStore.get(OWNER, USER)).toBeNull()

    const out = await engine.notifyImportUpload({
      owner_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app_socket',
      source: 'claude',
      observed_at: NOW_MS + 1_000,
    })

    expect(out.outcome).toBe('noop_no_state')
    expect(stack.startedSources).toEqual([])
    // No row was manufactured for an unsolicited upload.
    expect(await stateStore.get(OWNER, USER)).toBeNull()
  })

  test('managed mode, NO row → no-op (never seeds a row outside open Path-1)', async () => {
    const stack = stubImportStack()
    const engine = buildEngine({ deploymentMode: 'managed', importAffordanceOffered: true, ...stack })

    const out = await engine.notifyImportUpload({
      owner_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app_socket',
      source: 'claude',
      observed_at: NOW_MS + 1_000,
    })

    expect(out.outcome).toBe('noop_no_state')
    expect(stack.startedSources).toEqual([])
    expect(await stateStore.get(OWNER, USER)).toBeNull()
  })

  test('open mode honors the SNIFFED source (chatgpt affordance, claude zip)', async () => {
    const stack = stubImportStack()
    const engine = buildEngine({ deploymentMode: 'open', importAffordanceOffered: true, ...stack })
    await seedPhase('work_interview_gap_fill')

    // The web affordance hardcodes source=chatgpt; the handler sniffs the real
    // source from the zip and passes it here. The started runner source must be
    // the SNIFFED one.
    await engine.notifyImportUpload({
      owner_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app_socket',
      source: 'claude',
      observed_at: NOW_MS + 1_000,
    })
    expect(stack.startedSources).toEqual(['claude-zip'])
  })

  test('managed mode at a conversational phase still no-ops (not a blanket any-phase import)', async () => {
    const stack = stubImportStack()
    // Even with the affordance flag set, the open-mode guard blocks managed.
    const engine = buildEngine({ deploymentMode: 'managed', importAffordanceOffered: true, ...stack })
    await seedPhase('work_interview_gap_fill')

    const out = await engine.notifyImportUpload({
      owner_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app_socket',
      source: 'claude',
      observed_at: NOW_MS + 1_000,
    })

    // Managed mode only offers the affordance at the legacy phases → a sideways
    // upload here is NOT solicited and must not start a job.
    expect(out.outcome).toBe('no_active_prompt')
    expect(stack.startedSources).toEqual([])
    const next = await stateStore.get(OWNER, USER)
    expect(next?.phase).toBe('work_interview_gap_fill')
  })

  test('open mode, runner WIRED but affordance NOT offered (no substrate) → no-op (Codex PR #94)', async () => {
    // The exact case Codex flagged: in Open, build-landing-stack ALWAYS wires a
    // synthesis importJobRunner (over `importSubstrate ?? null`), so the runner
    // is present even when no substrate exists and the affordance is HIDDEN
    // (`uploadAffordance()` → null). Keying on runner-presence would (wrongly)
    // start + fail a job for a stray upload. Keying on `importAffordanceOffered`
    // (false here) correctly no-ops.
    const stack = stubImportStack()
    const engine = buildEngine({ deploymentMode: 'open', importAffordanceOffered: false, ...stack })
    await seedPhase('work_interview_gap_fill')

    const out = await engine.notifyImportUpload({
      owner_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app_socket',
      source: 'claude',
      observed_at: NOW_MS + 1_000,
    })
    expect(out.outcome).toBe('no_active_prompt')
    expect(stack.startedSources).toEqual([])
    const next = await stateStore.get(OWNER, USER)
    expect(next?.phase).toBe('work_interview_gap_fill')
  })

  test('open mode but a job is already in flight → no duplicate job', async () => {
    const stack = stubImportStack()
    const engine = buildEngine({ deploymentMode: 'open', importAffordanceOffered: true, ...stack })
    // A conversational phase that already carries an import_job_id (a prior
    // upload started a job). A second upload must NOT spawn a duplicate.
    await seedPhase('work_interview_gap_fill', { import_job_id: 'pre-existing-job' })

    const out = await engine.notifyImportUpload({
      owner_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app_socket',
      source: 'claude',
      observed_at: NOW_MS + 1_000,
    })
    expect(out.outcome).toBe('no_active_prompt')
    expect(stack.startedSources).toEqual([])
  })

  test('terminal onboarding upload no-ops (noop_terminal), never reaching the solicited path', async () => {
    const stack = stubImportStack()
    const engine = buildEngine({ deploymentMode: 'open', importAffordanceOffered: true, ...stack })
    await seedPhase('completed')

    const out = await engine.notifyImportUpload({
      owner_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app_socket',
      source: 'claude',
      observed_at: NOW_MS + 1_000,
    })
    expect(out.outcome).toBe('noop_terminal')
    expect(stack.startedSources).toEqual([])
  })

  test('no-state, sequential double-submit → only ONE job (the 2nd takes the non-null guarded path)', async () => {
    const stack = stubImportStack()
    const engine = buildEngine({ deploymentMode: 'open', importAffordanceOffered: true, ...stack })

    const first = await engine.notifyImportUpload({
      owner_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app_socket',
      source: 'claude',
      observed_at: NOW_MS + 1_000,
    })
    expect(first.outcome).not.toBe('noop_no_state')

    // Same fresh-install user re-submits (client retry). The row now exists at
    // import_running with a job, so this hits the non-null `alreadyHasImportJob`
    // guard — no duplicate job.
    const second = await engine.notifyImportUpload({
      owner_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app_socket',
      source: 'claude',
      observed_at: NOW_MS + 2_000,
    })
    expect(second.outcome).toBe('no_active_prompt')
    expect(stack.startedSources).toEqual(['claude-zip']) // exactly one job
  })

  test('no-state, a concurrent upload lands a job between the two reads → recheck re-enters the guarded path (no duplicate, no downgrade)', async () => {
    // Codex r1 P2: simulate the truly-concurrent window. A get()-hooked store
    // returns null on the engine's FIRST read (state===null branch entered), but
    // a concurrent fresh-install upload lands an `import_running` row + job in
    // that instant — so the engine's RE-READ inside the open-mode branch sees a
    // live import. The fix re-enters the normal flow, which `alreadyHasImportJob`
    // guards: NO duplicate job started, and the live `import_running` is NOT
    // downgraded by our work_interview_gap_fill seed.
    const stack = stubImportStack()
    let firstGetDone = false
    const hooked: OnboardingStateStore = {
      get: async (p, u) => {
        if (!firstGetDone) {
          firstGetDone = true
          // The engine's initial read observes no row...
          return null
        }
        // ...but by the recheck, a concurrent upload has landed a job.
        return stateStore.get(p, u)
      },
      upsert: (i) => stateStore.upsert(i),
      patchPhaseState: (owner, user, patch) => stateStore.patchPhaseState(owner, user, patch),
      rekey: (a, b, c) => stateStore.rekey(a, b, c),
      delete: (p, u) => stateStore.delete(p, u),
      deleteByOwner: (p) => stateStore.deleteByOwner(p),
      completeIfPhaseStateMatches: (i) => stateStore.completeIfPhaseStateMatches(i),
    }
    const engine = new InterviewEngine({
      buttonStore,
      stateStore: hooked,
      transcript,
      deploymentMode: 'open',
      importAffordanceOffered: true,
      sendButtonPrompt: async (input) => {
        sentPrompts.push(input)
        return { message_id: `msg-${sentPrompts.length}`, was_new: true }
      },
      ...stack,
    })

    // The "concurrent" upload's effect: a real import_running row + job already
    // in the underlying store (what the recheck will observe).
    await stateStore.upsert({
      user_id: USER,
      owner_slug: OWNER,
      phase: 'import_running',
      phase_state_patch: {
        topic_id: TOPIC,
        user_id: USER,
        signup_via: 'web',
        import_job_id: 'concurrent-job',
        import_source: 'claude-zip',
      },
      advanced_at: NOW_MS,
    })

    const out = await engine.notifyImportUpload({
      owner_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app_socket',
      source: 'claude',
      observed_at: NOW_MS + 1_000,
    })

    // Re-entered the non-null guarded path: no duplicate runner.start, and the
    // live import_running row (with the concurrent job) is preserved.
    expect(out.outcome).toBe('no_active_prompt')
    expect(stack.startedSources).toEqual([])
    const final = await stateStore.get(OWNER, USER)
    expect(final?.phase).toBe('import_running')
    expect(final?.phase_state['import_job_id']).toBe('concurrent-job')
  })

  test('no-state, TWO truly-simultaneous uploads → exactly ONE job (per-user serialization)', async () => {
    // Codex r1 P2, definitive: fire two no-state uploads for the same fresh-
    // install user concurrently. The engine's per-(project,user) serialization
    // tail runs them one at a time, so the second observes the first's
    // `import_running` row and takes the `alreadyHasImportJob` guard — never a
    // duplicate job, never a downgrade of the live import_running.
    const stack = stubImportStack()
    const engine = buildEngine({ deploymentMode: 'open', importAffordanceOffered: true, ...stack })

    expect(await stateStore.get(OWNER, USER)).toBeNull()

    const [a, b] = await Promise.all([
      engine.notifyImportUpload({
        owner_slug: OWNER,
        topic_id: TOPIC,
        user_id: USER,
        channel_kind: 'app_socket',
        source: 'claude',
        observed_at: NOW_MS + 1_000,
      }),
      engine.notifyImportUpload({
        owner_slug: OWNER,
        topic_id: TOPIC,
        user_id: USER,
        channel_kind: 'app_socket',
        source: 'claude',
        observed_at: NOW_MS + 1_001,
      }),
    ])

    // Exactly one import job started across both concurrent requests.
    expect(stack.startedSources).toEqual(['claude-zip'])
    // One request started it; the other hit the no-duplicate guard.
    const outcomes = [a.outcome, b.outcome].sort()
    expect(outcomes).toContain('no_active_prompt')

    const final = await stateStore.get(OWNER, USER)
    expect(final?.phase).toBe('import_running')
    expect(final?.phase_state['import_job_id']).toBe('job-1')
    expect(final?.phase_state['signup_via']).toBe('web')
  })
})
