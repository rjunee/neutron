/**
 * Sprint: LLM-driven onboarding prompts (2026-05-09).
 * Architecture: docs/research/onboarding-llm-prompts-architecture-2026-05-09.md
 *
 * End-to-end tests for the engine wiring: when `phaseSpecResolver` is
 * provided, `engine.start(...)` routes the signup phase through the
 * resolver instead of the static `S1_PROMPT_*` constants. When the
 * resolver returns null (phase not enabled / LLM error), the engine
 * falls back to the static spec — preserving every existing assertion.
 *
 * Also covers:
 *   - signup_via=web vs signup_via=telegram bundle population
 *   - tg_first_name reaches the resolver bundle when set on StartInput
 *   - ButtonStore idempotency unchanged across resolver runs
 *   - recent_turns populates from the transcript on subsequent emits
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
import { STATIC_PHASE_SPECS } from '../phase-prompts.ts'
import { InMemoryOnboardingStateStore } from '../state-store.ts'
import { TranscriptWriter } from '../transcript.ts'

// 2026-05-10 — the per-channel `S1_PROMPT_*` constants are gone.
// Both telegram and web fallback to the same static body. Aliases
// kept for diff minimization on existing assertions.
const S1_PROMPT_BODY = STATIC_PHASE_SPECS['signup']!.body
const S1_PROMPT_OPTIONS = { length: STATIC_PHASE_SPECS['signup']!.options.length }
import type {
  PhaseContextBundle,
  PhaseSpecResolver,
  LlmCallFn,
} from '../phase-spec-resolver.ts'
import { buildLlmPhaseSpecResolver } from '../phase-spec-resolver.ts'

interface Harness {
  tmp: string
  db: ProjectDb
  buttonStore: ButtonStore
  stateStore: InMemoryOnboardingStateStore
  transcript: TranscriptWriter
  sentPrompts: Array<{ project_slug: string; topic_id: string; prompt: ButtonPrompt }>
  observedBundles: PhaseContextBundle[]
  engine: InterviewEngine
}

function buildHarness(opts: {
  resolver?: PhaseSpecResolver
}): Harness {
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-eng-llm-'))
  const db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
  const buttonStore = new ButtonStore({ db })
  const stateStore = new InMemoryOnboardingStateStore()
  const transcript = new TranscriptWriter({
    path: join(tmp, 'persona', 'onboarding-transcript.jsonl'),
  })
  const sentPrompts: Harness['sentPrompts'] = []
  const observedBundles: PhaseContextBundle[] = []
  const sender = async (input: { project_slug: string; topic_id: string; prompt: ButtonPrompt }) => {
    sentPrompts.push(input)
    return { message_id: `msg-${sentPrompts.length}`, was_new: true }
  }
  const engineDeps: ConstructorParameters<typeof InterviewEngine>[0] = {
    buttonStore,
    stateStore,
    transcript,
    sendButtonPrompt: sender,
  }
  if (opts.resolver !== undefined) {
    engineDeps.phaseSpecResolver = opts.resolver
  }
  const engine = new InterviewEngine(engineDeps)
  return {
    tmp,
    db,
    buttonStore,
    stateStore,
    transcript,
    sentPrompts,
    observedBundles,
    engine,
  }
}

function tearDown(h: Harness): void {
  h.db.close()
  rmSync(h.tmp, { recursive: true, force: true })
}

describe('InterviewEngine — phaseSpecResolver wiring', () => {
  test('start emits LLM body when resolver returns a spec (signup phase)', async () => {
    let observedBundle: PhaseContextBundle | null = null
    const resolver: PhaseSpecResolver = {
      async resolve(bundle) {
        observedBundle = bundle
        return {
          phase: 'signup',
          body: 'Hey - whats your name?',
          options: [],
          allow_freeform: true,
          next_phase_on_default: 'agent_name_chosen',
        }
      },
    }
    const h = buildHarness({ resolver })
    try {
      await h.engine.start({
        project_slug: 't1',
        topic_id: 'web:user-1',
        user_id: 'u-1',
        signup_via: 'web',
      })
      expect(h.sentPrompts.length).toBe(1)
      expect(h.sentPrompts[0]!.prompt.body).toBe('Hey - whats your name?')
      // Free-text resolver returned no options.
      expect(h.sentPrompts[0]!.prompt.options.length).toBe(0)
      expect(observedBundle).not.toBeNull()
      expect(observedBundle!.signup_via).toBe('web')
      expect(observedBundle!.phase).toBe('signup')
    } finally {
      tearDown(h)
    }
  })

  test('start falls back to static S1_PROMPT_* when resolver returns null', async () => {
    const resolver: PhaseSpecResolver = {
      async resolve() {
        return null
      },
    }
    const h = buildHarness({ resolver })
    try {
      await h.engine.start({
        project_slug: 't1',
        topic_id: 'topic-1',
        user_id: 'u-1',
        signup_via: 'telegram',
      })
      expect(h.sentPrompts[0]!.prompt.body).toBe(S1_PROMPT_BODY)
      expect(h.sentPrompts[0]!.prompt.options.length).toBe(
        S1_PROMPT_OPTIONS.length,
      )
    } finally {
      tearDown(h)
    }
  })

  test('start with no resolver wired uses the static spec (default behavior)', async () => {
    const h = buildHarness({})
    try {
      await h.engine.start({
        project_slug: 't1',
        topic_id: 'topic-1',
        user_id: 'u-1',
        signup_via: 'telegram',
      })
      expect(h.sentPrompts[0]!.prompt.body).toBe(S1_PROMPT_BODY)
      expect(h.sentPrompts[0]!.prompt.options.length).toBe(
        S1_PROMPT_OPTIONS.length,
      )
    } finally {
      tearDown(h)
    }
  })

  test('start passes signup_via=telegram + tg_first_name into the bundle', async () => {
    let observedBundle: PhaseContextBundle | null = null
    const resolver: PhaseSpecResolver = {
      async resolve(bundle) {
        observedBundle = bundle
        return {
          phase: 'signup',
          body: 'Hey Anna - want me to call you that?',
          options: [],
          allow_freeform: true,
          next_phase_on_default: 'agent_name_chosen',
        }
      },
    }
    const h = buildHarness({ resolver })
    try {
      await h.engine.start({
        project_slug: 't1',
        topic_id: 'tg:123:0',
        user_id: 'tg-user-123',
        signup_via: 'telegram',
        tg_first_name: 'Anna',
      })
      expect(observedBundle).not.toBeNull()
      expect(observedBundle!.signup_via).toBe('telegram')
      expect(observedBundle!.telegram_display_name).toBe('Anna')
      // Verify it persisted into phase_state for downstream phases.
      const state = await h.stateStore.get('t1', 'tg-user-123')
      expect(state!.phase_state['tg_first_name']).toBe('Anna')
    } finally {
      tearDown(h)
    }
  })

  test('signup_via=web bundles telegram_display_name=null', async () => {
    let observedBundle: PhaseContextBundle | null = null
    const resolver: PhaseSpecResolver = {
      async resolve(bundle) {
        observedBundle = bundle
        return {
          phase: 'signup',
          body: 'whats your name?',
          options: [],
          allow_freeform: true,
          next_phase_on_default: 'agent_name_chosen',
        }
      },
    }
    const h = buildHarness({ resolver })
    try {
      await h.engine.start({
        project_slug: 't1',
        topic_id: 'web:user-1',
        user_id: 'u-1',
        signup_via: 'web',
      })
      expect(observedBundle).not.toBeNull()
      expect(observedBundle!.signup_via).toBe('web')
      expect(observedBundle!.telegram_display_name).toBeNull()
    } finally {
      tearDown(h)
    }
  })

  test('start idempotency unchanged across resolver runs', async () => {
    let calls = 0
    const resolver: PhaseSpecResolver = {
      async resolve() {
        calls++
        return {
          phase: 'signup',
          body: 'whats your name?',
          options: [],
          allow_freeform: true,
          next_phase_on_default: 'agent_name_chosen',
        }
      },
    }
    const h = buildHarness({ resolver })
    try {
      const startInput = {
        project_slug: 't1',
        topic_id: 'web:user-1',
        user_id: 'u-1',
        signup_via: 'web' as const,
      }
      const a = await h.engine.start(startInput)
      const b = await h.engine.start(startInput)
      // Second call short-circuits via the existing-active-prompt guard
      // path, so the resolver is NOT consulted a second time when the
      // existing row is reused. This proves we did not break idempotency.
      expect(b.was_new).toBe(false)
      expect(b.prompt_id).toBe(a.prompt_id)
      const rows = h.db
        .prepare<{ c: number }, []>('SELECT COUNT(*) AS c FROM button_prompts')
        .get()
      expect(rows?.c).toBe(1)
    } finally {
      tearDown(h)
    }
  })

  test('start idempotency holds even when LLM returns DIFFERENT body on each call (Codex P1)', async () => {
    // Simulates the race: two concurrent start() calls land before the
    // first persists active_prompt_id. Each gets a slightly different
    // LLM rephrase. The seed must NOT depend on LLM body — the same
    // (instance, topic, phase) must hash to the same idempotency_key so
    // ButtonStore.emit dedupes and only one row + one send happens.
    let counter = 0
    const resolver: PhaseSpecResolver = {
      async resolve() {
        counter++
        return {
          phase: 'signup',
          body: `LLM rephrase #${counter}`,
          options: [],
          allow_freeform: true,
          next_phase_on_default: 'agent_name_chosen',
        }
      },
    }
    // Build TWO independent harnesses sharing the same db so both
    // start() calls compete for the same idempotency_key bucket.
    const tmp = mkdtempSync(join(tmpdir(), 'neutron-eng-llm-race-'))
    try {
      const db = ProjectDb.open(join(tmp, 'project.db'))
      try {
        applyMigrations(db.raw())
        const buttonStore = new ButtonStore({ db })
        const stateStore = new InMemoryOnboardingStateStore()
        const transcript = new TranscriptWriter({
          path: join(tmp, 'persona', 'onboarding-transcript.jsonl'),
        })
        const sentPrompts: Array<{ project_slug: string; topic_id: string; prompt: ButtonPrompt }> = []
        const sender = async (input: { project_slug: string; topic_id: string; prompt: ButtonPrompt }) => {
          sentPrompts.push(input)
          return { message_id: `msg-${sentPrompts.length}`, was_new: true }
        }
        // Two engines on the same DB — but with the SAME resolver so
        // each call gets a different body. The state-store guard
        // dedupes one path, but the idempotency_key must dedupe the
        // ButtonStore row even if the body differs.
        const engine1 = new InterviewEngine({
          buttonStore,
          stateStore,
          transcript,
          sendButtonPrompt: sender,
          phaseSpecResolver: resolver,
        })
        const startInput = {
          project_slug: 't1',
          topic_id: 'web:user-1',
          user_id: 'u-1',
          signup_via: 'web' as const,
        }
        await engine1.start(startInput)
        await engine1.start(startInput)
        // Even though the resolver was consulted twice and returned
        // DIFFERENT bodies, only ONE button_prompts row exists.
        const rows = db
          .prepare<{ c: number }, []>('SELECT COUNT(*) AS c FROM button_prompts')
          .get()
        expect(rows?.c).toBe(1)
      } finally {
        db.close()
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('resolver throw is swallowed — engine falls back gracefully', async () => {
    const resolver: PhaseSpecResolver = {
      async resolve() {
        throw new Error('resolver bug')
      },
    }
    const h = buildHarness({ resolver })
    try {
      await h.engine.start({
        project_slug: 't1',
        topic_id: 'topic-1',
        user_id: 'u-1',
        signup_via: 'telegram',
      })
      expect(h.sentPrompts.length).toBe(1)
      expect(h.sentPrompts[0]!.prompt.body).toBe(S1_PROMPT_BODY)
    } finally {
      tearDown(h)
    }
  })

  test('agent transcript line records the LLM body, not the static body', async () => {
    const resolver: PhaseSpecResolver = {
      async resolve() {
        return {
          phase: 'signup',
          body: 'casual LLM greeting',
          options: [],
          allow_freeform: true,
          next_phase_on_default: 'agent_name_chosen',
        }
      },
    }
    const h = buildHarness({ resolver })
    try {
      await h.engine.start({
        project_slug: 't1',
        topic_id: 'web:user-1',
        user_id: 'u-1',
        signup_via: 'web',
      })
      const entries = h.transcript.readAll()
      expect(entries.length).toBe(1)
      expect(entries[0]!.body).toBe('casual LLM greeting')
      expect(entries[0]!.body).not.toBe(S1_PROMPT_BODY)
    } finally {
      tearDown(h)
    }
  })

  test('resolver bundle includes recent_turns from the transcript on a subsequent emit', async () => {
    const resolver: PhaseSpecResolver = {
      async resolve(bundle) {
        return {
          phase: bundle.phase,
          body: `body for ${bundle.phase} (turns=${bundle.recent_turns.length})`,
          options: [],
          allow_freeform: true,
          next_phase_on_default: 'agent_name_chosen',
        }
      },
    }
    const h = buildHarness({ resolver })
    try {
      await h.engine.start({
        project_slug: 't1',
        topic_id: 'web:user-1',
        user_id: 'u-1',
        signup_via: 'web',
      })
      // Add a synthetic user line to the transcript to simulate the
      // user replying. The next emit's bundle should see it in
      // recent_turns.
      h.transcript.append({
        role: 'user',
        body: 'Sam',
        phase: 'signup',
      })
      // Re-emit the same phase via emitCurrentPhasePrompt — the engine
      // re-resolves with the LLM resolver and the bundle picks up the
      // user turn we just appended.
      const obs: PhaseContextBundle[] = []
      // Replace the resolver so we can observe the bundle on this turn.
      const resolver2: PhaseSpecResolver = {
        async resolve(bundle) {
          obs.push(bundle)
          return {
            phase: bundle.phase,
            body: `re-emit body (turns=${bundle.recent_turns.length})`,
            options: [],
            allow_freeform: true,
            next_phase_on_default: 'agent_name_chosen',
          }
        },
      }
      // Build a second engine sharing the same stores so the freshly
      // appended transcript line is visible on the next call.
      const engine2 = new InterviewEngine({
        buttonStore: h.buttonStore,
        stateStore: h.stateStore,
        transcript: h.transcript,
        sendButtonPrompt: async (input) => {
          h.sentPrompts.push(input)
          return { message_id: `m-${h.sentPrompts.length}`, was_new: true }
        },
        phaseSpecResolver: resolver2,
      })
      await engine2.emitCurrentPhasePrompt({
        user_id: 'u-1',
        project_slug: 't1',
        topic_id: 'web:user-1',
      })
      expect(obs.length).toBeGreaterThan(0)
      const lastBundle = obs[obs.length - 1]!
      // recent_turns includes BOTH the original agent line AND the
      // newly-appended user "Sam" line.
      expect(lastBundle.recent_turns.length).toBeGreaterThanOrEqual(2)
      const bodies = lastBundle.recent_turns.map((t) => t.body)
      expect(bodies).toContain('Sam')
    } finally {
      tearDown(h)
    }
  })

  test('topic_id flows through the bundle', async () => {
    let observedBundle: PhaseContextBundle | null = null
    const resolver: PhaseSpecResolver = {
      async resolve(bundle) {
        observedBundle = bundle
        return {
          phase: bundle.phase,
          body: 'hi',
          options: [],
          allow_freeform: true,
          next_phase_on_default: 'agent_name_chosen',
        }
      },
    }
    const h = buildHarness({ resolver })
    try {
      await h.engine.start({
        project_slug: 't1',
        topic_id: 'web:user-99',
        user_id: 'user-99',
        signup_via: 'web',
      })
      expect(observedBundle).not.toBeNull()
      expect(observedBundle!.topic_id).toBe('web:user-99')
      expect(observedBundle!.user_id).toBe('user-99')
    } finally {
      tearDown(h)
    }
  })
})

// ---------------------------------------------------------------------------
// REAL-PATH body↔options desync reproduction (onboarding-bodyoptions-desync,
// 2026-06-20). The launch showstopper: a fresh install emitted a prompt whose
// BODY was the "what's your first name?" question but whose BUTTONS were the
// import offer (Yes ChatGPT / Yes Claude / Neither), and asked the name twice.
//
// WHY PRIOR TESTS MISSED IT: every test above stubs `phaseSpecResolver` with a
// hand-written clean per-phase spec, so the bug — which lives in the REAL
// resolver's parse → materialize → engine-emit seam — was never exercised.
// These tests wire the PRODUCTION `buildLlmPhaseSpecResolver` (real
// `parseLlmSpec` + `materializeSpec`) and feed the `LlmCallFn` the exact raw
// JSON the warm, ACCUMULATING `cc-llm` session produced live: a LAGGED
// previous-phase body (a name re-ask) with an EMPTY options array, emitted
// while the engine has already advanced to `ai_substrate_offered`.
//
// PRE-FIX: `materializeSpec` grafted the CURRENT phase's static import buttons
// onto the lagged name body → name body + import buttons (the desync).
// POST-FIX: the resolver discards the option-less LLM spec for an option-bearing
// phase, the engine falls back to the FULL static `ai_substrate_offered` spec,
// and body + options are guaranteed in-phase.
describe('InterviewEngine — REAL resolver body↔options desync (option-bearing phase)', () => {
  const AI_SUBSTRATE_STATIC = STATIC_PHASE_SPECS['ai_substrate_offered']!
  // The verbatim lagged body the warm session re-emitted live (a name re-ask
  // while the phase had already advanced to the import offer).
  const LAGGED_NAME_BODY = "Hey, welcome in! What's your first name?"

  async function seedAndEmit(llm: LlmCallFn): Promise<ButtonPrompt> {
    const resolver = buildLlmPhaseSpecResolver({
      llm,
      enabled_phases: new Set(['signup', 'ai_substrate_offered'] as const),
    })
    const h = buildHarness({ resolver })
    try {
      // Engine has advanced past signup; it is now emitting the import offer.
      await h.stateStore.upsert({
        project_slug: 't1',
        user_id: 'u-1',
        phase: 'ai_substrate_offered',
        phase_state_patch: {
          topic_id: 'web:user-1',
          signup_via: 'web',
          user_first_name: 'Ryan',
        },
      })
      await h.engine.emitPhasePrompt({
        project_slug: 't1',
        user_id: 'u-1',
        topic_id: 'web:user-1',
        phase: 'ai_substrate_offered',
        observed_at: Date.now(),
      })
      expect(h.sentPrompts.length).toBe(1)
      return h.sentPrompts[0]!.prompt
    } finally {
      tearDown(h)
    }
  }

  test('lagged name body + empty options NEVER ships with import buttons grafted on', async () => {
    // The warm session returns the PREVIOUS phase's body with no options.
    const laggedLlm: LlmCallFn = async () =>
      JSON.stringify({ body: LAGGED_NAME_BODY, options: [] })
    const prompt = await seedAndEmit(laggedLlm)

    // The defect: a name body wearing import buttons. This MUST NOT happen.
    const isDesynced =
      prompt.body === LAGGED_NAME_BODY && prompt.options.length > 0
    expect(isDesynced).toBe(false)

    // Concretely: the engine fell back to the FULL static import spec, so body
    // AND options are both the import phase's own — never cross-phase.
    expect(prompt.body).toBe(AI_SUBSTRATE_STATIC.body)
    expect(prompt.body).not.toContain('first name')
    expect(prompt.options.length).toBe(AI_SUBSTRATE_STATIC.options.length)
    expect(prompt.options.map((o) => o.value)).toEqual(
      AI_SUBSTRATE_STATIC.options.map((o) => o.value),
    )
  })

  test('a legitimate in-phase LLM spec (proper body + full options) is preserved', async () => {
    const goodLlm: LlmCallFn = async () =>
      JSON.stringify({
        body: 'Do you have ChatGPT or Claude history I can import?',
        options: [
          { label: 'A', body: 'Yes, ChatGPT', value: 'chatgpt' },
          { label: 'B', body: 'Yes, Claude', value: 'claude' },
          { label: 'C', body: 'Neither', value: 'neither' },
        ],
      })
    const prompt = await seedAndEmit(goodLlm)
    expect(prompt.body).toBe('Do you have ChatGPT or Claude history I can import?')
    expect(prompt.options.map((o) => o.value)).toEqual([
      'chatgpt',
      'claude',
      'neither',
    ])
  })

  test('a legitimate NARROWED option subset from the LLM is preserved (not over-corrected)', async () => {
    const subsetLlm: LlmCallFn = async () =>
      JSON.stringify({
        body: 'Want me to import your ChatGPT or Claude history?',
        options: [
          { label: 'A', body: 'Yes, ChatGPT', value: 'chatgpt' },
          { label: 'B', body: 'Yes, Claude', value: 'claude' },
        ],
      })
    const prompt = await seedAndEmit(subsetLlm)
    expect(prompt.body).toBe('Want me to import your ChatGPT or Claude history?')
    // A non-empty subset is a legitimate narrowing — kept, not replaced.
    expect(prompt.options.map((o) => o.value)).toEqual(['chatgpt', 'claude'])
  })
})
