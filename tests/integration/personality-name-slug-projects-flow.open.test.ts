/**
 * Integration test (OPEN carve) — P2 v2 § 3.9 / § 3.10 / § 3.11 / § 3.12 / S7.
 *
 * Walks the engine through the four user-visible phases between
 * `work_interview_gap_fill` and `persona_synthesizing`:
 *
 *   1. `personality_offered`  → free-text agent_personality capture
 *   2. `agent_name_chosen`    → agent_name capture + validation
 *   3. `slug_chosen`          → agent-name-primary slug picker
 *   4. `projects_proposed`    → confirm + advance
 *
 * "slug" here is the OWNER's agent-name slug chosen during onboarding
 * (e.g. `mimir-mira`), NOT a hosted subdomain. The single-owner flow
 * exercises the engine's slug grammar via the structural
 * `SlugRegistryProbe` / `SlugHistoryProbe` seams (Open `runtime/slug-grammar.ts`)
 * — no provisioning registry is booted.
 *
 * Spec-conformance focus (CLAUDE.md HARD RULE):
 *   - Verifies the SPEC modules invocations land on disk / phase_state,
 *     not just phase-machine bookkeeping.
 *   - Asserts each spec'd module's effect: personaSync.recordAgentPersonality,
 *     personaSync.recordAgentName, the slug suggestion algorithm output,
 *     and `phase_state.primary_projects_confirmed[]` write.
 *   - Walks via real `engine.advance` calls — no SQL-stubbing past
 *     intermediate phases.
 *
 * The freeform extraction seam is the `llmRouter` (the deleted promptDriver
 * stub is gone, 2026-06-21 consolidation): a `stubRouter` feeds deterministic
 * `RouterDecision`s so the test is insulated from real LLM availability while
 * still exercising the "router extracts fields via state_delta" path on the
 * freeform phases (signup name + work_interview_gap_fill). The personality /
 * agent-name / slug phases are `'mixed'` mode — their validated freeform reply
 * routes straight through `consumeChoice` without the router.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { ButtonStore } from '@neutronai/channels/button-store.ts'
import type { ButtonChoice, ButtonPrompt } from '@neutronai/channels/button-primitive.ts'
import { InterviewEngine } from '@neutronai/onboarding/interview/engine.ts'
import type {
  PersonaSyncHook,
  SlugPickerEngineHook,
  SlugPickerEngineHookInput,
} from '@neutronai/onboarding/interview/engine.ts'
import type { SlugPickerOutcome } from '@neutronai/runtime/slug-picker-types.ts'
import { InMemoryOnboardingStateStore } from '@neutronai/onboarding/interview/state-store.ts'
import { TranscriptWriter } from '@neutronai/onboarding/interview/transcript.ts'
import type {
  LlmRouter,
  RouterDecision,
} from '@neutronai/onboarding/interview/llm-router.ts'
import { stubRouter, stubPlatform } from './m2-walkthrough-test-helpers.ts'
import {
  checkSlugAvailability,
  sanitizeToSlug,
} from '@neutronai/runtime/slug-grammar.ts'
import type {
  SlugRegistryProbe,
  SlugHistoryProbe,
} from '@neutronai/runtime/slug-grammar.ts'

const OWNER = 'mira'
const TOPIC = 'topic-1'
const USER = 'u-1'

let tmp: string
let db: ProjectDb
let buttonStore: ButtonStore
let stateStore: InMemoryOnboardingStateStore
let transcript: TranscriptWriter
let sentPrompts: Array<{ prompt: ButtonPrompt }>

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-s7-flow-open-'))
  db = ProjectDb.open(join(tmp, 'owner.db'))
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

/**
 * The driver-stub extraction seam was DELETED in the 2026-06-21
 * consolidation; freeform extraction now flows ONLY through the
 * `llmRouter`. With `platform: stubPlatform('all')` the router is consulted
 * on every freeform-mode phase that carries a knowledge pack — here that's
 * `signup` (the name reply) and `work_interview_gap_fill` (the projects
 * reply). The personality / agent-name / slug phases are `'mixed'` mode:
 * their validated freeform reply IS the answer and routes straight through
 * the existing `consumeChoice` cascade WITHOUT the router. So only two
 * router decisions are needed per `landAtPersonality` walk.
 *
 * An `advance` decision answers the current question via `freeform_text`;
 * for the gap-fill it ALSO carries the extracted structured fields in
 * `state_delta` (the engine merges the whitelisted delta into phase_state
 * before the gap-fill audit runs, then — seeing the router was consulted
 * upstream — does NOT re-extract). The Mira walk volunteers all three
 * projects + two interests in one reply, so the single gap-fill advance
 * clears the audit gate in one turn (the same one-turn-clear the deleted
 * driver gave).
 */
function advanceDecision(
  freeform_text: string,
  state_delta: RouterDecision['state_delta'] = null,
): RouterDecision {
  return {
    action: 'advance',
    confidence: 0.97,
    choice_value: null,
    freeform_text,
    response: null,
    state_delta,
    reasoning: 'test: scripted advance',
  }
}

/** The two scripted router decisions the `landAtPersonality` walk needs:
 *  the signup name reply, then the gap-fill projects+interests reply that
 *  clears the audit in one turn. */
function landAtPersonalityDecisions(): RouterDecision[] {
  return [
    advanceDecision('Mira'),
    advanceDecision(
      'Working on a fragrance brand and a hotel group; outside work yoga + family time.',
      {
        primary_projects: ['fragrance brand', 'hotel group', 'CC course'],
        non_work_interests: [{ name: 'yoga' }, { name: 'family time' }],
      },
    ),
  ]
}

interface RegistryStub extends SlugRegistryProbe {
  takenSlugs: Set<string>
}

function makeRegistryStub(taken: ReadonlyArray<string> = []): RegistryStub {
  const takenSlugs = new Set(taken)
  return {
    takenSlugs,
    getBySlug(slug: string) {
      if (takenSlugs.has(slug)) {
        return { internal_handle: `ih-${slug}` }
      }
      return undefined
    },
  }
}

function makeSlugHistoryStub(reserved: ReadonlyArray<string> = []): SlugHistoryProbe {
  const set = new Set(reserved)
  return {
    isPermanentlyReserved(slug: string) {
      return set.has(slug)
    },
  }
}

interface PersonaSyncRecorder extends PersonaSyncHook {
  recorded: Array<
    | { kind: 'agent_name'; value: string | null }
    | { kind: 'user_first_name'; value: string | null }
    | { kind: 'agent_personality'; value: string | null }
  >
}

function makePersonaSyncRecorder(): PersonaSyncRecorder {
  const recorded: PersonaSyncRecorder['recorded'] = []
  return {
    recorded,
    async recordAgentName(input) {
      recorded.push({ kind: 'agent_name', value: input.agent_name })
    },
    async recordUserFirstName(input) {
      recorded.push({ kind: 'user_first_name', value: input.user_first_name })
    },
    async recordAgentPersonality(input) {
      recorded.push({
        kind: 'agent_personality',
        value: input.agent_personality,
      })
    },
  }
}

interface MakeEngineOpts {
  takenSlugs?: ReadonlyArray<string>
  personaSync?: PersonaSyncHook
  /**
   * When true, wire a `slugPicker` stub that always resolves picks as
   * `skipped` so the engine advances to projects_proposed without
   * exercising the rename pipeline. Default true so the slug body
   * renders the multi-suggestion shape (single-suggestion fallback only
   * fires when picker is unwired).
   */
  wireSlugPicker?: boolean
  /**
   * Scripted `llmRouter` decisions, consumed in order on each freeform-mode
   * router consultation (signup name reply + gap-fill reply). Defaults to
   * the two `landAtPersonality` needs. Pass a longer list for tests that
   * walk extra router-consulted freeform turns (e.g. a projects_proposed
   * list edit).
   */
  routerDecisions?: ReadonlyArray<RouterDecision>
}

const slugPickerCalls: SlugPickerEngineHookInput[] = []

function makeStubSlugPicker(): SlugPickerEngineHook {
  return {
    async processReply(input): Promise<SlugPickerOutcome> {
      slugPickerCalls.push(input)
      // Treat every tap as "kept" so the engine advances to
      // projects_proposed without exercising the rename pipeline. This
      // is sufficient for S7 spec-conformance: the body-render path and
      // the multi-suggestion buttons are what we're asserting.
      return { kind: 'skipped', reason: 'same_slug' }
    },
  }
}

function makeEngine(opts: MakeEngineOpts = {}): InterviewEngine {
  const personaSync = opts.personaSync ?? makePersonaSyncRecorder()
  const wirePicker = opts.wireSlugPicker !== false
  // Wire the multi-suggestion path through the live `slugAvailability`
  // PlatformAdapter seam (the legacy slugRegistry/slugHistoryStore/
  // reservedSlugs engine-dep triple was removed — R1, audit P2-1). The
  // probe wraps the same `checkSlugAvailability` grammar so suggestion
  // behavior is byte-identical to the deleted triple path.
  const registry = makeRegistryStub(opts.takenSlugs ?? [])
  const slugHistory = makeSlugHistoryStub()
  const reservedSlugs = new Set<string>([
    'admin',
    'root',
    'system',
    'neutron',
    'api',
  ])
  const slugAvailability = {
    check: (probeInput: { slug: string; selfInternalHandle?: string }) =>
      checkSlugAvailability({
        slug: probeInput.slug,
        registry,
        slugHistory,
        reservedSlugs,
        ...(probeInput.selfInternalHandle !== undefined
          ? { selfInternalHandle: probeInput.selfInternalHandle }
          : {}),
      }),
    sanitize: sanitizeToSlug,
  }
  const llmRouter: LlmRouter = stubRouter([
    ...(opts.routerDecisions ?? landAtPersonalityDecisions()),
  ]).router
  return new InterviewEngine({
    buttonStore,
    stateStore,
    transcript,
    sendButtonPrompt: async (input) => {
      sentPrompts.push({ prompt: input.prompt })
      return { message_id: `msg-${sentPrompts.length}`, was_new: true }
    },
    llmRouter,
    platform: stubPlatform('all'),
    personaSync,
    slugAvailability,
    ...(wirePicker ? { slugPicker: makeStubSlugPicker() } : {}),
  })
}

async function lastPromptId(): Promise<string> {
  const sent = sentPrompts[sentPrompts.length - 1]
  if (sent === undefined) throw new Error('no prompt has been sent yet')
  return sent.prompt.prompt_id
}

/**
 * Drive the REAL web freeform path: a typed reply with NO matching
 * ButtonChoice so `advance` hits the freeform interaction-mode branch. On
 * router-consulted phases (signup, work_interview_gap_fill) this reaches
 * the scripted `llmRouter`; on `'mixed'` phases (personality / agent-name /
 * slug) the validated text routes straight through `consumeChoice` without
 * the router. (A synthetic `__freeform__` ButtonChoice would BYPASS the
 * router entirely — not the live web shape.)
 */
async function advanceFreeform(
  engine: InterviewEngine,
  text: string,
  observed_at: number,
): Promise<void> {
  await engine.advance({
    project_slug: OWNER,
    topic_id: TOPIC,
    user_id: USER,
    channel_kind: 'app-socket',
    freeform_text: text,
    observed_at,
  })
}

async function advanceButton(
  engine: InterviewEngine,
  choice_value: string,
  observed_at: number,
): Promise<void> {
  const prompt_id = await lastPromptId()
  await engine.advance({
    project_slug: OWNER,
    topic_id: TOPIC,
    user_id: USER,
    channel_kind: 'app-socket',
    choice: {
      prompt_id,
      choice_value,
      chosen_at: observed_at,
      speaker_user_id: USER,
      channel_kind: 'app-socket',
    },
    observed_at,
  })
}

/**
 * Walk the engine from start() to `personality_offered`. The audit
 * gate clears after one gap-fill iteration thanks to the deterministic
 * driver stub above.
 */
async function landAtPersonality(
  engine: InterviewEngine,
  observed_at: number,
): Promise<number> {
  await engine.start({
    project_slug: OWNER,
    topic_id: TOPIC,
    user_id: USER,
    signup_via: 'web',
  })
  let t = observed_at
  t += 1_000
  await advanceFreeform(engine, 'Mira', t)
  t += 1_000
  await advanceButton(engine, 'neither', t)
  t += 1_000
  await advanceFreeform(
    engine,
    'Working on a fragrance brand and a hotel group; outside work yoga + family time.',
    t,
  )
  const state = await stateStore.get(OWNER, USER)
  expect(state!.phase).toBe('personality_offered')
  return t
}

describe('P2 v2 § 3.9 — personality_offered (free-text path)', () => {
  test('captures agent_personality on freeform reply + writes to phase_state + persona store', async () => {
    const personaSync = makePersonaSyncRecorder()
    const engine = makeEngine({ personaSync })
    let t = await landAtPersonality(engine, 1_700_000_000_000)

    t += 1_000
    await advanceFreeform(
      engine,
      'A sharp strategist who pushes back when I am hand-waving',
      t,
    )
    const state = await stateStore.get(OWNER, USER)
    expect(state!.phase).toBe('agent_name_chosen')
    expect(state!.phase_state['agent_personality']).toBe(
      'A sharp strategist who pushes back when I am hand-waving',
    )
    expect(
      personaSync.recorded.some(
        (r) =>
          r.kind === 'agent_personality' &&
          typeof r.value === 'string' &&
          r.value.startsWith('A sharp strategist'),
      ),
    ).toBe(true)
  })

  test('reply under 4 chars stays on personality_offered + sets rejection_reason', async () => {
    const engine = makeEngine()
    let t = await landAtPersonality(engine, 1_700_000_000_000)

    t += 1_000
    await advanceFreeform(engine, 'hi', t)
    const state = await stateStore.get(OWNER, USER)
    expect(state!.phase).toBe('personality_offered')
    expect(
      typeof state!.phase_state['personality_offered_rejection'],
    ).toBe('string')
    // The next emit re-prompts with the rejection prepended.
    const last = sentPrompts[sentPrompts.length - 1]!.prompt
    expect(last.body).toContain("didn't catch")
  })

  test('archetype reference in reply is honoured as free text (no curated-menu lookup)', async () => {
    const engine = makeEngine()
    let t = await landAtPersonality(engine, 1_700_000_000_000)

    t += 1_000
    await advanceFreeform(engine, 'Like Gandalf the White', t)
    const state = await stateStore.get(OWNER, USER)
    expect(state!.phase).toBe('agent_name_chosen')
    expect(state!.phase_state['agent_personality']).toBe(
      'Like Gandalf the White',
    )
  })
})

describe('P2 v2 § 3.10 — agent_name_chosen', () => {
  async function landAtName(
    engine: InterviewEngine,
    observed_at: number,
  ): Promise<number> {
    let t = await landAtPersonality(engine, observed_at)
    t += 1_000
    await advanceFreeform(engine, 'A sharp strategist with warmth', t)
    const state = await stateStore.get(OWNER, USER)
    expect(state!.phase).toBe('agent_name_chosen')
    return t
  }

  test('valid name → captured + persisted + suggested_slug derived (agent-name-primary) + advances to slug_chosen', async () => {
    const personaSync = makePersonaSyncRecorder()
    const engine = makeEngine({ personaSync })
    let t = await landAtName(engine, 1_700_000_000_000)

    t += 1_000
    await advanceFreeform(engine, 'Mimir', t)
    const state = await stateStore.get(OWNER, USER)
    expect(state!.phase).toBe('slug_chosen')
    expect(state!.phase_state['agent_name']).toBe('Mimir')
    // P2 v2 § 2.8 Alex-lock — primary suggestion is
    // `<agent_name>-<user_first_name>` (Codex r1 P1 fix). The legacy
    // `slugify(agent_name)` alone shape is gone.
    expect(state!.phase_state['suggested_slug']).toBe('mimir-mira')
    expect(
      personaSync.recorded.some(
        (r) => r.kind === 'agent_name' && r.value === 'Mimir',
      ),
    ).toBe(true)
  })

  test('reserved name → stays on agent_name_chosen with rejection reason', async () => {
    const engine = makeEngine()
    let t = await landAtName(engine, 1_700_000_000_000)

    t += 1_000
    await advanceFreeform(engine, 'Claude', t)
    const state = await stateStore.get(OWNER, USER)
    expect(state!.phase).toBe('agent_name_chosen')
    expect(state!.phase_state['agent_name']).not.toBe('Claude')
    // Live web shape: `agent_name_chosen` is a `'mixed'`-interaction phase,
    // so the typed reply is validated by the canonical `validateAgentName`
    // BEFORE it reaches `consumeChoice`. A reserved name fails that gate and
    // the engine surfaces the recoverable reason to the USER (the re-emitted
    // prompt body carries it) rather than persisting an internal
    // `agent_name_chosen_rejection` bookkeeping field — that field is only
    // written on the `consumeChoice` path (a valid name / a button tap). The
    // INTENT — "stay on phase, tell the user it's reserved" — is preserved
    // through the mixed-mode seam.
    const last = sentPrompts[sentPrompts.length - 1]!.prompt
    expect(last.body.toLowerCase()).toContain('reserved')
  })

  test('name with invalid chars (e.g. punctuation) → stays + rejection reason', async () => {
    const engine = makeEngine()
    let t = await landAtName(engine, 1_700_000_000_000)

    t += 1_000
    await advanceFreeform(engine, 'Mimir@home', t)
    const state = await stateStore.get(OWNER, USER)
    expect(state!.phase).toBe('agent_name_chosen')
    expect(state!.phase_state['agent_name']).not.toBe('Mimir@home')
    // Mixed-mode validation rejects the punctuation BEFORE consumeChoice (see
    // the reserved-name test). The recoverable reason is surfaced to the user
    // via the re-emitted prompt body — assert the user sees the
    // letters/numbers guidance rather than an internal rejection field.
    const last = sentPrompts[sentPrompts.length - 1]!.prompt
    expect(last.body.toLowerCase()).toContain('letters')
  })

  test('1-char name → rejected (length floor 2)', async () => {
    const engine = makeEngine()
    let t = await landAtName(engine, 1_700_000_000_000)

    t += 1_000
    await advanceFreeform(engine, 'X', t)
    const state = await stateStore.get(OWNER, USER)
    expect(state!.phase).toBe('agent_name_chosen')
    expect(state!.phase_state['agent_name']).not.toBe('X')
  })

  test('after a rejection, a follow-up valid name advances to slug_chosen', async () => {
    const engine = makeEngine()
    let t = await landAtName(engine, 1_700_000_000_000)

    t += 1_000
    await advanceFreeform(engine, 'Claude', t)
    let state = await stateStore.get(OWNER, USER)
    expect(state!.phase).toBe('agent_name_chosen')

    t += 1_000
    await advanceFreeform(engine, 'Sage', t)
    state = await stateStore.get(OWNER, USER)
    expect(state!.phase).toBe('slug_chosen')
    expect(state!.phase_state['agent_name']).toBe('Sage')
    expect(state!.phase_state['agent_name_chosen_rejection']).toBeNull()
  })
})

describe('P2 v2 § 3.11 — slug_chosen (agent-name-primary algorithm)', () => {
  async function landAtSlug(
    engine: InterviewEngine,
    observed_at: number,
    agent_name = 'Mimir',
  ): Promise<number> {
    let t = await landAtPersonality(engine, observed_at)
    t += 1_000
    await advanceFreeform(engine, 'A sharp strategist with warmth', t)
    t += 1_000
    await advanceFreeform(engine, agent_name, t)
    const state = await stateStore.get(OWNER, USER)
    expect(state!.phase).toBe('slug_chosen')
    return t
  }

  test('body surfaces agent-name-primary slug as default (mimir-mira)', async () => {
    const engine = makeEngine()
    await landAtSlug(engine, 1_700_000_000_000)

    const last = sentPrompts[sentPrompts.length - 1]!.prompt
    // Primary suggestion per § 2.8 — `<agent_name>-<first_name>`. The de-hosted
    // copy lists it as option A (the default) rather than a full hosted URL.
    expect(last.body).toContain('mimir-mira   (the default)')
    // Body lists multiple candidates per § 2.8 — the agent-name-only alt.
    expect(last.body).toContain('mimir')
  })

  test('options include the multi-suggestion buttons (use-suggested + use-slug:<alt>)', async () => {
    const engine = makeEngine()
    await landAtSlug(engine, 1_700_000_000_000)

    const last = sentPrompts[sentPrompts.length - 1]!.prompt
    const values = (last.options ?? []).map((o) => o.value)
    expect(values).toContain('use-suggested')
    // At least one `use-slug:<value>` alt button.
    expect(values.some((v) => v.startsWith('use-slug:'))).toBe(true)
  })

  test('collision on primary shifts default to NNN-suffixed candidate', async () => {
    // Pre-seed the registry stub so `mimir-mira` is taken; the algorithm
    // should fall back to the 3-digit-random candidate.
    const engine = makeEngine({ takenSlugs: ['mimir-mira'] })
    await landAtSlug(engine, 1_700_000_000_000)

    const last = sentPrompts[sentPrompts.length - 1]!.prompt
    // `mimir-mira` is taken — the body must not advertise it as the default.
    expect(last.body).not.toContain('mimir-mira   (the default)')
    // The collision fallback shape is `mimir-mira-NNN`. Body should
    // include one such candidate.
    expect(last.body).toMatch(/mimir-mira-\d{3}/)
  })
})

describe('P2 v2 § 3.12 — projects_proposed', () => {
  async function landAtProjects(
    engine: InterviewEngine,
    observed_at: number,
  ): Promise<number> {
    let t = await landAtPersonality(engine, observed_at)
    t += 1_000
    await advanceFreeform(engine, 'A sharp strategist with warmth', t)
    t += 1_000
    await advanceFreeform(engine, 'Mimir', t)
    // We're now at slug_chosen. Gate-collapse (#93, 2026-06-05) removed the
    // interactive projects_proposed gate from the LIVE flow — the slug
    // advance now AUTO-CONFIRMS the already-reviewed list and skips straight
    // to persona_synthesizing (no second "Good to go" approval). But the
    // projects_proposed prompt BUILDER + the consumeProjectsProposedChoice
    // handler are RETAINED defensively (for any stale in-flight prompt), so
    // the tests below still exercise them by seeding projects_proposed
    // DIRECTLY (carrying the walked primary_projects) and emitting its
    // prompt via a no-choice advance — rather than reaching it via the now
    // auto-confirming slug advance.
    const slugState = await stateStore.get(OWNER, USER)
    expect(slugState!.phase).toBe('slug_chosen')
    t += 1_000
    await stateStore.upsert({
      user_id: USER,
      project_slug: OWNER,
      phase: 'projects_proposed',
      phase_state_patch: { active_prompt_id: null },
      advanced_at: t,
    })
    // No-choice advance emits the projects_proposed prompt (this entry does
    // NOT trigger the auto-confirm, which only fires from the slug advance /
    // start() landing).
    await engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      observed_at: t,
    })
    const state = await stateStore.get(OWNER, USER)
    expect(state!.phase).toBe('projects_proposed')
    return t
  }

  test('body renders the collected project list', async () => {
    const engine = makeEngine()
    await landAtProjects(engine, 1_700_000_000_000)

    const last = sentPrompts[sentPrompts.length - 1]!.prompt
    // Per § 3.12 the body lists the captured projects.
    expect(last.body).toContain('fragrance brand')
    expect(last.body).toContain('hotel group')
    expect(last.body).toContain('CC course')
    // 2026-05-28 single-CTA collapse — only [A] Good to go remains
    // (the [B] Review each one button was a no-op dead-end per Alex's
    // walkthrough). Freeform stays open for tweak replies.
    const values = (last.options ?? []).map((o) => o.value)
    expect(values).toContain('confirm')
    expect(values).not.toContain('review')
    expect(last.allow_freeform).toBe(true)
  })

  test("auto-create tap → advances + writes primary_projects_confirmed", async () => {
    const engine = makeEngine()
    let t = await landAtProjects(engine, 1_700_000_000_000)

    t += 1_000
    await advanceButton(engine, 'confirm', t)
    const state = await stateStore.get(OWNER, USER)
    // persona_synthesizing is auto-skip; without a personaComposer wired
    // the engine lands at persona_reviewed (the auto-skip target).
    expect(state!.phase).toBe('persona_reviewed')
    expect(state!.phase_state['primary_projects_confirmed']).toEqual([
      'fragrance brand',
      'hotel group',
      'CC course',
    ])
    expect(state!.phase_state['projects_proposed_confirm_kind']).toBe(
      'auto-create',
    )
  })

  test('review-each-one tap → also advances (per-project edit deferred per S7 brief)', async () => {
    const engine = makeEngine()
    let t = await landAtProjects(engine, 1_700_000_000_000)

    t += 1_000
    await advanceButton(engine, 'review', t)
    const state = await stateStore.get(OWNER, USER)
    expect(state!.phase).toBe('persona_reviewed')
    expect(state!.phase_state['projects_proposed_confirm_kind']).toBe(
      'review-deferred',
    )
  })
})

describe('P2 v2 § 3.10 / S7 — agent-name → slug primary derivation (Codex r1 P1)', () => {
  test('valid agent_name persists `suggested_slug` as `<agent_name>-<user_first_name>` (primary)', async () => {
    // Codex r1 P1: pre-fix `suggested_slug` was `slugify(agent_name)`
    // alone (e.g. `mimir`), but the slug_chosen resolver surfaced
    // `mimir-mira` as the primary URL. Tapping `use-suggested` then
    // renamed the owner instance to `mimir` — the URL the user did NOT see.
    // Post-fix `suggested_slug` IS the primary candidate so the
    // resolver + the bridge agree.
    const engine = makeEngine()
    let t = await landAtPersonality(engine, 1_700_000_000_000)

    t += 1_000
    await advanceFreeform(engine, 'A sharp strategist with warmth', t)
    t += 1_000
    await advanceFreeform(engine, 'Mimir', t)

    const state = await stateStore.get(OWNER, USER)
    expect(state!.phase).toBe('slug_chosen')
    // The persisted suggested_slug MUST be the agent-name-primary
    // candidate, not the bare agent name.
    expect(state!.phase_state['suggested_slug']).toBe('mimir-mira')
    expect(state!.phase_state['agent_name']).toBe('Mimir')
  })
})

describe('P2 v2 § 3.12 / S7 — projects_proposed honours LLM-extracted edits (Codex r1 P1)', () => {
  test('freeform "drop one, add another" reply lands in primary_projects_confirmed', async () => {
    // Codex r1 P1: pre-fix the confirm path persisted
    // `[...persisted_projects]` BEFORE the extracted_patch overrode
    // them, so a user's "drop hotel, add Sound Ceremony" tweak was
    // silently discarded. Post-fix the merged view (extracted patch
    // wins) drives `primary_projects_confirmed`.
    const slugPickerCallsLocal: SlugPickerEngineHookInput[] = []
    const stubPicker: SlugPickerEngineHook = {
      async processReply(input) {
        slugPickerCallsLocal.push(input)
        return { kind: 'skipped', reason: 'same_slug' }
      },
    }
    // Router decisions for this walk: (1) signup name, (2) gap-fill
    // projects+interests, (3) the projects_proposed list edit. The edit is a
    // REVIEW-completing advance — it both answers the review AND carries the
    // corrected facts, so it advances past projects_proposed (the one case
    // where an advance carries a non-null state_delta, llm-router.ts §
    // REVIEW/CORRECTION). `removed_projects` is the transient removal signal
    // the advance-path additive merge (`mergeAdvanceProjectsAdditively`)
    // honors: (seeded ∪ adds) MINUS removals. Seeded [fragrance, hotel, CC] ∪
    // adds [fragrance, CC, Sound Ceremony] minus [hotel] = [fragrance, CC,
    // Sound Ceremony].
    const editDecisions: RouterDecision[] = [
      ...landAtPersonalityDecisions(),
      advanceDecision('drop hotel, add Sound Ceremony', {
        primary_projects: ['fragrance brand', 'CC course', 'Sound Ceremony'],
        // `removed_projects` is whitelist-stripped before it reaches
        // phase_state, but `mergeAdvanceProjectsAdditively` reads it first.
        removed_projects: ['hotel group'],
      } as RouterDecision['state_delta']),
    ]
    const engine = new InterviewEngine({
      buttonStore,
      stateStore,
      transcript,
      sendButtonPrompt: async (input) => {
        sentPrompts.push({ prompt: input.prompt })
        return { message_id: `msg-${sentPrompts.length}`, was_new: true }
      },
      // Freeform extraction flows ONLY through the `llmRouter` now (the
      // driver seam was deleted). With `stubPlatform('all')` the populated
      // projects_proposed list-review edit is routed to the router (the
      // engine's #117 interaction-mode override flips buttons-only →
      // freeform when the router is wired + consulted).
      llmRouter: stubRouter(editDecisions).router,
      platform: stubPlatform('all'),
      personaSync: makePersonaSyncRecorder(),
      // No slug-suggestion wiring needed — this test exercises the
      // projects_proposed merge path; the slug phase auto-advances via
      // the stub picker (R1, audit P2-1 removed the engine-dep triple).
      slugPicker: stubPicker,
    })

    let t = await landAtPersonality(engine, 1_700_000_000_000)
    t += 1_000
    await advanceFreeform(engine, 'A sharp strategist with warmth', t)
    t += 1_000
    await advanceFreeform(engine, 'Mimir', t)
    // Gate-collapse (#93): the live slug advance auto-confirms past
    // projects_proposed, but the consumeProjectsProposedChoice freeform-edit
    // handler is RETAINED defensively. Seed projects_proposed directly
    // (carrying the walked primary_projects) + emit its prompt so we still
    // exercise that retained edit path.
    let state = await stateStore.get(OWNER, USER)
    expect(state!.phase).toBe('slug_chosen')
    t += 1_000
    await stateStore.upsert({
      user_id: USER,
      project_slug: OWNER,
      phase: 'projects_proposed',
      phase_state_patch: { active_prompt_id: null },
      advanced_at: t,
    })
    await engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      observed_at: t,
    })
    state = await stateStore.get(OWNER, USER)
    expect(state!.phase).toBe('projects_proposed')

    // User free-text-edits the list — extracted_patch carries the new
    // primary_projects shape.
    t += 1_000
    await advanceFreeform(engine, 'drop hotel, add Sound Ceremony', t)
    state = await stateStore.get(OWNER, USER)
    expect(state!.phase).toBe('persona_reviewed')
    expect(state!.phase_state['primary_projects_confirmed']).toEqual([
      'fragrance brand',
      'CC course',
      'Sound Ceremony',
    ])
  })
})

describe('P2 v2 / S7 — end-to-end walk traverses all four phases', () => {
  test('signup → … → personality_offered → agent_name_chosen → slug_chosen → projects_proposed → persona_reviewed', async () => {
    const personaSync = makePersonaSyncRecorder()
    const engine = makeEngine({ personaSync })
    let t = await landAtPersonality(engine, 1_700_000_000_000)

    // personality_offered → free text
    t += 1_000
    await advanceFreeform(engine, 'A sharp strategist who pushes back', t)
    let state = await stateStore.get(OWNER, USER)
    expect(state!.phase).toBe('agent_name_chosen')

    // agent_name_chosen → free text
    t += 1_000
    await advanceFreeform(engine, 'Mimir', t)
    state = await stateStore.get(OWNER, USER)
    expect(state!.phase).toBe('slug_chosen')

    // slug_chosen → tap primary suggestion (stub picker treats every
    // tap as `skipped` so we advance without exercising rename).
    // Gate-collapse (#93): the slug advance now AUTO-CONFIRMS the
    // already-reviewed project list (no redundant "Good to go" gate) and
    // traverses projects_proposed → persona_synthesizing → persona_reviewed
    // in one step, writing primary_projects_confirmed[] along the way.
    t += 1_000
    await advanceButton(engine, 'use-suggested', t)
    state = await stateStore.get(OWNER, USER)
    expect(state!.phase).toBe('persona_reviewed')

    // Spec-conformance: every spec-required dual-store write fired.
    expect(
      personaSync.recorded.some(
        (r) => r.kind === 'user_first_name' && r.value === 'Mira',
      ),
    ).toBe(true)
    expect(
      personaSync.recorded.some(
        (r) =>
          r.kind === 'agent_personality' &&
          typeof r.value === 'string' &&
          r.value.startsWith('A sharp strategist'),
      ),
    ).toBe(true)
    expect(
      personaSync.recorded.some(
        (r) => r.kind === 'agent_name' && r.value === 'Mimir',
      ),
    ).toBe(true)
    expect(state!.phase_state['primary_projects_confirmed']).toEqual([
      'fragrance brand',
      'hotel group',
      'CC course',
    ])
  })
})
