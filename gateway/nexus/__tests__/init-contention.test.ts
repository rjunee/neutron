import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { readFileSync } from 'node:fs'
import { migrationContentHash } from '@neutronai/migrations/provenance.ts'
import { DEFAULT_NEXUS_MIGRATIONS_DIR } from '../nexus-store.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function probe(mode: string) {
  const root = mkdtempSync(join(tmpdir(), 'nexus-init-contention-'))
  roots.push(root)
  const child = Bun.spawn([process.execPath, join(import.meta.dir, 'fixtures/init-contention.ts'), mode, root], {
    stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, NEUTRON_COMMIT_SHA: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
  })
  // A broken retry ceiling must fail this test instead of leaking a child.
  const deadline = setTimeout(() => child.kill(), 30_000)
  try {
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ])
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: '' })
    return JSON.parse(stdout)
  } finally {
    clearTimeout(deadline)
    child.kill()
    await child.exited
  }
}

test('final startup retry leaves a migration retry for a real competing ledger commit', async () => {
  const result = await probe('late-ledger-race')
  expect(result.error).toBeNull()
  expect(result.injectedStartupFailures).toBe(10)
  expect(result.startupCalls).toBe(12)
  expect(result.migrationCalls).toBe(1) // stale runner; retry reads competitor's committed ledger
  expect(result.ledgerErrors).toHaveLength(1)
  expect(result.ledgerErrors[0]).toContain('UNIQUE constraint failed: _migrations.name')
  expect(result.events).toEqual([{ body: 'contender' }, { body: 'survived contention' }])
  expect(result.ledger).toEqual(result.contenderLedger)
  expect(result.ledger).toEqual([{
    version: 1, name: 'rc1_initial_schema', applied_at: expect.any(Number),
    content_sha256: migrationContentHash(readFileSync(join(DEFAULT_NEXUS_MIGRATIONS_DIR, '0001_rc1_initial_schema.sql'), 'utf8')),
    applied_by_commit: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    tree_provenance: 'tracked-in-index',
  }])
}, 35_000)

test('persistent startup contention stops without running migrations', async () => {
  const result = await probe('startup-exhausted')
  expect(result.error).toContain('failed to open')
  expect(result.startupCalls).toBe(11)
  expect(result.migrationCalls).toBe(0)
  expect(result.events).toEqual([])
  expect(result.ledger).toEqual([])
  expect(result.partialBody).toEqual([])
}, 35_000)

test('a UNIQUE inside the migration body rolls back and fails without retry', async () => {
  const result = await probe('body-unique')
  expect(result.error).toContain('UNIQUE constraint failed: body_unique.id')
  expect(result.migrationCalls).toBe(1)
  expect(result.ledgerErrors).toEqual([])
  expect(result.ledger).toEqual([])
  expect(result.partialBody).toEqual([])
}, 35_000)

test('a persistent ledger UNIQUE cannot be mistaken for successful initialization', async () => {
  const result = await probe('ledger-unique')
  expect(result.error).toContain('UNIQUE constraint failed: _migrations.name')
  expect(result.migrationCalls).toBe(11)
  expect(result.ledgerErrors).toHaveLength(11)
  expect(result.ledger).toEqual([])
  expect(result.partialBody).toEqual([])
  expect(result.events).toEqual([])
}, 35_000)

test('three separate first writers preserve every append and one ledger witness', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nexus-first-writers-'))
  roots.push(root)
  const children = ['alpha', 'beta', 'gamma'].map((actor) => Bun.spawn([
    process.execPath, join(import.meta.dir, 'fixtures/init-writer.ts'), root, actor,
  ], { stdout: 'pipe', stderr: 'pipe' }))
  const deadline = setTimeout(() => children.forEach((child) => child.kill()), 30_000)
  try {
    const results = await Promise.all(children.map(async (child) => {
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ])
      expect({ stderr, exit }).toEqual({ stderr: '', exit: 0 })
      return JSON.parse(stdout)
    }))
    const db = new Database(join(root, 'Projects/race-project/.nexus/nexus.db'))
    try {
      const events = db.query('SELECT * FROM agent_nexus_events ORDER BY actor_id').all()
      expect(events).toEqual(results.map((result) => result.event).sort((a, b) => a.actor_id.localeCompare(b.actor_id)))
      expect(new Set(results.map((result) => result.event.id)).size).toBe(3)
      const ledger = db.query('SELECT * FROM _migrations').all()
      expect(ledger).toHaveLength(1)
      for (const result of results) expect(result.ledger).toEqual(ledger)
    } finally {
      db.close()
    }
  } finally {
    clearTimeout(deadline)
    children.forEach((child) => child.kill())
    await Promise.all(children.map((child) => child.exited))
  }
}, 35_000)

test('persistent migration contention stops after its bounded budget', async () => {
  const result = await probe('migration-exhausted')
  expect(result.error).toContain('failed to apply nexus migrations')
  expect(result.startupCalls).toBe(11)
  expect(result.migrationCalls).toBe(11)
  expect(result.events).toEqual([])
  expect(result.ledger).toEqual([])
}, 35_000)

test('alternating startup and migration contention cannot reset either budget', async () => {
  const result = await probe('alternating-exhausted')
  expect(result.error).toContain('failed to open')
  expect(result.startupCalls).toBe(21)
  expect(result.migrationCalls).toBe(10)
  expect(result.events).toEqual([])
  expect(result.ledger).toEqual([])
}, 35_000)

test('a non-contention SQL failure is refused immediately without a ledger row', async () => {
  const result = await probe('corrupt-sql')
  expect(result.error).toContain('no such table: missing_nexus_table')
  expect(result.startupCalls).toBe(1)
  expect(result.migrationCalls).toBe(1)
  expect(result.events).toEqual([])
  expect(result.ledger).toEqual([])
  expect(result.partialBody).toEqual([])
}, 35_000)

test('closing during an init retry rejects the old operation and permits a fresh generation', async () => {
  const result = await probe('close-during-retry')
  expect(result.error).toContain('store was closed during initialization')
  expect(result.replacementError).toBeNull()
  expect(result.injectedStartupFailures).toBe(1)
  expect(result.events).toEqual([{ body: 'replacement generation' }])
  expect(result.ledger).toHaveLength(1)
}, 35_000)

test('a retry without closeAll preserves the original operation', async () => {
  const result = await probe('single-startup-busy')
  expect(result.error).toBeNull()
  expect(result.injectedStartupFailures).toBe(1)
  expect(result.events).toEqual([{ body: 'survived contention' }])
  expect(result.ledger).toHaveLength(1)
}, 35_000)
