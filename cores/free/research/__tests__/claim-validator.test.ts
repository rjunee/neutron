/**
 * @neutronai/research-core — assertSourcesCited invariant tests.
 *
 * Per docs/plans/research-core-tier1-brief.md § 3.5 + § 2.3.
 *
 * The single most important contract: every claim has citation OR is
 * tagged unverified. Test every edge case.
 */

import { describe, expect, test } from 'bun:test'

import {
  SourcesCitedViolationError,
  assertSourcesCited,
} from '../src/claim-validator.ts'
import type { ResearchClaim } from '../src/claim-store.ts'

function claim(overrides: Partial<ResearchClaim>): ResearchClaim {
  return {
    id: overrides.id ?? 'c-1',
    task_id: overrides.task_id ?? 't-1',
    claim: overrides.claim ?? 'water is wet',
    evidence: overrides.evidence ?? null,
    citation: overrides.citation ?? null,
    confidence: overrides.confidence ?? 'medium',
    created_at: overrides.created_at ?? 0,
  }
}

describe('assertSourcesCited — happy path', () => {
  test('returns N when every claim is cited', () => {
    const claims: ResearchClaim[] = [
      claim({ id: 'c-1', citation: 'https://wikipedia.org/wiki/Water', confidence: 'high' }),
      claim({ id: 'c-2', citation: 'docs/plans/foo.md:12', confidence: 'medium' }),
      claim({ id: 'c-3', citation: '10.1038/nature01234', confidence: 'high' }),
    ]
    expect(assertSourcesCited('t-1', claims)).toBe(3)
  })

  test('returns N when every claim is tagged unverified', () => {
    const claims: ResearchClaim[] = [
      claim({ id: 'c-1', citation: null, confidence: 'unverified' }),
      claim({ id: 'c-2', citation: null, confidence: 'unverified' }),
    ]
    expect(assertSourcesCited('t-1', claims)).toBe(2)
  })

  test('mixed cited + unverified passes', () => {
    const claims: ResearchClaim[] = [
      claim({ id: 'c-1', citation: 'https://gov.uk/x', confidence: 'high' }),
      claim({ id: 'c-2', citation: null, confidence: 'unverified' }),
      claim({ id: 'c-3', citation: 'https://arxiv.org/abs/1234', confidence: 'low' }),
    ]
    expect(assertSourcesCited('t-1', claims)).toBe(3)
  })
})

describe('assertSourcesCited — violation paths', () => {
  test('throws when a single claim is missing both citation + unverified tag', () => {
    const offending = claim({
      id: 'c-bad',
      claim: 'a thing that needs a source',
      citation: null,
      confidence: 'medium',
    })
    expect(() => assertSourcesCited('t-1', [offending])).toThrow(
      SourcesCitedViolationError,
    )
  })

  test('the error names the offending claim id + text', () => {
    const offending = claim({
      id: 'c-bad-12345',
      claim: 'an uncited factual assertion',
      citation: null,
      confidence: 'high',
    })
    try {
      assertSourcesCited('t-7', [offending])
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(SourcesCitedViolationError)
      const e = err as SourcesCitedViolationError
      expect(e.task_id).toBe('t-7')
      expect(e.offending_claim_id).toBe('c-bad-12345')
      expect(e.offending_claim_text).toBe('an uncited factual assertion')
      expect(e.code).toBe('sources_cited_violation')
    }
  })

  test('empty claim array throws (every brief must carry at least one)', () => {
    expect(() => assertSourcesCited('t-1', [])).toThrow(SourcesCitedViolationError)
  })

  test('empty-string citation counts as missing', () => {
    const offending = claim({ id: 'c-blank', citation: '', confidence: 'high' })
    expect(() => assertSourcesCited('t-1', [offending])).toThrow(
      SourcesCitedViolationError,
    )
  })

  test('whitespace-only citation counts as missing', () => {
    const offending = claim({ id: 'c-ws', citation: '   \n  ', confidence: 'high' })
    expect(() => assertSourcesCited('t-1', [offending])).toThrow(
      SourcesCitedViolationError,
    )
  })

  test('first offending claim is the one reported (validator short-circuits)', () => {
    const claims: ResearchClaim[] = [
      claim({ id: 'c-ok', citation: 'https://wikipedia.org/x', confidence: 'high' }),
      claim({ id: 'c-bad-first', citation: null, confidence: 'medium' }),
      claim({ id: 'c-bad-second', citation: null, confidence: 'low' }),
    ]
    try {
      assertSourcesCited('t-1', claims)
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(SourcesCitedViolationError)
      expect((err as SourcesCitedViolationError).offending_claim_id).toBe('c-bad-first')
    }
  })
})

describe('assertSourcesCited — property test', () => {
  // 100 randomly-generated briefs (claim count × claim-citation
  // distribution × confidence distribution). The invariant: pass IFF
  // every claim has citation OR confidence='unverified'.
  test('100 random briefs: pass IFF every claim is cited OR unverified', () => {
    const rng = mulberry32(0xdeadbeef)
    for (let trial = 0; trial < 100; trial++) {
      const n = 1 + Math.floor(rng() * 8) // 1..8 claims
      const claims: ResearchClaim[] = []
      for (let i = 0; i < n; i++) {
        const r = rng()
        // 40% cited+verified, 30% unverified-no-citation, 15%
        // unverified-with-citation (also valid), 15% invalid (no
        // citation + verified).
        let citation: string | null
        let confidence: ResearchClaim['confidence']
        if (r < 0.4) {
          citation = `https://example.com/${i}`
          confidence = 'medium'
        } else if (r < 0.7) {
          citation = null
          confidence = 'unverified'
        } else if (r < 0.85) {
          citation = `https://example.com/u-${i}`
          confidence = 'unverified'
        } else {
          citation = null
          confidence = 'high'
        }
        claims.push(claim({ id: `c-${trial}-${i}`, citation, confidence }))
      }
      const expectedPass = claims.every(
        (c) =>
          (typeof c.citation === 'string' && c.citation.trim().length > 0) ||
          c.confidence === 'unverified',
      )
      if (expectedPass) {
        expect(() => assertSourcesCited(`t-${trial}`, claims)).not.toThrow()
      } else {
        expect(() => assertSourcesCited(`t-${trial}`, claims)).toThrow(
          SourcesCitedViolationError,
        )
      }
    }
  })
})

// Deterministic seeded RNG for the property test.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return (): number => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
