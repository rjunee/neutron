/**
 * The DIRECTION GUARD (defect 2026-08-14) — a boot that was never told who it
 * is may not pull the live instance's rows onto itself.
 *
 * The measured outage: `NEUTRON_INSTANCE_SLUG` was unset while `NEUTRON_HOME`
 * was inherited, so the reconciler resolved the documented `'dev'` fallback,
 * pointed it at the LIVE instance database, and moved all fifteen credential rows
 * `juno → dev`. Seven minutes later a normal boot moved them back. The owner
 * pressed ▶ inside that window and the gateway — frozen on the handle `juno` —
 * read zero secrets and reported "GitHub origin detected but the outer publisher
 * cannot authenticate". Nothing was expired and nothing was revoked.
 *
 * The reconciler was not malfunctioning; it was SYMMETRIC. Migrating forward
 * onto an explicitly configured handle is the feature. Migrating onto the
 * FALLBACK handle is always wrong, because the fallback means "nobody told me
 * who I am". These cases pin the asymmetry, one test per acceptance bullet.
 *
 * The flip-flop case asserts on the DECRYPTED token, not on row counts: counting
 * rows under each handle passes whether the guard skipped correctly or clobbered
 * and restored, which is exactly how a test here gets faked.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SecretsStore } from '@neutronai/auth/secrets-store.ts'
import { readGitHubToken, storeGitHubToken } from '@neutronai/github/credential.ts'
import { asOwnerHandle, ProjectDb } from '@neutronai/persistence/index.ts'

import { applyMigrations } from '../runner.ts'
import { reconcileInstanceScope, reconcileInstanceScopeOnProjectDb } from '../scope-rekey.ts'

/** The real, explicitly-configured handle the live rows are scoped to. */
const LIVE = 'juno'
/** The documented bare-`bun run` default — "nobody told me who I am". */
const FALLBACK = 'dev'
const TOKEN = 'ghp_direction_guard_regression'

let dir: string
let dbPath: string
let db: Database
let pdb: ProjectDb | null = null

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'neutron-scope-direction-'))
  dbPath = join(dir, 'project.db')
  db = new Database(dbPath, { create: true })
  applyMigrations(db)
})

afterEach(() => {
  pdb?.close()
  pdb = null
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function snapshots(): string[] {
  return readdirSync(dir).filter((f) => f.startsWith('project.db.pre-rekey-'))
}

/** The anchor table the reconciler discovers stranded keys from. */
function seedOnboarding(slug: string, phase = 'completed'): void {
  db.prepare(
    `INSERT INTO onboarding_state
       (project_slug, user_id, phase, phase_state_json, started_at, last_advanced_at)
     VALUES (?, 'owner', ?, '{}', 1000, 1000)`,
  ).run(slug, phase)
}

/** A raw `secrets` row, for the cases that do not need the real crypto path. */
function seedSecret(slug: string, id = 'sec-1'): void {
  db.prepare(
    `INSERT INTO secrets (id, project_slug, kind, label, ciphertext, created_at)
     VALUES (?, ?, 'oauth_token', 'github', 'ciphertext-blob', 1000)`,
  ).run(id, slug)
}

function seedLedger(slug: string): void {
  db.prepare(`INSERT INTO instance_scope_ledger (id, project_slug, updated_at) VALUES (1, ?, ?)`)
    .run(slug, 1)
}

function ledgerSlug(): string | null {
  const row = db
    .query<{ project_slug: string }, []>(`SELECT project_slug FROM instance_scope_ledger WHERE id = 1`)
    .get()
  return row?.project_slug ?? null
}

function slugsIn(table: string, column = 'project_slug'): string[] {
  return db
    .query<{ v: string }, []>(`SELECT DISTINCT ${column} AS v FROM ${table} ORDER BY ${column}`)
    .all()
    .map((r) => r.v)
}

describe('direction guard — a fallback boot never pulls rows off an explicit handle', () => {
  test('UNSET slug vs a juno-scoped DB: no move, no snapshot, no ledger write', () => {
    seedOnboarding(LIVE)
    seedSecret(LIVE)

    const result = reconcileInstanceScope(db, FALLBACK, {
      dbPath,
      currentSlugIsFallback: true,
    })

    expect(result.action).toBe('noop')
    expect(result.refused_direction?.stranded_keys).toEqual([LIVE])
    // The count is the evidence the log line carries: onboarding anchor + secret.
    expect(result.refused_direction?.stranded_rows).toBeGreaterThanOrEqual(2)
    expect(result.moved_total).toBe(0)
    expect(result.rekeys).toEqual([])

    expect(slugsIn('onboarding_state')).toEqual([LIVE])
    expect(slugsIn('secrets')).toEqual([LIVE])
    // The guard returns BEFORE the snapshot and BEFORE `BEGIN IMMEDIATE`, so
    // there is nothing on disk and nothing in the ledger to undo.
    expect(snapshots()).toEqual([])
    expect(ledgerSlug()).toBeNull()
  })

  test('UNSET slug with the ledger already recording juno: still a noop, ledger untouched', () => {
    // The steady-state shape of the outage: the live box had already reconciled,
    // so the ledger is the authority saying these rows belong to `juno`.
    seedOnboarding(LIVE)
    seedSecret(LIVE)
    seedLedger(LIVE)

    const result = reconcileInstanceScope(db, FALLBACK, {
      dbPath,
      currentSlugIsFallback: true,
    })

    expect(result.action).toBe('noop')
    expect(result.refused_direction?.stranded_keys).toEqual([LIVE])
    expect(ledgerSlug()).toBe(LIVE)
    expect(slugsIn('secrets')).toEqual([LIVE])
    expect(snapshots()).toEqual([])
  })

  test('EXPLICIT dev vs a dev-scoped DB behaves exactly as before the guard', () => {
    // A genuine dev instance is not collateral damage: `NEUTRON_INSTANCE_SLUG=dev`
    // set on purpose is provenance `'env'`, so the flag is absent here.
    seedOnboarding(FALLBACK)
    seedSecret(FALLBACK)

    const result = reconcileInstanceScope(db, FALLBACK, { dbPath })

    expect(result.action).toBe('seeded')
    expect(result.refused_direction).toBeUndefined()
    expect(slugsIn('onboarding_state')).toEqual([FALLBACK])
    expect(slugsIn('secrets')).toEqual([FALLBACK])
    expect(ledgerSlug()).toBe(FALLBACK)
    expect(snapshots()).toEqual([])
  })

  test('FORWARD migration is preserved — explicit juno still adopts dev-scoped rows', () => {
    // The feature the guard must not weaken: a rename onto a real handle.
    seedOnboarding(FALLBACK)
    seedSecret(FALLBACK)

    const result = reconcileInstanceScope(db, LIVE, { dbPath, currentSlugIsFallback: false })

    expect(result.action).toBe('rekeyed')
    expect(result.refused_direction).toBeUndefined()
    expect(slugsIn('onboarding_state')).toEqual([LIVE])
    expect(slugsIn('secrets')).toEqual([LIVE])
    expect(ledgerSlug()).toBe(LIVE)
    expect(snapshots().length).toBe(1)
  })

  test('a FRESH dev box still seeds — the guard only fires on stranded rows', () => {
    const result = reconcileInstanceScope(db, FALLBACK, {
      dbPath,
      currentSlugIsFallback: true,
    })

    expect(result.action).toBe('seeded')
    expect(result.refused_direction).toBeUndefined()
    expect(ledgerSlug()).toBe(FALLBACK)
    expect(snapshots()).toEqual([])
  })
})

describe('direction guard — the flip-flop', () => {
  test('unset → juno → unset leaves the DECRYPTED GitHub token readable throughout', async () => {
    // The exact sequence the two surviving snapshot files record, against ONE
    // database, through the real crypto path: a store, not a fixture blob.
    pdb = ProjectDb.open(dbPath)
    const store = new SecretsStore({ data_dir: dir, db: pdb })
    await storeGitHubToken(store, asOwnerHandle(LIVE), TOKEN)
    seedOnboarding(LIVE)

    // BOOT 1 — an anonymous process inheriting NEUTRON_HOME.
    const boot1 = reconcileInstanceScopeOnProjectDb(pdb, FALLBACK, {
      dbPath,
      currentSlugIsFallback: true,
    })
    expect(boot1.action).toBe('noop')
    expect(boot1.refused_direction?.stranded_keys).toEqual([LIVE])
    expect(await readGitHubToken(store, asOwnerHandle(LIVE))).toBe(TOKEN)
    expect(slugsIn('secrets')).toEqual([LIVE])

    // BOOT 2 — the real gateway, explicitly configured.
    const boot2 = reconcileInstanceScopeOnProjectDb(pdb, LIVE, {
      dbPath,
      currentSlugIsFallback: false,
    })
    expect(boot2.action).not.toBe('rekeyed')
    expect(boot2.rekeys).toEqual([])
    expect(await readGitHubToken(store, asOwnerHandle(LIVE))).toBe(TOKEN)
    expect(slugsIn('secrets')).toEqual([LIVE])

    // BOOT 3 — the anonymous process again, now with the ledger on `juno`.
    const boot3 = reconcileInstanceScopeOnProjectDb(pdb, FALLBACK, {
      dbPath,
      currentSlugIsFallback: true,
    })
    expect(boot3.action).toBe('noop')
    expect(boot3.refused_direction?.stranded_keys).toEqual([LIVE])
    expect(await readGitHubToken(store, asOwnerHandle(LIVE))).toBe(TOKEN)
    expect(slugsIn('secrets')).toEqual([LIVE])

    // No ordering of these boots can move rows off the explicit handle, so the
    // two live snapshot files are not reachable in sequence — and no snapshot is
    // taken at all, because nothing was ever repaired.
    expect(slugsIn('onboarding_state')).toEqual([LIVE])
    expect(ledgerSlug()).toBe(LIVE)
    expect(snapshots()).toEqual([])
  })
})
