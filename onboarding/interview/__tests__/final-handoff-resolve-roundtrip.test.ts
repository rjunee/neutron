/**
 * 2026-05-28 PR #331 fast-follower — IMPORTANT #1 (Argus r1).
 *
 * Spec: button taps on the final-handoff prompt route through
 * `buttonStore.resolve()` for idempotency parity with `consumeChoice`.
 * Pre-fix the engine read `input.choice.choice_value` directly, leaving
 * the prompt row's `resolved_at` NULL and opening a microsecond-window
 * race where two near-simultaneous taps walked the mint+emit cycle
 * twice (the channel-level `buttonStore.emit` idempotency collapsed the
 * wire-side send, but the engine still did redundant work).
 *
 * Three assertions:
 *
 *   1. Tap routes through `buttonStore.resolve()` so the prompt row's
 *      `resolved_at` + `resolution_value` are stamped exactly once.
 *   2. Duplicate taps on the same prompt_id collapse to a single
 *      follow-up emit (the second resolve sees was_new=false and
 *      noop_terminals).
 *   3. Stale prompt_id taps (whose prompt_id != active_prompt_id) are
 *      rejected BEFORE resolve fires, so the stale prompt's row is
 *      untouched.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  buildFinalHandoffEngine,
  makeDispatchRecorder,
  setupFinalHandoffTest,
  tapHandoffChoice,
  walkToCompleted,
  type FinalHandoffTestSetup,
} from './final-handoff-test-helpers.ts'
import {
  FINAL_HANDOFF_MOBILE_APP_CHOICE,
} from '../final-handoff-prompts.ts'

let setup: FinalHandoffTestSetup

beforeEach(() => {
  setup = setupFinalHandoffTest()
})

afterEach(() => {
  setup.cleanup()
})

describe('final-handoff resolve() round-trip (PR #331 fast-follower)', () => {
  test('button tap routes through buttonStore.resolve — prompt row is marked resolved', async () => {
    const rec = makeDispatchRecorder()
    const engine = buildFinalHandoffEngine({ setup, wowDispatcher: rec.hook })
    const { prompt: handoff } = await walkToCompleted({
      setup,
      engine,
      project_slug: 'casey',
      user_id: 'u-1',
      topic_id: 'web:u-1',
      channel_kind: 'app-socket',
    })
    // Sanity: the prompt is in the DB and unresolved before the tap.
    const before = await setup.buttonStore.get(handoff.prompt_id, Date.now())
    expect(before).not.toBeNull()
    expect(before!.prompt_id).toBe(handoff.prompt_id)

    const sentBefore = setup.sentPrompts.length
    await tapHandoffChoice({
      setup,
      engine,
      project_slug: 'casey',
      user_id: 'u-1',
      topic_id: 'web:u-1',
      channel_kind: 'app-socket',
      prompt_id: handoff.prompt_id,
      choice_value: FINAL_HANDOFF_MOBILE_APP_CHOICE,
      observed_at: 1_700_000_010_000,
    })
    // The mobile-app follow-up emitted.
    expect(setup.sentPrompts.length).toBe(sentBefore + 1)

    // The original handoff prompt row is now stamped resolved with the
    // matching `resolution_value`. We probe via a duplicate resolve()
    // call — was_new=false + the persisted choice_value comes back —
    // which is the exact mechanic the engine relies on for idempotency.
    const probe = await setup.buttonStore.resolve({
      choice: {
        prompt_id: handoff.prompt_id,
        choice_value: 'irrelevant-on-duplicate',
        chosen_at: 1_700_000_010_000 + 1_000,
        speaker_user_id: 'u-1',
        channel_kind: 'app-socket',
      },
    })
    expect(probe.was_new).toBe(false)
    expect(probe.choice.choice_value).toBe(FINAL_HANDOFF_MOBILE_APP_CHOICE)
  })

  test('double-tap race protected — second tap noops, only one follow-up emits', async () => {
    const rec = makeDispatchRecorder()
    const engine = buildFinalHandoffEngine({ setup, wowDispatcher: rec.hook })
    const { prompt: handoff } = await walkToCompleted({
      setup,
      engine,
      project_slug: 'casey',
      user_id: 'u-1',
      topic_id: 'web:u-1',
      channel_kind: 'app-socket',
    })
    const sentBefore = setup.sentPrompts.length
    // Fire two taps with the same prompt_id + choice_value at the same
    // observed_at — the classic "client double-tapped before the
    // keyboard re-rendered" pattern.
    await tapHandoffChoice({
      setup,
      engine,
      project_slug: 'casey',
      user_id: 'u-1',
      topic_id: 'web:u-1',
      channel_kind: 'app-socket',
      prompt_id: handoff.prompt_id,
      choice_value: FINAL_HANDOFF_MOBILE_APP_CHOICE,
      observed_at: 1_700_000_010_000,
    })
    await tapHandoffChoice({
      setup,
      engine,
      project_slug: 'casey',
      user_id: 'u-1',
      topic_id: 'web:u-1',
      channel_kind: 'app-socket',
      prompt_id: handoff.prompt_id,
      choice_value: FINAL_HANDOFF_MOBILE_APP_CHOICE,
      observed_at: 1_700_000_010_001,
    })
    // Exactly one follow-up emitted — the duplicate tap noop'd before
    // walking emitFinalHandoffSpec. (Pre-fix the engine walked the
    // mint+emit cycle a second time and only the channel-level
    // buttonStore.emit idempotency-key collapsed the visible re-send;
    // the engine still did redundant work and the prompt row stayed
    // unresolved.)
    expect(setup.sentPrompts.length).toBe(sentBefore + 1)
  })

  test('stale prompt_id taps are rejected BEFORE resolve fires', async () => {
    const rec = makeDispatchRecorder()
    const engine = buildFinalHandoffEngine({ setup, wowDispatcher: rec.hook })
    const { prompt: handoff } = await walkToCompleted({
      setup,
      engine,
      project_slug: 'casey',
      user_id: 'u-1',
      topic_id: 'web:u-1',
      channel_kind: 'app-socket',
    })
    const sentBefore = setup.sentPrompts.length
    // Tap with a prompt_id that doesn't match the active one — could
    // be a stale callback from a prior phase or a maliciously spoofed
    // payload. The handler must noop without touching buttonStore.
    await tapHandoffChoice({
      setup,
      engine,
      project_slug: 'casey',
      user_id: 'u-1',
      topic_id: 'web:u-1',
      channel_kind: 'app-socket',
      prompt_id: 'prm_not_active_at_all',
      choice_value: FINAL_HANDOFF_MOBILE_APP_CHOICE,
      observed_at: 1_700_000_010_000,
    })
    // No follow-up emitted.
    expect(setup.sentPrompts.length).toBe(sentBefore)
    // And the actual handoff prompt row is still unresolved — the
    // stale tap never reached buttonStore.resolve.
    const probe = await setup.buttonStore.resolve({
      choice: {
        prompt_id: handoff.prompt_id,
        choice_value: FINAL_HANDOFF_MOBILE_APP_CHOICE,
        chosen_at: 1_700_000_010_500,
        speaker_user_id: 'u-1',
        channel_kind: 'app-socket',
      },
    })
    // was_new=true means we successfully made the FIRST resolution
    // here in the probe — proof the engine never touched the row.
    expect(probe.was_new).toBe(true)
  })
})
