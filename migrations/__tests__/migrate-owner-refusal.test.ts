import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

import { resolveOpenDbPath } from '../db-path.ts'
import {
  applyMigrations,
  canonicalOwnerPath,
  migrateOwnerMarkerPath,
} from '../runner.ts'

const MIGRATIONS_DIR = join(import.meta.dir, '..')
const COPIED = ['db-path.ts', 'provenance.ts', 'git-index.ts'] as const

function snapshot(dbPath: string): { ledger: string; schema: string } {
  const db = new Database(dbPath, { readonly: true })
  try {
    return {
      ledger: JSON.stringify(
        db
          .query(
            'SELECT version, name, applied_at, content_sha256 FROM _migrations ORDER BY version',
          )
          .all(),
      ),
      schema: JSON.stringify(
        db.query('SELECT type, name, sql FROM sqlite_master ORDER BY name').all(),
      ),
    }
  } finally {
    db.close()
  }
}

function messageOf(action: () => unknown): string {
  let thrown: unknown
  try {
    action()
  } catch (err) {
    thrown = err
  }
  if (thrown === undefined) throw new Error('expected migration ownership refusal')
  return thrown instanceof Error ? thrown.message : String(thrown)
}

test('a foreign runner inheriting NEUTRON_HOME is refused before any live migration write', async () => {
  const root = join(
    MIGRATIONS_DIR,
    `.mig-owner-refusal-${process.pid}-${Date.now()}`,
  )
  const liveHome = join(root, 'live-home')
  const fixtureEnv = { NEUTRON_HOME: liveHome }
  const dbPath = resolveOpenDbPath(fixtureEnv)
  const markerPath = migrateOwnerMarkerPath(dbPath)
  const chainA = join(root, 'chain-a')
  const worktree = join(root, 'worktree')
  const emptyDir = join(root, 'empty-cwd')

  expect(dbPath).toBe(join(liveHome, 'project.db'))

  try {
    mkdirSync(liveHome, { recursive: true })
    mkdirSync(chainA, { recursive: true })
    mkdirSync(worktree, { recursive: true })
    mkdirSync(emptyDir, { recursive: true })
    writeFileSync(join(chainA, '0001_base.sql'), 'CREATE TABLE base (id INTEGER);\n')

    const seed = new Database(dbPath, { create: true })
    try {
      expect(applyMigrations(seed, chainA)).toEqual({ applied: [1], skipped: [] })
    } finally {
      seed.close()
    }

    const recordedOwner = canonicalOwnerPath(MIGRATIONS_DIR)
    const worktreeOwner = canonicalOwnerPath(worktree)
    const claimedMarker = readFileSync(markerPath)
    expect(claimedMarker.toString('utf8').split(/\r?\n/, 1)[0]).toBe(recordedOwner)

    cpSync(join(MIGRATIONS_DIR, 'runner.ts'), join(worktree, 'runner.ts'))
    for (const file of COPIED) cpSync(join(MIGRATIONS_DIR, file), join(worktree, file))
    writeFileSync(join(worktree, '0001_base.sql'), 'CREATE TABLE base (id INTEGER);\n')
    writeFileSync(join(worktree, '0002_new.sql'), 'CREATE TABLE stolen (id INTEGER);\n')

    const foreign = await import(`${join(worktree, 'runner.ts')}?owner=${Date.now()}`)
    const before = snapshot(dbPath)

    const pendingDb = new Database(dbPath)
    let pendingMessage: string
    try {
      pendingMessage = messageOf(() => foreign.applyMigrations(pendingDb, worktree))
    } finally {
      pendingDb.close()
    }
    expect(pendingMessage).toContain(recordedOwner)
    expect(pendingMessage).toContain(worktreeOwner)
    expect(pendingMessage).toContain('.migrate-owner')
    expect(pendingMessage).toContain('NOTHING HAS BEEN APPLIED')

    // The gate is unconditional on pending state: the same foreign runner must
    // refuse even when the selected chain contains nothing new.
    const steadyDb = new Database(dbPath)
    try {
      expect(messageOf(() => foreign.applyMigrations(steadyDb, chainA))).toContain(
        'Migration ownership refusal',
      )
    } finally {
      steadyDb.close()
    }

    expect(snapshot(dbPath)).toEqual(before)
    expect(readFileSync(markerPath)).toEqual(claimedMarker)

    const verifyNoStolen = new Database(dbPath, { readonly: true })
    try {
      expect(
        verifyNoStolen
          .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'stolen'")
          .get(),
      ).toBeNull()
      expect(verifyNoStolen.query('SELECT version FROM _migrations WHERE version = 2').get()).toBeNull()
    } finally {
      verifyNoStolen.close()
    }

    // Binding reproduction: no argv database path. The copied CLI receives only
    // the inherited live NEUTRON_HOME and resolves project.db itself.
    const cli = Bun.spawn(['bun', 'run', join(worktree, 'runner.ts')], {
      cwd: emptyDir,
      env: { PATH: process.env['PATH'] ?? '', NEUTRON_HOME: liveHome },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      cli.exited,
      new Response(cli.stdout).text(),
      new Response(cli.stderr).text(),
    ])
    const cliOutput = `${stdout}\n${stderr}`
    expect(exitCode).not.toBe(0)
    expect(cliOutput).toContain('Migration ownership refusal')
    expect(cliOutput).toContain(recordedOwner)
    expect(cliOutput).toContain(worktreeOwner)
    expect(snapshot(dbPath)).toEqual(before)
    expect(readFileSync(markerPath)).toEqual(claimedMarker)

    // The owning checkout can keep using the home, and never repeats its claim.
    const ownerDb = new Database(dbPath)
    try {
      expect(applyMigrations(ownerDb, chainA)).toEqual({ applied: [], skipped: [1] })
    } finally {
      ownerDb.close()
    }
    expect(readFileSync(markerPath)).toEqual(claimedMarker)

    // Production's wrapped-database entry is the same guarded path.
    const productionDb = new Database(dbPath)
    try {
      expect(
        messageOf(() => foreign.applyMigrationsToProjectDb({ raw: () => productionDb })),
      ).toContain('Migration ownership refusal')
    } finally {
      productionDb.close()
    }
    expect(readFileSync(join(MIGRATIONS_DIR, '..', 'gateway', 'index.ts'), 'utf8')).toContain(
      'applyMigrationsToProjectDb(db)',
    )
    expect(snapshot(dbPath)).toEqual(before)
    expect(readFileSync(markerPath)).toEqual(claimedMarker)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 30_000)

test.skipIf(process.getuid?.() === 0)(
  'an unwritable database directory does not turn a tolerant first claim into a migration failure',
  () => {
    const root = join(MIGRATIONS_DIR, `.mig-owner-readonly-${process.pid}-${Date.now()}`)
    const home = join(root, 'home')
    const chain = join(root, 'chain')
    const dbPath = join(home, 'project.db')
    mkdirSync(home, { recursive: true })
    mkdirSync(chain, { recursive: true })
    writeFileSync(join(chain, '0001_base.sql'), 'CREATE TABLE base (id INTEGER);\n')
    const db = new Database(dbPath, { create: true })
    db.exec('PRAGMA journal_mode = MEMORY')
    chmodSync(home, 0o555)
    try {
      expect(applyMigrations(db, chain)).toEqual({ applied: [1], skipped: [] })
      expect(existsSync(migrateOwnerMarkerPath(dbPath))).toBe(false)
    } finally {
      chmodSync(home, 0o755)
      db.close()
      rmSync(root, { recursive: true, force: true })
    }
  },
)

test('in-memory databases never consult or write an ownership marker', () => {
  const root = join(MIGRATIONS_DIR, `.mig-owner-memory-${process.pid}-${Date.now()}`)
  const chain = join(root, 'chain')
  try {
    mkdirSync(chain, { recursive: true })
    writeFileSync(join(chain, '0001_base.sql'), 'CREATE TABLE base (id INTEGER);\n')
    const db = new Database(':memory:')
    try {
      expect(applyMigrations(db, chain)).toEqual({ applied: [1], skipped: [] })
    } finally {
      db.close()
    }
    expect(existsSync(join(root, '.migrate-owner'))).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
