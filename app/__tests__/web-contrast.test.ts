/**
 * THE WEB CHAT'S TEXT HAS TO BE READABLE ON EVERY GROUND IT IS DRAWN ON.
 *
 * WHY: the owner, 2026-08-11, on document names and paths rendering dim grey —
 * "This is NOT USABLE." It was not a matter of taste. Measured against WCAG AA
 * (4.5:1 for body text) the shipped values were:
 *
 *     web dark   --faint  #5f646e on --bg           3.27
 *     web dark   --faint  #5f646e on --surface      2.99
 *     web dark   --faint  #5f646e on --agent-bubble 2.75
 *     web light  --faint  #aeb2ba                   2.13
 *
 * So the dimmest token was failing on every background, and worst in light mode
 * at less than half the required ratio.
 *
 * The values are PARSED OUT of `landing/chat-react.html`'s two `:root` blocks
 * rather than restated here, so this cannot drift from what actually ships. A
 * token renamed or deleted fails loudly instead of silently passing.
 *
 * Scoped to the WEB stylesheet on purpose: the mobile palette has its own
 * light/dark work and its own contrast gate, and coupling the two would mean
 * neither could land without the other.
 */

import { describe, expect, test } from 'bun:test'

import { contrastRatio, parseWebThemes, type ColorSurface } from './support/contrast.ts'

/** WCAG AA for normal-size body text. */
const AA = 4.5
/** WCAG AA for large text (>=18.66px bold or >=24px) — used for muted labels. */
const AA_LARGE = 3.0

const themes = parseWebThemes()

/** Backgrounds a text token can legitimately be drawn on, per theme. */
const GROUNDS = ['bg', 'surface', 'agent-bubble'] as const

/** Text tokens that carry READABLE CONTENT and therefore owe full AA. */
const BODY_TEXT = ['fg', 'muted', 'fg-2', 'faint'] as const

function need(surface: ColorSurface, token: string, theme: string): string {
  const v = surface[token]
  // A missing token is a FAILURE, not a skip: silently skipping is how a renamed
  // variable turns a contrast gate into a no-op.
  expect(v, `${theme} ${token} is missing from chat-react.html`).toBeDefined()
  return v as string
}

for (const [themeName, surface] of Object.entries(themes)) {
  describe(`web ${themeName}: body text clears AA on every ground`, () => {
    for (const token of BODY_TEXT) {
      for (const ground of GROUNDS) {
        test(`${token} on ${ground}`, () => {
          const fg = need(surface, token, themeName)
          const bg = need(surface, ground, themeName)
          const ratio = contrastRatio(fg, bg)
          expect(
            ratio,
            `web ${themeName} ${token} ${fg} on ${ground} ${bg} = ${ratio.toFixed(2)}, below AA ${AA}`,
          ).toBeGreaterThanOrEqual(AA)
        })
      }
    }
  })
}

describe('both web themes exist and are distinct', () => {
  test('a light AND a dark :root block are present', () => {
    // Light mode is the thing the owner asked for by name; if the light block
    // vanished, every test above would still pass by only checking dark.
    expect(Object.keys(themes).sort()).toEqual(['dark', 'light'])
  })

  test('the two themes actually differ in their backgrounds', () => {
    // A light theme that copied the dark background would pass contrast while
    // being no light theme at all.
    expect(themes.light['bg']).not.toBe(themes.dark['bg'])
  })

  test('light mode really is lighter than dark mode', () => {
    // Direction matters: a "light" palette darker than the dark one would satisfy
    // "distinct" while being obviously wrong.
    const lightBg = need(themes.light, 'bg', 'light')
    const darkBg = need(themes.dark, 'bg', 'dark')
    // Contrast against black is a proxy for luminance and needs no extra import.
    expect(contrastRatio(lightBg, '#000000')).toBeGreaterThan(
      contrastRatio(darkBg, '#000000'),
    )
  })
})

describe('the dimmest token is no longer the unreadable one', () => {
  test('--faint is not the pre-fix #5f646e / #aeb2ba', () => {
    // Pins the specific regression the owner reported, by value. If someone
    // reinstates either shipped colour this fails by name rather than by ratio.
    expect(themes.dark['faint']?.toLowerCase()).not.toBe('#5f646e')
    expect(themes.light['faint']?.toLowerCase()).not.toBe('#aeb2ba')
  })

  test('--faint still reads as SUBDUED — dimmer than fg on the same ground', () => {
    // The fix must not be "make everything full white": the token exists to be
    // quieter. AA is the floor, not the target.
    for (const [themeName, surface] of Object.entries(themes)) {
      const bg = need(surface, 'bg', themeName)
      const faint = contrastRatio(need(surface, 'faint', themeName), bg)
      const text = contrastRatio(need(surface, 'fg', themeName), bg)
      expect(faint, `web ${themeName}: --faint should be dimmer than fg`).toBeLessThan(text)
      expect(faint).toBeGreaterThanOrEqual(AA_LARGE)
    }
  })
})
