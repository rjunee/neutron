/**
 * ISSUES #564 — THE CHECK THAT SHOULD HAVE CAUGHT SONNET, AND DID NOT EXIST.
 *
 * `SONNET_MODEL` sat on a generation-old id for weeks and was found by the OWNER
 * reading a settings pane. That is the part worth fixing — the bump itself is one
 * string. Understanding WHY nothing noticed is what makes the fix the right shape:
 *
 *   The model-update watchdog probes the LIVE CLI SESSION and asks what model it is.
 *   That answer is always the TOP tier. `compareModelRecency` is then family-scoped ON
 *   PURPOSE — a cross-family comparison is `unknown` so a Haiku id leaked during an
 *   Opus outage can never be adopted as the new default. Both of those are correct, and
 *   together they guarantee the probe can never rank a `claude-opus-*` answer against a
 *   `claude-sonnet-*` baseline. The non-Opus tier constants were outside every check by
 *   construction, not by oversight.
 *
 * So the gap is closed WITHOUT a probe. The pricing table is already the registry of
 * ids this build knows about — `resolveModelPricing` THROWS on an unregistered id
 * rather than defaulting, so a model cannot be dispatched until someone adds a verified
 * row. "An id exists in that table that is newer, in the same family, than a tier
 * default" is therefore a precise, deterministic statement of "this tier default is
 * stale", computable with no network and no credential. Which is exactly what lets a
 * TEST be the machine that notices.
 *
 * THE RANKER IS REUSED, NOT REBUILT. `parseModelId` / `compareModelRecency` already
 * define "newer" for this codebase, family-scoped and snapshot-tolerant. A second
 * definition here would be free to drift from the one the live path uses.
 */

import { describe, expect, it } from 'bun:test'

import { MODEL_PRICING_TABLE, resolveModelPricing } from '../model-pricing.ts'
import { SONNET_MODEL, tierDefaults } from '../models.ts'
import {
  staleTierDefaultNotice,
  staleTierDefaults,
} from '../adapters/claude-code/persistent/model-update-watchdog.ts'

const KNOWN = Object.keys(MODEL_PRICING_TABLE)

describe('THE GUARD — no tier default is a generation behind', () => {
  it('every tier constant is the newest id this build knows about in its family', () => {
    // THIS IS THE ASSERTION THAT WOULD HAVE GONE RED. Ship a pricing row for a newer
    // Sonnet, Opus, Haiku or Fable without bumping the matching constant and CI fails
    // here, naming the constant to edit — instead of the owner noticing months later.
    const stale = staleTierDefaults(tierDefaults(), KNOWN)
    expect(stale).toEqual([])
  })

  it('every tier default can actually be PRICED — the registry and the tiers agree', () => {
    // The other half of the same coupling. A constant pointing at an id with no pricing
    // row would throw at the first dispatch against it, which is a loud failure but a
    // late one; this makes it a compile-time-ish one.
    for (const { constant, model } of tierDefaults()) {
      expect(() => resolveModelPricing(model), `${constant} → ${model}`).not.toThrow()
    }
  })

  it('the Sonnet tier is on the current generation (the bump itself)', () => {
    // Pinned explicitly as well as by the walk above, so the specific regression this
    // issue is about cannot come back through a change to the walk.
    expect(SONNET_MODEL).toBe('claude-sonnet-5')
  })
})

describe('staleTierDefaults — the detector itself can fail', () => {
  it('DETECTS a behind-by-a-generation constant', () => {
    // Without this the guard above would pass on a function that always returned [].
    const stale = staleTierDefaults(
      [{ constant: 'SONNET_MODEL', model: 'claude-sonnet-4-6' }],
      ['claude-sonnet-4-6', 'claude-sonnet-5', 'claude-opus-5'],
    )
    expect(stale).toEqual([
      { constant: 'SONNET_MODEL', current: 'claude-sonnet-4-6', newest: 'claude-sonnet-5' },
    ])
  })

  it('is FAMILY-SCOPED — a newer Opus does not make Sonnet look stale', () => {
    // The property that makes this safe to run against a mixed registry, and the same
    // one that makes the live-session probe blind to Sonnet in the first place.
    expect(
      staleTierDefaults(
        [{ constant: 'SONNET_MODEL', model: 'claude-sonnet-5' }],
        ['claude-opus-9', 'claude-fable-9', 'claude-sonnet-5'],
      ),
    ).toEqual([])
  })

  it('ranks by VERSION TUPLE, not by string order', () => {
    // `claude-opus-4-10` sorts before `claude-opus-4-9` as a string. A lexical ranker
    // would report the newer constant as stale and send someone to "fix" a downgrade.
    expect(
      staleTierDefaults(
        [{ constant: 'BEST_MODEL', model: 'claude-opus-4-10' }],
        ['claude-opus-4-9', 'claude-opus-4-10'],
      ),
    ).toEqual([])
    expect(
      staleTierDefaults(
        [{ constant: 'BEST_MODEL', model: 'claude-opus-4-9' }],
        ['claude-opus-4-9', 'claude-opus-4-10'],
      ),
    ).toHaveLength(1)
  })

  it('tolerates dated snapshots on either side', () => {
    // `FAST_MODEL` is a dated snapshot (`claude-haiku-4-5-20251001`). Reporting it stale
    // against its own alias would make the guard cry wolf on every boot, which is how a
    // check like this gets muted.
    expect(
      staleTierDefaults(
        [{ constant: 'FAST_MODEL', model: 'claude-haiku-4-5-20251001' }],
        ['claude-haiku-4-5', 'claude-haiku-4-5-20251001'],
      ),
    ).toEqual([])
  })

  it('SKIPS an id it cannot parse rather than guessing', () => {
    // An operator's `NEUTRON_SONNET_MODEL` alias is not evidence of staleness, and a
    // false alarm on a deliberate pin is how the guard loses its credibility.
    expect(
      staleTierDefaults([{ constant: 'SONNET_MODEL', model: 'my-internal-alias' }], KNOWN),
    ).toEqual([])
  })

  it('the notice names the CONSTANT to edit, not just the ids', () => {
    // "sonnet is old" is not actionable at 3am; `runtime/models.ts:SONNET_MODEL` is.
    const notice = staleTierDefaultNotice({
      constant: 'SONNET_MODEL',
      current: 'claude-sonnet-4-6',
      newest: 'claude-sonnet-5',
    })
    expect(notice).toContain('runtime/models.ts:SONNET_MODEL')
    expect(notice).toContain('claude-sonnet-4-6')
    expect(notice).toContain('claude-sonnet-5')
    // …and explains why the live probe could not have caught it, so the next reader
    // does not "fix" the gap by adding a second probe.
    expect(notice).toContain('family-scoped')
  })
})
