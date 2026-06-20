/**
 * @neutronai/onboarding/interview — buildSlugChosenPromptSpec unit tests.
 *
 * 2026-05-09 chat-UX (Issue 2): the slug-picker phase emits ONE
 * click-button — `Use "<suggested>"`. The freeform composer is the
 * affordance for "Type a different one" (button removed: redundant
 * with the textbox). The `Skip for now` escape-ramp moves off this
 * phase to a global menu — escape-ramps cluttered the happy-path
 * button row.
 *
 * Engine routing for `type-different` / `skip-slug` is preserved (see
 * `engine.ts:consumeSlugChosenChoice`) so a global menu / Telegram /
 * existing tests can still emit those choice values without rendering
 * them as buttons here.
 */

import { describe, expect, test } from 'bun:test'
import { buildSlugChosenPromptSpec } from '../phase-prompts.ts'

describe('buildSlugChosenPromptSpec — slug_picker_configured + suggested_slug', () => {
  test('emits ONE click-button with body "Use <suggested>" and value "use-suggested"', () => {
    const spec = buildSlugChosenPromptSpec({
      slug_picker_configured: true,
      suggested_slug: 'nova',
      rejection_reason: null,
    })
    expect(spec.options.length).toBe(1)
    expect(spec.options[0]?.value).toBe('use-suggested')
    expect(spec.options[0]?.body).toBe('Use nova')
    expect(spec.allow_freeform).toBe(true)
  })

  test('does NOT emit type-different or skip-slug as buttons', () => {
    const spec = buildSlugChosenPromptSpec({
      slug_picker_configured: true,
      suggested_slug: 'nova',
      rejection_reason: null,
    })
    expect(spec.options.find((o) => o.value === 'type-different')).toBeUndefined()
    expect(spec.options.find((o) => o.value === 'skip-slug')).toBeUndefined()
  })

  test('body bakes the suggested slug into the default example', () => {
    const spec = buildSlugChosenPromptSpec({
      slug_picker_configured: true,
      suggested_slug: 'nova',
      rejection_reason: null,
    })
    expect(spec.body).toContain('Default: nova')
    expect(spec.body).toContain('"nova"')
  })

  test('rejection reason is prepended to the body when set', () => {
    const spec = buildSlugChosenPromptSpec({
      slug_picker_configured: true,
      suggested_slug: 'nova',
      rejection_reason: 'That slug is taken.',
    })
    expect(spec.body.startsWith('That slug is taken.\n\n')).toBe(true)
  })
})

describe('buildSlugChosenPromptSpec — slug_picker_configured + null suggested_slug', () => {
  test('emits ZERO buttons (freeform-only) — the composer is the affordance', () => {
    const spec = buildSlugChosenPromptSpec({
      slug_picker_configured: true,
      suggested_slug: null,
      rejection_reason: null,
    })
    expect(spec.options.length).toBe(0)
    expect(spec.allow_freeform).toBe(true)
  })

  test('body asks the user to type a short name', () => {
    const spec = buildSlugChosenPromptSpec({
      slug_picker_configured: true,
      suggested_slug: null,
      rejection_reason: null,
    })
    expect(spec.body).toContain('Type a short name')
  })
})

describe('buildSlugChosenPromptSpec — !slug_picker_configured (composer drift / dev mode)', () => {
  test('emits a single Skip button when the picker is not configured', () => {
    const spec = buildSlugChosenPromptSpec({
      slug_picker_configured: false,
      suggested_slug: null,
      rejection_reason: null,
    })
    expect(spec.options.length).toBe(1)
    expect(spec.options[0]?.value).toBe('skip-slug')
    expect(spec.options[0]?.body).toBe('Skip for now')
    expect(spec.allow_freeform).toBe(false)
  })

  test('still emits Skip even when a suggested_slug is present', () => {
    const spec = buildSlugChosenPromptSpec({
      slug_picker_configured: false,
      suggested_slug: 'nova',
      rejection_reason: null,
    })
    expect(spec.options.length).toBe(1)
    expect(spec.options[0]?.value).toBe('skip-slug')
    // Body should still surface the suggested name so the user knows what
    // they'd land on once the picker is wired.
    expect(spec.body).toContain('Default: nova')
  })
})

describe('buildSlugChosenPromptSpec — phase + default route are stable', () => {
  test('phase is "slug_chosen" and default route is "projects_proposed"', () => {
    // 2026-05-13: slug pick moved to AFTER persona_reviewed. The post-
    // slug target inherited persona_reviewed's previous default
    // (projects_proposed).
    const spec = buildSlugChosenPromptSpec({
      slug_picker_configured: true,
      suggested_slug: 'nova',
      rejection_reason: null,
    })
    expect(spec.phase).toBe('slug_chosen')
    expect(spec.next_phase_on_default).toBe('projects_proposed')
  })
})
