/**
 * gateway/__tests__/doc-store-root-status.test.ts — P-B.
 *
 * The standard per-project state doc `STATUS.md` lives at the PROJECT ROOT
 * (`Projects/<id>/STATUS.md`, a sibling of `docs/`), OUTSIDE the docs root the
 * DocStore is otherwise confined to. Ryan wants it surfaced as a first-class
 * Document, pinned to the top of the list. These tests cover the gateway side:
 *
 *   1. `tree()` surfaces the project-root STATUS.md as a top-level entry, LEADING
 *      the tree (so it's first in the Documents list) even though a docs/ file
 *      sorts before it alphabetically.
 *   2. `readDoc('STATUS.md')` reads the project-root file (not a phantom
 *      docs/STATUS.md).
 *   3. `writeDoc('STATUS.md')` edits the real project-root file in place.
 *   4. The redirect is tight: a real `docs/STATUS.md` still wins, and no other
 *      path escapes the docs root.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DocStore } from '../http/doc-store.ts'

const PROJECT = 'acme'
const created: string[] = []

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'neutron-docstore-status-'))
  created.push(home)
  const projectRoot = join(home, 'Projects', PROJECT)
  mkdirSync(join(projectRoot, 'docs'), { recursive: true })
  return home
}

afterEach(() => {
  while (created.length > 0) {
    const d = created.pop()
    if (d !== undefined) rmSync(d, { recursive: true, force: true })
  }
})

describe('DocStore — project-root STATUS.md surfacing (P-B)', () => {
  it('surfaces the project-root STATUS.md as the FIRST tree entry', async () => {
    const home = makeHome()
    const projectRoot = join(home, 'Projects', PROJECT)
    // A docs/ file that sorts before "STATUS.md" alphabetically ('history').
    writeFileSync(join(projectRoot, 'docs', 'history.md'), '# History\n')
    writeFileSync(join(projectRoot, 'STATUS.md'), '# Status\nreadme\n')
    const store = new DocStore({ owner_home: home })

    const tree = await store.tree(PROJECT)
    expect(tree.length).toBe(2)
    // STATUS.md leads the list despite 'history.md' sorting first in docs/.
    expect(tree[0]?.path).toBe('STATUS.md')
    expect(tree[0]?.kind).toBe('file')
    expect(tree[1]?.path).toBe('history.md')
  })

  it('surfaces STATUS.md even when docs/ is empty', async () => {
    const home = makeHome()
    const projectRoot = join(home, 'Projects', PROJECT)
    writeFileSync(join(projectRoot, 'STATUS.md'), '# Status\n')
    const store = new DocStore({ owner_home: home })

    const tree = await store.tree(PROJECT)
    expect(tree.map((n) => n.path)).toEqual(['STATUS.md'])
  })

  it('does NOT surface STATUS.md when the project root has none', async () => {
    const home = makeHome()
    const projectRoot = join(home, 'Projects', PROJECT)
    writeFileSync(join(projectRoot, 'docs', 'history.md'), '# History\n')
    const store = new DocStore({ owner_home: home })

    const tree = await store.tree(PROJECT)
    expect(tree.map((n) => n.path)).toEqual(['history.md'])
  })

  it('readDoc("STATUS.md") reads the project-root file', async () => {
    const home = makeHome()
    const projectRoot = join(home, 'Projects', PROJECT)
    writeFileSync(join(projectRoot, 'STATUS.md'), '# Root Status\nbody\n')
    const store = new DocStore({ owner_home: home })

    const doc = await store.readDoc(PROJECT, 'STATUS.md')
    expect(doc.content).toBe('# Root Status\nbody\n')
    expect(doc.path).toBe('STATUS.md')
  })

  it('writeDoc("STATUS.md") edits the real project-root file in place', async () => {
    const home = makeHome()
    const projectRoot = join(home, 'Projects', PROJECT)
    writeFileSync(join(projectRoot, 'STATUS.md'), 'old\n')
    const store = new DocStore({ owner_home: home })

    await store.writeDoc({ project_id: PROJECT, path: 'STATUS.md', content: 'new state\n' })
    // The project-root file is overwritten…
    expect(readFileSync(join(projectRoot, 'STATUS.md'), 'utf8')).toBe('new state\n')
    // …and NO phantom docs/STATUS.md was created.
    expect(() => readFileSync(join(projectRoot, 'docs', 'STATUS.md'), 'utf8')).toThrow()
    // Round-trips through readDoc.
    expect((await store.readDoc(PROJECT, 'STATUS.md')).content).toBe('new state\n')
  })

  it('deleteDoc("STATUS.md") removes the real project-root file (no 404)', async () => {
    const home = makeHome()
    const projectRoot = join(home, 'Projects', PROJECT)
    writeFileSync(join(projectRoot, 'STATUS.md'), 'state\n')
    const store = new DocStore({ owner_home: home })

    await store.deleteDoc(PROJECT, 'STATUS.md')
    expect(() => readFileSync(join(projectRoot, 'STATUS.md'), 'utf8')).toThrow()
    // Gone from the tree too.
    expect((await store.tree(PROJECT)).some((n) => n.path === 'STATUS.md')).toBe(false)
  })

  it('moveDoc("STATUS.md" → docs/renamed.md) relocates the real root file', async () => {
    const home = makeHome()
    const projectRoot = join(home, 'Projects', PROJECT)
    writeFileSync(join(projectRoot, 'STATUS.md'), 'state\n')
    const store = new DocStore({ owner_home: home })

    await store.moveDoc(PROJECT, 'STATUS.md', 'renamed.md')
    // The root file moved INTO docs/ under the new name…
    expect(readFileSync(join(projectRoot, 'docs', 'renamed.md'), 'utf8')).toBe('state\n')
    // …and no longer exists at the project root.
    expect(() => readFileSync(join(projectRoot, 'STATUS.md'), 'utf8')).toThrow()
  })

  it('prefers a real docs/STATUS.md over the project-root copy (no ambiguity)', async () => {
    const home = makeHome()
    const projectRoot = join(home, 'Projects', PROJECT)
    writeFileSync(join(projectRoot, 'STATUS.md'), 'ROOT copy\n')
    writeFileSync(join(projectRoot, 'docs', 'STATUS.md'), 'DOCS copy\n')
    const store = new DocStore({ owner_home: home })

    // Tree contains exactly one top-level STATUS.md (the docs/ one); no synthetic
    // duplicate is prepended.
    const tree = await store.tree(PROJECT)
    expect(tree.filter((n) => n.path === 'STATUS.md').length).toBe(1)
    // read/write resolve to the docs/ copy when it exists.
    expect((await store.readDoc(PROJECT, 'STATUS.md')).content).toBe('DOCS copy\n')
  })
})
