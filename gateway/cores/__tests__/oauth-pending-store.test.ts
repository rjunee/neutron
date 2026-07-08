import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import {
  CoresOAuthPendingStore,
  PENDING_TTL_MS,
} from '../oauth-pending-store.ts'

let workdir: string
let db: ProjectDb

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'neutron-cores-oauth-pending-'))
  const dbPath = join(workdir, 'owner.db')
  const raw = new Database(dbPath, { create: true })
  applyMigrations(raw)
  raw.close()
  db = ProjectDb.open(dbPath)
})

afterEach(() => {
  db.close()
  rmSync(workdir, { recursive: true, force: true })
})

test('put + consume round-trips state + delete-on-read', async () => {
  const store = new CoresOAuthPendingStore({ db, now: () => 1_700_000_000_000 })
  await store.put({
    state: 'state-1',
    project_slug: 'alice',
    code_verifier: 'verifier',
    labels: ['google_calendar', 'gmail_compose'],
    redirect_uri: 'https://auth.neutron.example/oauth/cores/google/callback',
  })
  const first = await store.consume('state-1')
  expect(first).not.toBeNull()
  expect(first?.project_slug).toBe('alice')
  expect(first?.labels).toEqual(['google_calendar', 'gmail_compose'])
  // Second consume returns null — delete-on-read.
  const second = await store.consume('state-1')
  expect(second).toBeNull()
})

test('expired rows are not returned by consume', async () => {
  let nowVal = 1_700_000_000_000
  const store = new CoresOAuthPendingStore({ db, now: () => nowVal })
  await store.put({
    state: 'state-2',
    project_slug: 'alice',
    code_verifier: 'v',
    labels: ['google_calendar'],
    redirect_uri: 'https://x',
  })
  nowVal += PENDING_TTL_MS + 1
  const result = await store.consume('state-2')
  expect(result).toBeNull()
})

test('sweepExpired removes expired-and-not-consumed rows', async () => {
  let nowVal = 1_700_000_000_000
  const store = new CoresOAuthPendingStore({ db, now: () => nowVal })
  await store.put({
    state: 'state-3',
    project_slug: 'alice',
    code_verifier: 'v',
    labels: ['google_calendar'],
    redirect_uri: 'https://x',
  })
  // Fresh row — sweep should leave it alone.
  let deleted = await store.sweepExpired()
  expect(deleted).toBe(0)
  nowVal += PENDING_TTL_MS + 1
  deleted = await store.sweepExpired()
  expect(deleted).toBe(1)
})
