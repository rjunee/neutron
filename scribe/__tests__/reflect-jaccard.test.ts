/**
 * RB3 reflect — Jaccard near-duplicate clustering (pure, deterministic).
 *
 * Data-integrity contract (memory-system-design-2026-07-20 blockers 1 & 3 —
 * dedup must never fuse UNRELATED entities):
 *   - tokenise is a set (case-folded); it KEEPS numeric/alphanumeric tokens
 *     (`2024`,`q1`,`v2`) and drops only single ASCII letters + pure punctuation.
 *   - `stripBoilerplate` removes ONLY generated boilerplate (title H1 == title,
 *     `## Relationships`/`## Merged`, `Mentioned in chat (kind: X).`) and NEVER a
 *     hand-authored factual heading.
 *   - clustering groups CLIQUES (every pair ≥ threshold), NOT connected
 *     components — a chain `A~B~C` with `A~C` below the bar does not fuse.
 *   - a page with fewer than `MIN_DISTINGUISHING_TOKENS` non-boilerplate tokens is
 *     never a merge candidate (fact-less boilerplate pages stay apart).
 *   - genuine near-duplicates (same entity, overlapping real facts) still merge.
 */

import { describe, test, expect } from 'bun:test'
import {
  tokenize,
  stripBoilerplate,
  jaccard,
  clusterNearDuplicates,
  isMergeSafeCluster,
  DEFAULT_JACCARD_THRESHOLD,
  MIN_DISTINGUISHING_TOKENS,
  type DedupCandidate,
} from '../reflect/jaccard.ts'

describe('tokenize', () => {
  test('lowercases, drops single ASCII letters + punctuation, dedups', () => {
    const t = tokenize('Acme Inc. — a B2B SaaS! (acme)')
    expect(t.has('acme')).toBe(true)
    expect(t.has('inc')).toBe(true)
    expect(t.has('b2b')).toBe(true)
    expect(t.has('saas')).toBe(true)
    expect(t.has('a')).toBe(false) // single ASCII letter dropped
    expect([...t].filter((x) => x === 'acme').length).toBe(1) // set, not bag
  })

  // Blocker 3 (ISSUES #373): Intl.Segmenter marks bare numeric/alphanumeric
  // tokens isWordLike=false; the old `continue` DROPPED them, so year/version/
  // quarter discriminators vanished and distinct pages collapsed.
  test('KEEPS numeric + alphanumeric discriminator tokens', () => {
    expect([...tokenize('2024')]).toEqual(['2024'])
    expect([...tokenize('q1')]).toEqual(['q1'])
    expect([...tokenize('v2')]).toEqual(['v2'])
    // A year inside prose survives as its own token.
    expect(tokenize('Fiscal Year 2024 Budget').has('2024')).toBe(true)
    // Single digits are kept (a real discriminator, unlike filler letter `a`).
    expect(tokenize('version 5').has('5')).toBe(true)
  })

  test('non-ASCII (CJK) content tokenizes and matches when identical', () => {
    const jp = '株式会社アクメは開発者ツールを構築する会社です'
    const toks = tokenize(jp)
    expect(toks.size).toBeGreaterThan(1)
    expect(jaccard(toks, tokenize(jp))).toBe(1)
  })
})

describe('stripBoilerplate (generated-only)', () => {
  test('strips the generated title H1 (label == title) but KEEPS a factual heading', () => {
    const stripped = stripBoilerplate('# Acme\n\n## Acquired by Globex', 'Acme')
    const toks = tokenize(stripped)
    // The title H1 `# Acme` is gone (the name token is the title, kept separately).
    expect(stripped).not.toContain('# Acme')
    // The hand-authored factual heading survives → its distinguishing tokens stay.
    expect(toks.has('globex')).toBe(true)
    expect(toks.has('acquired')).toBe(true)
  })

  test('a factual H1 whose label != title is KEPT (never over-stripped)', () => {
    // #415 over-reach stripped ALL H1s. Here a factual `# Acquired by Globex` on an
    // Acme page keeps its tokens because its label is not the title.
    const stripped = stripBoilerplate('# Acquired by Globex\n\nSome prose.', 'Acme')
    expect(stripped).toContain('# Acquired by Globex')
    expect(tokenize(stripped).has('globex')).toBe(true)
  })

  test('strips generated section headings + the fact-less mentioned-line', () => {
    const body = '# Acme\n\nMentioned in chat (kind: company).\n\n## Relationships\n\n- Works at [[globex]].'
    const stripped = stripBoilerplate(body, 'Acme')
    expect(stripped).not.toContain('# Acme')
    expect(stripped).not.toContain('Mentioned in chat')
    expect(stripped).not.toContain('## Relationships')
    // A real relation line survives.
    expect(stripped).toContain('[[globex]]')
  })
})

describe('jaccard', () => {
  test('identical sets → 1, disjoint → 0', () => {
    expect(jaccard(tokenize('alpha beta gamma'), tokenize('alpha beta gamma'))).toBe(1)
    expect(jaccard(tokenize('alpha beta'), tokenize('delta epsilon'))).toBe(0)
  })
  test('partial overlap is the exact ratio', () => {
    expect(jaccard(tokenize('aa bb cc'), tokenize('bb cc dd'))).toBeCloseTo(0.5, 6)
  })
  test('two empty sets never match', () => {
    expect(jaccard(tokenize(''), tokenize(''))).toBe(0)
    expect(jaccard(tokenize('a'), tokenize(''))).toBe(0)
  })
})

describe('clusterNearDuplicates — no fusion of unrelated entities', () => {
  const boiler = (kind = 'company'): string => `Mentioned in chat (kind: ${kind}).`
  const factless = (name: string): DedupCandidate => ({
    slug: name.toLowerCase(),
    title: name,
    text: `# ${name}\n\n${boiler()}`,
  })

  // Blocker 1 headline: five fact-less boilerplate company pages fused into ONE
  // entity transitively on main. They must NOT cluster now.
  test('five fact-less boilerplate pages do NOT cluster (blocker 1 headline)', () => {
    const pages = ['Acme', 'Globex', 'Initech', 'Umbrella', 'Soylent'].map(factless)
    const clusters = clusterNearDuplicates(pages)
    expect(clusters.length).toBe(5) // all singletons
    for (const c of clusters) expect(c.length).toBe(1)
  })

  // Blocker 3: two fiscal-year pages whose only discriminator is the year.
  test('fiscal-year pages stay distinct (numeric discriminator survives)', () => {
    const fy = (y: string): DedupCandidate => ({
      slug: `fy${y}`,
      title: `Fiscal Year ${y} Budget`,
      text: `# Fiscal Year ${y} Budget\n\nMentioned in chat (kind: concept).`,
    })
    const clusters = clusterNearDuplicates([fy('2023'), fy('2024')])
    expect(clusters.length).toBe(2)
  })

  test('v1/v2 and Q1/Q2 variants stay distinct', () => {
    const p = (slug: string, title: string): DedupCandidate => ({
      slug,
      title,
      text: `# ${title}\n\nMentioned in chat (kind: project).`,
    })
    expect(clusterNearDuplicates([p('proj-v1', 'Project V1'), p('proj-v2', 'Project V2')]).length).toBe(2)
    expect(clusterNearDuplicates([p('rep-q1', 'Report Q1'), p('rep-q2', 'Report Q2')]).length).toBe(2)
  })

  test('two pages distinguished ONLY by a factual heading do not fuse (heading kept)', () => {
    // Both share the same generated boilerplate; the ONLY distinguishing content is
    // a hand-authored factual heading. Stripping the boilerplate keeps the heading.
    const a: DedupCandidate = { slug: 'a', title: 'Deal', text: '# Deal\n\nMentioned in chat (kind: concept).\n\n## Acquired by Globex' }
    const b: DedupCandidate = { slug: 'b', title: 'Deal', text: '# Deal\n\nMentioned in chat (kind: concept).\n\n## Acquired by Umbrella' }
    expect(clusterNearDuplicates([a, b]).length).toBe(2)
  })
})

describe('clusterNearDuplicates — clique, min-token, and real dedup', () => {
  test('genuine near-duplicates (same entity, real overlapping facts) STILL cluster', () => {
    const items: DedupCandidate[] = [
      { slug: 'acme', title: 'Acme', text: '# Acme\n\nAcme is an enterprise SaaS company building developer tools for teams.' },
      { slug: 'acme-inc', title: 'Acme Inc', text: '# Acme Inc\n\nAcme is an enterprise SaaS company building developer tools for teams.' },
      { slug: 'globex', title: 'Globex', text: '# Globex\n\nGlobex is a logistics and freight-forwarding conglomerate operating worldwide.' },
    ]
    const clusters = clusterNearDuplicates(items)
    const bySlug = clusters.map((c) => c.map((x) => x.slug).sort())
    expect(bySlug).toContainEqual(['acme', 'acme-inc'])
    expect(bySlug).toContainEqual(['globex'])
    expect(clusters.length).toBe(2)
  })

  // Blocker 1c-i: NO transitive closure. A~B and B~C but A~C below the bar → the
  // whole {A,B,C} must NOT fuse (only the clique {A,B} may).
  test('clustering requires a CLIQUE — a chain does NOT fuse transitively', () => {
    // Shared title token ('doc') + text engineered so a~b and b~c clear 0.5 while
    // a~c falls below it — the classic chain a connected-components pass would fuse.
    const items: DedupCandidate[] = [
      { slug: 'a', title: 'Doc', text: 'pp qq rr ss mm nn' },
      { slug: 'b', title: 'Doc', text: 'pp qq rr ss xx yy' },
      { slug: 'c', title: 'Doc', text: 'pp qq xx yy kk ll' },
    ]
    const clusters = clusterNearDuplicates(items, 0.5)
    // Connected-components would give {a,b,c}; clique gives {a,b} + {c}.
    const withA = clusters.find((c) => c.some((x) => x.slug === 'a'))!.map((x) => x.slug).sort()
    expect(withA).toEqual(['a', 'b']) // c is NOT dragged in
    expect(clusters.some((c) => c.length === 1 && c[0]!.slug === 'c')).toBe(true)
  })

  // Blocker 1c-ii: a page below the min-token gate is never a merge candidate.
  test('a page with < MIN_DISTINGUISHING_TOKENS is never merged (own singleton)', () => {
    expect(MIN_DISTINGUISHING_TOKENS).toBe(2)
    // Two pages whose ONLY non-boilerplate token is an identical single word — each
    // has 1 distinguishing token (< 2) so neither is a merge candidate.
    const a: DedupCandidate = { slug: 'a', title: 'Zeta', text: '# Zeta\n\nMentioned in chat (kind: company).' }
    const b: DedupCandidate = { slug: 'b', title: 'Zeta', text: '# Zeta\n\nMentioned in chat (kind: company).' }
    const clusters = clusterNearDuplicates([a, b])
    expect(clusters.length).toBe(2) // NOT fused despite identical single token
  })

  test('threshold is configurable', () => {
    const items: DedupCandidate[] = [
      { slug: 'x', title: 'X', text: 'alpha beta gamma delta' },
      { slug: 'y', title: 'Y', text: 'alpha beta gamma zeta' }, // 3/5 tokens shared incl. titles
    ]
    // High bar keeps them apart; low bar merges — same corpus, threshold-driven.
    expect(clusterNearDuplicates(items, 0.95).length).toBe(2)
    expect(clusterNearDuplicates(items, 0.4).length).toBe(1)
    expect(DEFAULT_JACCARD_THRESHOLD).toBe(0.7)
  })

  // Residual B (Argus r1, verified by running this code): two DIFFERENT-named
  // entities that each assert the SAME ≥ 3 relation targets reach the 0.7 bar at
  // the CLUSTERING layer, because relation-VERB tokens (`works`,`at`) are not
  // stripped and the shared targets inflate overlap. Clustering still groups them
  // (characterization — the clustering layer is intentionally unchanged); the
  // FUSION is now blocked one layer up by `isMergeSafeCluster` (Gate A: no shared
  // name token). See the `isMergeSafeCluster` block below for the gate assertion.
  test('residual B: different-named entities sharing ≥3 relation targets score 0.714 and still CLUSTER', () => {
    const orgs = ['org0', 'org1', 'org2']
    const rels = orgs.map((o) => `Works at [[${o}]].`).join('\n')
    const bob: DedupCandidate = { slug: 'bob', title: 'Bob', text: `# Bob\n\n${rels}` }
    const carol: DedupCandidate = { slug: 'carol', title: 'Carol', text: `# Carol\n\n${rels}` }
    const st = (c: DedupCandidate): Set<string> => {
      const s = tokenize(c.title)
      for (const t of tokenize(stripBoilerplate(c.text, c.title))) s.add(t)
      return s
    }
    // Verb tokens + shared targets survive the boilerplate strip → 5/7 overlap.
    expect(jaccard(st(bob), st(carol))).toBeCloseTo(0.7142857, 5)
    // ...which is ≥ DEFAULT_JACCARD_THRESHOLD, so they still CLUSTER (candidacy)...
    expect(clusterNearDuplicates([bob, carol]).length).toBe(1)
    // ...but the merge gate HOLDS them (different names → Gate A) so no fusion.
    expect(isMergeSafeCluster([bob, carol]).safe).toBe(false)
  })
})

describe('isMergeSafeCluster (§7.2 merge safety gate — arming precondition)', () => {
  // Residual A — two DISTINCT fact-less entities sharing an identical name score
  // 1.0 (identical name tokens, empty body) and cluster, but must NOT fuse: there
  // is nothing beyond the name to prove they are the same entity, and a false
  // fusion is irreversible.
  test('residual A: two distinct fact-less same-name pages are HELD (name-only similarity)', () => {
    const boiler = (name: string): string => `# ${name}\n\nMentioned in chat (kind: person).`
    const a: DedupCandidate = { slug: 'john-smith', title: 'John Smith', text: boiler('John Smith') }
    const b: DedupCandidate = { slug: 'john-smith-2', title: 'John Smith', text: boiler('John Smith') }
    // They DO cluster (identical name tokens → similarity 1.0)...
    expect(clusterNearDuplicates([a, b]).length).toBe(1)
    // ...but the gate holds them: body-only similarity is 0 once the name is excluded.
    const gate = isMergeSafeCluster([a, b])
    expect(gate.safe).toBe(false)
    if (!gate.safe) expect(gate.reason).toContain('residual A')
  })

  // Residual B — different names, shared relation targets → held by Gate A.
  test('residual B: different-named entities sharing relation targets are HELD (no shared name token)', () => {
    const rels = ['org0', 'org1', 'org2'].map((o) => `Works at [[${o}]].`).join('\n')
    const bob: DedupCandidate = { slug: 'bob', title: 'Bob', text: `# Bob\n\n${rels}` }
    const carol: DedupCandidate = { slug: 'carol', title: 'Carol', text: `# Carol\n\n${rels}` }
    const gate = isMergeSafeCluster([bob, carol])
    expect(gate.safe).toBe(false)
    if (!gate.safe) expect(gate.reason).toContain('residual B')
  })

  // The gate must NOT over-hold genuine near-duplicates: shared name token AND
  // substantial shared factual body beyond the name → SAFE to merge.
  test('genuine near-duplicates (shared name + shared body facts) are SAFE to merge', () => {
    const body =
      'is an enterprise SaaS company building developer tooling for platform teams. Advises [[globex]].'
    const acme: DedupCandidate = { slug: 'acme', title: 'Acme', text: `# Acme\n\nAcme ${body}` }
    const acmeInc: DedupCandidate = {
      slug: 'acme-inc',
      title: 'Acme Inc',
      text: `# Acme Inc\n\nAcme Inc ${body}`,
    }
    expect(isMergeSafeCluster([acme, acmeInc]).safe).toBe(true)
  })

  // A singleton or empty cluster is trivially safe (never a fuse).
  test('a singleton cluster is trivially safe', () => {
    const solo: DedupCandidate = { slug: 'solo', title: 'Solo', text: '# Solo\n\nA fact.' }
    expect(isMergeSafeCluster([solo]).safe).toBe(true)
    expect(isMergeSafeCluster([]).safe).toBe(true)
  })
})
