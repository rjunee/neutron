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

/**
 * A phase whose two defaults differ, so a rule that confuses them is visible — and
 * the ONE row with two executors, which is the case the greying rule gets wrong if
 * either client still compares against `group` alone.
 */
const BUILD = {
  key: 'build',
  label: 'Build',
  description: 'Writes the code and the tests.',
  group: 'claude',
  groups: ['claude', 'codex'],
  effort_supported: true,
  default: { model: 'opus', effort: 'high' },
}

/** The codex review row: a different executor, and no effort control at all. */
const CODEX = {
  key: 'review_codex',
  label: 'Cross-model review (Codex)',
  description: 'A second opinion from a GPT model.',
  group: 'codex',
  groups: ['codex'],
  effort_supported: false,
  default: { model: 'sol', effort: 'high' },
}

/** A Claude-only row, so "wrong executor" and "no credential" can be told apart. */
const RUBRIC = {
  key: 'review_rubric',
  label: 'Rubric review',
  description: 'Reviews the diff against the fixed criteria.',
  group: 'claude',
  groups: ['claude'],
  effort_supported: true,
  default: { model: 'opus', effort: 'high' },
}

/**
 * The tier vocabulary as the server sends it, with ONE tier deliberately
 * unavailable — the case where the two clients could most easily disagree about
 * whether to grey an option or drop it.
 */
const TIERS = [
  { tier: 'opus', provider: 'anthropic', model_id: 'claude-opus-5', group: 'claude', effort_supported: true, available: true, unavailable_reason: null },
  { tier: 'fast', provider: 'anthropic', model_id: 'claude-haiku-4-5', group: 'claude', effort_supported: true, available: true, unavailable_reason: null },
  { tier: 'sol', provider: 'openai', model_id: 'gpt-5.6-sol', group: 'codex', effort_supported: false, available: true, unavailable_reason: null },
  // UNAVAILABLE on purpose: the case where the two clients could most easily
  // disagree about whether to grey an option or drop it.
  { tier: 'terra', provider: 'openai', model_id: 'gpt-5.6-terra', group: 'codex', effort_supported: false, available: false, unavailable_reason: 'needs a Codex connection' },
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
  {
    name: 'move to a codex tier ON TOP of an effort — the effort must go',
    overrides: { build: { effort: 'max' } },
    patch: { model: 'sol' },
  },
  {
    name: 'set an effort while ALREADY on a codex tier — still nothing to store',
    overrides: { build: { model: 'sol' } },
    patch: { effort: 'max' },
  },
  {
    name: 'move BACK to a Claude tier — the effort control is live again',
    overrides: { build: { model: 'sol' } },
    patch: { model: 'fast', effort: 'max' },
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
      const fromWeb = web.applyRowEdit(c.overrides, BUILD, c.patch, TIERS)
      const fromMobile = mobile.applyRowEdit(c.overrides, BUILD, c.patch, TIERS)
      expect(fromWeb).toEqual(fromMobile)
    })
  }

  test('neither MUTATES the input it was given', () => {
    // A copy that mutated in place would still "agree" on the returned value while
    // corrupting the caller's state — an agreement test that missed the real
    // divergence. Asserted on both.
    const original = { build: { model: 'sonnet' } }
    const snapshot = JSON.stringify(original)
    web.applyRowEdit(original, BUILD, { model: 'opus' }, TIERS)
    expect(JSON.stringify(original)).toBe(snapshot)
    mobile.applyRowEdit(original, BUILD, { model: 'opus' }, TIERS)
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
  for (const phase of [BUILD, CODEX, RUBRIC]) {
    test(`${phase.key} offers the same set`, () => {
      // The reason STRING is compared too, not just the boolean: "needs a Codex
      // connection" and a blank grey box are very different answers to "why can't I
      // pick this", and only one of them lets the owner fix it.
      expect(web.tierChoices(phase, TIERS)).toEqual(mobile.tierChoices(phase, TIERS))
    })
  }

  test('the BUILD row offers the codex tiers, on both clients', () => {
    // The row has two executors now, so the GPT tiers are SELECTABLE — and the old
    // reason must be gone, not merely reworded. A greyed option with an explanation
    // that has become false is worse than the option being absent.
    for (const choices of [web.tierChoices(BUILD, TIERS), mobile.tierChoices(BUILD, TIERS)]) {
      const sol = choices.find((c) => c.tier === 'sol')!
      expect(sol).toEqual({ tier: 'sol', model_id: 'gpt-5.6-sol', selectable: true, reason: null })
      // The Claude tiers are still selectable — a second executor ADDS a choice.
      expect(choices.find((c) => c.tier === 'opus')!.selectable).toBe(true)
      // …and a codex tier this install has no credential for is still SELECTABLE-
      // eligible for the row: the reason is the missing connection, not the wiring.
      expect(choices.find((c) => c.tier === 'terra')!.reason).toBe('needs a Codex connection')
    }
  })

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
    expect(web.applyRowEdit({}, BUILD, { effort: 'xhigh' }, TIERS)).toEqual({
      build: { effort: 'xhigh' },
    })
    expect(web.effectiveRow(BUILD, {}).model).toBe('opus')
    expect(web.effectiveRow(BUILD, { build: { model: 'fast' } }).overridden).toBe(true)
    // …and the new helpers can distinguish the three outcomes they exist for.
    const choices = web.tierChoices(CODEX, TIERS)
    expect(choices.find((c) => c.tier === 'sol')!.selectable).toBe(true)
    expect(choices.find((c) => c.tier === 'opus')!.reason).toContain('Claude is not wired for this step yet')
    // A payload from a gateway that predates `groups` still renders, on both clients:
    // the settings pane must not blank out because one field is missing.
    const { groups: _omitted, ...legacyBuild } = BUILD
    expect(web.tierChoices(legacyBuild, TIERS)).toEqual(mobile.tierChoices(legacyBuild, TIERS))
    expect(web.tierChoices(legacyBuild, TIERS).find((c) => c.tier === 'sol')!.reason).toBe(
      'Codex is not wired for this step yet — it runs on Claude',
    )
    // WRONG-GROUP BEATS UNAVAILABLE, deliberately: telling the owner of a Claude-only
    // row to go connect Codex would send them to fix something that would not help.
    expect(web.tierChoices(RUBRIC, TIERS).find((c) => c.tier === 'terra')!.reason).toContain(
      'Codex is not wired for this step yet',
    )
    // On a row that COULD use it, the missing credential is the reason — and the
    // option is still listed rather than hidden.
    expect(web.tierChoices(CODEX, TIERS).find((c) => c.tier === 'terra')).toEqual({
      tier: 'terra',
      model_id: 'gpt-5.6-terra',
      selectable: false,
      reason: 'needs a Codex connection',
    })
  })

  test('both copies are the SAME shape of function, not one wrapping the other', () => {
    expect(web.applyRowEdit.length).toBe(mobile.applyRowEdit.length)
    expect(web.effectiveRow.length).toBe(mobile.effectiveRow.length)
    expect(web.tierChoices.length).toBe(mobile.tierChoices.length)
    expect(web.resolvedModel.length).toBe(mobile.resolvedModel.length)
    expect(web.rejectedModel.length).toBe(mobile.rejectedModel.length)
    expect(web.effortSettable.length).toBe(mobile.effortSettable.length)
    expect(web.phaseGroupsOf.length).toBe(mobile.phaseGroupsOf.length)
  })
})

describe('effortSettable — both clients disable the same cell', () => {
  // THE BUG THIS PINS. `effort_supported` on the PHASE answers for its DEFAULT tier,
  // so the build row kept a live effort dropdown after the owner moved it to codex —
  // and `applyRowEdit` then merged the stale effort into the PUT, which the server
  // refused. The whole save failed, taking every other row's pending edit with it.
  const CASES: Array<[string, boolean]> = [
    ['opus', true],
    ['fast', true],
    ['sol', false],
    ['terra', false],
    // A saved override the server no longer resolves keeps the phase's own answer —
    // the row is already telling the owner that value is dead.
    ['retired-tier', true],
  ]
  for (const [tier, expected] of CASES) {
    test(`build on ${tier} → ${expected}`, () => {
      expect(web.effortSettable(BUILD, tier, TIERS)).toBe(expected)
      expect(mobile.effortSettable(BUILD, tier, TIERS)).toBe(expected)
    })
  }

  test('a row with no effort control at all stays off, whatever the tier', () => {
    expect(web.effortSettable(CODEX, 'sol', TIERS)).toBe(false)
    expect(mobile.effortSettable(CODEX, 'opus', TIERS)).toBe(false)
  })

  test('a gateway that predates `effort_supported` keeps every effort control', () => {
    // THE VERSION-SKEW HAZARD, and it is the opposite shape from the one above.
    // `effort_supported` arrived with the CLI executors; an older gateway omits it,
    // and `undefined` under a truthiness test is falsy — so EVERY row on the pane
    // would lose its effort dropdown at once, silently, on a payload that used to
    // render fine. Absent means "no opinion", which is the old behaviour: keep it.
    // (`groups` already had this guard; this field shipped without one.)
    const { effort_supported: _phaseOmitted, ...legacyPhase } = BUILD
    const legacyTiers = TIERS.map(({ effort_supported: _tierOmitted, ...rest }) => rest)
    for (const client of [web, mobile]) {
      expect(client.effortSettable(legacyPhase, 'opus', legacyTiers)).toBe(true)
      // …including on a tier the old server had no opinion about either.
      expect(client.effortSettable(legacyPhase, 'sol', legacyTiers)).toBe(true)
    }
    // THE CONTROL: an explicit `false` from a CURRENT gateway still disables, so the
    // fallback did not simply switch the feature off.
    expect(web.effortSettable(BUILD, 'sol', TIERS)).toBe(false)
    expect(mobile.effortSettable(CODEX, 'opus', TIERS)).toBe(false)
  })

  test('the whole point: a codex build never PUTs an effort', () => {
    // End to end on the pure helpers — what the pane would send after the owner
    // picks `sol` on a row that had an effort pinned.
    for (const client of [web, mobile]) {
      expect(client.applyRowEdit({ build: { effort: 'max' } }, BUILD, { model: 'sol' }, TIERS)).toEqual({
        build: { model: 'sol' },
      })
    }
  })
})
