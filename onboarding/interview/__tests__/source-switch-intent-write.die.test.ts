// DIES WITH K11b1 — pins the freeform source-switch intent write/clear path
// (reEmitImportSourceSelection / reconcileSwitchIntentFromFreeform via
// engine.advance/normalAdvance), deleted in K11b1.
//
// K11a6 split (2026-07-06): the RETAINED late-upload arbitration half of these
// ISSUES #98 tests re-anchored onto `notifyImportUpload` + seeded state in
// `./source-switch-late-upload-race.test.ts` (survives K11b1). This file
// PRESERVES the still-live-at-HEAD WRITE/CLEAR coverage those tests also
// carried: the freeform reroute that COMPUTES + PERSISTS `source_switch_intent`
// (`reEmitImportSourceSelection` → `computeSwitchIntent`,
// engine-import-routing.ts:143/164) and the freeform reconcile that
// CLEARS/UPDATES a stale intent (`reconcileSwitchIntentFromFreeform`,
// engine-import-routing.ts:68), both invoked from the picker freeform path
// inside the dying `normalAdvance` (engine.ts:2626). These are driven through
// the REAL `engine.advance` path (NOT seeded) so a regression that made
// `computeSwitchIntent` return null, or dropped the intent from the upsert,
// FAILS here. The whole path co-deletes with the interview-engine
// conversational drive in K11b1; this file legitimately contains
// `engine.advance` until then.
//
// ---------------------------------------------------------------------------
// Original ISSUES #98 rationale (retained verbatim for the write/clear pins):
//
// A user is mid-ChatGPT-upload at `import_upload_pending` and types an explicit
// switch ("can I do Claude instead?"). The freeform reroutes to the source
// picker (`ai_substrate_offered`), preserving `ai_substrate_used=chatgpt`
// (non-destructive re-emit, Argus r2), and records `source_switch_intent` when
// the freeform UNAMBIGUOUSLY names a DIFFERENT source than the staged one. A
// bare clarification (no source token) records NO intent; a real source tap or
// a restated "keep chatgpt" CLEARS a stale intent.

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
import type { LlmRouter, RouterDecision } from '../llm-router.ts'
import type { PlatformAdapter, PlatformInstanceInfo } from '../../../runtime/platform-adapter.ts'
import type { OnboardingPhase } from '../phase.ts'
import {
  stubRouter as sharedStubRouter,
  stubPlatform as sharedStubPlatform,
  type RouterCall,
} from '@neutronai/onboarding/interview/__tests__/interview-testkit.ts'

const OWNER = 't1'
const TOPIC = 'topic-1'
const USER = 'u-1'
const SELF: PlatformInstanceInfo = {
  internal_handle: 'h1',
  url_slug: OWNER,
  owner_home: '/tmp/x',
  agent_name: null,
  tier: 'open',
  kind: 'user',
}

function stubRouter(answers: Iterable<RouterDecision>): {
  router: LlmRouter
  calls: RouterCall[]
} {
  return sharedStubRouter(answers)
}

function stubPlatform(conversational: 'all' | ReadonlyArray<OnboardingPhase>): PlatformAdapter {
  return sharedStubPlatform(conversational, SELF)
}

let tmp: string
let db: ProjectDb
let buttonStore: ButtonStore
let stateStore: InMemoryOnboardingStateStore
let transcript: TranscriptWriter
let sentPrompts: Array<{ project_slug: string; topic_id: string; prompt: ButtonPrompt }>

function buildEngine(opts: {
  router?: LlmRouter
  platform?: PlatformAdapter
  importJobRunner?: ImportJobRunnerHook
  importPayloadResolver?: ImportPayloadResolver
}): InterviewEngine {
  const deps: ConstructorParameters<typeof InterviewEngine>[0] = {
    buttonStore,
    stateStore,
    transcript,
    sendButtonPrompt: async (input) => {
      sentPrompts.push(input)
      return { message_id: `msg-${sentPrompts.length}`, was_new: true }
    },
  }
  if (opts.router !== undefined) deps.llmRouter = opts.router
  if (opts.platform !== undefined) deps.platform = opts.platform
  if (opts.importJobRunner !== undefined) deps.importJobRunner = opts.importJobRunner
  if (opts.importPayloadResolver !== undefined)
    deps.importPayloadResolver = opts.importPayloadResolver
  return new InterviewEngine(deps)
}

/** A runner + resolver that record the sources they're asked to import, so
 *  a test can assert the staged source was (or was NOT) actually imported. */
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
    status: async (): Promise<ImportJob | null> => null,
    cancel: async () => undefined,
    synthesizeOnDemand: async () => null,
  }
  const importPayloadResolver: ImportPayloadResolver = {
    // `ChunkerInput` is `Buffer | OAuthRefs`; a non-null payload routes the
    // engine into the import-running path (a null would re-emit "I don't see
    // your export yet"). An empty buffer suffices — the stub runner ignores it.
    resolve: async () => Buffer.from(''),
  }
  return { importJobRunner, importPayloadResolver, startedSources }
}

const NOW_MS = Date.now()

async function startAndReachPhase(
  engine: InterviewEngine,
  phase: OnboardingPhase,
  phase_state_patch: Record<string, unknown> = {},
): Promise<string> {
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
  await engine.advance({
    project_slug: OWNER,
    topic_id: TOPIC,
    user_id: USER,
    channel_kind: 'app-socket',
    observed_at: NOW_MS,
  })
  const next = await stateStore.get(OWNER, USER)
  expect(next?.phase).toBe(phase)
  const ap = next?.phase_state['active_prompt_id']
  expect(typeof ap).toBe('string')
  sentPrompts.length = 0
  return ap as string
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-source-switch-intent-write-'))
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

describe('ISSUES #98 — freeform source-switch intent WRITE/CLEAR (DIES with K11b1)', () => {
  /** WRITE: an explicit switch reroute COMPUTES + PERSISTS
   *  `source_switch_intent=claude` while non-destructively preserving the
   *  staged `ai_substrate_used=chatgpt`. */
  test('explicit Claude switch reroute records source_switch_intent=claude (write path)', async () => {
    const { router } = stubRouter([])
    const stack = stubImportStack()
    const engine = buildEngine({
      router,
      platform: stubPlatform('all'),
      ...stack,
    })

    // User tapped ChatGPT, is mid-upload at import_upload_pending.
    await startAndReachPhase(engine, 'import_upload_pending', {
      ai_substrate_used: 'chatgpt',
    })

    // Types an explicit switch to Claude → reroute computes + records intent.
    await engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      freeform_text: 'can I do claude instead?',
      observed_at: NOW_MS + 1_000,
    })
    const rerouted = await stateStore.get(OWNER, USER)
    expect(rerouted?.phase).toBe('ai_substrate_offered')
    expect(rerouted?.phase_state['source_switch_intent']).toBe('claude')
    // Non-destructive: the staged source is still on record.
    expect(rerouted?.phase_state['ai_substrate_used']).toBe('chatgpt')

    // End-to-end (with the real write): the abandoned ChatGPT upload landing
    // after the switch is NOT auto-imported.
    sentPrompts.length = 0
    const out = await engine.notifyImportUpload({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      source: 'chatgpt',
      observed_at: NOW_MS + 2_000,
    })
    expect(out.outcome).toBe('no_active_prompt')
    expect(stack.startedSources).toEqual([])
    const texts = sentPrompts.map((p) => p.prompt.body)
    expect(texts.some((b) => /switching services/i.test(b))).toBe(true)
  })

  /** NO-WRITE: a BARE clarification (no source token) records NO intent, so a
   *  matching late upload IS still auto-honored (Argus r1 preserved). */
  test('bare clarification records NO switch-intent (write path negative)', async () => {
    const { router } = stubRouter([])
    const stack = stubImportStack()
    const engine = buildEngine({
      router,
      platform: stubPlatform('all'),
      ...stack,
    })

    await startAndReachPhase(engine, 'import_upload_pending', {
      ai_substrate_used: 'chatgpt',
    })

    // A non-switch clarification — reroutes but records NO intent.
    await engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      freeform_text: 'is it done?',
      observed_at: NOW_MS + 1_000,
    })
    const rerouted = await stateStore.get(OWNER, USER)
    expect(rerouted?.phase).toBe('ai_substrate_offered')
    expect(rerouted?.phase_state['source_switch_intent'] ?? null).toBeNull()

    // The user's own ChatGPT upload lands → honored, not orphaned.
    const out = await engine.notifyImportUpload({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      source: 'chatgpt',
      observed_at: NOW_MS + 2_000,
    })
    expect(out.outcome).not.toBe('no_active_prompt')
    expect(stack.startedSources).toEqual(['chatgpt-zip'])
    expect(out.state?.phase).toBe('import_running')
  })

  /** CLEAR (tap): a real source tap CLEARS the recorded intent + sets
   *  ai_substrate_used=claude, parking back at import_upload_pending. */
  test('tapping the new source clears switch-intent (clear path via tap)', async () => {
    const { router } = stubRouter([])
    const stack = stubImportStack()
    const engine = buildEngine({
      router,
      platform: stubPlatform('all'),
      ...stack,
    })

    await startAndReachPhase(engine, 'import_upload_pending', {
      ai_substrate_used: 'chatgpt',
    })
    await engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      freeform_text: 'can I do claude instead?',
      observed_at: NOW_MS + 1_000,
    })
    const picker = (await stateStore.get(OWNER, USER))?.phase_state[
      'active_prompt_id'
    ] as string

    // Tap Claude — resolves the intent + sets ai_substrate_used=claude.
    await engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      choice: {
        prompt_id: picker,
        choice_value: 'claude',
        chosen_at: NOW_MS + 2_000,
        speaker_user_id: USER,
        channel_kind: 'app-socket',
      },
      observed_at: NOW_MS + 2_000,
    })
    const tapped = await stateStore.get(OWNER, USER)
    expect(tapped?.phase).toBe('import_upload_pending')
    expect(tapped?.phase_state['ai_substrate_used']).toBe('claude')
    expect(tapped?.phase_state['source_switch_intent'] ?? null).toBeNull()

    // Now the Claude upload lands → honored.
    const out = await engine.notifyImportUpload({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      source: 'claude',
      observed_at: NOW_MS + 3_000,
    })
    expect(out.outcome).not.toBe('no_active_prompt')
    expect(stack.startedSources).toEqual(['claude-zip'])
    expect(out.state?.phase).toBe('import_running')
  })

  /** NO-WRITE (negation): a NEGATED mention of the other source ("I don't have
   *  a GPT export") mid Claude-upload records NO intent — negation-blind
   *  detector regression guard. */
  test('negated other-source mention records NO switch-intent (write path negation guard)', async () => {
    const { router } = stubRouter([])
    const stack = stubImportStack()
    const engine = buildEngine({
      router,
      platform: stubPlatform('all'),
      ...stack,
    })

    // User tapped Claude, is mid-upload at import_upload_pending.
    await startAndReachPhase(engine, 'import_upload_pending', {
      ai_substrate_used: 'claude',
    })

    // Types an incidental, NEGATED mention of ChatGPT — not a switch.
    await engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      freeform_text: "I don't have a GPT export",
      observed_at: NOW_MS + 1_000,
    })
    const rerouted = await stateStore.get(OWNER, USER)
    expect(rerouted?.phase).toBe('ai_substrate_offered')
    // No switch-intent recorded — the mention was negated.
    expect(rerouted?.phase_state['source_switch_intent'] ?? null).toBeNull()

    // The user's own Claude upload lands → honored, NOT refused.
    const out = await engine.notifyImportUpload({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      source: 'claude',
      observed_at: NOW_MS + 2_000,
    })
    expect(out.outcome).not.toBe('no_active_prompt')
    expect(stack.startedSources).toEqual(['claude-zip'])
    expect(out.state?.phase).toBe('import_running')
  })

  /** CLEAR (reconcile): after an explicit Claude switch, a restated "no, keep
   *  chatgpt" reconciles the stale `source_switch_intent` back to the staged
   *  source (cleared) via `reconcileSwitchIntentFromFreeform`. */
  test('restated "keep chatgpt" at picker clears stale intent (clear path via reconcile)', async () => {
    const { router } = stubRouter([])
    const stack = stubImportStack()
    const engine = buildEngine({
      router,
      platform: stubPlatform('all'),
      ...stack,
    })

    await startAndReachPhase(engine, 'import_upload_pending', {
      ai_substrate_used: 'chatgpt',
    })

    // Explicit switch → reroute records source_switch_intent=claude.
    await engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      freeform_text: 'can I do claude instead?',
      observed_at: NOW_MS + 1_000,
    })
    expect(
      (await stateStore.get(OWNER, USER))?.phase_state['source_switch_intent'],
    ).toBe('claude')

    // The user changes their mind via freeform (not a button tap).
    await engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      freeform_text: 'no, keep chatgpt',
      observed_at: NOW_MS + 1_500,
    })
    const reconciled = await stateStore.get(OWNER, USER)
    expect(reconciled?.phase).toBe('ai_substrate_offered')
    // Intent reconciled back to the staged source → cleared.
    expect(reconciled?.phase_state['source_switch_intent'] ?? null).toBeNull()
    expect(reconciled?.phase_state['ai_substrate_used']).toBe('chatgpt')

    // The in-flight ChatGPT upload lands → honored, not refused.
    const out = await engine.notifyImportUpload({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      source: 'chatgpt',
      observed_at: NOW_MS + 2_000,
    })
    expect(out.outcome).not.toBe('no_active_prompt')
    expect(stack.startedSources).toEqual(['chatgpt-zip'])
    expect(out.state?.phase).toBe('import_running')
  })
})
