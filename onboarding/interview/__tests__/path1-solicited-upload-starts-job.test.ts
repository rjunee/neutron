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

import { applyMigrations } from '../../../migrations/runner.ts'
import { ProjectDb } from '../../../persistence/index.ts'
import { ButtonStore } from '../../../channels/button-store.ts'
import type { ButtonPrompt } from '../../../channels/button-primitive.ts'
import {
  InterviewEngine,
  type ImportJobRunnerHook,
  type ImportPayloadResolver,
} from '../engine.ts'
import type { ImportJob } from '../../history-import/types.ts'
import { InMemoryOnboardingStateStore } from '../state-store.ts'
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
let sentPrompts: Array<{ project_slug: string; topic_id: string; prompt: ButtonPrompt }>

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
    project_slug: OWNER,
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
    const engine = buildEngine({ deploymentMode: 'open', ...stack })

    // Live Path-1: the engine sits at a conversational phase with NO import job.
    await seedPhase('work_interview_gap_fill')

    const out = await engine.notifyImportUpload({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
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

  test('open mode honors the SNIFFED source (chatgpt affordance, claude zip)', async () => {
    const stack = stubImportStack()
    const engine = buildEngine({ deploymentMode: 'open', ...stack })
    await seedPhase('work_interview_gap_fill')

    // The web affordance hardcodes source=chatgpt; the handler sniffs the real
    // source from the zip and passes it here. The started runner source must be
    // the SNIFFED one.
    await engine.notifyImportUpload({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      source: 'claude',
      observed_at: NOW_MS + 1_000,
    })
    expect(stack.startedSources).toEqual(['claude-zip'])
  })

  test('managed mode at a conversational phase still no-ops (not a blanket any-phase import)', async () => {
    const stack = stubImportStack()
    const engine = buildEngine({ deploymentMode: 'managed', ...stack })
    await seedPhase('work_interview_gap_fill')

    const out = await engine.notifyImportUpload({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
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

  test('open mode but importJobRunner UNWIRED → no-op (affordance was never offered)', async () => {
    // No import substrate ⇒ the live-agent seam returns null from
    // uploadAffordance() ⇒ the client never shows the affordance ⇒ an upload
    // reaching here is stray.
    const engine = buildEngine({ deploymentMode: 'open' })
    await seedPhase('work_interview_gap_fill')

    const out = await engine.notifyImportUpload({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      source: 'claude',
      observed_at: NOW_MS + 1_000,
    })
    expect(out.outcome).toBe('no_active_prompt')
    const next = await stateStore.get(OWNER, USER)
    expect(next?.phase).toBe('work_interview_gap_fill')
  })

  test('open mode but a job is already in flight → no duplicate job', async () => {
    const stack = stubImportStack()
    const engine = buildEngine({ deploymentMode: 'open', ...stack })
    // A conversational phase that already carries an import_job_id (a prior
    // upload started a job). A second upload must NOT spawn a duplicate.
    await seedPhase('work_interview_gap_fill', { import_job_id: 'pre-existing-job' })

    const out = await engine.notifyImportUpload({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      source: 'claude',
      observed_at: NOW_MS + 1_000,
    })
    expect(out.outcome).toBe('no_active_prompt')
    expect(stack.startedSources).toEqual([])
  })

  test('terminal onboarding upload no-ops (noop_terminal), never reaching the solicited path', async () => {
    const stack = stubImportStack()
    const engine = buildEngine({ deploymentMode: 'open', ...stack })
    await seedPhase('completed')

    const out = await engine.notifyImportUpload({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      source: 'claude',
      observed_at: NOW_MS + 1_000,
    })
    expect(out.outcome).toBe('noop_terminal')
    expect(stack.startedSources).toEqual([])
  })
})
