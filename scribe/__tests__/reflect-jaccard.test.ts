/**
 * RB3 reflect — Jaccard near-duplicate clustering (pure, deterministic).
 *   - tokenisation is a set (case-folded, short tokens dropped)
 *   - Jaccard value is |∩|/|∪|; empty sets never "match"
 *   - clustering groups near-duplicates, keeps distinct pages apart, and is
 *     transitive (A~B, B~C ⇒ {A,B,C}) via connected components
 */

import { describe, test, expect } from 'bun:test'
import {
  tokenize,
  jaccard,
  clusterNearDuplicates,
  DEFAULT_JACCARD_THRESHOLD,
  type DedupCandidate,
} from '../reflect/jaccard.ts'

describe('tokenize', () => {
  test('lowercases, splits on non-alphanumerics, drops <2-char tokens, dedups', () => {
    const t = tokenize('Acme Inc. — a B2B SaaS! (acme)')
    expect(t.has('acme')).toBe(true)
    expect(t.has('inc')).toBe(true)
    expect(t.has('b2b')).toBe(true)
    expect(t.has('saas')).toBe(true)
    expect(t.has('a')).toBe(false) // single char dropped
    // 'acme' appears twice but the set carries it once.
    expect([...t].filter((x) => x === 'acme').length).toBe(1)
  })
})

describe('jaccard', () => {
  test('identical sets → 1, disjoint → 0', () => {
    expect(jaccard(tokenize('alpha beta gamma'), tokenize('alpha beta gamma'))).toBe(1)
    expect(jaccard(tokenize('alpha beta'), tokenize('delta epsilon'))).toBe(0)
  })
  test('partial overlap is the exact ratio', () => {
    // {a,b,c} vs {b,c,d}: ∩={b,c}=2, ∪={a,b,c,d}=4 → 0.5
    expect(jaccard(tokenize('aa bb cc'), tokenize('bb cc dd'))).toBeCloseTo(0.5, 6)
  })
  test('two empty sets never match', () => {
    expect(jaccard(tokenize(''), tokenize(''))).toBe(0)
    expect(jaccard(tokenize('a'), tokenize(''))).toBe(0) // 'a' dropped → empty
  })
})

describe('clusterNearDuplicates', () => {
  const cand = (slug: string, text: string): DedupCandidate => ({ slug, text })

  test('groups near-duplicates and keeps distinct pages as singletons', () => {
    const items = [
      cand('acme', 'Acme is an enterprise SaaS company building developer tools'),
      cand('acme-inc', 'Acme Inc is an enterprise SaaS company building developer tools'),
      cand('globex', 'Globex is a logistics and freight-forwarding conglomerate'),
    ]
    const clusters = clusterNearDuplicates(items, DEFAULT_JACCARD_THRESHOLD)
    // acme + acme-inc collapse; globex stands alone.
    const bySize = clusters.map((c) => c.map((x) => x.slug).sort())
    expect(bySize).toContainEqual(['acme', 'acme-inc'])
    expect(bySize).toContainEqual(['globex'])
    expect(clusters.length).toBe(2)
  })

  test('clustering is transitive via connected components', () => {
    // Chain: A~B (share most tokens), B~C, but A and C alone are below the bar.
    const items = [
      cand('a', 'one two three four five common'),
      cand('b', 'two three four five six common'),
      cand('c', 'three four five six seven common'),
    ]
    const clusters = clusterNearDuplicates(items, 0.5)
    // If A~B and B~C at 0.5, all three land in ONE component.
    const withAB = clusters.find((c) => c.some((x) => x.slug === 'a'))
    expect(withAB?.map((x) => x.slug).sort()).toEqual(['a', 'b', 'c'])
  })

  test('a high threshold keeps merely-similar pages apart', () => {
    const items = [
      cand('x', 'alpha beta gamma delta'),
      cand('y', 'alpha beta gamma zeta'), // 3/5 = 0.6 overlap
    ]
    expect(clusterNearDuplicates(items, 0.9).length).toBe(2) // below 0.9 → not merged
    expect(clusterNearDuplicates(items, 0.5).length).toBe(1) // above 0.5 → merged
  })
})
