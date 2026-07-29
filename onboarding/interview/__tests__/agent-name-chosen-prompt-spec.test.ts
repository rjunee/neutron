/**
 * v0.1.121 (2026-06-04) — `buildAgentNameChosenPromptSpec` renders the
 * suggested names as tappable buttons (value = bare canonical name) instead
 * of body-text bullets. This unit suite pins the builder contract directly.
 */

import { describe, expect, test } from 'bun:test'
import { buildAgentNameChosenPromptSpec } from '../phase-prompts.ts'
import { VALUE_BYTE_CAP } from '@neutronai/channels/button-primitive.ts'

describe('buildAgentNameChosenPromptSpec', () => {
  test('renders the default suggestions as A/B/C name buttons (value = bare name)', () => {
    const spec = buildAgentNameChosenPromptSpec()
    expect(spec.options.map((o) => o.value)).toEqual(['Sage', 'Vera', 'Orin'])
    expect(spec.options.map((o) => o.label)).toEqual(['A', 'B', 'C'])
    expect(spec.allow_freeform).toBe(true)
    expect(spec.body).toContain('Tap a name that fits')
    // No body-text bullets — the buttons replace them.
    expect(spec.body).not.toContain('- Sage')
  })

  test('strips the "— rationale" tail so the button value is just the name', () => {
    const spec = buildAgentNameChosenPromptSpec({
      name_suggestions: ['Atlas — calm, carries weight', 'Mimir — wise'],
    })
    expect(spec.options.map((o) => o.value)).toEqual(['Atlas', 'Mimir'])
  })

  test('hyphenated names survive (only whitespace-surrounded dashes split)', () => {
    const spec = buildAgentNameChosenPromptSpec({
      name_suggestions: ['Jean-Luc — steady'],
    })
    expect(spec.options[0]?.value).toBe('Jean-Luc')
  })

  test('drops reserved / invalid names as buttons (still typeable)', () => {
    const spec = buildAgentNameChosenPromptSpec({
      name_suggestions: ['Claude', 'X', 'Sage'],
    })
    // 'Claude' reserved, 'X' too short → only 'Sage' is a button.
    expect(spec.options.map((o) => o.value)).toEqual(['Sage'])
    expect(spec.allow_freeform).toBe(true)
  })

  test('Codex r1 — a valid-but-over-cap Unicode name is NOT surfaced as a button', () => {
    // A 13-char CJK name passes the 32-CHARACTER validator but is 39 bytes
    // UTF-8 (> VALUE_BYTE_CAP=37) — surfacing it as a button would make
    // validateButtonPrompt reject the whole prompt.
    const longCjk = '安' .repeat(13)
    expect(longCjk.length).toBeLessThanOrEqual(32)
    expect(Buffer.byteLength(longCjk, 'utf8')).toBeGreaterThan(VALUE_BYTE_CAP)
    const spec = buildAgentNameChosenPromptSpec({
      name_suggestions: [longCjk, 'Sage'],
    })
    expect(spec.options.map((o) => o.value)).toEqual(['Sage'])
    // Every emitted button value fits the callback cap.
    for (const o of spec.options) {
      expect(Buffer.byteLength(o.value, 'utf8')).toBeLessThanOrEqual(
        VALUE_BYTE_CAP,
      )
    }
  })

  test('no valid suggestions → empty options, body invites typing', () => {
    const spec = buildAgentNameChosenPromptSpec({
      name_suggestions: ['Claude', 'GPT'],
    })
    expect(spec.options).toHaveLength(0)
    expect(spec.body).toContain('Type any name you want')
    expect(spec.allow_freeform).toBe(true)
  })
})
