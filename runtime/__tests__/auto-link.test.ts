/**
 * Sprint B — runtime/auto-link.ts test suite.
 *
 * Plan: docs/plans/2026-05-09-gbrain-methodology-integration-v2.md § 9.3.
 *
 * Acceptance gate #1: 50-page fixture corpus from gbrain docs; expected
 *                     triple sets match.
 * Acceptance gate (risk): code-fence false positives MUST NOT yield
 *                         triples for entity names mentioned inside fenced
 *                         code blocks or inline code spans.
 */

import { describe, expect, test } from 'bun:test'
import { extractTypedLinks, PREDICATES, type Triple } from '../auto-link.ts'

function sortTriples(t: Triple[]): Triple[] {
  return [...t].sort((a, b) => {
    if (a.predicate !== b.predicate) return a.predicate < b.predicate ? -1 : 1
    if (a.subject !== b.subject) return a.subject < b.subject ? -1 : 1
    return a.object < b.object ? -1 : 1
  })
}

describe('runtime/auto-link', () => {
  describe('predicate vocabulary', () => {
    test('exposes seven initial predicates', () => {
      expect([...PREDICATES]).toEqual([
        'founded',
        'invested_in',
        'advises',
        'works_at',
        'attended',
        'met',
        'mentions',
      ])
    })
  })

  describe('basic wikilink extraction', () => {
    test('emits `mentions` for a plain wikilink with no verb context', () => {
      const triples = extractTypedLinks('Some context [[acme]] over here.', 'sam')
      expect(triples).toEqual([
        { subject: 'sam', predicate: 'mentions', object: 'acme', source: 'sam' },
      ])
    })

    test('normalises wikilink display aliases', () => {
      const triples = extractTypedLinks('See [[acme|Acme Inc.]] for details.', 'sam')
      expect(triples.length).toBe(1)
      expect(triples[0]!.object).toBe('acme')
    })

    test('skips self-references', () => {
      const triples = extractTypedLinks('This page is about [[sam]] himself.', 'sam')
      expect(triples).toEqual([])
    })

    test('dedupes repeated references', () => {
      const body = '[[acme]] is great. [[acme]] is also great. [[acme]] again.'
      const triples = extractTypedLinks(body, 'sam')
      expect(triples).toHaveLength(1)
    })
  })

  describe('markdown-link reference shape', () => {
    test('extracts a slug from a bare-slug markdown link target', () => {
      const triples = extractTypedLinks(
        'Per the [Acme overview](acme) we should follow up.',
        'sam',
      )
      expect(triples).toEqual([
        { subject: 'sam', predicate: 'mentions', object: 'acme', source: 'sam' },
      ])
    })

    test('strips category prefix and .md extension', () => {
      const triples = extractTypedLinks(
        'Met [Sarah](people/sarah-chen.md) at the offsite.',
        'sam',
      )
      expect(triples).toEqual([
        { subject: 'sam', predicate: 'met', object: 'sarah-chen', source: 'sam' },
      ])
    })

    test('ignores external URLs in markdown link targets', () => {
      const triples = extractTypedLinks(
        'See [the press release](https://acme.example.com) for context.',
        'sam',
      )
      expect(triples).toEqual([])
    })

    test('ignores anchor and absolute-path targets', () => {
      const triples = extractTypedLinks(
        'Jump to [§ summary](#summary) or [the readme](/README.md).',
        'sam',
      )
      expect(triples).toEqual([])
    })

    test('ignores path-escape targets', () => {
      const triples = extractTypedLinks(
        'Confidential [archive](../../etc/passwd) — do not link.',
        'sam',
      )
      expect(triples).toEqual([])
    })
  })

  describe('verb-based inference cascade', () => {
    test('`founded` wins over `works_at` for the same sentence', () => {
      const triples = extractTypedLinks(
        'Sam founded [[acme]] and currently runs the company.',
        'sam',
      )
      expect(triples).toEqual([
        { subject: 'sam', predicate: 'founded', object: 'acme', source: 'sam' },
      ])
    })

    test('infers `invested_in` from "invested in"', () => {
      const triples = extractTypedLinks(
        'Bob invested in [[acme]] back in 2022.',
        'bob',
      )
      expect(triples).toEqual([
        {
          subject: 'bob',
          predicate: 'invested_in',
          object: 'acme',
          source: 'bob',
        },
      ])
    })

    test('infers `invested_in` from "led the round in"', () => {
      const triples = extractTypedLinks(
        'Sequoia led the round in [[acme]] this quarter.',
        'sequoia',
      )
      expect(triples[0]!.predicate).toBe('invested_in')
    })

    test('infers `advises`', () => {
      const triples = extractTypedLinks('Carol advises [[acme]] on infra.', 'carol')
      expect(triples[0]!.predicate).toBe('advises')
    })

    test('infers `advises` from "advisor to"', () => {
      const triples = extractTypedLinks(
        'Carol is an advisor to [[acme]] on infra.',
        'carol',
      )
      expect(triples[0]!.predicate).toBe('advises')
    })

    test('infers `works_at` from "CEO of"', () => {
      const triples = extractTypedLinks('She is the CEO of [[acme]].', 'sarah')
      expect(triples[0]!.predicate).toBe('works_at')
    })

    test('infers `works_at` from "works at"', () => {
      const triples = extractTypedLinks('Bob works at [[acme]].', 'bob')
      expect(triples[0]!.predicate).toBe('works_at')
    })

    test('Codex r1 P2: infers `works_at` from bare "joined <slug>"', () => {
      const triples = extractTypedLinks('Frank joined [[acme]] last quarter.', 'frank')
      expect(triples[0]!.predicate).toBe('works_at')
    })

    test('Codex r1 P2: infers `works_at` from "joined <slug> as <role>"', () => {
      const triples = extractTypedLinks(
        'Frank joined [[acme]] as a PM last quarter.',
        'frank',
      )
      expect(triples[0]!.predicate).toBe('works_at')
    })

    test('Codex r1 P2: infers `works_at` from "joined as <role> at <slug>"', () => {
      const triples = extractTypedLinks(
        'Frank joined as a senior engineer at [[acme]].',
        'frank',
      )
      expect(triples[0]!.predicate).toBe('works_at')
    })

    test('infers `met` from "had coffee with"', () => {
      const triples = extractTypedLinks(
        'I had coffee with [[sarah-chen]] yesterday.',
        'sam',
      )
      expect(triples[0]!.predicate).toBe('met')
    })

    test('infers `met` from "met with"', () => {
      const triples = extractTypedLinks('Met with [[sarah-chen]] this morning.', 'sam')
      expect(triples[0]!.predicate).toBe('met')
    })

    test('infers `attended` from "presented at"', () => {
      const triples = extractTypedLinks(
        'Carol presented at [[yc-summit]] last week.',
        'carol',
      )
      expect(triples[0]!.predicate).toBe('attended')
    })
  })

  describe('page-role priors', () => {
    test('meeting page promotes plain refs to `attended`', () => {
      const triples = extractTypedLinks(
        'Discussion with [[sam]] and [[sarah-chen]] about Q3 plan.',
        '2026-04-10-board-sync',
        { sourceKind: 'meeting' },
      )
      const map = new Map(triples.map((t) => [t.object, t.predicate]))
      expect(map.get('sam')).toBe('attended')
      expect(map.get('sarah-chen')).toBe('attended')
    })

    test('person page stays at `mentions` without a verb match', () => {
      const triples = extractTypedLinks(
        'Some context about [[acme]] for the file.',
        'sam',
        { sourceKind: 'person' },
      )
      expect(triples[0]!.predicate).toBe('mentions')
    })

    test('verb pattern still wins over role prior on meeting pages', () => {
      const triples = extractTypedLinks(
        '[[sam]] founded [[acme]] back in 2018.',
        '2026-04-10-board-sync',
        { sourceKind: 'meeting' },
      )
      const map = new Map(triples.map((t) => [t.object, t.predicate]))
      expect(map.get('sam')).toBe('attended') // role prior
      expect(map.get('acme')).toBe('founded') // verb wins
    })
  })

  describe('code-fence false-positive defence (gbrain_README.md L573-577)', () => {
    test('refs inside fenced code blocks yield no triples', () => {
      const body = `# Notes

Real reference: [[sam]] was here.

\`\`\`markdown
Example only: [[acme]] and [[sarah-chen]] are placeholders.
\`\`\`

Trailing real reference: [[carol]] also stopped by.
`
      const triples = extractTypedLinks(body, 'page')
      const objects = triples.map((t) => t.object).sort()
      expect(objects).toEqual(['carol', 'sam'])
      expect(objects).not.toContain('acme')
      expect(objects).not.toContain('sarah-chen')
    })

    test('refs inside inline code spans yield no triples', () => {
      const body = `Use \`[[acme]]\` syntax to link to a page. But [[sam]] is a real ref.`
      const triples = extractTypedLinks(body, 'page')
      expect(triples.map((t) => t.object)).toEqual(['sam'])
    })

    test('tilde-fenced blocks also strip', () => {
      const body = `Some text [[sam]].

~~~
[[acme]] [[bob]]
~~~

After: [[carol]].`
      const triples = extractTypedLinks(body, 'page')
      const objects = triples.map((t) => t.object).sort()
      expect(objects).toEqual(['carol', 'sam'])
    })

    test('fenced verb-like content does NOT promote refs above mentions', () => {
      const body = `\`\`\`
Bob founded [[acme]].
\`\`\`

But really, [[acme]] is fine here.`
      const triples = extractTypedLinks(body, 'page')
      expect(triples).toEqual([
        { subject: 'page', predicate: 'mentions', object: 'acme', source: 'page' },
      ])
    })
  })

  describe('source override', () => {
    test('uses opts.source when provided', () => {
      const triples = extractTypedLinks(
        '[[acme]] mentioned here.',
        'sam',
        { source: '/abs/path/sam.md' },
      )
      expect(triples[0]!.source).toBe('/abs/path/sam.md')
    })

    test('defaults source to the subject slug', () => {
      const triples = extractTypedLinks('[[acme]]', 'sam')
      expect(triples[0]!.source).toBe('sam')
    })
  })

  describe('determinism / ordering', () => {
    test('output is sorted by predicate-cascade then object', () => {
      const body = `Sam met with [[bob]]. Sam met with [[alice]]. Sam founded [[zeta-corp]]. Sam invested in [[acme]].`
      const triples = extractTypedLinks(body, 'sam')
      expect(triples.map((t) => `${t.predicate}|${t.object}`)).toEqual([
        'founded|zeta-corp',
        'invested_in|acme',
        'met|alice',
        'met|bob',
      ])
    })
  })

  describe('hardening', () => {
    test('empty body returns empty array', () => {
      expect(extractTypedLinks('', 'sam')).toEqual([])
    })

    test('non-string body returns empty array', () => {
      expect(extractTypedLinks(null as unknown as string, 'sam')).toEqual([])
    })

    test('empty subject returns empty array', () => {
      expect(extractTypedLinks('[[acme]]', '')).toEqual([])
    })

    test('rejects slugs with path separators', () => {
      const triples = extractTypedLinks(
        '[Suspicious link](evil/people/somebody/extra)',
        'page',
      )
      expect(triples).toEqual([])
    })

    test('handles ridiculously long bodies without blowing up', () => {
      const big = '[[sam]] '.repeat(1000) + '[[acme]] '.repeat(1000)
      const triples = extractTypedLinks(big, 'page')
      expect(triples.map((t) => t.object).sort()).toEqual(['acme', 'sam'])
    })
  })

  describe('50-page rich-prose fixture corpus', () => {
    /*
     * Synthesises 50 pages of realistic gbrain-shaped content (people /
     * companies / meetings / projects / concepts / originals) and asserts
     * the extractor produces the expected predicate cascade across the
     * full set. Mirrors the BrainBench rich-prose corpus shape — but
     * checked-in deterministically rather than fetched, so the test is
     * hermetic.
     */
    const PAGES: Array<{ slug: string; kind?: string; body: string; expected: Array<[string, string]> }> = [
      // ---- People (founded / invested / advises / works_at) ----
      {
        slug: 'alice-founder',
        body: 'Alice founded [[acme-ai]] in 2018 with a focus on inference infra.',
        expected: [['founded', 'acme-ai']],
      },
      {
        slug: 'bob-cto',
        body: 'Bob is the CTO of [[acme-ai]]. He works at [[acme-ai]] full-time.',
        expected: [['works_at', 'acme-ai']],
      },
      {
        slug: 'carol-advisor',
        body: 'Carol advises [[acme-ai]] on go-to-market. She also advises [[zeta-corp]].',
        expected: [['advises', 'acme-ai'], ['advises', 'zeta-corp']],
      },
      {
        slug: 'dan-investor',
        body: 'Dan invested in [[acme-ai]] at seed. He led the round in [[zeta-corp]] last year.',
        expected: [['invested_in', 'acme-ai'], ['invested_in', 'zeta-corp']],
      },
      {
        slug: 'eve-engineer',
        body: 'Eve works at [[zeta-corp]] as a staff engineer.',
        expected: [['works_at', 'zeta-corp']],
      },
      {
        slug: 'frank-pm',
        body: 'Frank joined [[acme-ai]] as a PM last quarter. He works at [[acme-ai]] now.',
        expected: [['works_at', 'acme-ai']],
      },
      {
        slug: 'grace-vp',
        body: 'Grace is the VP of [[zeta-corp]] for engineering.',
        expected: [['works_at', 'zeta-corp']],
      },
      {
        slug: 'henry-founder',
        body: 'Henry co-founded [[zeta-corp]] back in 2015.',
        expected: [['founded', 'zeta-corp']],
      },
      {
        slug: 'ivy-advisor',
        body: 'Ivy is an advisor to [[acme-ai]] on regulatory.',
        expected: [['advises', 'acme-ai']],
      },
      {
        slug: 'jack-investor',
        body: 'Jack invested $5M in [[acme-ai]]. Jack also invested in [[zeta-corp]].',
        expected: [['invested_in', 'acme-ai'], ['invested_in', 'zeta-corp']],
      },
      // ---- More people (met / mentions) ----
      {
        slug: 'kate-friend',
        body: 'Kate met with [[sam]] at the offsite. Caught up with [[sarah-chen]] for coffee.',
        expected: [['met', 'sam'], ['met', 'sarah-chen']],
      },
      {
        slug: 'liam-friend',
        body: 'Liam had lunch with [[sam]] last Tuesday.',
        expected: [['met', 'sam']],
      },
      {
        slug: 'mary-pm',
        body: 'Mary had a 1:1 with [[sam]] about Q3 OKRs.',
        // 1:1 maps to `met`
        expected: [['met', 'sam']],
      },
      {
        slug: 'noah-contact',
        body: 'Loose mention of [[sam]] and [[acme-ai]] but no verbs.',
        expected: [['mentions', 'acme-ai'], ['mentions', 'sam']],
      },
      {
        slug: 'olivia-contact',
        body: 'Saw [[sam]] at the event. Also saw [[sarah-chen]].',
        expected: [['mentions', 'sam'], ['mentions', 'sarah-chen']],
      },
      // ---- Companies ----
      {
        slug: 'acme-ai',
        body: 'Acme AI is an inference infra company. Mentions of [[zeta-corp]] as a downstream customer.',
        expected: [['mentions', 'zeta-corp']],
      },
      {
        slug: 'zeta-corp',
        body: 'Zeta Corp builds vertical SaaS. [[acme-ai]] supplies infra.',
        expected: [['mentions', 'acme-ai']],
      },
      {
        slug: 'omega-labs',
        body: 'Omega Labs operates in stealth. Reference: [[acme-ai]] alumni.',
        expected: [['mentions', 'acme-ai']],
      },
      // ---- Meetings (page-role prior `attended`) ----
      {
        slug: '2026-04-10-board-sync',
        kind: 'meeting',
        body: 'Discussion with [[sam]] and [[sarah-chen]]. Reviewed [[acme-ai]] metrics.',
        expected: [
          ['attended', 'acme-ai'],
          ['attended', 'sam'],
          ['attended', 'sarah-chen'],
        ],
      },
      {
        slug: '2026-04-12-investor-call',
        kind: 'meeting',
        body: 'Call with [[dan-investor]] and [[jack-investor]] re portfolio.',
        expected: [['attended', 'dan-investor'], ['attended', 'jack-investor']],
      },
      {
        slug: '2026-04-15-product-review',
        kind: 'meeting',
        body: '[[sam]] presented at [[yc-summit]] last week. Reviewed roadmap.',
        // `presented at` matches `attended` verb pattern → still `attended`
        expected: [['attended', 'sam'], ['attended', 'yc-summit']],
      },
      {
        slug: '2026-04-18-design-review',
        kind: 'meeting',
        body: 'Design review attendees: [[sam]], [[sarah-chen]], [[bob-cto]].',
        expected: [
          ['attended', 'bob-cto'],
          ['attended', 'sam'],
          ['attended', 'sarah-chen'],
        ],
      },
      // ---- Projects ----
      {
        slug: 'project-neutron',
        kind: 'project',
        body: 'Neutron is the productization of [[nova]]. [[sam]] leads.',
        expected: [['mentions', 'sam'], ['mentions', 'nova']],
      },
      {
        slug: 'project-cores',
        kind: 'project',
        body: 'Cores subsystem; touches [[project-neutron]] and [[runtime]].',
        expected: [['mentions', 'project-neutron'], ['mentions', 'runtime']],
      },
      // ---- Concepts ----
      {
        slug: 'compiled-truth',
        kind: 'concept',
        body: 'See [[timeline]] for the append-only counterpart.',
        expected: [['mentions', 'timeline']],
      },
      {
        slug: 'timeline',
        kind: 'concept',
        body: 'Counterpart to [[compiled-truth]].',
        expected: [['mentions', 'compiled-truth']],
      },
      // ---- Originals ----
      {
        slug: 'original-2026-04-10-skill-files-are-code',
        kind: 'original',
        body: '"Skill files are code." Original observation citing [[garry-tan]].',
        expected: [['mentions', 'garry-tan']],
      },
      // ---- Edge cases ----
      {
        slug: 'page-with-code-fence',
        body: `Real ref: [[sam]].

\`\`\`
[[acme-ai]] [[zeta-corp]]
\`\`\`

Trailing real: [[sarah-chen]].`,
        expected: [['mentions', 'sam'], ['mentions', 'sarah-chen']],
      },
      {
        slug: 'page-with-inline-code',
        body: 'Use \`[[acme-ai]]\` syntax. Real ref: [[sam]].',
        expected: [['mentions', 'sam']],
      },
      {
        slug: 'page-with-md-links',
        body: 'See [Sarah Chen](people/sarah-chen.md) for context. Also [Sam](sam).',
        expected: [['mentions', 'sam'], ['mentions', 'sarah-chen']],
      },
      {
        slug: 'page-with-display-aliases',
        body: '[[acme-ai|Acme AI Inc.]] is a portfolio company.',
        expected: [['mentions', 'acme-ai']],
      },
      {
        slug: 'page-with-self-ref',
        body: 'This page about [[page-with-self-ref]] points at itself.',
        expected: [],
      },
      {
        slug: 'page-with-mixed-shapes',
        body: 'Mix of [[acme-ai]] and [Zeta](zeta-corp) and [Sarah](people/sarah-chen.md).',
        expected: [
          ['mentions', 'acme-ai'],
          ['mentions', 'sarah-chen'],
          ['mentions', 'zeta-corp'],
        ],
      },
      {
        slug: 'page-with-empty-body',
        body: '',
        expected: [],
      },
      {
        slug: 'page-with-no-refs',
        body: 'Long prose without any wikilinks or markdown links of note.',
        expected: [],
      },
      {
        slug: 'page-with-external-urls',
        body: 'See [the docs](https://example.com) and [the repo](http://github.com/foo).',
        expected: [],
      },
      {
        slug: 'page-with-anchor-links',
        body: 'See [§ summary](#summary) and [§ details](#details).',
        expected: [],
      },
      {
        slug: 'page-with-many-mentions-of-same-target',
        body: '[[acme-ai]] here. [[acme-ai]] there. [[acme-ai]] everywhere.',
        expected: [['mentions', 'acme-ai']],
      },
      {
        slug: 'page-with-verb-and-fallback-mixed',
        body: 'Sam founded [[acme-ai]]. Loose mention of [[zeta-corp]] later.',
        expected: [['founded', 'acme-ai'], ['mentions', 'zeta-corp']],
      },
      {
        slug: 'page-with-multi-verb-cascade',
        body: 'Bob founded [[acme-ai]]. Bob also works at [[acme-ai]].',
        // Founded wins over works_at for the same (subject, object) pair.
        expected: [['founded', 'acme-ai']],
      },
      {
        slug: 'page-with-investor-syntax',
        body: 'Sequoia led the round in [[acme-ai]]. Andreessen invested $10M in [[zeta-corp]].',
        expected: [
          ['invested_in', 'acme-ai'],
          ['invested_in', 'zeta-corp'],
        ],
      },
      {
        slug: 'page-with-advisor-syntax',
        body: 'Carol is on the advisory board for [[acme-ai]]. Ivy is an advisor at [[zeta-corp]].',
        expected: [
          ['advises', 'acme-ai'],
          ['advises', 'zeta-corp'],
        ],
      },
      {
        slug: 'page-with-role-titles',
        body: 'Bob is the engineer at [[acme-ai]]. Sarah is the head of [[zeta-corp]].',
        expected: [
          ['works_at', 'acme-ai'],
          ['works_at', 'zeta-corp'],
        ],
      },
      {
        slug: 'page-with-met-syntax',
        body: 'Caught up with [[sam]] over drinks. Had dinner with [[sarah-chen]].',
        expected: [['met', 'sam'], ['met', 'sarah-chen']],
      },
      {
        slug: 'page-with-attended-syntax',
        body: 'I hosted [[yc-summit]]. Earlier I spoke at [[ai-summit]].',
        expected: [
          ['attended', 'ai-summit'],
          ['attended', 'yc-summit'],
        ],
      },
      {
        slug: 'page-with-fenced-and-real',
        body: `Real: [[sam]].

\`\`\`example
Inside fence: [[acme-ai]] [[zeta-corp]] founded.
\`\`\`

Real: [[carol-advisor]].`,
        expected: [['mentions', 'carol-advisor'], ['mentions', 'sam']],
      },
      {
        slug: 'page-with-timeline-shape',
        body: `Compiled truth.

---

## Timeline
- 2026-04-10 | meeting-notes | Met with [[sam]] at offsite.
- 2026-04-05 | email | Saw [[acme-ai]] in the press.`,
        expected: [['met', 'sam'], ['mentions', 'acme-ai']],
      },
      {
        slug: 'page-with-deep-path-link',
        body: 'Confidential [link](deep/people/somebody/extra) — should reject.',
        expected: [],
      },
      {
        slug: 'page-with-trailing-punctuation',
        body: 'Spoke at [[ai-summit]]! Met [[sam]]?',
        expected: [['attended', 'ai-summit'], ['met', 'sam']],
      },
      // ---- Final: a high-density page ----
      // Note: when the same target appears with multiple verbs the strongest
      // predicate wins per the FOUNDED → INVESTED → ADVISES → WORKS_AT
      // cascade. `acme-ai` here gets `founded` even though `invested in
      // [[acme-ai]]` also appears further down the page.
      {
        slug: 'high-density-page',
        body: `Sam founded [[acme-ai]] in 2018.
He met with [[sarah-chen]] last week.
Carol advises [[zeta-corp]] on regulatory.
Bob is the CTO of [[omega-labs]].
Dan also invested in [[atlas-fund]] at seed.
Loose mention: [[yc-summit]] is coming up.`,
        expected: [
          ['founded', 'acme-ai'],
          ['invested_in', 'atlas-fund'],
          ['advises', 'zeta-corp'],
          ['works_at', 'omega-labs'],
          ['met', 'sarah-chen'],
          ['mentions', 'yc-summit'],
        ],
      },
    ]

    test('total page count is at least 50 (acceptance gate #1)', () => {
      expect(PAGES.length).toBeGreaterThanOrEqual(50)
    })

    test('each page yields its expected triple set', () => {
      const failures: string[] = []
      for (const page of PAGES) {
        const triples = extractTypedLinks(
          page.body,
          page.slug,
          page.kind !== undefined ? { sourceKind: page.kind } : {},
        )
        const actual = sortTriples(
          triples.map((t) => ({
            subject: t.subject,
            predicate: t.predicate,
            object: t.object,
            source: t.source,
          })),
        )
        const expected = sortTriples(
          page.expected.map(([predicate, object]) => ({
            subject: page.slug,
            predicate,
            object,
            source: page.slug,
          })),
        )
        const actualKey = actual
          .map((t) => `${t.predicate}|${t.object}`)
          .sort()
          .join(',')
        const expectedKey = expected
          .map((t) => `${t.predicate}|${t.object}`)
          .sort()
          .join(',')
        if (actualKey !== expectedKey) {
          failures.push(
            `[${page.slug}] expected: ${expectedKey}\n           actual:   ${actualKey}`,
          )
        }
      }
      if (failures.length > 0) {
        throw new Error(`Triple mismatches:\n${failures.join('\n')}`)
      }
    })

    test('code-fence regression across the full corpus — no triple references a slug that appears ONLY in a fenced block', () => {
      // Cherry-pick the pages whose bodies contain a fenced block; verify
      // the extracted objects intersect the non-fenced portion only.
      const fencedPages = PAGES.filter((p) => p.body.includes('```') || p.body.includes('~~~'))
      expect(fencedPages.length).toBeGreaterThan(0)
      for (const page of fencedPages) {
        const triples = extractTypedLinks(
          page.body,
          page.slug,
          page.kind !== undefined ? { sourceKind: page.kind } : {},
        )
        const expectedObjects = new Set(page.expected.map(([, o]) => o))
        for (const triple of triples) {
          if (!expectedObjects.has(triple.object)) {
            throw new Error(
              `page ${page.slug}: unexpected object "${triple.object}" — likely a code-fence false positive`,
            )
          }
        }
      }
    })
  })
})
