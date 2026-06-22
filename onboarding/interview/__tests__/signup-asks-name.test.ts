/**
 * P2 v2 § 3.1 / § 4.1 (S3, 2026-05-16) — signup phase captures the
 * user's first name end-to-end + mirrors it to the canonical
 * `user_first_name` registry row via the `personaSync` hook.
 *
 * Spec contract:
 *   1. Engine emits the signup prompt ("Hey, what should I call you?").
 *   2. User replies in free-text ("Casey" / "Sam Doe" / "I'm Sam").
 *   3. Engine extracts the first name via the LLM driver OR the
 *      static-fallback heuristic (`extractAgentNameFromFreeform` +
 *      `sanitizeUserFirstName`).
 *   4. Engine writes the captured value to BOTH stores:
 *        - `phase_state.user_first_name` (working state during onboarding)
 *        - `user_first_name` registry row via `personaSync.recordUserFirstName`
 *      The dual-store write is intentional per § 4.1.
 *   5. Engine advances past signup (to `ai_substrate_offered` via the
 *      auto-skipped `instance_provisioned` transit).
 *   6. If extraction fails (ambiguous reply like "yes"), the engine
 *      stays on signup and re-prompts via the clarify_name_reprompt
 *      branch — does NOT advance with a missing/garbage value.
 *
 * The test uses the static-fallback driver path (no LLM substrate) so
 * the assertions are deterministic. Production wires the Anthropic
 * client and the LLM emits `extracted_fields.user_first_name`
 * directly; the engine's heuristic capture is the safety net for the
 * fallback path.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '../../../migrations/runner.ts'
import { ProjectDb } from '../../../persistence/index.ts'
import { ButtonStore } from '../../../channels/button-store.ts'
import type {
  ButtonChoice,
  ButtonPrompt,
} from '../../../channels/button-primitive.ts'
import { InterviewEngine, type PersonaSyncHook } from '../engine.ts'
import { InMemoryOnboardingStateStore } from '../state-store.ts'
import { TranscriptWriter } from '../transcript.ts'
import { stubRouter, stubPlatform } from './interview-testkit.ts'

let tmp: string
let db: ProjectDb
let buttonStore: ButtonStore
let stateStore: InMemoryOnboardingStateStore
let transcript: TranscriptWriter
let sentPrompts: Array<{
  project_slug: string
  topic_id: string
  prompt: ButtonPrompt
}>
let recordedUserFirstNames: Array<{
  project_slug: string
  user_first_name: string | null
}>
let recordedAgentNames: Array<{
  project_slug: string
  agent_name: string | null
}>

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-signup-name-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
  buttonStore = new ButtonStore({ db })
  stateStore = new InMemoryOnboardingStateStore()
  transcript = new TranscriptWriter({
    path: join(tmp, 'persona', 'onboarding-transcript.jsonl'),
  })
  sentPrompts = []
  recordedUserFirstNames = []
  recordedAgentNames = []
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

// 2026-06-21 (onboarding-engine consolidation) — the `promptDriver`
// extraction seam was removed; it was never wired in production. With NO
// `platform` adapter wired, `shouldConsultRouter` short-circuits to false,
// so the engine runs the STATIC heuristic capture path
// (`extractAgentNameFromFreeform` → `sanitizeUserFirstName`) — the exact
// safety-net path these deterministic assertions exercise. A plain-name
// signup reply ("Casey", "Sam Doe", "I'm Sam", "call me Sam") is captured
// by the heuristic with no router and no driver.
function makeEngine(personaSync?: PersonaSyncHook): InterviewEngine {
  return new InterviewEngine({
    buttonStore,
    stateStore,
    transcript,
    sendButtonPrompt: async (input) => {
      sentPrompts.push(input)
      return { message_id: `msg-${sentPrompts.length}`, was_new: true }
    },
    ...(personaSync !== undefined ? { personaSync } : {}),
  })
}

function makeRecorder(): PersonaSyncHook {
  return {
    recordAgentName: async (input) => {
      recordedAgentNames.push(input)
    },
    recordUserFirstName: async (input) => {
      recordedUserFirstNames.push(input)
    },
  }
}

async function lastPromptId(): Promise<string> {
  const sent = sentPrompts[sentPrompts.length - 1]
  if (sent === undefined) throw new Error('no prompt has been sent yet')
  return sent.prompt.prompt_id
}

async function advanceFreeform(
  engine: InterviewEngine,
  project_slug: string,
  text: string,
  observed_at: number,
): Promise<void> {
  const prompt_id = await lastPromptId()
  const choice: ButtonChoice = {
    prompt_id,
    choice_value: '__freeform__',
    freeform_text: text,
    chosen_at: observed_at,
    speaker_user_id: 'u-1',
    channel_kind: 'app-socket',
  }
  await engine.advance({
    project_slug,
    topic_id: 'topic-1',
    user_id: 'u-1',
    channel_kind: 'app-socket',
    choice,
    observed_at,
  })
}

describe('P2 v2 § 3.1 — signup captures user_first_name (dual-store write)', () => {
  test('single-token reply ("Casey") lands in phase_state.user_first_name AND fires recordUserFirstName', async () => {
    const engine = makeEngine(makeRecorder())
    const project_slug = 'casey'
    let observed_at = 1_700_000_000_000

    await engine.start({
      project_slug,
      topic_id: 'topic-1',
      user_id: 'u-1',
      signup_via: 'web',
    })
    let state = await stateStore.get(project_slug, 'u-1')
    expect(state?.phase).toBe('signup')

    observed_at += 1_000
    await advanceFreeform(engine, project_slug, 'Casey', observed_at)

    state = await stateStore.get(project_slug, 'u-1')
    // Engine advanced past signup → ai_substrate_offered via the
    // auto-skipped instance_provisioned transit.
    expect(state?.phase).toBe('ai_substrate_offered')
    // Dual-store mirror — phase_state side.
    expect(state?.phase_state['user_first_name']).toBe('Casey')
    // Dual-store mirror — registry side (via personaSync hook).
    expect(recordedUserFirstNames).toEqual([
      { project_slug: 'casey', user_first_name: 'Casey' },
    ])
  })

  test('full-name reply ("Sam Doe") extracts the FIRST token', async () => {
    const engine = makeEngine(makeRecorder())
    const project_slug = 'sam'
    let observed_at = 1_700_000_000_000

    await engine.start({
      project_slug,
      topic_id: 'topic-1',
      user_id: 'u-1',
      signup_via: 'web',
    })
    observed_at += 1_000
    await advanceFreeform(engine, project_slug, 'Sam Doe', observed_at)

    const state = await stateStore.get(project_slug, 'u-1')
    expect(state?.phase).toBe('ai_substrate_offered')
    expect(state?.phase_state['user_first_name']).toBe('Sam')
    expect(recordedUserFirstNames).toEqual([
      { project_slug: 'sam', user_first_name: 'Sam' },
    ])
  })

  test('"I\'m Sam" intro extracts via the heuristic', async () => {
    const engine = makeEngine(makeRecorder())
    const project_slug = 'sam'
    let observed_at = 1_700_000_000_000

    await engine.start({
      project_slug,
      topic_id: 'topic-1',
      user_id: 'u-1',
      signup_via: 'web',
    })
    observed_at += 1_000
    await advanceFreeform(engine, project_slug, "I'm Sam", observed_at)

    const state = await stateStore.get(project_slug, 'u-1')
    expect(state?.phase).toBe('ai_substrate_offered')
    expect(state?.phase_state['user_first_name']).toBe('Sam')
    expect(recordedUserFirstNames).toEqual([
      { project_slug: 'sam', user_first_name: 'Sam' },
    ])
  })

  test('"call me Sam" intro extracts via the heuristic', async () => {
    const engine = makeEngine(makeRecorder())
    const project_slug = 'sam-callme'
    let observed_at = 1_700_000_000_000

    await engine.start({
      project_slug,
      topic_id: 'topic-1',
      user_id: 'u-1',
      signup_via: 'web',
    })
    observed_at += 1_000
    await advanceFreeform(engine, project_slug, 'call me Sam', observed_at)

    const state = await stateStore.get(project_slug, 'u-1')
    expect(state?.phase).toBe('ai_substrate_offered')
    expect(state?.phase_state['user_first_name']).toBe('Sam')
    expect(recordedUserFirstNames).toEqual([
      { project_slug: 'sam-callme', user_first_name: 'Sam' },
    ])
  })
})

describe('P2 v2 § 3.1 — signup re-prompts on ambiguous / non-name replies', () => {
  test('"yes" stays at signup, does NOT advance, does NOT fire recordUserFirstName', async () => {
    const engine = makeEngine(makeRecorder())
    const project_slug = 'noname'
    let observed_at = 1_700_000_000_000

    await engine.start({
      project_slug,
      topic_id: 'topic-1',
      user_id: 'u-1',
      signup_via: 'web',
    })
    observed_at += 1_000
    await advanceFreeform(engine, project_slug, 'yes', observed_at)

    const state = await stateStore.get(project_slug, 'u-1')
    expect(state?.phase).toBe('signup')
    expect(state?.phase_state['user_first_name']).toBeUndefined()
    expect(state?.phase_state['clarify_name_reprompt']).toBe(true)
    expect(recordedUserFirstNames).toEqual([])
  })

  test('"what?" stays at signup with the clarify reprompt flag', async () => {
    const engine = makeEngine(makeRecorder())
    const project_slug = 'what'
    let observed_at = 1_700_000_000_000

    await engine.start({
      project_slug,
      topic_id: 'topic-1',
      user_id: 'u-1',
      signup_via: 'web',
    })
    observed_at += 1_000
    await advanceFreeform(engine, project_slug, 'what?', observed_at)

    const state = await stateStore.get(project_slug, 'u-1')
    expect(state?.phase).toBe('signup')
    expect(state?.phase_state['clarify_name_reprompt']).toBe(true)
    expect(recordedUserFirstNames).toEqual([])
  })
})

describe('P2 v2 § 3.1 — signup persists even when personaSync is unwired', () => {
  test('no personaSync hook → phase_state.user_first_name still written', async () => {
    // Production composer always wires the hook; this test verifies the
    // engine doesn't crash when an integrator passes a partial deps
    // bundle (e.g. an offline dev environment with NEUTRON_REGISTRY_DB_PATH
    // unset and `resolve-persona-sync.ts` returns `hook=null`).
    const engine = makeEngine()
    const project_slug = 'no-sync'
    let observed_at = 1_700_000_000_000

    await engine.start({
      project_slug,
      topic_id: 'topic-1',
      user_id: 'u-1',
      signup_via: 'web',
    })
    observed_at += 1_000
    await advanceFreeform(engine, project_slug, 'Casey', observed_at)

    const state = await stateStore.get(project_slug, 'u-1')
    expect(state?.phase).toBe('ai_substrate_offered')
    expect(state?.phase_state['user_first_name']).toBe('Casey')
  })

  test('personaSync without recordUserFirstName method → still writes phase_state, no crash', async () => {
    // Backward-compat shim: a fixture that only implements the
    // pre-S3 `recordAgentName` method must still allow signup to
    // advance. The new `recordUserFirstName` field is optional on
    // PersonaSyncHook so callers built pre-S3 keep compiling.
    const engine = makeEngine({
      recordAgentName: async (input) => {
        recordedAgentNames.push(input)
      },
    })
    const project_slug = 'legacy-sync'
    let observed_at = 1_700_000_000_000

    await engine.start({
      project_slug,
      topic_id: 'topic-1',
      user_id: 'u-1',
      signup_via: 'web',
    })
    observed_at += 1_000
    await advanceFreeform(engine, project_slug, 'Casey', observed_at)

    const state = await stateStore.get(project_slug, 'u-1')
    expect(state?.phase).toBe('ai_substrate_offered')
    expect(state?.phase_state['user_first_name']).toBe('Casey')
    expect(recordedUserFirstNames).toEqual([])
  })
})

describe('P2 v2 § 4.4 — required-fields audit observability at signup-advance', () => {
  test('post-signup audit shows user_first_name FILLED + 3 others still missing', async () => {
    // The audit is informational at S3 (logged via console.info, not
    // surfaced via a typed event yet — S5 wires the gating into
    // work_interview_gap_fill). This test asserts the field state the
    // audit reads, not the log output itself.
    const engine = makeEngine(makeRecorder())
    const project_slug = 'audit-check'
    let observed_at = 1_700_000_000_000

    await engine.start({
      project_slug,
      topic_id: 'topic-1',
      user_id: 'u-1',
      signup_via: 'web',
    })
    observed_at += 1_000
    await advanceFreeform(engine, project_slug, 'Casey', observed_at)

    const state = await stateStore.get(project_slug, 'u-1')
    expect(state?.phase_state['user_first_name']).toBe('Casey')
    // The other required fields are NOT collected at signup — they're
    // populated by later phases (import + gap_fill + personality +
    // agent_name). The audit module test suite exercises every
    // permutation of these states; here we just pin the post-signup
    // shape.
    expect(state?.phase_state['primary_projects']).toBeUndefined()
    expect(state?.phase_state['non_work_interests']).toBeUndefined()
    expect(state?.phase_state['agent_personality']).toBeUndefined()
  })
})

describe('P2 v2 § 3.1 (Codex r1 P1) — signup does NOT write user name into phase_state.agent_name', () => {
  test('phase_state.agent_name is undefined after signup-advance — the user\'s name is in user_first_name', async () => {
    // Spec § 3.10 reserves `phase_state.agent_name` for the dedicated
    // `agent_name_chosen` phase. v1 conflated the two (signup wrote
    // the user's reply to agent_name) which would let the new
    // required-fields audit mark `agent_name` as "filled" with the
    // user's own name and (once S5/S6 wire the gate) skip the
    // agent-naming step entirely.
    const engine = makeEngine(makeRecorder())
    const project_slug = 'no-agent-write'
    let observed_at = 1_700_000_000_000

    await engine.start({
      project_slug,
      topic_id: 'topic-1',
      user_id: 'u-1',
      signup_via: 'web',
    })
    observed_at += 1_000
    await advanceFreeform(engine, project_slug, 'Casey', observed_at)

    const state = await stateStore.get(project_slug, 'u-1')
    expect(state?.phase).toBe('ai_substrate_offered')
    expect(state?.phase_state['user_first_name']).toBe('Casey')
    expect(state?.phase_state['agent_name']).toBeUndefined()
  })
})

describe('P2 v2 § 3.1 (Codex r1 P2) — backfill user_first_name from legacy agent_name signal', () => {
  test('router advance emits agent_name (v1 shape) → engine backfills user_first_name from it', async () => {
    // 2026-06-21 (onboarding-engine consolidation) — ported off the removed
    // `promptDriver` extraction seam onto the surviving `llmRouter` seam.
    // A v1-shaped classifier emits only `state_delta.agent_name = 'Sam'` on
    // a signup ADVANCE (no `user_first_name`); the engine must NOT advance
    // with `phase_state.user_first_name === undefined`. The signup-advance
    // backfill (engine.ts § "backfill user_first_name from the legacy
    // agent_name extraction signal") kicks in when agent_name is the only
    // name signal, sanitizing through the same pipeline as a fresh
    // user_first_name extraction.
    //
    // The user's reply is intentionally NOT name-shaped ("yes that sounds
    // great") so `extractAgentNameFromFreeform` returns null and the
    // heuristic capture branch leaves user_first_name unset — isolating the
    // agent_name → user_first_name backfill as the ONLY path that supplies
    // the name.
    const project_slug = 'v1-llm-shape'
    const recorder = makeRecorder()
    const { router } = stubRouter([
      {
        action: 'advance',
        confidence: 0.95,
        choice_value: null,
        freeform_text: 'yes that sounds great',
        response: null,
        // v1 envelope shape: only agent_name, no user_first_name.
        state_delta: { agent_name: 'Sam' } as Record<string, unknown>,
        reasoning: 'v1-shaped advance — agent_name only',
      },
    ])
    const engine = new InterviewEngine({
      buttonStore,
      stateStore,
      transcript,
      sendButtonPrompt: async (input) => {
        sentPrompts.push(input)
        return { message_id: `msg-${sentPrompts.length}`, was_new: true }
      },
      llmRouter: router,
      platform: stubPlatform('all'),
      personaSync: recorder,
    })
    let observed_at = 1_700_000_000_000

    await engine.start({
      project_slug,
      topic_id: 'topic-1',
      user_id: 'u-1',
      signup_via: 'web',
    })
    observed_at += 1_000
    // The router seam is only consulted on the freeform interaction-mode
    // branch, which fires on a typed `freeform_text` reply (NOT a synthetic
    // `__freeform__` ButtonChoice). Drive that path directly.
    await engine.advance({
      project_slug,
      topic_id: 'topic-1',
      user_id: 'u-1',
      channel_kind: 'app-socket',
      freeform_text: 'yes that sounds great',
      observed_at,
    })

    const state = await stateStore.get(project_slug, 'u-1')
    expect(state?.phase).toBe('ai_substrate_offered')
    // Backfill landed: user_first_name set even though the classifier only
    // emitted agent_name.
    expect(state?.phase_state['user_first_name']).toBe('Sam')
    // Registry side mirrored too.
    expect(recordedUserFirstNames).toEqual([
      { project_slug, user_first_name: 'Sam' },
    ])
  })
})

describe('P2 v2 § 3.1 — registry write failure is non-blocking', () => {
  test('personaSync.recordUserFirstName throwing does NOT block advance', async () => {
    // Engine wraps the recordUserFirstName call in try/catch + warn so
    // a registry write failure (locked DB, missing column on pre-0006
    // schema, etc.) cannot strand the user at signup.
    const engine = makeEngine({
      recordAgentName: async () => {},
      recordUserFirstName: async () => {
        throw new Error('synthetic registry write failure')
      },
    })
    const project_slug = 'flaky-sync'
    let observed_at = 1_700_000_000_000

    await engine.start({
      project_slug,
      topic_id: 'topic-1',
      user_id: 'u-1',
      signup_via: 'web',
    })
    observed_at += 1_000
    await advanceFreeform(engine, project_slug, 'Casey', observed_at)

    const state = await stateStore.get(project_slug, 'u-1')
    expect(state?.phase).toBe('ai_substrate_offered')
    expect(state?.phase_state['user_first_name']).toBe('Casey')
  })
})
