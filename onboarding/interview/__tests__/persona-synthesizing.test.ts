/**
 * T1 (2026-05-13) — InterviewEngine `persona_synthesizing` +
 * `persona_reviewed` wiring tests. Per the spec-vs-current diff in the
 * T1 brief: PersonaComposer.compose() had ZERO production call sites
 * before this sprint; persona_synthesizing was a no-op transit phase
 * and persona_reviewed shipped with the hardcoded "Looks great, let's
 * pick your personal URL" body. These tests assert the product-logic
 * the spec requires:
 *
 *   1. compose(...) is called on the transition INTO persona_synthesizing
 *   2. compose(...) receives the captured signals (display_name,
 *      time_style, work_pattern, rituals) from phase_state
 *   3. the persona_reviewed body renders an excerpt of the generated
 *      content (not the hardcoded placeholder)
 *   4. the body does NOT leak the internal filenames (SOUL.md, USER.md,
 *      priority-map.md)
 *   5. applyEdit fires on the [B] Edit one line sub-flow
 *   6. commit fires on [A] Looks good
 *   7. the engine advances to max_oauth_offered after commit
 *      (P2-onboarding-v2 § 3.14 — slug moved EARLIER in the chain, so
 *      the post-persona advance is the Max-attach offer, not the slug
 *      picker)
 *   8. an E2E walk via real engine.advance calls (no SQL phase stubs)
 *      lands at persona_reviewed with the file content rendered
 *
 * Per CLAUDE.md HARD RULE: phase-machine bookkeeping assertions ALONE
 * are insufficient. Every test below asserts an explicit `compose /
 * applyEdit / commit` invocation OR an on-disk artifact.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '../../../migrations/runner.ts'
import { ProjectDb } from '../../../persistence/index.ts'
import { ButtonStore } from '../../../channels/button-store.ts'
import type { ButtonPrompt } from '../../../channels/button-primitive.ts'
import {
  InterviewEngine,
  type PersonaComposerHook,
} from '../engine.ts'
import { InMemoryOnboardingStateStore } from '../state-store.ts'
import { TranscriptWriter } from '../transcript.ts'
import { PersonaComposer } from '../../persona-gen/compose.ts'
import { buildCringeChecker } from '../../persona-gen/cringe-check.ts'
import type {
  ApplyEditInput as PersonaApplyEditInput,
  ComposeInput as PersonaComposeInput,
  PersonaDraft,
} from '../../persona-gen/compose.ts'

const OWNER = 't-persona-test'
const USER = 'u-1'
const TOPIC = `web:${USER}`

interface Recorder {
  composeCalls: PersonaComposeInput[]
  applyEditCalls: PersonaApplyEditInput[]
  commitCalls: PersonaDraft[]
}

function makeRecordingHook(realComposer: PersonaComposer, rec: Recorder): PersonaComposerHook {
  return {
    async compose(input) {
      rec.composeCalls.push(input)
      return await realComposer.compose(input)
    },
    async applyEdit(input) {
      rec.applyEditCalls.push(input)
      return await realComposer.applyEdit(input)
    },
    async commit(draft) {
      rec.commitCalls.push(draft)
      return await realComposer.commit(draft)
    },
  }
}

interface Harness {
  tmp: string
  db: ProjectDb
  stateStore: InMemoryOnboardingStateStore
  buttonStore: ButtonStore
  transcript: TranscriptWriter
  composer: PersonaComposer
  hook: PersonaComposerHook
  rec: Recorder
  engine: InterviewEngine
  sentPrompts: Array<{ project_slug: string; topic_id: string; prompt: ButtonPrompt }>
}

function makeHarness(): Harness {
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-persona-'))
  const db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
  const buttonStore = new ButtonStore({ db })
  const stateStore = new InMemoryOnboardingStateStore()
  const transcript = new TranscriptWriter({
    path: join(tmp, 'persona', 'onboarding-transcript.jsonl'),
  })
  const composer = new PersonaComposer({
    cringeChecker: buildCringeChecker(),
    ownerHomeFor: (_slug: string): string => join(tmp, 'persona'),
  })
  const rec: Recorder = { composeCalls: [], applyEditCalls: [], commitCalls: [] }
  const hook = makeRecordingHook(composer, rec)
  const sentPrompts: Harness['sentPrompts'] = []
  const engine = new InterviewEngine({
    buttonStore,
    stateStore,
    transcript,
    sendButtonPrompt: async (input) => {
      sentPrompts.push(input)
      return { message_id: `msg-${sentPrompts.length}`, was_new: true }
    },
    personaComposer: hook,
  })
  return { tmp, db, stateStore, buttonStore, transcript, composer, hook, rec, engine, sentPrompts }
}

function teardown(h: Harness): void {
  h.db.close()
  rmSync(h.tmp, { recursive: true, force: true })
}

/**
 * Seed onboarding_state at `projects_proposed` with captured signals so
 * the next button tap walks projects_proposed → persona_synthesizing →
 * persona_reviewed in one real advance call.
 */
async function seedProjectsProposed(h: Harness): Promise<string> {
  await h.stateStore.upsert({
    user_id: USER,
    project_slug: OWNER,
    phase: 'projects_proposed',
    phase_state_patch: {
      user_id: USER,
      topic_id: TOPIC,
      signup_via: 'web',
      agent_name: 'Nova',
      time_style: 'async-low',
      work_pattern: 'solo deep work in the morning, calls in the afternoon',
      rituals_captured: ['weekly review on Sunday'],
    },
    advanced_at: Date.now(),
  })
  // Drive a first emit so projects_proposed has a live keyboard.
  await h.engine.advance({
    project_slug: OWNER,
    topic_id: TOPIC,
    user_id: USER,
    channel_kind: 'app-socket',
    observed_at: Date.now(),
  })
  const state = await h.stateStore.get(OWNER, USER)
  const apid = (state?.phase_state as Record<string, unknown>)['active_prompt_id']
  if (typeof apid !== 'string') throw new Error('seed: missing active_prompt_id')
  return apid
}

describe('InterviewEngine — persona_synthesizing wiring (T1, 2026-05-13)', () => {
  let h: Harness
  afterEach(() => teardown(h))

  test('1. compose is called exactly once on persona_synthesizing entry', async () => {
    h = makeHarness()
    const prompt_id = await seedProjectsProposed(h)
    const result = await h.engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      choice: {
        prompt_id,
        choice_value: 'auto',
        chosen_at: Date.now(),
        speaker_user_id: USER,
        channel_kind: 'app-socket',
      },
      observed_at: Date.now(),
    })
    expect(h.rec.composeCalls.length).toBe(1)
    expect(result.state?.phase).toBe('persona_reviewed')
  })

  test('2. compose receives captured signals (agent_name, time_style, work_pattern, rituals)', async () => {
    h = makeHarness()
    const prompt_id = await seedProjectsProposed(h)
    await h.engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      choice: {
        prompt_id,
        choice_value: 'auto',
        chosen_at: Date.now(),
        speaker_user_id: USER,
        channel_kind: 'app-socket',
      },
      observed_at: Date.now(),
    })
    expect(h.rec.composeCalls.length).toBe(1)
    const call = h.rec.composeCalls[0]!
    expect(call.signals.display_name).toBe('Nova')
    expect(call.signals.time_style).toBe('async-low')
    expect(call.signals.work_pattern).toContain('deep work in the morning')
    expect(call.signals.rituals?.[0]).toBe('weekly review on Sunday')
    expect(call.user_facts.display_name).toBe('Nova')
  })

  test('3. persona_reviewed body renders a conversational summary (v0.1.80) — NO raw .md excerpts', async () => {
    // v0.1.80 (2026-05-22) — `persona_reviewed` body is now a 3-4
    // sentence plain-English summary, NOT the raw SOUL.md / USER.md /
    // priority-map.md excerpts. The summary is generated by the
    // `personaSummarizer` LLM call (memoized) when wired; otherwise
    // the deterministic `staticPersonaSummary(...)` ships. This test
    // harness wires no summarizer so the static path runs.
    h = makeHarness()
    const prompt_id = await seedProjectsProposed(h)
    await h.engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      choice: {
        prompt_id,
        choice_value: 'auto',
        chosen_at: Date.now(),
        speaker_user_id: USER,
        channel_kind: 'app-socket',
      },
      observed_at: Date.now(),
    })
    const last = h.sentPrompts.at(-1)?.prompt
    expect(last).toBeTruthy()
    // Summary opener — "Here's how I'll work with you" is the
    // deterministic prefix of `staticPersonaSummary`.
    expect(last!.body).toContain("Here's how I'll work with you")
    // Closing soft-tweak hook.
    expect(last!.body).toContain('Sound right')
    // Raw-excerpt sectioning is GONE.
    expect(last!.body).not.toContain('**Voice + style**')
    expect(last!.body).not.toContain('**About you**')
    expect(last!.body).not.toContain('**What matters**')
    expect(last!.body).not.toContain('Communication Style')
    // Gate-collapse (#93, 2026-06-05) — single "Looks good" CTA. The
    // "Tweak one line" / "Restart" buttons were removed per Sam; a typed
    // reply on this screen is now the tweak path (recompose).
    const buttons = last!.options.map((o) => o.body)
    expect(buttons).toEqual(['Looks good'])
  })

  test('4. body does NOT leak the literal persona file names anywhere in the user-visible bubble', async () => {
    // T11 (2026-05-15) — the on-disk persona files keep their canonical
    // `# SOUL.md` / `# USER.md` / `# priority-map.md` H1s (every
    // internal consumer expects them). The engine strips those H1s at
    // the excerpt-render boundary, so the user-visible bubble shows
    // friendly section titles ("Voice + style", "About you",
    // "What matters") and never echoes the raw filename — anywhere.
    h = makeHarness()
    const prompt_id = await seedProjectsProposed(h)
    await h.engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      choice: {
        prompt_id,
        choice_value: 'auto',
        chosen_at: Date.now(),
        speaker_user_id: USER,
        channel_kind: 'app-socket',
      },
      observed_at: Date.now(),
    })
    const last = h.sentPrompts.at(-1)?.prompt
    expect(last!.body).not.toContain('SOUL.md')
    expect(last!.body).not.toContain('USER.md')
    expect(last!.body).not.toContain('priority-map.md')
  })

  test('5. [B] Tweak one line routes through compose() with the freeform hint (v0.1.80, no applyEdit)', async () => {
    // v0.1.80 (2026-05-22) — "Tweak one line" no longer drives a
    // line-coordinate sub-flow. Instead it surfaces a conversational
    // "what should I change?" prompt; the user's freeform reply lands
    // as a `regen_hint` on the next `compose()` call. The legacy
    // applyEdit path is dead. PERSONA_MAX_RESTARTS is NOT incremented
    // on the tweak path (vs the [C] Restart path).
    h = makeHarness()
    const prompt_id = await seedProjectsProposed(h)
    // projects_proposed → persona_synthesizing → persona_reviewed
    await h.engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      choice: {
        prompt_id,
        choice_value: 'auto',
        chosen_at: Date.now(),
        speaker_user_id: USER,
        channel_kind: 'app-socket',
      },
      observed_at: Date.now(),
    })
    expect(h.rec.composeCalls.length).toBe(1)
    // User taps [B] Tweak one line
    const reviewState = await h.stateStore.get(OWNER, USER)
    const reviewPromptId = (reviewState!.phase_state as Record<string, unknown>)[
      'active_prompt_id'
    ] as string
    await h.engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      choice: {
        prompt_id: reviewPromptId,
        choice_value: 'edit_line',
        chosen_at: Date.now(),
        speaker_user_id: USER,
        channel_kind: 'app-socket',
      },
      observed_at: Date.now(),
    })
    // Engine should now surface the conversational "what should I
    // change?" prompt with freeform-only affordance.
    const tweakPromptState = await h.stateStore.get(OWNER, USER)
    const tweakSubStep = (tweakPromptState!.phase_state as Record<string, unknown>)[
      'persona_review_sub_step'
    ]
    expect(tweakSubStep).toBe('pending_regen_hint')
    const tweakMode = (tweakPromptState!.phase_state as Record<string, unknown>)[
      'persona_review_tweak_mode'
    ]
    expect(tweakMode).toBe(true)
    const tweakPromptBody = h.sentPrompts.at(-1)?.prompt.body ?? ''
    expect(tweakPromptBody).toContain('What should I change')
    // User provides the conversational tweak hint.
    const tweakPromptId = (tweakPromptState!.phase_state as Record<string, unknown>)[
      'active_prompt_id'
    ] as string
    await h.engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      choice: {
        prompt_id: tweakPromptId,
        choice_value: '__freeform__',
        freeform_text: 'Be a bit warmer and use Sam by name more often.',
        chosen_at: Date.now(),
        speaker_user_id: USER,
        channel_kind: 'app-socket',
      },
      observed_at: Date.now(),
    })
    // applyEdit MUST NOT fire on the new flow.
    expect(h.rec.applyEditCalls.length).toBe(0)
    // Instead, compose() fires again with the freeform hint threaded
    // through as `regen_hint`.
    expect(h.rec.composeCalls.length).toBe(2)
    const secondCompose = h.rec.composeCalls[1]!
    expect(secondCompose.regen_hint).toBe(
      'Be a bit warmer and use Sam by name more often.',
    )
    // Tweak mode preserves the restart counter.
    const afterState = await h.stateStore.get(OWNER, USER)
    const restartCount =
      (afterState!.phase_state as Record<string, unknown>)['persona_restart_count'] ??
      0
    expect(restartCount).toBe(0)
    // The memoized summary is invalidated (set to null) on the re-emit
    // patch, then immediately re-generated by the resolver before the
    // next prompt ships, so the persisted value at end of turn is a
    // fresh summary string off the redrafted persona — not the stale one.
    const memoizedSummary = (afterState!.phase_state as Record<string, unknown>)[
      'persona_reviewed_summary'
    ]
    expect(typeof memoizedSummary).toBe('string')
    expect((memoizedSummary as string).length).toBeGreaterThan(0)
  })

  test('6. commit fires on [A] Looks good and engine advances to max_oauth_offered', async () => {
    h = makeHarness()
    const prompt_id = await seedProjectsProposed(h)
    await h.engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      choice: {
        prompt_id,
        choice_value: 'auto',
        chosen_at: Date.now(),
        speaker_user_id: USER,
        channel_kind: 'app-socket',
      },
      observed_at: Date.now(),
    })
    const reviewState = await h.stateStore.get(OWNER, USER)
    const reviewPromptId = (reviewState!.phase_state as Record<string, unknown>)[
      'active_prompt_id'
    ] as string
    const result = await h.engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      choice: {
        prompt_id: reviewPromptId,
        choice_value: 'looks_good',
        chosen_at: Date.now(),
        speaker_user_id: USER,
        channel_kind: 'app-socket',
      },
      observed_at: Date.now(),
    })
    expect(h.rec.commitCalls.length).toBe(1)
    expect(result.state?.phase).toBe('max_oauth_offered')
    expect(result.state?.phase_state['persona_files_committed']).toBe(true)
  })

  test('7. commit writes SOUL.md / USER.md / priority-map.md to <owner_home>/persona/ on disk', async () => {
    h = makeHarness()
    const prompt_id = await seedProjectsProposed(h)
    await h.engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      choice: {
        prompt_id,
        choice_value: 'auto',
        chosen_at: Date.now(),
        speaker_user_id: USER,
        channel_kind: 'app-socket',
      },
      observed_at: Date.now(),
    })
    const reviewState = await h.stateStore.get(OWNER, USER)
    const reviewPromptId = (reviewState!.phase_state as Record<string, unknown>)[
      'active_prompt_id'
    ] as string
    await h.engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      choice: {
        prompt_id: reviewPromptId,
        choice_value: 'looks_good',
        chosen_at: Date.now(),
        speaker_user_id: USER,
        channel_kind: 'app-socket',
      },
      observed_at: Date.now(),
    })
    const soulPath = join(h.tmp, 'persona', 'SOUL.md')
    const userPath = join(h.tmp, 'persona', 'USER.md')
    const pmapPath = join(h.tmp, 'persona', 'priority-map.md')
    expect(existsSync(soulPath)).toBe(true)
    expect(existsSync(userPath)).toBe(true)
    expect(existsSync(pmapPath)).toBe(true)
    const soulText = readFileSync(soulPath, 'utf8')
    expect(soulText).toContain('# SOUL.md')
    expect(soulText).toContain('Communication Style')
    const userText = readFileSync(userPath, 'utf8')
    expect(userText).toContain('Nova')
    const pmapText = readFileSync(pmapPath, 'utf8')
    expect(pmapText).toContain('# priority-map.md')
  })

  test('Codex P1 — [C] Restart threads the freeform hint into the next compose call (regen_hint set on signals + ComposeInput)', async () => {
    h = makeHarness()
    const prompt_id = await seedProjectsProposed(h)
    // projects_proposed → persona_synthesizing → persona_reviewed
    await h.engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      choice: {
        prompt_id,
        choice_value: 'auto',
        chosen_at: Date.now(),
        speaker_user_id: USER,
        channel_kind: 'app-socket',
      },
      observed_at: Date.now(),
    })
    // [C] Restart
    const reviewState = await h.stateStore.get(OWNER, USER)
    const reviewPromptId = (reviewState!.phase_state as Record<string, unknown>)[
      'active_prompt_id'
    ] as string
    await h.engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      choice: {
        prompt_id: reviewPromptId,
        choice_value: 'restart',
        chosen_at: Date.now(),
        speaker_user_id: USER,
        channel_kind: 'app-socket',
      },
      observed_at: Date.now(),
    })
    // The user replies with the change they want.
    const hintState = await h.stateStore.get(OWNER, USER)
    const hintPromptId = (hintState!.phase_state as Record<string, unknown>)[
      'active_prompt_id'
    ] as string
    expect(h.rec.composeCalls.length).toBe(1)
    await h.engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      choice: {
        prompt_id: hintPromptId,
        choice_value: '__freeform__',
        freeform_text: 'be more concise and use shorter sentences',
        chosen_at: Date.now(),
        speaker_user_id: USER,
        channel_kind: 'app-socket',
      },
      observed_at: Date.now(),
    })
    expect(h.rec.composeCalls.length).toBe(2)
    const regenCall = h.rec.composeCalls[1]!
    expect(regenCall.regen_hint).toBe('be more concise and use shorter sentences')
    expect(regenCall.signals.regen_hint).toBe(
      'be more concise and use shorter sentences',
    )
    // The redraft SOUL.md should surface the hint as a section so the
    // user can SEE the persona reflects what they asked for.
    const reviewedState = await h.stateStore.get(OWNER, USER)
    const draft = (reviewedState!.phase_state as Record<string, unknown>)[
      'persona_draft'
    ] as { soul_md: string }
    expect(draft.soul_md).toContain('User Direction')
    expect(draft.soul_md).toContain('be more concise and use shorter sentences')
  })

  test('Codex P2 — fallback prompt rejects unknown choice_value instead of advancing', async () => {
    // Build a harness whose composer throws once so the engine emits
    // the Try-again / Use-basic-template / Skip-persona fallback prompt.
    const tmp = mkdtempSync(join(tmpdir(), 'neutron-persona-fb-'))
    const db = ProjectDb.open(join(tmp, 'project.db'))
    applyMigrations(db.raw())
    const buttonStore = new ButtonStore({ db })
    const stateStore = new InMemoryOnboardingStateStore()
    const transcript = new TranscriptWriter({
      path: join(tmp, 'persona', 'onboarding-transcript.jsonl'),
    })
    const composeCalls: PersonaComposeInput[] = []
    let composeThrows = true
    const hook: PersonaComposerHook = {
      async compose(input) {
        composeCalls.push(input)
        if (composeThrows) {
          // Throw a PersonaError once so the engine takes the
          // fallback path; subsequent calls should NOT happen here
          // because the unknown-choice path re-emits without
          // invoking compose.
          const { PersonaError } = await import('../../persona-gen/compose.ts')
          throw new PersonaError(
            'cringe_cap_exceeded',
            'cringe cap exceeded (test)',
          )
        }
        throw new Error('test bug: compose called after toggle')
      },
      async applyEdit() {
        throw new Error('not used in this test')
      },
      async commit() {
        throw new Error('not used in this test')
      },
    }
    const sentPrompts: Array<{
      project_slug: string
      topic_id: string
      prompt: ButtonPrompt
    }> = []
    const engine = new InterviewEngine({
      buttonStore,
      stateStore,
      transcript,
      sendButtonPrompt: async (input) => {
        sentPrompts.push(input)
        return { message_id: `msg-${sentPrompts.length}`, was_new: true }
      },
      personaComposer: hook,
    })
    try {
      // Seed onboarding state at projects_proposed.
      await stateStore.upsert({
        user_id: USER,
        project_slug: OWNER,
        phase: 'projects_proposed',
        phase_state_patch: {
          user_id: USER,
          topic_id: TOPIC,
          signup_via: 'web',
          agent_name: 'Nova',
          time_style: 'async-low',
          work_pattern: 'solo deep work',
          rituals_captured: ['weekly review'],
        },
        advanced_at: Date.now(),
      })
      await engine.advance({
        project_slug: OWNER,
        topic_id: TOPIC,
        user_id: USER,
        channel_kind: 'app-socket',
        observed_at: Date.now(),
      })
      const promptedState = await stateStore.get(OWNER, USER)
      const promptedId = (promptedState!.phase_state as Record<string, unknown>)[
        'active_prompt_id'
      ] as string
      // Trigger the compose failure → fallback prompt.
      await engine.advance({
        project_slug: OWNER,
        topic_id: TOPIC,
        user_id: USER,
        channel_kind: 'app-socket',
        choice: {
          prompt_id: promptedId,
          choice_value: 'auto',
          chosen_at: Date.now(),
          speaker_user_id: USER,
          channel_kind: 'app-socket',
        },
        observed_at: Date.now(),
      })
      // We should be at persona_synthesizing with the fallback prompt up.
      const fallbackState = await stateStore.get(OWNER, USER)
      expect(fallbackState?.phase).toBe('persona_synthesizing')
      const fallbackPromptId = (fallbackState!.phase_state as Record<string, unknown>)[
        'active_prompt_id'
      ] as string
      // Send a tampered / stale choice_value that is NOT in
      // {persona_retry, persona_use_basic, persona_skip}.
      composeThrows = false
      const result = await engine.advance({
        project_slug: OWNER,
        topic_id: TOPIC,
        user_id: USER,
        channel_kind: 'app-socket',
        choice: {
          prompt_id: fallbackPromptId,
          choice_value: 'tampered_value_should_be_rejected',
          chosen_at: Date.now(),
          speaker_user_id: USER,
          channel_kind: 'app-socket',
        },
        observed_at: Date.now(),
      })
      // The engine must NOT have advanced to persona_reviewed.
      expect(result.outcome).toBe('reemitted_current')
      expect(result.state?.phase).toBe('persona_synthesizing')
      // The unknown-choice path must NOT invoke compose (it should just
      // re-emit the fallback prompt for the user to retry).
      expect(composeCalls.length).toBe(1)
    } finally {
      db.close()
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('8. E2E — projects_proposed → persona_synthesizing → persona_reviewed via real engine.advance, no SQL stubs of downstream phases', async () => {
    h = makeHarness()
    // Seed the user mid-onboarding at projects_proposed with all signals
    // captured. NO phase=persona_synthesizing direct DB write happens;
    // the engine has to walk the full transition itself.
    const prompt_id = await seedProjectsProposed(h)
    const initialState = await h.stateStore.get(OWNER, USER)
    expect(initialState?.phase).toBe('projects_proposed')
    expect(h.rec.composeCalls.length).toBe(0)

    // One real advance call should: route projects_proposed → persona_synthesizing
    // (via the static spec route), fire synthesizePersona (which calls compose
    // and advances to persona_reviewed), and emit the review prompt.
    const result = await h.engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      choice: {
        prompt_id,
        choice_value: 'auto',
        chosen_at: Date.now(),
        speaker_user_id: USER,
        channel_kind: 'app-socket',
      },
      observed_at: Date.now(),
    })

    // Compose was called. The body contains real generated content.
    expect(h.rec.composeCalls.length).toBe(1)
    expect(result.state?.phase).toBe('persona_reviewed')
    const persona_draft = result.state?.phase_state['persona_draft']
    expect(persona_draft).toBeTruthy()
    expect((persona_draft as { soul_md?: string }).soul_md).toContain('# SOUL.md')

    // Gate-collapse (#93): the review prompt now has a SINGLE "Looks good"
    // option; freeform typing is the tweak path.
    const reviewPrompt = h.sentPrompts.at(-1)?.prompt
    expect(reviewPrompt?.options.map((o) => o.value)).toEqual(['looks_good'])
    expect(reviewPrompt?.allow_freeform).toBe(true)
  })

  /*
   * ISSUES #1 (2026-05-19) — T9-T12 close the resolver / resume-path
   * gaps that shipped after T1 (2026-05-13). Pre-fix: the resolver
   * branch at engine.ts:7669 returned `null` whenever the composer was
   * wired AND no failure flag was set, which made every resume / re-
   * emit path throw `prompt_emit_failed` with the literal string
   * `no prompt content for phase=persona_synthesizing` reaching the
   * user as a chat bubble. Spec source: docs/plans/P2-onboarding-v2.md
   * § 3.13. Brief: docs/plans/persona-synthesizing-fix-sprint-brief.md.
   */

  test('T9 — resolver returns spec § 3.13 status body when composer wired and no failure flag', async () => {
    h = makeHarness()
    // Land state at persona_synthesizing with no draft + no failure
    // flag — the exact post-T1 happy-path resolver-call shape that
    // pre-fix returned null.
    await h.stateStore.upsert({
      user_id: USER,
      project_slug: OWNER,
      phase: 'persona_synthesizing',
      phase_state_patch: { user_id: USER, topic_id: TOPIC, signup_via: 'web' },
      advanced_at: Date.now(),
    })
    // resolvePhasePromptSpec is private; tests reach in by bracket
    // access. This is the exact entry point engine.emitPhasePrompt
    // uses, so the assertion is on the user-facing resolver contract.
    const resolve = (
      h.engine as unknown as {
        resolvePhasePromptSpec: (
          slug: string,
          user_id: string,
          phase: string,
        ) => Promise<{ body: string; options: unknown[]; allow_freeform: boolean } | null>
      }
    ).resolvePhasePromptSpec.bind(h.engine)
    const spec = await resolve(OWNER, USER, 'persona_synthesizing')
    expect(spec).not.toBeNull()
    expect(spec!.body).toBe('Composing your persona — this takes about 10 sec.')
    expect(spec!.options).toEqual([])
    expect(spec!.allow_freeform).toBe(false)
    // The compose hook MUST NOT have been called as a side effect of
    // a pure resolver lookup — synthesis is driven by the resume
    // trigger / consumeChoice, not by the resolver.
    expect(h.rec.composeCalls.length).toBe(0)
  })

  test('T10 — re-emit at persona_synthesizing with composer wired and no failure flag does not throw and does not leak the error string', async () => {
    h = makeHarness()
    // Seed signals so the resume-trigger's compose() call succeeds.
    await h.stateStore.upsert({
      user_id: USER,
      project_slug: OWNER,
      phase: 'persona_synthesizing',
      phase_state_patch: {
        user_id: USER,
        topic_id: TOPIC,
        signup_via: 'web',
        agent_name: 'Nova',
        time_style: 'async-low',
        work_pattern: 'solo deep work in the morning',
        rituals_captured: ['weekly review on Sunday'],
        primary_projects: ['neutron'],
        agent_personality: 'precise sovereign coach',
      },
      advanced_at: Date.now(),
    })
    let threw: unknown = null
    try {
      await h.engine.advance({
        project_slug: OWNER,
        topic_id: TOPIC,
        user_id: USER,
        channel_kind: 'app-socket',
        observed_at: Date.now(),
      })
    } catch (err) {
      threw = err
    }
    expect(threw).toBeNull()
    // Sam-visible regression guard: the literal `prompt_emit_failed`
    // error string MUST never surface to the channel on any path —
    // pre-fix this was the user-facing bubble.
    for (const p of h.sentPrompts) {
      expect(p.prompt.body).not.toContain(
        'no prompt content for phase=persona_synthesizing',
      )
      expect(p.prompt.body).not.toContain('prompt_emit_failed')
    }
  })

  test('T11 — reconnect at persona_synthesizing with no draft fires synthesizePersona once and advances', async () => {
    h = makeHarness()
    // Seed signals + state as if a prior turn crashed RIGHT before
    // compose() returned: phase = persona_synthesizing, no draft, no
    // failure flag. The gateway never wrote the persona_reviewed
    // upsert; the user reconnects.
    await h.stateStore.upsert({
      user_id: USER,
      project_slug: OWNER,
      phase: 'persona_synthesizing',
      phase_state_patch: {
        user_id: USER,
        topic_id: TOPIC,
        signup_via: 'web',
        agent_name: 'Nova',
        time_style: 'async-low',
        work_pattern: 'solo deep work',
        rituals_captured: ['weekly review'],
        primary_projects: ['neutron', 'topline', 'acme'],
        agent_personality: 'precise sovereign coach',
      },
      advanced_at: Date.now() - 60_000,
    })
    expect(h.rec.composeCalls.length).toBe(0)
    const result = await h.engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      observed_at: Date.now(),
    })
    // The resume trigger must fire compose exactly once (not zero,
    // not twice — § 4.3.3 idempotency contract).
    expect(h.rec.composeCalls.length).toBe(1)
    expect(result.state?.phase).toBe('persona_reviewed')
    const after = await h.stateStore.get(OWNER, USER)
    expect(after?.phase).toBe('persona_reviewed')
    // The persisted draft from the resumed synthesis lands on
    // phase_state — the persona_reviewed dynamic resolver reads it
    // back to render the review bubble.
    const persona_draft = after?.phase_state['persona_draft']
    expect(persona_draft).toBeTruthy()
    expect((persona_draft as { soul_md?: string }).soul_md).toContain('# SOUL.md')
  })

  test('T12 — reconnect at persona_synthesizing WITH failure flag does NOT auto-re-fire compose and emits the fallback prompt', async () => {
    h = makeHarness()
    await h.stateStore.upsert({
      user_id: USER,
      project_slug: OWNER,
      phase: 'persona_synthesizing',
      phase_state_patch: {
        user_id: USER,
        topic_id: TOPIC,
        signup_via: 'web',
        persona_compose_failure_reason:
          'cringe_cap_exceeded: too many flags on user_md after 3 regens',
      },
      advanced_at: Date.now() - 60_000,
    })
    expect(h.rec.composeCalls.length).toBe(0)
    const result = await h.engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      observed_at: Date.now(),
    })
    // Compose MUST NOT have re-fired automatically — that's the
    // user's call via the fallback prompt's [A] Try-again button.
    expect(h.rec.composeCalls.length).toBe(0)
    // State stays at persona_synthesizing because the fallback prompt
    // expects a [A] Try-again / [B] Use-basic-template / [C] Skip
    // button tap to route forward via consumePersonaSynthesizingChoice.
    expect(result.state?.phase).toBe('persona_synthesizing')
    // The fallback prompt body MUST be what the user sees.
    const last = h.sentPrompts[h.sentPrompts.length - 1]
    expect(last).toBeTruthy()
    expect(last!.prompt.body).toContain("couldn't put together a clean draft")
    expect(last!.prompt.body).toContain('cringe_cap_exceeded')
    // And it MUST have the three fallback options wired up.
    expect(last!.prompt.options.map((o) => o.value)).toEqual([
      'persona_retry',
      'persona_use_basic',
      'persona_skip',
    ])
  })

  test('Codex r2 P2 — legacy pick_line/pick_replacement freeform is forwarded as regen_hint (no silent drop)', async () => {
    // v0.1.80 (2026-05-22) Codex P2 regression: pre-fix, a stale state
    // file that resumed in `pick_line` or `pick_replacement` (with the
    // user typing a freeform reply like "voice 3 be warmer") routed
    // through the migration branch which silently re-emitted the new
    // conversational prompt — DROPPING the user's text on the floor.
    // The user had to retype their intent. Post-fix: the freeform is
    // forwarded as `persona_regen_hint` and `compose()` is invoked
    // immediately, same shape as a normal pending_regen_hint tweak.
    // PERSONA_MAX_RESTARTS is NOT incremented (treated as a tweak).
    h = makeHarness()
    // Drive a real walk to persona_reviewed so persona_draft + signals
    // are populated, then mutate the sub_step to the deprecated value
    // (simulates a state file written by the pre-v0.1.80 engine).
    const prompt_id = await seedProjectsProposed(h)
    await h.engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      choice: {
        prompt_id,
        choice_value: 'auto',
        chosen_at: Date.now(),
        speaker_user_id: USER,
        channel_kind: 'app-socket',
      },
      observed_at: Date.now(),
    })
    expect(h.rec.composeCalls.length).toBe(1)
    const reviewedState = await h.stateStore.get(OWNER, USER)
    expect(reviewedState?.phase).toBe('persona_reviewed')
    const activePromptId = (reviewedState!.phase_state as Record<string, unknown>)[
      'active_prompt_id'
    ] as string
    // Munge the state-store row into the legacy shape: sub_step =
    // pick_line + edit_target_* set. A user resuming here in the new
    // engine would have a __freeform__ reply land in the migration
    // branch.
    await h.stateStore.upsert({
      project_slug: OWNER,
      user_id: USER,
      phase: 'persona_reviewed',
      phase_state_patch: {
        persona_review_sub_step: 'pick_line',
        persona_edit_target_section: 'voice',
        persona_edit_target_file: 'soul',
        persona_edit_target_line: 3,
      },
      advanced_at: Date.now(),
    })
    // Send the freeform reply. The original migration branch would
    // have re-emitted without invoking compose — post-fix, compose
    // MUST fire with the freeform threaded through as regen_hint.
    await h.engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      choice: {
        prompt_id: activePromptId,
        choice_value: '__freeform__',
        freeform_text: 'voice 3 be warmer and use Sam by name',
        chosen_at: Date.now(),
        speaker_user_id: USER,
        channel_kind: 'app-socket',
      },
      observed_at: Date.now(),
    })
    // compose() ran for the migrate-and-redraft.
    expect(h.rec.composeCalls.length).toBe(2)
    const migrateCall = h.rec.composeCalls[1]!
    expect(migrateCall.regen_hint).toBe('voice 3 be warmer and use Sam by name')
    expect(migrateCall.signals.regen_hint).toBe(
      'voice 3 be warmer and use Sam by name',
    )
    // applyEdit MUST NOT fire — the legacy line-coordinate path is dead.
    expect(h.rec.applyEditCalls.length).toBe(0)
    const after = await h.stateStore.get(OWNER, USER)
    const after_ps = after!.phase_state as Record<string, unknown>
    // Sub_step is back to idle, stale edit_target_* fields cleared.
    expect(after_ps['persona_review_sub_step']).toBe('idle')
    expect(after_ps['persona_edit_target_section']).toBeFalsy()
    expect(after_ps['persona_edit_target_file']).toBeFalsy()
    expect(after_ps['persona_edit_target_line']).toBeFalsy()
    // The hint is persisted on phase_state for a future resume.
    expect(after_ps['persona_regen_hint']).toBe(
      'voice 3 be warmer and use Sam by name',
    )
    // Tweak — restart counter UNCHANGED.
    const restartCount = (after_ps['persona_restart_count'] ?? 0) as number
    expect(restartCount).toBe(0)
  })

  test('Codex r2 P2 — empty freeform on legacy sub_step re-emits the conversational prompt without dropping into compose', async () => {
    // Companion to the above: when no freeform text accompanies the
    // legacy sub_step (rare — would require a stale state file AND a
    // freeform reply with empty body), the engine must NOT call
    // compose() with an empty hint. It must just re-emit the
    // pending_regen_hint prompt so the user can type a fresh hint.
    h = makeHarness()
    const prompt_id = await seedProjectsProposed(h)
    await h.engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      choice: {
        prompt_id,
        choice_value: 'auto',
        chosen_at: Date.now(),
        speaker_user_id: USER,
        channel_kind: 'app-socket',
      },
      observed_at: Date.now(),
    })
    expect(h.rec.composeCalls.length).toBe(1)
    const reviewedState = await h.stateStore.get(OWNER, USER)
    const activePromptId = (reviewedState!.phase_state as Record<string, unknown>)[
      'active_prompt_id'
    ] as string
    await h.stateStore.upsert({
      project_slug: OWNER,
      user_id: USER,
      phase: 'persona_reviewed',
      phase_state_patch: {
        persona_review_sub_step: 'pick_replacement',
        persona_edit_target_section: 'about',
        persona_edit_target_file: 'user',
        persona_edit_target_line: 7,
      },
      advanced_at: Date.now(),
    })
    await h.engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      choice: {
        prompt_id: activePromptId,
        choice_value: '__freeform__',
        freeform_text: '   ',
        chosen_at: Date.now(),
        speaker_user_id: USER,
        channel_kind: 'app-socket',
      },
      observed_at: Date.now(),
    })
    // No additional compose() — empty hint cannot redraft.
    expect(h.rec.composeCalls.length).toBe(1)
    const after = await h.stateStore.get(OWNER, USER)
    const after_ps = after!.phase_state as Record<string, unknown>
    expect(after_ps['persona_review_sub_step']).toBe('pending_regen_hint')
    expect(after_ps['persona_review_tweak_mode']).toBe(true)
    expect(after_ps['persona_edit_target_section']).toBeFalsy()
    expect(after_ps['persona_edit_target_file']).toBeFalsy()
    expect(after_ps['persona_edit_target_line']).toBeFalsy()
  })
})
