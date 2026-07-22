/**
 * @neutronai/scribe — deterministic correction-pattern clustering + composition
 * (Q2 overturn 2, tier-2 pure leaf). No I/O, no LLM.
 */

import { describe, expect, test } from 'bun:test'
import { SLUG_REGEX } from '@neutronai/runtime/entity-slug.ts'
import {
  clusterCorrections,
  composePatternPage,
  stablePatternSlug,
  resolveClusterSlug,
  correctionOccurrenceKey,
  DEFAULT_CORRECTION_PATTERN_JACCARD,
  type CorrectionEntry,
  type PriorPatternIdentity,
} from '../reflect/correction-patterns.ts'

/** Three near-identical "use tabs" corrections (share heavy token overlap). */
const TAB_1: CorrectionEntry = {
  id: 'c-aaa',
  ts: '2026-07-01T00:00:00.000Z',
  wrong: 'used spaces for indentation',
  right: 'use tabs for indentation',
  why: 'the repo convention is tabs',
}
const TAB_2: CorrectionEntry = {
  id: 'c-bbb',
  ts: '2026-07-02T00:00:00.000Z',
  wrong: 'used spaces for indentation again',
  right: 'use tabs for indentation',
  why: 'the repo convention is tabs',
}
const TAB_3: CorrectionEntry = {
  id: 'c-ccc',
  ts: '2026-07-03T00:00:00.000Z',
  wrong: 'indentation with spaces',
  right: 'use tabs for indentation',
  why: 'convention is tabs',
}
/** Two unrelated corrections. */
const OTHER_1: CorrectionEntry = {
  id: 'c-ddd',
  ts: '2026-07-04T00:00:00.000Z',
  wrong: 'called the endpoint synchronously',
  right: 'await the endpoint asynchronously',
  why: 'avoid blocking the event loop',
}
const OTHER_2: CorrectionEntry = {
  id: 'c-eee',
  ts: '2026-07-05T00:00:00.000Z',
  wrong: 'used the wrong contact',
  right: 'the primary email is on file',
  why: 'stated preference',
}

describe('clusterCorrections', () => {
  test('3 similar + 2 unrelated → one cluster of 3, seed is oldest', () => {
    const clusters = clusterCorrections(
      [TAB_1, TAB_2, TAB_3, OTHER_1, OTHER_2],
      DEFAULT_CORRECTION_PATTERN_JACCARD,
    )
    const bySize = clusters.map((c) => c.length).sort((a, b) => b - a)
    expect(bySize[0]).toBe(3)
    const tabCluster = clusters.find((c) => c.length === 3)!
    expect(tabCluster[0]!.id).toBe('c-aaa') // oldest by ts is the seed
  })

  test('ordering stability — shuffled input yields the same slug', () => {
    const a = clusterCorrections([TAB_1, TAB_2, TAB_3], DEFAULT_CORRECTION_PATTERN_JACCARD)
    const b = clusterCorrections([TAB_3, TAB_1, TAB_2], DEFAULT_CORRECTION_PATTERN_JACCARD)
    const seedA = composePatternPage(a.find((c) => c.length === 3)!).slug
    const seedB = composePatternPage(b.find((c) => c.length === 3)!).slug
    expect(seedA).toBe(seedB)
    expect(SLUG_REGEX.test(seedA)).toBe(true)
    expect(seedA.startsWith('correction-pattern-')).toBe(true)
  })
})

describe('stablePatternSlug — window invariance (Argus r2 minor)', () => {
  // Same recurring lesson, seen through a SLIDING 200-scan window: pass A sees
  // occurrences 1-3, a later pass sees 2-4 (occurrence 1 aged out, 4 arrived).
  // The slug MUST be identical so the reflect pass UPDATES the one page rather
  // than minting a duplicate (the old oldest-member-id slug drifted here).
  const TAB_4: CorrectionEntry = {
    id: 'c-fff',
    ts: '2026-07-06T00:00:00.000Z',
    wrong: 'spaces used for indentation',
    right: 'use tabs for indentation',
    why: 'repo convention tabs',
  }

  test('a window that drops the oldest member and gains a newer one keeps the slug', () => {
    const early = stablePatternSlug([TAB_1, TAB_2, TAB_3])
    const slid = stablePatternSlug([TAB_2, TAB_3, TAB_4])
    expect(slid).toBe(early)
  })

  test('a genuinely different lesson gets a different slug', () => {
    const tabs = stablePatternSlug([TAB_1, TAB_2, TAB_3])
    const other = stablePatternSlug([
      { id: 'x1', ts: '2026-08-01T00:00:00.000Z', wrong: 'blocked the loop', right: 'await the async endpoint', why: 'never block' },
      { id: 'x2', ts: '2026-08-02T00:00:00.000Z', wrong: 'sync call', right: 'await the async endpoint call', why: 'non-blocking' },
    ])
    expect(other).not.toBe(tabs)
    expect(SLUG_REGEX.test(other)).toBe(true)
  })

  // Argus r2 BLOCKER (2 reviewers): the interim majority-`right`-vocabulary digest
  // was NOT membership-independent — the "tokens present in a majority of the CURRENT
  // members" set shifts as members age in/out of the window, even when the SEED is
  // unchanged. Seed-derived identity fixes it: the reviewer's exact counterexample.
  test('slug is stable when the majority token set shifts but the seed is unchanged', () => {
    // Seed (oldest) is constant across both windows; only non-seed members change.
    const SEED: CorrectionEntry = { id: 'c-s', ts: '2026-09-01T00:00:00.000Z', wrong: 'w', right: 'alpha beta', why: 'y' }
    const M1: CorrectionEntry = { id: 'c-m1', ts: '2026-09-02T00:00:00.000Z', wrong: 'w', right: 'alpha gamma', why: 'y' }
    const M2: CorrectionEntry = { id: 'c-m2', ts: '2026-09-03T00:00:00.000Z', wrong: 'w', right: 'beta gamma', why: 'y' }
    const M3: CorrectionEntry = { id: 'c-m3', ts: '2026-09-04T00:00:00.000Z', wrong: 'w', right: 'gamma delta', why: 'y' }
    // Window A majority = {alpha,beta,gamma}; window B majority = {beta,gamma} — the
    // old scheme would have minted two slugs. Seed 'alpha beta' is constant → one slug.
    const windowA = stablePatternSlug([SEED, M1, M2])
    const windowB = stablePatternSlug([SEED, M2, M3])
    expect(windowB).toBe(windowA)
  })

  test('slug ignores caller ordering — derives from the oldest member regardless', () => {
    const a = stablePatternSlug([TAB_3, TAB_1, TAB_2])
    const b = stablePatternSlug([TAB_2, TAB_3, TAB_1])
    expect(b).toBe(a)
  })
})

describe('composePatternPage', () => {
  test('slug is SLUG_REGEX-safe + window-invariant; title/learning from the newest', () => {
    const page = composePatternPage([TAB_1, TAB_2, TAB_3])
    expect(page.slug).toBe(stablePatternSlug([TAB_1, TAB_2, TAB_3]))
    expect(SLUG_REGEX.test(page.slug)).toBe(true)
    // Newest member's `right` is the durable learning line + title.
    expect(page.title).toContain('use tabs for indentation')
    expect(page.compiledTruth).toContain('use tabs for indentation')
    expect(page.compiledTruth).toContain('Observed 3 times')
    // One timeline row per occurrence.
    expect(page.timelineRows).toHaveLength(3)
    expect(page.timelineRows.every((r) => r.source === 'reflect:correction-pattern')).toBe(true)
    expect(page.timelineRows[0]!.body).toContain('→')
  })

  test('a slug override is honoured verbatim (pass-resolved identity)', () => {
    const page = composePatternPage([TAB_1, TAB_2, TAB_3], 'correction-pattern-forced')
    expect(page.slug).toBe('correction-pattern-forced')
    // Body/title still derive from the cluster; only identity is overridden.
    expect(page.compiledTruth).toContain('use tabs for indentation')
  })

  test('a timeline row body byte-matches the occurrence key body half', () => {
    const page = composePatternPage([TAB_1])
    const parts = correctionOccurrenceKey(TAB_1).split('\x1f')
    expect(page.timelineRows[0]!.ts).toBe(parts[0]!)
    expect(page.timelineRows[0]!.body).toBe(parts[1]!)
  })
})

// Argus r3 (both reviewers VETO): `stablePatternSlug` alone still drifts when the
// scan window ages the ORIGINAL seed out — the next seed's `right` can differ and
// mint a new slug. `resolveClusterSlug` closes it: a cluster reuses an already-
// promoted page's slug whenever it still shares an occurrence with it.
describe('resolveClusterSlug — identity survives seed eviction', () => {
  // A recurring lesson whose members share enough whole-text to cluster, but whose
  // per-member `right` differs — so the seed-derived fallback slug MOVES when the
  // oldest member ages out.
  const S0: CorrectionEntry = { id: 'c-s0', ts: '2026-12-01T00:00:00.000Z', wrong: 'w1 w2 w3 w4', right: 'correct alpha behavior', why: 'reason common shared' }
  const M1: CorrectionEntry = { id: 'c-m1', ts: '2026-12-02T00:00:00.000Z', wrong: 'w1 w2 w3 w4', right: 'correct beta behavior', why: 'reason common shared' }
  const M2: CorrectionEntry = { id: 'c-m2', ts: '2026-12-03T00:00:00.000Z', wrong: 'w1 w2 w3 w4', right: 'correct gamma behavior', why: 'reason common shared' }
  const M3: CorrectionEntry = { id: 'c-m3', ts: '2026-12-04T00:00:00.000Z', wrong: 'w1 w2 w3 w4', right: 'correct delta behavior', why: 'reason common shared' }

  test('the fallback slug genuinely DRIFTS once the seed is evicted (proves the bug exists)', () => {
    const windowA = stablePatternSlug([S0, M1, M2]) // seed S0 → right "correct alpha behavior"
    const windowB = stablePatternSlug([M1, M2, M3]) // seed now M1 → right "correct beta behavior"
    expect(windowB).not.toBe(windowA) // identity drift — the defect
  })

  test('reuses the promoted page identity when the cluster still overlaps it', () => {
    const promotedSlug = stablePatternSlug([S0, M1, M2])
    // The page recorded occurrences for S0, M1, M2 (keys byte-match the live cluster).
    const prior: PriorPatternIdentity = {
      slug: promotedSlug,
      occurrenceKeys: new Set([S0, M1, M2].map(correctionOccurrenceKey)),
    }
    // Later pass: seed S0 aged out, M3 arrived. Fallback would drift; resolve reuses.
    const resolved = resolveClusterSlug([M1, M2, M3], [prior])
    expect(resolved).toBe(promotedSlug)
    expect(resolved).not.toBe(stablePatternSlug([M1, M2, M3]))
  })

  test('a genuinely new cluster (no overlap) falls back to the seed slug', () => {
    const prior: PriorPatternIdentity = {
      slug: stablePatternSlug([S0, M1, M2]),
      occurrenceKeys: new Set([S0, M1, M2].map(correctionOccurrenceKey)),
    }
    const fresh = resolveClusterSlug([OTHER_1, OTHER_2, { id: 'c-o3', ts: '2027-01-01T00:00:00.000Z', wrong: 'sync again', right: 'await the endpoint asynchronously', why: 'non-blocking' }], [prior])
    expect(fresh).toBe(stablePatternSlug([OTHER_1, OTHER_2, { id: 'c-o3', ts: '2027-01-01T00:00:00.000Z', wrong: 'sync again', right: 'await the endpoint asynchronously', why: 'non-blocking' }]))
  })

  test('greatest-overlap wins; equal overlap breaks to the lexicographically-smaller slug', () => {
    const zzz: PriorPatternIdentity = { slug: 'correction-pattern-zzz', occurrenceKeys: new Set([correctionOccurrenceKey(M1)]) }
    const aaa: PriorPatternIdentity = { slug: 'correction-pattern-aaa', occurrenceKeys: new Set([correctionOccurrenceKey(M1)]) }
    // Both overlap on M1 only (equal) → smaller slug wins deterministically.
    expect(resolveClusterSlug([M1, M2, M3], [zzz, aaa])).toBe('correction-pattern-aaa')
    // A prior with STRICTLY more overlap beats the lexicographic tie-break.
    const two: PriorPatternIdentity = { slug: 'correction-pattern-zzz', occurrenceKeys: new Set([M1, M2].map(correctionOccurrenceKey)) }
    expect(resolveClusterSlug([M1, M2, M3], [two, aaa])).toBe('correction-pattern-zzz')
  })
})

// Argus r3 nit: a ts-tie must NOT let seed selection depend on input/scan order.
describe('stablePatternSlug — deterministic ts-tie break by id', () => {
  const P_HI: CorrectionEntry = { id: 'c-bbb', ts: '2027-02-01T00:00:00.000Z', wrong: 'w', right: 'foo bar', why: 'y' }
  const P_LO: CorrectionEntry = { id: 'c-aaa', ts: '2027-02-01T00:00:00.000Z', wrong: 'w', right: 'baz qux', why: 'y' } // SAME ts, smaller id
  const P_NEW: CorrectionEntry = { id: 'c-ccc', ts: '2027-02-02T00:00:00.000Z', wrong: 'w', right: 'later thing', why: 'y' }

  test('equal-ts members in either input order yield the SAME slug (id tie-break)', () => {
    const a = stablePatternSlug([P_HI, P_LO, P_NEW])
    const b = stablePatternSlug([P_LO, P_HI, P_NEW])
    expect(b).toBe(a)
  })

  test("the seed is the smaller-id member (its `right` drives the slug)", () => {
    // P_LO (id c-aaa) is the seed → slug derives from "baz qux", not "foo bar".
    expect(stablePatternSlug([P_HI, P_LO, P_NEW])).toBe(stablePatternSlug([P_LO]))
    expect(stablePatternSlug([P_HI, P_LO, P_NEW])).not.toBe(stablePatternSlug([P_HI]))
  })
})
