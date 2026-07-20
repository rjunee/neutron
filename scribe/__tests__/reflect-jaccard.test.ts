/**
 * RB3 reflect — Jaccard near-duplicate clustering (pure, deterministic).
 *   - tokenisation is a set (case-folded, short tokens dropped)
 *   - Jaccard value is |∩|/|∪|; empty sets never "match"
 *   - `stripBoilerplate` removes template scaffolding (heading lines + the
 *     `Mentioned in chat (kind: X).` fact-less body) before scoring
 *   - clustering groups near-duplicates, keeps distinct pages apart, forms
 *     CLIQUES (NOT transitive chains), and never merges a fact-less page
 *
 * DATA-INTEGRITY (memory blocker 1): the reproduced defect — five fact-less
 * company pages fusing into ONE entity in a single pass — is pinned below and
 * must stay fixed.
 */

import { describe, test, expect } from 'bun:test'
import {
  tokenize,
  jaccard,
  clusterNearDuplicates,
  stripBoilerplate,
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

  test('non-ASCII (CJK) content tokenizes and matches when identical', () => {
    // A plain [^a-z0-9] split would drop every CJK char → empty set → never match.
    const jp = '株式会社アクメは開発者ツールを構築する会社です'
    const toks = tokenize(jp)
    expect(toks.size).toBeGreaterThan(1) // segmented into real word tokens
    expect(jaccard(toks, tokenize(jp))).toBe(1) // identical CJK strings match
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

  test('clustering forms CLIQUES, not transitive chains (memory blocker 1, guard c)', () => {
    // Chain: A~B and B~C above the bar, but A and C are BELOW it.
    //   {one..five,common} vs {two..six,common}  → 5/7 ≈ 0.71  (A~B, B~C)
    //   {one..five,common} vs {three..seven,common} → 4/8 = 0.5 (A~C, below 0.6)
    const items = [
      cand('a', 'one two three four five common'),
      cand('b', 'two three four five six common'),
      cand('c', 'three four five six seven common'),
    ]
    const clusters = clusterNearDuplicates(items, 0.6)
    // Connected components would have fused {a,b,c}; cliques must NOT — C is not
    // similar enough to A to share A's cluster. A joins B; C stands apart.
    const withA = clusters.find((c) => c.some((x) => x.slug === 'a'))
    expect(withA?.map((x) => x.slug).sort()).toEqual(['a', 'b'])
    const withC = clusters.find((c) => c.some((x) => x.slug === 'c'))
    expect(withC?.map((x) => x.slug)).toEqual(['c']) // C is its own singleton
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

describe('stripBoilerplate', () => {
  test('removes heading lines and the fact-less template sentence, keeps real prose', () => {
    const factless = stripBoilerplate('Acme\n# Acme\n\nMentioned in chat (kind: company).\n')
    expect(factless).not.toContain('Mentioned in chat')
    expect(factless).not.toContain('# Acme')
    expect(tokenize(factless).has('mentioned')).toBe(false)
    expect(tokenize(factless).has('chat')).toBe(false)
    expect(tokenize(factless).has('acme')).toBe(true) // the name (from the title) survives
    // A real prose sentence that merely contains "company" is untouched.
    const real = stripBoilerplate('Globex is a logistics company founded by [[jane]].')
    expect(real).toContain('logistics company')
  })

  test('strips ONLY generated section headings; KEEPS hand-authored factual headings (blocker 1 VETO)', () => {
    // The generated scaffolding labels are boilerplate; a factual heading is not.
    const body =
      'Acme\n# Acme\n\nAcme is a payments startup.\n\n## Acquired by Globex\n\nBought in 2024.\n\n## Relationships\n\n- Works at [[globex]].\n'
    const out = stripBoilerplate(body)
    // Generated H1 title + `## Relationships` scaffolding → gone.
    expect(out).not.toContain('# Acme')
    expect(out).not.toContain('## Relationships')
    // Hand-authored factual heading → PRESERVED (its tokens must survive to keep
    // distinct pages apart; the old strip-every-heading regex erased these).
    expect(out).toContain('## Acquired by Globex')
    const toks = tokenize(out)
    expect(toks.has('acquired')).toBe(true)
    expect(toks.has('globex')).toBe(true)
    expect(toks.has('relationships')).toBe(false) // scaffolding token dropped
  })

  test('strips the reserved-kind fact-less synthesis fallback sentence', () => {
    const out = stripBoilerplate('Kickoff\n# Kickoff\n\nIdentified during reflect (meeting).\n')
    expect(out).not.toContain('Identified during reflect')
    expect(tokenize(out).has('identified')).toBe(false)
    expect(tokenize(out).has('reflect')).toBe(false)
  })
})

describe('memory blocker 1 — fact-less pages must NOT fuse (reproduce-then-fix)', () => {
  // Exactly what write-to-gbrain `composeNewCompiledTruth` emits for a fact-less
  // page, wrapped as reflect-pass builds the candidate: `${title}\n${compiledTruth}`.
  const factless = (name: string, slug: string): DedupCandidate => ({
    slug,
    text: `${name}\n# ${name}\n\nMentioned in chat (kind: company).\n`,
  })
  const five = [
    factless('Acme', 'acme'),
    factless('Globex', 'globex'),
    factless('Initech', 'initech'),
    factless('Umbrella', 'umbrella'),
    factless('Soylent', 'soylent'),
  ]

  test('five fact-less company pages stay SEPARATE (they collapsed into one on old main)', () => {
    // On the pre-fix code these all shared ~6 boilerplate tokens and scored ~0.71
    // Jaccard, fusing transitively into a SINGLE entity. After the fix each strips
    // to just its name ({acme}, {globex}, …) → no shared tokens → five singletons.
    const clusters = clusterNearDuplicates(five)
    expect(clusters.length).toBe(5)
    for (const c of clusters) expect(c.length).toBe(1)
  })

  test('a page reduced to < 2 distinguishing tokens is never a merge candidate (guard b)', () => {
    // Two DIFFERENT single-word fact-less names: even at threshold 0 they must not
    // merge, because each strips to a 1-token set and the min-token gate forces a
    // singleton before similarity is even considered.
    const clusters = clusterNearDuplicates([factless('Acme', 'acme'), factless('Globex', 'globex')], 0)
    expect(clusters.length).toBe(2)
  })

  test('distinct pages with different FACTUAL headings do NOT falsely merge (blocker 1 VETO)', () => {
    // Two genuinely-different companies that share a generic one-line description
    // but are distinguished ONLY by a hand-authored factual heading. Under the old
    // strip-EVERY-heading regex those headings were erased, so both pages reduced to
    // {name + shared-description tokens} and scored ~0.75 Jaccard → they FUSED
    // irreversibly into one entity. Keeping the factual headings restores each
    // page's distinguishing tokens, dropping the score well below 0.7.
    const withHeading = (name: string, slug: string, heading: string): DedupCandidate => ({
      slug,
      // Identical prose blob → without the headings these look like near-duplicates.
      text: `${name}\n# ${name}\n\nA company in the technology sector based in the bay area.\n\n## ${heading}\n`,
    })
    const items = [
      withHeading('Acme', 'acme', 'Acquired by Globex in 2024'),
      withHeading('Zeta', 'zeta', 'Independent and privately held since 1999'),
    ]
    const clusters = clusterNearDuplicates(items)
    expect(clusters.length).toBe(2) // FAILS on old strip-all-headings (they merge into 1)
    for (const c of clusters) expect(c.length).toBe(1)
  })

  test('genuine near-duplicates (same entity, overlapping REAL facts) STILL cluster', () => {
    // Real dedup must not be broken by the boilerplate fix.
    const items: DedupCandidate[] = [
      {
        slug: 'acme',
        text:
          'Acme\n# Acme\n\nAcme is a fintech startup based in Berlin, founded by [[jane-doe]]. It raised a Series A in 2023 and builds developer payment tooling.\n',
      },
      {
        slug: 'acme-inc',
        text:
          'Acme Inc\n# Acme Inc\n\nAcme is a fintech startup based in Berlin, founded by [[jane-doe]]. Raised a Series A in 2023 and builds developer payment tooling.\n',
      },
    ]
    const clusters = clusterNearDuplicates(items)
    expect(clusters.length).toBe(1)
    expect(clusters[0]!.map((c) => c.slug).sort()).toEqual(['acme', 'acme-inc'])
  })
})
