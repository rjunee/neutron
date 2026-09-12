import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  AS_BUILT_DIR,
  findDuplicateEntryHeadings as findDuplicateEntryHeadingsFromCore,
  parseLog,
  serializeLog,
  shardStagedEntries,
  shardStagedEntry,
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

describe('the frozen log', () => {
  test('carries the freeze note above every entry, and the entries are still there', () => {
    const text = readFileSync(REAL_LOG_PATH, 'utf8')
    const parsed = parseLog(text)
    // The note is PREAMBLE, not an entry: it must not become the newest record.
    expect(parsed.preamble.join('\n')).toContain('FROZEN as of 2026-09-12')
    expect(parsed.entries.length).toBeGreaterThan(400)
    expect(parsed.entries[0]!.lines[0]).toMatch(/^## \d{4}-\d{2}-\d{2} — /)
    expect(findDuplicateEntryHeadingsFromCore(text)).toEqual([])
  })

  test('no as-built writer targets it any more', () => {
    // The appender is the only thing that ever wrote it, and the absence of that
    // write is the property — a reintroduced one would typecheck perfectly. Read
    // with comments stripped, because this module's own docblock has to be able
    // to NAME the file it stopped writing.
    const appender = readFileSync(join(import.meta.dir, 'as-built-appender.ts'), 'utf8')
    const code = appender.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    expect(code).not.toContain('AS_BUILT.md')
    expect(code).toContain('AS_BUILT_DIR')
  })
})

describe('shardStagedEntry', () => {
  const NONE: ReadonlySet<string> = new Set()

  test('names the file from the staged slug and keeps the entry verbatim', () => {
    const result = shardStagedEntry(
      '.trident/as-built/trident/some-spec-item-slug.md',
      '## 2026-09-12 — newest\n\nnew body\n\n\n',
      NONE,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.name).toBe('some-spec-item-slug.md')
    expect(result.suffixed).toBe(false)
    // Trailing blank lines normalised to exactly one newline; nothing else touched.
    expect(result.text).toBe('## 2026-09-12 — newest\n\nnew body\n')
    expect(parseLog(result.text).entries).toHaveLength(1)
  })

  test('a body of any shape survives, including a heading quoted in a fence', () => {
    const entry = '## 2026-09-12 — quotes a heading\n\n```md\n## 2000-01-01 — sample\n```\n'
    const result = shardStagedEntry('.trident/as-built/x.md', entry, NONE)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.text).toBe(entry)
  })

  test('a COLLIDING FILENAME takes the first free suffix and the TITLE is left alone', () => {
    // This is the one rule that had to change shape rather than move. In the
    // monolith two identical headings were one ambiguous key, so the incoming
    // entry was RETITLED ' (2)'. Here the key is the path, so the title — which
    // is content — is preserved and the NAME is what gets suffixed.
    const heading = '## 2026-09-12 — same title'
    const once = shardStagedEntry('.trident/as-built/dup.md', `${heading}\n\nincoming`, new Set(['dup.md']))
    expect(once.ok).toBe(true)
    if (!once.ok) return
    expect(once.name).toBe('dup-2.md')
    expect(once.suffixed).toBe(true)
    expect(once.text).toBe(`${heading}\n\nincoming\n`)

    const twice = shardStagedEntry(
      '.trident/as-built/dup.md',
      `${heading}\n\nincoming`,
      new Set(['dup.md', 'dup-2.md']),
    )
    expect(twice.ok).toBe(true)
    if (!twice.ok) return
    expect(twice.name).toBe('dup-3.md')
  })

  test.each([
    {
      name: 'two headings',
      staged: '## 2026-09-12 — one\n\nbody\n\n## 2026-09-11 — two\n\nbody',
      reasons: ['must be exactly one entry; found 2', '## 2026-09-11 — two'],
    },
    {
      name: 'prose before the heading',
      staged: 'not an entry\n\n## 2026-09-12 — valid\n\nbody',
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
  ])('refuses $name', ({ staged, reasons }) => {
    const result = shardStagedEntry('.trident/as-built/some-branch.md', staged, NONE)
    expect(result.ok).toBe(false)
    if (result.ok) return
    for (const reason of reasons) expect(result.reason).toContain(reason)

    const batch = shardStagedEntries([{ path: '.trident/as-built/some-branch.md', text: staged }], NONE)
    expect(batch.shards).toEqual([])
    expect(batch.refused).toEqual([{ index: 0, reason: result.reason }])
  })

  test('refuses a staged name that is not a usable filename', () => {
    // A branch name can legally carry characters a record name must not: a name
    // with a slash in it would quietly become a subdirectory the collision check
    // never looks in.
    for (const bad of ['.hidden.md', '..md', 'has space.md', '-leading.md']) {
      const result = shardStagedEntry(`.trident/as-built/${bad}`, '## 2026-09-12 — t\n\nb\n', NONE)
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.reason).toContain('not a usable record name')
    }
  })
})

describe('shardStagedEntries', () => {
  test('shards in landing order, suffixes within the pass, and skips a malformed middle entry', () => {
    const result = shardStagedEntries(
      [
        { path: '.trident/as-built/same.md', text: '## 2026-09-10 — first landed\n\nfirst body' },
        { path: '.trident/as-built/broken.md', text: 'prose is not an entry' },
        { path: '.trident/as-built/same.md', text: '## 2026-09-11 — last landed\n\nlast body' },
      ],
      new Set(),
    )
    // Two entries claiming one slug in ONE pass: the second is suffixed against
    // the first, not against the directory it has not been written to yet.
    expect(result.shards.map((s) => [s.index, s.name, s.suffixed])).toEqual([
      [0, 'same.md', false],
      [2, 'same-2.md', true],
    ])
    expect(result.refused).toHaveLength(1)
    expect(result.refused[0]!.index).toBe(1)
    expect(result.refused[0]!.reason).toContain('prose is not an entry')
  })

  test('suffixes against names already in the directory', () => {
    const result = shardStagedEntries(
      [{ path: '.trident/as-built/taken.md', text: '## 2026-09-12 — t\n\nb\n' }],
      new Set(['taken.md', 'taken-2.md', 'README.md']),
    )
    expect(result.shards.map((s) => s.name)).toEqual(['taken-3.md'])
  })

  test('AS_BUILT_DIR is the directory the records actually live in', () => {
    expect(AS_BUILT_DIR).toBe('docs/as-built')
    expect(readFileSync(join(import.meta.dir, '..', AS_BUILT_DIR, 'README.md'), 'utf8')).toContain(
      'one file per change',
    )
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
