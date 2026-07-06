/**
 * 2026-05-13 → re-anchored 2026-07-06 (K11a6-rem/grammar).
 *
 * ORIGINAL PIN (Codex r4 BLOCKING, PR #85): on reconnect, the onboarding
 * runtime re-emits an UNRESOLVED active button prompt so the reconnecting
 * user isn't stranded on a blank chat; a RESOLVED prompt is NOT re-emitted.
 *
 * The original test drove this through `engine.start`'s reuse-active-prompt
 * branch. K11b1 deletes the interview engine's conversational drive
 * (`start`/`advance`), so this is re-anchored onto the RETAINED, non-engine
 * reconnect grammar: `gateway/http/chat-bridge.ts:resumeCookieSession` →
 * `reEmitActiveSeedPromptIfAny`. That helper re-emits the latest UNRESOLVED
 * `ButtonStore` turn for a reconnecting PROJECT topic (and skips a RESOLVED
 * one) purely off `ButtonStore.listHistoryByTopic` — no interview engine
 * involved. The fake engine below is an inert stub required only by the
 * bridge constructor; `resumeCookieSession` never invokes it, so the re-emit
 * is driven entirely by the bridge's ButtonStore read. (See the sibling
 * `gateway/http/__tests__/chat-bridge-seed-reemit-race.test.ts` for the same
 * web-bridge harness.)
 *
 * Contract preserved:
 *   1. UNRESOLVED active prompt + reconnect → re-emit the stored prompt
 *      (same prompt_id + body).
 *   2. RESOLVED active prompt + reconnect → NO re-emit.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ButtonPrompt } from '../../../channels/button-primitive.ts'
import { ButtonStore } from '../../../channels/button-store.ts'
import { applyMigrations } from '../../../migrations/runner.ts'
import { ProjectDb } from '../../../persistence/index.ts'
import {
  buildWebChatBridge,
  InMemoryWebChatSenderRegistry,
} from '../../../gateway/http/chat-bridge.ts'
import { InMemoryConsumedTokens } from '@neutronai/runtime/__tests__/start-token-testkit.ts'
import type { ChatOutbound } from '../../../landing/server.ts'
import type {
  AdvanceInput,
  AdvanceResult,
  InterviewEngine,
  StartInput,
  StartResult,
} from '../engine.ts'
import type { OnboardingState } from '../state-store.ts'

const PROJECT_SLUG = 'nova'
const USER_ID = 'u-1'
// A PROJECT topic (`web:<user>:<proj>`) — reEmitActiveSeedPromptIfAny only
// fires when the reconnect lands on a project topic (wire_topic_id !==
// webTopicId(user_id)); the General topic is driven by the live turn instead.
const PROJECT_TOPIC = `web:${USER_ID}:${PROJECT_SLUG}`

let tmp: string
let db: ProjectDb
let buttonStore: ButtonStore

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-eng-reconnect-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
  buttonStore = new ButtonStore({ db })
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

function fakeState(): OnboardingState {
  return {
    project_slug: PROJECT_SLUG,
    user_id: USER_ID,
    phase: 'work_interview_gap_fill',
    phase_state: {},
    started_at: 0,
    last_advanced_at: 0,
    completed_at: null,
    import_job_id: null,
    persona_files_committed: false,
    wow_fired: false,
    wow_pushed_at: null,
    onboarding_handoff_emitted_at: null,
    attempt_id: 'a-1',
  }
}

/** Inert engine stub — `resumeCookieSession` never calls it; the reconnect
 *  re-emit is driven entirely by the bridge's ButtonStore read. */
function makeFakeEngine(): InterviewEngine {
  const s = fakeState()
  const startResult: StartResult = { prompt_id: 'pid-unused', was_new: true, state: s }
  const advanceResult: AdvanceResult = { outcome: 'advanced', state: s }
  return {
    async start(_: StartInput): Promise<StartResult> {
      return startResult
    },
    async advance(_: AdvanceInput): Promise<AdvanceResult> {
      return advanceResult
    },
    async recordInboundReceived(): Promise<void> {},
    async tick(): Promise<void> {},
    async emitCurrentPhasePrompt(): Promise<AdvanceResult> {
      return advanceResult
    },
  } as unknown as InterviewEngine
}

/** `ChatBridge.resumeCookieSession` is optional on the interface but always
 *  wired by `buildWebChatBridge`; narrow it once for the call sites below. */
function resumeCookieSession(
  bridge: ReturnType<typeof buildWebChatBridge>,
): NonNullable<ReturnType<typeof buildWebChatBridge>['resumeCookieSession']> {
  const fn = bridge.resumeCookieSession
  if (fn === undefined) throw new Error('buildWebChatBridge did not wire resumeCookieSession')
  return fn.bind(bridge)
}

function makeBridge() {
  return buildWebChatBridge({
    expected_project_slug: PROJECT_SLUG,
    resolveKey: async () => null,
    consumedTokens: new InMemoryConsumedTokens(),
    engine: makeFakeEngine(),
    registry: new InMemoryWebChatSenderRegistry(),
    buttonStore,
  })
}

async function seedPersistedPrompt(prompt_id: string, body: string): Promise<ButtonPrompt> {
  const prompt: ButtonPrompt = {
    prompt_id,
    body,
    options: [],
    allow_freeform: true,
  }
  // Persist a button_prompts row (resolved_at = null) on the PROJECT topic —
  // the reconnect re-emit reads the latest unresolved turn for that topic.
  await buttonStore.emit(prompt, { topic_id: PROJECT_TOPIC })
  return prompt
}

describe('reconnect re-emit of an unresolved active prompt (retained non-engine grammar)', () => {
  test('UNRESOLVED active prompt: cookie-resume onto the project topic re-emits the stored prompt', async () => {
    const PROMPT_ID = crypto.randomUUID()
    const PROMPT_BODY = 'Tell me about how you work — solo, small team, larger org?'
    await seedPersistedPrompt(PROMPT_ID, PROMPT_BODY)

    const peekBefore = await buttonStore.peek(PROMPT_ID)
    expect(peekBefore?.resolved_at).toBeNull()

    const bridge = makeBridge()
    const sent: ChatOutbound[] = []
    const send = (e: ChatOutbound): void => {
      sent.push(e)
    }

    await resumeCookieSession(bridge)({
      project_slug: PROJECT_SLUG,
      user_id: USER_ID,
      send,
      active_topic_id: PROJECT_TOPIC,
    })

    // The active prompt is re-sent so the reconnecting user sees the missed
    // prompt body + keyboard.
    const agentMsgs = sent.filter((e) => e.type === 'agent_message')
    expect(agentMsgs).toHaveLength(1)
    const agent = agentMsgs[0]
    if (agent === undefined || agent.type !== 'agent_message') {
      throw new Error('expected one agent_message')
    }
    expect(agent.prompt_id).toBe(PROMPT_ID)
    expect(agent.body).toBe(PROMPT_BODY)
  })

  test('RESOLVED active prompt: cookie-resume does NOT re-emit', async () => {
    const PROMPT_ID = crypto.randomUUID()
    const PROMPT_BODY = 'Tell me about how you work'
    await seedPersistedPrompt(PROMPT_ID, PROMPT_BODY)
    // Resolve the row via the public API so `resolved_at` is set the same way
    // the production tap path sets it.
    await buttonStore.resolve({
      choice: {
        prompt_id: PROMPT_ID,
        choice_value: '__freeform__',
        chosen_at: 2_000,
        speaker_user_id: USER_ID,
        channel_kind: 'app-socket',
        freeform_text: 'small team of three',
      },
    })

    const peekBefore = await buttonStore.peek(PROMPT_ID)
    expect(peekBefore?.resolved_at).not.toBeNull()

    const bridge = makeBridge()
    const sent: ChatOutbound[] = []
    const send = (e: ChatOutbound): void => {
      sent.push(e)
    }

    await resumeCookieSession(bridge)({
      project_slug: PROJECT_SLUG,
      user_id: USER_ID,
      send,
      active_topic_id: PROJECT_TOPIC,
    })

    // The resolved prompt MUST NOT be re-emitted (no duplicate keyboard).
    const agentMsgs = sent.filter((e) => e.type === 'agent_message')
    expect(agentMsgs).toHaveLength(0)
  })
})
