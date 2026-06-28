/**
 * Path 1 post-turn onboarding scribe — unit tests.
 *
 * Verifies the fire-and-forget extractor: it pulls structured fields out of an
 * (assistant question, user answer) exchange, persists them byte-compatibly
 * into `phase_state`, never blocks/throws, and fires `onComplete` exactly when
 * the 5 required fields first become complete.
 */

import { test, expect } from 'bun:test'

import {
  buildPostTurnExtractor,
  buildPhaseStatePatch,
  parseExtractedFields,
} from '../post-turn-extractor.ts'
import type { AnthropicMessagesClient } from '../agent-name-suggester.ts'
import { InMemoryOnboardingStateStore } from '../state-store.ts'
import { auditRequiredFields } from '../required-fields-audit.ts'

const SLUG = 'acme'
const USER = 'owner:1'

/** A stub client that returns a fixed JSON envelope (one per call, in order). */
function stubClient(responses: string[]): AnthropicMessagesClient {
  let i = 0
  return {
    messages: {
      create: async () => {
        const text = responses[Math.min(i, responses.length - 1)] ?? '{}'
        i += 1
        return { content: [{ text }] }
      },
    },
  }
}

test('parseExtractedFields: strict parse + array coercion', () => {
  const parsed = parseExtractedFields(
    '{"user_first_name":"Sam","primary_projects":["A","B"],"non_work_interests":["climbing",{"name":"chess","cadence_hint":"weekly"}]}',
  )
  expect(parsed?.user_first_name).toBe('Sam')
  expect(parsed?.primary_projects).toEqual(['A', 'B'])
  expect(parsed?.non_work_interests).toEqual([{ name: 'climbing' }, { name: 'chess', cadence_hint: 'weekly' }])
  expect(parseExtractedFields('not json')).toBeNull()
  expect(parseExtractedFields('{}')).toEqual({})
})

test('buildPhaseStatePatch: merges arrays, dedupes, LLM-driven scalars', () => {
  const prior = { primary_projects: ['Topline'], user_first_name: 'Sam' }
  const patch = buildPhaseStatePatch(
    prior,
    { primary_projects: ['topline', 'Acme'], agent_personality: 'warm and direct', agent_name: 'Atlas' },
    'I want to call you Atlas',
  )
  // dedupe case-insensitive against prior, append new
  expect(patch['primary_projects']).toEqual(['Topline', 'Acme'])
  expect(patch['agent_personality']).toBe('warm and direct')
  // user_first_name already set in prior → not re-patched
  expect(patch['user_first_name']).toBeUndefined()
  // agent_name comes from the LLM field
  expect(patch['agent_name']).toBe('Atlas')
})

test('buildPhaseStatePatch: does NOT mis-extract an agent name from a general turn', () => {
  // No agent_name from the LLM + a conversational answer → no spurious name.
  const patch = buildPhaseStatePatch({}, { user_first_name: 'Sam' }, "I'm Sam and I build things")
  expect(patch['agent_name']).toBeUndefined()
  expect(patch['user_first_name']).toBe('Sam')
})

test('extractor persists fields and fires onComplete when 5 required fields complete', async () => {
  const store = new InMemoryOnboardingStateStore()
  // One LLM response that completes every required field at once.
  const client = stubClient([
    JSON.stringify({
      user_first_name: 'Sam',
      agent_name: 'Atlas',
      agent_personality: 'warm and direct',
      primary_projects: ['Topline', 'Acme', 'a book on focus'],
      non_work_interests: ['climbing'],
    }),
  ])
  let completedWith: { user_id: string } | null = null
  const extractor = buildPostTurnExtractor({
    anthropicClient: client,
    stateStore: store,
    project_slug: SLUG,
    onComplete: ({ user_id }) => {
      completedWith = { user_id }
    },
  })

  const state = await extractor.runOnce({
    user_id: USER,
    agent_text: 'Tell me about yourself and your work.',
    user_text:
      "I'm Sam, I work on Topline and Acme and a book on focus, and I climb. Call you Atlas, warm and direct.",
    observed_at: 1000,
  })

  expect(state).not.toBeNull()
  expect(state!.phase_state['user_first_name']).toBe('Sam')
  expect(state!.phase_state['agent_name']).toBe('Atlas')
  expect((state!.phase_state['primary_projects'] as string[]).length).toBe(3)
  expect(auditRequiredFields(state!.phase_state).next_to_collect).toBeNull()
  expect(completedWith).not.toBeNull()
  expect(completedWith!.user_id).toBe(USER)
})

test('extractor does NOT complete while fields are still missing', async () => {
  const store = new InMemoryOnboardingStateStore()
  const client = stubClient([JSON.stringify({ user_first_name: 'Sam' })])
  let completed = false
  const extractor = buildPostTurnExtractor({
    anthropicClient: client,
    stateStore: store,
    project_slug: SLUG,
    onComplete: () => {
      completed = true
    },
  })
  const state = await extractor.runOnce({
    user_id: USER,
    agent_text: 'What should I call you?',
    user_text: "I'm Sam",
    observed_at: 1000,
  })
  expect(state!.phase_state['user_first_name']).toBe('Sam')
  expect(state!.phase).toBe('work_interview_gap_fill')
  expect(completed).toBe(false)
})

test('extractor is a no-op once onboarding is completed (terminal phase)', async () => {
  const store = new InMemoryOnboardingStateStore()
  await store.upsert({ project_slug: SLUG, user_id: USER, phase: 'completed', completed_at: 1 })
  let called = false
  const extractor = buildPostTurnExtractor({
    anthropicClient: stubClient(['{}']),
    stateStore: store,
    project_slug: SLUG,
    onComplete: () => {
      called = true
    },
  })
  const state = await extractor.runOnce({
    user_id: USER,
    agent_text: 'hi',
    user_text: 'still chatting',
    observed_at: 2,
  })
  expect(state).toBeNull()
  expect(called).toBe(false)
})

// ── Premature-finalize import race (2026-06-28 reset-gate E2E) ──────────────
// A Path-1 export upload starts an import job OUTSIDE the extractor's per-user
// chain. If the extractor finalizes onboarding on top of a live import, the
// import completes orphaned (seeds on disk, but no `projects` DB rows / gbrain
// pages, because the wow-materializer already ran with no `import_result`).

const ALL_FIVE = JSON.stringify({
  user_first_name: 'Sam',
  agent_name: 'Atlas',
  agent_personality: 'warm and direct',
  primary_projects: ['Topline', 'Acme', 'a book on focus'],
  non_work_interests: ['climbing'],
})

test('in-flight import DEFERS completion even when all 5 fields are present', async () => {
  const store = new InMemoryOnboardingStateStore()
  let completed = false
  const extractor = buildPostTurnExtractor({
    anthropicClient: stubClient([ALL_FIVE]),
    stateStore: store,
    project_slug: SLUG,
    // A real import job is live → must NOT finalize on top of it.
    hasInFlightImport: async () => true,
    onComplete: () => {
      completed = true
    },
  })
  const state = await extractor.runOnce({
    user_id: USER,
    agent_text: 'Tell me about yourself.',
    user_text: "I'm Sam, I build Topline/Acme/a focus book, I climb, call you Atlas.",
    observed_at: 1000,
  })
  // Fields persisted, but completion deferred while the import runs.
  expect(auditRequiredFields(state!.phase_state).next_to_collect).toBeNull()
  expect(state!.phase).not.toBe('completed')
  expect(state!.completed_at ?? null).toBeNull()
  expect(completed).toBe(false)
})

test('completion proceeds once the import is no longer in flight', async () => {
  const store = new InMemoryOnboardingStateStore()
  let completed = false
  const extractor = buildPostTurnExtractor({
    anthropicClient: stubClient([ALL_FIVE]),
    stateStore: store,
    project_slug: SLUG,
    hasInFlightImport: async () => false, // import terminal/absent → safe to finish
    onComplete: () => {
      completed = true
    },
  })
  await extractor.runOnce({
    user_id: USER,
    agent_text: 'Tell me about yourself.',
    user_text: "I'm Sam, I build Topline/Acme/a focus book, I climb, call you Atlas.",
    observed_at: 1000,
  })
  expect(completed).toBe(true)
})

test('a concurrent upload that advances the row to import_running mid-extraction is NOT clobbered or finalized', async () => {
  const store = new InMemoryOnboardingStateStore()
  // Seed a row at the interview marker with 4/5 fields already collected.
  await store.upsert({
    project_slug: SLUG,
    user_id: USER,
    phase: 'work_interview_gap_fill',
    phase_state_patch: {
      user_first_name: 'Sam',
      agent_name: 'Atlas',
      agent_personality: 'warm and direct',
      primary_projects: ['Topline', 'Acme', 'a book on focus'],
    },
    advanced_at: 500,
  })
  let completed = false
  // The LLM call simulates a concurrent `notifyImportUpload` landing DURING the
  // multi-second extraction: it flips the row to `import_running` (as the engine
  // does) before returning the field that completes all 5. No `hasInFlightImport`
  // is wired here — the fix's FRESH re-read of the row must catch it on its own.
  const racingClient: AnthropicMessagesClient = {
    messages: {
      create: async () => {
        await store.upsert({
          project_slug: SLUG,
          user_id: USER,
          phase: 'import_running',
          phase_state_patch: { import_job_id: 'synth-xyz' },
          advanced_at: 900,
        })
        return { content: [{ text: JSON.stringify({ non_work_interests: ['climbing'] }) }] }
      },
    },
  }
  const extractor = buildPostTurnExtractor({
    anthropicClient: racingClient,
    stateStore: store,
    project_slug: SLUG,
    onComplete: () => {
      completed = true
    },
  })
  const state = await extractor.runOnce({
    user_id: USER,
    agent_text: 'Anything outside work?',
    user_text: 'I climb',
    observed_at: 1000,
  })
  // The fresh re-read must preserve `import_running` (no downgrade) and defer
  // completion — even though all 5 fields are now present.
  expect(state!.phase).toBe('import_running')
  expect(auditRequiredFields(state!.phase_state).next_to_collect).toBeNull()
  expect(completed).toBe(false)
})

test('a terse no-op turn AFTER an import is consumed still finalizes (no stall)', async () => {
  const store = new InMemoryOnboardingStateStore()
  // Post-consume state: all 5 fields present (incl. the import-merged projects),
  // import_result stamped, phase back at the interview marker, import terminal.
  await store.upsert({
    project_slug: SLUG,
    user_id: USER,
    phase: 'work_interview_gap_fill',
    phase_state_patch: {
      user_first_name: 'Sam',
      agent_name: 'Atlas',
      agent_personality: 'warm and direct',
      primary_projects: ['Topline', 'Acme', 'tabs'],
      non_work_interests: ['climbing'],
      import_result: { user_model: { projects: [] } },
    },
    advanced_at: 500,
  })
  let completed = false
  const extractor = buildPostTurnExtractor({
    anthropicClient: stubClient(['{}']), // terse turn → empty patch
    stateStore: store,
    project_slug: SLUG,
    hasInFlightImport: async () => false, // import already terminal
    onComplete: () => {
      completed = true
    },
  })
  const state = await extractor.runOnce({
    user_id: USER,
    agent_text: 'I pulled 4 projects from your history — all set?',
    user_text: 'looks good, thanks',
    observed_at: 1000,
  })
  // Empty patch wrote nothing, but completion still fires off the present fields.
  expect(auditRequiredFields(state!.phase_state).next_to_collect).toBeNull()
  expect(completed).toBe(true)
})

test('extractor swallows LLM failure (never throws) — fire-and-forget safety', async () => {
  const store = new InMemoryOnboardingStateStore()
  const throwingClient: AnthropicMessagesClient = {
    messages: { create: async () => { throw new Error('boom') } },
  }
  const extractor = buildPostTurnExtractor({
    anthropicClient: throwingClient,
    stateStore: store,
    project_slug: SLUG,
  })
  // The LLM throwing must NOT reject the call (fire-and-forget). Nothing is
  // extracted this turn, and no onboarding_state row is created from an empty
  // extraction — but the call resolves cleanly.
  await expect(
    extractor.runOnce({
      user_id: USER,
      agent_text: 'What should I call you?',
      user_text: 'Atlas, please',
      observed_at: 1,
    }),
  ).resolves.toBeNull()
})
