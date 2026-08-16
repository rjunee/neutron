/**
 * THE REFUSAL WARNING MUST REACH THE INSTANCE IT PROTECTS — at the composition
 * root, on the database shape that broke it (INVARIANTS #116(b); Argus r1
 * blocker, 2026-08-16).
 *
 * `open/__tests__/open-scope-rekey-direction-boot.test.ts` drives the same
 * decision through the full Open composer on the SIMPLE shape, where the frozen
 * credential handle and the live handle are the same string. That shape hides
 * the defect: a journal row keyed to the stale credential handle is readable
 * there by coincidence.
 *
 * This file uses the shape where they DIVERGE — the rename. The owner reads
 * under `alpha`; his credentials are frozen under `beta` (frozen at write time
 * by `auth/secrets-store.ts`, which is the entire condition
 * `credential_scope_orphaned` exists to report). An anonymous process then boots
 * against the same home. Keyed to `beta`, the warning is exactly as invisible as
 * it was when it was keyed to `dev` — the reader is strictly
 * `WHERE project_slug = ?` and `alpha` is the only string the owner ever passes
 * it.
 *
 * The second boot is the STARVATION half: identical state, no second row. The
 * owner's window is the newest 50 events and `system_events` has no retention
 * sweep, so an unconditional two-rows-per-boot is a way for this warning to
 * evict every other degrade event out of the report it is trying to appear in.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { ProjectDb, asOwnerHandle } from '@neutronai/persistence/index.ts'
import { SystemEventsStore } from '@neutronai/persistence/system-events.ts'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { SecretsStore } from '@neutronai/auth/secrets-store.ts'
import { boot } from '../index.ts'
import { DEFAULT_MAX_RECENT_EVENTS } from '../diagnostics/instance-sources.ts'

/** The handle the owner's own gateway boots as — the only scope he ever reads. */
const LIVE = 'alpha'
/** The handle his credentials were frozen under, before the rename. */
const FROZEN = 'beta'
/** What an unconfigured process resolves to. */
const FALLBACK = 'dev'

let home: string
let dbPath: string
const savedEnv: Record<string, string | undefined> = {}

const ENV_KEYS = [
  'NEUTRON_HOME',
  'NEUTRON_DB_PATH',
  'OWNER_HOME',
  'NEUTRON_INSTANCE_SLUG',
  'NOTIFY_SOCKET',
] as const

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  home = mkdtempSync(join(tmpdir(), 'neutron-boot-refusal-scope-'))
  dbPath = join(home, 'project.db')
  process.env['NEUTRON_HOME'] = home
  // NO `.url_slug` and NO `NEUTRON_INSTANCE_SLUG`: the fallback is reached by
  // ABSENCE, which is what makes this boot anonymous.
  const raw = new Database(dbPath, { create: true })
  applyMigrations(raw)
  raw.close()
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  for (const key of ENV_KEYS) {
    const value = savedEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

function openDb(): ProjectDb {
  return ProjectDb.open(dbPath)
}

function withDb<T>(fn: (db: ProjectDb) => T): T {
  const db = openDb()
  try {
    return fn(db)
  } finally {
    db.close()
  }
}

/** Read back through the PRODUCTION reader, not a laxer hand-written query. */
function feed(scope: string, event: string): Record<string, unknown>[] {
  return withDb((db) =>
    new SystemEventsStore({ db })
      .listRecentForScope(scope, 100)
      .filter((e) => e.event === event)
      .map((e) => e.payload),
  )
}

function slugsIn(table: string, column = 'project_slug'): string[] {
  return withDb((db) =>
    db
      .all<{ s: string }, []>(
        `SELECT DISTINCT ${column} AS s FROM ${table} ORDER BY ${column}`,
        [],
      )
      .map((r) => r.s),
  )
}

async function seedRenamedInstance(): Promise<void> {
  const db = openDb()
  try {
    // The live identity: onboarding finished under `alpha`, and the ledger — the
    // authoritative record of who this database belongs to, written only by an
    // EXPLICIT boot — says `alpha`.
    await db.run(
      `INSERT INTO onboarding_state (project_slug, user_id, phase, started_at, last_advanced_at)
       VALUES (?, 'owner', 'completed', 1, 1)`,
      [LIVE],
    )
    await db.run(
      `INSERT INTO instance_scope_ledger (id, project_slug, updated_at) VALUES (1, ?, 1)`,
      [LIVE],
    )
    // The credentials, frozen under the PRE-rename handle.
    const store = new SecretsStore({ data_dir: home, db })
    await store.put({
      owner_handle: asOwnerHandle(FROZEN),
      kind: 'byo_api_key',
      label: 'anthropic:prod',
      plaintext: 'a-frozen-handle-secret',
    })
  } finally {
    db.close()
  }
}

/** One anonymous boot, then a clean shutdown (which drains the journal sink). */
async function anonymousBoot(): Promise<void> {
  const handle = await boot({ port: 0 })
  await handle.shutdown({ force: true })
}

test('the refusal reaches the LIVE handle when the frozen credential handle diverges', async () => {
  await seedRenamedInstance()
  await anonymousBoot()

  // Nothing moved — the guard did its job on both table sets.
  expect(slugsIn('secrets')).toEqual([FROZEN])
  expect(slugsIn('onboarding_state')).toEqual([LIVE])
  expect(slugsIn('instance_scope_ledger')).toEqual([LIVE])

  // ── THE RE-KEY REFUSAL ──────────────────────────────────────────────────
  const rekeyRefusal = feed(LIVE, 'instance_scope_rekey_refused')
  expect(rekeyRefusal).toHaveLength(1)
  expect(rekeyRefusal[0]!['stranded_slug']).toBe(LIVE)
  expect(rekeyRefusal[0]!['attempted_by_slug']).toBe(FALLBACK)
  // No other handle was stranded, so the row says so with a count.
  expect(rekeyRefusal[0]!['other_stranded_handles']).toBe(0)

  // ── THE CREDENTIAL REFUSAL — the blocker this file exists for ───────────
  const credRefusal = feed(LIVE, 'credential_scope_orphaned')
  expect(credRefusal).toHaveLength(1)
  expect(credRefusal[0]!['refused_direction']).toBe(true)
  expect(credRefusal[0]!['attempted_by_slug']).toBe(FALLBACK)
  expect(credRefusal[0]!['orphaned_rows']).toBe(1)
  expect(credRefusal[0]!['orphaned_tables']).toEqual(['secrets'])
  // The frozen handle is NOT named in the reader's feed — it is not his key.
  expect(JSON.stringify(credRefusal[0]!)).not.toContain(FROZEN)

  // ── THE CONTROLS ────────────────────────────────────────────────────────
  // Both scopes that CANNOT be read are empty. Without these, "it landed under
  // alpha" is satisfied by a row written to every scope at once.
  expect(feed(FROZEN, 'credential_scope_orphaned')).toEqual([])
  expect(feed(FROZEN, 'instance_scope_rekey_refused')).toEqual([])
  expect(feed(FALLBACK, 'credential_scope_orphaned')).toEqual([])
  expect(feed(FALLBACK, 'instance_scope_rekey_refused')).toEqual([])
}, 60_000)

test('an unchanged repeat writes nothing — the warning cannot starve its own report', async () => {
  await seedRenamedInstance()
  await anonymousBoot()
  await anonymousBoot()
  await anonymousBoot()

  // Three anonymous boots, one row each. The state never changed, so there was
  // never any new information to record.
  expect(feed(LIVE, 'instance_scope_rekey_refused')).toHaveLength(1)
  expect(feed(LIVE, 'credential_scope_orphaned')).toHaveLength(1)
}, 90_000)

test('an instance whose own handle IS "dev" still gets its refusal (Argus r2 blocker)', async () => {
  // The owner configured `NEUTRON_INSTANCE_SLUG=dev` — his instance really is
  // called `dev`, so his ledger says `dev` and `dev` is the only string he ever
  // passes to `listRecentForScope`. A later anonymous process resolves to the
  // SAME string by absence, and the credential guard arms on the SOURCE being
  // the fallback, not on the string — so this is reachable in production.
  // Excluding the attempting handle by string equality sent the row to the
  // frozen handle instead: unreadable, i.e. worse than what shipped.
  const db = openDb()
  try {
    await db.run(
      `INSERT INTO onboarding_state (project_slug, user_id, phase, started_at, last_advanced_at)
       VALUES (?, 'owner', 'completed', 1, 1)`,
      [FALLBACK],
    )
    await db.run(
      `INSERT INTO instance_scope_ledger (id, project_slug, updated_at) VALUES (1, ?, 1)`,
      [FALLBACK],
    )
    const store = new SecretsStore({ data_dir: home, db })
    await store.put({
      owner_handle: asOwnerHandle(FROZEN),
      kind: 'byo_api_key',
      label: 'anthropic:prod',
      plaintext: 'a-frozen-handle-secret',
    })
  } finally {
    db.close()
  }

  await anonymousBoot()

  // Nothing moved: the frozen credential stays frozen.
  expect(slugsIn('secrets')).toEqual([FROZEN])
  // And the warning is where the owner reads — under his own handle, which
  // happens to be the same string the anonymous process booted as.
  const credRefusal = feed(FALLBACK, 'credential_scope_orphaned')
  expect(credRefusal).toHaveLength(1)
  expect(credRefusal[0]!['refused_direction']).toBe(true)
  expect(credRefusal[0]!['orphaned_rows']).toBe(1)
  // CONTROL — the unreadable scope stays empty, so "it landed" is not satisfied
  // by a row written to every scope at once.
  expect(feed(FROZEN, 'credential_scope_orphaned')).toEqual([])
}, 60_000)

test('a refusal that ROTATED OUT of the 50-row window is written again (Argus r2 blocker)', async () => {
  await seedRenamedInstance()
  await anonymousBoot()
  expect(feed(LIVE, 'credential_scope_orphaned')).toHaveLength(1)

  // Age the first boot's rows, then fill the owner's window with unrelated
  // in-scope events. The refusal row still EXISTS — `system_events` has no
  // retention sweep — but he can no longer see it, and a dedup measured against
  // unbounded history would suppress the warning from here on, permanently and
  // silently. Timestamps are pinned rather than derived from the wall clock so
  // the ordering is the test's, not the machine's.
  withDb((db) => {
    db.runSync(`UPDATE system_events SET ts = 1000 WHERE project_slug = ?`, [LIVE])
    for (let i = 0; i < 60; i++) {
      db.runSync(
        `INSERT INTO system_events (id, ts, level, module, event_name, payload_json, project_slug, duration_ms)
         VALUES (?, ?, 'warn', 'gateway', 'cron_job_error', '{}', ?, NULL)`,
        [`filler-${i}`, 2000 + i, LIVE],
      )
    }
  })
  const visible = withDb((db) =>
    new SystemEventsStore({ db }).listRecentForScope(LIVE, DEFAULT_MAX_RECENT_EVENTS),
  )
  expect(visible.some((e) => e.event === 'credential_scope_orphaned')).toBe(false)
  expect(visible.some((e) => e.event === 'instance_scope_rekey_refused')).toBe(false)

  await anonymousBoot()

  // Two rows now, and the newest is inside the window the owner actually reads.
  expect(feed(LIVE, 'credential_scope_orphaned')).toHaveLength(2)
  expect(feed(LIVE, 'instance_scope_rekey_refused')).toHaveLength(2)
  const afterVisible = withDb((db) =>
    new SystemEventsStore({ db }).listRecentForScope(LIVE, DEFAULT_MAX_RECENT_EVENTS),
  )
  expect(afterVisible.some((e) => e.event === 'credential_scope_orphaned')).toBe(true)
  expect(afterVisible.some((e) => e.event === 'instance_scope_rekey_refused')).toBe(true)
}, 90_000)

test('the ORDINARY ambiguous orphan is edge-triggered too (Argus r2)', async () => {
  // Not a refusal: an EXPLICIT boot as `alpha`, with credentials under both
  // `alpha` and the pre-rename `beta` — ambiguous, so the reconciler touches
  // nothing and journals the counts under the boot handle. That row lands under
  // the SAME (scope, event_name) key the refused branch dedups on, so an
  // unconditional write here writes a row every boot AND makes the newest row
  // alternate between two payloads — which defeats the edge trigger for the
  // refusal as well. Both branches trigger, or neither does.
  process.env['NEUTRON_INSTANCE_SLUG'] = LIVE
  const db = openDb()
  try {
    await db.run(
      `INSERT INTO onboarding_state (project_slug, user_id, phase, started_at, last_advanced_at)
       VALUES (?, 'owner', 'completed', 1, 1)`,
      [LIVE],
    )
    const store = new SecretsStore({ data_dir: home, db })
    await store.put({
      owner_handle: asOwnerHandle(FROZEN),
      kind: 'byo_api_key',
      label: 'anthropic:old',
      plaintext: 'a-frozen-handle-secret',
    })
    await store.put({
      owner_handle: asOwnerHandle(LIVE),
      kind: 'byo_api_key',
      label: 'anthropic:new',
      plaintext: 'a-live-handle-secret',
    })
  } finally {
    db.close()
  }

  const first = await boot({ port: 0 })
  await first.shutdown({ force: true })
  const second = await boot({ port: 0 })
  await second.shutdown({ force: true })

  // Ambiguous, so nothing moved — and exactly ONE journal row for two boots.
  expect(slugsIn('secrets')).toEqual([LIVE, FROZEN].sort())
  expect(feed(LIVE, 'credential_scope_orphaned')).toHaveLength(1)
}, 90_000)

test('one CORRUPT historical row cannot abort the boot (Argus r2)', async () => {
  await seedRenamedInstance()
  // A row the reader cannot deserialise, under the exact `(scope, event)` pair
  // the edge trigger reads. `rowToPersisted` parses with `onCorrupt: 'throw'`
  // and this read happens synchronously on the boot path, before the boot's own
  // failure cleanup exists — so unguarded, one bad row turns a best-effort
  // dedup into a dead instance.
  withDb((db) => {
    db.runSync(
      `INSERT INTO system_events (id, ts, level, module, event_name, payload_json, project_slug, duration_ms)
       VALUES ('corrupt-1', ?, 'warn', 'gateway', 'credential_scope_orphaned', 'not json', ?, NULL)`,
      [Date.now(), LIVE],
    )
  })

  await anonymousBoot() // the assertion IS that this resolves

  // And the refusal was still journalled: a failed read means "assume the owner
  // cannot see it" — write. (The corrupt row is dropped first because the
  // production reader deserialises every row it returns and would throw on it —
  // which is precisely the throw the boot path now survives.)
  withDb((db) => db.runSync(`DELETE FROM system_events WHERE id = 'corrupt-1'`, []))
  expect(feed(LIVE, 'credential_scope_orphaned')).toHaveLength(1)
}, 60_000)
