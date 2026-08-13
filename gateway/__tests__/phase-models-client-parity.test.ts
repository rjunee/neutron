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
  group: 'claude',
  effort_supported: true,
  default: { model: 'opus', effort: 'high' },
}

/** The codex review row: a different executor, and no effort control at all. */
const CODEX = {
  key: 'review_codex',
  label: 'Cross-model review (Codex)',
  description: 'A second opinion from a GPT model.',
  group: 'codex',
  effort_supported: false,
  default: { model: 'sol', effort: 'high' },
}

/** The kimi review row — the one whose only tier this install cannot run. */
const KIMI = {
  key: 'review_kimi',
  label: 'Cross-model review (Kimi)',
  description: 'A second opinion from Kimi K3.',
  group: 'kimi',
  effort_supported: false,
  default: { model: 'k3', effort: 'high' },
}

/**
 * The tier vocabulary as the server sends it, with ONE tier deliberately
 * unavailable — the case where the two clients could most easily disagree about
 * whether to grey an option or drop it.
 */
const TIERS = [
  { tier: 'opus', provider: 'anthropic', model_id: 'claude-opus-5', group: 'claude', available: true, unavailable_reason: null },
  { tier: 'fast', provider: 'anthropic', model_id: 'claude-haiku-4-5', group: 'claude', available: true, unavailable_reason: null },
  { tier: 'sol', provider: 'openai', model_id: 'gpt-5.6-sol', group: 'codex', available: true, unavailable_reason: null },
  { tier: 'k3', provider: 'moonshot', model_id: 'kimi-k3', group: 'kimi', available: false, unavailable_reason: 'needs a Kimi key' },
]

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

describe('tierChoices — the phone and the browser grey the same options, for the same reason', () => {
  for (const phase of [BUILD, CODEX, KIMI]) {
    test(`${phase.key} offers the same set`, () => {
      // The reason STRING is compared too, not just the boolean: "needs a Kimi key"
      // and a blank grey box are very different answers to "why can't I pick this",
      // and only one of them lets the owner fix it.
      expect(web.tierChoices(phase, TIERS)).toEqual(mobile.tierChoices(phase, TIERS))
    })
  }

  test('nothing is ever dropped from the list', () => {
    // Hiding an option the owner cannot account for is how a capability stays
    // invisible for weeks. Both copies must show all four.
    expect(web.tierChoices(BUILD, TIERS)).toHaveLength(TIERS.length)
    expect(mobile.tierChoices(CODEX, TIERS)).toHaveLength(TIERS.length)
  })
})

describe('resolvedModel / rejectedModel — the same answer on both', () => {
  test('a known tier resolves, an unknown one does not', () => {
    expect(web.resolvedModel('sol', TIERS)).toBe(mobile.resolvedModel('sol', TIERS))
    expect(web.resolvedModel('retired-tier', TIERS)).toBe(
      mobile.resolvedModel('retired-tier', TIERS),
    )
  })

  test('a refused stored value surfaces identically', () => {
    const rejected = { build: { model: 'gpt-5.7-nova' }, review_codex: { effort: 'max' } }
    expect(web.rejectedModel(BUILD, rejected)).toBe(mobile.rejectedModel(BUILD, rejected))
    // An effort-only rejection is NOT a struck-through model on either client.
    expect(web.rejectedModel(CODEX, rejected)).toBe(mobile.rejectedModel(CODEX, rejected))
  })
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
    // …and the new helpers can distinguish the three outcomes they exist for.
    const choices = web.tierChoices(CODEX, TIERS)
    expect(choices.find((c) => c.tier === 'sol')!.selectable).toBe(true)
    expect(choices.find((c) => c.tier === 'opus')!.reason).toBe('Claude steps only')
    // WRONG-GROUP BEATS UNAVAILABLE, deliberately: telling the owner of a Codex row
    // to go get a Kimi key would send them to fix something that would not help.
    expect(choices.find((c) => c.tier === 'k3')!.reason).toBe('Kimi steps only')
    // On the row that COULD use it, the missing credential is the reason — and the
    // option is still listed rather than hidden.
    const kimiChoices = web.tierChoices(KIMI, TIERS)
    expect(kimiChoices.find((c) => c.tier === 'k3')).toEqual({
      tier: 'k3',
      model_id: 'kimi-k3',
      selectable: false,
      reason: 'needs a Kimi key',
    })
  })

  test('both copies are the SAME shape of function, not one wrapping the other', () => {
    expect(web.applyRowEdit.length).toBe(mobile.applyRowEdit.length)
    expect(web.effectiveRow.length).toBe(mobile.effectiveRow.length)
    expect(web.tierChoices.length).toBe(mobile.tierChoices.length)
    expect(web.resolvedModel.length).toBe(mobile.resolvedModel.length)
    expect(web.rejectedModel.length).toBe(mobile.rejectedModel.length)
  })
})
