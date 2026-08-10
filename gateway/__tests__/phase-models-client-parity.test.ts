/**
 * WEB AND MOBILE MUST AGREE ABOUT THE OWNER'S BUILD SETTINGS.
 *
 * `effectiveRow` and `applyRowEdit` exist twice — `app/lib/phase-models-client.ts`
 * and `landing/chat-react/phase-models-client.ts` — because each client bundle is
 * deliberately free of the other's workspace. That duplication is correct, and it is
 * also the risk: **these two functions encode product decisions, not transport.**
 *
 * A divergence is the failure nobody reports. Each surface stays self-consistent, so
 * neither looks broken; the owner simply gets a different answer about their own
 * settings depending on which device they opened — and the one that matters most is
 * "does choosing the default clear the override or pin it", where the two answers
 * differ only in what happens *months later* when a default changes.
 *
 * SO THE COPIES ARE EXECUTED SIDE BY SIDE over the same inputs.
 *
 * WHY THIS FILE LIVES IN `gateway/__tests__`. `landing` does not declare
 * `@neutronai/app` as a dependency and must not start — that independence is the
 * whole reason the helpers are duplicated in the first place. `gateway` is the one
 * package that declares BOTH, which is the same home and the same reasoning as the
 * existing `runtime/__tests__/doc-links-parity.test.ts` mirror check.
 */

import { describe, expect, test } from 'bun:test'

import * as mobile from '@neutronai/app/lib/phase-models-client'
import * as web from '@neutronai/landing/chat-react/phase-models-client.ts'

/** A phase whose two defaults differ, so a rule that confuses them is visible. */
const BUILD = {
  key: 'build',
  label: 'Build',
  description: 'Writes the code and the tests.',
  default: { model: 'opus', effort: 'high' },
}

/**
 * Every shape an edit can take, including the ones with no obviously right answer.
 * A case list is the point: a single happy-path comparison would agree on both
 * copies of a rule that is wrong in the same way.
 */
const EDITS: Array<{
  name: string
  overrides: Record<string, { model?: string; effort?: string }>
  patch: { model?: string; effort?: string }
}> = [
  { name: 'set an effort from clean', overrides: {}, patch: { effort: 'xhigh' } },
  { name: 'set a model from clean', overrides: {}, patch: { model: 'sonnet' } },
  {
    name: 'choose the DEFAULT model — must clear, not pin',
    overrides: { build: { model: 'sonnet' } },
    patch: { model: 'opus' },
  },
  {
    name: 'choose the DEFAULT effort — must clear, not pin',
    overrides: { build: { effort: 'max' } },
    patch: { effort: 'high' },
  },
  {
    name: 'clear one half of two, keeping the other',
    overrides: { build: { model: 'sonnet', effort: 'max' } },
    patch: { model: 'opus' },
  },
  {
    name: 'clear BOTH halves in sequence leaves no entry',
    overrides: { build: { effort: 'high' } },
    patch: { effort: 'high' },
  },
  {
    name: 'switch a model that is already overridden',
    overrides: { build: { model: 'sonnet' } },
    patch: { model: 'fast' },
  },
  {
    name: 'no-op re-pick of the current override',
    overrides: { build: { effort: 'low' } },
    patch: { effort: 'low' },
  },
  {
    name: 'another phase is left alone',
    overrides: { synthesis: { model: 'opus' } },
    patch: { effort: 'low' },
  },
  {
    name: 'set both fields at once',
    overrides: {},
    patch: { model: 'fast', effort: 'low' },
  },
]

const DISPLAY: Array<Record<string, { model?: string; effort?: string }>> = [
  {},
  { build: { model: 'sonnet' } },
  { build: { effort: 'max' } },
  { build: { model: 'fast', effort: 'low' } },
  { build: {} },
  { build: { model: '' } },
  { synthesis: { model: 'opus' } },
]

describe('applyRowEdit — the phone and the browser make the same edit', () => {
  for (const c of EDITS) {
    test(c.name, () => {
      const fromWeb = web.applyRowEdit(c.overrides, BUILD, c.patch)
      const fromMobile = mobile.applyRowEdit(c.overrides, BUILD, c.patch)
      expect(fromWeb).toEqual(fromMobile)
    })
  }

  test('neither MUTATES the input it was given', () => {
    // A copy that mutated in place would still "agree" on the returned value while
    // corrupting the caller's state — an agreement test that missed the real
    // divergence. Asserted on both.
    const original = { build: { model: 'sonnet' } }
    const snapshot = JSON.stringify(original)
    web.applyRowEdit(original, BUILD, { model: 'opus' })
    expect(JSON.stringify(original)).toBe(snapshot)
    mobile.applyRowEdit(original, BUILD, { model: 'opus' })
    expect(JSON.stringify(original)).toBe(snapshot)
  })
})

describe('effectiveRow — the phone and the browser show the same row', () => {
  for (const over of DISPLAY) {
    test(JSON.stringify(over), () => {
      expect(web.effectiveRow(BUILD, over)).toEqual(mobile.effectiveRow(BUILD, over))
    })
  }
})

describe('the agreement is real, not vacuous', () => {
  test('the helpers actually do something — a positive control', () => {
    // WITHOUT THIS, two functions that both returned their input unchanged would
    // pass every comparison above. The suite must be able to fail.
    expect(web.applyRowEdit({}, BUILD, { effort: 'xhigh' })).toEqual({
      build: { effort: 'xhigh' },
    })
    expect(web.effectiveRow(BUILD, {}).model).toBe('opus')
    expect(web.effectiveRow(BUILD, { build: { model: 'fast' } }).overridden).toBe(true)
  })

  test('both copies are the SAME shape of function, not one wrapping the other', () => {
    expect(web.applyRowEdit.length).toBe(mobile.applyRowEdit.length)
    expect(web.effectiveRow.length).toBe(mobile.effectiveRow.length)
  })
})
