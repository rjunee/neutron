/** Isolated fault scheduling around the real sidecar and migration runner. */
import { Database } from 'bun:sqlite'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_NEXUS_MIGRATIONS_DIR, NexusStore } from '../../nexus-store.ts'

const [mode, ownerHome] = process.argv.slice(2)
if (!mode || !ownerHome) throw new Error('mode and owner home required')
const modes = new Set(['late-ledger-race', 'startup-exhausted', 'migration-exhausted', 'corrupt-sql', 'body-unique', 'ledger-unique', 'alternating-exhausted', 'single-startup-busy', 'close-during-retry'])
if (!modes.has(mode)) throw new Error('unknown fixture mode')

let startupCalls = 0
let migrationCalls = 0
let injectedStartupFailures = 0
let raceInjected = false
let contenderLedger: unknown = null
const ledgerErrors: string[] = []
const originalRun = Database.prototype.run
Database.prototype.run = function (...args: Parameters<Database['run']>) {
  try {
    return originalRun.apply(this, args)
  } catch (error) {
    if (String(args[0]).includes('INSERT INTO _migrations')) ledgerErrors.push(String(error))
    throw error
  }
}
const originalExec = Database.prototype.exec
Database.prototype.exec = function (sql: string) {
  if (sql === 'PRAGMA journal_mode = WAL') {
    startupCalls++
    const failStartup = mode === 'startup-exhausted' ||
      (mode === 'late-ledger-race' && injectedStartupFailures < 10) ||
      ((mode === 'single-startup-busy' || mode === 'close-during-retry') && injectedStartupFailures === 0) ||
      (mode === 'alternating-exhausted' && startupCalls % 2 === 1)
    if (failStartup) {
      injectedStartupFailures++
      if (mode === 'close-during-retry') queueMicrotask(() => store.closeAll())
      // Once WAL is already active its no-op pragma need not acquire this
      // lock. The alternating ceiling control deliberately injects BUSY.
      if (mode === 'alternating-exhausted') throw new Error('SQLITE_BUSY: scheduled startup contention')
      // A second SQLite connection owns the exclusive lock; exercise the
      // driver's real startup BUSY and openSidecar's wrapped cause chain.
      const blocker = new Database(this.filename)
      try {
        originalExec.call(blocker, 'BEGIN EXCLUSIVE')
        return originalExec.call(this, sql)
      } finally {
        blocker.close()
      }
    }
  }
  if (sql === 'BEGIN') {
    migrationCalls++
    if (mode === 'migration-exhausted' || mode === 'alternating-exhausted') {
      throw new Error('SQLITE_BUSY: scheduled migration contention')
    }
    if (mode === 'late-ledger-race' && !raceInjected) {
      // This runner has already read an empty ledger. Commit the competing
      // migration in a separate process before its stale INSERT. No driver
      // error is forged here: the losing ledger INSERT must really fail.
      raceInjected = true
      const contender = Bun.spawnSync([process.execPath, join(import.meta.dir, 'init-writer.ts'), ownerHome, 'contender'], {
        env: { ...process.env, NEUTRON_COMMIT_SHA: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
        timeout: 10_000,
      })
      if (contender.exitCode !== 0) throw new Error(contender.stderr.toString())
      contenderLedger = JSON.parse(contender.stdout.toString()).ledger
    }
  }
  return originalExec.call(this, sql)
}

let migrationsDir = DEFAULT_NEXUS_MIGRATIONS_DIR
if (['corrupt-sql', 'body-unique', 'ledger-unique'].includes(mode)) {
  migrationsDir = join(ownerHome, 'fixture-migrations')
  mkdirSync(migrationsDir)
  const suffix = mode === 'corrupt-sql'
    ? 'SELECT * FROM missing_nexus_table;'
    : mode === 'body-unique'
      ? 'CREATE TABLE body_unique (id INTEGER PRIMARY KEY); INSERT INTO body_unique VALUES (1), (1);'
      : "INSERT INTO _migrations (version, name, applied_at) VALUES (1, 'rc1_initial_schema', 0);"
  writeFileSync(join(migrationsDir, '0001_rc1_initial_schema.sql'),
    readFileSync(join(DEFAULT_NEXUS_MIGRATIONS_DIR, '0001_rc1_initial_schema.sql'), 'utf8') + '\n' + suffix)
}
const store = new NexusStore({ owner_home: ownerHome, migrations_dir: migrationsDir })
let error: string | null = null
let replacementError: string | null = null
try {
  await store.appendEvent('race-project', {
    actor_kind: 'forge', actor_id: 'fixture', kind: 'observation', body: 'survived contention', refs: null,
  })
} catch (caught) {
  error = caught instanceof Error ? caught.message : String(caught)
  if (mode === 'close-during-retry') {
    try {
      await store.appendEvent('race-project', {
        actor_kind: 'forge', actor_id: 'replacement', kind: 'observation', body: 'replacement generation', refs: null,
      })
    } catch (replacement) {
      replacementError = replacement instanceof Error ? replacement.message : String(replacement)
    }
  }
} finally {
  store.closeAll()
  Database.prototype.exec = originalExec
  Database.prototype.run = originalRun
}
const db = new Database(join(ownerHome, 'Projects/race-project/.nexus/nexus.db'))
const hasEvents = db.query("SELECT 1 FROM sqlite_master WHERE name = 'agent_nexus_events'").get() !== null
const events = hasEvents ? db.query('SELECT body FROM agent_nexus_events').all() : []
const hasLedger = db.query("SELECT 1 FROM sqlite_master WHERE name = '_migrations'").get() !== null
const ledger = hasLedger ? db.query('SELECT * FROM _migrations').all() : []
const partialBody = db.query("SELECT name FROM sqlite_master WHERE name IN ('body_unique', 'agent_nexus_events')").all()
db.close()
console.log(JSON.stringify({ error, replacementError, startupCalls, migrationCalls, injectedStartupFailures, contenderLedger, ledgerErrors, events, ledger, partialBody }))
