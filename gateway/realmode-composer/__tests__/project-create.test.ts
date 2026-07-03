/**
 * Unit tests for the shared project-creation primitives (`project-create.ts`)
 * + the `create_project` agent tool (`create-project-tool.ts`).
 *
 * `createProjectRow` is the fast, deterministic half of the create path (no
 * disk I/O): it must land a real `projects` row + its cli wow-shell `topics`
 * binding so the rail query (`SELECT id,name FROM projects WHERE deleted_at IS
 * NULL`) returns it, be idempotent on re-create, reuse a pre-existing row, and
 * skip a soft-deleted id (never resurrect a deleted project).
 */

import { test, expect } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ProjectDb } from '../../../persistence/index.ts'
import { applyMigrations } from '../../../migrations/runner.ts'
import { ToolRegistry } from '../../../tools/registry.ts'
import { createProjectRow, type ProjectScaffoldDeps } from '../project-create.ts'
import {
  CREATE_PROJECT_TOOL,
  registerCreateProjectToolSurface,
  type CreateProjectToolService,
} from '../create-project-tool.ts'

const PROJECT_SLUG = 'acme'

function makeDb(): ProjectDb {
  const dir = mkdtempSync(join(tmpdir(), 'project-create-'))
  const db = ProjectDb.open(join(dir, 'project.db'))
  applyMigrations(db.raw())
  return db
}

function makeDeps(db: ProjectDb): ProjectScaffoldDeps {
  return {
    owner_home: mkdtempSync(join(tmpdir(), 'project-create-home-')),
    project_slug: PROJECT_SLUG,
    db,
    now: () => 1_700_000_000_000,
  }
}

function railRows(db: ProjectDb): { id: string; name: string }[] {
  return db
    .prepare<{ id: string; name: string }, []>(
      `SELECT id, name FROM projects WHERE deleted_at IS NULL ORDER BY id`,
    )
    .all()
}

test('createProjectRow lands a usable project row + topic binding', async () => {
  const db = makeDb()
  const deps = makeDeps(db)

  const res = await createProjectRow(deps, { name: '  My Taxes  ' })
  expect(res.outcome).toBe('created')
  expect(res.project_id).toBe('my-taxes') // slugified, trimmed
  expect(res.name).toBe('My Taxes')

  // The rail query surfaces it.
  expect(railRows(db)).toEqual([{ id: 'my-taxes', name: 'My Taxes' }])

  // Its durable wow-shell topic binding exists.
  const topic = db
    .prepare<{ channel_topic_id: string; project_id: string }, [string]>(
      `SELECT channel_topic_id, project_id FROM topics WHERE project_id = ?`,
    )
    .get('my-taxes')
  expect(topic).not.toBeNull()
  expect(topic?.channel_topic_id).toBe('wow-shell-my-taxes')
})

test('createProjectRow is idempotent on the name (no duplicate row)', async () => {
  const db = makeDb()
  const deps = makeDeps(db)

  const first = await createProjectRow(deps, { name: 'Garden' })
  expect(first.outcome).toBe('created')
  const second = await createProjectRow(deps, { name: 'garden' }) // same slug
  expect(second.outcome).toBe('existing')
  expect(second.project_id).toBe('garden')

  // Exactly ONE row, ONE topic.
  expect(railRows(db)).toEqual([{ id: 'garden', name: 'Garden' }])
  const topicCount = db
    .prepare<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM topics WHERE project_id = ?`,
    )
    .get('garden')
  expect(topicCount?.n).toBe(1)
})

test('createProjectRow skips a soft-deleted id (never resurrects)', async () => {
  const db = makeDb()
  const deps = makeDeps(db)

  await createProjectRow(deps, { name: 'Old' })
  // Soft-delete it (the owner deleted the project).
  db.prepare<unknown, [string]>(
    `UPDATE projects SET deleted_at = '2024-01-01T00:00:00.000Z' WHERE id = ?`,
  ).run('old')

  const res = await createProjectRow(deps, { name: 'Old' })
  expect(res.outcome).toBe('skipped')
  // The rail stays empty — the deleted project was NOT brought back.
  expect(railRows(db)).toEqual([])
})

test('create_project tool validates name + delegates to the bound service', async () => {
  const calls: Array<{ name: string; project_slug: string; speaker_user_id: string | null }> = []
  const service: CreateProjectToolService = {
    create: async (input) => {
      calls.push(input)
      const outcome = /deleted/i.test(input.name) ? 'skipped' : 'created'
      return { project_id: 'taxes', name: input.name, outcome }
    },
  }
  const reg = new ToolRegistry()
  const names = registerCreateProjectToolSurface(reg, service)
  expect(names).toEqual([CREATE_PROJECT_TOOL])

  const tool = reg.get(CREATE_PROJECT_TOOL)
  expect(tool).not.toBeUndefined()
  expect(tool?.approval_policy).toBe('auto')
  expect(tool?.capability_required).toBe('write:project_data')
  expect(tool?.agent_hidden ?? false).toBe(false) // visible in the manifest

  const ctx = {
    project_slug: PROJECT_SLUG,
    project_id: null,
    topic_id: 'topic-1',
    call_id: 'call-1',
    speaker_user_id: 'sam',
  }

  // Empty name → clean error, no service call.
  const bad = (await tool!.handler({ name: '   ' }, ctx)) as { ok: boolean; error?: string }
  expect(bad.ok).toBe(false)
  expect(calls).toEqual([])

  // Valid name → trimmed, server-injected scope, ok result.
  const good = (await tool!.handler({ name: '  Taxes  ' }, ctx)) as {
    ok: boolean
    project_id?: string
  }
  expect(good.ok).toBe(true)
  expect(good.project_id).toBe('taxes')
  expect(calls).toEqual([
    { name: 'Taxes', project_slug: PROJECT_SLUG, speaker_user_id: 'sam' },
  ])

  // A 'skipped' outcome (soft-deleted-name collision) is NOT reported as success.
  const skipped = (await tool!.handler({ name: 'Deleted Project' }, ctx)) as {
    ok: boolean
    error?: string
  }
  expect(skipped.ok).toBe(false)
  expect(skipped.error).toBeDefined()
})
