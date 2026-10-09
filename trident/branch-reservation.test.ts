import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { seedMigratedDb } from '../tests/support/migrated-db.ts'
import { TridentRunStore } from './store.ts'

let root: string
let db: ProjectDb
let otherDb: ProjectDb
let store: TridentRunStore
let other: TridentRunStore
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'branch-reservation-'))
  const path = join(root, 'project.db')
  seedMigratedDb(path)
  db = ProjectDb.open(path)
  otherDb = ProjectDb.open(path)
  store = new TridentRunStore(db)
  other = new TridentRunStore(otherDb)
})
afterEach(() => { db.close(); otherDb.close(); rmSync(root, { recursive: true, force: true }) })

const input = () => ({ slug: 'card', project_slug: 'project', repo_path: root,
  branch: 'trident/card', task: 'preserve the candidate', merge_mode: 'pr' as const })
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

test('salvage excludes admission across connections without blocking unrelated database writes', async () => {
  const failed = await store.create({ ...input(), phase: 'failed' })
  const entered = deferred(); const finish = deferred()
  const salvage = store.withSalvageReservation(failed, async () => {
    entered.resolve(); await finish.promise
    return { ...failed, pr: 17, published_pr: 17 }
  })
  try {
    await entered.promise
    expect(await other.createIfClaimsAvailable(input())).toEqual({ ok: false, conflict: 'reservation' })
    expect((await other.createIfClaimsAvailable({ ...input(), slug: 'other', branch: 'trident/other' })).ok).toBe(true)
    expect(other.get(failed.id)?.pr).toBeNull()
  } finally { finish.resolve(); await salvage }
  expect(other.get(failed.id)?.published_pr).toBe(17)
  expect((await other.createIfClaimsAvailable(input())).ok).toBe(true)
})

test('admission owns branch-dependent preparation; its committed run then excludes salvage', async () => {
  const failed = await store.create({ ...input(), phase: 'failed' })
  const reservation = await other.reserveBranch({ repo_path: root, branch: input().branch,
    run_id: 'new-run', purpose: 'admission' })
  expect(reservation).not.toBeNull()
  let calls = 0
  const salvage = () => store.withSalvageReservation(failed, async () => { calls++; return failed })
  expect(await salvage()).toBeNull()
  try {
    expect((await other.createIfClaimsAvailable({ ...input(), id: 'new-run' }, undefined, undefined, reservation!)).ok).toBe(true)
  } finally { await other.releaseBranch(reservation!) }
  expect(await salvage()).toBeNull()
  expect(calls).toBe(0)
  await other.update('new-run', { phase: 'failed' })
  expect(await salvage()).not.toBeNull()
  expect(calls).toBe(1)
})

test('a retained reservation survives reopening; time and a different token cannot release it', async () => {
  const reservation = await store.reserveBranch({ repo_path: root, branch: input().branch,
    run_id: 'interrupted-salvage', purpose: 'salvage' })
  expect(reservation).not.toBeNull()
  db.close(); db = ProjectDb.open(join(root, 'project.db')); store = new TridentRunStore(db)
  await store.releaseBranch({ ...reservation!, token: 'wrong-token' })
  expect(await store.createIfClaimsAvailable(input())).toEqual({ ok: false, conflict: 'reservation' })
  expect((await store.createIfClaimsAvailable({ ...input(), slug: 'other', branch: 'trident/other' })).ok).toBe(true)
  await other.releaseBranch(reservation!)
  expect((await store.createIfClaimsAvailable(input())).ok).toBe(true)
})

test('a live owner in another project or through a repository alias refuses direct salvage', async () => {
  const failed = await store.create({ ...input(), phase: 'failed' })
  const alias = join(root, 'alias'); symlinkSync(root, alias)
  await other.create({ ...input(), slug: 'other-card', project_slug: 'other', repo_path: alias })
  let calls = 0
  expect(await store.withSalvageReservation(failed, async () => { calls++; return failed })).toBeNull()
  expect(calls).toBe(0)
})

test('unknown ownership cannot enter salvage and a throwing operation releases only its own reservation', async () => {
  const failed = await store.create({ ...input(), phase: 'failed' })
  db.close(); db = ProjectDb.open(join(root, 'project.db'))
  let calls = 0
  await expect(store.withSalvageReservation(failed, async () => { calls++; return failed })).rejects.toThrow()
  expect(calls).toBe(0)
  store = new TridentRunStore(db)
  await expect(store.withSalvageReservation(failed, async () => { throw new Error('publish failed') })).rejects.toThrow('publish failed')
  expect((await other.createIfClaimsAvailable(input())).ok).toBe(true)
})

test('the live-owner guard is not limited by the startup census page', async () => {
  const failed = await store.create({ ...input(), phase: 'failed' })
  await db.run(`WITH RECURSIVE ids(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM ids WHERE n < 10001)
    INSERT INTO code_trident_runs (id, slug, project_slug, repo_path, task, started_at, last_advanced_at)
    SELECT 'distractor-' || n, 'distractor-' || n, 'project', ?, 'unrelated', '2000-01-01', '2000-01-01' FROM ids`, [root])
  await other.create({ ...input(), slug: 'owner-outside-page' })
  expect(store.listNonTerminal(10_000).some(run => run.branch === input().branch)).toBe(false)
  let calls = 0
  expect(await store.withSalvageReservation(failed, async () => { calls++; return failed })).toBeNull()
  expect(calls).toBe(0)
})
