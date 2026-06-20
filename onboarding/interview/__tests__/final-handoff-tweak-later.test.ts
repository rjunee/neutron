/**
 * Tests — post-completion handoff "tweak later" promise + once-per-instance
 * idempotency (sprint 2026-06-03 onboarding-buttons-only-tweak-later § 5).
 *
 * The brief asks for a first post-onboarding General-topic message that
 * lists the projects, invites tweaks (rename / delete / merge), and points
 * at the per-project pre-loaded context. The existing 2026-05-28
 * final-handoff already fires in the General topic at `wow_fired →
 * completed` and lists projects, so this sprint folds the tweak-later
 * promise into that existing `initial` handoff (rather than emitting a
 * redundant second General-topic message) and adds the once-per-instance
 * `onboarding_handoff_emitted_at` idempotency gate.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  buildFinalHandoffEngine,
  makeDispatchRecorder,
  setupFinalHandoffTest,
  walkToCompleted,
  type FinalHandoffTestSetup,
} from './final-handoff-test-helpers.ts'

let setup: FinalHandoffTestSetup

beforeEach(() => {
  setup = setupFinalHandoffTest()
})

afterEach(() => {
  setup.cleanup()
})

describe('handoff content — tweak-later promise', () => {
  test('body invites rename/delete/merge + points at per-project context', async () => {
    const rec = makeDispatchRecorder()
    const engine = buildFinalHandoffEngine({ setup, wowDispatcher: rec.hook })
    const { prompt } = await walkToCompleted({
      setup,
      engine,
      project_slug: 'casey',
      user_id: 'u-1',
      topic_id: 'web:u-1',
      channel_kind: 'app-socket',
      seed_phase_state: {
        user_first_name: 'Sam',
        primary_projects_confirmed: ['Topline', 'Northwind Labs', 'Acme'],
      },
    })
    const body = prompt.body.toLowerCase()
    // Items 7 + 9 (2026-06-19) — the short close no longer RE-LISTS the
    // projects (the wow guide already did), but still points at the
    // per-project context and keeps the tweak-later invite.
    expect(prompt.body).not.toContain('Topline')
    // Invites tweaks — rename + drop/delete + merge verbs all present.
    expect(body).toContain('rename')
    expect(body).toContain('merge')
    expect(body.includes('delete') || body.includes('drop')).toBe(true)
    // Points at the pre-loaded per-project context ("each is already
    // loaded with what I learned about it during setup").
    expect(body).toContain('loaded')
    expect(body).toContain('learned')
    // "just ask" framing for changing how the agent works.
    expect(body).toContain('just ask')
  })

  test('no-projects variant still carries the "change how I work" invite', async () => {
    const rec = makeDispatchRecorder()
    const engine = buildFinalHandoffEngine({ setup, wowDispatcher: rec.hook })
    const { prompt } = await walkToCompleted({
      setup,
      engine,
      project_slug: 'casey',
      user_id: 'u-1',
      topic_id: 'web:u-1',
      channel_kind: 'app-socket',
      seed_phase_state: {
        user_first_name: 'Sam',
        primary_projects_confirmed: [],
      },
    })
    expect(prompt.body.toLowerCase()).toContain('just ask')
  })
})

describe('handoff idempotency — fires once per instance', () => {
  test('onboarding_handoff_emitted_at is stamped on completion', async () => {
    const rec = makeDispatchRecorder()
    const engine = buildFinalHandoffEngine({ setup, wowDispatcher: rec.hook })
    await walkToCompleted({
      setup,
      engine,
      project_slug: 'casey',
      user_id: 'u-1',
      topic_id: 'web:u-1',
      channel_kind: 'app-socket',
    })
    const s = await setup.stateStore.get('casey', 'u-1')
    expect(s).not.toBeNull()
    expect(s!.phase).toBe('completed')
    expect(typeof s!.onboarding_handoff_emitted_at).toBe('number')
    expect(s!.onboarding_handoff_emitted_at).toBeGreaterThan(0)
  })

  test('a second completion re-entry does NOT emit a second initial handoff', async () => {
    const rec = makeDispatchRecorder()
    const engine = buildFinalHandoffEngine({ setup, wowDispatcher: rec.hook })
    const countInitial = (): number =>
      setup.sentPrompts.filter(
        (p) => p.prompt.metadata?.['final_handoff_shape'] === 'initial',
      ).length

    // First completion → exactly one initial handoff, field stamped.
    await walkToCompleted({
      setup,
      engine,
      project_slug: 'casey',
      user_id: 'u-1',
      topic_id: 'web:u-1',
      channel_kind: 'app-socket',
    })
    expect(countInitial()).toBe(1)
    const stampedAt = (await setup.stateStore.get('casey', 'u-1'))!
      .onboarding_handoff_emitted_at
    expect(typeof stampedAt).toBe('number')

    // Re-seed back to max_oauth_offered (upsert PRESERVES the stamped
    // field — it isn't passed), then re-walk to completion. The gate must
    // suppress a second initial handoff.
    await walkToCompleted({
      setup,
      engine,
      project_slug: 'casey',
      user_id: 'u-1',
      topic_id: 'web:u-1',
      channel_kind: 'app-socket',
    })
    expect(countInitial()).toBe(1)
    // The marker survived the second pass unchanged.
    const after = await setup.stateStore.get('casey', 'u-1')
    expect(after!.onboarding_handoff_emitted_at).toBe(stampedAt)
  })
})
