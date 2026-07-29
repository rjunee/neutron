/**
 * P2-v2 S23 — registry tests for `runtime/model-pricing.ts`.
 *
 * Per the S23 brief these tests pin:
 *   - The three registry rows required by production (Opus 4.7, Sonnet 4.6,
 *     Haiku 4.5) match the prices verified 2026-05-17 from
 *     https://docs.claude.com/en/docs/about-claude/pricing.
 *   - The Haiku 4.5 snapshot id (the date-suffixed form used by
 *     `runtime/models.ts:FAST_MODEL`) carries the same prices as its alias.
 *   - `resolveModelPricing` returns the entry for known ids.
 *   - `resolveModelPricing` throws a descriptive error for unknown ids
 *     (silent billing at a default rate is the failure mode S23 closes —
 *     see S21 R2 IMPORTANT #1 + S22 R3 Codex follow-up #2).
 */

import { describe, expect, test } from 'bun:test'
import {
  MODEL_PRICING_TABLE,
  resolveModelPricing,
} from '../model-pricing.ts'
import { BEST_MODEL, FAST_MODEL, SONNET_MODEL } from '../models.ts'

describe('MODEL_PRICING_TABLE — verified 2026-05-17 docs.claude.com rows', () => {
  test('claude-opus-4-7 → $5 input / $25 output', () => {
    const e = MODEL_PRICING_TABLE['claude-opus-4-7']
    expect(e).toBeDefined()
    expect(e!.input_usd_per_m).toBe(5)
    expect(e!.output_usd_per_m).toBe(25)
    expect(e!.verified_at).toBe('2026-05-17')
    expect(e!.source_url).toContain('docs.claude.com')
  })

  test('claude-sonnet-4-6 → $3 input / $15 output', () => {
    const e = MODEL_PRICING_TABLE['claude-sonnet-4-6']
    expect(e).toBeDefined()
    expect(e!.input_usd_per_m).toBe(3)
    expect(e!.output_usd_per_m).toBe(15)
    expect(e!.verified_at).toBe('2026-05-17')
  })

  test('claude-haiku-4-5 → $1 input / $5 output (S23 corrected from legacy Haiku 3.5 $0.8/$4.0)', () => {
    const e = MODEL_PRICING_TABLE['claude-haiku-4-5']
    expect(e).toBeDefined()
    expect(e!.input_usd_per_m).toBe(1)
    expect(e!.output_usd_per_m).toBe(5)
    expect(e!.verified_at).toBe('2026-05-17')
  })

  test('claude-haiku-4-5-20251001 snapshot id carries the same prices as its alias', () => {
    const alias = MODEL_PRICING_TABLE['claude-haiku-4-5']!
    const snap = MODEL_PRICING_TABLE['claude-haiku-4-5-20251001']!
    expect(snap.input_usd_per_m).toBe(alias.input_usd_per_m)
    expect(snap.output_usd_per_m).toBe(alias.output_usd_per_m)
  })

  test('table is frozen — accidental mutation throws (catch regressions like S21 R2 #1)', () => {
    // Object.freeze blocks shallow writes; in strict mode (Bun) the assign
    // throws, in sloppy mode it silently no-ops. Either way the property is
    // unchanged after the attempt, so we assert via re-read.
    try {
      ;(MODEL_PRICING_TABLE as { 'claude-opus-4-7': unknown })['claude-opus-4-7'] = {
        input_usd_per_m: 999,
        output_usd_per_m: 999,
        verified_at: 'spoof',
        source_url: 'spoof',
      }
    } catch {
      // strict mode → ok
    }
    expect(MODEL_PRICING_TABLE['claude-opus-4-7']!.input_usd_per_m).toBe(5)
  })

  test('rows are deep-frozen — field mutation on a returned entry cannot poison the registry (Codex S23 R1 P3)', () => {
    // S23 shipped a SHALLOW freeze (outer table frozen, rows not). That
    // left a hole: a caller could keep a reference to a returned
    // `ModelPricingEntry` and mutate its fields, poisoning the registry
    // process-wide (every subsequent `resolveModelPricing` for that model
    // would see the spoofed numbers). S24 closes the hole by deep-freezing
    // each row at construction. This test pins the contract for every row.
    //
    // In Bun's strict-mode ESM the assign throws; in sloppy mode it silently
    // no-ops. Either way the field MUST be unchanged after the attempt.
    const ids = [
      'claude-opus-4-7',
      'claude-sonnet-4-6',
      'claude-haiku-4-5',
      'claude-haiku-4-5-20251001',
    ] as const

    for (const id of ids) {
      const before = MODEL_PRICING_TABLE[id]!

      try {
        ;(before as { input_usd_per_m: number }).input_usd_per_m = 999
      } catch {
        // strict mode → ok
      }
      try {
        ;(before as { output_usd_per_m: number }).output_usd_per_m = 999
      } catch {
        // strict mode → ok
      }
      try {
        ;(before as { verified_at: string }).verified_at = 'spoof'
      } catch {
        // strict mode → ok
      }

      const after = MODEL_PRICING_TABLE[id]!
      expect(after.input_usd_per_m).not.toBe(999)
      expect(after.output_usd_per_m).not.toBe(999)
      expect(after.verified_at).toBe('2026-05-17')

      // And the row itself MUST report as frozen.
      expect(Object.isFrozen(after)).toBe(true)
    }
  })

  test('resolveModelPricing returns a frozen entry (no mutation via the public accessor)', () => {
    // Same contract as above but exercised through the public lookup path
    // production code uses (substrate adapters call resolveModelPricing,
    // not MODEL_PRICING_TABLE directly).
    const entry = resolveModelPricing('claude-opus-4-7')
    expect(Object.isFrozen(entry)).toBe(true)

    try {
      ;(entry as { input_usd_per_m: number }).input_usd_per_m = 12345
    } catch {
      // strict mode → ok
    }

    // The next resolve MUST still hand back the verified $5 rate.
    expect(resolveModelPricing('claude-opus-4-7').input_usd_per_m).toBe(5)
  })

  test('snapshot-fallback alias lookup also returns a frozen entry', () => {
    // resolveModelPricing's snapshot-suffix fallback returns the *alias*
    // row by reference. That row is registered, so it MUST be frozen too —
    // i.e. mutating a snapshot-resolved entry must not poison the alias.
    const snap = resolveModelPricing('claude-opus-4-7-20260101')
    expect(Object.isFrozen(snap)).toBe(true)

    try {
      ;(snap as { input_usd_per_m: number }).input_usd_per_m = 999
    } catch {
      // strict mode → ok
    }

    expect(resolveModelPricing('claude-opus-4-7').input_usd_per_m).toBe(5)
  })
})

describe('resolveModelPricing', () => {
  test('returns the entry for each canonical model id', () => {
    expect(resolveModelPricing('claude-opus-4-7').input_usd_per_m).toBe(5)
    expect(resolveModelPricing('claude-sonnet-4-6').input_usd_per_m).toBe(3)
    expect(resolveModelPricing('claude-haiku-4-5').input_usd_per_m).toBe(1)
  })

  test('returns the entry for the production runtime/models.ts aliases', () => {
    // BEST_MODEL + SONNET_MODEL default to the un-suffixed canonical name;
    // FAST_MODEL defaults to the date-suffixed snapshot. The registry MUST
    // resolve all three at startup so a fresh import doesn't crash.
    expect(() => resolveModelPricing(BEST_MODEL)).not.toThrow()
    expect(() => resolveModelPricing(SONNET_MODEL)).not.toThrow()
    expect(() => resolveModelPricing(FAST_MODEL)).not.toThrow()
  })

  test('throws a descriptive error for unknown model ids', () => {
    let caught: unknown = null
    try {
      resolveModelPricing('claude-unknown-future-model')
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(Error)
    const msg = (caught as Error).message
    expect(msg).toContain('claude-unknown-future-model')
    expect(msg).toContain('claude-opus-4-7')
    expect(msg).toContain('MODEL_PRICING_TABLE')
    expect(msg).toContain('docs.claude.com')
  })

  test('throw enumerates the known model ids so operators can fix env overrides', () => {
    try {
      resolveModelPricing('bad-id')
    } catch (err) {
      const msg = (err as Error).message
      // Each canonical row mentioned so an operator who set NEUTRON_SONNET_MODEL
      // to a typo can see the valid alternatives at a glance.
      expect(msg).toContain('claude-opus-4-7')
      expect(msg).toContain('claude-sonnet-4-6')
      expect(msg).toContain('claude-haiku-4-5')
    }
  })
})

describe('resolveModelPricing — snapshot-suffix fallback (Codex S23 R1 P2)', () => {
  // Anthropic uses `-YYYYMMDD` snapshot ids (e.g. `claude-haiku-4-5-20251001`
  // is already registered). Operators piloting a new snapshot of an
  // already-registered generation via `NEUTRON_BEST_MODEL=...` must NOT need
  // a code change for pricing to resolve — Anthropic prices a generation
  // identically across snapshots, so the alias row is the correct billing
  // rate. This describe block pins that contract.

  test('unregistered Opus 4.7 snapshot resolves via its registered alias', () => {
    const entry = resolveModelPricing('claude-opus-4-7-20260101')
    expect(entry.input_usd_per_m).toBe(5)
    expect(entry.output_usd_per_m).toBe(25)
  })

  test('unregistered Sonnet 4.6 snapshot resolves via its registered alias', () => {
    const entry = resolveModelPricing('claude-sonnet-4-6-20260131')
    expect(entry.input_usd_per_m).toBe(3)
    expect(entry.output_usd_per_m).toBe(15)
  })

  test('unregistered Haiku 4.5 snapshot resolves via its registered alias', () => {
    const entry = resolveModelPricing('claude-haiku-4-5-20260215')
    expect(entry.input_usd_per_m).toBe(1)
    expect(entry.output_usd_per_m).toBe(5)
  })

  test('snapshot id of an UNREGISTERED generation still throws (no silent cross-gen mis-bill)', () => {
    // Opus 5.0 (hypothetical) is NOT registered. Its snapshot must NOT
    // silently borrow Opus 4.7's rates — Anthropic generations have
    // different pricing tables (Opus 4.7 = $5/$25, Opus 4.1 = $15/$75).
    let caught: unknown = null
    try {
      resolveModelPricing('claude-opus-5-0-20260301')
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toContain('claude-opus-5-0-20260301')
  })

  test('typo with date-like suffix still throws (catches "claude-typo-12345678")', () => {
    let caught: unknown = null
    try {
      resolveModelPricing('claude-typo-19700101')
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(Error)
  })

  test('non-snapshot typo (no trailing date) throws without trying the snapshot path', () => {
    let caught: unknown = null
    try {
      resolveModelPricing('claude-opus-4-7-extra')
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(Error)
  })
})
