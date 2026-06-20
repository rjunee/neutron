/**
 * Onboarding Open-mode — deployment-mode-gated phase-walk regression test.
 *
 * Spec: docs/plans/P2-onboarding-v2.md § 2.13 (Open vs Managed sequence) +
 * docs/NEUTRON.md § 1 (deployment tiers / Open framing-by-shape).
 *
 * Per CLAUDE.md forbidden-patterns (NO bookkeeping-only tests): every walk
 * here traverses phases via REAL `engine.advance` calls with a mocked LLM
 * (the static-fallback prompt driver), NOT by SQL-stubbing intermediate
 * phases. The open walk asserts:
 *   - the CUT phases (identity_oauth / instance_provisioned / slug_chosen) are
 *     NEVER entered (neither as an observed resting phase NOR as an emitted
 *     prompt),
 *   - the KEPT phases (signup / ai_substrate_offered / personality_offered /
 *     agent_name_chosen / persona_reviewed / max_oauth_offered / wow_fired)
 *     ARE entered, and projects are confirmed (traversed),
 *   - `max_oauth_offered` presents the LOCAL setup-token paste affordance
 *     (asserted on the emitted prompt body + the SecretsStore write — not
 *     just a phase advance),
 *   - NO slug is derived from the agent name in open mode.
 * A managed walk pins the unchanged hosted routing (slug_chosen IS entered).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '../../../migrations/runner.ts'
import { ProjectDb } from '../../../persistence/index.ts'
import { ButtonStore } from '../../../channels/button-store.ts'
import type { ButtonChoice, ButtonPrompt } from '../../../channels/button-primitive.ts'
import { InterviewEngine } from '../engine.ts'
import type { OnboardingDeploymentMode } from '../phase.ts'
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
let secretsPuts: Array<{ internal_handle: string; kind: string; label: string; plaintext: string }>
let savedEnvToken: string | undefined

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-open-walk-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
  buttonStore = new ButtonStore({ db })
  stateStore = new InMemoryOnboardingStateStore()
  transcript = new TranscriptWriter({
    path: join(tmp, 'persona', 'onboarding-transcript.jsonl'),
  })
  sentPrompts = []
  secretsPuts = []
  // The open max_oauth_offered phase auto-skips when a Max secret exists OR
  // `CLAUDE_CODE_OAUTH_TOKEN` is set in the env (maybeAutoAdvancePastMaxOauthOffered).
  // Unset it so the walk deterministically PRESENTS the setup-token prompt.
  savedEnvToken = process.env['CLAUDE_CODE_OAUTH_TOKEN']
  delete process.env['CLAUDE_CODE_OAUTH_TOKEN']
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
  if (savedEnvToken === undefined) delete process.env['CLAUDE_CODE_OAUTH_TOKEN']
  else process.env['CLAUDE_CODE_OAUTH_TOKEN'] = savedEnvToken
})

/**
 * Static-fallback prompt driver (same shape as v2-phase-walk.test.ts). The
 * work_interview_gap_fill phase gets deterministic extraction so the audit
 * gate clears in one turn; every other free-text phase falls back to the
 * static spec so routing is driven by `next_phase_on_default`.
 */
function makeFallbackDriver(): (input: GeneratePromptInput) => Promise<DrivenPhasePromptSpec> {
  return async (input) => {
    const spec: DrivenPhasePromptSpec = {
      phase: input.phase,
      body: 'fallback',
      options: [],
      allow_freeform: true,
      next_phase_on_default: input.phase,
      is_fallback: false,
    }
    if (input.phase === 'work_interview_gap_fill') {
      const lastUser = [...input.transcript_so_far].reverse().find((t) => t.role === 'user')
      const reply = lastUser?.body ?? ''
      const extracted: NonNullable<DrivenPhasePromptSpec['extracted_fields']> = {}
      if (/fragrance brand|hotel group/i.test(reply)) {
        extracted.primary_projects = ['fragrance brand', 'hotel group', 'CC course']
      }
      if (/yoga|family time/i.test(reply)) {
        extracted.non_work_interests = [{ name: 'yoga' }, { name: 'family time' }]
      }
      if (Object.keys(extracted).length > 0) spec.extracted_fields = extracted
    } else {
      spec.is_fallback = true
    }
    return spec
  }
}

function makeEngine(deploymentMode: OnboardingDeploymentMode): InterviewEngine {
  return new InterviewEngine({
    buttonStore,
    stateStore,
    transcript,
    sendButtonPrompt: async (input) => {
      sentPrompts.push(input)
      return { message_id: `msg-${sentPrompts.length}`, was_new: true }
    },
    promptDriver: makeFallbackDriver(),
    deploymentMode,
    // In-memory SecretsStore so the open setup-token paste persists somewhere
    // observable. `list` starts empty so the phase is not auto-skipped.
    secrets: {
      put: async (row) => {
        secretsPuts.push({
          internal_handle: row.internal_handle,
          kind: row.kind,
          label: row.label,
          plaintext: row.plaintext,
        })
        return { id: `secret-${secretsPuts.length}` }
      },
      list: async () => [],
    },
  })
}

async function lastPromptId(): Promise<string> {
  const sent = sentPrompts[sentPrompts.length - 1]
  if (sent === undefined) throw new Error('no prompt has been sent yet')
  return sent.prompt.prompt_id
}

function lastPrompt(): ButtonPrompt {
  const sent = sentPrompts[sentPrompts.length - 1]
  if (sent === undefined) throw new Error('no prompt has been sent yet')
  return sent.prompt
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

async function advanceButton(
  engine: InterviewEngine,
  project_slug: string,
  choice_value: string,
  observed_at: number,
): Promise<void> {
  const prompt_id = await lastPromptId()
  const choice: ButtonChoice = {
    prompt_id,
    choice_value,
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

const CUT_OPEN_PHASES = ['identity_oauth', 'instance_provisioned', 'slug_chosen'] as const

describe('Onboarding Open-mode — engine.advance walk cuts the managed-only phases', () => {
  test('open walk never enters identity_oauth / instance_provisioned / slug_chosen and reaches wow_fired', async () => {
    const engine = makeEngine('open')
    const project_slug = 'owner'
    let observed_at = 1_700_000_000_000
    const observedPhases: string[] = []

    const recordPhase = async (): Promise<string> => {
      const state = await stateStore.get(project_slug, 'u-1')
      expect(state).not.toBeNull()
      observedPhases.push(state!.phase)
      return state!.phase
    }

    // start() emits the greeting (signup). identity_oauth + instance_provisioned
    // are NOT walked in open mode (they are cut from the route).
    await engine.start({
      project_slug,
      topic_id: 'topic-1',
      user_id: 'u-1',
      signup_via: 'web',
    })
    expect(await recordPhase()).toBe('signup')

    // signup greeting → first-name reply. Managed routes signup →
    // instance_provisioned (auto-skip) → ai_substrate_offered; OPEN routes
    // signup → ai_substrate_offered DIRECTLY (no provisioning transit).
    observed_at += 1_000
    await advanceFreeform(engine, project_slug, 'Riley', observed_at)
    expect(await recordPhase()).toBe('ai_substrate_offered')

    // ai_substrate_offered → neither → work_interview_gap_fill (unchanged).
    observed_at += 1_000
    await advanceButton(engine, project_slug, 'neither', observed_at)
    expect(await recordPhase()).toBe('work_interview_gap_fill')

    // gap-fill freeform — volunteers projects + interests; audit clears.
    observed_at += 1_000
    await advanceFreeform(
      engine,
      project_slug,
      'Building a fragrance brand and a hotel group. Outside work: yoga and family time.',
      observed_at,
    )
    expect(await recordPhase()).toBe('personality_offered')

    // personality_offered → agent_name_chosen (KEPT in open — the name still
    // names the runtime assistant).
    observed_at += 1_000
    await advanceFreeform(engine, project_slug, 'A warm thinking-partner with a strategist edge.', observed_at)
    expect(await recordPhase()).toBe('agent_name_chosen')

    // agent_name_chosen → in OPEN this routes to projects_proposed (slug_chosen
    // CUT) and the gate-collapse walks through projects_proposed →
    // persona_synthesizing → persona_reviewed in one advance. The managed
    // path would rest at slug_chosen here.
    observed_at += 1_000
    await advanceFreeform(engine, project_slug, 'Sage', observed_at)
    const afterName = await stateStore.get(project_slug, 'u-1')
    observedPhases.push(afterName!.phase)
    expect(afterName!.phase).toBe('persona_reviewed')
    // Name was captured AND used (it names the assistant)...
    expect(afterName!.phase_state['agent_name']).toBe('Sage')
    // ...but NO slug was derived from it — slug_chosen is not in the open
    // sequence, so no dangling `suggested_slug` is seeded.
    expect(afterName!.phase_state['suggested_slug']).toBeUndefined()
    // Projects were confirmed (traversed, not skipped) by the gate-collapse.
    expect(afterName!.phase_state['primary_projects_confirmed']).toEqual([
      'fragrance brand',
      'hotel group',
      'CC course',
    ])

    // persona_reviewed → looks_good → max_oauth_offered.
    observed_at += 1_000
    await advanceButton(engine, project_slug, 'looks_good', observed_at)
    expect(await recordPhase()).toBe('max_oauth_offered')

    // ASSERT THE AFFORDANCE (not just the phase): the open max_oauth_offered
    // prompt is the LOCAL setup-token paste, NOT the hosted "Connect Claude
    // Max" OAuth handoff.
    const maxPrompt = lastPrompt()
    expect(maxPrompt.body.toLowerCase()).toContain('claude setup-token')
    expect(maxPrompt.body.toLowerCase()).toContain('paste')
    expect(maxPrompt.body).not.toContain('Connect Claude Max')
    expect(maxPrompt.body).not.toContain('http')
    // Only a "Skip for now" button — no attach_max / byo buttons.
    const optionValues = maxPrompt.options.map((o) => o.value)
    expect(optionValues).not.toContain('attach_max')
    expect(optionValues).not.toContain('byo_key')

    // Paste the setup-token (freeform) → persists to the local SecretsStore
    // as kind `max_oauth_refresh` and advances to wow_fired.
    observed_at += 1_000
    await advanceFreeform(engine, project_slug, 'sk-ant-oat01-good-setup-token-fixture-value', observed_at)
    const afterPaste = await stateStore.get(project_slug, 'u-1')
    observedPhases.push(afterPaste!.phase)
    expect(afterPaste!.phase).toBe('wow_fired')
    expect(afterPaste!.phase_state['max_substrate']).toBe('max_oauth')

    // The setup-token was persisted to the local SecretsStore.
    expect(secretsPuts.length).toBe(1)
    expect(secretsPuts[0]!.kind).toBe('max_oauth_refresh')
    expect(secretsPuts[0]!.plaintext).toContain('sk-ant-oat01-good-setup-token-fixture-value')

    // FINAL: no cut phase was ever an observed resting phase. The engine
    // emits a prompt only when it rests on (or re-emits) a phase, so a cut
    // phase never being a resting phase means no prompt was ever emitted for
    // one either.
    for (const cut of CUT_OPEN_PHASES) {
      expect(observedPhases).not.toContain(cut)
    }
    // The kept user-visible phases WERE entered.
    for (const kept of ['signup', 'ai_substrate_offered', 'personality_offered', 'agent_name_chosen', 'persona_reviewed', 'max_oauth_offered', 'wow_fired']) {
      expect(observedPhases).toContain(kept)
    }
  })

  test('open mode: a stale attach_max tap re-emits the setup-token prompt (never starts a hosted handoff)', async () => {
    const engine = makeEngine('open')
    const project_slug = 'owner2'
    let observed_at = 1_700_000_000_000
    await engine.start({ project_slug, topic_id: 'topic-1', user_id: 'u-1', signup_via: 'web' })
    observed_at += 1_000
    await advanceFreeform(engine, project_slug, 'Riley', observed_at)
    observed_at += 1_000
    await advanceButton(engine, project_slug, 'neither', observed_at)
    observed_at += 1_000
    await advanceFreeform(engine, project_slug, 'Building a fragrance brand and a hotel group. Outside work: yoga.', observed_at)
    observed_at += 1_000
    await advanceFreeform(engine, project_slug, 'warm strategist', observed_at)
    observed_at += 1_000
    await advanceFreeform(engine, project_slug, 'Sage', observed_at)
    observed_at += 1_000
    await advanceButton(engine, project_slug, 'looks_good', observed_at)
    let state = await stateStore.get(project_slug, 'u-1')
    expect(state!.phase).toBe('max_oauth_offered')

    // A stale managed-shaped keyboard might send `attach_max`. In open mode
    // that must NOT start a hosted handoff (no handoff URL minted); it
    // re-emits the local setup-token prompt.
    observed_at += 1_000
    await advanceButton(engine, project_slug, 'attach_max', observed_at)
    state = await stateStore.get(project_slug, 'u-1')
    expect(state!.phase).toBe('max_oauth_offered')
    expect(state!.phase_state['max_handoff_url'] ?? null).toBeNull()
    const reEmitted = lastPrompt()
    expect(reEmitted.body.toLowerCase()).toContain('setup-token')
  })
})

describe('Onboarding Managed-mode — sequence is unchanged (no regression)', () => {
  test('managed walk still routes agent_name_chosen → slug_chosen and derives a slug', async () => {
    const engine = makeEngine('managed')
    const project_slug = 'casey'
    let observed_at = 1_700_000_000_000

    await engine.start({ project_slug, topic_id: 'topic-1', user_id: 'u-1', signup_via: 'web' })
    let state = await stateStore.get(project_slug, 'u-1')
    expect(state!.phase).toBe('signup')

    observed_at += 1_000
    await advanceFreeform(engine, project_slug, 'Casey', observed_at)
    state = await stateStore.get(project_slug, 'u-1')
    // Managed routes signup → instance_provisioned (auto-skip) → ai_substrate_offered.
    expect(state!.phase).toBe('ai_substrate_offered')

    observed_at += 1_000
    await advanceButton(engine, project_slug, 'neither', observed_at)
    observed_at += 1_000
    await advanceFreeform(
      engine,
      project_slug,
      'Building a fragrance brand and a hotel group. Outside work: yoga and family time.',
      observed_at,
    )
    state = await stateStore.get(project_slug, 'u-1')
    expect(state!.phase).toBe('personality_offered')

    observed_at += 1_000
    await advanceFreeform(engine, project_slug, 'warm strategist', observed_at)
    state = await stateStore.get(project_slug, 'u-1')
    expect(state!.phase).toBe('agent_name_chosen')

    // The managed-mode contract: agent_name_chosen → slug_chosen, WITH a
    // derived slug (the open-mode cut + no-derivation must NOT leak here).
    observed_at += 1_000
    await advanceFreeform(engine, project_slug, 'Sage', observed_at)
    state = await stateStore.get(project_slug, 'u-1')
    expect(state!.phase).toBe('slug_chosen')
    expect(state!.phase_state['agent_name']).toBe('Sage')
    expect(typeof state!.phase_state['suggested_slug']).toBe('string')
    expect((state!.phase_state['suggested_slug'] as string).length).toBeGreaterThan(0)
  })
})
