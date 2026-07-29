/**
 * RC1 test fixture — hold the sidecar's SQLite WRITE lock from a real
 * separate process for a fixed window.
 *
 * Usage: bun run hold-write-lock.ts <db_path> <hold_ms>
 *
 * Opens the database, takes `BEGIN IMMEDIATE` (the write lock), prints
 * `HELD` (the parent synchronizes on this line, so any parent-side
 * write issued after it provably overlaps the held lock), sleeps
 * `hold_ms`, commits, prints `RELEASED`.
 */

import { Database } from 'bun:sqlite'

const [db_path, hold_ms_raw] = process.argv.slice(2)
const hold_ms = Number(hold_ms_raw)
if (db_path === undefined || !Number.isFinite(hold_ms)) {
  console.error('usage: hold-write-lock.ts <db_path> <hold_ms>')
  process.exit(2)
}

const db = new Database(db_path, { create: false, readwrite: true })
db.exec('PRAGMA busy_timeout = 5000')
db.exec('BEGIN IMMEDIATE')
// A write inside the txn so the lock is a real pending write, then the
// parent-visible marker.
db.run(
  `INSERT INTO agent_nexus_events (id, actor_kind, actor_id, kind, body, refs_json, created_at)
   VALUES (?, 'orchestrator', 'lock-holder', 'observation', 'held-lock marker', NULL, ?)`,
  [`0LOCKHOLDER${Date.now().toString(36).toUpperCase().padStart(15, '0')}`, Date.now()],
)
console.log('HELD')
await Bun.sleep(hold_ms)
db.exec('COMMIT')
console.log('RELEASED')
db.close()
process.exit(0)
