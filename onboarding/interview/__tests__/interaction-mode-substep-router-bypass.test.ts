/**
 * Regression tests — Argus r2 BLOCKER (2026-06-03,
 * onboarding-buttons-only-tweak-later).
 *
 * r1 fixed phase-level buttons-only stranding by making
 * `resolveInteractionMode` sub_step-aware: freeform sub_steps of a
 * buttons-only phase resolve to `'freeform'` so the engine runs its
 * synthetic-`__freeform__` → consumeChoice path. The r1 tests
 * (interaction-mode-substep-routing.test.ts) prove that — but they wire
 * NO LLM router (`platform` undefined), so `shouldConsultRouter` returns
 * false and the synthetic path is taken trivially.
 *
 * That masked a second mechanism: in production
 * (`NEUTRON_ONBOARDING_CONVERSATIONAL` on), the freeform branch consults
 * the LLM router BEFORE the synthetic path — but ONLY when the phase has a
 * non-null PHASE_KNOWLEDGE pack. `persona_reviewed` HAS such a pack
 * (PACK_PERSONA_REVIEWED), so a typed tweak ("make it warmer") went to
 * `llmRouter.route()`. A non-`advance` verdict (`answer` / `amend`)
 * re-emits the keyboard and NEVER calls `consumePersonaReviewedChoice` →
 * no recompose. Same stranding symptom as r1, different mechanism.
 *
 * The fix: `shouldConsultRouter` short-circuits to false on a freeform
 * sub_step (`isFreeformSubStep`), bypassing intent classification entirely
 * — the typed text IS the answer to the sub_step's dedicated handler.
 *
 * These tests WIRE a router that would MIS-classify (queued `answer` /
 * `amend` decisions) and a platform with the conversational flag ON, then
 * assert:
 *   (a) the router is NEVER called (bypassed), and
 *   (b) the sub_step's dedicated handler fires anyway (recompose for
 *       persona_reviewed; runner.start/status for import_running) and
 *       state advances, and
 *   (c) the canned buttons-only nudge is NEVER emitted.
 *
 * `import_running` is safe-by-accident today (null pack → router never
 * fires regardless), but is covered here as defensive regression: if a
 * knowledge pack is ever added for it, the bypass must still hold.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '../../../migrations/runner.ts'
import { ProjectDb } from '../../../persistence/index.ts'
import { ButtonStore } from '../../../channels/button-store.ts'
import { buildButtonPrompt } from '../../../channels/button-primitive.ts'
import type { ButtonPrompt } from '../../../channels/button-primitive.ts'
import {
  InterviewEngine,
  type PersonaComposerHook,
  type ImportJobRunnerHook,
  type ImportPayloadResolver,
  type MaxOauthSecretsStore,
} from '../engine.ts'
import type { PersonaDraft } from '../../persona-gen/compose.ts'
import type { ImportJob } from '../../history-import/types.ts'
import { InMemoryOnboardingStateStore } from '../state-store.ts'
import { TranscriptWriter } from '../transcript.ts'
import { BUTTONS_ONLY_NUDGE_TEXT } from '../interaction-mode.ts'
import type { LlmRouter, RouterDecision } from '../llm-router.ts'
import type { PlatformAdapter, PlatformInstanceInfo } from '../../../runtime/platform-adapter.ts'
import {
  stubRouter,
  stubPlatform,
  type RouterCall,
} from '@neutronai/onboarding/interview/__tests__/interview-testkit.ts'

const OWNER = 't1'
const TOPIC = 'topic-1'
const USER = 'u-1'
const NOW_MS = Date.now()

const SELF: PlatformInstanceInfo = {
  internal_handle: 'h1',
  url_slug: OWNER,
  owner_home: '/tmp/x',
  agent_name: null,
  tier: 'open',
  kind: 'user',
}

let tmp: string
let db: ProjectDb
let buttonStore: ButtonStore
let stateStore: InMemoryOnboardingStateStore
let transcript: TranscriptWriter
let sentPrompts: Array<{ prompt: ButtonPrompt }>

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-substep-router-bypass-'))
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

function nudgeCount(): number {
  return sentPrompts.filter((p) => p.prompt.body === BUTTONS_ONLY_NUDGE_TEXT).length
}

/** Register a live freeform prompt so the seeded `active_prompt_id`
 *  resolves through consumeChoice. */
async function registerFreeformPrompt(body: string): Promise<string> {
  const prompt = buildButtonPrompt({ body, options: [], allow_freeform: true })
  await buttonStore.emit(prompt, { topic_id: TOPIC })
  return prompt.prompt_id
}

/** A router that, if EVER consulted, would mis-classify the typed text as
 *  an in-context `answer` (re-emit keyboard, no advance) — the exact
 *  failure the bypass prevents. The test asserts `calls.length === 0`. */
function misclassifyingRouter(): { router: LlmRouter; calls: RouterCall[] } {
  const decision: RouterDecision = {
    action: 'answer',
    confidence: 0.9,
    choice_value: null,
    freeform_text: null,
    response: 'Here is some info — keyboard stays put.',
    state_delta: null,
    reasoning: 'mis-classified the tweak as a question',
  }
  // Queue several so repeated-call tests never exhaust it (the queue is
  // only consumed if the bypass fails — which is itself the bug).
  return stubRouter([decision, decision, decision])
}

function conversationalPlatform(): PlatformAdapter {
  return stubPlatform('all', SELF)
}

// ── persona_reviewed freeform sub_steps (LIVE bug: non-null pack) ────────

function makeStubComposer(track: { composeCalls: number }): PersonaComposerHook {
  const draft = (project_slug: string): PersonaDraft => ({
    project_slug,
    draft_id: 'draft-test',
    soul_md: '# SOUL\nYou are a warm, direct thinking partner.',
    user_md: '# USER\nName: Test',
    priority_map_md: '# PRIORITY\n- work',
    cringe_check_flags: { soul: 0, user: 0, priority_map: 0 },
    regen_attempts: { soul: 0, user: 0, priority_map: 0 },
    status: 'draft',
  })
  return {
    async compose(input) {
      track.composeCalls += 1
      return draft(input.project_slug)
    },
    async applyEdit() {
      return draft(OWNER)
    },
    async commit() {
      return { committed_at: NOW_MS, git_sha: null, paths: [] }
    },
  }
}

describe('persona_reviewed freeform sub_steps bypass the LLM router (recompose fires)', () => {
  for (const sub_step of [
    'pending_regen_hint',
    'pick_replacement',
    'pick_line',
  ] as const) {
    test(`${sub_step}: router wired + ON → typed tweak recomposes, router NOT called, no nudge`, async () => {
      const track = { composeCalls: 0 }
      const { router, calls } = misclassifyingRouter()
      const engine = new InterviewEngine({
        buttonStore,
        stateStore,
        transcript,
        sendButtonPrompt: async (input) => {
          sentPrompts.push({ prompt: input.prompt })
          return { message_id: `msg-${sentPrompts.length}`, was_new: true }
        },
        personaComposer: makeStubComposer(track),
        llmRouter: router,
        platform: conversationalPlatform(),
      })

      const prompt_id = await registerFreeformPrompt(
        'What should I change? Say it in your own words and I will update.',
      )
      await stateStore.upsert({
        user_id: USER,
        project_slug: OWNER,
        phase: 'persona_reviewed',
        phase_state_patch: {
          topic_id: TOPIC,
          user_id: USER,
          signup_via: 'web',
          user_first_name: 'Casey',
          agent_name: 'Sage',
          agent_personality: 'a warm thinking partner',
          persona_review_sub_step: sub_step,
          persona_review_tweak_mode: true,
          active_prompt_id: prompt_id,
        },
        advanced_at: NOW_MS,
      })

      const out = await engine.advance({
        project_slug: OWNER,
        topic_id: TOPIC,
        user_id: USER,
        channel_kind: 'app-socket',
        freeform_text: 'Make it a little warmer and less formal.',
        observed_at: NOW_MS + 1_000,
      })

      // (a) the router was NEVER consulted — the bypass held
      expect(calls.length).toBe(0)
      // (b) recompose fired via the sub_step's dedicated handler
      expect(track.composeCalls).toBe(1)
      // (c) the canned nudge was NEVER emitted
      expect(nudgeCount()).toBe(0)
      // (d) state advanced: sub_step returned to idle with a fresh draft
      const state = await stateStore.get(OWNER, USER)
      expect(state?.phase).toBe('persona_reviewed')
      expect(state?.phase_state['persona_review_sub_step']).toBe('idle')
      expect(state?.phase_state['persona_draft']).toBeDefined()
      expect(out.outcome).not.toBe('noop_no_state')
    })
  }
})

// ── import_running freeform sub_steps (defensive: null pack today) ───────

function makeImportEngine(
  track: { startCalls: number; statusCalls: number },
  router: LlmRouter,
  platform: PlatformAdapter,
): InterviewEngine {
  const runner: ImportJobRunnerHook = {
    start: async () => {
      track.startCalls += 1
      return { job_id: 'job-new' }
    },
    status: async (job_id: string) => {
      track.statusCalls += 1
      return {
        job_id,
        project_slug: OWNER,
        source: 'chatgpt-zip',
        status: 'pass1-running',
        dollars_spent: 0,
        pass1_chunks_done: 1,
        pass1_chunks_total: 10,
        chunks_total_known: true,
        started_at: NOW_MS - 30_000,
      } as ImportJob
    },
    cancel: async () => undefined,
    synthesizeOnDemand: async () => null,
  }
  const payloadResolver: ImportPayloadResolver = {
    resolve: async () => Buffer.from('fake-zip'),
  }
  return new InterviewEngine({
    buttonStore,
    stateStore,
    transcript,
    sendButtonPrompt: async (input) => {
      sentPrompts.push({ prompt: input.prompt })
      return { message_id: `msg-${sentPrompts.length}`, was_new: true }
    },
    importJobRunner: runner,
    importPayloadResolver: payloadResolver,
    llmRouter: router,
    platform,
  })
}

describe('import_running freeform sub_steps bypass the LLM router (handler fires)', () => {
  test('failed: router wired + ON → pasted URL retries, router NOT called, no nudge', async () => {
    const track = { startCalls: 0, statusCalls: 0 }
    const { router, calls } = misclassifyingRouter()
    const engine = makeImportEngine(track, router, conversationalPlatform())

    const prompt_id = await registerFreeformPrompt(
      'Something went wrong. Paste a fresh URL below to retry, or tap a button.',
    )
    await stateStore.upsert({
      user_id: USER,
      project_slug: OWNER,
      phase: 'import_running',
      phase_state_patch: {
        topic_id: TOPIC,
        user_id: USER,
        signup_via: 'web',
        import_source: 'chatgpt-zip',
        import_job_id: 'job-old',
        import_running_sub_step: 'failed',
        active_prompt_id: prompt_id,
      },
      advanced_at: NOW_MS,
    })

    await engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      freeform_text: 'https://example.com/fresh-export.zip',
      observed_at: NOW_MS + 1_000,
    })

    // (a) the router was NEVER consulted
    expect(calls.length).toBe(0)
    // (b) the pasted URL routed to the retry path → runner.start fired
    expect(track.startCalls).toBe(1)
    // (c) the canned nudge was NEVER emitted
    expect(nudgeCount()).toBe(0)
    const state = await stateStore.get(OWNER, USER)
    expect(state?.phase).toBe('import_running')
    expect(state?.phase_state['import_paste_url_chatgpt-zip']).toBe(
      'https://example.com/fresh-export.zip',
    )
  })

  test('rate_limit_paused: router wired + ON → typed text re-polls, router NOT called, no nudge', async () => {
    const track = { startCalls: 0, statusCalls: 0 }
    const { router, calls } = misclassifyingRouter()
    const engine = makeImportEngine(track, router, conversationalPlatform())

    const prompt_id = await registerFreeformPrompt(
      "Your import is paused while Claude's rate limit recovers. I'll auto-resume.",
    )
    await stateStore.upsert({
      user_id: USER,
      project_slug: OWNER,
      phase: 'import_running',
      phase_state_patch: {
        topic_id: TOPIC,
        user_id: USER,
        signup_via: 'web',
        import_source: 'chatgpt-zip',
        import_job_id: 'job-old',
        import_running_sub_step: 'rate_limit_paused',
        active_prompt_id: prompt_id,
      },
      advanced_at: NOW_MS,
    })

    await engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      freeform_text: 'any update?',
      observed_at: NOW_MS + 1_000,
    })

    // (a) the router was NEVER consulted
    expect(calls.length).toBe(0)
    // (b) the typed text re-polled the runner instead of stalling
    expect(track.statusCalls).toBeGreaterThanOrEqual(1)
    // (c) no retry triggered (paused is recoverable; status text only)
    expect(track.startCalls).toBe(0)
    // (d) the canned nudge was NEVER emitted
    expect(nudgeCount()).toBe(0)
    const state = await stateStore.get(OWNER, USER)
    expect(state?.phase).toBe('import_running')
  })
})

// ── projects_proposed:share_freeform (Argus r4 BLOCKER: LIVE, non-null pack) ─
//
// Tapping "Share what I'm working on" flips
// `projects_proposed_share_freeform=true` and re-emits "Tell me what you're
// working on" (`options:[]` + allow_freeform). projects_proposed HAS a
// non-null knowledge pack (PACK_PROJECTS_PROPOSED), so — UNLIKE
// import_running — this was a LIVE router-stranding bug, not just a
// canned-nudge stall: pre-fix the typed project list went to the router and a
// mis-classification re-emitted the keyboard, so the list never reached
// `consumeProjectsProposedChoice`'s `awaiting_share_freeform` branch. The fix
// derives the `share_freeform` sub_step from the boolean flag
// (`deriveActiveSubStep`) → `resolveInteractionMode` returns 'freeform' AND
// `shouldConsultRouter` bypasses the router. Routed via `freeform_text` (the
// real channel path), NOT a synthetic `__freeform__` choice — the choice path
// skips the interaction-mode gate entirely and never exercised this bug.

describe('projects_proposed:share_freeform bypasses the LLM router (project list captured)', () => {
  test('router wired + ON → typed project list captured, router NOT called, no nudge', async () => {
    const { router, calls } = misclassifyingRouter()
    const engine = new InterviewEngine({
      buttonStore,
      stateStore,
      transcript,
      sendButtonPrompt: async (input) => {
        sentPrompts.push({ prompt: input.prompt })
        return { message_id: `msg-${sentPrompts.length}`, was_new: true }
      },
      llmRouter: router,
      platform: conversationalPlatform(),
    })

    const prompt_id = await registerFreeformPrompt(
      "Tell me what you're working on — a few projects in your own words is plenty.",
    )
    await stateStore.upsert({
      user_id: USER,
      project_slug: OWNER,
      phase: 'projects_proposed',
      phase_state_patch: {
        topic_id: TOPIC,
        user_id: USER,
        signup_via: 'web',
        primary_projects: [],
        projects_proposed_share_freeform: true,
        active_prompt_id: prompt_id,
      },
      advanced_at: NOW_MS,
    })

    const out = await engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      freeform_text: '1. Northwind\n2. Acme\n3. the book',
      observed_at: NOW_MS + 1_000,
    })

    // (a) the router was NEVER consulted — the bypass held
    expect(calls.length).toBe(0)
    // (b) the dedicated share-freeform handler captured the typed list
    //     (no LLM driver wired → splitFreeformProjectList fallback fires)
    const state = await stateStore.get(OWNER, USER)
    expect(state?.phase_state['primary_projects']).toEqual([
      'Northwind',
      'Acme',
      'the book',
    ])
    // (c) the share-freeform sub-state was cleared (handler ran to completion)
    expect(state?.phase_state['projects_proposed_share_freeform']).toBeNull()
    // (d) the canned buttons-only nudge was NEVER emitted
    expect(nudgeCount()).toBe(0)
    // (e) stays on projects_proposed (re-emits the populated list for confirm)
    expect(state?.phase).toBe('projects_proposed')
    expect(out.outcome).toBe('reemitted_current')
  })
})

// ── max_oauth_offered:awaiting_byo_paste (Argus r4 BLOCKER: LIVE, non-null pack) ─
//
// Tapping the BYO path flips `awaiting_byo_paste=true` and re-emits "Paste
// your Anthropic API key" (one Skip button + allow_freeform).
// max_oauth_offered HAS a non-null pack (PACK_MAX_OAUTH_OFFERED), so a pasted
// key went to the router and a mis-classification stranded the BYO flow
// entirely. The fix derives `awaiting_byo_paste` from the boolean flag →
// 'freeform' mode + router bypass → `persistByoApiKeyAndAdvance` runs.
//
// NB the existing max-oauth-offered.test.ts Test 5 exercises the SAME paste
// but via a synthetic `__freeform__` *choice*, which hits `consumeChoice`
// directly and SKIPS the interaction-mode gate — so it passed even while the
// real `freeform_text` channel path (below) was broken. This is the
// regression that closes that gap.

describe('max_oauth_offered:awaiting_byo_paste bypasses the LLM router (key persisted)', () => {
  test('router wired + ON → pasted key persisted + advances, router NOT called, no nudge', async () => {
    const { router, calls } = misclassifyingRouter()
    const putCalls: Array<{ kind: string; plaintext: string }> = []
    const secrets: MaxOauthSecretsStore = {
      async put(input) {
        putCalls.push({ kind: input.kind, plaintext: input.plaintext })
        return { id: 'sec-1' }
      },
      async list() {
        return []
      },
    }
    const engine = new InterviewEngine({
      buttonStore,
      stateStore,
      transcript,
      sendButtonPrompt: async (input) => {
        sentPrompts.push({ prompt: input.prompt })
        return { message_id: `msg-${sentPrompts.length}`, was_new: true }
      },
      secrets,
      llmRouter: router,
      platform: conversationalPlatform(),
    })

    const prompt_id = await registerFreeformPrompt(
      'Paste your Anthropic API key (starts with sk-ant-).',
    )
    await stateStore.upsert({
      user_id: USER,
      project_slug: OWNER,
      phase: 'max_oauth_offered',
      phase_state_patch: {
        topic_id: TOPIC,
        user_id: USER,
        signup_via: 'web',
        awaiting_byo_paste: true,
        active_prompt_id: prompt_id,
      },
      advanced_at: NOW_MS,
    })

    const out = await engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      freeform_text: 'sk-ant-api03-test-byo-key-000',
      observed_at: NOW_MS + 1_000,
    })

    // (a) the router was NEVER consulted — the bypass held
    expect(calls.length).toBe(0)
    // (b) the dedicated BYO handler persisted the pasted key
    expect(putCalls.length).toBe(1)
    expect(putCalls[0]?.kind).toBe('byo_api_key')
    expect(putCalls[0]?.plaintext).toBe('sk-ant-api03-test-byo-key-000')
    // (c) advanced to wow_fired with the byo substrate recorded + flag cleared
    const state = await stateStore.get(OWNER, USER)
    expect(state?.phase).toBe('wow_fired')
    expect(state?.phase_state['max_substrate']).toBe('byo_api_key')
    expect(state?.phase_state['awaiting_byo_paste']).toBeNull()
    // (d) the canned buttons-only nudge was NEVER emitted
    expect(nudgeCount()).toBe(0)
    expect(out.outcome).toBe('advanced')
  })
})

// ── import_analysis_presented (Argus r3 BLOCKER: reclassify, DON'T bypass) ─
//
// The HAPPY path: completed import, no `can_resume_import` → the success
// body renders `options:[]` + "Anything important I missed?" (allow_freeform).
// Classified `'buttons-only'`, a typed correction hit the canned nudge
// ("Tap one of the buttons above") with NO button present → hard stall.
//
// The fix reclassifies it `'freeform'`. UNLIKE the persona_reviewed /
// import_running freeform SUB_STEPS above, the router is NOT bypassed here —
// this phase's router behavior is intentional (a typed FAQ deflects via
// `answer`, a project edit via `amend`; the FAQ/amend coverage lives in
// engine-router-integration.test.ts). A correction / "looks good" classifies
// `advance`, which feeds `consumeImportAnalysisPresentedChoice`. These two
// tests pin the HAPPY-path advance: (1) router unwired → the synthetic-
// `__freeform__` fall-through captures the reply and advances (the pure
// stall reproduction — buttons-only no longer intercepts); (2) router wired
// + ON, returning `advance` → the same handler runs via the router. Both:
// handler captured the reply, state advanced, canned nudge NEVER emitted.

describe('import_analysis_presented typed reply reaches its handler on the HAPPY path', () => {
  /** Seed the success-path state: completed import, three required fields
   *  filled (audit clean → personality_offered), no can_resume_import. */
  async function seedSuccessState(prompt_id: string): Promise<void> {
    await stateStore.upsert({
      user_id: USER,
      project_slug: OWNER,
      phase: 'import_analysis_presented',
      phase_state_patch: {
        topic_id: TOPIC,
        user_id: USER,
        signup_via: 'web',
        user_first_name: 'Casey',
        primary_projects: ['Northwind', 'Acme', 'the book'],
        non_work_interests: ['climbing'],
        active_prompt_id: prompt_id,
      },
      advanced_at: NOW_MS,
    })
  }

  test('router UNWIRED → synthetic fall-through captures correction, advances, no nudge', async () => {
    const engine = new InterviewEngine({
      buttonStore,
      stateStore,
      transcript,
      sendButtonPrompt: async (input) => {
        sentPrompts.push({ prompt: input.prompt })
        return { message_id: `msg-${sentPrompts.length}`, was_new: true }
      },
      // No llmRouter, no platform — the pure flag-off happy path. Pre-fix
      // this stranded on the buttons-only nudge regardless of the router.
    })

    const prompt_id = await registerFreeformPrompt(
      "Here's what I gathered from your conversations. Anything important I missed?",
    )
    await seedSuccessState(prompt_id)

    const out = await engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      freeform_text: 'I forgot to mention the X project',
      observed_at: NOW_MS + 1_000,
    })

    const state = await stateStore.get(OWNER, USER)
    // (a) dedicated handler captured the typed correction
    expect(state?.phase_state['user_supplied_corrections']).toContain(
      'I forgot to mention the X project',
    )
    expect(state?.phase_state['last_choice_freeform']).toBe(
      'I forgot to mention the X project',
    )
    // (b) advanced off import_analysis_presented (audit clean → personality_offered)
    expect(state?.phase).toBe('personality_offered')
    expect(out.outcome).toBe('advanced')
    // (c) the canned buttons-only nudge was NEVER emitted
    expect(nudgeCount()).toBe(0)
  })

  test('router WIRED + ON, returns advance → handler runs via router, advances, no nudge', async () => {
    const { router, calls } = stubRouter([
      {
        action: 'advance',
        confidence: 0.95,
        choice_value: null,
        freeform_text: 'I forgot to mention the X project',
        response: null,
        state_delta: null,
        reasoning: 'final correction → advance into the dedicated handler',
      },
    ])
    const engine = new InterviewEngine({
      buttonStore,
      stateStore,
      transcript,
      sendButtonPrompt: async (input) => {
        sentPrompts.push({ prompt: input.prompt })
        return { message_id: `msg-${sentPrompts.length}`, was_new: true }
      },
      llmRouter: router,
      platform: conversationalPlatform(),
    })

    const prompt_id = await registerFreeformPrompt(
      "Here's what I gathered from your conversations. Anything important I missed?",
    )
    await seedSuccessState(prompt_id)

    const out = await engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      freeform_text: 'I forgot to mention the X project',
      observed_at: NOW_MS + 1_000,
    })

    // (a) the router WAS consulted exactly once (NOT bypassed — intentional here)
    expect(calls.length).toBe(1)
    expect(calls[0]?.input.phase).toBe('import_analysis_presented')
    // (b) the advance verdict fed the dedicated handler, which captured the reply
    const state = await stateStore.get(OWNER, USER)
    expect(state?.phase_state['user_supplied_corrections']).toContain(
      'I forgot to mention the X project',
    )
    // (c) advanced off the phase (audit clean → personality_offered)
    expect(state?.phase).toBe('personality_offered')
    expect(out.outcome).toBe('advanced')
    // (d) the canned buttons-only nudge was NEVER emitted
    expect(nudgeCount()).toBe(0)
  })
})

// ── Guard: genuinely-freeform phases STILL consult the router ────────────
//
// The bypass must be surgical — it keys on the freeform SUB_STEP, not on
// "freeform mode" broadly. A genuinely-freeform phase (signup) has no
// sub_step, so `isFreeformSubStep` is false and the router still fires.
// Without this guard a future over-broad bypass (e.g. keying on
// interaction_mode === 'freeform') would silently kill the router on the
// phases that legitimately need it.

describe('genuinely-freeform phases still consult the router (bypass is sub_step-scoped)', () => {
  test('signup: router wired + ON → typed name reaches the router (NOT bypassed)', async () => {
    const { router, calls } = stubRouter([
      {
        action: 'advance',
        confidence: 0.95,
        choice_value: null,
        freeform_text: 'Sam',
        response: null,
        state_delta: null,
        reasoning: 'name captured',
      },
    ])
    const engine = new InterviewEngine({
      buttonStore,
      stateStore,
      transcript,
      sendButtonPrompt: async (input) => {
        sentPrompts.push({ prompt: input.prompt })
        return { message_id: `msg-${sentPrompts.length}`, was_new: true }
      },
      llmRouter: router,
      platform: conversationalPlatform(),
    })

    // Seed signup + emit the active prompt so active_prompt_id is set.
    await stateStore.upsert({
      user_id: USER,
      project_slug: OWNER,
      phase: 'signup',
      phase_state_patch: { topic_id: TOPIC, user_id: USER, signup_via: 'web' },
      advanced_at: NOW_MS,
    })
    await engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      observed_at: NOW_MS,
    })
    sentPrompts.length = 0

    await engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      freeform_text: 'Sam',
      observed_at: NOW_MS + 1_000,
    })

    // The router WAS consulted for this genuinely-freeform phase.
    expect(calls.length).toBe(1)
  })
})
