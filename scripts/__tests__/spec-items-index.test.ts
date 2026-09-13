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
  countStructure,
  checkDeclaredStructure,
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

// The blocker list answers "what is still in the way", but `cutover` answers "does this
// item gate the cutover" — provenance, which stays true after the work lands. Filtering on
// the flag alone conflated the two, and the index went on naming finished items as
// blockers. Unobservable until an item was first both `cutover` and not `open`, so pin
// BOTH directions here: presence for open, absence for each terminal status.
describe('the blocker list is what is still in the way, not what ever gated the cutover', () => {
  const base = { group: 'trident', priority: 'P0', cutover: true, needs_spec: false } as const
  /** The `## Blocking the cutover` section alone. A done item still appears in the main
   *  table below it, so a whole-document `not.toContain` would pass for the wrong reason. */
  function blockerSection(rendered: string): string {
    const start = rendered.indexOf('## Blocking the cutover')
    if (start === -1) return ''
    const rest = rendered.slice(start + 1)
    const end = rest.indexOf('\n## ')
    return end === -1 ? rest : rest.slice(0, end)
  }

  // The OTHER half of the conjunction, and the mutant the cases below do not catch on
  // their own: dropping the flag entirely (`i.status === 'open'`) passes every one of them
  // while listing the whole open queue as cutover blockers.
  test('an open item that does NOT gate the cutover is absent from the list and the count', () => {
    const rendered = renderIndex([
      { ...base, slug: 'gates-it', title: 'Gates it', status: 'open' },
      { ...base, cutover: false, priority: 'P1', slug: 'unrelated', title: 'Unrelated', status: 'open' },
    ])
    expect(blockerSection(rendered)).not.toContain('unrelated')
    expect(blockerSection(rendered)).toContain('gates-it')
    expect(rendered).toContain('(unrelated.md)') // still an item; only the blocker list drops it
    expect(rendered).toContain('**2 items.** 1 blocks the harness-orchestrator cutover')
  })

  // A tree with open work but nothing gating the cutover must drop the heading, same as
  // the all-done tree below — for the other reason.
  test('no cutover item at all leaves no blocker section', () => {
    const rendered = renderIndex([{ ...base, cutover: false, priority: 'P1', slug: 'unrelated', title: 'Unrelated', status: 'open' }])
    expect(rendered).not.toContain('## Blocking the cutover')
    expect(rendered).toContain('**1 items.** 0 block the harness-orchestrator cutover')
  })

  test('an open cutover item is listed', () => {
    const section = blockerSection(renderIndex([{ ...base, slug: 'still-open', title: 'Still open', status: 'open' }]))
    expect(section).toContain('still-open')
  })

  test('a done cutover item is NOT listed, though it is still in the table', () => {
    const rendered = renderIndex([{ ...base, slug: 'landed', title: 'Landed', status: 'done' }])
    expect(blockerSection(rendered)).not.toContain('landed')
    expect(rendered).toContain('(landed.md)') // still an item; only the blocker list drops it
  })

  test('a wont-do cutover item is NOT listed either', () => {
    const rendered = renderIndex([{ ...base, slug: 'abandoned', title: 'Abandoned', status: 'wont-do' }])
    expect(blockerSection(rendered)).not.toContain('abandoned')
    expect(rendered).toContain('(abandoned.md)')
  })

  // The count in the summary line is computed from the same list, so it must move too —
  // a fix applied to the section but not the sentence would leave the prose lying.
  test('the summary count counts only the open ones', () => {
    const rendered = renderIndex([
      { ...base, slug: 'still-open', title: 'Still open', status: 'open' },
      { ...base, slug: 'landed', title: 'Landed', status: 'done' },
      { ...base, slug: 'abandoned', title: 'Abandoned', status: 'wont-do' },
    ])
    expect(rendered).toContain('**3 items.** 1 blocks the harness-orchestrator cutover')
  })

  // With no open cutover item the heading must be absent entirely, not an empty section
  // captioned "These are the items the cutover is gated on."
  test('all-done leaves no blocker section at all', () => {
    const rendered = renderIndex([{ ...base, slug: 'landed', title: 'Landed', status: 'done' }])
    expect(rendered).not.toContain('## Blocking the cutover')
    expect(rendered).toContain('**1 items.** 0 block the harness-orchestrator cutover')
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

  // The failure this pins: an edit that replaced "from a heading to end of file" dropped a
  // whole trailing section, and every other check here still passed. A declared structure
  // makes truncation fail at the moment of the edit.
  describe('declared structure', () => {
    const body = ['## A', '- [ ] one', '- [ ] two', '1. **c one**', '2. **c two**', '## B', 'x'].join('\n')

    test('counts sections, criteria and contract items', () => {
      expect(countStructure(body)).toEqual({ sections: 2, criteria: 2, contract_items: 2 })
    })

    test('an item that declares nothing is unconstrained', () => {
      expect(() => checkDeclaredStructure('x', {}, body)).not.toThrow()
    })

    test('a matching declaration passes', () => {
      expect(() =>
        checkDeclaredStructure('x', { sections: '2', criteria: '2', contract_items: '2' }, body),
      ).not.toThrow()
    })

    test('a dropped trailing section fails, naming both numbers', () => {
      const truncated = body.slice(0, body.indexOf('## B'))
      expect(() => checkDeclaredStructure('x', { sections: '2' }, truncated)).toThrow(
        /declares sections: 2 but the body has 1/,
      )
    })

    test('a removed criterion fails', () => {
      expect(() => checkDeclaredStructure('x', { criteria: '2' }, body.replace('- [ ] two\n', ''))).toThrow(
        /declares criteria: 2 but the body has 1/,
      )
    })

    test('a non-integer declaration is refused rather than ignored', () => {
      expect(() => checkDeclaredStructure('x', { sections: 'two' }, body)).toThrow(/must be an integer/)
    })

    // The counter is an instrument, so it needs adversarial inputs for COUNTING — not only a
    // replay of the one edit it was built to catch. Markdown-shaped text inside a fence is not
    // structure; counting it lets a dropped section be BALANCED BACK by an example.
    describe('fenced code is not structure', () => {
      const F = '```'

      test('look-alikes inside a fence count for nothing', () => {
        expect(countStructure(`${F}\n## fake\n- [ ] fake\n1. **fake**\n${F}`)).toEqual({
          sections: 0,
          criteria: 0,
          contract_items: 0,
        })
      })

      test('real structure around a fence still counts', () => {
        expect(countStructure(`## real\n${F}\n## fake\n${F}\n- [ ] real\n1. **real**`)).toEqual({
          sections: 1,
          criteria: 1,
          contract_items: 1,
        })
      })

      test('a tilde fence encloses too, and does not close a backtick fence', () => {
        expect(countStructure(`~~~\n## fake\n~~~\n## real`).sections).toBe(1)
        expect(countStructure(`${F}\n## fake\n~~~\n## fake2\n${F}`).sections).toBe(0)
      })

      test('a fence may be indented up to three spaces', () => {
        expect(countStructure(`   ${F}\n## fake\n   ${F}`).sections).toBe(0)
      })

      test('a shorter run does not close a longer fence, and an info string never closes one', () => {
        expect(countStructure(`${F}\`\n## fake\n${F}\n## fake2\n${F}\`\n## real`).sections).toBe(1)
        expect(countStructure(`${F}\n## fake\n${F}bash\n## fake2\n${F}\n## real`).sections).toBe(1)
      })

      // An unterminated fence under-counts without limit, which is the same miscount in the
      // more dangerous direction, so it is a loud failure rather than a silent zero.
      test('an unterminated fence throws instead of swallowing the rest of the file', () => {
        expect(() => countStructure(`${F}\n## fake\n## fake2`)).toThrow(/unterminated code fence/)
        expect(() => checkDeclaredStructure('x', { sections: '1' }, `${F}\n## fake`)).toThrow(
          /x: unterminated code fence/,
        )
      })

      test('an item declaring nothing is unaffected by an unterminated fence', () => {
        expect(() => checkDeclaredStructure('x', {}, `${F}\n## fake`)).not.toThrow()
      })

      // The partner to the positive control: it is not enough that removing a section fails —
      // removing it and replacing it with a fenced look-alike must fail too, or the guard's
      // own subject can forge its evidence.
      test('a dropped section replaced by a fenced look-alike still fails', () => {
        const forged = body.replace('## B', `${F}\n## B\n${F}`)
        expect(countStructure(forged).sections).toBe(1)
        expect(() => checkDeclaredStructure('x', { sections: '2' }, forged)).toThrow(
          /declares sections: 2 but the body has 1/,
        )
      })

      test('a dropped criterion replaced by a fenced look-alike still fails', () => {
        const forged = body.replace('- [ ] two', `${F}\n- [ ] two\n${F}`)
        expect(() => checkDeclaredStructure('x', { criteria: '2' }, forged)).toThrow(
          /declares criteria: 2 but the body has 1/,
        )
      })
    })
  })
})
