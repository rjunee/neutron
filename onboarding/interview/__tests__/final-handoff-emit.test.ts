/**
 * 2026-05-28 final-handoff sprint — Test 1.
 *
 * Spec: on `wow_fired → completed` over the web (`app-socket`) channel,
 * the General topic gets a final-handoff prompt with 3 buttons +
 * freeform. The body mentions every confirmed project name, references
 * the sidebar pointer, and offers the mobile-app + Telegram-bot CTAs.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  buildFinalHandoffEngine,
  makeDispatchRecorder,
  setupFinalHandoffTest,
  walkToCompleted,
  type FinalHandoffTestSetup,
} from './final-handoff-test-helpers.ts'
import {
  FINAL_HANDOFF_METADATA_TAG,
  FINAL_HANDOFF_MOBILE_APP_CHOICE,
  FINAL_HANDOFF_SKIP_CHOICE,
  FINAL_HANDOFF_TELEGRAM_BIND_CHOICE,
} from '../final-handoff-prompts.ts'

let setup: FinalHandoffTestSetup

beforeEach(() => {
  setup = setupFinalHandoffTest()
})

afterEach(() => {
  setup.cleanup()
})

describe('final-handoff emit (web channel)', () => {
  test('emits short close: single mobile-app button + freeform, LEFT pointer, no project re-list', async () => {
    // Items 7 + 9 (2026-06-19 owner live-dogfood, `final-handoff-prompts.ts`)
    // — the terminal General message no longer RE-LISTS every project
    // (the wow guide already walked them) and no longer offers the
    // not-yet-built "Connect a Telegram bot" CTA or a "Skip for now"
    // dead-end. It is a SHORT close: point the user LEFT, keep the
    // tweak-later invite, and end with an actionable prompt. The mobile-app
    // affordance is the ONLY remaining button on the web channel.
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
        primary_projects_confirmed: [
          'Topline',
          'Northwind Labs',
          'Acme',
          'Acme Holdco',
          'n8n Automation',
          'Home Assistant',
          'LA Property',
        ],
      },
    })
    // The handoff metadata tag is set so the engine's
    // `handleFinalHandoffOnCompleted` recognises a button tap as ours.
    expect(prompt.metadata?.[FINAL_HANDOFF_METADATA_TAG]).toBe(true)
    expect(prompt.metadata?.['final_handoff_shape']).toBe('initial')
    // Single mobile-app button + freeform allowed (Telegram + Skip dropped).
    expect(prompt.options.length).toBe(1)
    expect(prompt.allow_freeform).toBe(true)
    const values = prompt.options.map((o) => o.value)
    expect(values).toContain(FINAL_HANDOFF_MOBILE_APP_CHOICE)
    expect(values).not.toContain(FINAL_HANDOFF_TELEGRAM_BIND_CHOICE)
    expect(values).not.toContain(FINAL_HANDOFF_SKIP_CHOICE)
    // Greeting includes the first name; body points LEFT to the sidebar.
    expect(prompt.body).toContain('Sam')
    expect(prompt.body.toLowerCase()).toContain('left')
    // The SHORT close does NOT re-enumerate the confirmed projects.
    expect(prompt.body).not.toContain('Northwind Labs')
    expect(prompt.body).not.toContain('LA Property')
    // It keeps the actionable invite + the tweak-later promise.
    expect(prompt.body).toContain("What's something I can help you with right now?")
    expect(prompt.body.toLowerCase()).toContain('rename')
    // The sole button is the mobile-app affordance.
    const labels = prompt.options.map((o) => o.body.toLowerCase())
    expect(labels.some((l) => l.includes('mobile'))).toBe(true)
  })

  test('state.phase === completed AND active_prompt_id is the handoff prompt', async () => {
    const rec = makeDispatchRecorder()
    const engine = buildFinalHandoffEngine({ setup, wowDispatcher: rec.hook })
    const { prompt } = await walkToCompleted({
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
    expect(s!.phase_state['active_prompt_id']).toBe(prompt.prompt_id)
    expect(s!.wow_fired).toBe(true)
  })

  test('GAP3 — guide fires as the terminal message on the action-01 BRIEF path (brief_prompt_id present)', async () => {
    // Reproduce-first lock: pre-fix, when the dispatcher reported a
    // `brief_prompt_id` the engine stayed at `wow_fired` and the guide
    // NEVER fired — Sam's 2026-06-09 signup saw only the (now-silenced)
    // shells receipt. This recorder mirrors the live brief path; the fix
    // makes the engine advance to completed and emit the guide regardless.
    const rec = makeDispatchRecorder({
      outcome: {
        fired: ['01-first-week-brief', '03-project-shells', '07-overnight-pass'],
        skipped_no_trigger: [
          '02-lifestyle-reminders',
          '04-overdue-task',
          '05-followup-email-draft',
          '06-interest-check-in',
        ],
        failed: [],
        rescheduled: false,
        brief_prompt_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      },
    })
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
    // The terminal General message is the GUIDE, not the brief affordance.
    expect(prompt.metadata?.[FINAL_HANDOFF_METADATA_TAG]).toBe(true)
    expect(prompt.body.toLowerCase()).toContain('left')
    // The short close points LEFT but does NOT re-list the projects.
    expect(prompt.body).not.toContain('Topline')
    expect(prompt.body).toContain("What's something I can help you with right now?")
    // And the silenced shells-receipt copy is nowhere in the terminal message.
    expect(prompt.body.toLowerCase()).not.toContain('let me know if any of these need changing')
    // Phase reached completed (brief path no longer parks at wow_fired).
    const s = await setup.stateStore.get('casey', 'u-1')
    expect(s!.phase).toBe('completed')
    expect(s!.wow_fired).toBe(true)
  })

  test('renders no-projects fallback when primary_projects_confirmed is empty', async () => {
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
    // No project list in the body — but the General-topic pointer should
    // still be there (sidebar mention) so the user knows where to go.
    expect(prompt.body.toLowerCase()).toContain('general')
    expect(prompt.body).not.toContain('I have spun up 0')
    // Single mobile-app button on the web channel (Telegram + Skip dropped).
    expect(prompt.options.length).toBe(1)
    expect(prompt.options[0]?.value).toBe(FINAL_HANDOFF_MOBILE_APP_CHOICE)
  })
})
