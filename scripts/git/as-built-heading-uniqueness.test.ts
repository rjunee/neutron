/**
 * "One entry per merged change" (`docs/AS_BUILT.md` line 3), enforced.
 *
 * The last case in this file is the one that matters: it reads the REAL log off
 * disk. A unit test over a fixture proves the function works; only the real
 * file proves the repo conforms, and this repo did not — four headings collided
 * on `main` at f99d6d49.
 *
 * Every negative here is paired with a positive control that re-introduces the
 * exact collision it forbids, because a checker that has silently stopped
 * matching anything reports a clean file in exactly the same words as a clean
 * file.
 */

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { parseLog } from './as-built-log-merge.ts'
import {
  explainDuplicateEntryHeadings,
  findDuplicateEntryHeadings,
} from './as-built-heading-uniqueness.ts'

const LOG_PATH = join(import.meta.dir, '..', '..', 'docs', 'AS_BUILT.md')

describe('findDuplicateEntryHeadings', () => {
  it('reports nothing when every entry heading is distinct', () => {
    expect(findDuplicateEntryHeadings('# AS_BUILT\n\n## a — one\n\nx\n\n## b — two\n\ny\n')).toEqual([])
  })

  it('reports a repeated heading with every line it appears on', () => {
    const log = '# AS_BUILT\n\n## a — one\n\nx\n\n## b — two\n\ny\n\n## a — one\n\nz\n'
    expect(findDuplicateEntryHeadings(log)).toEqual([{ heading: '## a — one', lines: [3, 11] }])
  })

  it('does NOT key on the date — same-day entries are the log\'s normal case', () => {
    // 2026-08-09 alone carries more than twenty entries. A date-keyed check
    // would be a wall of false positives, and a gate that cries wolf is waved
    // through.
    const log = '## 2026-08-09 — one\n\nx\n\n## 2026-08-09 — two\n\ny\n'
    expect(findDuplicateEntryHeadings(log)).toEqual([])
  })

  it('ignores `###` and deeper — those are an entry\'s internal structure', () => {
    const log = '## a — one\n\n### Verification\n\nx\n\n## b — two\n\n### Verification\n\ny\n'
    expect(findDuplicateEntryHeadings(log)).toEqual([])
  })

  it('ignores a `## ` line inside a fenced block — quoted markdown is prose', () => {
    const log = '## a — one\n\n```md\n## a — one\n```\n\n## b — two\n\ny\n'
    expect(findDuplicateEntryHeadings(log)).toEqual([])
  })

  it('agrees with the merge driver on `~~~` fences', () => {
    // The gate's first shape matched only ``` , so a heading quoted inside a
    // tilde fence read as a real entry and the gate reported a duplicate the
    // driver does not see. Blocking a merge over prose is the expensive
    // direction of that disagreement.
    const log = '## a — one\n\n~~~md\n## a — one\n~~~\n\n## b — two\n\ny\n'
    expect(findDuplicateEntryHeadings(log)).toEqual([])
  })

  it('agrees with the merge driver on an indented fence closer', () => {
    // Opener at column 0, closer indented — the shape a nested list or a quoted
    // block produces. `startsWith('```')` matched the opener and missed the
    // closer, so `fenced` stayed stuck open and EVERY heading below went
    // uncounted: a real collision reported clean, which is the direction of
    // disagreement nobody ever finds out about.
    const log = '## a — one\n\n```\nsample\n  ```\n\n## b — two\n\ny\n\n## b — two\n\nz\n'
    expect(findDuplicateEntryHeadings(log).map((d) => d.heading)).toEqual(['## b — two'])
  })

  it('agrees with the merge driver on a tab-separated heading', () => {
    // `startsWith('## ')` requires a space; the driver's `HEADING` accepts a tab as
    // the delimiter too, as CommonMark does. The driver would merge these as one
    // entry twice over; the gate saw none. This case is also why that regex is not
    // the narrower `/^## /` — under it this fixture parses as ZERO entries and the
    // gate reports clean, which is the silent direction. See `HEADING` in the
    // driver's parser for the rule and the three spellings that got it wrong.
    const log = '##\ta — one\n\nx\n\n##\ta — one\n\ny\n'
    expect(findDuplicateEntryHeadings(log)).toEqual([{ heading: '##\ta — one', lines: [1, 5] }])
  })

  it('reports the line number the driver would land on, per entry length', () => {
    // Line numbers are reconstructed from the parse rather than re-scanned, so
    // this pins the arithmetic — preamble length, then each entry's own length.
    const log = '# AS_BUILT\n\nintro\n\n## a — one\n\n~~~\n## a — one\n~~~\n\n## b\n\nz\n\n## a — one\n\nq\n'
    expect(findDuplicateEntryHeadings(log)).toEqual([{ heading: '## a — one', lines: [5, 15] }])
  })

  it('distinguishes headings that differ only in a trailing suffix', () => {
    // This is precisely how the three folded detail entries were disambiguated,
    // so a checker that normalised punctuation away would report a collision
    // that no longer exists.
    const log = '## a — one\n\nx\n\n## a — one (detail)\n\ny\n'
    expect(findDuplicateEntryHeadings(log)).toEqual([])
  })
})

describe('explainDuplicateEntryHeadings', () => {
  it('names the file, the heading and every line, and says not to delete a body', () => {
    const text = explainDuplicateEntryHeadings('docs/AS_BUILT.md', [
      { heading: '## a — one', lines: [3, 11] },
    ])
    expect(text).toContain('docs/AS_BUILT.md')
    expect(text).toContain('## a — one')
    expect(text).toContain('lines 3, 11')
    expect(text).toContain('loses history')
  })
})

describe('docs/AS_BUILT.md conforms to its own contract', () => {
  const log = readFileSync(LOG_PATH, 'utf8')

  it('states the contract this test enforces', () => {
    // If the header is ever reworded, this gate should be re-justified rather
    // than left enforcing a rule the file no longer claims.
    expect(log).toContain('One entry per merged change.')
  })

  it('has no repeated entry heading', () => {
    const duplicates = findDuplicateEntryHeadings(log)
    expect(
      duplicates.length === 0 ? '' : explainDuplicateEntryHeadings('docs/AS_BUILT.md', duplicates),
    ).toBe('')
  })

  it('positive control: re-introducing a collision in the real log goes red', () => {
    // Without this, a checker that had stopped matching `## ` at all would pass
    // the case above and report the log clean forever. Four collisions reached
    // main under exactly that absence of a check.
    //
    // Stated as a DELTA against the file's own baseline so this control keeps
    // testing only what it claims — that appending a collision adds one — even
    // on a day the log is not clean.
    //
    // The heading it re-appends must be one that is not ALREADY duplicated,
    // which is not a hypothetical: the scenario this whole gate exists for is a
    // union merge doubling an entry, and the entry it doubles is the newest —
    // i.e. the first `## ` in a newest-first log. Re-appending an already-doubled
    // heading takes it from two occurrences to three, so the duplicate COUNT is
    // unchanged and this control reds with a confusing message on a day the log
    // is dirty in exactly the way it is warning about.
    //
    // Headings come from the driver's parser, not a line scan, so the one picked
    // is one the gate genuinely counts — a `## ` lifted out of a fenced block
    // would be a brand-new heading when appended at top level, and the delta
    // would be zero.
    const before = findDuplicateEntryHeadings(log)
    const alreadyDuplicated = new Set(before.map((d) => d.heading))
    const target = parseLog(log)
      .entries.map((e) => e.lines[0]!.trimEnd())
      .find((h) => !alreadyDuplicated.has(h))
    expect(target).toBeDefined()
    const collided = `${log}\n${target}\n\nre-appended by a union merge that kept both sides.\n`
    const after = findDuplicateEntryHeadings(collided)
    expect(after).toHaveLength(before.length + 1)
    expect(after.find((d) => d.heading === target)?.lines).toHaveLength(2)
  })
})
