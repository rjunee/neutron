/**
 * Codex r1 carry-over (PR #270) — `projects_proposed` zero-state
 * share-freeform handler must re-emit with the JUST-PERSISTED
 * `primary_projects`, not the stale pre-resolve-cached spec.
 *
 * Pre-fix bug (engine.ts:5095-5099 region): the share-freeform branch
 *   1. invalidates the resolved-spec cache,
 *   2. pre-resolves the prompt spec (caches a freshly-resolved spec
 *      whose `primary_projects` is still the EMPTY zero-state list),
 *   3. drains LLM-extracted projects / falls back to
 *      `splitFreeformProjectList`,
 *   4. upserts `primary_projects` into state,
 *   5. calls `emitPhasePrompt`, which re-reads the resolved-spec cache
 *      and returns the STALE step-2 entry — with the empty body.
 *
 * The user sees the share-prompt body again, not their populated list.
 *
 * Post-fix: invalidate the cache AFTER step 4 (and before the rejection
 * re-emit on the no-projects-extracted path too), so `emitPhasePrompt`
 * rebuilds the spec against the freshly-persisted state.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '../../../migrations/runner.ts'
import { ProjectDb } from '../../../persistence/index.ts'
import { ButtonStore } from '../../../channels/button-store.ts'
import type { ButtonChoice, ButtonPrompt } from '../../../channels/button-primitive.ts'
import { buildButtonPrompt } from '../../../channels/button-primitive.ts'
import { InterviewEngine } from '../engine.ts'
import { InMemoryOnboardingStateStore } from '../state-store.ts'
import { TranscriptWriter } from '../transcript.ts'
import {
  PROJECTS_PROPOSED_SHARE_WORK,
} from '../phase-prompts.ts'

let tmp: string
let db: ProjectDb
let buttonStore: ButtonStore
let stateStore: InMemoryOnboardingStateStore
let transcript: TranscriptWriter
let sentPrompts: Array<{ project_slug: string; topic_id: string; prompt: ButtonPrompt }>
let engine: InterviewEngine

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-pp-cachebust-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
  buttonStore = new ButtonStore({ db })
  stateStore = new InMemoryOnboardingStateStore()
  transcript = new TranscriptWriter({
    path: join(tmp, 'persona', 'onboarding-transcript.jsonl'),
  })
  sentPrompts = []
  engine = new InterviewEngine({
    buttonStore,
    stateStore,
    transcript,
    sendButtonPrompt: async (input) => {
      sentPrompts.push(input)
      return { message_id: `msg-${sentPrompts.length}`, was_new: true }
    },
    // No promptDriver — fall through to the static (zero-state /
    // populated) builder so we can directly assert against the body.
  })
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

async function emitProjectsProposedZeroState(): Promise<string> {
  // Seed the state directly at projects_proposed with empty
  // primary_projects + the share-freeform sub-state flipped on, then
  // force an emit by routing a no-op advance through start() — easier
  // than walking the full chain. We mint a prompt by invoking the
  // engine's internal emit path via a wrapper: the simplest is to
  // post a __freeform__ tap against a pre-seeded prompt row.
  await stateStore.upsert({
    project_slug: 't1',
    user_id: 'u-1',
    phase: 'projects_proposed',
    phase_state_patch: {
      primary_projects: [],
      projects_proposed_share_freeform: true,
    },
    advanced_at: 1_000,
  })
  // Emit the share-freeform prompt by tapping SHARE_WORK first ⇒
  // re-emit lands as a freeform-only prompt. Skip that — go directly
  // to the freeform turn by minting a button prompt that matches what
  // emitPhasePrompt would produce, then routing the freeform reply
  // through engine.advance.
  //
  // Drive via the engine: tap SHARE_WORK (the user's first tap),
  // which re-emits the share-freeform body and stamps active_prompt_id.
  // First we need an active prompt to acceptChoice against. Mint one
  // via a synthetic emit through the engine's start? Too heavyweight.
  //
  // Simpler: emit by tapping a value, but the share-work path needs
  // an active_prompt_id pointer. The minimal harness — call
  // start({phase: 'projects_proposed'})? `start()` only handles
  // signup. The cleanest is to emit a real ButtonPrompt and feed its
  // id into a freeform advance.
  //
  // Use the engine's `reemitCurrentPhase` (if exposed) or just
  // synthesize a button prompt row directly via buttonStore.
  const prompt = buildButtonPrompt({
    body: 'You said you wanted to share what you are working on...',
    options: [],
    allow_freeform: true,
    idempotency_key: 'pp-share-freeform-seed',
    uuid: () => '00000000-0000-0000-0000-000000000001',
  })
  const emit = await buttonStore.emit(prompt, { topic_id: 'topic-1' })
  await buttonStore.markDelivered(emit.prompt_id, 1_500)
  await stateStore.upsert({
    project_slug: 't1',
    user_id: 'u-1',
    phase: 'projects_proposed',
    phase_state_patch: { active_prompt_id: emit.prompt_id },
    advanced_at: 2_000,
  })
  return emit.prompt_id
}

test('share-freeform freeform with extracted projects re-emits with populated body (not stale empty cache)', async () => {
  const prompt_id = await emitProjectsProposedZeroState()
  const choice: ButtonChoice = {
    prompt_id,
    choice_value: '__freeform__',
    freeform_text: '1. Topline\n2. Northwind\n3. Beacon',
    chosen_at: 3_000,
    speaker_user_id: 'u-1',
    channel_kind: 'app-socket',
  }
  const result = await engine.advance({
    project_slug: 't1',
    topic_id: 'topic-1',
    user_id: 'u-1',
    channel_kind: 'app-socket',
    choice,
    observed_at: 3_000,
  })
  expect(result.outcome).toBe('reemitted_current')

  // The re-emitted prompt should now list the three projects — not
  // re-display the zero-state share-freeform body.
  const last = sentPrompts[sentPrompts.length - 1]
  expect(last).toBeDefined()
  const body = last!.prompt.body
  expect(body).toContain('Topline')
  expect(body).toContain('Northwind')
  expect(body).toContain('Beacon')
  // The zero-state body shouldn't leak through the cache.
  expect(body).not.toContain('Tell me what')
  // primary_projects should be persisted on state.
  const finalState = await stateStore.get('t1', 'u-1')
  expect(finalState?.phase).toBe('projects_proposed')
  const persisted = finalState!.phase_state['primary_projects'] as readonly string[]
  expect(persisted).toEqual(['Topline', 'Northwind', 'Beacon'])
})

test('share-freeform with NO extractable projects re-emits the rejection body (cache busted with rejection patch)', async () => {
  const prompt_id = await emitProjectsProposedZeroState()
  // splitFreeformProjectList drops any candidate > 120 chars, so a
  // single long line with no separators / numeric markers extracts
  // nothing and the engine takes the rejection branch.
  const longRamble =
    'I have been working on quite a lot of things lately but cannot really pin down a clean list of distinct projects because they all blend together and overlap in many ways throughout my week'
  const choice: ButtonChoice = {
    prompt_id,
    choice_value: '__freeform__',
    freeform_text: longRamble,
    chosen_at: 3_000,
    speaker_user_id: 'u-1',
    channel_kind: 'app-socket',
  }
  const result = await engine.advance({
    project_slug: 't1',
    topic_id: 'topic-1',
    user_id: 'u-1',
    channel_kind: 'app-socket',
    choice,
    observed_at: 3_000,
  })
  expect(result.outcome).toBe('reemitted_current')

  const last = sentPrompts[sentPrompts.length - 1]
  expect(last).toBeDefined()
  // The rejection text should be present in the rebuilt body (the
  // pre-resolve cached the body without the rejection patch; the
  // post-fix invalidation lets the rebuild stitch the rejection onto
  // the zero-state body).
  expect(last!.prompt.body).toContain("I couldn't pick out")
  // primary_projects remains empty.
  const finalState = await stateStore.get('t1', 'u-1')
  const persisted = (finalState!.phase_state['primary_projects'] ?? []) as readonly string[]
  expect(persisted).toEqual([])
})

// Sanity — touching the SHARE_WORK button still re-emits the share-
// freeform body. This is the path that LANDS the user at the freeform
// turn the two tests above exercise.
test('SHARE_WORK button tap re-emits the share-freeform body', async () => {
  // Drive via tapping SHARE_WORK against a pre-emitted populated
  // projects_proposed prompt. The pre-fix code already invalidated
  // the cache on this branch (line 5197), so this is a sanity
  // assertion that the existing behavior holds — defensive against
  // a future refactor.
  await stateStore.upsert({
    project_slug: 't1',
    user_id: 'u-1',
    phase: 'projects_proposed',
    phase_state_patch: { primary_projects: [] },
    advanced_at: 1_000,
  })
  const prompt = buildButtonPrompt({
    body: '...zero state body...',
    options: [
      { label: 'A', body: "Share what I'm working on", value: PROJECTS_PROPOSED_SHARE_WORK },
      { label: 'B', body: 'Skip', value: 'skip_ahead' },
    ],
    allow_freeform: true,
    idempotency_key: 'pp-zero-state-seed',
    uuid: () => '00000000-0000-0000-0000-000000000002',
  })
  const emit = await buttonStore.emit(prompt, { topic_id: 'topic-1' })
  await buttonStore.markDelivered(emit.prompt_id, 1_500)
  await stateStore.upsert({
    project_slug: 't1',
    user_id: 'u-1',
    phase: 'projects_proposed',
    phase_state_patch: { active_prompt_id: emit.prompt_id },
    advanced_at: 2_000,
  })

  const choice: ButtonChoice = {
    prompt_id: emit.prompt_id,
    choice_value: PROJECTS_PROPOSED_SHARE_WORK,
    chosen_at: 3_000,
    speaker_user_id: 'u-1',
    channel_kind: 'app-socket',
  }
  const result = await engine.advance({
    project_slug: 't1',
    topic_id: 'topic-1',
    user_id: 'u-1',
    channel_kind: 'app-socket',
    choice,
    observed_at: 3_000,
  })
  expect(result.outcome).toBe('reemitted_current')

  const last = sentPrompts[sentPrompts.length - 1]
  expect(last).toBeDefined()
  expect(last!.prompt.body).toContain("Tell me what you're working on")
  // share_freeform sub-state should be set.
  const finalState = await stateStore.get('t1', 'u-1')
  expect(finalState?.phase_state['projects_proposed_share_freeform']).toBe(true)
})
