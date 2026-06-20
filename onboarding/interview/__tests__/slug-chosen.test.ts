/**
 * @neutronai/onboarding/interview — Sprint 21 slug_chosen integration tests.
 *
 * Covers each branch of the engine's slug_chosen handling:
 *   - "Use suggested" success → `renamed` outcome → advance to
 *     projects_proposed (2026-05-13: slug pick moved to after
 *     persona_reviewed, inheriting that phase's previous default target)
 *   - typed-different success → `renamed` outcome → advance
 *   - typed-different `unavailable` → re-prompt with reason
 *   - typed-different `reserved` → re-prompt with reason
 *   - typed-different `sanitize_failed` → re-prompt with reason
 *   - skip-slug → advance without rename
 *   - hook throws → re-prompt with degraded reason
 *   - hook absent → only skip-slug advances
 *
 * Uses a stub `SlugPickerEngineHook` and an in-memory state store so the
 * tests stay fast + isolated. The end-to-end live-rename flow is
 * covered separately in `tests/integration/sprint21-slug-chosen-live-flow.test.ts`.
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
  type SlugPickerEngineHook,
  type SlugPickerEngineHookInput,
} from '../engine.ts'
import { InMemoryOnboardingStateStore } from '../state-store.ts'
import { TranscriptWriter } from '../transcript.ts'
import type { SlugPickerOutcome } from '../../../runtime/slug-picker-types.ts'

interface Harness {
  tmp: string
  db: ProjectDb
  buttonStore: ButtonStore
  stateStore: InMemoryOnboardingStateStore
  transcript: TranscriptWriter
  sentPrompts: Array<{ project_slug: string; topic_id: string; prompt: ButtonPrompt }>
  hookCalls: SlugPickerEngineHookInput[]
  hookOutcome: SlugPickerOutcome | null
  hookError: Error | null
  engine: InterviewEngine
}

function makeHarness(opts: { hookConfigured: boolean }): Harness {
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-slug-chosen-'))
  const db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
  const buttonStore = new ButtonStore({ db })
  const stateStore = new InMemoryOnboardingStateStore()
  const transcript = new TranscriptWriter({
    path: join(tmp, 'persona', 'onboarding-transcript.jsonl'),
  })
  const sentPrompts: Harness['sentPrompts'] = []
  const hookCalls: SlugPickerEngineHookInput[] = []
  const harness: Partial<Harness> = {
    tmp,
    db,
    buttonStore,
    stateStore,
    transcript,
    sentPrompts,
    hookCalls,
    hookOutcome: null,
    hookError: null,
  }
  const stubHook: SlugPickerEngineHook = {
    async processReply(input) {
      hookCalls.push(input)
      if (harness.hookError) throw harness.hookError
      if (harness.hookOutcome === null || harness.hookOutcome === undefined) {
        throw new Error('test bug: hookOutcome not set')
      }
      return harness.hookOutcome
    },
  }
  const engine = new InterviewEngine({
    buttonStore,
    stateStore,
    transcript,
    sendButtonPrompt: async (input) => {
      sentPrompts.push(input)
      return { message_id: `msg-${sentPrompts.length}`, was_new: true }
    },
    ...(opts.hookConfigured ? { slugPicker: stubHook } : {}),
  })
  harness.engine = engine
  return harness as Harness
}

function teardown(h: Harness): void {
  h.db.close()
  rmSync(h.tmp, { recursive: true, force: true })
}

/**
 * Seed an instance directly into onboarding_state at slug_chosen with the
 * given agent_name. Bypasses the full prior-phase walk so each test
 * lands in slug_chosen with a clean phase_state.
 */
async function seedSlugChosen(
  h: Harness,
  agent_name: string | null,
  suggested: string | null,
  current_slug: string,
): Promise<void> {
  const phase_state: Record<string, unknown> = {
    user_id: 'u-1',
    topic_id: 'web:u-1',
    signup_via: 'web',
    // A genuine already-reviewed project list carried forward to the
    // projects_proposed redirect anchor. The gate-collapse auto-confirm
    // only fires when there IS content to collapse the redundant gate on
    // (Argus r2 zero-state guard); the both-empty case is covered by its
    // own dedicated test, not these slug-rename mechanics tests.
    primary_projects: ['Topline', 'Northwind'],
  }
  if (agent_name !== null) phase_state['agent_name'] = agent_name
  if (suggested !== null) phase_state['suggested_slug'] = suggested
  await h.stateStore.upsert({
    user_id: 'u-1',
    project_slug: current_slug,
    phase: 'slug_chosen',
    phase_state_patch: phase_state,
    advanced_at: Date.now(),
  })
  // Emit the slug_chosen prompt so we have a real active_prompt_id.
  await h.engine.advance({
    project_slug: current_slug,
    topic_id: 'web:u-1',
    user_id: 'u-1',
    channel_kind: 'app-socket',
    observed_at: Date.now(),
  })
}

function activePromptId(h: Harness, project_slug: string): Promise<string> {
  return h.stateStore.get(project_slug, 'u-1').then((state) => {
    if (state === null) throw new Error('state missing')
    const apid = state.phase_state['active_prompt_id']
    if (typeof apid !== 'string') throw new Error('active_prompt_id missing')
    return apid
  })
}

describe('InterviewEngine — slug_chosen branch (Sprint 21)', () => {
  let h: Harness
  afterEach(() => teardown(h))

  test('emits dynamic prompt with suggested slug as the only click-button (2026-05-09 chat-UX)', async () => {
    h = makeHarness({ hookConfigured: true })
    await seedSlugChosen(h, 'Nova', 'nova', 't-11111111')
    expect(h.sentPrompts.length).toBe(1)
    const prompt = h.sentPrompts[0]?.prompt
    // Issue 2: only ONE click-button on slug_chosen — `Use "<suggested>"`.
    // The freeform composer is the affordance for "Type a different one";
    // the `Skip for now` escape-ramp moves to a global menu.
    expect(prompt?.options.length).toBe(1)
    expect(prompt?.options[0]?.value).toBe('use-suggested')
    expect(prompt?.options[0]?.body).toBe('Use nova')
    expect(prompt?.options.find((o) => o.value === 'type-different')).toBeUndefined()
    expect(prompt?.options.find((o) => o.value === 'skip-slug')).toBeUndefined()
    expect(prompt?.allow_freeform).toBe(true)
  })

  test('emits zero options when configured but suggested_slug is null (freeform-only)', async () => {
    h = makeHarness({ hookConfigured: true })
    await seedSlugChosen(h, '!!!', null, 't-11111111')
    const prompt = h.sentPrompts[0]?.prompt
    // No suggested_slug means no useful click-button. The freeform
    // composer (`allow_freeform: true`) is the only affordance — the
    // user types the slug they want directly.
    expect(prompt?.options.length).toBe(0)
    expect(prompt?.allow_freeform).toBe(true)
  })

  test('"use suggested" → renamed → advances to projects_proposed', async () => {
    h = makeHarness({ hookConfigured: true })
    await seedSlugChosen(h, 'Nova', 'nova', 't-11111111')
    h.hookOutcome = {
      kind: 'renamed',
      new_slug: 'nova',
      result: {
        internal_handle: 't-11111111',
        old_url_slug: 't-11111111',
        new_url_slug: 'nova',
        redirect_route_id: 'r-1',
        pending_rename_id: 'p-1',
        completed_at: Date.now(),
        steps: [{ step: 'completed', status: 'success' }],
      },
    }
    const prompt_id = await activePromptId(h, 't-11111111')
    const result = await h.engine.advance({
      project_slug: 't-11111111',
      topic_id: 'web:u-1',
      user_id: 'u-1',
      channel_kind: 'app-socket',
      choice: {
        prompt_id,
        choice_value: 'use-suggested',
        chosen_at: Date.now(),
        speaker_user_id: 'u-1',
        channel_kind: 'app-socket',
      },
      observed_at: Date.now(),
    })
    expect(result.outcome).toBe('advanced')
    expect(result.state?.phase).toBe('projects_proposed')
    expect(h.hookCalls.length).toBe(1)
    expect(h.hookCalls[0]?.raw_input).toBe('nova')
    expect(h.hookCalls[0]?.picker_choice).toBe('use-suggested')
    expect(h.hookCalls[0]?.agent_name).toBe('Nova')
    expect(result.state?.phase_state['url_slug_renamed_to']).toBe('nova')
    expect(result.state?.phase_state['slug_picker_outcome']).toBe('renamed')
  })

  test('typed-different success → renamed → advances', async () => {
    h = makeHarness({ hookConfigured: true })
    await seedSlugChosen(h, 'Nova', 'nova', 't-11111111')
    h.hookOutcome = {
      kind: 'renamed',
      new_slug: 'odin',
      result: {
        internal_handle: 't-11111111',
        old_url_slug: 't-11111111',
        new_url_slug: 'odin',
        redirect_route_id: 'r-2',
        pending_rename_id: 'p-2',
        completed_at: Date.now(),
        steps: [{ step: 'completed', status: 'success' }],
      },
    }
    const prompt_id = await activePromptId(h, 't-11111111')
    const result = await h.engine.advance({
      project_slug: 't-11111111',
      topic_id: 'web:u-1',
      user_id: 'u-1',
      channel_kind: 'app-socket',
      choice: {
        prompt_id,
        choice_value: '__freeform__',
        freeform_text: 'odin',
        chosen_at: Date.now(),
        speaker_user_id: 'u-1',
        channel_kind: 'app-socket',
      },
      observed_at: Date.now(),
    })
    expect(result.outcome).toBe('advanced')
    expect(result.state?.phase).toBe('projects_proposed')
    expect(h.hookCalls[0]?.raw_input).toBe('odin')
    expect(h.hookCalls[0]?.picker_choice).toBe('type-different')
    expect(result.state?.phase_state['url_slug_renamed_to']).toBe('odin')
  })

  test('typed-different `unavailable` → re-prompt with "already using" reason', async () => {
    h = makeHarness({ hookConfigured: true })
    await seedSlugChosen(h, 'Nova', 'nova', 't-11111111')
    h.hookOutcome = {
      kind: 'rejected',
      reason: 'unavailable',
      availability: { slug: 'taken-slug', available: false, reason: 'taken' },
    }
    const prompt_id = await activePromptId(h, 't-11111111')
    const result = await h.engine.advance({
      project_slug: 't-11111111',
      topic_id: 'web:u-1',
      user_id: 'u-1',
      channel_kind: 'app-socket',
      choice: {
        prompt_id,
        choice_value: '__freeform__',
        freeform_text: 'taken-slug',
        chosen_at: Date.now(),
        speaker_user_id: 'u-1',
        channel_kind: 'app-socket',
      },
      observed_at: Date.now(),
    })
    expect(result.outcome).toBe('reemitted_current')
    expect(result.state?.phase).toBe('slug_chosen')
    expect(result.state?.phase_state['slug_picker_rejection']).toContain('already using')
    expect(h.sentPrompts.length).toBe(2) // initial + re-prompt
    const reprompt = h.sentPrompts[1]?.prompt
    expect(reprompt?.body).toContain('already using')
  })

  test('typed-different `reserved` → re-prompt with reserved reason', async () => {
    h = makeHarness({ hookConfigured: true })
    await seedSlugChosen(h, 'Nova', 'nova', 't-11111111')
    h.hookOutcome = {
      kind: 'rejected',
      reason: 'unavailable',
      availability: { slug: 'admin', available: false, reason: 'reserved' },
    }
    const prompt_id = await activePromptId(h, 't-11111111')
    const result = await h.engine.advance({
      project_slug: 't-11111111',
      topic_id: 'web:u-1',
      user_id: 'u-1',
      channel_kind: 'app-socket',
      choice: {
        prompt_id,
        choice_value: '__freeform__',
        freeform_text: 'admin',
        chosen_at: Date.now(),
        speaker_user_id: 'u-1',
        channel_kind: 'app-socket',
      },
      observed_at: Date.now(),
    })
    expect(result.outcome).toBe('reemitted_current')
    expect(result.state?.phase).toBe('slug_chosen')
    expect(result.state?.phase_state['slug_picker_rejection']).toContain('reserved')
  })

  test('typed-different `sanitize_failed` → re-prompt with format reason', async () => {
    h = makeHarness({ hookConfigured: true })
    await seedSlugChosen(h, 'Nova', 'nova', 't-11111111')
    h.hookOutcome = { kind: 'rejected', reason: 'sanitize_failed' }
    const prompt_id = await activePromptId(h, 't-11111111')
    const result = await h.engine.advance({
      project_slug: 't-11111111',
      topic_id: 'web:u-1',
      user_id: 'u-1',
      channel_kind: 'app-socket',
      choice: {
        prompt_id,
        choice_value: '__freeform__',
        freeform_text: '!!!',
        chosen_at: Date.now(),
        speaker_user_id: 'u-1',
        channel_kind: 'app-socket',
      },
      observed_at: Date.now(),
    })
    expect(result.outcome).toBe('reemitted_current')
    expect(result.state?.phase).toBe('slug_chosen')
    expect(result.state?.phase_state['slug_picker_rejection']).toContain('lowercase a-z')
  })

  test('rename_failed → re-prompt with code', async () => {
    h = makeHarness({ hookConfigured: true })
    await seedSlugChosen(h, 'Nova', 'nova', 't-11111111')
    h.hookOutcome = {
      kind: 'rejected',
      reason: 'rename_failed',
      code: 'caddy_unreachable',
      message: 'caddy down',
    }
    const prompt_id = await activePromptId(h, 't-11111111')
    const result = await h.engine.advance({
      project_slug: 't-11111111',
      topic_id: 'web:u-1',
      user_id: 'u-1',
      channel_kind: 'app-socket',
      choice: {
        prompt_id,
        choice_value: 'use-suggested',
        chosen_at: Date.now(),
        speaker_user_id: 'u-1',
        channel_kind: 'app-socket',
      },
      observed_at: Date.now(),
    })
    expect(result.outcome).toBe('reemitted_current')
    expect(result.state?.phase).toBe('slug_chosen')
    expect(result.state?.phase_state['slug_picker_rejection']).toContain('caddy_unreachable')
  })

  test('skip-slug → auto-confirms through projects_proposed to persona_reviewed without calling hook', async () => {
    // Gate-collapse (#93): the slug pick still passes THROUGH the
    // projects_proposed anchor (kept for the v0.1.133 redirect), but the
    // engine now auto-confirms the already-reviewed project list inline and
    // advances to persona_synthesizing → persona_reviewed (no composer
    // wired here, so synthesizePersona is a pure transit to persona_reviewed).
    h = makeHarness({ hookConfigured: true })
    await seedSlugChosen(h, 'Nova', 'nova', 't-11111111')
    const prompt_id = await activePromptId(h, 't-11111111')
    const result = await h.engine.advance({
      project_slug: 't-11111111',
      topic_id: 'web:u-1',
      user_id: 'u-1',
      channel_kind: 'app-socket',
      choice: {
        prompt_id,
        choice_value: 'skip-slug',
        chosen_at: Date.now(),
        speaker_user_id: 'u-1',
        channel_kind: 'app-socket',
      },
      observed_at: Date.now(),
    })
    expect(result.outcome).toBe('advanced')
    expect(result.state?.phase).toBe('persona_reviewed')
    expect(h.hookCalls.length).toBe(0)
    // slug-picker outcome persisted through the auto-confirm (patch merge).
    expect(result.state?.phase_state['slug_picker_outcome']).toBe('kept')
    expect(result.state?.phase_state['url_slug_renamed_to']).toBeUndefined()
  })

  test('type-different button → fresh prompt with new prompt_id (Codex r5 P1)', async () => {
    h = makeHarness({ hookConfigured: true })
    await seedSlugChosen(h, 'Nova', 'nova', 't-11111111')
    const sentBefore = h.sentPrompts.length
    const oldPromptId = await activePromptId(h, 't-11111111')
    const result = await h.engine.advance({
      project_slug: 't-11111111',
      topic_id: 'web:u-1',
      user_id: 'u-1',
      channel_kind: 'app-socket',
      choice: {
        prompt_id: oldPromptId,
        choice_value: 'type-different',
        chosen_at: Date.now(),
        speaker_user_id: 'u-1',
        channel_kind: 'app-socket',
      },
      observed_at: Date.now(),
    })
    expect(result.outcome).toBe('reemitted_current')
    expect(result.state?.phase).toBe('slug_chosen')
    expect(h.hookCalls.length).toBe(0)
    // Codex r5 P1 — the attempt counter was bumped + active_prompt_id
    // cleared BEFORE re-emit so ButtonStore.emit produces a NEW row
    // (not collapse onto the resolved one). The freshly rendered
    // keyboard arrives on the wire so the user can actually type.
    expect(h.sentPrompts.length).toBeGreaterThan(sentBefore)
    expect(result.prompt_id).toBeDefined()
    expect(result.prompt_id).not.toBe(oldPromptId)
    expect(result.state?.phase_state['slug_picker_attempt_count']).toBe(1)
  })

  test('hook throws → degraded re-prompt', async () => {
    h = makeHarness({ hookConfigured: true })
    await seedSlugChosen(h, 'Nova', 'nova', 't-11111111')
    h.hookError = new Error('rename db pinned')
    const prompt_id = await activePromptId(h, 't-11111111')
    const result = await h.engine.advance({
      project_slug: 't-11111111',
      topic_id: 'web:u-1',
      user_id: 'u-1',
      channel_kind: 'app-socket',
      choice: {
        prompt_id,
        choice_value: 'use-suggested',
        chosen_at: Date.now(),
        speaker_user_id: 'u-1',
        channel_kind: 'app-socket',
      },
      observed_at: Date.now(),
    })
    expect(result.outcome).toBe('reemitted_current')
    expect(result.state?.phase).toBe('slug_chosen')
    expect(result.state?.phase_state['slug_picker_rejection']).toContain('temporarily unavailable')
  })

  test('hook absent → only skip-slug advances', async () => {
    h = makeHarness({ hookConfigured: false })
    await seedSlugChosen(h, 'Nova', 'nova', 't-11111111')
    // Without the hook, the prompt should not offer "Use suggested" or
    // "Type different" — only "Skip for now".
    expect(h.sentPrompts.length).toBe(1)
    const prompt = h.sentPrompts[0]?.prompt
    expect(prompt?.options.find((o) => o.value === 'use-suggested')).toBeUndefined()
    expect(prompt?.options.find((o) => o.value === 'type-different')).toBeUndefined()
    expect(prompt?.options.find((o) => o.value === 'skip-slug')).toBeDefined()
    const prompt_id = await activePromptId(h, 't-11111111')
    const result = await h.engine.advance({
      project_slug: 't-11111111',
      topic_id: 'web:u-1',
      user_id: 'u-1',
      channel_kind: 'app-socket',
      choice: {
        prompt_id,
        choice_value: 'skip-slug',
        chosen_at: Date.now(),
        speaker_user_id: 'u-1',
        channel_kind: 'app-socket',
      },
      observed_at: Date.now(),
    })
    expect(result.outcome).toBe('advanced')
    // Gate-collapse (#93): skip-slug auto-confirms projects_proposed inline.
    expect(result.state?.phase).toBe('persona_reviewed')
  })

  test('typed freeform via user_message inbound (no choice) → calls hook', async () => {
    h = makeHarness({ hookConfigured: true })
    await seedSlugChosen(h, 'Nova', 'nova', 't-11111111')
    h.hookOutcome = {
      kind: 'renamed',
      new_slug: 'pyrra',
      result: {
        internal_handle: 't-11111111',
        old_url_slug: 't-11111111',
        new_url_slug: 'pyrra',
        redirect_route_id: 'r-3',
        pending_rename_id: 'p-3',
        completed_at: Date.now(),
        steps: [{ step: 'completed', status: 'success' }],
      },
    }
    // User typed plain text in the chat input → engine routes via
    // freeform_text + the slug_chosen spec's allow_freeform=true path.
    const result = await h.engine.advance({
      project_slug: 't-11111111',
      topic_id: 'web:u-1',
      user_id: 'u-1',
      channel_kind: 'app-socket',
      freeform_text: 'pyrra',
      observed_at: Date.now(),
    })
    expect(result.outcome).toBe('advanced')
    expect(result.state?.phase).toBe('projects_proposed')
    expect(h.hookCalls[0]?.raw_input).toBe('pyrra')
  })

  test('rename success WITH gateway-refresh=success: state row is rekeyed from old slug to new slug', async () => {
    h = makeHarness({ hookConfigured: true })
    await seedSlugChosen(h, 'Nova', 'nova', 't-11111111')
    h.hookOutcome = {
      kind: 'renamed',
      new_slug: 'nova',
      result: {
        internal_handle: 't-11111111',
        old_url_slug: 't-11111111',
        new_url_slug: 'nova',
        redirect_route_id: 'r-rk',
        pending_rename_id: 'p-rk',
        completed_at: Date.now(),
        steps: [
          { step: 'gateway-refreshed', status: 'success' },
          { step: 'completed', status: 'success' },
        ],
      },
    }
    const prompt_id = await activePromptId(h, 't-11111111')
    const result = await h.engine.advance({
      project_slug: 't-11111111',
      topic_id: 'web:u-1',
      user_id: 'u-1',
      channel_kind: 'app-socket',
      choice: {
        prompt_id,
        choice_value: 'use-suggested',
        chosen_at: Date.now(),
        speaker_user_id: 'u-1',
        channel_kind: 'app-socket',
      },
      observed_at: Date.now(),
    })
    expect(result.outcome).toBe('advanced')
    // Old slug no longer has a row.
    expect(await h.stateStore.get('t-11111111', 'u-1')).toBeNull()
    // New slug now holds the row.
    const rekeyed = await h.stateStore.get('nova', 'u-1')
    expect(rekeyed?.phase).toBe('projects_proposed')
    expect(rekeyed?.project_slug).toBe('nova')
  })

  test('rename success WITH gateway-refresh=success: engine does NOT emit prompt on the dying socket', async () => {
    h = makeHarness({ hookConfigured: true })
    await seedSlugChosen(h, 'Nova', 'nova', 't-11111111')
    const sentBefore = h.sentPrompts.length
    h.hookOutcome = {
      kind: 'renamed',
      new_slug: 'nova',
      result: {
        internal_handle: 't-11111111',
        old_url_slug: 't-11111111',
        new_url_slug: 'nova',
        redirect_route_id: 'r-noemit',
        pending_rename_id: 'p-noemit',
        completed_at: Date.now(),
        steps: [
          { step: 'gateway-refreshed', status: 'success' },
          { step: 'completed', status: 'success' },
        ],
      },
    }
    const prompt_id = await activePromptId(h, 't-11111111')
    const result = await h.engine.advance({
      project_slug: 't-11111111',
      topic_id: 'web:u-1',
      user_id: 'u-1',
      channel_kind: 'app-socket',
      choice: {
        prompt_id,
        choice_value: 'use-suggested',
        chosen_at: Date.now(),
        speaker_user_id: 'u-1',
        channel_kind: 'app-socket',
      },
      observed_at: Date.now(),
    })
    expect(h.sentPrompts.length).toBe(sentBefore)
    expect(result.prompt_id).toBeUndefined()
    const rekeyed = await h.stateStore.get('nova', 'u-1')
    expect(rekeyed?.phase_state['active_prompt_id']).toBeNull()
  })

  test('skip success: engine DOES emit next-phase prompt (WS still alive)', async () => {
    h = makeHarness({ hookConfigured: true })
    await seedSlugChosen(h, 'Nova', 'nova', 't-11111111')
    const sentBefore = h.sentPrompts.length
    const prompt_id = await activePromptId(h, 't-11111111')
    const result = await h.engine.advance({
      project_slug: 't-11111111',
      topic_id: 'web:u-1',
      user_id: 'u-1',
      channel_kind: 'app-socket',
      choice: {
        prompt_id,
        choice_value: 'skip-slug',
        chosen_at: Date.now(),
        speaker_user_id: 'u-1',
        channel_kind: 'app-socket',
      },
      observed_at: Date.now(),
    })
    expect(result.outcome).toBe('advanced')
    // Gate-collapse (#93): auto-confirms through projects_proposed →
    // persona_reviewed; the persona_reviewed prompt is the next emit.
    expect(result.state?.phase).toBe('persona_reviewed')
    // Skip path keeps the WS alive — emit the next phase prompt.
    expect(h.sentPrompts.length).toBeGreaterThan(sentBefore)
    expect(result.prompt_id).toBeDefined()
  })

  test('engine.start at projects_proposed (post-rename reconnect) AUTO-CONFIRMS to persona_reviewed (gate-collapse #93)', async () => {
    h = makeHarness({ hookConfigured: true })
    // 2026-05-13 — post-slug we land at projects_proposed (the v0.1.133
    // redirect anchor). Gate-collapse (#93): instead of re-emitting the
    // redundant "Good to go" gate for an already-reviewed list, the renamed
    // gateway's first start() auto-confirms the list and advances to
    // persona_synthesizing → persona_reviewed (no composer here, so it's a
    // pure transit). Seed at projects_proposed with active_prompt_id null —
    // the exact post-rename state the renamed gateway sees on reconnect.
    await h.stateStore.upsert({
      user_id: 'u-1',
      project_slug: 'nova',
      phase: 'projects_proposed',
      phase_state_patch: {
        user_id: 'u-1',
        topic_id: 'web:u-1',
        signup_via: 'web',
        active_prompt_id: null,
        // A genuine already-reviewed list — the auto-confirm only fires
        // when there IS content to collapse the redundant gate on (Argus
        // r2 zero-state guard). The both-empty case is covered separately
        // below.
        primary_projects: ['Topline', 'Northwind'],
        slug_picker_outcome: 'renamed',
        url_slug_renamed_to: 'nova',
      },
      advanced_at: Date.now(),
    })
    const sentBefore = h.sentPrompts.length
    const result = await h.engine.start({
      project_slug: 'nova',
      topic_id: 'web:u-1',
      user_id: 'u-1',
      signup_via: 'web',
    })
    // start() auto-confirmed + emitted the persona_reviewed prompt — the
    // user sees the next interview step on the renamed gateway without
    // having to send any inbound first, and without a redundant second
    // project-approval gate.
    expect(h.sentPrompts.length).toBeGreaterThan(sentBefore)
    expect(result.prompt_id.length).toBeGreaterThan(0)
    expect(result.state.phase).toBe('persona_reviewed')
    // The reviewed list was confirmed without a second gate.
    expect(result.state.phase_state['primary_projects_confirmed']).toEqual([
      'Topline',
      'Northwind',
    ])
  })

  test('engine.start at projects_proposed with BOTH reviewed + import-proposed EMPTY re-emits zero-state, does NOT auto-confirm (Argus r2 BLOCKING)', async () => {
    h = makeHarness({ hookConfigured: true })
    // Argus r2 zero-state BLOCKING fix. A user who reaches projects_proposed
    // with no detected projects (empty primary_projects AND empty
    // import_result.proposed_projects) must NOT be silently auto-confirmed
    // into an empty workspace. Auto-confirming here writes
    // primary_projects_confirmed: [] which buildWowSignalsFromState reads as
    // projects_confirmed:true and 03-project-shells.ts reads as
    // "user explicitly declined" → ZERO shells. Instead the engine re-emits
    // the retained zero-state prompt ("Share what I'm working on" /
    // "Skip for now") so the user makes the call. Seed the exact post-rename
    // parked shape (active_prompt_id null, no projects anywhere).
    await h.stateStore.upsert({
      user_id: 'u-1',
      project_slug: 'nova',
      phase: 'projects_proposed',
      phase_state_patch: {
        user_id: 'u-1',
        topic_id: 'web:u-1',
        signup_via: 'web',
        active_prompt_id: null,
        primary_projects: [],
        import_result: { proposed_projects: [] },
        slug_picker_outcome: 'renamed',
        url_slug_renamed_to: 'nova',
      },
      advanced_at: Date.now(),
    })
    const sentBefore = h.sentPrompts.length
    const result = await h.engine.start({
      project_slug: 'nova',
      topic_id: 'web:u-1',
      user_id: 'u-1',
      signup_via: 'web',
    })
    // NOT auto-confirmed: phase stays projects_proposed and no
    // primary_projects_confirmed[] was written.
    expect(result.state.phase).toBe('projects_proposed')
    expect(
      result.state.phase_state['primary_projects_confirmed'],
    ).toBeUndefined()
    // The retained zero-state prompt was re-emitted so the user is not
    // stranded — they see Share-work / Skip-for-now.
    expect(h.sentPrompts.length).toBeGreaterThan(sentBefore)
    expect(result.prompt_id.length).toBeGreaterThan(0)
    const lastSent = h.sentPrompts[h.sentPrompts.length - 1]?.prompt
    expect(lastSent?.body).toContain("I didn't pin down")
  })

  test('engine.start at projects_proposed WITH active_prompt_id is NOT auto-confirmed (Argus r1 IMPORTANT)', async () => {
    h = makeHarness({ hookConfigured: true })
    // The post-rename PARKED state the auto-confirm guard targets has
    // active_prompt_id === null (the live-socket emit was suppressed by the
    // gateway restart). A session that DOES have an in-flight active prompt
    // is NOT the parked state — auto-confirming it would silently advance
    // past a prompt the user is still answering, dropping a pending edit.
    // The guard must skip auto-confirm and leave the phase at
    // projects_proposed (the generic re-emit path repaints the prompt).
    await h.stateStore.upsert({
      user_id: 'u-1',
      project_slug: 'nova',
      phase: 'projects_proposed',
      phase_state_patch: {
        user_id: 'u-1',
        topic_id: 'web:u-1',
        signup_via: 'web',
        active_prompt_id: 'pp-active-1',
      },
      advanced_at: Date.now(),
    })
    const result = await h.engine.start({
      project_slug: 'nova',
      topic_id: 'web:u-1',
      user_id: 'u-1',
      signup_via: 'web',
    })
    // NOT auto-confirmed: phase stays projects_proposed and no
    // primary_projects_confirmed[] was written.
    expect(result.state.phase).toBe('projects_proposed')
    expect(result.state.phase_state['primary_projects_confirmed']).toBeUndefined()
  })

  test('engine.start at projects_proposed in share_freeform sub_step is NOT auto-confirmed (Argus r1 IMPORTANT)', async () => {
    h = makeHarness({ hookConfigured: true })
    // The user tapped "Share what I'm working on" and is mid-edit:
    // projects_proposed_share_freeform === true with the active_prompt_id
    // cleared. deriveActiveSubStep maps this to 'share_freeform'. Auto-
    // confirming here would discard the project edit the user is typing,
    // so the guard must skip auto-confirm and fall through to the generic
    // re-emit (which repaints the freeform prompt).
    await h.stateStore.upsert({
      user_id: 'u-1',
      project_slug: 'nova',
      phase: 'projects_proposed',
      phase_state_patch: {
        user_id: 'u-1',
        topic_id: 'web:u-1',
        signup_via: 'web',
        active_prompt_id: null,
        projects_proposed_share_freeform: true,
      },
      advanced_at: Date.now(),
    })
    const result = await h.engine.start({
      project_slug: 'nova',
      topic_id: 'web:u-1',
      user_id: 'u-1',
      signup_via: 'web',
    })
    // NOT auto-confirmed: phase stays projects_proposed and no
    // primary_projects_confirmed[] was written; the pending edit survives.
    expect(result.state.phase).toBe('projects_proposed')
    expect(result.state.phase_state['primary_projects_confirmed']).toBeUndefined()
  })

  test('same-slug outcome from bridge → engine treats as kept (Codex r3 P2)', async () => {
    h = makeHarness({ hookConfigured: true })
    await seedSlugChosen(h, 'Nova', 'nova', 't-11111111')
    // The bridge returns kind:'skipped', reason:'same_slug' when the
    // user types the slug they already have. Engine should treat this
    // as kept (no rename) and emit the next phase prompt on the live
    // socket — NOT suppress the prompt as it does on a real rename.
    h.hookOutcome = { kind: 'skipped', reason: 'same_slug' }
    const sentBefore = h.sentPrompts.length
    const prompt_id = await activePromptId(h, 't-11111111')
    const result = await h.engine.advance({
      project_slug: 't-11111111',
      topic_id: 'web:u-1',
      user_id: 'u-1',
      channel_kind: 'app-socket',
      choice: {
        prompt_id,
        choice_value: '__freeform__',
        freeform_text: 't-11111111',
        chosen_at: Date.now(),
        speaker_user_id: 'u-1',
        channel_kind: 'app-socket',
      },
      observed_at: Date.now(),
    })
    expect(result.outcome).toBe('advanced')
    // Gate-collapse (#93): kept (same-slug) auto-confirms inline.
    expect(result.state?.phase).toBe('persona_reviewed')
    // No rename → state row stays under the old slug.
    expect(await h.stateStore.get('t-11111111', 'u-1')).not.toBeNull()
    // WS still alive → next-phase prompt fires.
    expect(h.sentPrompts.length).toBeGreaterThan(sentBefore)
    expect(result.prompt_id).toBeDefined()
    expect(result.state?.phase_state['slug_picker_outcome']).toBe('kept')
  })

  test('rename success with gateway-refresh=skipped → emit prompt on live socket (no-restart mode, Codex r8)', async () => {
    h = makeHarness({ hookConfigured: true })
    await seedSlugChosen(h, 'Nova', 'nova', 't-11111111')
    h.hookOutcome = {
      kind: 'renamed',
      new_slug: 'nova',
      result: {
        internal_handle: 't-11111111',
        old_url_slug: 't-11111111',
        new_url_slug: 'nova',
        redirect_route_id: 'r-noskip',
        pending_rename_id: 'p-noskip',
        completed_at: Date.now(),
        steps: [{ step: 'gateway-refreshed', status: 'skipped' }],
      },
    }
    const sentBefore = h.sentPrompts.length
    const prompt_id = await activePromptId(h, 't-11111111')
    const result = await h.engine.advance({
      project_slug: 't-11111111',
      topic_id: 'web:u-1',
      user_id: 'u-1',
      channel_kind: 'app-socket',
      choice: {
        prompt_id,
        choice_value: 'use-suggested',
        chosen_at: Date.now(),
        speaker_user_id: 'u-1',
        channel_kind: 'app-socket',
      },
      observed_at: Date.now(),
    })
    expect(result.outcome).toBe('advanced')
    // Gate-collapse (#93): no-restart rename keeps the WS alive → the
    // engine auto-confirms projects_proposed inline and advances to
    // persona_reviewed on the live socket.
    expect(result.state?.phase).toBe('persona_reviewed')
    // gateway-refresh=skipped → no real restart happened, WS is still
    // alive on this same gateway → emit the next prompt on the live
    // socket.
    expect(h.sentPrompts.length).toBeGreaterThan(sentBefore)
    expect(result.prompt_id).toBeDefined()
    // Codex r9 [P1] — state stays on OLD slug because the gateway is
    // still running on it. A future refresh on old subdomain still
    // resumes correctly. Only when restartCommitted=true do we rekey.
    expect((await h.stateStore.get('t-11111111', 'u-1'))?.phase).toBe('persona_reviewed')
    expect(await h.stateStore.get('nova', 'u-1')).toBeNull()
    expect(result.state?.phase_state['slug_picker_restart_committed']).toBe(false)
    expect(result.state?.phase_state['url_slug_renamed_to']).toBe('nova')
  })

  test('rename success with gateway-refresh=partial → suppress emit (WS-closed-mid-rename, Codex r8)', async () => {
    h = makeHarness({ hookConfigured: true })
    await seedSlugChosen(h, 'Nova', 'nova', 't-11111111')
    h.hookOutcome = {
      kind: 'renamed',
      new_slug: 'nova',
      result: {
        internal_handle: 't-11111111',
        old_url_slug: 't-11111111',
        new_url_slug: 'nova',
        redirect_route_id: 'r-partial',
        pending_rename_id: 'p-partial',
        completed_at: Date.now(),
        steps: [{ step: 'gateway-refreshed', status: 'partial' }],
      },
    }
    const sentBefore = h.sentPrompts.length
    const prompt_id = await activePromptId(h, 't-11111111')
    const result = await h.engine.advance({
      project_slug: 't-11111111',
      topic_id: 'web:u-1',
      user_id: 'u-1',
      channel_kind: 'app-socket',
      choice: {
        prompt_id,
        choice_value: 'use-suggested',
        chosen_at: Date.now(),
        speaker_user_id: 'u-1',
        channel_kind: 'app-socket',
      },
      observed_at: Date.now(),
    })
    expect(result.outcome).toBe('advanced')
    expect(result.state?.phase).toBe('projects_proposed')
    // Partial → WS-closed-mid-rename or restart-failed: no point
    // emitting (no live receiver).
    expect(h.sentPrompts.length).toBe(sentBefore)
    expect(result.prompt_id).toBeUndefined()
    // Codex r9 [P1] — state stays on OLD slug; the gateway is still
    // running on it. The reconciler retries the gateway-restart
    // later, but the rekey is left for a future enhancement (out of
    // scope for this PR).
    expect((await h.stateStore.get('t-11111111', 'u-1'))?.phase).toBe('projects_proposed')
    expect(await h.stateStore.get('nova', 'u-1')).toBeNull()
    expect(result.state?.phase_state['slug_picker_restart_committed']).toBe(false)
  })

  // 2026-05-09 regression — Sam typed a custom slug at the slug_chosen
  // prompt on the chat surface and it went silent:
  // bubble appeared, then nothing. The contract being asserted: for every
  // possible slug-picker outcome (renamed / skipped / rejected / hook-
  // throws), the engine MUST either send a button prompt to the live WS
  // OR throw an InterviewError that the bridge surfaces as a `type:'error'`
  // envelope. SILENCE is never a valid response.
  //
  // Pre-fix the partial-restart case dropped the next-prompt emit in the
  // engine AND the chat-bridge dropped the redirect-failure in user
  // visibility. The chat-bridge fix renders an `error` envelope on
  // restart-failed so the WS remains a useful surface even when the
  // engine's `shouldEmit` collapses to false.
  describe('regression: typed-freeform never produces silent server response (Sam 2026-05-09)', () => {
    type Scenario = {
      name: string
      hook: SlugPickerOutcome | null
      hookThrows?: Error
      typed: string
    }
    const scenarios: Scenario[] = [
      {
        name: 'renamed (gateway-refresh skipped — no-real-mode prod)',
        typed: 'pyrra',
        hook: {
          kind: 'renamed',
          new_slug: 'pyrra',
          result: {
            internal_handle: 't-11111111',
            old_url_slug: 't-11111111',
            new_url_slug: 'pyrra',
            redirect_route_id: 'r-skip',
            pending_rename_id: 'p-skip',
            completed_at: Date.now(),
            steps: [{ step: 'gateway-refreshed', status: 'skipped' }],
          },
        },
      },
      {
        name: 'skipped (same slug)',
        typed: 't-11111111',
        hook: { kind: 'skipped', reason: 'same_slug' },
      },
      {
        name: 'rejected — sanitize_failed',
        typed: '###',
        hook: { kind: 'rejected', reason: 'sanitize_failed' },
      },
      {
        name: 'rejected — unavailable',
        typed: 'taken',
        hook: {
          kind: 'rejected',
          reason: 'unavailable',
          availability: { available: false, reason: 'taken', slug: 'taken' },
        },
      },
      {
        name: 'rejected — rename_failed',
        typed: 'whatever',
        hook: {
          kind: 'rejected',
          reason: 'rename_failed',
          code: 'caddy_unreachable',
          message: 'caddy admin returned 502',
        },
      },
      {
        name: 'hook throws',
        typed: 'kaboom',
        hook: null,
        hookThrows: new Error('rename service unavailable'),
      },
    ]
    for (const s of scenarios) {
      test(`${s.name} — emits agent prompt OR throws (never silent)`, async () => {
        h = makeHarness({ hookConfigured: true })
        await seedSlugChosen(h, 'Nova', 'nova', 't-11111111')
        h.hookOutcome = s.hook
        if (s.hookThrows !== undefined) h.hookError = s.hookThrows
        const sentBefore = h.sentPrompts.length
        // User typed text via WS user_message → engine routes through the
        // freeform_text path (no `choice` field). Mirrors the inbound
        // shape `gateway/http/chat-bridge.ts:handleInbound` constructs.
        const result = await h.engine.advance({
          project_slug: 't-11111111',
          topic_id: 'web:u-1',
          user_id: 'u-1',
          channel_kind: 'app-socket',
          freeform_text: s.typed,
          observed_at: Date.now(),
        })
        // Either the engine sent a prompt to the live WS, or the engine
        // returned a state the bridge can use (advanced / reemitted /
        // resume / no_active_prompt with prompt_id). Anything else is a
        // silent failure — the user typed something and the server
        // produced zero observable output.
        const emittedPrompt = h.sentPrompts.length > sentBefore
        const advancedWithPromptOrState =
          result.outcome === 'advanced' || result.outcome === 'reemitted_current'
        expect(
          emittedPrompt || advancedWithPromptOrState,
          `silent server response for scenario "${s.name}" — sentPrompts unchanged AND result.outcome=${result.outcome}`,
        ).toBe(true)
      })
    }
    test('hook absent + typed freeform → re-emits with not-configured rejection (never silent)', async () => {
      // The other code path: when slugPicker hook is undefined (composer
      // drift, env-var unset). Engine takes branch 3 → persistRejectionAndReEmit.
      h = makeHarness({ hookConfigured: false })
      await seedSlugChosen(h, 'Nova', 'nova', 't-11111111')
      const sentBefore = h.sentPrompts.length
      const result = await h.engine.advance({
        project_slug: 't-11111111',
        topic_id: 'web:u-1',
        user_id: 'u-1',
        channel_kind: 'app-socket',
        freeform_text: 'sam',
        observed_at: Date.now(),
      })
      expect(result.outcome).toBe('reemitted_current')
      expect(h.sentPrompts.length).toBeGreaterThan(sentBefore)
      // The re-emitted prompt's body MUST surface an actionable reason
      // so the user understands why their typed input did nothing.
      const lastPrompt = h.sentPrompts[h.sentPrompts.length - 1]?.prompt
      expect(lastPrompt?.body.toLowerCase()).toContain('not configured')
    })
  })

  test('telemetry — system transcript line for each outcome', async () => {
    h = makeHarness({ hookConfigured: true })
    await seedSlugChosen(h, 'Nova', 'nova', 't-11111111')
    h.hookOutcome = {
      kind: 'renamed',
      new_slug: 'nova',
      result: {
        internal_handle: 't-11111111',
        old_url_slug: 't-11111111',
        new_url_slug: 'nova',
        redirect_route_id: 'r-4',
        pending_rename_id: 'p-4',
        completed_at: Date.now(),
        steps: [{ step: 'completed', status: 'success' }],
      },
    }
    const promptIdT = await activePromptId(h, 't-11111111')
    await h.engine.advance({
      project_slug: 't-11111111',
      topic_id: 'web:u-1',
      user_id: 'u-1',
      channel_kind: 'app-socket',
      choice: {
        prompt_id: promptIdT,
        choice_value: 'use-suggested',
        chosen_at: Date.now(),
        speaker_user_id: 'u-1',
        channel_kind: 'app-socket',
      },
      observed_at: Date.now(),
    })
    const entries = h.transcript.readAll()
    const systemLines = entries.filter((e) => e.role === 'system')
    expect(systemLines.some((e) => e.body.includes('renamed'))).toBe(true)
    expect(systemLines.some((e) => e.body.includes('t-11111111 → nova'))).toBe(true)
  })
})
