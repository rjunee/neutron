/**
 * ISSUES #566/#567 — THE THREE STATES A CROSS-MODEL SEAT CAN BE IN, AND WHY THEY MUST
 * NOT COLLAPSE.
 *
 * `none` (the owner turned the seat off) and `configured`-but-dead both produce no
 * verdict. That is the whole danger. A gate that distinguished them by asking "did a
 * verdict arrive" would have to pick one wrong answer:
 *
 *   • treat both as blocking → an owner who deliberately opted out can never merge;
 *   • treat both as fine     → a cross-model reviewer that DIED stops barring the
 *                              APPROVE, the panel silently becomes single-family, and
 *                              the run still reports that a cross-model review
 *                              happened. That report is what an operator trusts, which
 *                              makes it the worse of the two by a distance.
 *
 * So the disposition is DATA, computed here from the owner's configuration and the
 * install's credentials, and the gate reads the field. These tests hold that property
 * from both sides — every assertion that a state does not block is paired with the
 * positive control that another state does.
 */

import { describe, expect, it } from 'bun:test'

import {
  CROSS_MODEL_SLOT_KEYS,
  dispatchableSlots,
  panelIsClaudeOnly,
  resolveCrossModelSlots,
} from '../cross-model-slots.ts'
import { NO_MODEL } from '../model-tiers.ts'
import { parsePhaseModelConfig } from '../phase-models.ts'

const BOTH = { codex: true, kimi: true }

/** Run a raw stored config through the REAL validator, as the launcher does. */
const stored = (raw: Record<string, { model?: string; effort?: string }>): ReturnType<
  typeof parsePhaseModelConfig
>['config'] => parsePhaseModelConfig(raw).config

describe('the default panel — an install that never opened the pane', () => {
  it('fills both seats from the phase defaults, with two different model families', () => {
    const slots = resolveCrossModelSlots({}, BOTH)
    expect(slots.map((s) => s.key)).toEqual([...CROSS_MODEL_SLOT_KEYS])
    expect(slots.map((s) => s.disposition)).toEqual(['configured', 'configured'])
    expect(slots.map((s) => s.model_id)).toEqual(['gpt-5.6-sol', 'kimi-k3'])
    // THE POINT OF THE SEATS: two DIFFERENT families, so the panel is not one set of
    // blind spots. A default that put the same provider in both would satisfy every
    // other assertion in this file and quietly defeat the feature.
    expect(new Set(slots.map((s) => s.requires)).size).toBe(2)
    expect(panelIsClaudeOnly(slots)).toBe(false)
    expect(dispatchableSlots(slots)).toHaveLength(2)
  })

  it('carries the wrapper and env knob the dispatch needs, not just a model name', () => {
    const [one, two] = resolveCrossModelSlots({}, BOTH)
    expect(one!.wrapper).toBe('trident/codex-review.sh')
    expect(one!.env_var).toBe('CODEX_REVIEW_MODEL')
    expect(two!.wrapper).toBe('trident/kimi-review-cli.ts')
    expect(two!.env_var).toBe('KIMI_MODEL')
  })
})

describe('NONE is a deliberate choice, and it is stored as one', () => {
  it('reports `none`, holds no model, and says WHY in words that are not a failure', () => {
    const slots = resolveCrossModelSlots(stored({ review_cross_1: { model: NO_MODEL } }), BOTH)
    expect(slots[0]!.disposition).toBe('none')
    expect(slots[0]!.tier).toBeNull()
    expect(slots[0]!.model_id).toBeNull()
    expect(slots[0]!.reason).toContain('deliberately empty')
    // …and the OTHER seat is untouched. Emptying one seat must not empty the panel.
    expect(slots[1]!.disposition).toBe('configured')
    expect(dispatchableSlots(slots)).toHaveLength(1)
    expect(panelIsClaudeOnly(slots)).toBe(false)
  })

  it('BOTH seats none is a knowing opt-out the panel can NAME', () => {
    const slots = resolveCrossModelSlots(
      stored({ review_cross_1: { model: NO_MODEL }, review_cross_2: { model: NO_MODEL } }),
      BOTH,
    )
    expect(slots.every((s) => s.disposition === 'none')).toBe(true)
    expect(dispatchableSlots(slots)).toEqual([])
    // It is legitimate, so nothing here blocks — but it IS a single-family panel, and
    // the predicate exists so the pane and the run can say so rather than letting the
    // owner keep believing a second family is checking the work.
    expect(panelIsClaudeOnly(slots)).toBe(true)
  })

  it('`none` is NOT the same as a seat with no credential', () => {
    // THE DISTINCTION THAT MUST SURVIVE. Both produce no review and neither blocks, so
    // it would be tempting to collapse them — but only one is a choice the owner made,
    // and only one is fixed by connecting an account. The panel record has to be able
    // to say which.
    const off = resolveCrossModelSlots(stored({ review_cross_1: { model: NO_MODEL } }), BOTH)[0]!
    const unavailable = resolveCrossModelSlots({}, { codex: false, kimi: true })[0]!
    expect(off.disposition).toBe('none')
    expect(unavailable.disposition).toBe('not_configured')
    expect(off.disposition).not.toBe(unavailable.disposition)
    // The unavailable seat still remembers WHAT it was pointed at, so the owner can see
    // which credential would light it up.
    expect(unavailable.model_id).toBe('gpt-5.6-sol')
    expect(unavailable.requires).toBe('codex')
    expect(unavailable.reason).toContain('no codex credential')
    // The emptied seat deliberately remembers nothing — there is nothing to connect.
    expect(off.model_id).toBeNull()
  })
})

describe('the seats are re-pointable — a slot is a position, not a vendor', () => {
  it('accepts EITHER executor in EITHER slot', () => {
    // The defect in one line: "How can I then change them to a different model?" A seat
    // named after its occupant could not be re-pointed, and both slots now take any
    // non-Claude tier.
    const swapped = resolveCrossModelSlots(
      stored({ review_cross_1: { model: 'k3' }, review_cross_2: { model: 'terra' } }),
      BOTH,
    )
    expect(swapped[0]!.model_id).toBe('kimi-k3')
    expect(swapped[0]!.wrapper).toBe('trident/kimi-review-cli.ts')
    expect(swapped[1]!.model_id).toBe('gpt-5.6-terra')
    expect(swapped[1]!.wrapper).toBe('trident/codex-review.sh')
    // The WRAPPER moved with the model. A seat that kept the old wrapper would set
    // `CODEX_REVIEW_MODEL=kimi-k3`, which is not a review — it is an error.
    expect(swapped[0]!.env_var).toBe('KIMI_MODEL')
    expect(swapped[1]!.env_var).toBe('CODEX_REVIEW_MODEL')
  })

  it('BOTH slots on the SAME family is allowed, and the pane is not lying about it', () => {
    // A legitimate configuration (two GPT tiers cross-check each other on price and
    // capability), and one the panel should not describe as three families. Nothing
    // here blocks it; the point is only that the resolver reports what was chosen.
    const slots = resolveCrossModelSlots(
      stored({ review_cross_1: { model: 'sol' }, review_cross_2: { model: 'luna' } }),
      BOTH,
    )
    expect(slots.map((s) => s.requires)).toEqual(['codex', 'codex'])
    expect(panelIsClaudeOnly(slots)).toBe(false)
  })
})

describe('a bad stored value degrades toward a reviewer that RUNS', () => {
  it('an override the validator would refuse falls back to the default, never to empty', () => {
    // The safe direction. Reading an unusable value as `none` would silently empty a
    // seat the owner never emptied — the one outcome worse than ignoring their choice,
    // because it removes a merge gate without saying so.
    const slots = resolveCrossModelSlots(
      { review_cross_1: { model: 'gpt-5.7-nova' } } as never,
      BOTH,
    )
    expect(slots[0]!.disposition).toBe('configured')
    expect(slots[0]!.model_id).toBe('gpt-5.6-sol')
  })

  it('a Claude tier smuggled into a slot also falls back rather than emptying it', () => {
    const slots = resolveCrossModelSlots({ review_cross_1: { model: 'opus' } } as never, BOTH)
    expect(slots[0]!.disposition).toBe('configured')
    expect(slots[0]!.model_id).toBe('gpt-5.6-sol')
    expect(slots[0]!.requires).toBe('codex')
  })
})

describe('credentials gate dispatch, but never hide the choice', () => {
  it('an install with NO cross-model credentials runs a reduced panel that says so', () => {
    const slots = resolveCrossModelSlots({}, { codex: false, kimi: false })
    expect(slots.map((s) => s.disposition)).toEqual(['not_configured', 'not_configured'])
    expect(dispatchableSlots(slots)).toEqual([])
    expect(panelIsClaudeOnly(slots)).toBe(true)
    // Each still names its model and its missing credential — an option that silently
    // disappears is how a capability stays invisible for weeks (ISSUES #551).
    for (const slot of slots) {
      expect(slot.model_id).not.toBeNull()
      expect(slot.reason).toContain('credential')
    }
  })
})
