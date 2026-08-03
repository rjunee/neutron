/**
 * #451 — a RENAMED instance must not read as "still onboarding".
 *
 * ── THE DEFECT ─────────────────────────────────────────────────────────────
 * An instance has a frozen handle and a renameable `url_slug`, and nearly every
 * table in `project.db` is scoped by the renameable one. The gateway resolves
 * that slug ONCE at boot and hands the same string to the whole module graph, so
 * the moment the owner renames, every pre-rename row is stranded under the OLD
 * key while the running process reads the NEW one.
 *
 * `onboarding_state` is where it hurts. The composer's onboarding predicate
 * (`open/composer.ts` `isOnboardingActive`) fail-closes on a miss —
 * `st === null → true` — so an owner whose row says `phase = 'completed'` is
 * reported as still onboarding, on every boot, forever. Two consequences, both
 * owner-visible: the bundled-ritual boot sweep gates on that predicate and so
 * defers permanently (the ritual layer can never turn on), and the live-turn
 * builder keeps `onboardingActive` true, which pins the cold-turn onboarding
 * preamble on and runs every ordinary message through the onboarding-answer
 * extractor. Using the product is what keeps him inside onboarding.
 *
 * ── WHY THESE TESTS BOOT THE REAL SERVER ───────────────────────────────────
 * The reconciler's policy is unit-tested in
 * `migrations/__tests__/scope-rekey.test.ts` against a real migrated database.
 * That is not what failed here. What failed was that NOTHING RECONCILED AT
 * BOOT — so these tests go through `boot()` with the production Open composer
 * and assert the owner-visible BEHAVIOUR downstream of it: after a rename, the
 * bundled-ritual sweep proceeds instead of deferring, which it can only do if
 * the onboarding seam now reports the owner as finished.
 *
 * The new slug is NEVER written by the test. It arrives exactly the way it
 * arrives in production — through the environment, read by `boot()`'s slug
 * resolver — so a test that "helpfully" seeded the new key would prove nothing.
 *
 * MUTATION-TESTED — see the PR body for the stub and the failure it produced.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { boot, type BootHandle } from '@neutronai/gateway/index.ts'
import { writeOwnerTimezone } from '@neutronai/gateway/storage/owner-metadata.ts'
import { SqliteOnboardingStateStore } from '@neutronai/onboarding/interview/sqlite-state-store.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'

import { createIsolatedHome, type IsolatedHome } from '../../tests/support/test-isolation.ts'
import { __resetAmbientAuthCacheForTests } from '../ambient-claude-auth.ts'
import { buildOpenGraphComposer } from '../composer.ts'
import { OWNER_USER_ID } from '../owner-identity.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const LANDING_DIR = join(HERE, '..', '..', 'landing')

/** The slug the instance was created under, and the one it is renamed to. */
const BEFORE = 'owner-before'
const AFTER = 'owner-after'

/** The three rituals the engine ships — the sweep's observable output. */
const BUNDLED_IDS = ['morning-brief', 'evening-wrap', 'kaizen'] as const

let home: IsolatedHome
let handle: BootHandle | null = null

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function waitFor(pred: () => boolean, timeoutMs = 20_000): Promise<void> {
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

/**
 * Ritual approval prompts, per ritual id. These are the sweep's owner-facing
 * output: their presence means it ran, their absence means it deferred because
 * the onboarding seam said the owner is still onboarding.
 */
function contentPrompts(id: string): number {
  return withDb(
    (db) =>
      db
        .prepare<{ n: number }, [string]>(
          `SELECT COUNT(*) AS n FROM button_prompts WHERE body LIKE ?`,
        )
        .get(`Ritual approval needed: ${id}%`)?.n ?? 0,
  )
}

function allRitualsPrompted(): boolean {
  return BUNDLED_IDS.every((id) => contentPrompts(id) >= 1)
}

function onboardingRows(): Array<{ project_slug: string; user_id: string; phase: string }> {
  return withDb((db) =>
    db
      .prepare<{ project_slug: string; user_id: string; phase: string }, []>(
        `SELECT project_slug, user_id, phase FROM onboarding_state ORDER BY project_slug`,
      )
      .all(),
  )
}

function snapshotCount(): number {
  return readdirSync(home.dir).filter((f) => f.startsWith('project.db.pre-rekey-')).length
}

/** One full boot of the real server under `slug`, then a clean shutdown. */
async function bootAs(slug: string, opts: { waitForRituals?: boolean } = {}): Promise<void> {
  process.env['NEUTRON_INSTANCE_SLUG'] = slug
  const composer = buildOpenGraphComposer({ env: process.env })
  handle = await boot({ composer, port: 0 })
  try {
    // Bounded WAIT, not an assertion: giving up here must fall through to the
    // caller's explicit expectations so a regression reports "ritual X was never
    // offered to the owner" rather than an opaque timeout from a helper.
    if (opts.waitForRituals === true) await waitFor(allRitualsPrompted).catch(() => undefined)
    // The sweep is fire-and-forget off module start; this window is what makes
    // the NEGATIVE assertions ("nothing was prompted") meaningful rather than
    // merely early.
    await sleep(2_000)
  } finally {
    await handle.shutdown({ force: true })
    handle = null
  }
}

/**
 * Put the owner past onboarding UNDER `slug`, through the production store —
 * not raw SQL — so the row is byte-identical to one a real completed
 * onboarding leaves behind.
 */
async function completeOnboardingUnder(slug: string): Promise<void> {
  const db = ProjectDb.open(home.dbPath)
  try {
    const store = new SqliteOnboardingStateStore({ db })
    await store.upsert({
      owner_slug: slug,
      user_id: OWNER_USER_ID,
      phase: 'completed',
      completed_at: Date.now(),
      persona_files_committed: true,
      wow_fired: true,
    })
  } finally {
    db.close()
  }
}

beforeEach(() => {
  home = createIsolatedHome({
    slug: BEFORE,
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
      NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET: 'open-scope-rekey-test-secret-0123456789',
      ANTHROPIC_API_KEY: 'sk-ant-synthetic-scope-rekey-test',
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

describe('#451 — a renamed instance keeps its finished onboarding', () => {
  test('THE DEFECT: booting under a NEW slug over an old-slug database resumes normal service', async () => {
    // The owner's actual situation: a database written under the old slug, no
    // ledger yet (this fix has never run here), and a completed onboarding. The
    // migrations run inside `boot()`, so the row is seeded through a bare
    // connection first — exactly what an already-renamed box looks like on disk.
    const db = ProjectDb.open(home.dbPath)
    try {
      const { applyMigrations } = await import('@neutronai/migrations/runner.ts')
      applyMigrations(db.raw())
      const store = new SqliteOnboardingStateStore({ db })
      await store.upsert({
        owner_slug: BEFORE,
        user_id: OWNER_USER_ID,
        phase: 'completed',
        completed_at: Date.now(),
        persona_files_committed: true,
        wow_fired: true,
      })
      // Stored under the OLD slug too — it must follow the rename, or the
      // owner's timezone silently reverts to the default.
      await writeOwnerTimezone(db, BEFORE, 'America/Los_Angeles')
    } finally {
      db.close()
    }

    // The rename arrives the only way it does in production: through the env
    // the boot slug resolver reads. The test never writes the new key.
    await bootAs(AFTER, { waitForRituals: true })

    // BEHAVIOUR, not bookkeeping: the bundled-ritual sweep only runs when the
    // onboarding seam reports the owner FINISHED. Before this fix it deferred
    // on every boot with "owner is still onboarding" and this was 0 for all
    // three, forever.
    for (const id of BUNDLED_IDS) {
      expect(contentPrompts(id), `ritual '${id}' was never offered to the owner`).toBe(1)
    }

    // And the database is whole again: one onboarding row, under the live slug,
    // still terminal. No duplicate was minted under either key.
    expect(onboardingRows()).toEqual([
      { project_slug: AFTER, user_id: OWNER_USER_ID, phase: 'completed' },
    ])

    // The instance's own metadata row moved with it.
    const tz = withDb(
      (d) =>
        d
          .prepare<{ instance_slug: string; timezone: string | null }, []>(
            `SELECT instance_slug, timezone FROM instance_metadata`,
          )
          .all(),
    )
    expect(tz).toEqual([{ instance_slug: AFTER, timezone: 'America/Los_Angeles' }])

    // A repair happened to the owner's data, so it is durably journalled with
    // the pre-repair snapshot it can be undone from.
    const journal = withDb((d) =>
      d
        .prepare<{ project_slug: string | null; payload_json: string }, []>(
          `SELECT project_slug, payload_json FROM system_events
            WHERE event_name = 'instance_scope_rekeyed'`,
        )
        .all(),
    )
    expect(journal.length).toBe(1)
    expect(journal[0]?.project_slug).toBe(AFTER)
    expect(JSON.parse(journal[0]?.payload_json ?? '{}')).toMatchObject({ from: [BEFORE] })
    expect(snapshotCount()).toBe(1)
  }, 180_000)

  test('a rename BETWEEN boots is repaired on the next boot, and the boot after that is inert', async () => {
    // Boot 1 — a fresh instance mid-onboarding. Nothing to repair, and the
    // ritual sweep correctly stays quiet (its prompts would otherwise land where
    // the welcome opener belongs).
    await bootAs(BEFORE)
    for (const id of BUNDLED_IDS) expect(contentPrompts(id)).toBe(0)

    // The owner finishes onboarding, under the slug in force at the time.
    await completeOnboardingUnder(BEFORE)

    // Boot 2 — renamed. Repair, then normal service.
    await bootAs(AFTER, { waitForRituals: true })
    for (const id of BUNDLED_IDS) expect(contentPrompts(id)).toBe(1)
    expect(onboardingRows()).toEqual([
      { project_slug: AFTER, user_id: OWNER_USER_ID, phase: 'completed' },
    ])
    expect(snapshotCount()).toBe(1)

    // Boot 3 — nothing left to do. A restart loop must not re-snapshot the
    // database or re-ask the owner to approve rituals he already decided on.
    await bootAs(AFTER)
    for (const id of BUNDLED_IDS) expect(contentPrompts(id)).toBe(1)
    expect(snapshotCount()).toBe(1)
    const journal = withDb(
      (d) =>
        d
          .prepare<{ n: number }, []>(
            `SELECT COUNT(*) AS n FROM system_events WHERE event_name = 'instance_scope_rekeyed'`,
          )
          .get()?.n ?? 0,
    )
    expect(journal).toBe(1)
  }, 300_000)
})
