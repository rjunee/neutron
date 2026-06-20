/**
 * 2026-05-28 final-handoff sprint — Test 5.
 *
 * Spec: `[C] Skip for now` tap emits a short "you can always do this
 * later from settings" follow-up + leaves the chat surface quiet. The
 * phase stays at `completed` and no further engine prompts emit.
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
  FINAL_HANDOFF_SKIP_CHOICE,
} from '../final-handoff-prompts.ts'

let setup: FinalHandoffTestSetup

beforeEach(() => {
  setup = setupFinalHandoffTest()
})

afterEach(() => {
  setup.cleanup()
})

describe('final-handoff [C] skip button', () => {
  test('emits the skip-ack follow-up, phase stays completed, no more prompts after', async () => {
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
    await tapHandoffChoice({
      setup,
      engine,
      project_slug: 'casey',
      user_id: 'u-1',
      topic_id: 'web:u-1',
      channel_kind: 'app-socket',
      prompt_id: handoff.prompt_id,
      choice_value: FINAL_HANDOFF_SKIP_CHOICE,
      observed_at: 1_700_000_010_000,
    })
    // One follow-up: the skip-ack body.
    expect(setup.sentPrompts.length).toBe(before_tap + 1)
    const ack = setup.sentPrompts[before_tap]!.prompt
    expect(ack.metadata?.['final_handoff_shape']).toBe('skip')
    // The skip-ack is a zero-option, freeform-allowed agent line — the
    // user can keep chatting but there's nothing to tap.
    expect(ack.options.length).toBe(0)
    expect(ack.allow_freeform).toBe(true)
    expect(ack.body.toLowerCase()).toContain('later')
    // Phase is still completed.
    const s = await setup.stateStore.get('casey', 'u-1')
    expect(s!.phase).toBe('completed')
    expect(s!.phase_state['active_prompt_id']).toBe(ack.prompt_id)
    // A follow-up freeform reply on the skip-ack does NOT emit a new
    // engine prompt (the engine treats `completed` + freeform as a no-op
    // once the handoff is resolved to skip).
    const before_idle = setup.sentPrompts.length
    await engine.advance({
      project_slug: 'casey',
      topic_id: 'web:u-1',
      user_id: 'u-1',
      channel_kind: 'app-socket',
      freeform_text: 'hi',
      observed_at: 1_700_000_011_000,
    })
    expect(setup.sentPrompts.length).toBe(before_idle)
  })
})
