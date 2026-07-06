/**
 * Integration tests — explicit source-switch vs late upload of the
 * ABANDONED source (ISSUES #98).
 *
 * Symptom this reproduces: a user is mid-ChatGPT-upload at
 * `import_upload_pending` and types an explicit switch ("can I do Claude
 * instead?"). The freeform reroutes to the source picker
 * (`ai_substrate_offered`), preserving `ai_substrate_used=chatgpt`
 * (non-destructive re-emit, Argus r2). The ChatGPT upload then completes
 * BEFORE the user taps Claude and lands at `ai_substrate_offered`. The
 * pre-fix late-upload-tolerance branch auto-imported the ABANDONED ChatGPT
 * source because `ai_substrate_used` still read `chatgpt` and matched the
 * upload — silently honoring the source the user was leaving.
 *
 * The fix (ISSUES #98): the reroute records `source_switch_intent` when the
 * freeform UNAMBIGUOUSLY names a DIFFERENT source than the staged one. The
 * late-upload path refuses to auto-honor an upload of the abandoned source
 * once an intent points elsewhere, surfacing the visible re-pick notice
 * instead. A bare clarification (no source token) records NO intent, so the
 * legitimate concurrent-upload auto-honor (Argus r1) is preserved.
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
  tmp = mkdtempSync(join(tmpdir(), 'neutron-source-switch-race-'))
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

// K11a3: the `detectImportSourceMention` — deterministic source-token
// detector` unit-test describe block moved verbatim to
// `./import-source-copy.test.ts` beside the new leaf module
// (`../import-source-copy.ts`). This file keeps the engine-driven
// integration half below.

// K11a6: re-anchor this race pin on notifyImportUpload + stateStore before
// K11b1.
describe('ISSUES #98 — explicit switch must not auto-import the abandoned source', () => {
  /** THE core reproduce: mid-chatgpt-upload → explicit Claude switch →
   *  chatgpt upload lands → it must NOT auto-import chatgpt. */
  test('explicit Claude switch then late ChatGPT upload does NOT auto-import chatgpt', async () => {
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

    // Types an explicit switch to Claude → reroute records switch-intent.
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
    sentPrompts.length = 0

    // The abandoned ChatGPT upload completes AFTER the switch but BEFORE a tap.
    const out = await engine.notifyImportUpload({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      source: 'chatgpt',
      observed_at: NOW_MS + 2_000,
    })

    // It must NOT be auto-imported.
    expect(out.outcome).toBe('no_active_prompt')
    expect(stack.startedSources).toEqual([])
    // The phase did not advance to import_running.
    const after = await stateStore.get(OWNER, USER)
    expect(after?.phase).toBe('ai_substrate_offered')
    // A visible re-pick notice was surfaced (not a silent drop).
    const texts = sentPrompts.map((p) => p.prompt.body)
    expect(texts.some((b) => /switching services/i.test(b))).toBe(true)
  })

  /** Argus r1 regression guard: a BARE clarification (no source token) records
   *  no switch-intent, so a matching late upload IS still auto-honored — the
   *  concurrent-upload race fix must survive ISSUES #98. */
  test('bare clarification then matching late upload still auto-imports (Argus r1 preserved)', async () => {
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

  /** If the user switches AND then their NEW source's upload lands, it is also
   *  not auto-run without a fresh tap (the staged `ai_substrate_used` still
   *  points at the old source), and is surfaced rather than dropped. */
  test('explicit switch then late NEW-source upload is surfaced, not auto-run', async () => {
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
      freeform_text: 'switch to claude',
      observed_at: NOW_MS + 1_000,
    })

    const out = await engine.notifyImportUpload({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      source: 'claude',
      observed_at: NOW_MS + 2_000,
    })

    expect(out.outcome).toBe('no_active_prompt')
    expect(stack.startedSources).toEqual([])
  })

  /** A real source tap CLEARS the recorded intent: after tapping Claude, a
   *  Claude upload is honored normally. */
  test('tapping the new source clears switch-intent so its upload is honored', async () => {
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

  /** Argus r1b IMPORTANT — negation-blind detector regression guard. Mid
   *  Claude-upload, typing a NEGATED mention of the other source ("I don't
   *  have a GPT export") must NOT record a switch-intent, so the user's own
   *  legitimate Claude upload is still honored — not falsely refused. */
  test('negated other-source mention does NOT refuse the in-flight upload', async () => {
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

  /** Argus r1b MINOR — stale intent cleared on a freeform "undo" at
   *  ai_substrate_offered. After an explicit Claude switch, a restated
   *  "no, keep chatgpt" must clear the stale source_switch_intent so the
   *  in-flight ChatGPT upload is honored rather than refused. */
  test('restated "keep chatgpt" at picker clears stale intent so its upload runs', async () => {
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
