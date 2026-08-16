/**
 * Unit coverage for the as-built log's layout rules. The concurrency property itself is
 * proven against real git in `scripts/as-built-concurrent-realgit.test.ts`; this file
 * covers the two things that decide whether the RENDERED document is still the log it
 * was — the order, and the entry boundary.
 */

import { describe, expect, test } from 'bun:test'

import {
  archiveEntries,
  AS_BUILT_ARCHIVE,
  AS_BUILT_ENTRY_DIR,
  ENTRY_FILE_RE,
  entryFileName,
  orderEntryFiles,
  renderLog,
} from './as-built-log.ts'

describe('entryFileName', () => {
  test('builds <YYYY-MM-DD>-<slug>.md', () => {
    expect(entryFileName('2026-08-16', 'the-log-stops-sharing-bytes')).toBe(
      '2026-08-16-the-log-stops-sharing-bytes.md',
    )
    expect(AS_BUILT_ENTRY_DIR).toBe('docs/as-built')
    expect(AS_BUILT_ARCHIVE).toBe('docs/AS_BUILT.md')
  })

  test('refuses a name the renderer would not read back', () => {
    // Each of these parses as a file but NOT as an entry, so a build that wrote one
    // would silently produce an entry that never appears in the log.
    expect(() => entryFileName('16-08-2026', 'ok-slug')).toThrow(/<YYYY-MM-DD>-<slug>\.md/)
    expect(() => entryFileName('2026-08-16', 'Not_A_Slug')).toThrow(/<YYYY-MM-DD>-<slug>\.md/)
    expect(() => entryFileName('2026-08-16', 'trailing-')).toThrow(/<YYYY-MM-DD>-<slug>\.md/)
    expect(() => entryFileName('2026-08-16', 'double--hyphen')).toThrow(/<YYYY-MM-DD>-<slug>\.md/)
  })
})

describe('orderEntryFiles', () => {
  test('date DESCENDING wins over the slug — the order is the log, not the alphabet', () => {
    // `aaa` on the older day would come first under any plain filename sort that did
    // not treat the date as the primary key.
    expect(
      orderEntryFiles(['2026-08-14-aaa.md', '2026-08-16-zzz.md', '2026-08-15-mmm.md']),
    ).toEqual(['2026-08-16-zzz.md', '2026-08-15-mmm.md', '2026-08-14-aaa.md'])
  })

  test('same day falls back to the slug, so the render never depends on read order', () => {
    const forward = orderEntryFiles(['2026-08-16-alpha.md', '2026-08-16-bravo.md'])
    const reversed = orderEntryFiles(['2026-08-16-bravo.md', '2026-08-16-alpha.md'])
    expect(forward).toEqual(['2026-08-16-alpha.md', '2026-08-16-bravo.md'])
    expect(reversed).toEqual(forward)
  })

  test('non-entry files in the directory are dropped, never rendered as entries', () => {
    expect(orderEntryFiles(['README.md', '.DS_Store', 'notes.md', '2026-08-16-real.md'])).toEqual([
      '2026-08-16-real.md',
    ])
    expect(ENTRY_FILE_RE.test('README.md')).toBe(false)
  })
})

const ARCHIVE = [
  '# AS_BUILT — archive (FROZEN)',
  '',
  'Preamble that the render replaces.',
  '',
  '## 2026-08-01 — an older entry',
  '',
  'body.',
  '',
].join('\n')

describe('archiveEntries', () => {
  test('contributes entries only — the archive preamble never reaches the log body', () => {
    expect(archiveEntries(ARCHIVE)).toBe('## 2026-08-01 — an older entry\n\nbody.')
    expect(archiveEntries(ARCHIVE)).not.toContain('Preamble')
  })

  test('an archive with no entries contributes nothing rather than its header', () => {
    expect(archiveEntries('# AS_BUILT\n\nnothing here yet.\n')).toBe('')
  })
})

describe('renderLog', () => {
  const entries = [
    { name: '2026-08-16-b.md', body: '## 2026-08-16 — b\n\nb body.\n' },
    { name: '2026-08-15-a.md', body: '## 2026-08-15 — a\n\na body.\n' },
  ]

  test('newest-first, one header, every entry whole', () => {
    expect(renderLog({ entries, archive: ARCHIVE })).toBe(
      [
        '<!-- RENDERED by `bun scripts/render-as-built.ts` — do not commit this file. Entries live in docs/as-built/. -->',
        '',
        '# AS_BUILT',
        '',
        'Running log of what shipped, newest first. One entry per merged change.',
        '',
        '## 2026-08-16 — b',
        '',
        'b body.',
        '',
        '## 2026-08-15 — a',
        '',
        'a body.',
        '',
        '## 2026-08-01 — an older entry',
        '',
        'body.',
        '',
      ].join('\n'),
    )
  })

  test('an entry that is not a whole entry THROWS instead of being glued to its neighbour', () => {
    // The control for the boundary guard: a body missing its heading is exactly the
    // shape a line-wise merge produces, and gluing it on would hide the damage inside
    // the previous entry.
    expect(() =>
      renderLog({ entries: [{ name: '2026-08-16-b.md', body: 'orphaned prose with no heading\n' }], archive: '' }),
    ).toThrow(/does not open with a markdown heading/)
  })

  test('the live corpus mixes `#` and `##` titles, and BOTH are emitted verbatim', () => {
    // 28 of the 47 entries written under this layout open with `#`, 19 with `##`. The
    // renderer must not reject either and must not rewrite either — it never edits
    // inside an entry, which is the property that makes splicing impossible.
    const out = renderLog({
      entries: [
        { name: '2026-08-16-h1.md', body: '# A title written as h1 (2026-08-16)\n\nprose.\n' },
        { name: '2026-08-15-h2.md', body: '## 2026-08-15 — a title written as h2\n\nprose.\n' },
      ],
      archive: '',
    })
    expect(out).toContain('# A title written as h1 (2026-08-16)\n\nprose.')
    expect(out).toContain('## 2026-08-15 — a title written as h2\n\nprose.')
  })

  test('with no entries yet the log is the archive, not an empty document', () => {
    expect(renderLog({ entries: [], archive: ARCHIVE })).toContain('## 2026-08-01 — an older entry')
  })
})
