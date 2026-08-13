/**
 * THE MODEL REGISTRY AND THE PRICING REGISTRY MUST BUMP TOGETHER (ISSUES #564).
 *
 * `resolveModelPricing` throws on an unregistered id — deliberately, so a bad
 * id surfaces instead of silently billing at the wrong rate — and it is reached
 * at composer construction. So changing a default in `runtime/models.ts`
 * WITHOUT adding the matching row to `runtime/model-pricing.ts` does not
 * degrade quietly: it fails the boot of every install that takes the default.
 *
 * That coupling existed and was written down in prose; nothing enforced it.
 * This file enforces it. It is deliberately written against the LIVE exports
 * rather than a hand-copied list of ids, because a hand-copied list is the thing
 * that rotted in the first place.
 *
 * The companion guard — that `config/index.ts`'s hand-copied DEFAULTS table still
 * agrees with these exports — lives in `gateway/__tests__/model-defaults-drift.test.ts`
 * rather than here, because `runtime` does not depend on `config` and must not
 * start: `gateway` is the layer that legitimately sees both.
 */

import { describe, expect, test } from 'bun:test'

import { resolveModelPricing } from '../model-pricing.ts'
import { BEST_MODEL, FABLE_MODEL, FAST_MODEL, PROBE_MODEL, SONNET_MODEL } from '../models.ts'

describe('every default model id has a pricing row', () => {
  const TIERS: ReadonlyArray<readonly [string, string]> = [
    ['BEST_MODEL', BEST_MODEL],
    ['FABLE_MODEL', FABLE_MODEL],
    ['SONNET_MODEL', SONNET_MODEL],
    ['FAST_MODEL', FAST_MODEL],
    ['PROBE_MODEL', PROBE_MODEL],
  ]

  for (const [name, id] of TIERS) {
    test(`${name} (${id}) resolves a pricing row`, () => {
      // MUTATION TARGET. Point any tier at an id with no row and this throws —
      // which is precisely the boot failure this test exists to catch in CI
      // rather than on the owner's instance.
      const entry = resolveModelPricing(id)
      expect(entry.input_usd_per_m).toBeGreaterThan(0)
      expect(entry.output_usd_per_m).toBeGreaterThan(0)
      // A row whose numbers were guessed rather than read is worse than a
      // missing row, because the field is named `verified_at`. Pin that every
      // row carries a real date and a real source.
      expect(entry.verified_at).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(entry.source_url).toMatch(/^https:\/\//)
    })
  }
})

describe('Sonnet 5 pricing is the read number, not the inherited one', () => {
  // The generation bump CHANGED the rate — $2/$10 against 4.6's $3/$15. Every
  // other tier in this codebase kept its numbers across a generation boundary,
  // so "carry the old row forward" is the plausible wrong move here, and it
  // would have over-billed every Sonnet dispatch by 50%. Read off the pricing
  // table 2026-08-13.
  test('claude-sonnet-5 is $2 in / $10 out', () => {
    const entry = resolveModelPricing('claude-sonnet-5')
    expect(entry.input_usd_per_m).toBe(2)
    expect(entry.output_usd_per_m).toBe(10)
  })

  test('claude-sonnet-4-6 is retained at its own rate for installs still pinning it', () => {
    const entry = resolveModelPricing('claude-sonnet-4-6')
    expect(entry.input_usd_per_m).toBe(3)
    expect(entry.output_usd_per_m).toBe(15)
  })
})
