/**
 * Items 7 + 9 (2026-06-19, owner live-dogfood) — final General handoff is a
 * SHORT close, not a duplicative project re-list, and ends with an
 * actionable invite. Telegram-bind + "Skip for now" buttons are removed.
 *
 * Direct unit test of `buildFinalHandoffPromptSpec` (no walk helper — the
 * walk helper has a pre-existing max_oauth_offered baseline failure, ISSUES
 * #79; this asserts the prompt SHAPE the engine emits).
 */

import { describe, expect, test } from 'bun:test'
import {
  buildFinalHandoffPromptSpec,
  FINAL_HANDOFF_MOBILE_APP_CHOICE,
  FINAL_HANDOFF_TELEGRAM_BIND_CHOICE,
  FINAL_HANDOFF_SKIP_CHOICE,
} from '../final-handoff-prompts.ts'

const SEVEN = ['Acme', 'Globex', 'DTC', 'Initech', 'Contoso', 'Hooli', 'Umbrella']

describe('buildFinalHandoffPromptSpec — short close (Items 7 + 9)', () => {
  test('web channel: mobile-app is the only button; no Telegram, no Skip', () => {
    const spec = buildFinalHandoffPromptSpec({
      project_names: SEVEN,
      channel_kind: 'app-socket',
      user_first_name: 'Ryan',
    })
    const values = spec.options.map((o) => o.value)
    expect(values).toEqual([FINAL_HANDOFF_MOBILE_APP_CHOICE])
    expect(values).not.toContain(FINAL_HANDOFF_TELEGRAM_BIND_CHOICE)
    expect(values).not.toContain(FINAL_HANDOFF_SKIP_CHOICE)
    expect(spec.allow_freeform).toBe(true)
  })

  test('does NOT re-enumerate the projects (no duplicative list)', () => {
    const spec = buildFinalHandoffPromptSpec({
      project_names: SEVEN,
      channel_kind: 'app-socket',
      user_first_name: 'Ryan',
    })
    // The body points LEFT but must not re-list every project name (that
    // duplication of wow message #1 is exactly what Item 7 removes).
    expect(spec.body).toContain('on the left')
    const named = SEVEN.filter((n) => spec.body.includes(n))
    expect(named).toEqual([])
  })

  test('ends with the actionable invite (Item 9)', () => {
    const spec = buildFinalHandoffPromptSpec({
      project_names: SEVEN,
      channel_kind: 'app-socket',
      user_first_name: 'Ryan',
    })
    expect(spec.body).toContain("What's something I can help you with right now?")
  })

  test('telegram channel: buttons-free close (user is already mobile)', () => {
    const spec = buildFinalHandoffPromptSpec({
      project_names: SEVEN,
      channel_kind: 'telegram',
      user_first_name: 'Ryan',
    })
    expect(spec.options).toEqual([])
    expect(spec.body).toContain("What's something I can help you with right now?")
  })
})
