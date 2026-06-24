import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'

import { applyMigrations } from '../../migrations/runner.ts'
import { ProjectDb } from '../../persistence/index.ts'
import { SkillForgeProposalsStore, type CreateProposalInput } from '../proposals-store.ts'
import type { CompletedWorkflow } from '../types.ts'

let tmp: string
let dbPath: string
let db: ProjectDb
let store: SkillForgeProposalsStore
let now = 1_000_000

const workflow: CompletedWorkflow = {
  project_slug: 'p',
  topic_id: 't',
  intent: 'do the thing',
  steps: [{ action: 'a' }, { action: 'b' }],
  artifacts: ['x.md'],
  succeeded: true,
}

function input(over: Partial<CreateProposalInput> = {}): CreateProposalInput {
  return {
    workflow_signature: 'sig-1',
    project_slug: 'p',
    topic_id: 't',
    proposed_name: 'do-the-thing',
    triggers: ['do the thing'],
    what_it_does: 'Does the thing.',
    artifacts: ['x.md'],
    workflow,
    ...over,
  }
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'skill-forge-store-'))
  dbPath = join(tmp, 'project.db')
  const raw = new Database(dbPath, { create: true })
  applyMigrations(raw)
  raw.close()
  db = ProjectDb.open(dbPath)
  now = 1_000_000
  store = new SkillForgeProposalsStore({ db, now: () => now })
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

test('create + get round-trips all fields and decodes JSON', async () => {
  const rec = await store.create(input())
  expect(rec.status).toBe('pending')
  expect(rec.skill_path).toBeNull()
  expect(rec.created_at).toBe(1_000_000)
  expect(rec.triggers).toEqual(['do the thing'])
  expect(rec.artifacts).toEqual(['x.md'])
  expect(rec.workflow.steps.map((s) => s.action)).toEqual(['a', 'b'])

  const got = await store.get(rec.id)
  expect(got?.proposed_name).toBe('do-the-thing')
})

test('getActiveBySignature dedupes pending/approved but not declined', async () => {
  const rec = await store.create(input({ workflow_signature: 'sig-X' }))
  expect((await store.getActiveBySignature('sig-X'))?.id).toBe(rec.id)

  await store.markDeclined(rec.id)
  expect(await store.getActiveBySignature('sig-X')).toBeNull()
})

test('markApproved records the skill path; only pending rows can be decided', async () => {
  const rec = await store.create(input())
  now = 2_000_000
  const approved = await store.markApproved(rec.id, '/skills/conventions/do-the-thing.md')
  expect(approved.status).toBe('approved')
  expect(approved.skill_path).toBe('/skills/conventions/do-the-thing.md')
  expect(approved.decided_at).toBe(2_000_000)

  // Re-deciding an already-approved row throws (the UPDATE matches no pending row).
  await expect(store.markDeclined(rec.id)).rejects.toThrow()
})

test('proposals persist across a fresh session (DB reopen)', async () => {
  const rec = await store.create(input())
  await store.markApproved(rec.id, '/skills/conventions/do-the-thing.md')
  db.close()

  // Simulate a brand-new process / session: reopen the same file.
  const db2 = ProjectDb.open(dbPath)
  const store2 = new SkillForgeProposalsStore({ db: db2, now: () => now })
  const reread = await store2.get(rec.id)
  expect(reread?.status).toBe('approved')
  expect(reread?.skill_path).toBe('/skills/conventions/do-the-thing.md')
  db2.close()
  // Reopen once more so afterEach's db.close() has a live handle.
  db = ProjectDb.open(dbPath)
})
