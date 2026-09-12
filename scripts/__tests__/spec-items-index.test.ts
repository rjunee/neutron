/**
 * The committed `docs/spec-items/README.md` must be exactly what the renderer produces.
 *
 * WITHOUT THIS TEST THE INDEX ROTS IN A WEEK. The work-tracking standard's §6 trap says
 * a split without a rendered index gives you all the cost and none of the benefit — and
 * a rendered index nobody re-renders is the same thing with an extra file. This is the
 * ratchet: adding a spec item without regenerating the rollup fails the build.
 *
 * It also validates the frontmatter of every item, so a typo'd group or an invented
 * priority is caught at the point it is introduced rather than by a reader months later.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  GROUPS,
  escapeCell,
  INDEX_FILENAME,
  PRIORITIES,
  SPEC_ITEMS_DIR,
  buildIndex,
  parseFrontmatter,
  readSpecItem,
  readSpecItems,
  renderIndex,
} from '../spec-items-index.ts'

const DIR = join(import.meta.dir, '..', '..', SPEC_ITEMS_DIR)

describe('the committed index matches the renderer', () => {
  test('docs/spec-items/README.md is exactly what the script produces', () => {
    const committed = readFileSync(join(DIR, INDEX_FILENAME), 'utf8')
    expect(buildIndex(DIR)).toBe(committed)
  })

  // POSITIVE CONTROL. The assertion above passes trivially if `buildIndex` were ever
  // reduced to reading the committed file back. This proves the renderer actually
  // renders — an item that is not in the committed index makes it differ.
  test('an unrendered item makes the check FAIL', () => {
    const items = readSpecItems(DIR)
    const withExtra = renderIndex([
      ...items,
      { slug: 'not-a-real-item', title: 'Never committed', group: 'trident', status: 'open', priority: 'P1', cutover: false, needs_spec: false },
    ])
    expect(withExtra).not.toBe(readFileSync(join(DIR, INDEX_FILENAME), 'utf8'))
    expect(withExtra).toContain('not-a-real-item')
  })
})

describe('every committed spec item has valid frontmatter', () => {
  const items = readSpecItems(DIR)

  test('the queue is non-empty', () => {
    expect(items.length).toBeGreaterThan(0)
  })

  test('group, priority and status are from the closed sets, and titles fit', () => {
    for (const i of items) {
      expect(GROUPS).toContain(i.group)
      expect(PRIORITIES).toContain(i.priority)
      expect(i.title.length).toBeGreaterThan(0)
      expect(i.title.length).toBeLessThanOrEqual(70)
    }
  })

  test('slugs are unique — identity is the filename', () => {
    expect(new Set(items.map((i) => i.slug)).size).toBe(items.length)
  })

  test('P0 is reserved for cutover-blocking work', () => {
    for (const i of items.filter((x) => x.priority === 'P0')) expect(i.cutover).toBe(true)
  })

  test('every item is linked from the index', () => {
    const index = readFileSync(join(DIR, INDEX_FILENAME), 'utf8')
    for (const i of items) expect(index).toContain(`(${i.slug}.md)`)
  })
})

describe('the validator rejects what it should', () => {
  function withItem(filename: string, body: string, fn: (dir: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), 'spec-items-'))
    try {
      writeFileSync(join(dir, filename), body)
      fn(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  const ok = ['---', 'title: A title', 'group: trident', 'status: open', 'priority: P1', 'cutover: false', '---', '', 'body'].join('\n')

  test('a well-formed item parses', () => {
    withItem('fine.md', ok, (dir) => {
      const item = readSpecItem(dir, 'fine.md')
      expect(item.slug).toBe('fine')
      expect(item.group).toBe('trident')
      expect(item.needs_spec).toBe(false)
    })
  })

  test('an unknown group is refused', () => {
    withItem('bad.md', ok.replace('group: trident', 'group: tridnet'), (dir) => {
      expect(() => readSpecItem(dir, 'bad.md')).toThrow(/'group' is 'tridnet'/)
    })
  })

  test('an invented priority is refused', () => {
    withItem('bad.md', ok.replace('priority: P1', 'priority: urgent'), (dir) => {
      expect(() => readSpecItem(dir, 'bad.md')).toThrow(/'priority' is 'urgent'/)
    })
  })

  test('a missing required key is refused', () => {
    withItem('bad.md', ok.replace('cutover: false\n', ''), (dir) => {
      expect(() => readSpecItem(dir, 'bad.md')).toThrow(/missing required frontmatter 'cutover'/)
    })
  })

  test('an over-long title is refused', () => {
    withItem('bad.md', ok.replace('title: A title', `title: ${'x'.repeat(71)}`), (dir) => {
      expect(() => readSpecItem(dir, 'bad.md')).toThrow(/title is 71 chars/)
    })
  })

  test('a file with no frontmatter is refused', () => {
    withItem('bad.md', '# just a heading\n', (dir) => {
      expect(() => readSpecItem(dir, 'bad.md')).toThrow(/no frontmatter/)
    })
  })

  test('the index file itself is never read as an item', () => {
    withItem('fine.md', ok, (dir) => {
      writeFileSync(join(dir, INDEX_FILENAME), 'not an item, has no frontmatter')
      expect(readSpecItems(dir).map((i) => i.slug)).toEqual(['fine'])
    })
  })

  // A title with a backslash before a pipe is the case that breaks pipe-only escaping:
  // `\|` becomes `\\|`, an escaped BACKSLASH plus a LIVE separator, so the text
  // escapes its own column. Order of replacement is the fix, so pin the order.
  test('a cell escapes backslashes before pipes, so nothing breaks out of its column', () => {
    expect(escapeCell('a|b')).toBe('a\\|b')
    expect(escapeCell('a\\|b')).toBe('a\\\\\\|b')
    expect(escapeCell('a\\b')).toBe('a\\\\b')
    // The bug this pins: pipe-only escaping would yield 'a\\\\|b' — a live separator.
    expect(escapeCell('a\\|b').endsWith('\\\\|b')).toBe(true)
  })

  test('quoted frontmatter values are unquoted', () => {
    expect(parseFrontmatter('---\nlegacy_ref: "a b"\n---\n', 'x').legacy_ref).toBe('a b')
  })
})
