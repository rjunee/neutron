import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  findDuplicateEntryHeadings as findDuplicateEntryHeadingsFromCore,
  foldEntriesIntoLog,
  foldEntryIntoLog,
  parseLog,
  serializeLog,
} from '@neutronai/trident/as-built-log.ts'
// This cross-package import is the subject of the shim-identity pin below.
// eslint-disable-next-line import/no-relative-packages
import { findDuplicateEntryHeadings as findDuplicateEntryHeadingsFromShim } from '../scripts/git/as-built-heading-uniqueness.ts'

const REAL_LOG_PATH = join(import.meta.dir, '..', 'docs', 'AS_BUILT.md')
const PREAMBLE = '# AS_BUILT\n\nRunning log, newest first.\n\n'

describe('as-built entry model', () => {
  test('round-trips the real log byte-for-byte', () => {
    const text = readFileSync(REAL_LOG_PATH, 'utf8')
    expect(serializeLog(parseLog(text))).toBe(text)
  })

  test('headings inside backtick and tilde fences are not entries', () => {
    const text =
      '## 2026-08-17 — quotes headings\n\n```md\n## 2000-01-01 — backtick sample\n```\n\n~~~md\n## 2000-01-02 — tilde sample\n~~~\n'
    const parsed = parseLog(text)
    expect(parsed.entries).toHaveLength(1)
    expect(serializeLog(parsed)).toBe(text)
  })

  test('a tab after the hashes begins an entry', () => {
    expect(parseLog('##\ttitle\n\nbody\n').entries).toHaveLength(1)
  })

  test('hashes without a delimiter do not begin an entry', () => {
    expect(parseLog('##foo\n\nbody\n').entries).toHaveLength(0)
  })
})

describe('foldEntryIntoLog', () => {
  test('inserts a normalized entry first and preserves every existing log byte', () => {
    const originalEntries =
      '## 2026-08-15 — older\n\nolder body\n\n## 2026-08-14 — oldest\n\noldest body\n'
    const log = PREAMBLE + originalEntries
    const staged = '## 2026-08-17 — newest\n\nnew body\n\n\n'
    const expected = PREAMBLE + '## 2026-08-17 — newest\n\nnew body\n\n' + originalEntries

    const result = foldEntryIntoLog(log, staged)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.log).toBe(expected)
    expect(result.heading).toBe('## 2026-08-17 — newest')
    expect(result.retitled).toBe(false)
    expect(parseLog(result.log).entries[0]!.lines[0]).toBe('## 2026-08-17 — newest')
  })

  test('appends after an entryless preamble without changing its bytes', () => {
    const log = '# AS_BUILT\n\nNo entries yet.\n\n'
    const result = foldEntryIntoLog(log, '## 2026-08-17 — first\n\nfirst body')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.log).toBe(`${log}## 2026-08-17 — first\n\nfirst body\n`)

    const empty = foldEntryIntoLog('', '## 2026-08-17 — first')
    expect(empty.ok).toBe(true)
    if (!empty.ok) return
    expect(empty.log).toBe('## 2026-08-17 — first\n')
  })

  test('uses the first free numeric suffix for colliding headings', () => {
    const heading = '## 2026-08-17 — same title'
    const once = foldEntryIntoLog(`${PREAMBLE}${heading}\n\noriginal\n`, `${heading}\n\nincoming`)
    expect(once.ok).toBe(true)
    if (!once.ok) return
    expect(once.heading).toBe(`${heading} (2)`)
    expect(once.retitled).toBe(true)
    expect(findDuplicateEntryHeadingsFromCore(once.log)).toEqual([])

    const occupied = `${PREAMBLE}${heading}\n\noriginal\n\n${heading} (2)\n\nsecond\n`
    const twice = foldEntryIntoLog(occupied, `${heading}\n\nincoming`)
    expect(twice.ok).toBe(true)
    if (!twice.ok) return
    expect(twice.heading).toBe(`${heading} (3)`)
    expect(twice.retitled).toBe(true)
    expect(findDuplicateEntryHeadingsFromCore(twice.log)).toEqual([])
  })

  test.each([
    {
      name: 'two headings',
      staged: '## 2026-08-17 — one\n\nbody\n\n## 2026-08-16 — two\n\nbody',
      reasons: ['must be exactly one entry; found 2', '## 2026-08-16 — two'],
    },
    {
      name: 'prose before the heading',
      staged: 'not an entry\n\n## 2026-08-17 — valid\n\nbody',
      reasons: ["content before the '## ' heading", 'not an entry'],
    },
    {
      name: 'a heading without a date',
      staged: '## not-a-date — title\n\nbody',
      reasons: ["heading '## not-a-date — title'", "does not match '## YYYY-MM-DD — title'"],
    },
    {
      name: 'hashes without a heading delimiter',
      staged: '##bad',
      reasons: ["content before the '## ' heading", '##bad'],
    },
  ])('refuses $name and leaves the log byte-unchanged', ({ staged, reasons }) => {
    const log = `${PREAMBLE}## 2026-08-10 — existing\n\nbody\n`
    const result = foldEntryIntoLog(log, staged)
    expect(result.ok).toBe(false)
    if (result.ok) return
    for (const reason of reasons) expect(result.reason).toContain(reason)

    const batch = foldEntriesIntoLog(log, [staged])
    expect(batch.log).toBe(log)
    expect(batch.folded).toEqual([])
    expect(batch.refused).toEqual([{ index: 0, reason: result.reason }])
  })
})

describe('foldEntriesIntoLog', () => {
  test('folds in landing order, leaves the last entry topmost, and skips a malformed middle entry', () => {
    const existing = '## 2026-08-10 — existing\n\nbody\n'
    const oldestLanded = '## 2026-08-15 — first landed\n\nfirst body'
    const malformed = 'prose is not an entry'
    const newestLanded = '## 2026-08-16 — last landed\n\nlast body'

    const result = foldEntriesIntoLog(PREAMBLE + existing, [oldestLanded, malformed, newestLanded])
    expect(parseLog(result.log).entries.map((entry) => entry.lines[0])).toEqual([
      '## 2026-08-16 — last landed',
      '## 2026-08-15 — first landed',
      '## 2026-08-10 — existing',
    ])
    expect(result.folded).toEqual([
      { heading: '## 2026-08-15 — first landed', retitled: false },
      { heading: '## 2026-08-16 — last landed', retitled: false },
    ])
    expect(result.refused).toHaveLength(1)
    expect(result.refused[0]!.index).toBe(1)
    expect(result.refused[0]!.reason).toContain('prose is not an entry')
  })

  test('folds over the real log without changing a byte below the inserted block', () => {
    const realLog = readFileSync(REAL_LOG_PATH, 'utf8')
    const parsed = parseLog(realLog)
    expect(parsed.entries.length).toBeGreaterThan(300)

    const staged = '## 2099-01-01 — synthetic fold probe'
    const result = foldEntryIntoLog(realLog, staged)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const preamble = `${parsed.preamble.join('\n')}\n`
    const existingEntries = serializeLog({ preamble: [], entries: parsed.entries })
    expect(result.log).toBe(`${preamble}${staged}\n\n${existingEntries}`)
    expect(findDuplicateEntryHeadingsFromCore(result.log)).toEqual([])
  })
})

/**
 * THE TWO COPIES ARE PINNED BY BEHAVIOUR, NOT BY OBJECT IDENTITY — and that is the whole
 * point of this pair of tests.
 *
 * The earlier version asserted `Object.is(core, shim)`, which can only hold if the
 * scripts/git module re-exports this one. That assertion pinned the shape that BROKE the
 * merge driver: git execs it as `bun --config=/dev/null scripts/git/as-built-merge-driver.ts`
 * from a temporary merge worktree, where a `@neutronai/...` specifier has no node_modules to
 * resolve through. The driver died and `git merge` returned non-zero. Six tests in
 * `scripts/git/as-built-merge-realgit.test.ts` caught it; every one of their
 * driver-uninstalled CONTROLS stayed green, which is what identified the driver rather than
 * the suite as broken.
 *
 * So identity is the wrong contract. The right one is two claims, and both are checked:
 * the scripts/git side owns its implementation outright, and the two implementations agree.
 */
test('the scripts/git uniqueness module resolves without node_modules — no PACKAGE specifiers', () => {
  // RELATIVE specifiers are fine and are the point: `./as-built-log-merge.ts` sits beside the
  // driver and resolves from the file's own directory, with no node_modules involved. What
  // must not appear is a PACKAGE specifier — `@neutronai/...` or any bare name — because that
  // is resolved by walking up to a node_modules the merge worktree does not have.
  //
  // The first cut of this test banned every `from` line and failed on the relative import,
  // which would have been "fixed" by loosening it back to nothing. Naming the real class is
  // what makes it both correct and enforceable.
  const dir = join(import.meta.dir, '..', 'scripts', 'git')
  const specifierOf = (line: string) => /\bfrom\s+['"]([^'"]+)['"]/.exec(line)?.[1]
  const packageSpecifiers = (src: string) =>
    src
      .split('\n')
      .map(specifierOf)
      .filter((spec): spec is string => spec !== undefined)
      .filter((spec) => !spec.startsWith('.') && !spec.startsWith('node:'))

  for (const file of ['as-built-heading-uniqueness.ts', 'as-built-log-merge.ts', 'as-built-merge-driver.ts']) {
    expect(packageSpecifiers(readFileSync(join(dir, file), 'utf8'))).toEqual([])
  }

  // Control: the matcher must actually find one when it is there, or the loop above passes
  // for a file it failed to parse.
  expect(packageSpecifiers("import { x } from '@neutronai/trident/as-built-log.ts'\n")).toEqual([
    '@neutronai/trident/as-built-log.ts',
  ])
})

test('the two duplicate-heading implementations agree, so the copies cannot drift apart', () => {
  // Exercised against the REAL log and against a log that genuinely contains duplicates —
  // agreeing only on the empty case would pass for two functions that share nothing.
  const realLog = readFileSync(REAL_LOG_PATH, 'utf8')
  const dupes = `${PREAMBLE}## 2026-01-01 — same\n\na\n\n## 2026-01-01 — same\n\nb\n\n## 2026-01-02 — other\n\nc\n`

  for (const sample of [realLog, dupes]) {
    expect(findDuplicateEntryHeadingsFromShim(sample)).toEqual(findDuplicateEntryHeadingsFromCore(sample))
  }
  // The duplicate fixture must actually contain one, or the loop above compares two empties.
  expect(findDuplicateEntryHeadingsFromCore(dupes).length).toBeGreaterThan(0)
})
