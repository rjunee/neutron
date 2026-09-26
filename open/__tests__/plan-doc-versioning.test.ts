import { localVaultBackup } from '../../tests/support/vault-backup.ts'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DocVersionStore } from '@neutronai/gateway/git/doc-version-store.ts'
import { DocStore } from '@neutronai/gateway/http/doc-store.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { TridentRunStore } from '@neutronai/trident/store.ts'
import { WorkBoardSpecDocService } from '@neutronai/work-board/spec-doc-service.ts'
import { docPathFromDesignRef } from '@neutronai/work-board/spec-doc.ts'
import { WorkBoardStore } from '@neutronai/work-board/store.ts'
import { seedMigratedDb } from '../../tests/support/migrated-db.ts'

const PROJECT = 'project-one'
const SCOPE = 'project-one'
const ORIGINAL_SPEC = 'Build the export control.\n\nAcceptance: preserve empty rows and quote commas.'

let tempRoot: string
let db: ProjectDb

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'plan-doc-versioning-'))
  mkdirSync(join(tempRoot, 'Projects', PROJECT, 'docs'), { recursive: true })
  const dbPath = join(tempRoot, 'project.db')
  seedMigratedDb(dbPath)
  db = ProjectDb.open(dbPath)
})

afterEach(() => {
  db.close()
  rmSync(tempRoot, { recursive: true, force: true })
})

describe('card plan-doc versioning', () => {
  test('the production composer supplies the version store to its document writer', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'composer.ts'), 'utf8')
    expect(source).toMatch(/new DocVersionStore\(\{[^}]*backupStore: projectBackupStore/)
    expect(source).toMatch(/new DocStore\(\{[\s\S]*?versionStore: docVersionStore,[\s\S]*?onMutationSuccess:/)
  })

  test('the writer commits the visible doc and the run retains the dispatched version', async () => {
    const versions = new DocVersionStore({ owner_home: tempRoot, project_slug: SCOPE, backupStore: localVaultBackup(tempRoot, SCOPE) })
    const docs = new DocStore({ owner_home: tempRoot, versionStore: versions })
    const board = new WorkBoardStore(db)
    const service = new WorkBoardSpecDocService({ docs, board })

    const item = await service.createCardWithOptionalSpec(SCOPE, PROJECT, {
      title: 'Version the export plan',
      spec: ORIGINAL_SPEC,
    })
    const path = docPathFromDesignRef(item.design_doc_ref)
    expect(path).toMatch(/^plans\/version-the-export-plan-[a-z0-9]+\.md$/)

    const firstHistory = await versions.history(PROJECT, path as string)
    expect(firstHistory.entries).toHaveLength(1)
    expect(firstHistory.entries[0]?.message).toBe(`create: ${path}`)
    const originalVersion = await versions.read_at(
      PROJECT,
      path as string,
      firstHistory.entries[0]!.sha,
    )
    expect(originalVersion.content).toContain(ORIGINAL_SPEC)

    const dispatchedTask = await service.resolveTaskForItem(PROJECT, item)
    const run = await new TridentRunStore(db).create({
      slug: 'version-the-export-plan',
      project_slug: SCOPE,
      repo_path: '.',
      task: dispatchedTask,
    })
    await docs.writeDoc({
      project_id: PROJECT,
      path: path as string,
      content: '# Version the export plan\n\nReplacement spec.\n',
    })

    expect((await new TridentRunStore(db).get(run.id))?.task).toBe(dispatchedTask)
    expect(dispatchedTask).toContain(ORIGINAL_SPEC)
    expect((await versions.history(PROJECT, path as string)).entries).toHaveLength(2)
    expect((await versions.read_at(PROJECT, path as string, firstHistory.entries[0]!.sha)).content)
      .toContain(ORIGINAL_SPEC)
  })
})
