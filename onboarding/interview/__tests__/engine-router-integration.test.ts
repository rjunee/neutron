/**
 * Integration tests — `InterviewEngine` × LLM router wiring.
 *
 * P2-v3 S2 (2026-05-18). Per sprint brief § 8.2. Exercises the four S2
 * phases (signup / ai_substrate_offered / import_upload_pending /
 * personality_offered) against a stub router and asserts the engine's
 * `dispatchRouterDecision` behaves per design § 2.3:
 *
 *   - `advance` → consumeChoice fires; phase progresses
 *   - `answer`  → phase stays put; agent body posted; keyboard re-emitted
 *   - `amend`   → phase_state merged with delta; phase stays put
 *
 * The "brief incident" test is the single most important assertion in
 * this sprint: at `import_upload_pending`, the user types
 * "can you give me the instructions for claude as well" and the engine
 * must NOT advance — the router's `answer` decision keeps state put
 * and the Claude export steps land via a free-text agent bubble.
 *
 * --- 2026-06-03 reclassification (onboarding-buttons-only-tweak-later) ---
 * Sam's "buttons only tweak later" call retired the LLM router from the
 * onboarding hot path for all phases EXCEPT the genuinely-freeform ones
 * (signup + work_interview_gap_fill). `ai_substrate_offered`,
 * `import_upload_pending`, `import_analysis_presented`, `projects_proposed`,
 * `persona_reviewed` are now buttons-only; `agent_name_chosen`,
 * `slug_chosen`, `personality_offered` are now mixed (validated
 * text-input, no router). The engine consults `interaction-mode.ts`
 * BEFORE the router, so the router is NEVER reached for these phases.
 *
 * Consequence for this file: every test that asserted router behavior on
 * a reclassified phase is testing REMOVED behavior. Those are marked
 * `.skip` with a reason below (preserved, not deleted, in case the router
 * is restored for some phase — see ISSUES.md "onboarding LLM-router
 * retired for buttons-only/mixed phases"). The router MECHANICS
 * (advance / answer / amend, the amend-key whitelist security gate) stay
 * covered via the still-freeform `signup` phase + `llm-router.test.ts`,
 * and the NEW buttons-only/mixed contract is covered by
 * `interaction-mode-routing.test.ts`. The parameterized S3 loops skip
 * their reclassified phases via an `INTERACTION_MODE_BY_PHASE` guard so
 * the surviving freeform phase (work_interview_gap_fill) still runs.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '../../../migrations/runner.ts'
import { ProjectDb } from '../../../persistence/index.ts'
import { ButtonStore } from '../../../channels/button-store.ts'
import type { ButtonPrompt } from '../../../channels/button-primitive.ts'
import { AMEND_ACK_FALLBACK_TEXT, InterviewEngine } from '../engine.ts'
import { InMemoryOnboardingStateStore } from '../state-store.ts'
import { TranscriptWriter } from '../transcript.ts'
import type { LlmRouter, RouterDecision, RouterInput } from '../llm-router.ts'
import type { PlatformAdapter, PlatformInstanceInfo } from '../../../runtime/platform-adapter.ts'
import type { OnboardingPhase } from '../phase.ts'
import { INTERACTION_MODE_BY_PHASE } from '../interaction-mode.ts'

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

// P2-v3 S4 — `stubRouter` + `stubPlatform` extracted to a shared helper
// so the v3 fixture / tangent-coverage suites can share them. ISSUES #223
// (2026-06-13) relocated that Open subset to
// `onboarding/interview/__tests__/interview-testkit.ts` (a kept Open
// path) so the Sprint-C carve ships it.
import {
  stubRouter as sharedStubRouter,
  stubPlatform as sharedStubPlatform,
  type RouterCall,
} from '@neutronai/onboarding/interview/__tests__/interview-testkit.ts'

function stubRouter(answers: Iterable<RouterDecision>): {
  router: LlmRouter
  calls: RouterCall[]
} {
  return sharedStubRouter(answers)
}

function stubPlatform(
  conversational: 'all' | ReadonlyArray<OnboardingPhase>,
): PlatformAdapter {
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
  return new InterviewEngine(deps)
}

// Pick an observed-at near `Date.now()` so the resume-on-reconnect gate
// (default 24h) does not trigger when the test seeds state and then
// drives the engine.
const NOW_MS = Date.now()

async function startAndReachPhase(
  engine: InterviewEngine,
  phase: OnboardingPhase,
  phase_state_patch: Record<string, unknown> = {},
): Promise<string> {
  // Seed the state store directly at the target phase so each test can
  // exercise the router for a specific phase without walking the
  // entire phase machine.
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
  // Trigger the engine to emit the active prompt (which seeds
  // active_prompt_id on the state).
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
  // Drop the emit-side prompt out of the send log so subsequent
  // assertions only see router-driven sends.
  sentPrompts.length = 0
  return ap as string
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-router-eng-'))
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

describe('router action=advance', () => {
  test('signup: typed name maps to consumeChoice + transcript user line', async () => {
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
    const engine = buildEngine({ router, platform: stubPlatform('all') })
    await startAndReachPhase(engine, 'signup')
    const out = await engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      observed_at: NOW_MS,
      freeform_text: 'Sam',
    })
    expect(calls.length).toBe(1)
    expect(calls[0]?.input.phase).toBe('signup')
    expect(calls[0]?.input.user_text).toBe('Sam')
    // Phase advances past signup (engine walks auto-skip etc.) — what we
    // care about is "no longer at signup".
    expect(out.state?.phase).not.toBe('signup')
    const userLines = transcript
      .readAll()
      .filter((e) => e.role === 'user')
      .map((e) => e.body)
    expect(userLines).toContain('Sam')
  })

  test('import_analysis_presented HYBRID advance: freeform answer + state_delta merges projects AND advances (envelope-conformance round 2)', async () => {
    // The canonical hybrid amend+advance (§ 2.3): the user both ANSWERS the
    // review phase ("what did I miss?") AND supplies facts. The advance branch
    // must merge the whitelisted state_delta BEFORE running the advance cascade
    // so the projects are recorded AND the phase progresses in ONE turn — no
    // amend→re-ask stall (the prod failure this round fixes).
    const reply = "I'm working on Northwind, Acme, and a book; I climb"
    const { router, calls } = stubRouter([
      {
        action: 'advance',
        confidence: 0.98,
        choice_value: null,
        freeform_text: reply,
        response: null,
        state_delta: {
          primary_projects: ['Northwind', 'Acme', 'Book'],
          non_work_interests: ['climbing'],
        } as Record<string, unknown>,
        reasoning: 'review/correction hybrid advance',
      },
    ])
    const engine = buildEngine({ router, platform: stubPlatform('all') })
    await startAndReachPhase(engine, 'import_analysis_presented')
    const out = await engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      observed_at: NOW_MS,
      freeform_text: reply,
    })
    expect(calls.length).toBe(1)
    // CRITICAL — advanced OFF import_analysis_presented (no amend→re-ask stall).
    expect(out.state?.phase).not.toBe('import_analysis_presented')
    // The hybrid state_delta was merged (whitelisted) into phase_state.
    const phase_state = (out.state?.phase_state ?? {}) as Record<string, unknown>
    expect(phase_state['primary_projects']).toEqual([
      'Northwind',
      'Acme',
      'Book',
    ])
    expect(phase_state['non_work_interests']).toEqual(['climbing'])
  })

  test('DEDUPED redelivered hybrid advance does NOT re-merge the state_delta (idempotency barrier — Argus r2-round2 IMPORTANT)', async () => {
    // The hybrid state_delta merge now lands DOWNSTREAM of buttonStore.resolve,
    // so it is gated on was_new. A duplicate/redelivered inbound that the
    // idempotency barrier swallows (was_new=false) must NOT re-run the merge —
    // re-merging on a deduped turn would bump last_advanced_at and replay
    // user_supplied_corrections[] on a turn that never reaches the user.
    const reply = "I'm working on Northwind; I climb"
    const { router, calls } = stubRouter([
      {
        action: 'advance',
        confidence: 0.98,
        choice_value: null,
        freeform_text: reply,
        response: null,
        state_delta: {
          primary_projects: ['Northwind'],
          non_work_interests: ['climbing'],
        } as Record<string, unknown>,
        reasoning: 'redelivered hybrid advance',
      },
    ])
    const engine = buildEngine({ router, platform: stubPlatform('all') })
    const activeId = await startAndReachPhase(engine, 'import_analysis_presented')
    // Simulate the FIRST delivery of this turn having already resolved the
    // active prompt (this IS the idempotency barrier). The redelivery below
    // must therefore find resolved_at set → was_new=false.
    await buttonStore.resolve({
      choice: {
        prompt_id: activeId,
        choice_value: '__freeform__',
        freeform_text: reply,
        chosen_at: NOW_MS,
        speaker_user_id: USER,
        channel_kind: 'app-socket',
      },
    })
    const out = await engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      observed_at: NOW_MS,
      freeform_text: reply,
    })
    expect(calls.length).toBe(1)
    // CRITICAL — the deduped (was_new=false) turn did NOT merge the delta.
    // primary_projects / non_work_interests stay absent (the merge was skipped).
    const phase_state = (out.state?.phase_state ?? {}) as Record<string, unknown>
    expect(phase_state['primary_projects']).toBeUndefined()
    expect(phase_state['non_work_interests']).toBeUndefined()
  })

  test('synthesised timeout advance → re-prompts, preserves input, stays on phase (DECISION Part 2)', async () => {
    // DECISION doc Part 2: an `advance` decision carrying `synthesised` is NOT
    // a real classification (the LLM call failed entirely). The engine must
    // NOT blind-advance — it appends the user's text to the transcript, sends
    // a "say it again" re-prompt, re-emits the keyboard, and stays on phase.
    const { router, calls } = stubRouter([
      {
        action: 'advance',
        confidence: 0,
        choice_value: null,
        freeform_text: 'my projects are helperbot and beacon',
        response: null,
        state_delta: null,
        reasoning: 'timeout',
        synthesised: 'timeout',
      },
    ])
    const engine = buildEngine({ router, platform: stubPlatform('all') })
    const activeId = await startAndReachPhase(engine, 'signup')
    const out = await engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      observed_at: NOW_MS,
      freeform_text: 'my projects are helperbot and beacon',
    })
    expect(calls.length).toBe(1)
    // CRITICAL — phase MUST stay at signup (no blind advance).
    expect(out.outcome).toBe('reemitted_current')
    expect(out.state?.phase).toBe('signup')
    expect(out.prompt_id).toBe(activeId)
    // The user's text is preserved on the transcript for the next (warm) turn.
    const userLines = transcript
      .readAll()
      .filter((e) => e.role === 'user')
      .map((e) => e.body)
    expect(userLines).toContain('my projects are helperbot and beacon')
    // A brief re-prompt was sent.
    const reprompt = sentPrompts.find((p) =>
      p.prompt.body.toLowerCase().includes("didn't quite catch that"),
    )
    expect(reprompt).toBeDefined()
    // The original keyboard was re-emitted so taps still land on activeId.
    const reEmitted = sentPrompts.find((p) => p.prompt.prompt_id === activeId)
    expect(reEmitted).toBeDefined()
  })

  test('advance with non-null response sends ack BEFORE consuming the choice', async () => {
    const { router } = stubRouter([
      {
        action: 'advance',
        confidence: 0.95,
        choice_value: null,
        freeform_text: 'Sam',
        response: 'Nice to meet you, Sam.',
        state_delta: null,
        reasoning: 'name captured',
      },
    ])
    const engine = buildEngine({ router, platform: stubPlatform('all') })
    await startAndReachPhase(engine, 'signup')
    await engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      observed_at: NOW_MS,
      freeform_text: 'Sam',
    })
    const ackBubble = sentPrompts.find((p) =>
      p.prompt.body.includes('Nice to meet you'),
    )
    expect(ackBubble).toBeDefined()
  })
})

describe('router action=answer (THE BRIEF INCIDENT lives here)', () => {
  // SKIP 2026-06-03: import_upload_pending is now buttons-only. The
  // router-driven "give me claude instructions too" answer path is
  // retired — typed questions on this phase now get the canned nudge.
  // This deliberately supersedes the 2026-06-03 freeform source-switch
  // work (PR #357 / commit 8f0d33f); flagged in the sprint PR for Sam.
  test.skip(
    'import_upload_pending: "can you give me the instructions for claude as well" → NO advance',
    async () => {
      const claudeBody =
        "Sure - Claude's export lives at Settings > Privacy & Personalization > Data Controls > Export. Click Export, wait ~5 minutes, then upload the .zip here."
      const { router, calls } = stubRouter([
        {
          action: 'answer',
          confidence: 0.94,
          choice_value: null,
          freeform_text: null,
          response: claudeBody,
          state_delta: null,
          reasoning: 'tangent_route_to_claude_export_steps',
        },
      ])
      const engine = buildEngine({ router, platform: stubPlatform('all') })
      const activeId = await startAndReachPhase(engine, 'import_upload_pending')
      const out = await engine.advance({
        project_slug: OWNER,
        topic_id: TOPIC,
        user_id: USER,
        channel_kind: 'app-socket',
        freeform_text: 'can you give me the instructions for claude as well',
      })
      expect(calls.length).toBe(1)
      // CRITICAL — phase MUST stay at import_upload_pending.
      expect(out.state?.phase).toBe('import_upload_pending')
      // active_prompt_id must remain unchanged.
      const phase_state = (out.state?.phase_state ?? {}) as Record<string, unknown>
      expect(phase_state['active_prompt_id']).toBe(activeId)
      // The agent's Claude-export body must have been sent.
      const sentBodies = sentPrompts.map((p) => p.prompt.body)
      expect(sentBodies.some((b) => b.toLowerCase().includes('claude'))).toBe(true)
      // The user's reply landed on the transcript.
      const userLines = transcript
        .readAll()
        .filter((e) => e.role === 'user')
        .map((e) => e.body)
      expect(userLines).toContain(
        'can you give me the instructions for claude as well',
      )
      // The keyboard was re-emitted (i.e. the original active prompt
      // was re-sent so taps still land on the same active_prompt_id).
      const reEmittedKeyboard = sentPrompts.find((p) => p.prompt.prompt_id === activeId)
      expect(reEmittedKeyboard).toBeDefined()
    },
  )

  test('signup: tangent question → phase stays put', async () => {
    const { router } = stubRouter([
      {
        action: 'answer',
        confidence: 0.91,
        choice_value: null,
        freeform_text: null,
        response: "Your name's just so the agent knows what to call you.",
        state_delta: null,
        reasoning: 'tangent purpose',
      },
    ])
    const engine = buildEngine({ router, platform: stubPlatform('all') })
    const activeId = await startAndReachPhase(engine, 'signup')
    const out = await engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      observed_at: NOW_MS,
      freeform_text: 'why do you need my name?',
    })
    expect(out.state?.phase).toBe('signup')
    const phase_state = (out.state?.phase_state ?? {}) as Record<string, unknown>
    expect(phase_state['active_prompt_id']).toBe(activeId)
  })
})

describe('router action=amend whitelist (Argus r2 BLOCKING #2)', () => {
  test('non-whitelisted bookkeeping keys (created_at, owner_id) are REJECTED before stateStore.upsert', async () => {
    // Capture the engine warning so we can assert the structured log.
    const originalWarn = console.warn
    const warns: string[] = []
    console.warn = (...args: unknown[]) => {
      warns.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
    }
    try {
      const { router } = stubRouter([
        {
          action: 'amend',
          confidence: 0.92,
          choice_value: null,
          freeform_text: null,
          response: "Got it, I'll remember that.",
          state_delta: {
            // ALLOWED — survives the whitelist.
            user_first_name: 'Doe',
            // REJECTED — bookkeeping field the router has no business writing.
            created_at: '1970-01-01T00:00:00Z',
            // REJECTED — identity column.
            owner_id: 'attacker',
            // REJECTED — control flow column.
            active_prompt_id: 'attacker-prompt',
          } as unknown as Record<string, unknown>,
          reasoning: 'adversarial test',
        },
      ])
      // Retargeted 2026-06-03 from personality_offered (now mixed, no
      // router) to signup (still freeform) so the amend-key whitelist
      // SECURITY gate stays covered. The whitelist lives in
      // dispatchRouterDecision (and consumeChoice) and is phase-agnostic.
      //
      // onboarding-opening-fix (2026-06-19, BUG 1): an `amend` on signup
      // that carries a valid `user_first_name` now AUTO-ADVANCES off signup
      // (the double-ask fix) via the signup guard → consumeChoice. The
      // whitelist runs on BOTH the guard's path and consumeChoice's merge,
      // so the SECURITY property under test (bookkeeping keys rejected, the
      // attacker's active_prompt_id never lands) holds on the new advance
      // path too — which is exactly what we assert below.
      const engine = buildEngine({ router, platform: stubPlatform('all') })
      const activeId = await startAndReachPhase(engine, 'signup')
      const out = await engine.advance({
        project_slug: OWNER,
        topic_id: TOPIC,
        user_id: USER,
        channel_kind: 'app-socket',
        observed_at: NOW_MS,
        freeform_text: 'I want it to call me Doe',
      })
      const phase_state = (out.state?.phase_state ?? {}) as Record<string, unknown>
      // Signup advanced off (BUG 1 fix) — the name was captured, not re-asked.
      expect(out.state?.phase).not.toBe('signup')
      // Allowed key landed (carried forward in phase_state).
      expect(phase_state['user_first_name']).toBe('Doe')
      // Bookkeeping keys never landed.
      expect(phase_state['created_at']).toBeUndefined()
      expect(phase_state['owner_id']).toBeUndefined()
      // active_prompt_id MUST be an engine-minted value, never the attacker's.
      expect(phase_state['active_prompt_id']).not.toBe('attacker-prompt')
      // The warn line names every rejected key.
      const warnLine = warns.find((w) => w.includes('rejected non-whitelisted keys'))
      expect(warnLine).toBeDefined()
      expect(warnLine).toContain('created_at')
      expect(warnLine).toContain('owner_id')
      expect(warnLine).toContain('active_prompt_id')
    } finally {
      console.warn = originalWarn
    }
  })

  test('all-rejected state_delta still emits the agent response + re-emits keyboard', async () => {
    const originalWarn = console.warn
    console.warn = () => {}
    try {
      const { router } = stubRouter([
        {
          action: 'amend',
          confidence: 0.92,
          choice_value: null,
          freeform_text: null,
          response: "Noted.",
          state_delta: {
            created_at: '1970-01-01',
            __proto__: 'attacker',
          } as unknown as Record<string, unknown>,
          reasoning: 'all rejected',
        },
      ])
      // Retargeted 2026-06-03 personality_offered → signup (see above).
      const engine = buildEngine({ router, platform: stubPlatform('all') })
      const activeId = await startAndReachPhase(engine, 'signup')
      // onboarding-opening-fix (2026-06-19, BUG 1): the signup guard
      // auto-advances ONLY when a valid name signal is present. This amend
      // carries an all-rejected state_delta (no user_first_name) and a
      // NON-name freeform ("why does it matter?" — fails
      // extractAgentNameFromFreeform), so the guard returns null and the
      // generic amend tail runs: stay on signup, emit the ack, re-emit the
      // keyboard. This keeps the all-rejected whitelist gate covered on the
      // stay path (the name-bearing advance path is covered by the test
      // above).
      const out = await engine.advance({
        project_slug: OWNER,
        topic_id: TOPIC,
        user_id: USER,
        channel_kind: 'app-socket',
        observed_at: NOW_MS,
        freeform_text: 'why does it matter?',
      })
      // Phase stays + active_prompt_id intact.
      expect(out.state?.phase).toBe('signup')
      const phase_state = (out.state?.phase_state ?? {}) as Record<string, unknown>
      expect(phase_state['active_prompt_id']).toBe(activeId)
      // Response still fired.
      const ack = sentPrompts.find((p) => p.prompt.body.includes('Noted'))
      expect(ack).toBeDefined()
    } finally {
      console.warn = originalWarn
    }
  })
})

describe('router action=amend', () => {
  // SKIP 2026-06-03: personality_offered is now mixed — typed text is
  // validated as a custom personality description and routed straight to
  // consumeChoice, never the router. The amend mechanic itself stays
  // covered by the whitelist tests above (retargeted to signup).
  test.skip('personality_offered: "call me Doe" → state_delta merged, phase stays', async () => {
    const { router } = stubRouter([
      {
        action: 'amend',
        confidence: 0.93,
        choice_value: null,
        freeform_text: null,
        response: "Got it, I'll call you Doe. So what personality should I have?",
        state_delta: {
          // The router's `state_delta` is typed as
          // `Partial<RequiredFieldsState>` but the parser accepts any
          // plain-object value the LLM emits. We use a structural key
          // that lands in phase_state verbatim — the engine merges
          // shallow.
          user_first_name: 'Doe',
        } as Record<string, unknown>,
        reasoning: 'address preference',
      },
    ])
    const engine = buildEngine({ router, platform: stubPlatform('all') })
    const activeId = await startAndReachPhase(engine, 'personality_offered')
    const out = await engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      observed_at: NOW_MS,
      freeform_text: 'I want it to call me Doe',
    })
    expect(out.state?.phase).toBe('personality_offered')
    const phase_state = (out.state?.phase_state ?? {}) as Record<string, unknown>
    expect(phase_state['user_first_name']).toBe('Doe')
    expect(phase_state['active_prompt_id']).toBe(activeId)
    // Agent response was sent.
    const ack = sentPrompts.find((p) => p.prompt.body.includes("I'll call you Doe"))
    expect(ack).toBeDefined()
  })

  // 2026-06-05 — amend-redisplay typing-indicator fix. At
  // import_analysis_presented a freeform amend ("also add a Studio Sessions
  // project") is classified amend with state_delta but NO `response`. Pre-fix,
  // the branch only called reEmitKeyboard → re-sent the byte-identical analysis
  // prompt with the SAME prompt_id → the web client dedupes by prompt_id →
  // nothing renders → the typing indicator hangs forever (though the merge DID
  // persist). The fix emits a generic ack with a FRESH prompt_id so the client
  // renders + clears the indicator, AND the project is persisted.
  test('import_analysis_presented amend with NO response → AUTO-ADVANCES (gate-collapse #92) + project persists, no dead screen', async () => {
    // Gate-collapse (#92, 2026-06-05) — a bare `amend` on the single
    // content-review gate previously merged the correction then RE-EMITTED
    // the deduped keyboard and STAYED → dead screen (ack with no advance).
    // Now it applies the correction AND advances through the same hybrid
    // amend+advance tail the `advance` branch uses. The corrected project
    // list still persists; the next-phase prompt is the visible
    // continuation that clears the typing indicator (no separate fallback
    // ack needed, since we no longer stay on a deduped prompt).
    const { router, calls } = stubRouter([
      {
        action: 'amend',
        confidence: 0.95,
        choice_value: null,
        freeform_text: null,
        // The prod failure mode: the router classified amend but returned no
        // wording.
        response: null,
        state_delta: {
          primary_projects: ['Helperbot', 'Beacon', 'Studio Sessions'],
        } as Record<string, unknown>,
        reasoning: 'add a project',
      },
    ])
    const engine = buildEngine({ router, platform: stubPlatform('all') })
    const activeId = await startAndReachPhase(engine, 'import_analysis_presented', {
      user_first_name: 'Sam',
    })
    const out = await engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      observed_at: NOW_MS,
      freeform_text: 'also add a Studio Sessions project',
    })
    expect(calls.length).toBe(1)
    // Advanced OFF import_analysis_presented (no dead-screen stall).
    expect(out.outcome).toBe('advanced')
    expect(out.state?.phase).not.toBe('import_analysis_presented')
    // The added project PERSISTED via the whitelisted state_delta merge
    // (consumeChoice merges the delta before the per-phase handler runs).
    const phase_state = (out.state?.phase_state ?? {}) as Record<string, unknown>
    expect(phase_state['primary_projects']).toEqual([
      'Helperbot',
      'Beacon',
      'Studio Sessions',
    ])
    // A FRESH prompt (the next phase's) was emitted with a new prompt_id —
    // the client renders it and the typing indicator clears.
    const freshEmit = sentPrompts.find((p) => p.prompt.prompt_id !== activeId)
    expect(freshEmit).toBeDefined()
  })

  // Guard the complementary path: when the router DOES supply a `response`, the
  // engine uses that wording (no double-ack) — the fix must not regress it.
  test('import_analysis_presented amend WITH response → uses the router wording, no generic fallback', async () => {
    const { router } = stubRouter([
      {
        action: 'amend',
        confidence: 0.95,
        choice_value: null,
        freeform_text: null,
        response: 'Added Studio Sessions to your projects.',
        state_delta: {
          primary_projects: ['Helperbot', 'Studio Sessions'],
        } as Record<string, unknown>,
        reasoning: 'add a project',
      },
    ])
    const engine = buildEngine({ router, platform: stubPlatform('all') })
    await startAndReachPhase(engine, 'import_analysis_presented')
    await engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      observed_at: NOW_MS,
      freeform_text: 'also add a Studio Sessions project',
    })
    const specific = sentPrompts.find((p) =>
      p.prompt.body.includes('Added Studio Sessions'),
    )
    expect(specific).toBeDefined()
    const fallback = sentPrompts.find((p) => p.prompt.body === AMEND_ACK_FALLBACK_TEXT)
    expect(fallback).toBeUndefined()
  })
})

// Argus #3 (2026-06-05) — AMEND_ACK_FALLBACK_TEXT must be GATED to the
// non-switched path. On a source switch at import_upload_pending the fresh
// `import_upload_pending` re-render IS the acknowledgement; emitting the
// generic ack on top double-messages the user. The bug was latent — the
// `switched_source` branch only runs at import_upload_pending, which is
// now buttons-only, so the router (and `dispatchRouterDecision`) is never
// reached from `engine.advance` (proven by the SKIPPED suite below, whose
// `calls.length === 1` assertions fail when un-skipped). To pin the gating
// runnably we therefore drive the private `dispatchRouterDecision` directly
// with a `response:null` amend that carries a source switch — the exact
// shape the non-null `response` fixtures masked.
type DispatchableEngine = {
  dispatchRouterDecision: (
    input: unknown,
    state: unknown,
    spec: unknown,
    decision: RouterDecision,
    active_prompt_id: string,
    observed_at: number,
  ) => Promise<{ outcome: string; state?: { phase?: string } | null }>
}

describe('dispatchRouterDecision amend ack-gating (Argus #3 — no source-switch double-message)', () => {
  test('response:null + source SWITCH → fallback ack SUPPRESSED; fresh re-render is the only ack', async () => {
    const { router } = stubRouter([]) // not consulted — we call dispatch directly
    const engine = buildEngine({ router, platform: stubPlatform('all') })
    const activeId = await startAndReachPhase(engine, 'import_upload_pending', {
      ai_substrate_used: 'chatgpt',
    })
    const state = await stateStore.get(OWNER, USER)
    const input = {
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket' as const,
      observed_at: NOW_MS,
      freeform_text: 'actually can i upload claude instead',
    }
    const decision: RouterDecision = {
      action: 'amend',
      confidence: 0.9,
      choice_value: null,
      freeform_text: null,
      response: null, // the masked case — no router wording
      state_delta: { ai_substrate_used: 'claude' } as unknown as Record<string, unknown>,
      reasoning: 'source switch chatgpt->claude, no ack text',
    }
    const out = await (engine as unknown as DispatchableEngine).dispatchRouterDecision(
      input,
      state,
      // spec is unused on the amend branch (it re-resolves via emitPhasePrompt).
      {},
      decision,
      activeId,
      NOW_MS,
    )
    // The generic ack must NOT have fired — no double-message.
    const fallback = sentPrompts.find((p) => p.prompt.body === AMEND_ACK_FALLBACK_TEXT)
    expect(fallback).toBeUndefined()
    // The switch re-rendered a FRESH import_upload_pending prompt (the real ack),
    // and we stayed on phase.
    expect(out.outcome).toBe('reemitted_current')
    const bodies = sentPrompts.map((p) => p.prompt.body)
    expect(bodies.some((b) => b.includes('claude.ai'))).toBe(true)
    const finalState = await stateStore.get(OWNER, USER)
    const finalPhaseState = (finalState?.phase_state ?? {}) as Record<string, unknown>
    expect(finalPhaseState['ai_substrate_used']).toBe('claude')
    expect(finalPhaseState['active_prompt_id']).not.toBe(activeId)
  })

  test('response:null + SAME source (no switch) → fallback ack STILL fires (gating does not over-suppress)', async () => {
    const { router } = stubRouter([])
    const engine = buildEngine({ router, platform: stubPlatform('all') })
    const activeId = await startAndReachPhase(engine, 'import_upload_pending', {
      ai_substrate_used: 'chatgpt',
    })
    const state = await stateStore.get(OWNER, USER)
    const input = {
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket' as const,
      observed_at: NOW_MS,
      freeform_text: 'yeah chatgpt is fine',
    }
    const decision: RouterDecision = {
      action: 'amend',
      confidence: 0.9,
      choice_value: null,
      freeform_text: null,
      response: null,
      // SAME source as prior → switched_source is false → not a switch.
      state_delta: { ai_substrate_used: 'chatgpt' } as unknown as Record<string, unknown>,
      reasoning: 'same source, no ack text',
    }
    await (engine as unknown as DispatchableEngine).dispatchRouterDecision(
      input,
      state,
      {},
      decision,
      activeId,
      NOW_MS,
    )
    // No switch → the typing-indicator floor MUST still fire so the client
    // renders something and clears the optimistic indicator.
    const fallback = sentPrompts.find((p) => p.prompt.body === AMEND_ACK_FALLBACK_TEXT)
    expect(fallback).toBeDefined()
    expect(fallback!.prompt.prompt_id).not.toBe(activeId)
  })
})

// freeform-intent-spec.md (2026-06-03) — the import SOURCE-SWITCH regression.
// This is THE 2026-06-03 incident: at import_upload_pending with
// ai_substrate_used=chatgpt, the user typed "actually can i upload claude
// instead" and the bot advanced to import_running with an empty jobs table.
// The fix: classify a switch as `amend` carrying ai_substrate_used, then
// re-render the dynamic upload body for the NEW source (NOT reEmitKeyboard,
// which re-sent the stale ChatGPT instructions).
// SKIP 2026-06-03 (buttons-only sprint): the entire SOURCE-SWITCH path is
// router-driven on import_upload_pending, which is now buttons-only — the
// router (and the dispatchRouterDecision `switched_source` branch it
// drives) is never reached. This DELIBERATELY supersedes the same-day
// freeform source-switch fix (PR #357 / commit 8f0d33f). If source-switch
// is still wanted, it now needs a button (e.g. "Use Claude instead").
// Flagged in the sprint PR + STATUS for Sam's call. The dispatchRouter
// source-switch code is retained (dead for now) pending that decision.
describe.skip('router action=amend → import SOURCE SWITCH (2026-06-03 incident)', () => {
  test('"actually can i upload claude instead" → switch to Claude, re-render Claude instructions, NO advance', async () => {
    const { router, calls } = stubRouter([
      {
        action: 'amend',
        confidence: 0.9,
        choice_value: null,
        freeform_text: null,
        response: "Got it - switching to Claude. Here's how to export it:",
        state_delta: { ai_substrate_used: 'claude' } as unknown as Record<string, unknown>,
        reasoning: 'source switch chatgpt->claude',
      },
    ])
    const engine = buildEngine({ router, platform: stubPlatform('all') })
    // Seed at import_upload_pending with the PRIOR source = chatgpt, so the
    // seeded prompt body renders ChatGPT instructions.
    const activeId = await startAndReachPhase(engine, 'import_upload_pending', {
      ai_substrate_used: 'chatgpt',
    })
    const out = await engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      observed_at: NOW_MS,
      freeform_text: 'actually can i upload claude instead',
    })
    expect(calls.length).toBe(1)
    // CRITICAL — must NOT advance to import_running.
    expect(out.state?.phase).toBe('import_upload_pending')
    const phase_state = (out.state?.phase_state ?? {}) as Record<string, unknown>
    // The stored source is now claude.
    expect(phase_state['ai_substrate_used']).toBe('claude')
    // A FRESH prompt was emitted (different prompt_id from the seeded one).
    expect(typeof phase_state['active_prompt_id']).toBe('string')
    expect(phase_state['active_prompt_id']).not.toBe(activeId)
    // The re-rendered body shows CLAUDE instructions, never ChatGPT.
    const bodies = sentPrompts.map((p) => p.prompt.body)
    expect(bodies.some((b) => b.includes('claude.ai'))).toBe(true)
    expect(bodies.some((b) => b.includes('chatgpt.com'))).toBe(false)
    // The ack fired.
    expect(bodies.some((b) => b.includes('switching to Claude'))).toBe(true)
    // The user reply landed on the transcript.
    const userLines = transcript
      .readAll()
      .filter((e) => e.role === 'user')
      .map((e) => e.body)
    expect(userLines).toContain('actually can i upload claude instead')
  })

  test('switch to the SAME source is a no-op → keyboard re-emitted, active_prompt_id unchanged', async () => {
    const { router } = stubRouter([
      {
        action: 'amend',
        confidence: 0.9,
        choice_value: null,
        freeform_text: null,
        response: 'Sticking with ChatGPT.',
        state_delta: { ai_substrate_used: 'chatgpt' } as unknown as Record<string, unknown>,
        reasoning: 'same source',
      },
    ])
    const engine = buildEngine({ router, platform: stubPlatform('all') })
    const activeId = await startAndReachPhase(engine, 'import_upload_pending', {
      ai_substrate_used: 'chatgpt',
    })
    const out = await engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      observed_at: NOW_MS,
      freeform_text: 'yeah chatgpt is fine',
    })
    expect(out.state?.phase).toBe('import_upload_pending')
    const phase_state = (out.state?.phase_state ?? {}) as Record<string, unknown>
    expect(phase_state['ai_substrate_used']).toBe('chatgpt')
    // No fresh dynamic re-render — the same active prompt stays canonical.
    expect(phase_state['active_prompt_id']).toBe(activeId)
  })

  test('hallucinated source value is REJECTED → no switch, source unchanged, warn logged', async () => {
    const originalWarn = console.warn
    const warns: string[] = []
    console.warn = (...args: unknown[]) => {
      warns.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
    }
    try {
      const { router } = stubRouter([
        {
          action: 'amend',
          confidence: 0.9,
          choice_value: null,
          freeform_text: null,
          response: 'Hmm.',
          state_delta: { ai_substrate_used: 'gpt5-turbo' } as unknown as Record<string, unknown>,
          reasoning: 'bad source value',
        },
      ])
      const engine = buildEngine({ router, platform: stubPlatform('all') })
      const activeId = await startAndReachPhase(engine, 'import_upload_pending', {
        ai_substrate_used: 'chatgpt',
      })
      const out = await engine.advance({
        project_slug: OWNER,
        topic_id: TOPIC,
        user_id: USER,
        channel_kind: 'app-socket',
        observed_at: NOW_MS,
        freeform_text: 'use gpt5 turbo',
      })
      expect(out.state?.phase).toBe('import_upload_pending')
      const phase_state = (out.state?.phase_state ?? {}) as Record<string, unknown>
      // The bad value never landed; the prior source is intact.
      expect(phase_state['ai_substrate_used']).toBe('chatgpt')
      expect(phase_state['active_prompt_id']).toBe(activeId)
      const warnLine = warns.find((w) => w.includes('rejected non-whitelisted keys'))
      expect(warnLine).toBeDefined()
      expect(warnLine).toContain('ai_substrate_used')
    } finally {
      console.warn = originalWarn
    }
  })

  // Argus r1 BLOCKER (2026-06-03) — switch-BACK oscillation.
  // The first switch (chatgpt → claude) re-renders fine because the claude
  // body differs from the seeded chatgpt body. The bug bit on switch-BACK:
  // chatgpt → claude → chatgpt re-renders a chatgpt body that is
  // BYTE-IDENTICAL to the original chatgpt emit. With no distinguishing
  // seed, `emitPhasePrompt`'s idempotency key collapsed onto the prior
  // delivered row (was_new=false, was_delivered=true) → `sendButtonPrompt`
  // was SKIPPED → the user saw only the "switching to ChatGPT" ack with NO
  // re-pushed upload instructions. The fix folds `switch:<new_source>:
  // <observed_at>` into the seed so every switch forces a fresh delivered row.
  test('chatgpt → claude → chatgpt oscillation: switch-BACK re-renders instructions (NOT skipped)', async () => {
    const { router, calls } = stubRouter([
      {
        action: 'amend',
        confidence: 0.9,
        choice_value: null,
        freeform_text: null,
        response: "Switching to Claude. Here's how to export it:",
        state_delta: { ai_substrate_used: 'claude' } as unknown as Record<string, unknown>,
        reasoning: 'source switch chatgpt->claude',
      },
      {
        action: 'amend',
        confidence: 0.9,
        choice_value: null,
        freeform_text: null,
        response: "Switching to ChatGPT. Here's how to export it:",
        state_delta: { ai_substrate_used: 'chatgpt' } as unknown as Record<string, unknown>,
        reasoning: 'source switch claude->chatgpt (switch-back)',
      },
    ])
    const engine = buildEngine({ router, platform: stubPlatform('all') })
    // Seed at import_upload_pending with the ORIGINAL source = chatgpt.
    const activeId0 = await startAndReachPhase(engine, 'import_upload_pending', {
      ai_substrate_used: 'chatgpt',
    })

    // Switch 1: chatgpt → claude (distinct observed_at, mirroring real turns).
    await engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      observed_at: NOW_MS + 1_000,
      freeform_text: 'actually can i upload claude instead',
    })
    const afterSwitch1 = await stateStore.get(OWNER, USER)
    const activeId1 = afterSwitch1?.phase_state['active_prompt_id'] as string
    expect(activeId1).not.toBe(activeId0)

    // Isolate the switch-BACK emit: drop everything sent so far.
    sentPrompts.length = 0

    // Switch 2 (switch-BACK): claude → chatgpt. The re-rendered chatgpt body
    // is byte-identical to the original chatgpt emit at activeId0.
    const out = await engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      observed_at: NOW_MS + 2_000,
      freeform_text: 'actually never mind, back to chatgpt',
    })

    expect(calls.length).toBe(2)
    // Still parked at import_upload_pending — no spurious advance.
    expect(out.state?.phase).toBe('import_upload_pending')
    const phase_state = (out.state?.phase_state ?? {}) as Record<string, unknown>
    expect(phase_state['ai_substrate_used']).toBe('chatgpt')

    // (1) Instructions ARE re-rendered: a NEW button_prompts row, distinct
    // from BOTH the original chatgpt emit AND the intervening claude emit.
    const activeId2 = phase_state['active_prompt_id'] as string
    expect(typeof activeId2).toBe('string')
    expect(activeId2).not.toBe(activeId0)
    expect(activeId2).not.toBe(activeId1)

    // (2) sendButtonPrompt was CALLED (not skipped): the switch-back emit
    // produced sends after the log was cleared.
    const bodies = sentPrompts.map((p) => p.prompt.body)
    expect(bodies.length).toBeGreaterThan(0)

    // (3) The re-pushed body matches the ChatGPT instructions block.
    expect(bodies.some((b) => b.includes('chatgpt.com'))).toBe(true)
    expect(bodies.some((b) => b.includes('claude.ai'))).toBe(false)
  })
})

describe('flag-off / unwired router fall-through', () => {
  test('platform absent → router NEVER fires, v2 path stays unchanged', async () => {
    const { router, calls } = stubRouter([])
    const engine = buildEngine({ router }) // NO platform
    await startAndReachPhase(engine, 'signup')
    await engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      observed_at: NOW_MS,
      freeform_text: 'Sam',
    })
    expect(calls.length).toBe(0)
  })

  test('phase has null knowledge → router NEVER fires for that phase', async () => {
    const { router, calls } = stubRouter([])
    // wow_fired is one of the forever-null transit phases — its
    // PHASE_KNOWLEDGE entry stays null after S3. Even with the flag on,
    // the router does not fire on it.
    const engine = buildEngine({ router, platform: stubPlatform('all') })
    await startAndReachPhase(engine, 'wow_fired')
    await engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      observed_at: NOW_MS,
      freeform_text: 'random text',
    })
    expect(calls.length).toBe(0)
  })

  test('phases is empty Set → router NEVER fires', async () => {
    const { router, calls } = stubRouter([])
    const engine = buildEngine({ router, platform: stubPlatform([]) })
    await startAndReachPhase(engine, 'signup')
    await engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      observed_at: NOW_MS,
      freeform_text: 'Sam',
    })
    expect(calls.length).toBe(0)
  })

  test('phases=Set([import_upload_pending]) → fires on that phase only', async () => {
    const { router, calls } = stubRouter([
      {
        action: 'answer',
        confidence: 0.9,
        choice_value: null,
        freeform_text: null,
        response: 'Claude steps...',
        state_delta: null,
        reasoning: 'tangent',
      },
    ])
    const engine = buildEngine({
      router,
      platform: stubPlatform(['import_upload_pending']),
    })
    // signup is NOT in the phase set — should NOT fire.
    await startAndReachPhase(engine, 'signup')
    await engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      observed_at: NOW_MS,
      freeform_text: 'Sam',
    })
    expect(calls.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// P2-v3 S3 (2026-05-18) — coverage tests for the seven new packs.
// ---------------------------------------------------------------------------
//
// Implementation note for `max_oauth_offered`. That phase is the only S3
// phase with shape=`pick-only` (PHASE_INTENTS) and `allow_freeform: false`
// (STATIC_PHASE_SPECS). The engine's freeform fall-through in
// `normalAdvance` guards on `spec.allow_freeform` before consulting the
// router, so under the CURRENT engine wiring the router never fires when
// the user types text on max_oauth_offered — the input is recorded and
// the keyboard is re-emitted. The pack still exists so the router has
// the knowledge available IF / WHEN a future sprint widens the engine to
// route pick-only freeform; pack content invariants are exercised in
// phase-knowledge.test.ts. The S3 integration tests below therefore
// cover only the six free-text S3 phases via the engine path, plus an
// explicit guard test documenting the current pick-only behaviour.

import { PHASE_KNOWLEDGE } from '../phase-spec-resolver.ts'

const S3_FREEFORM_PHASES: ReadonlyArray<OnboardingPhase> = [
  'import_analysis_presented',
  'work_interview_gap_fill',
  'agent_name_chosen',
  'slug_chosen',
  'projects_proposed',
  'persona_reviewed',
]

// Seed state per phase to satisfy any upstream gates (e.g. slug suggester
// reads suggested_slug; projects_proposed reads primary_projects). Each
// patch keeps state minimal but valid enough to emit a prompt.
const SEED_STATE: Readonly<Record<OnboardingPhase, Record<string, unknown>>> = {
  import_analysis_presented: {
    user_first_name: 'Sam',
    primary_projects: ['Topline', 'Northwind', 'Beacon'],
  },
  work_interview_gap_fill: {
    user_first_name: 'Sam',
  },
  agent_name_chosen: {
    user_first_name: 'Sam',
  },
  slug_chosen: {
    user_first_name: 'Sam',
    agent_name: 'Atlas',
    suggested_slug: 'sam',
  },
  projects_proposed: {
    user_first_name: 'Sam',
    primary_projects: ['Topline', 'Northwind', 'Beacon', 'CC', 'Acme'],
  },
  persona_reviewed: {
    user_first_name: 'Sam',
    agent_name: 'Atlas',
    chosen_slug: 'sam',
  },
  max_oauth_offered: {
    user_first_name: 'Sam',
    agent_name: 'Atlas',
    chosen_slug: 'sam',
  },
  // Unused but required to satisfy the Record<OnboardingPhase, ...> type.
  signup: {},
  identity_oauth: {},
  instance_provisioned: {},
  ai_substrate_offered: {},
  import_upload_pending: {},
  import_running: {},
  personality_offered: {},
  persona_synthesizing: {},
  wow_fired: {},
  completed: {},
  failed: {},
}

// Tangent-coverage loop — one engine integration test per
// expected_tangent across the six free-text S3 phases. Each test stubs
// the router to return the brief-declared action (answer or amend) and
// asserts the engine STAYS on the same phase, posts the agent response
// (if any), and on `amend` merges the state_delta. ~36 tests total.
for (const phase of S3_FREEFORM_PHASES) {
  const pack = PHASE_KNOWLEDGE[phase]
  if (pack === null) {
    // Defensive — S3 phases must have a pack after this sprint.
    throw new Error(`S3 phase ${phase} has null PHASE_KNOWLEDGE entry — pack missing.`)
  }
  // 2026-06-03: router-driven tangent FAQ only runs on phases still in
  // 'freeform' mode (work_interview_gap_fill). Reclassified buttons-only/
  // mixed phases skip — their typed questions now get the canned nudge.
  const tangentRunner = INTERACTION_MODE_BY_PHASE[phase] === 'freeform' ? test : test.skip
  describe(`S3 tangent coverage | phase=${phase}`, () => {
    for (let i = 0; i < pack.expected_tangents.length; i += 1) {
      const tangent = pack.expected_tangents[i]!
      tangentRunner(`tangent #${i}: ${tangent.summary}`, async () => {
        // Use a whitelisted key (auxiliary_facts is in ROUTER_AMEND_ALLOWED_KEYS per S2 r2)
        // and a phase:i marker so the test still verifies the merge landed.
        const stubDelta =
          tangent.expected_action === 'amend'
            ? ({ auxiliary_facts: { s3_tangent_amend_marker: `${phase}:${i}` } } as Record<string, unknown>)
            : null
        const { router, calls } = stubRouter([
          {
            action: tangent.expected_action,
            confidence: 0.92,
            choice_value: null,
            freeform_text: null,
            response: `STUB-S3-RESPONSE-${phase}-${i}`,
            state_delta: stubDelta as never,
            reasoning: tangent.summary.slice(0, 100),
          },
        ])
        const engine = buildEngine({ router, platform: stubPlatform('all') })
        const activeId = await startAndReachPhase(engine, phase, SEED_STATE[phase])
        const out = await engine.advance({
          project_slug: OWNER,
          topic_id: TOPIC,
          user_id: USER,
          channel_kind: 'app-socket',
          observed_at: NOW_MS,
          freeform_text: tangent.user_text_example,
        })

        // Router was consulted exactly once for this turn.
        expect(calls.length).toBe(1)
        expect(calls[0]?.input.phase).toBe(phase)
        expect(calls[0]?.input.user_text).toBe(tangent.user_text_example)
        const phase_state = (out.state?.phase_state ?? {}) as Record<string, unknown>
        const sentBodies = sentPrompts.map((p) => p.prompt.body)
        // Gate-collapse (#92, 2026-06-05) — at import_analysis_presented a
        // bare `amend` now AUTO-ADVANCES (the correction is applied via the
        // hybrid amend+advance tail and the phase moves on; the old
        // stay-and-re-emit dead-screen is gone). Every OTHER phase, and the
        // `answer` action, keep the legacy stay-on-phase behaviour.
        const amendAdvances =
          phase === 'import_analysis_presented' && tangent.expected_action === 'amend'
        if (amendAdvances) {
          // Advanced OFF import_analysis_presented.
          expect(out.state?.phase).not.toBe('import_analysis_presented')
          // Agent response (ack) was posted before advancing.
          expect(sentBodies.some((b) => b.includes(`STUB-S3-RESPONSE-${phase}-${i}`))).toBe(true)
          // The amend state_delta still merged (auxiliary_facts whitelisted).
          const aux = phase_state['auxiliary_facts'] as Record<string, unknown> | undefined
          expect(aux?.['s3_tangent_amend_marker']).toBe(`${phase}:${i}`)
        } else {
          // Phase stays put (answer + non-import amends per design § 2.3).
          expect(out.state?.phase).toBe(phase)
          expect(phase_state['active_prompt_id']).toBe(activeId)
          // Agent response was posted.
          expect(sentBodies.some((b) => b.includes(`STUB-S3-RESPONSE-${phase}-${i}`))).toBe(true)
          // On amend, the state_delta merged into phase_state. Accesses
          // auxiliary_facts.s3_tangent_amend_marker since we route through the
          // S2-r2 whitelisted auxiliary_facts key.
          if (tangent.expected_action === 'amend') {
            const aux = phase_state['auxiliary_facts'] as Record<string, unknown> | undefined
            expect(aux?.['s3_tangent_amend_marker']).toBe(`${phase}:${i}`)
          }
          // The keyboard was re-emitted (active prompt stays anchored).
          const reEmitted = sentPrompts.find((p) => p.prompt.prompt_id === activeId)
          expect(reEmitted).toBeDefined()
        }
      })
    }
  })
}

// Per-phase happy-path advance tests — one per free-text S3 phase. Each
// stubs the router to return `advance` with the first advance_example
// from the pack and asserts the engine progresses past the phase.
describe('S3 per-phase advance happy paths', () => {
  for (const phase of S3_FREEFORM_PHASES) {
    const pack = PHASE_KNOWLEDGE[phase]!
    const example = pack.advance_examples[0]
    if (example === undefined) continue
    // 2026-06-03: only the still-freeform phases advance via the router.
    const advanceRunner = INTERACTION_MODE_BY_PHASE[phase] === 'freeform' ? test : test.skip
    advanceRunner(`${phase}: typed "${example.user_text_example.slice(0, 30)}" advances past the phase`, async () => {
      const { router, calls } = stubRouter([
        {
          action: 'advance',
          confidence: 0.95,
          choice_value: example.canonical_value,
          freeform_text:
            example.canonical_value === null ? example.user_text_example : null,
          response: null,
          state_delta: null,
          reasoning: example.summary.slice(0, 100),
        },
      ])
      const engine = buildEngine({ router, platform: stubPlatform('all') })
      await startAndReachPhase(engine, phase, SEED_STATE[phase])
      const out = await engine.advance({
        project_slug: OWNER,
        topic_id: TOPIC,
        user_id: USER,
        channel_kind: 'app-socket',
        observed_at: NOW_MS,
        freeform_text: example.user_text_example,
      })
      expect(calls.length).toBe(1)
      expect(calls[0]?.input.phase).toBe(phase)
      // Phase advanced off the source phase (engine may walk auto-skips
      // / self-loops — what matters is we did not stay stuck).
      // work_interview_gap_fill is allowed to self-loop while gaps
      // remain; the advance still moves through consumeChoice, so we
      // assert that the router was called and consumeChoice fired by
      // checking the transcript carries the user text.
      const userLines = transcript
        .readAll()
        .filter((e) => e.role === 'user')
        .map((e) => e.body)
      expect(userLines).toContain(example.user_text_example)
      // For phases with a single forward edge AND no required external
      // hook, assert we did advance. Two phases are exempt:
      //  - work_interview_gap_fill self-loops while the audit reports
      //    gaps (test seed has no projects/interests filled in).
      //  - slug_chosen depends on a `slugPicker` hook this stub
      //    engine doesn't wire — without it the consume cascade
      //    surfaces a soft "picker not configured" rejection and stays
      //    on phase. The router consult is the contract we care about
      //    here; slug-picker integration is tested elsewhere.
      if (phase !== 'work_interview_gap_fill' && phase !== 'slug_chosen') {
        expect(out.state?.phase).not.toBe(phase)
      }
    })
  }
})

// The five brief-named "high-leverage" cases (§ 5.2). #4
// (max_oauth_offered verbose advance) is adapted to document the
// current pick-only engine behaviour; the integration we'd want there
// requires an engine widening for pick-only freeform routing — out of
// scope per the sprint brief.
describe('S3 high-leverage cases (brief § 5.2)', () => {
  test('#1 work_interview_gap_fill escape-hatch: skip-rest stays on phase', async () => {
    const explanation =
      "You can skip individual questions but not the full gap-fill — every required field has to land before persona can synthesise."
    const { router, calls } = stubRouter([
      {
        action: 'answer',
        confidence: 0.94,
        choice_value: null,
        freeform_text: null,
        response: explanation,
        state_delta: null,
        reasoning: 'escape_hatch_route_to_can_skip',
      },
    ])
    const engine = buildEngine({ router, platform: stubPlatform('all') })
    const activeId = await startAndReachPhase(
      engine,
      'work_interview_gap_fill',
      SEED_STATE['work_interview_gap_fill'],
    )
    const out = await engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      observed_at: NOW_MS,
      freeform_text: "I'd rather skip the rest of the questions",
    })
    expect(calls.length).toBe(1)
    expect(out.state?.phase).toBe('work_interview_gap_fill')
    const phase_state = (out.state?.phase_state ?? {}) as Record<string, unknown>
    expect(phase_state['active_prompt_id']).toBe(activeId)
    // The required-field-floor explanation was posted as an agent
    // bubble.
    expect(sentPrompts.some((p) => p.prompt.body.includes('required field'))).toBe(true)
  })

  // SKIP 2026-06-03: slug_chosen is now mixed (validated custom_slug, no
  // router) — there is no router-driven tangent-then-advance anymore.
  test.skip('#2 slug_chosen tangent-then-advance: two turns, two router calls', async () => {
    const tangentAnswer =
      "The slug is your subdomain (e.g. sam.neutron.example), your Telegram handle (@<slug>neutronbot), and your project directory."
    const { router, calls } = stubRouter([
      {
        action: 'answer',
        confidence: 0.93,
        choice_value: null,
        freeform_text: null,
        response: tangentAnswer,
        state_delta: null,
        reasoning: 'tangent_route_to_what_is_the_slug_used_for',
      },
      {
        action: 'advance',
        confidence: 0.96,
        choice_value: null,
        freeform_text: 'sam',
        response: null,
        state_delta: null,
        reasoning: 'slug_confirmed',
      },
    ])
    const engine = buildEngine({ router, platform: stubPlatform('all') })
    const activeId = await startAndReachPhase(engine, 'slug_chosen', SEED_STATE['slug_chosen'])

    // Turn 1 — tangent. Phase stays put.
    const t1 = await engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      observed_at: NOW_MS,
      freeform_text: 'is the slug used for anything other than the URL?',
    })
    expect(t1.state?.phase).toBe('slug_chosen')
    const phase_state_after_t1 = (t1.state?.phase_state ?? {}) as Record<string, unknown>
    expect(phase_state_after_t1['active_prompt_id']).toBe(activeId)

    // Turn 2 — advance with the confirmed slug.
    const t2 = await engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      observed_at: NOW_MS,
      freeform_text: 'sam',
    })

    expect(calls.length).toBe(2)
    expect(calls[0]?.input.user_text).toBe(
      'is the slug used for anything other than the URL?',
    )
    expect(calls[1]?.input.user_text).toBe('sam')
    // After the second turn the user's slug landed on the transcript
    // via the consumeChoice cascade. Whether the engine fully advances
    // depends on the slugPicker hook (not wired in this stub harness);
    // the contract this test asserts is the two-turn router routing
    // (one answer, one advance) with both decisions reaching the
    // engine.
    const userLines2 = transcript
      .readAll()
      .filter((e) => e.role === 'user')
      .map((e) => e.body)
    expect(userLines2).toContain('sam')
    void t2
  })

  // ISSUES #117 (2026-06-10) — UN-SKIPPED + rewritten. The 2026-06-03 skip
  // deferred typed projects_proposed edits to the canned nudge + post-onboarding
  // tools. The GAP1 union (2026-06-09) re-decided that a freeform "drop X / add
  // Y" on the POPULATED list-review should be APPLIED, but wired it on the
  // prod-dead `promptDriver` drain. The #117 fix re-homes it onto the prod-wired
  // llmRouter: a populated-list edit now reaches the router (interaction-mode
  // override) and an `amend` applies the additive `(seeded ∪ adds) minus
  // removed_projects` union, stays on phase, and re-emits the re-rendered list.
  test('#3 projects_proposed amend: drop-one applies the additive union (prod-wired router path)', async () => {
    const seeded = SEED_STATE['projects_proposed'][
      'primary_projects'
    ] as ReadonlyArray<string>
    const { router, calls } = stubRouter([
      {
        action: 'amend',
        confidence: 0.92,
        choice_value: null,
        freeform_text: null,
        response: 'Dropped CC from the list.',
        // The router anchors the restated kept list to a SHORTER subset but
        // names the removal explicitly. The union keeps the rest of the seeded
        // list and subtracts only the named project.
        state_delta: {
          primary_projects: ['Topline', 'Northwind'],
          removed_projects: ['CC'],
        } as never,
        reasoning: 'amend_drop_project',
      },
    ])
    const engine = buildEngine({ router, platform: stubPlatform('all') })
    await startAndReachPhase(
      engine,
      'projects_proposed',
      SEED_STATE['projects_proposed'],
    )
    const out = await engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      observed_at: NOW_MS,
      freeform_text: 'drop CC',
    })
    expect(calls.length).toBe(1)
    // Stays on the confirm gate (an edit is not a confirm).
    expect(out.state?.phase).toBe('projects_proposed')
    const phase_state = (out.state?.phase_state ?? {}) as Record<string, unknown>
    const primary = phase_state['primary_projects'] as ReadonlyArray<string>
    // (seeded ∪ {Topline, Northwind}) minus {CC} — every seeded project except CC.
    expect(primary).not.toContain('CC')
    for (const p of seeded.filter((p) => p !== 'CC')) {
      expect(primary).toContain(p)
    }
    expect(primary.length).toBe(seeded.length - 1)
    // The transient removal signal never persists.
    expect(phase_state['removed_projects']).toBeUndefined()
  })

  test('#4 max_oauth_offered pick-only: freeform text records + re-emits, router not consulted', async () => {
    // S3 documentation gap (engine-wiring scope is S2-frozen): the
    // engine's `normalAdvance` short-circuits to record + re-emit when
    // `spec.allow_freeform` is false. max_oauth_offered is the only S3
    // phase with `allow_freeform: false`, so the router never fires
    // here on typed text. Future engine widening would route this
    // through the LLM router with the pack's canonical_value
    // 'attach_max' mapping; for now we pin current behaviour.
    const { router, calls } = stubRouter([])
    const engine = buildEngine({ router, platform: stubPlatform('all') })
    const activeId = await startAndReachPhase(
      engine,
      'max_oauth_offered',
      SEED_STATE['max_oauth_offered'],
    )
    const out = await engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      observed_at: NOW_MS,
      freeform_text: "let's attach my Max subscription",
    })
    // Router NOT called.
    expect(calls.length).toBe(0)
    // Phase stays put.
    expect(out.state?.phase).toBe('max_oauth_offered')
    // The user's reply landed on the transcript.
    const userLines = transcript
      .readAll()
      .filter((e) => e.role === 'user')
      .map((e) => e.body)
    expect(userLines).toContain("let's attach my Max subscription")
    // active_prompt_id is preserved as a non-empty string. (The engine
    // may dedupe the re-emit when the same prompt is already in the
    // ButtonStore — we don't assert on send-count.)
    const phase_state = (out.state?.phase_state ?? {}) as Record<string, unknown>
    expect(typeof phase_state['active_prompt_id']).toBe('string')
    expect((phase_state['active_prompt_id'] as string).length).toBeGreaterThan(0)
    void activeId
  })

  // SKIP 2026-06-03: persona_reviewed is now buttons-only — the
  // router-driven "revisit" amend is retired; revisits happen via the
  // post-onboarding owner tools (update_personality / update_agent_name).
  test.skip('#5 persona_reviewed revisit: amend stashes revisit_target, phase stays', async () => {
    const { router, calls } = stubRouter([
      {
        action: 'amend',
        confidence: 0.91,
        choice_value: null,
        freeform_text: null,
        response: "Got it - we'll redo the personality. One moment.",
        state_delta: {
          // S2-r2 whitelist requires canonical keys; revisit_target lives
          // under auxiliary_facts. (S3 r2 Argus fix demoted the actual
          // tangents from amend to answer, but this test still exercises
          // the amend wiring with a whitelisted shape.)
          auxiliary_facts: { revisit_target: 'personality_offered' },
        } as never,
        reasoning: 'revisit_personality',
      },
    ])
    const engine = buildEngine({ router, platform: stubPlatform('all') })
    const activeId = await startAndReachPhase(
      engine,
      'persona_reviewed',
      SEED_STATE['persona_reviewed'],
    )
    const out = await engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      observed_at: NOW_MS,
      freeform_text: 'the personality feels off',
    })
    expect(calls.length).toBe(1)
    expect(out.state?.phase).toBe('persona_reviewed')
    const phase_state = (out.state?.phase_state ?? {}) as Record<string, unknown>
    const aux2 = phase_state['auxiliary_facts'] as Record<string, unknown> | undefined
    expect(aux2?.['revisit_target']).toBe('personality_offered')
    expect(phase_state['active_prompt_id']).toBe(activeId)
  })
})
