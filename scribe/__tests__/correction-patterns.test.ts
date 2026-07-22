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
  DEFAULT_CORRECTION_PATTERN_JACCARD,
  type CorrectionEntry,
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
})
