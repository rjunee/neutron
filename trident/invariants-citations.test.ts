/**
 * INVARIANT #118 CITES BY NAME, AND EVERY NAME IT CITES EXISTS (Argus r29).
 *
 * #118 is the invariant this card writes — "a run that did not review is not
 * recorded as a rejection" — and it is long, so it carries a lot of citations.
 * Nine of them were `path:LINE` anchors, and every one had drifted: `store.ts:677`
 * pointed at a `// COLS order` comment rather than at `latestTerminalBySlug`,
 * `checkpoint.sh:183` at nothing to do with `round_for_checkpoint`. A stale anchor
 * is worse than no anchor — it sends the next reader to code that does not say what
 * the sentence claims, and nothing in the suite noticed, because no test read this
 * file at all.
 *
 * A line number is unguardable by construction: it changes whenever anything above
 * it does. A NAME is not, so #118 now cites files and symbols by name, and this is
 * what keeps that true — the file must exist, and the anchor must be absent.
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
const DOC = join(REPO, 'docs', 'INVARIANTS.md')

/** Everything from `118. ` up to the next top-level numbered invariant. */
const invariant = (n: number): string => {
  const lines = readFileSync(DOC, 'utf8').split('\n')
  const start = lines.findIndex((l) => l.startsWith(`${n}. `))
  if (start === -1) return ''
  const rest = lines.slice(start + 1)
  // The next invariant OR the next section heading, whichever comes first — the
  // headings carry citations of their own (`critic-*.md`) and are not #118's.
  const end = rest.findIndex((l) => /^\d+\. /.test(l) || l.startsWith('#'))
  return [lines[start], ...(end === -1 ? rest : rest.slice(0, end))].join('\n')
}

/** Backticked spans that are a repo path, with or without a `:LINE` anchor. */
const citedPaths = (text: string): string[] =>
  (text.match(/`[A-Za-z0-9_./-]+\.(?:ts|tsx|sh|mjs|sql|md)(?::[0-9,-]+)?`/g) ?? []).map((m) =>
    m.slice(1, -1),
  )

describe('docs/INVARIANTS.md #118 — the citations are checkable', () => {
  test('every file it names exists in the repo', () => {
    const cited = citedPaths(invariant(118))
    // Non-vacuous: the extraction must actually find the citations. #118 carries
    // well over a dozen; a regex that silently matched nothing would otherwise
    // read as a pass.
    expect(cited.length).toBeGreaterThan(15)
    const missing = cited
      .map((c) => c.split(':')[0]!)
      .filter((path) => !existsSync(join(REPO, path)))
    expect(missing).toEqual([])
  })

  test('it cites by NAME — no `path:LINE` anchors, which drift silently', () => {
    const anchored = citedPaths(invariant(118)).filter((c) => c.includes(':'))
    expect(anchored).toEqual([])
  })

  test('POSITIVE CONTROL: both rules catch what they are for', () => {
    // A path that does not exist, and an anchor, are both detected — so the two
    // assertions above are answering about #118 and not about an empty set.
    const bogus = '118. a claim (`trident/no-such-module.ts`) pinned at `trident/store.ts:677`.\n119. next'
    const cited = citedPaths(bogus)
    expect(cited).toEqual(['trident/no-such-module.ts', 'trident/store.ts:677'])
    expect(cited.filter((c) => c.includes(':'))).toEqual(['trident/store.ts:677'])
    expect(existsSync(join(REPO, 'trident/no-such-module.ts'))).toBe(false)
    // …and the extractor really does stop at the next invariant.
    expect(invariant(118)).not.toContain('\n119. ')
  })
})
