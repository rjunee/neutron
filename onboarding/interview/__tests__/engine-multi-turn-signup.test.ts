/**
 * Argus r1 (2026-05-10) — end-to-end multi-turn signup integration.
 *
 * Replays a 4-turn signup conversation through `engine.advance(...)` —
 * the production code path. Pins the contract that:
 *
 *   1. The S1_HARDCODED_NEXT_PHASE shortcut is gone — a user reply at
 *      signup no longer auto-advances to name_chosen on turn 1.
 *   2. The engine respects the LLM driver's `next_phase_on_default`
 *      stay/advance signal. Turns 1-3 keep the engine on `signup` and
 *      re-emit a fresh prompt body per turn.
 *   3. On the advance turn, the LLM-extracted `agent_name` and `slug`
 *      survive — they're written to `phase_state.agent_name` and
 *      `phase_state.suggested_slug` (the keys the slug picker reads,
 *      NOT the dead `extracted_slug` key the prior code used).
 *   4. The 4-turn engine path matches the unit-test view of the same
 *      conversation: same LLM stub, same expected end-state.
 *
 * The bug Argus flagged: the unit test covered the driver in isolation
 * but the engine end-to-end path advanced on turn 1 (S1 shortcut) and
 * never replayed turns 2-4.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '../../../migrations/runner.ts'
import { ProjectDb } from '../../../persistence/index.ts'
import { ButtonStore } from '../../../channels/button-store.ts'
import type { ButtonPrompt } from '../../../channels/button-primitive.ts'
import { InterviewEngine } from '../engine.ts'
import { InMemoryOnboardingStateStore } from '../state-store.ts'
import { TranscriptWriter } from '../transcript.ts'
import type {
  DrivenPhasePromptSpec,
  GeneratePromptInput,
} from '../llm-prompt-driver.ts'

let tmp: string
let db: ProjectDb
let buttonStore: ButtonStore
let stateStore: InMemoryOnboardingStateStore
let transcript: TranscriptWriter
let sentPrompts: Array<{ project_slug: string; topic_id: string; prompt: ButtonPrompt }>

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-multi-turn-'))
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

function makeEngine(
  promptDriver: (input: GeneratePromptInput) => Promise<DrivenPhasePromptSpec>,
): InterviewEngine {
  return new InterviewEngine({
    buttonStore,
    stateStore,
    transcript,
    sendButtonPrompt: async (input) => {
      sentPrompts.push(input)
      return { message_id: `msg-${sentPrompts.length}`, was_new: true }
    },
    promptDriver,
  })
}

/**
 * Scripted LLM driver that replays Sam's example signup.
 *
 *   Turn 0 (start):  driver emits opening prompt; stay
 *   Turn 1 (user 1): user types name → driver acknowledges; stay
 *   Turn 2 (user 2): user adds archetype context → stay one more turn
 *   Turn 3 (user 3): user picks slug → driver extracts slug, advances
 */
function makeScriptedDriver(): {
  driver: (input: GeneratePromptInput) => Promise<DrivenPhasePromptSpec>
  calls: GeneratePromptInput[]
} {
  const calls: GeneratePromptInput[] = []
  let turn = 0
  const driver = async (input: GeneratePromptInput): Promise<DrivenPhasePromptSpec> => {
    calls.push(input)
    if (input.phase !== 'signup') {
      // Subsequent phases (name_chosen is auto-skipped to slug_chosen,
      // which is special-cased and bypasses the driver) shouldn't
      // arrive here on the signup-only multi-turn test. If the engine
      // does land here, return a benign fallback that doesn't loop.
      return {
        phase: input.phase,
        body: 'continuing',
        options: [],
        allow_freeform: true,
        next_phase_on_default: input.phase,
        is_fallback: false,
      }
    }
    turn += 1
    if (turn === 1) {
      return {
        phase: 'signup',
        body: "Hey — what should I call you, and what kind of agent voice do you want?",
        options: [],
        allow_freeform: true,
        next_phase_on_default: 'signup',
        is_fallback: false,
      }
    }
    if (turn === 2) {
      // User just said "I'm Sam, like sherlock-but-warmer".
      return {
        phase: 'signup',
        body: "Got it Sam, sherlock-but-warmer. Anything else worth knowing about how you want me to sound?",
        options: [],
        allow_freeform: true,
        next_phase_on_default: 'signup',
        is_fallback: false,
        extracted_fields: {
          agent_name: 'Sam',
          archetypes: ['sherlock-but-warmer'],
        },
      }
    }
    if (turn === 3) {
      // User added "and a bit like Marcus Aurelius".
      return {
        phase: 'signup',
        body: "Ok Sam — got Sherlock-but-warmer + Marcus. What URL slug do you want?",
        options: [],
        allow_freeform: true,
        next_phase_on_default: 'signup',
        is_fallback: false,
        extracted_fields: {
          archetypes: ['sherlock-but-warmer', 'marcus aurelius'],
        },
      }
    }
    // Turn 4 — user picks the slug. Driver extracts + advances.
    // 2026-05-14 — T9: signup advances to `instance_provisioned` (the
    // spec'd next phase per docs/plans/P2-onboarding.md § 2.8). Pre-T9
    // this drove signup → name_chosen as a shortcut, bypassing
    // import_offered + archetype_picked. instance_provisioned is in
    // AUTO_SKIP_PHASES so the engine walks straight to import_offered.
    return {
      phase: 'signup',
      body: "Locked in — nova.neutron.example it is.",
      options: [],
      allow_freeform: true,
      next_phase_on_default: 'instance_provisioned',
      is_fallback: false,
      extracted_fields: {
        agent_name: 'Sam',
        slug: 'nova',
        archetypes: ['sherlock-but-warmer', 'marcus aurelius'],
      },
    }
  }
  return { driver, calls }
}

describe('InterviewEngine — multi-turn signup end-to-end', () => {
  test('stays at signup across 3 user turns and advances on turn 4 with extracted fields', async () => {
    const { driver, calls } = makeScriptedDriver()
    const engine = makeEngine(driver)
    const project = 't1'
    const topic = 'web:u-1'

    // Turn 0 — open onboarding. Driver emits opening prompt.
    await engine.start({
      project_slug: project,
      topic_id: topic,
      user_id: 'u-1',
      signup_via: 'web',
    })
    let state = await stateStore.get(project, 'u-1')
    expect(state).not.toBeNull()
    expect(state!.phase).toBe('signup')
    expect(sentPrompts.length).toBe(1)

    // Turn 1 — user replies with their name. Engine MUST NOT advance.
    await engine.advance({
      project_slug: project,
      topic_id: topic,
      user_id: 'u-1',
      channel_kind: 'app-socket',
      freeform_text: "I'm Sam, like sherlock-but-warmer",
    })
    state = await stateStore.get(project, 'u-1')
    expect(state!.phase).toBe('signup')
    expect(state!.phase_state['agent_name']).toBe('Sam')

    // Turn 2 — user adds archetype context. Still at signup.
    await engine.advance({
      project_slug: project,
      topic_id: topic,
      user_id: 'u-1',
      channel_kind: 'app-socket',
      freeform_text: 'and a bit like Marcus Aurelius',
    })
    state = await stateStore.get(project, 'u-1')
    expect(state!.phase).toBe('signup')

    // Turn 3 — user picks a slug. Driver advances to instance_provisioned.
    // 2026-05-14 — T9: post-T9 the spec'd flow walks
    //   signup → instance_provisioned (auto-skip) → import_offered
    // so the user lands at the import-substrate picker (NOT
    // time_style_picked — that's downstream of import_offered →
    // archetype_picked → name_chosen). The LLM-extracted
    // `suggested_slug` still lands on phase_state so the later slug
    // picker entry has the seed available.
    await engine.advance({
      project_slug: project,
      topic_id: topic,
      user_id: 'u-1',
      channel_kind: 'app-socket',
      freeform_text: 'nova',
    })
    state = await stateStore.get(project, 'u-1')

    // The engine advanced past signup. AUTO_SKIP_PHASES walks
    // instance_provisioned → import_offered so the user lands at the
    // import-substrate picker — the first interactive phase after
    // signup per § 2.3.
    expect(state!.phase).toBe('ai_substrate_offered')

    // Argus r1 BLOCKER fix: the LLM-extracted slug survives. Pre-fix
    // it was written to the dead `extracted_slug` key and silently
    // dropped. The slug picker (entered later) reads `suggested_slug`.
    expect(state!.phase_state['suggested_slug']).toBe('nova')
    expect(state!.phase_state['agent_name']).toBe('Sam')

    // The driver was called once per emit cycle — once on start +
    // once per user-reply that re-emits the same signup prompt +
    // once on the advance turn. Total 4 LLM-driver calls on the
    // signup phase.
    const signupCalls = calls.filter((c) => c.phase === 'signup')
    expect(signupCalls.length).toBe(4)

    // Every signup re-emit landed a fresh agent body in the
    // transcript so the user sees a NEW conversational turn instead
    // of the same prompt re-keyed.
    const agentSignupTurns = transcript
      .readAll()
      .filter((e) => e.role === 'agent' && e.phase === 'signup')
    expect(agentSignupTurns.length).toBeGreaterThanOrEqual(3)
  })

  test('static fallback (no LLM driver) advances signup → instance_provisioned → (auto-skip) → import_offered on first reply', async () => {
    // Without a driver, the static fallback returns
    // next_phase_on_default='instance_provisioned' (post-T9 — see
    // STATIC_PHASE_SPECS.signup). The very first user reply advances
    // and the AUTO_SKIP_PHASES walker chains through instance_provisioned
    // to import_offered (the first interactive prompt after signup per
    // § 2.3). This preserves the LLM-unwired safety net while routing
    // through every spec'd phase.
    const engine = new InterviewEngine({
      buttonStore,
      stateStore,
      transcript,
      sendButtonPrompt: async (input) => {
        sentPrompts.push(input)
        return { message_id: `msg-${sentPrompts.length}`, was_new: true }
      },
    })
    const project = 't1'
    const topic = 'web:u-1'
    await engine.start({
      project_slug: project,
      topic_id: topic,
      user_id: 'u-1',
      signup_via: 'web',
    })
    await engine.advance({
      project_slug: project,
      topic_id: topic,
      user_id: 'u-1',
      channel_kind: 'app-socket',
      freeform_text: 'Sam',
    })
    const state = await stateStore.get(project, 'u-1')
    expect(state!.phase).toBe('ai_substrate_offered')
    // P2 v2 S3 (2026-05-16, Codex r1 P1) — signup writes the user's
    // first name to `phase_state.user_first_name`, not `agent_name`.
    // The agent's name is collected later at the dedicated
    // `agent_name_chosen` phase (§ 3.10). Pre-S3 the static-fallback
    // heuristic conflated the two; v2 separates them.
    expect(state!.phase_state['user_first_name']).toBe('Sam')
    expect(state!.phase_state['agent_name']).toBeUndefined()
  })
})
