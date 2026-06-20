/**
 * Regression tests — Argus r1 BLOCKER 1 + 2 (2026-06-03,
 * onboarding-buttons-only-tweak-later).
 *
 * The buttons-only sprint classified `persona_reviewed` and `import_running`
 * as buttons-only at the PHASE level. But both phases carry sub_steps whose
 * prompt body explicitly asks for freeform text:
 *
 *   - persona_reviewed: `pick_replacement` / `pending_regen_hint` emit
 *     `options:[]` + `allow_freeform:true` and ask the user to describe a
 *     tweak "in their own words".
 *   - import_running: `rate_limit_paused` (any text re-polls) and `failed`
 *     ("Paste a fresh URL below to retry") both invite a typed reply.
 *
 * Pre-fix the phase-level buttons-only mode intercepted that text with the
 * canned nudge — a hard stall (no button to tap on the options:[] shapes).
 *
 * These tests prove `resolveInteractionMode` is now sub_step-aware: typed
 * input on a freeform sub_step routes to the phase's dedicated freeform
 * handler (recompose / retry / re-poll), advances state, and the canned
 * nudge is NEVER emitted. (Gate-collapse #93, 2026-06-05: persona_reviewed's
 * `idle` screen is now ALSO a freeform sub_step — a typed reply on the
 * single-"Looks good"-button review screen recomposes — so only
 * import_running's `status` transit sub_step remains buttons-only here.)
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
} from '../engine.ts'
import type { PersonaDraft } from '../../persona-gen/compose.ts'
import type { ImportJob } from '../../history-import/types.ts'
import { InMemoryOnboardingStateStore } from '../state-store.ts'
import { TranscriptWriter } from '../transcript.ts'
import { BUTTONS_ONLY_NUDGE_TEXT } from '../interaction-mode.ts'

const OWNER = 't1'
const TOPIC = 'topic-1'
const USER = 'u-1'
const NOW_MS = Date.now()

let tmp: string
let db: ProjectDb
let buttonStore: ButtonStore
let stateStore: InMemoryOnboardingStateStore
let transcript: TranscriptWriter
let sentPrompts: Array<{ prompt: ButtonPrompt }>

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-substep-routing-'))
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

/** Register a live freeform prompt in the ButtonStore and return its id so
 *  the seeded state's `active_prompt_id` resolves through consumeChoice. */
async function registerFreeformPrompt(body: string): Promise<string> {
  const prompt = buildButtonPrompt({ body, options: [], allow_freeform: true })
  await buttonStore.emit(prompt, { topic_id: TOPIC })
  return prompt.prompt_id
}

// ── persona_reviewed freeform sub_steps ──────────────────────────────────

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

describe('persona_reviewed freeform sub_steps route to recompose (not nudged)', () => {
  for (const sub_step of ['pending_regen_hint', 'pick_replacement'] as const) {
    test(`${sub_step}: typed tweak recomposes, advances sub_step to idle, no canned nudge`, async () => {
      const track = { composeCalls: 0 }
      const engine = new InterviewEngine({
        buttonStore,
        stateStore,
        transcript,
        sendButtonPrompt: async (input) => {
          sentPrompts.push({ prompt: input.prompt })
          return { message_id: `msg-${sentPrompts.length}`, was_new: true }
        },
        personaComposer: makeStubComposer(track),
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

      // (a) the canned nudge was NEVER emitted
      expect(nudgeCount()).toBe(0)
      // (b) the typed tweak routed to the recompose handler
      expect(track.composeCalls).toBe(1)
      // (c) state advanced: sub_step returned to idle with a fresh draft
      const state = await stateStore.get(OWNER, USER)
      expect(state?.phase).toBe('persona_reviewed')
      expect(state?.phase_state['persona_review_sub_step']).toBe('idle')
      expect(state?.phase_state['persona_draft']).toBeDefined()
      expect(out.outcome).not.toBe('noop_no_state')
    })
  }
})

// ── import_running freeform sub_steps ────────────────────────────────────

function makeImportEngine(track: {
  startCalls: number
  statusCalls: number
}): InterviewEngine {
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
  })
}

describe('import_running freeform sub_steps route to retry/re-poll (not nudged)', () => {
  test('failed: pasted URL kicks off a retry runner.start, no canned nudge', async () => {
    const track = { startCalls: 0, statusCalls: 0 }
    const engine = makeImportEngine(track)

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

    // (a) the canned nudge was NEVER emitted
    expect(nudgeCount()).toBe(0)
    // (b) the pasted URL routed to the retry path → runner.start fired
    expect(track.startCalls).toBe(1)
    // (c) the fresh URL was stashed for the retry
    const state = await stateStore.get(OWNER, USER)
    expect(state?.phase).toBe('import_running')
    expect(state?.phase_state['import_paste_url_chatgpt-zip']).toBe(
      'https://example.com/fresh-export.zip',
    )
  })

  test('rate_limit_paused: typed text re-polls the runner, no canned nudge', async () => {
    const track = { startCalls: 0, statusCalls: 0 }
    const engine = makeImportEngine(track)

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

    // (a) the canned nudge was NEVER emitted
    expect(nudgeCount()).toBe(0)
    // (b) the typed text re-polled the runner instead of stalling
    expect(track.statusCalls).toBeGreaterThanOrEqual(1)
    // (c) no retry was triggered (paused is recoverable; status text only)
    expect(track.startCalls).toBe(0)
    const state = await stateStore.get(OWNER, USER)
    expect(state?.phase).toBe('import_running')
  })
})
