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

import {
  explainDuplicateEntryHeadings,
  findDuplicateEntryHeadings,
} from './as-built-heading-uniqueness.ts'

const LOG_PATH = join(import.meta.dir, '..', 'docs', 'AS_BUILT.md')

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
    const before = findDuplicateEntryHeadings(log)
    const first = log.split('\n').find((l) => l.startsWith('## '))
    expect(first).toBeDefined()
    const collided = `${log}\n${first}\n\nre-appended by a union merge that kept both sides.\n`
    const after = findDuplicateEntryHeadings(collided)
    expect(after).toHaveLength(before.length + 1)
    expect(after.find((d) => d.heading === first)?.lines).toHaveLength(2)
  })
})
