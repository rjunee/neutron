/**
 * The DIRECTION GUARD, at the COMPOSITION ROOT (defect 2026-08-14 19:35).
 *
 * ── WHY THIS TEST EXISTS, GIVEN THE UNIT SUITE ─────────────────────────────
 * `migrations/__tests__/scope-rekey-direction-guard.test.ts` pins the guard's
 * POLICY by calling `reconcileInstanceScope*` with `currentSlugIsFallback`
 * passed in by hand. There is exactly one failure it cannot see:
 * `gateway/index.ts:boot()` silently NOT threading that flag. With the flag
 * unthreaded the reconciler is symmetric again and a fallback boot re-keys the
 * live rows precisely as it did in the outage — every unit case still green.
 *
 * So this test drives the REAL `boot()` with the production Open composer, and
 * the slug arrives the only way it arrives in production: through the
 * environment, read by boot's own resolver. The test never writes a scope key.
 *
 * ── THE OUTAGE, IN ONE SEQUENCE ────────────────────────────────────────────
 * `NEUTRON_INSTANCE_SLUG` was unset while `NEUTRON_HOME` was inherited, so the
 * documented `'dev'` fallback was pointed at the LIVE instance database and moved
 * all fifteen credential rows `juno → dev` (snapshot `…pre-rekey-1786735643069`,
 * 19:27). Seven minutes later a normal boot moved them back
 * (`…pre-rekey-1786736040922`, 19:34). The owner pressed ▶ inside that window
 * and the gateway — frozen on the handle `juno` — read zero secrets and
 * reported "GitHub origin detected but the outer publisher cannot
 * authenticate". Nothing was expired and nothing was revoked.
 *
 * The boots below are that sequence: explicit `juno` → slug UNSET → explicit
 * `juno`, against ONE database.
 *
 * ── HOW A TEST HERE GETS FAKED ─────────────────────────────────────────────
 * Counting rows under each handle passes whether the guard skipped correctly or
 * clobbered and restored, so every boot also asserts the DECRYPTED GitHub token
 * through a FRESH `SecretsStore`. And "nothing moved" is equally consistent
 * with the reconcile never having run at all — so the fallback boot must ALSO
 * leave a durable `instance_scope_rekey_refused` row. That row is the positive
 * evidence that `currentSlugIsFallback` reached the reconciler from `boot()`.
 *
 * And a COUNT of those rows is itself fakeable, which is the second thing this
 * file now pins (2026-08-16). Journalled under the anonymous fallback the row
 * satisfies any count and is unreadable FOREVER — the refusal deliberately
 * leaves the ledger on `juno`, so the next explicit boot takes the
 * ledger-agrees fast path and never sweeps `system_events` back, while the
 * owner's diagnostics feed is strictly `WHERE project_slug = ?`. So the
 * assertions below are on the SCOPE, read through the production reader
 * (`listRecentForScope`), with the anonymous scope asserted EMPTY as the
 * control. INVARIANTS #116(b).
 *
 * SCOPE OF THIS FILE, stated because it is NOT the whole rule: here the live
 * handle, the ledger's handle and the frozen credential handle are all the
 * string `juno`, so it cannot tell a row scoped to "the handle the owner reads
 * under" from one scoped to "the handle the rows are stuck under". That
 * distinction is what
 * `gateway/__tests__/boot-refusal-scope.test.ts` exists for (the rename shape,
 * where they diverge), and `gateway/__tests__/scope-refusal-journal.test.ts`
 * pins the policy — narrowing, blank handles, and the edge trigger — directly.
 *
 * MUTATION-TESTED — see the commit body for the stub and the failure it
 * produced.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { SecretsStore } from '@neutronai/auth/secrets-store.ts'
import { boot, type BootHandle } from '@neutronai/gateway/index.ts'
import { readGitHubToken, storeGitHubToken } from '@neutronai/github/credential.ts'
import { SqliteOnboardingStateStore } from '@neutronai/onboarding/interview/sqlite-state-store.ts'
import { asOwnerHandle, ProjectDb } from '@neutronai/persistence/index.ts'
import {
  type PersistedSystemEvent,
  SystemEventsStore,
} from '@neutronai/persistence/system-events.ts'

import { createIsolatedHome, type IsolatedHome } from '../../tests/support/test-isolation.ts'
import { __resetAmbientAuthCacheForTests } from '../ambient-claude-auth.ts'
import { buildOpenGraphComposer } from '../composer.ts'
import { OWNER_USER_ID } from '../owner-identity.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const LANDING_DIR = join(HERE, '..', '..', 'landing')

/** The real, explicitly-configured handle every live row is scoped to. */
const LIVE = 'juno'
/** The token the owner's `gh` actually authenticates with, in shape. */
const TOKEN = 'ghp_boot_direction_guard_regression'

let home: IsolatedHome
let handle: BootHandle | null = null

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function waitFor(pred: () => boolean, timeoutMs = 15_000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await sleep(25)
  }
}

/** Open a second connection to the booted server's database for assertions. */
function withDb<T>(fn: (db: ProjectDb) => T): T {
  const db = ProjectDb.open(home.dbPath)
  try {
    return fn(db)
  } finally {
    db.close()
  }
}

function slugsIn(table: string): string[] {
  return withDb((db) =>
    db
      .prepare<{ project_slug: string }, []>(
        `SELECT DISTINCT project_slug FROM ${table} ORDER BY project_slug`,
      )
      .all()
      .map((r) => r.project_slug),
  )
}

function ledgerSlug(): string | null {
  return withDb(
    (db) =>
      db
        .prepare<{ project_slug: string }, []>(
          `SELECT project_slug FROM instance_scope_ledger WHERE id = 1`,
        )
        .get()?.project_slug ?? null,
  )
}

/** A refused re-key repairs nothing, so it must preserve nothing. */
function snapshotCount(): number {
  return readdirSync(home.dir).filter((f) => f.startsWith('project.db.pre-rekey-')).length
}

function refusalEvents(): number {
  return withDb(
    (db) =>
      db
        .prepare<{ n: number }, []>(
          `SELECT COUNT(*) AS n FROM system_events
            WHERE event_name = 'instance_scope_rekey_refused'`,
        )
        .get()?.n ?? 0,
  )
}

/**
 * The scopes the refusal rows actually landed under — the assertion a COUNT
 * cannot make. A count is satisfied by a row keyed to the anonymous fallback,
 * which is a row no owner can ever read (see `refusalIsVisibleToOwner` below).
 */
function refusalScopes(): string[] {
  return withDb((db) =>
    db
      .prepare<{ project_slug: string }, []>(
        `SELECT DISTINCT project_slug FROM system_events
          WHERE event_name = 'instance_scope_rekey_refused'
          ORDER BY project_slug`,
      )
      .all()
      .map((r) => r.project_slug),
  )
}

/**
 * The acceptance the whole guard is FOR: does the owner's own instance-scoped
 * diagnostics feed surface the refusal? Read through the production reader
 * (`listRecentForScope`, strictly `WHERE project_slug = ?`), not through a
 * hand-written query that could be laxer than production.
 */
function refusalIsVisibleToOwner(scope: string): PersistedSystemEvent[] {
  return withDb((db) =>
    new SystemEventsStore({ db })
      .listRecentForScope(scope, 100)
      .filter((e) => e.event === 'instance_scope_rekey_refused'),
  )
}

/**
 * The assertion that cannot be faked by clobber-and-restore: the plaintext,
 * back through the real crypto path. A FRESH store every time, so nothing can
 * be served out of a cache the previous boot warmed.
 */
async function readTokenBack(): Promise<string | null> {
  const db = ProjectDb.open(home.dbPath)
  try {
    const store = new SecretsStore({ data_dir: home.dir, db })
    return await readGitHubToken(store, asOwnerHandle(LIVE))
  } finally {
    db.close()
  }
}

/**
 * One full boot of the real server, then a clean shutdown.
 *
 * `slug === undefined` DELETES `NEUTRON_INSTANCE_SLUG` — which is the whole
 * point: the fallback is reached by ABSENCE, not by the string `'dev'`. The
 * home dir deliberately has no `.url_slug` file (only the rename orchestrator
 * writes one), or provenance would be `'file'` and this path unreachable.
 */
async function bootOnce(
  slug: string | undefined,
  opts: { until?: () => boolean } = {},
): Promise<void> {
  if (slug === undefined) delete process.env['NEUTRON_INSTANCE_SLUG']
  else process.env['NEUTRON_INSTANCE_SLUG'] = slug

  const composer = buildOpenGraphComposer({ env: process.env })
  // Not wrapped in anything that could swallow a throw: `boot()` returning a
  // live handle IS the "a refused re-key never refuses the boot" assertion.
  handle = await boot({ composer, port: 0 })
  try {
    // Bounded WAIT, not an assertion — the journal write is fire-and-forget off
    // boot. Giving up here falls through to the caller's explicit expectation
    // so a regression reports the missing row, not an opaque helper timeout.
    if (opts.until !== undefined) await waitFor(opts.until).catch(() => undefined)
    await sleep(1_500)
  } finally {
    await handle.shutdown({ force: true })
    handle = null
  }
}

beforeEach(() => {
  home = createIsolatedHome({
    slug: LIVE,
    extraEnvKeys: [
      'NEUTRON_LANDING_STATIC_DIR',
      'NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET',
      'ANTHROPIC_API_KEY',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'NEUTRON_DISABLE_AMBIENT_CLAUDE_AUTH',
      'NOTIFY_SOCKET',
      'NEUTRON_GRAPH_COMPOSER_MODULE',
      'TZ',
    ],
    env: {
      NEUTRON_LANDING_STATIC_DIR: LANDING_DIR,
      NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET: 'open-scope-direction-boot-secret-0123456789',
      ANTHROPIC_API_KEY: 'sk-ant-synthetic-scope-direction-boot-test',
      CLAUDE_CODE_OAUTH_TOKEN: undefined,
      NEUTRON_DISABLE_AMBIENT_CLAUDE_AUTH: '1',
      NOTIFY_SOCKET: undefined,
      NEUTRON_GRAPH_COMPOSER_MODULE: undefined,
    },
  })
  __resetAmbientAuthCacheForTests()
})

afterEach(async () => {
  if (handle !== null) {
    await handle.shutdown({ force: true })
    handle = null
  }
  home.restore()
}, 30_000)

describe('direction guard at boot — an anonymous process cannot steal the live scope', () => {
  test('explicit juno → slug UNSET → explicit juno leaves every credential row on juno', async () => {
    // The owner's box on disk before any of this: migrations applied, onboarding
    // finished under `juno`, and a GitHub token stored through the REAL crypto
    // path (a store, not a fixture blob). Seeded on a bare connection because
    // `boot()` is what runs the migrations in production.
    {
      const db = ProjectDb.open(home.dbPath)
      try {
        const { applyMigrations } = await import('@neutronai/migrations/runner.ts')
        applyMigrations(db.raw())
        const onboarding = new SqliteOnboardingStateStore({ db })
        await onboarding.upsert({
          owner_slug: LIVE,
          user_id: OWNER_USER_ID,
          phase: 'completed',
          completed_at: Date.now(),
          persona_files_committed: true,
          wow_fired: true,
        })
        const secrets = new SecretsStore({ data_dir: home.dir, db })
        await storeGitHubToken(secrets, asOwnerHandle(LIVE), TOKEN)
      } finally {
        db.close()
      }
    }

    // ── BOOT 1 — the real gateway, explicitly configured. ───────────────────
    await bootOnce(LIVE)

    expect(slugsIn('secrets')).toEqual([LIVE])
    expect(slugsIn('onboarding_state')).toEqual([LIVE])
    // This boot is what seeds the ledger, so the fallback boot below meets the
    // steady-state shape of the outage: an authoritative ledger saying `juno`.
    expect(ledgerSlug()).toBe(LIVE)
    expect(snapshotCount()).toBe(0)
    expect(await readTokenBack()).toBe(TOKEN)
    expect(refusalEvents()).toBe(0)

    // ── BOOT 2 — the anonymous process. ────────────────────────────────────
    // `NEUTRON_INSTANCE_SLUG` absent, `NEUTRON_HOME` still pointing at the live
    // home: a test suite, a bare `bun run`, a worktree under a cleared env. This
    // is the 19:27 boot. It must resolve `'dev'`, see `juno`-scoped rows, and
    // leave every one of them exactly where it found it.
    await bootOnce(undefined, { until: () => refusalEvents() >= 1 })

    expect(slugsIn('secrets')).toEqual([LIVE])
    // If this ever contains 'dev', some module minted an onboarding row at boot
    // with zero owner interaction — a NEW instance of this defect class. Do not
    // loosen it.
    expect(slugsIn('onboarding_state')).toEqual([LIVE])
    // The guard returns before the transaction, so not even the bookkeeping moves.
    expect(ledgerSlug()).toBe(LIVE)
    // A refused re-key repaired nothing, so it preserved nothing.
    expect(snapshotCount()).toBe(0)
    expect(await readTokenBack()).toBe(TOKEN)
    // POSITIVE evidence, not the absence of damage: the flag was threaded from
    // `boot()` and the guard actually fired. Zero here with the rows still in
    // place means the reconcile was skipped, not refused — the exact silent
    // failure this file exists to catch.
    expect(refusalEvents()).toBeGreaterThanOrEqual(1)

    // ── AND THE SCOPE, WHICH THE COUNT ABOVE CANNOT SEE ────────────────────
    // A row keyed to `dev` satisfies the count and is unreadable forever: the
    // refusal deliberately leaves the ledger on `juno`, so the next explicit
    // boot takes the ledger-agrees fast path and never sweeps `system_events`
    // back — and the owner's diagnostics feed is strictly `WHERE project_slug
    // = ?`. The row belongs to the handle whose rows were at stake.
    expect(refusalScopes()).toEqual([LIVE])
    // The acceptance in the owner's terms: it is in HIS feed, through the
    // production reader, naming the anonymous process that tried.
    const visible = refusalIsVisibleToOwner(LIVE)
    expect(visible).toHaveLength(1)
    expect(visible[0]!.payload['attempted_by_slug']).toBe('dev')
    expect(visible[0]!.payload['stranded_slug']).toBe(LIVE)
    // Narrowed to this scope: no OTHER handle's name or volume rides along
    // (Argus r1 — a per-handle fan-out of the full payload is a cross-scope
    // disclosure). Here there is only one, so the counts are zero.
    expect(visible[0]!.payload['other_stranded_handles']).toBe(0)
    // The negative control that makes the assertion above mean something: the
    // anonymous scope holds nothing, so `toEqual([LIVE])` is a real placement
    // and not a duplicate written to both.
    expect(refusalIsVisibleToOwner('dev')).toEqual([])

    // THE SECOND RECONCILER, same rule. `reconcileCredentialScope` sweeps a
    // DIFFERENT table set, so scoping only the re-key row readably leaves the
    // credential refusal exactly as invisible as the bug being fixed here.
    const credRefusal = withDb((db) =>
      new SystemEventsStore({ db })
        .listRecentForScope(LIVE, 100)
        .filter((e) => e.event === 'credential_scope_orphaned'),
    )
    expect(credRefusal).toHaveLength(1)
    expect(credRefusal[0]!.payload['attempted_by_slug']).toBe('dev')
    expect(credRefusal[0]!.payload['refused_direction']).toBe(true)
    expect(
      withDb((db) =>
        new SystemEventsStore({ db })
          .listRecentForScope('dev', 100)
          .filter((e) => e.event === 'credential_scope_orphaned'),
      ),
    ).toEqual([])

    // ── BOOT 3 — the real gateway again. ───────────────────────────────────
    // The 19:34 boot, which in the outage moved the rows back. Here there is
    // nothing to move back, so it is inert.
    await bootOnce(LIVE)

    expect(slugsIn('secrets')).toEqual([LIVE])
    expect(slugsIn('onboarding_state')).toEqual([LIVE])
    expect(ledgerSlug()).toBe(LIVE)
    // Nothing was ever stranded, so nothing was ever repaired: the two live
    // snapshot files' scopes are not reachable in ANY ordering of boots.
    expect(snapshotCount()).toBe(0)
    expect(await readTokenBack()).toBe(TOKEN)
    // Three full boots of the production graph, measured at ~20s each on the
    // build box — the same order of magnitude the sibling boot suite budgets.
  }, 300_000)
})
