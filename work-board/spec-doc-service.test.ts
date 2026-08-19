/**
 * WorkBoardSpecDocService (M1 play-button + on-disk spec) — the ONE seam that
 * couples spec-doc policy to real I/O. Uses a real `WorkBoardStore` (SQLite) and
 * an in-memory docs stub so we prove: a non-trivial create writes a doc + links
 * the card; a trivial create stays title-only; an explicit ref wins; a doc-write
 * failure degrades to a title-only card; and resolveTaskForItem reads the doc
 * (falling back to the title).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedMigratedDb } from '../tests/support/migrated-db.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { WorkBoardStore } from './store.ts'
import { WorkBoardSpecDocService, type SpecDocStore,
  stripFrontmatter,
} from './spec-doc-service.ts'
import { docPathFromDesignRef } from './spec-doc.ts'

const PROJECT = 'proj-1'

/** In-memory docs stub — records writes + serves reads by exact path. */
class FakeDocs implements SpecDocStore {
  readonly writes: Array<{ project_id: string; path: string; content: string }> = []
  readonly files = new Map<string, string>()
  failWrite = false
  async writeDoc(input: { project_id: string; path: string; content: string }): Promise<unknown> {
    if (this.failWrite) throw new Error('disk full')
    this.writes.push(input)
    this.files.set(input.path, input.content)
    return {}
  }
  async readDoc(_project_id: string, path: string): Promise<{ content: string }> {
    const c = this.files.get(path)
    if (c === undefined) throw new Error(`no doc at ${path}`)
    return { content: c }
  }
}

let tmp: string
let db: ProjectDb
let store: WorkBoardStore
let docs: FakeDocs
let svc: WorkBoardSpecDocService

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-spec-doc-svc-'))
  seedMigratedDb(join(tmp, 'project.db'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  store = new WorkBoardStore(db)
  docs = new FakeDocs()
  svc = new WorkBoardSpecDocService({ docs, board: store, log: { warn: () => {} } })
})
afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

describe('createCardWithOptionalSpec', () => {
  test('non-trivial spec → writes a plans/ doc + sets a neutron-docs ref', async () => {
    const item = await svc.createCardWithOptionalSpec(PROJECT, PROJECT, {
      title: 'Wire CSV export',
      spec: 'Add a CSV export button.\nWire it to /export.\nCover the happy path + an empty-set case with tests.',
    })
    expect(docs.writes.length).toBe(1)
    const written = docs.writes[0]!
    expect(written.project_id).toBe(PROJECT)
    expect(written.path).toMatch(/^plans\/wire-csv-export-[a-z0-9]+\.md$/)
    expect(written.content).toContain('# Wire CSV export')
    expect(written.content).toContain('Wire it to /export.')
    // The card is linked to the doc.
    expect(item.design_doc_ref).toBe(`neutron-docs:${written.path}`)
    expect(docPathFromDesignRef(item.design_doc_ref)).toBe(written.path)
    // And it's persisted on the row.
    const reread = store.get(PROJECT, item.id)
    expect(reread?.design_doc_ref).toBe(item.design_doc_ref)
  })

  test('trivial one-liner → title-only, NO doc, null ref', async () => {
    const item = await svc.createCardWithOptionalSpec(PROJECT, PROJECT, {
      title: 'build a meditation timer',
      spec: 'build a meditation timer',
    })
    expect(docs.writes.length).toBe(0)
    expect(item.design_doc_ref).toBeNull()
  })

  test('no spec → title-only, NO doc', async () => {
    const item = await svc.createCardWithOptionalSpec(PROJECT, PROJECT, { title: 'quick fix' })
    expect(docs.writes.length).toBe(0)
    expect(item.design_doc_ref).toBeNull()
  })

  test('explicit design_doc_ref WINS — never overwritten by a generated doc', async () => {
    const item = await svc.createCardWithOptionalSpec(PROJECT, PROJECT, {
      title: 'has a doc already',
      design_doc_ref: 'https://example.test/spec',
      spec: 'a long spec that would otherwise be persisted to a doc file on disk somewhere useful',
    })
    expect(docs.writes.length).toBe(0)
    expect(item.design_doc_ref).toBe('https://example.test/spec')
  })

  test('ensureDocsDir is invoked BEFORE the doc write (missing docs/ root)', async () => {
    const order: string[] = []
    const trackingDocs = new FakeDocs()
    const origWrite = trackingDocs.writeDoc.bind(trackingDocs)
    trackingDocs.writeDoc = async (input) => {
      order.push('write')
      return origWrite(input)
    }
    const svc2 = new WorkBoardSpecDocService({
      docs: trackingDocs,
      board: store,
      log: { warn: () => {} },
      ensureDocsDir: async () => {
        order.push('ensure')
      },
    })
    await svc2.createCardWithOptionalSpec(PROJECT, PROJECT, {
      title: 'needs a doc',
      spec: 'a substantial spec\n- with\n- structure\n- worth persisting',
    })
    expect(order).toEqual(['ensure', 'write'])
  })

  test('doc-write failure degrades to a title-only card (no throw)', async () => {
    docs.failWrite = true
    const item = await svc.createCardWithOptionalSpec(PROJECT, PROJECT, {
      title: 'important work',
      spec: 'a substantial multi-requirement spec\n- one\n- two\n- three',
    })
    // Card still created; just no doc/ref.
    expect(item.title).toBe('important work')
    expect(item.design_doc_ref).toBeNull()
    expect(store.get(PROJECT, item.id)).not.toBeNull()
  })
})

describe('resolveTaskForItem', () => {
  test('reads the linked doc content as the task', async () => {
    const item = await svc.createCardWithOptionalSpec(PROJECT, PROJECT, {
      title: 'Wire CSV export',
      spec: 'Add a CSV export button.\nWire it to the /export endpoint.\nCover the empty-set case with tests.',
    })
    const task = await svc.resolveTaskForItem(PROJECT, {
      title: item.title,
      design_doc_ref: item.design_doc_ref,
    })
    expect(task).toContain('# Wire CSV export')
    expect(task).toContain('/export')
  })

  test('the RESOLVED task carries the body and NOT the YAML header', async () => {
    // THE ASSERTION THAT MATTERS. The pure-helper tests above passed even with
    // `resolveTaskForItem` reverted to raw content, because they never called it.
    // This drives the real round-trip: createCardWithOptionalSpec writes the doc
    // (frontmatter and all) and resolveTaskForItem reads it back.
    const item = await svc.createCardWithOptionalSpec(PROJECT, PROJECT, {
      title: 'P1 — email pipeline store + poller',
      spec: 'GOAL: escalated email notifications live end to end.\nOut of scope: the digest.\nSHIPS EMPTY sender rules.',
    })
    const task = await svc.resolveTaskForItem(PROJECT, {
      title: item.title,
      design_doc_ref: item.design_doc_ref,
    })
    // The body survives…
    expect(task).toContain('GOAL: escalated email notifications')
    // …and none of the frontmatter keys leak into the builder's first instruction.
    expect(task).not.toContain('type: plan')
    expect(task).not.toContain('created:')
    // And it must not merely START past the header by accident — the first
    // non-empty line is real content, which is what the branch slug is built from.
    expect(task.trim().startsWith('---')).toBe(false)
  })

  test('falls back to the title when there is no doc ref', async () => {
    const task = await svc.resolveTaskForItem(PROJECT, {
      title: 'just the title',
      design_doc_ref: null,
    })
    expect(task).toBe('just the title')
  })

  test('falls back to the title when the doc read fails', async () => {
    const task = await svc.resolveTaskForItem(PROJECT, {
      title: 'fallback title',
      design_doc_ref: 'neutron-docs:plans/missing.md',
    })
    expect(task).toBe('fallback title')
  })
})

describe('the builder gets the doc BODY, not its frontmatter', () => {
  // Observed live 2026-08-10 on two separate email-core runs: the dispatch branch
  // came out `trident/type-plan-title-p1-email-pipeline-s`. The slug derives from the
  // task text, so the leaked YAML was visible in the branch NAME — while the real
  // damage was invisible, the builder opening its brief on `type: plan` instead of the
  // scope. `writeSpecDoc` prepends that block; `resolveTaskForItem` returned it.

  const FM = ['---', 'type: plan', 'title: P1 — email pipeline', 'created: 2026-08-07T23:16:07.171Z', '---'].join('\n')
  const BODY = '# P1 — email pipeline\n\nGOAL: escalated email notifications live end to end.'

  test('a doc with frontmatter yields only the body', () => {
    expect(stripFrontmatter(`${FM}\n\n${BODY}`).trim()).toBe(BODY)
  })

  test('a doc with NO frontmatter is returned untouched', () => {
    expect(stripFrontmatter(BODY)).toBe(BODY)
  })

  test('a mid-document `---` is a horizontal rule, NOT a fence', () => {
    // The load-bearing case. This repo's plan docs use `---` as section dividers
    // constantly; treating one as a closing fence would silently truncate the brief
    // from the top, which is strictly worse than leaving the header on.
    // TWO rules, deliberately. With only one, a mutant that looks for a fence
    // ANYWHERE still finds no closer and returns the input — so a single-rule
    // fixture cannot tell the correct rule from the broken one. It passed both.
    const withRule = 'Scope line one.\n\n---\n\nScope line two.\n\n---\n\nScope line three.'
    expect(stripFrontmatter(withRule)).toBe(withRule)
  })

  test('an UNCLOSED opener is left alone rather than guessed at', () => {
    const unclosed = '---\ntype: plan\nno closing fence here'
    expect(stripFrontmatter(unclosed)).toBe(unclosed)
  })

  test('a fence must be exactly `---`, not merely start with it', () => {
    const dashes = '----\nnot frontmatter\n----'
    expect(stripFrontmatter(dashes)).toBe(dashes)
  })

  test('leading blank lines before the fence are tolerated', () => {
    expect(stripFrontmatter(`\n\n${FM}\n${BODY}`).trim()).toBe(BODY)
  })

  test('a doc that is ONLY frontmatter strips to empty, so the caller falls back to the title', () => {
    // Empty is the RIGHT result here: resolveTaskForItem treats empty as "no usable
    // spec" and returns the card title, rather than dispatching a blank brief.
    expect(stripFrontmatter(FM).trim()).toBe('')
  })
})
