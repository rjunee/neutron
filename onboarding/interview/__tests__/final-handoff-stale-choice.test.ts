/**
 * 2026-05-28 final-handoff sprint — Argus r1/r2/r3 fix-pass.
 *
 * Regression test for three Codex cross-model catches:
 *
 *  - r1 P2 (rejected "dead code" branch): the earlier refactor
 *    collapsed an explicit `else if (...SKIP_CHOICE) { ... } else {
 *    return noop_terminal }` chain into a bare `else` that defaulted
 *    to the SKIP follow-up. `buttonStore.resolve()` (channels/
 *    button-store.ts:467-480) does NO option-membership check against
 *    the prompt's options list, and `chat-bridge.ts` forwards the
 *    client-supplied `choice_value` verbatim. A stale or malformed
 *    tap that still hits a live `prompt_id` therefore lands in
 *    `consumeFinalHandoffChoice` with a value that is not one of the
 *    four `FINAL_HANDOFF_*` constants, and would get mis-routed to
 *    the SKIP follow-up.
 *
 *  - r2 P0 (resolve-slot-burned): the r1 membership guard ran AFTER
 *    `buttonStore.resolve()`, so a malformed tap stamped
 *    `resolved_at` + `resolution_value='totally_made_up_value'` on
 *    the prompt row even though the dispatch correctly returned
 *    `noop_terminal`. A subsequent legitimate Mobile/Telegram/Skip
 *    retap on the same `prompt_id` returned `was_new=false` from
 *    `resolve()` and silently noop'd — locking the user out for the
 *    rest of the prompt TTL. The fix moves the membership guard
 *    BEFORE the `resolve()` round-trip so the prompt row stays
 *    `resolved_at IS NULL` and a legitimate retap walks the
 *    mint+emit cycle as intended.
 *
 *  - r3 P0 (__freeform__-without-payload lockout): admitting
 *    `__freeform__` into the membership set lets a malicious/buggy
 *    app-socket client send `{type:'button_choice', prompt_id:
 *    <live>, choice_value:'__freeform__'}` with NO `freeform_text`.
 *    `gateway/http/chat-bridge.ts:1131-1138` forwards verbatim. The
 *    r2 membership guard admits it, `resolve()` stamps `resolved_at`,
 *    `consumeFinalHandoffChoice` falls through the unknown-value
 *    `else` to `noop_terminal`, and a subsequent legitimate
 *    Mobile/Telegram/Skip retap returns `was_new=false` → silent
 *    noop. Same lockout shape as r2. Fix: reject `__freeform__`
 *    without a `freeform_text` payload BEFORE `resolve()`.
 *
 * Spec: malformed/stale taps on a live final-handoff prompt must be
 * dropped silently (no follow-up emit, phase stays at `completed`,
 * `active_prompt_id` stays pointed at the original handoff). A
 * legitimate retap on the same prompt MUST still resolve normally
 * and emit the matching follow-up.
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
import { FINAL_HANDOFF_MOBILE_APP_CHOICE } from '../final-handoff-prompts.ts'

let setup: FinalHandoffTestSetup

beforeEach(() => {
  setup = setupFinalHandoffTest()
})

afterEach(() => {
  setup.cleanup()
})

describe('final-handoff stale/malformed choice_value', () => {
  test('drops malformed tap to noop_terminal and does NOT consume the resolve slot', async () => {
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
    const before_tap = setup.sentPrompts.length
    // ── Phase 1: malformed tap ──────────────────────────────────────
    // A value that is NOT in the spec'd 5 (mobile-app/telegram-bind/
    // skip/done + __freeform__). The engine must reject it BEFORE the
    // `buttonStore.resolve()` round-trip so the prompt row stays
    // unresolved and a follow-up legitimate tap can still consume it.
    await tapHandoffChoice({
      setup,
      engine,
      project_slug: 'casey',
      user_id: 'u-1',
      topic_id: 'web:u-1',
      channel_kind: 'app-socket',
      prompt_id: handoff.prompt_id,
      choice_value: 'totally_made_up_value',
      observed_at: 1_700_000_010_000,
    })
    expect(setup.sentPrompts.length).toBe(before_tap)
    const after_malformed = await setup.stateStore.get('casey', 'u-1')
    expect(after_malformed!.phase).toBe('completed')
    expect(after_malformed!.phase_state['active_prompt_id']).toBe(handoff.prompt_id)
    expect(after_malformed!.phase_state['final_handoff_active']).toBe(true)
    // CRITICAL r2 assertion: the prompt row must still be unresolved.
    // If the membership guard ran AFTER `resolve()`, this row's
    // `resolved_at` would already be stamped and the legitimate retap
    // below would silently noop.
    const row_after_malformed = await setup.buttonStore.peek(handoff.prompt_id)
    expect(row_after_malformed).not.toBeNull()
    expect(row_after_malformed!.resolved_at).toBeNull()
    expect(row_after_malformed!.resolution_value).toBeNull()

    // ── Phase 2: legitimate retap on a fresh option ────────────────
    // Same prompt_id, but now with a valid choice. Should walk the
    // mint+emit cycle exactly as if the malformed tap never happened.
    await tapHandoffChoice({
      setup,
      engine,
      project_slug: 'casey',
      user_id: 'u-1',
      topic_id: 'web:u-1',
      channel_kind: 'app-socket',
      prompt_id: handoff.prompt_id,
      choice_value: FINAL_HANDOFF_MOBILE_APP_CHOICE,
      observed_at: 1_700_000_020_000,
    })
    // The mobile-app follow-up prompt was emitted.
    expect(setup.sentPrompts.length).toBe(before_tap + 1)
    // Original handoff prompt is now resolved by the LEGITIMATE tap
    // (not the malformed one) — `resolution_value` reflects the
    // mobile-app choice, not `totally_made_up_value`.
    const row_after_legit = await setup.buttonStore.peek(handoff.prompt_id)
    expect(row_after_legit).not.toBeNull()
    expect(row_after_legit!.resolved_at).toBe(1_700_000_020_000)
    expect(row_after_legit!.resolution_value).toBe(FINAL_HANDOFF_MOBILE_APP_CHOICE)
    // Phase still completed, but active_prompt_id has rotated to the
    // follow-up shape's prompt_id.
    const after_legit = await setup.stateStore.get('casey', 'u-1')
    expect(after_legit!.phase).toBe('completed')
    expect(after_legit!.phase_state['final_handoff_active']).toBe(true)
    expect(after_legit!.phase_state['active_prompt_id']).not.toBe(handoff.prompt_id)
  })

  test('drops __freeform__ tap with no payload to noop_terminal and does NOT consume the resolve slot', async () => {
    const rec = makeDispatchRecorder()
    const engine = buildFinalHandoffEngine({ setup, wowDispatcher: rec.hook })
    const { prompt: handoff } = await walkToCompleted({
      setup,
      engine,
      project_slug: 'casey',
      user_id: 'u-2',
      topic_id: 'web:u-2',
      channel_kind: 'app-socket',
    })
    const before_tap = setup.sentPrompts.length
    // ── Phase 1: malicious/buggy __freeform__ tap with NO payload ──
    // chat-bridge.ts forwards the client-supplied choice_value verbatim
    // (gateway/http/chat-bridge.ts:1131-1138). An app-socket client can
    // therefore send `choice_value: '__freeform__'` without a
    // `freeform_text` body. The engine must reject this BEFORE the
    // `buttonStore.resolve()` round-trip so the prompt row stays
    // unresolved and a follow-up legitimate tap can still consume it.
    await tapHandoffChoice({
      setup,
      engine,
      project_slug: 'casey',
      user_id: 'u-2',
      topic_id: 'web:u-2',
      channel_kind: 'app-socket',
      prompt_id: handoff.prompt_id,
      choice_value: '__freeform__',
      observed_at: 1_700_000_010_000,
    })
    expect(setup.sentPrompts.length).toBe(before_tap)
    const after_freeform_noop = await setup.stateStore.get('casey', 'u-2')
    expect(after_freeform_noop!.phase).toBe('completed')
    expect(after_freeform_noop!.phase_state['active_prompt_id']).toBe(handoff.prompt_id)
    expect(after_freeform_noop!.phase_state['final_handoff_active']).toBe(true)
    // CRITICAL r3 assertion: the prompt row must still be unresolved.
    // If `__freeform__` were admitted without a payload, this row's
    // `resolved_at` would already be stamped and the legitimate retap
    // below would silently noop.
    const row_after_freeform = await setup.buttonStore.peek(handoff.prompt_id)
    expect(row_after_freeform).not.toBeNull()
    expect(row_after_freeform!.resolved_at).toBeNull()
    expect(row_after_freeform!.resolution_value).toBeNull()

    // ── Phase 2: legitimate retap on a real button ────────────────
    // Same prompt_id, but now with a valid Mobile-App choice. Should
    // walk the mint+emit cycle exactly as if the malformed tap never
    // happened.
    await tapHandoffChoice({
      setup,
      engine,
      project_slug: 'casey',
      user_id: 'u-2',
      topic_id: 'web:u-2',
      channel_kind: 'app-socket',
      prompt_id: handoff.prompt_id,
      choice_value: FINAL_HANDOFF_MOBILE_APP_CHOICE,
      observed_at: 1_700_000_020_000,
    })
    // The mobile-app follow-up prompt was emitted.
    expect(setup.sentPrompts.length).toBe(before_tap + 1)
    // Original handoff prompt is now resolved by the LEGITIMATE tap
    // (not the empty `__freeform__`) — `resolution_value` reflects the
    // mobile-app choice.
    const row_after_legit = await setup.buttonStore.peek(handoff.prompt_id)
    expect(row_after_legit).not.toBeNull()
    expect(row_after_legit!.resolved_at).toBe(1_700_000_020_000)
    expect(row_after_legit!.resolution_value).toBe(FINAL_HANDOFF_MOBILE_APP_CHOICE)
    const after_legit = await setup.stateStore.get('casey', 'u-2')
    expect(after_legit!.phase).toBe('completed')
    expect(after_legit!.phase_state['final_handoff_active']).toBe(true)
    expect(after_legit!.phase_state['active_prompt_id']).not.toBe(handoff.prompt_id)
  })
})
