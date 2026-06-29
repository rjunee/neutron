/**
 * doc_search must NOT surface a deleted project's documents (M1 E2E Round 4, bug E).
 *
 * THE BUG: `delete_project` is a metadata-only soft delete (sets
 * `projects.deleted_at`) and never removes the on-disk `Projects/<id>/` folder.
 * The doc-search indexer enumerates projects by a bare disk scan and only
 * purges a project whose folder vanished — so a deleted project stays indexed
 * and `doc_search` keeps returning its docs, contradicting the user's "delete".
 *
 * THE FIX: `buildLiveProjectEnumerator(db)` filters the disk scan against rows
 * with `deleted_at IS NOT NULL`, so the indexer purges the deleted project on
 * its next refresh.
 *
 * This drives the REAL DocSearchRuntime + indexer + store over a fixture tree.
 * The control case (default disk-scan enumerator) demonstrates the bug: the
 * deleted project's doc IS returned without the filter.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '../../migrations/runner.ts'
import { ProjectDb } from '../../persistence/index.ts'
import { DocSearchIndex } from '../../doc-search/store.ts'
import { DocSearchRuntime } from '../../doc-search/runtime.ts'
import { buildLiveProjectEnumerator } from '../doc-search-live-enumerator.ts'

let ownerHome: string
let dbPath: string
let db: ProjectDb
let index: DocSearchIndex

async function seedTree(root: string): Promise<void> {
  const mk = async (rel: string, body: string): Promise<void> => {
    const abs = join(root, 'Projects', rel)
    await mkdir(join(abs, '..'), { recursive: true })
    await writeFile(abs, body, 'utf8')
  }
  await mk('alpha/notes.md', '# Alpha\n\nAlpha tracks the rocketship analytics rollout.')
  await mk('beta/notes.md', '# Beta\n\nBeta owns the submarine logistics migration.')
}

function insertProject(id: string, deleted: boolean): void {
  db.raw().run(
    `INSERT INTO projects
       (id, name, description, persona, privacy_mode, billing_mode,
        created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, NULL, 'private', 'personal', ?, ?, ?)`,
    [id, id, '', '2026-06-29T00:00:00.000Z', '2026-06-29T00:00:00.000Z', deleted ? '2026-06-29T00:00:00.000Z' : null],
  )
}

beforeEach(async () => {
  ownerHome = mkdtempSync(join(tmpdir(), 'neutron-docsearch-deleted-'))
  dbPath = join(ownerHome, 'project.db')
  db = ProjectDb.open(dbPath)
  applyMigrations(db.raw())
  await seedTree(ownerHome)
  index = DocSearchIndex.open(':memory:')
})

afterEach(() => {
  index.close()
  db.close()
  rmSync(ownerHome, { recursive: true, force: true })
})

describe('doc-search excludes soft-deleted projects', () => {
  test('the live enumerator drops a project marked deleted_at; doc_search no longer returns it', async () => {
    insertProject('alpha', false)
    insertProject('beta', true) // the user deleted "beta"

    const runtime = new DocSearchRuntime({
      ownerHome,
      index,
      enumerateProjects: buildLiveProjectEnumerator(db),
    })
    await runtime.ensureFresh(true)

    // The deleted project's doc must NOT be searchable.
    const deletedHits = await runtime.search({ query: 'submarine logistics' })
    expect(deletedHits).toEqual([])

    // The live project is still fully searchable.
    const liveHits = await runtime.search({ query: 'rocketship analytics' })
    expect(liveHits.length).toBeGreaterThanOrEqual(1)
    expect(liveHits[0]!.project).toBe('alpha')
  })

  test('a re-deletion is reflected on the next refresh (project purged from the index)', async () => {
    insertProject('alpha', false)
    insertProject('beta', false) // beta starts live

    const runtime = new DocSearchRuntime({
      ownerHome,
      index,
      refreshIntervalMs: 0, // no throttle for the test
      enumerateProjects: buildLiveProjectEnumerator(db),
    })
    await runtime.ensureFresh(true)
    expect((await runtime.search({ query: 'submarine logistics' })).length).toBeGreaterThanOrEqual(1)

    // User deletes beta — soft delete, folder stays on disk.
    db.raw().run(`UPDATE projects SET deleted_at = ? WHERE id = 'beta'`, ['2026-06-29T01:00:00.000Z'])
    await runtime.ensureFresh(true)
    expect(await runtime.search({ query: 'submarine logistics' })).toEqual([])
  })

  test('CONTROL: the default disk-scan enumerator still returns the deleted project (the bug)', async () => {
    insertProject('alpha', false)
    insertProject('beta', true)

    // No enumerateProjects override → bare disk scan, no deleted_at awareness.
    const runtime = new DocSearchRuntime({ ownerHome, index })
    await runtime.ensureFresh(true)

    const deletedHits = await runtime.search({ query: 'submarine logistics' })
    expect(deletedHits.length).toBeGreaterThanOrEqual(1) // <-- pre-fix behavior
  })
})
