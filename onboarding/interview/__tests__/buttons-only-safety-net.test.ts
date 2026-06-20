/**
 * Integration tests — buttons-only dead-end SAFETY NET
 * (sprint 2026-06-06 onboarding-buttons-only-safety-net; Sam real-signup,
 * instance t-cccccccc, v0.1.134; ISSUES #84).
 *
 * Symptom this reproduces: at a buttons-only phase, a user who types
 * freeform that doesn't resolve to an advance got ONLY the static
 * `BUTTONS_ONLY_NUDGE_TEXT` ("Tap one of the buttons above to continue…")
 * with NO buttons re-rendered. The web client dedupes by `prompt_id`, so
 * the original keyboard (scrolled away in history) never re-appears — a
 * dead-end loop with nothing to tap.
 *
 * The fix (brief § "The fix — universal safety net"): whenever the engine
 * would emit a buttons-only nudge on a phase that HAS button options, it
 * must (1) emit the brief tweak-later line THEN (2) RE-EMIT the current
 * incomplete phase prompt — full body + button options — with a FRESH
 * `prompt_id` so the client actually renders the buttons at the bottom.
 *
 * Plus (ISSUES #84, reopened 2026-06-06 import-screen-deadend sprint): at
 * `import_upload_pending`, ANY non-upload freeform — whether an explicit
 * source-switch ("actually can I do chatgpt instead?") OR a bare
 * clarification ("actually can I do chatgpt?", "go back", "wrong one",
 * "hmm") — re-emits the import-source SELECTION prompt
 * (ChatGPT/Claude/Neither buttons) so the user can re-pick. The earlier
 * verb-gated detector (`detectImportSourceSwitch`) is retired: it dead-ended
 * any phrasing without a switch VERB. The re-emit is NON-DESTRUCTIVE
 * (preserves `uploads_received` / `ai_substrate_used`), so routing ALL
 * freeform back to the picker can never lose a staged upload.
 *
 * Each assertion checks a button prompt with options>0 AND a FRESH
 * prompt_id (!= the prior active_prompt_id) is re-emitted — NOT just a
 * bare text nudge. A stale prompt_id renders nothing on the client; that
 * is THE bug.
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
import { BUTTONS_ONLY_NUDGE_TEXT } from '../interaction-mode.ts'
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
 *  a test can assert the staged source was actually imported (not dropped). */
function stubImportStack(): {
  importJobRunner: ImportJobRunnerHook
  importPayloadResolver: ImportPayloadResolver
  startedSources: string[]
} {
  const startedSources: string[] = []
  let jobSeq = 0
  const importJobRunner: ImportJobRunnerHook = {
    start: async (input: { source: string }) => {
      startedSources.push(input.source)
      jobSeq += 1
      return { job_id: `job-${jobSeq}` } as unknown as { job_id: string }
    },
    status: async (): Promise<ImportJob | null> => null,
    cancel: async () => undefined,
    synthesizeOnDemand: async () => null,
  }
  const importPayloadResolver: ImportPayloadResolver = {
    resolve: async (input: { source: string }) =>
      ({
        conversations: [],
        source: input.source,
      } as unknown as ReturnType<ImportPayloadResolver['resolve']> extends Promise<infer R>
        ? R
        : never),
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
  tmp = mkdtempSync(join(tmpdir(), 'neutron-buttons-safety-net-'))
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

/** All button prompts (options>0) re-emitted during the turn. */
function buttonPromptsSent(): ButtonPrompt[] {
  return sentPrompts.map((p) => p.prompt).filter((p) => p.options.length > 0)
}

describe('buttons-only safety net — never dead-end on "tap a button"', () => {
  // THE core reproduce (import-screen-deadend sprint, 2026-06-06): on
  // `import_upload_pending`, ANY non-upload freeform — including a bare
  // clarification with NO switch verb ("actually can I do chatgpt?",
  // "go back", "wrong one", "hmm") that the OLD verb-gated detector let
  // dead-end — must bring back the source picker (ChatGPT/Claude/Neither),
  // never the bare buttons-only nudge / upload-pending re-emit.
  test.each([
    'actually can I do chatgpt?',
    'go back',
    'wrong one',
    'hmm',
    'ok',
    'what does this mean',
  ])('import_upload_pending: non-upload freeform %p re-emits the source picker', async (text) => {
    const { router, calls } = stubRouter([])
    const engine = buildEngine({ router, platform: stubPlatform('all') })
    const original = await startAndReachPhase(engine, 'import_upload_pending', {
      ai_substrate_used: 'claude',
    })

    const out = await engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      freeform_text: text,
      observed_at: NOW_MS + 1_000,
    })

    expect(out.outcome).toBe('reemitted_current')
    // (a) the engine parked on the SELECTION phase (not stuck on upload-pending)
    const state = await stateStore.get(OWNER, USER)
    expect(state?.phase).toBe('ai_substrate_offered')
    // (b) the 3-option source picker was re-emitted with a FRESH prompt_id
    const buttons = buttonPromptsSent()
    expect(buttons.length).toBeGreaterThan(0)
    const picker = buttons[buttons.length - 1]!
    expect(picker.options.map((o) => o.value).sort()).toEqual(['chatgpt', 'claude', 'neither'])
    expect(picker.prompt_id).not.toBe(original)
    expect(state?.phase_state['active_prompt_id']).toBe(picker.prompt_id)
    expect(out.prompt_id).toBe(picker.prompt_id)
    // (c) router never consulted (buttons-only path)
    expect(calls.length).toBe(0)
  })

  // ISSUES #84 — an explicit source-switch verb still works (regression guard).
  test('import_upload_pending: source-switch "chatgpt instead" re-emits source-selection buttons', async () => {
    const { router, calls } = stubRouter([])
    const engine = buildEngine({ router, platform: stubPlatform('all') })
    const original = await startAndReachPhase(engine, 'import_upload_pending', {
      ai_substrate_used: 'claude',
    })

    const out = await engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      freeform_text: 'actually can I do chatgpt instead?',
      observed_at: NOW_MS + 1_000,
    })

    const state = await stateStore.get(OWNER, USER)
    expect(out.outcome).toBe('reemitted_current')
    // (a) the import-source SELECTION buttons were re-emitted, fresh id
    const buttons = buttonPromptsSent()
    expect(buttons.length).toBeGreaterThan(0)
    const picker = buttons[buttons.length - 1]!
    const values = picker.options.map((o) => o.value).sort()
    expect(values).toEqual(['chatgpt', 'claude', 'neither'])
    expect(picker.prompt_id).not.toBe(original)
    // (b) the engine parked on the selection phase so a tap re-picks the source
    expect(state?.phase).toBe('ai_substrate_offered')
    expect(state?.phase_state['active_prompt_id']).toBe(picker.prompt_id)
    // (c) router never consulted (buttons-only path, deterministic re-emit)
    expect(calls.length).toBe(0)
  })

  // Argus r2 BLOCKER (2026-06-06) — the source-switch re-emit must be
  // NON-DESTRUCTIVE: it parks on the selection phase WITHOUT clearing the
  // prior `ai_substrate_used`, so a detector false positive cannot strand
  // the user (worst case is a harmless re-display). The reset is deferred
  // to the consume handler and only fires on a real re-pick (tap).
  test('import_upload_pending: source-switch re-emit is non-destructive (prior source retained until re-pick)', async () => {
    const { router } = stubRouter([])
    const engine = buildEngine({ router, platform: stubPlatform('all') })
    await startAndReachPhase(engine, 'import_upload_pending', {
      ai_substrate_used: 'claude',
    })

    await engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      freeform_text: 'actually can I switch to chatgpt instead?',
      observed_at: NOW_MS + 1_000,
    })

    const state = await stateStore.get(OWNER, USER)
    // Parked on the selection phase with buttons re-offered…
    expect(state?.phase).toBe('ai_substrate_offered')
    // …but the prior source is retained until a new one is actually tapped
    // (non-destructive re-emit — the #383 / Argus r2 invariant).
    expect(state?.phase_state['ai_substrate_used']).toBe('claude')
  })

  // Tapping a source button after the re-display IS a deliberate re-pick —
  // the consume handler advances forward with the freshly chosen source.
  test('ai_substrate_offered: tapping a source after re-display starts a clean import with the new source', async () => {
    const { router } = stubRouter([])
    const engine = buildEngine({ router, platform: stubPlatform('all') })
    await startAndReachPhase(engine, 'import_upload_pending', {
      ai_substrate_used: 'claude',
    })
    await engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      freeform_text: 'switch to chatgpt instead',
      observed_at: NOW_MS + 1_000,
    })
    const picker = (await stateStore.get(OWNER, USER))?.phase_state[
      'active_prompt_id'
    ] as string

    const out = await engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      choice: {
        prompt_id: picker,
        choice_value: 'chatgpt',
        chosen_at: NOW_MS + 2_000,
        speaker_user_id: USER,
        channel_kind: 'app-socket',
      },
      observed_at: NOW_MS + 2_000,
    })
    expect(out.outcome).toBe('advanced')
    const state = await stateStore.get(OWNER, USER)
    expect(state?.phase).toBe('import_upload_pending')
    expect(state?.phase_state['ai_substrate_used']).toBe('chatgpt')
  })

  // remove-both-import-option (2026-06-06) deploy-window robustness: a stale
  // `value:'both'` tap from an OLD 4-option prompt left open across the
  // release must NOT silently dead-end — re-emit the 3-option picker fresh.
  test("ai_substrate_offered: a stale 'both' button tap re-emits the 3-option picker (no dead tap)", async () => {
    const { router, calls } = stubRouter([])
    const engine = buildEngine({ router, platform: stubPlatform('all') })
    const original = await startAndReachPhase(engine, 'ai_substrate_offered')

    const out = await engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      choice: {
        prompt_id: original,
        choice_value: 'both',
        chosen_at: NOW_MS + 1_000,
        speaker_user_id: USER,
        channel_kind: 'app-socket',
      },
      observed_at: NOW_MS + 1_000,
    })

    // Not a silent no-op — the current source picker is re-emitted fresh.
    expect(out.outcome).toBe('reemitted_current')
    const state = await stateStore.get(OWNER, USER)
    expect(state?.phase).toBe('ai_substrate_offered')
    const buttons = buttonPromptsSent()
    const picker = buttons[buttons.length - 1]!
    expect(picker.options.map((o) => o.value).sort()).toEqual(['chatgpt', 'claude', 'neither'])
    expect(picker.prompt_id).not.toBe(original)
    expect(state?.phase_state['active_prompt_id']).toBe(picker.prompt_id)
    expect(calls.length).toBe(0)
  })

  // remove-both-import-option (2026-06-06) deploy-window robustness, SKIP
  // path — mirrors the stale-'both' source-screen TAP recovery above (the
  // Argus r1 P2 BLOCKER). An owner parked at `import_upload_pending` with a
  // STALE `ai_substrate_used='both'` (from the removed two-upload flow) who
  // already staged ONE zip and taps "Skip the import" AFTER this release
  // must NOT fall through to the generic skip → work_interview_gap_fill
  // route, which would silently discard the uploaded zip. Instead the engine
  // imports the single staged source (self-healing, no data loss — the zip
  // is on disk) and advances to import_running.
  test("import_upload_pending: stale 'both' + one staged upload taps Skip → imports the staged source (not dropped to gap-fill)", async () => {
    const { router, calls } = stubRouter([])
    const { importJobRunner, importPayloadResolver, startedSources } = stubImportStack()
    const engine = buildEngine({
      router,
      platform: stubPlatform('all'),
      importJobRunner,
      importPayloadResolver,
    })
    // Parked mid-(removed)-both-flow: stale source + one zip already on disk.
    const original = await startAndReachPhase(engine, 'import_upload_pending', {
      ai_substrate_used: 'both',
      uploads_received: ['chatgpt'],
    })

    const out = await engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      choice: {
        prompt_id: original,
        choice_value: 'skip',
        chosen_at: NOW_MS + 1_000,
        speaker_user_id: USER,
        channel_kind: 'app-socket',
      },
      observed_at: NOW_MS + 1_000,
    })

    // The staged upload was imported — NOT dropped to gap-fill. (The job is
    // still "running" — the stub's status() returns null — so the engine
    // re-emits the import_running status prompt; the decisive signals are the
    // phase + the started job, not the emit outcome.)
    expect(out.outcome).not.toBe('no_active_prompt')
    const state = await stateStore.get(OWNER, USER)
    expect(state?.phase).toBe('import_running')
    expect(state?.phase).not.toBe('work_interview_gap_fill')
    expect(state?.phase_state['import_source']).toBe('chatgpt-zip')
    // The runner actually started a job for the staged source.
    expect(startedSources).toEqual(['chatgpt-zip'])
    // Buttons-only path — router never consulted for the skip tap.
    expect(calls.length).toBe(0)
  })

  // Argus r2 BLOCKER (2026-06-06, remove-both-import-option) — deploy-window
  // hole the SKIP recovery opened: a stale-'both' owner with a staged
  // CHATGPT zip who source-SWITCHES to Claude, re-picks Claude, then taps
  // Skip must NOT have the stale ChatGPT zip imported. The re-pick to a
  // DIFFERENT source clears `uploads_received` (the PRIMARY root fix in
  // advanceFromAiSubstrateOfferedToUpload, fulfilling the documented
  // invariant at the source-switch re-emit), so the later Skip finds no
  // staged upload and falls through to the standard skip → gap-fill route.
  // Expectation per Argus: NOT chatgpt — gap-fill (or claude), never the
  // abandoned ChatGPT import.
  test("import_upload_pending: stale 'both' + staged chatgpt → switch to Claude → re-pick Claude → Skip → does NOT import chatgpt", async () => {
    const { router } = stubRouter([])
    const { importJobRunner, importPayloadResolver, startedSources } = stubImportStack()
    const engine = buildEngine({
      router,
      platform: stubPlatform('all'),
      importJobRunner,
      importPayloadResolver,
    })
    // Parked mid-(removed)-both-flow: stale 'both' + one ChatGPT zip on disk.
    const original = await startAndReachPhase(engine, 'import_upload_pending', {
      ai_substrate_used: 'both',
      uploads_received: ['chatgpt'],
    })

    // (1) Source-switch freeform → non-destructive re-emit of the picker.
    const switchOut = await engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      freeform_text: 'actually switch to claude',
      observed_at: NOW_MS + 1_000,
    })
    expect(switchOut.outcome).toBe('reemitted_current')
    const afterSwitch = await stateStore.get(OWNER, USER)
    expect(afterSwitch?.phase).toBe('ai_substrate_offered')
    // Non-destructive: the staged upload is still present until a real re-pick.
    expect(afterSwitch?.phase_state['uploads_received']).toEqual(['chatgpt'])
    const picker = afterSwitch?.phase_state['active_prompt_id'] as string
    expect(picker).not.toBe(original)

    // (2) Re-pick Claude (a DIFFERENT source than the staged chatgpt) → the
    // PRIMARY fix clears `uploads_received` and records the new substrate.
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
    const afterRepick = await stateStore.get(OWNER, USER)
    expect(afterRepick?.phase).toBe('import_upload_pending')
    expect(afterRepick?.phase_state['ai_substrate_used']).toBe('claude')
    // THE root fix: the stale chatgpt upload was cleared on the re-pick.
    expect(afterRepick?.phase_state['uploads_received']).toEqual([])
    const repickPrompt = afterRepick?.phase_state['active_prompt_id'] as string

    // (3) Tap Skip → with no staged upload, the SKIP recovery does NOT fire;
    // the engine routes to gap-fill. The decisive signal: the stale ChatGPT
    // zip was NEVER imported (neither the just-abandoned source nor any).
    await engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      choice: {
        prompt_id: repickPrompt,
        choice_value: 'skip',
        chosen_at: NOW_MS + 3_000,
        speaker_user_id: USER,
        channel_kind: 'app-socket',
      },
      observed_at: NOW_MS + 3_000,
    })
    const finalState = await stateStore.get(OWNER, USER)
    // NOT chatgpt — the abandoned ChatGPT import never ran.
    expect(startedSources).not.toContain('chatgpt-zip')
    expect(startedSources).toEqual([])
    expect(finalState?.phase_state['import_source']).not.toBe('chatgpt-zip')
    // Skip honored: routed to gap-fill, NOT import_running.
    expect(finalState?.phase).not.toBe('import_running')
    expect(finalState?.phase).toBe('work_interview_gap_fill')
  })

  // Argus r2 belt-and-suspenders — even if a stale single `ai_substrate_used`
  // ever diverges from the staged source WITHOUT going through the re-pick
  // clear (defense in depth), the SKIP recovery must refuse to import the
  // mismatched source. Stale ai_substrate_used='claude' + staged chatgpt zip
  // taps Skip → the recovery's consistency gate rejects the import → falls
  // through to gap-fill rather than importing the source the user moved away
  // from. (The matching-source + stale-'both' cases still import — covered
  // by the r1 test above.)
  test("import_upload_pending: SKIP recovery refuses a staged source that mismatches a concrete ai_substrate_used", async () => {
    const { router } = stubRouter([])
    const { importJobRunner, importPayloadResolver, startedSources } = stubImportStack()
    const engine = buildEngine({
      router,
      platform: stubPlatform('all'),
      importJobRunner,
      importPayloadResolver,
    })
    const original = await startAndReachPhase(engine, 'import_upload_pending', {
      ai_substrate_used: 'claude',
      uploads_received: ['chatgpt'],
    })

    await engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      choice: {
        prompt_id: original,
        choice_value: 'skip',
        chosen_at: NOW_MS + 1_000,
        speaker_user_id: USER,
        channel_kind: 'app-socket',
      },
      observed_at: NOW_MS + 1_000,
    })

    const state = await stateStore.get(OWNER, USER)
    // The mismatched chatgpt zip was NOT imported…
    expect(startedSources).toEqual([])
    expect(state?.phase).not.toBe('import_running')
    // …Skip honored → gap-fill.
    expect(state?.phase).toBe('work_interview_gap_fill')
  })

  // Generic buttons-only phase (not import) — proves the safety net is
  // universal, not import-specific.
  test('ai_substrate_offered: freeform re-emits the 3-button prompt with fresh prompt_id', async () => {
    const { router, calls } = stubRouter([])
    const engine = buildEngine({ router, platform: stubPlatform('all') })
    const original = await startAndReachPhase(engine, 'ai_substrate_offered')

    const out = await engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      freeform_text: 'wait what does this mean',
      observed_at: NOW_MS + 1_000,
    })

    const state = await stateStore.get(OWNER, USER)
    expect(state?.phase).toBe('ai_substrate_offered')
    expect(out.outcome).toBe('reemitted_current')
    expect(sentPrompts.some((p) => p.prompt.body === BUTTONS_ONLY_NUDGE_TEXT)).toBe(true)
    const buttons = buttonPromptsSent()
    expect(buttons.length).toBeGreaterThan(0)
    const reemitted = buttons[buttons.length - 1]!
    expect(reemitted.options.length).toBe(3)
    expect(reemitted.prompt_id).not.toBe(original)
    expect(state?.phase_state['active_prompt_id']).toBe(reemitted.prompt_id)
    expect(calls.length).toBe(0)
  })
})
