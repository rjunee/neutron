/**
 * THE PROVENANCE BOUNDARY — `resolveOwnerSlugSourceFromConfig`'s `source` field.
 *
 * `source` is the highest-precedence input to the scope direction guard: it is
 * the ONLY thing that decides whether a migration is REFUSED
 * (`gateway/index.ts:348` and `:456` both read `slugResolution.source ===
 * 'fallback'`). Before this file nothing asserted it. Every test that touched
 * the resolver asserted the SLUG (`open/__tests__/bootconfig-both-entrypoints
 * .test.ts:140,154`), the direction unit suite passes `currentSlugIsFallback`
 * in by hand, and the boot regression deliberately makes `.url_slug` ABSENT —
 * so the file-provenance branch had no direct coverage at all.
 *
 * ── THE MUTANT THIS FILE KILLS, AND THE ONES IT DOESN'T ────────────────────
 * MEASURED on this branch, not asserted from the review card:
 *
 *   `source: 'file'`     → `'fallback'`  ALREADY DIES on
 *       `gateway/__tests__/boot-credential-scope.test.ts` (a3) — that suite
 *       pins the boot handle with a `.url_slug` file and seeds stale rows, so
 *       the credential direction guard refuses and the token stops reading
 *       back. (Run before this file existed: 35 pass / 1 fail.)
 *   `source: 'env'`      → `'fallback'`  ALREADY DIES on
 *       `open/__tests__/open-scope-rekey-boot.test.ts` (2/2 red).
 *   `source: 'file'`     → `'env'`       SURVIVED THE ENTIRE SUITE. Both values
 *       are non-fallback, so no guard changes behavior and every slug is still
 *       the right string — and the DISTINCTION is load-bearing the moment any
 *       future policy keys on "the owner configured this explicitly, in a file
 *       the rename orchestrator writes" versus "an env var this shell happened
 *       to carry". THAT is the mutant the matrix below kills, by asserting the
 *       whole `{slug, source}` object rather than the slug.
 *
 * The consequence of getting `'file'` wrong in the OTHER direction is the exact
 * inverse of the guard's purpose: a REAL rename (the orchestrator writes the new
 * name to `.url_slug`) would be refused as if it were an anonymous boot, and the
 * owner's old-scope rows would be stranded and unreachable. The last test here
 * drives that rename through a real `boot()` so the forward path is pinned by
 * behavior and not only by the resolver's return value.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'

import { resolveBootConfig } from '@neutronai/config/index.ts'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'

import { boot, resolveOwnerSlugSourceFromConfig } from '../index.ts'

const OLD_HANDLE = 'old-handle'
const NEW_HANDLE = 'new-handle'

let home: string
let dbPath: string

/** A BootConfig built from an EXPLICIT bag — never `process.env`. */
function configFor(env: Record<string, string | undefined>): ReturnType<typeof resolveBootConfig> {
  return resolveBootConfig({ NEUTRON_HOME: home, ...env })
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'neutron-slug-provenance-'))
  dbPath = join(home, 'project.db')
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

describe('resolveOwnerSlugSourceFromConfig — the provenance matrix over all three inputs', () => {
  test('`.url_slug` file present → source "file", and it BEATS the env var', () => {
    writeFileSync(join(home, '.url_slug'), `${NEW_HANDLE}\n`, 'utf8')
    // Asserted as the WHOLE object: an assertion on `.slug` alone is satisfied
    // by any `source`, which is precisely how this branch went uncovered.
    expect(
      resolveOwnerSlugSourceFromConfig(configFor({ NEUTRON_INSTANCE_SLUG: 'from-env' })),
    ).toEqual({ slug: NEW_HANDLE, source: 'file' })
  })

  test('no file, `NEUTRON_INSTANCE_SLUG` set → source "env"', () => {
    expect(resolveOwnerSlugSourceFromConfig(configFor({ NEUTRON_INSTANCE_SLUG: OLD_HANDLE }))).toEqual(
      { slug: OLD_HANDLE, source: 'env' },
    )
  })

  test('neither → source "fallback", the ONLY input that arms the direction guard', () => {
    expect(resolveOwnerSlugSourceFromConfig(configFor({}))).toEqual({
      slug: 'dev',
      source: 'fallback',
    })
  })

  test('an EXPLICIT `NEUTRON_INSTANCE_SLUG=dev` is "env", not "fallback"', () => {
    // The `??` semantics the resolver's docblock calls out (gateway/index.ts:
    // 200-203): the fallback is reached by ABSENCE, never by the string 'dev'.
    // An owner who really is called `dev` must not have his rows frozen out.
    expect(resolveOwnerSlugSourceFromConfig(configFor({ NEUTRON_INSTANCE_SLUG: 'dev' }))).toEqual({
      slug: 'dev',
      source: 'env',
    })
  })

  test('an EMPTY `NEUTRON_INSTANCE_SLUG` is "fallback" — a failed deploy, not a configured one', () => {
    // Argus r1 (2026-08-16). `NEUTRON_INSTANCE_SLUG=` reaches the resolver as
    // `''`, not `undefined`, and the earlier `!== undefined` test called that
    // CONFIGURED. Two consequences, both the 2026-08-14 outage: the direction
    // guard arms only on 'fallback' (`gateway/index.ts:348`, `:456`) so it stays
    // DISARMED, and every owner row is then re-keyed onto the handle `''` —
    // which no owner ever passes to `listRecentForScope`, so even the damage
    // report would be unreadable.
    expect(resolveOwnerSlugSourceFromConfig(configFor({ NEUTRON_INSTANCE_SLUG: '' }))).toEqual({
      slug: 'dev',
      source: 'fallback',
    })
  })

  test('a WHITESPACE `NEUTRON_INSTANCE_SLUG` is "fallback" too', () => {
    expect(resolveOwnerSlugSourceFromConfig(configFor({ NEUTRON_INSTANCE_SLUG: '  \t ' }))).toEqual({
      slug: 'dev',
      source: 'fallback',
    })
  })

  test('a PADDED `NEUTRON_INSTANCE_SLUG` is trimmed, as the file branch always was', () => {
    // ` juno ` as a literal scope key matches nothing else in the system — the
    // `.url_slug` branch has always trimmed, and the two inputs must agree.
    expect(
      resolveOwnerSlugSourceFromConfig(configFor({ NEUTRON_INSTANCE_SLUG: `  ${NEW_HANDLE}\n` })),
    ).toEqual({ slug: NEW_HANDLE, source: 'env' })
  })

  test('an EMPTY/whitespace `.url_slug` falls THROUGH to the env var', () => {
    writeFileSync(join(home, '.url_slug'), '   \n', 'utf8')
    expect(
      resolveOwnerSlugSourceFromConfig(configFor({ NEUTRON_INSTANCE_SLUG: OLD_HANDLE })),
    ).toEqual({ slug: OLD_HANDLE, source: 'env' })
  })

  test('`OWNER_HOME` is where the file is read from when it is set', () => {
    // The effective owner home is `ownerHome ?? neutronHome` (gateway/index.ts:
    // 206). A box with OWNER_HOME set must read THAT `.url_slug`, not the one
    // beside the database.
    const ownerHome = mkdtempSync(join(tmpdir(), 'neutron-slug-ownerhome-'))
    try {
      writeFileSync(join(ownerHome, '.url_slug'), `${NEW_HANDLE}\n`, 'utf8')
      writeFileSync(join(home, '.url_slug'), 'ignored-neighbour', 'utf8')
      expect(
        resolveOwnerSlugSourceFromConfig(
          resolveBootConfig({ NEUTRON_HOME: home, OWNER_HOME: ownerHome, NEUTRON_DB_PATH: dbPath }),
        ),
      ).toEqual({ slug: NEW_HANDLE, source: 'file' })
    } finally {
      rmSync(ownerHome, { recursive: true, force: true })
    }
  })
})

describe('a FILE-driven rename still migrates forward through a real boot()', () => {
  const ENV_KEYS = [
    'NEUTRON_HOME',
    'NEUTRON_DB_PATH',
    'OWNER_HOME',
    'NEUTRON_INSTANCE_SLUG',
    'NOTIFY_SOCKET',
  ] as const
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key]
      delete process.env[key]
    }
    process.env['NEUTRON_HOME'] = home
    const raw = new Database(dbPath, { create: true })
    applyMigrations(raw)
    // The owner's box BEFORE the rename: the scope-rekey reconciler's anchor
    // table carries exactly one owner row, under the old handle.
    const now = Date.now()
    raw.run(
      `INSERT INTO onboarding_state
         (project_slug, user_id, phase, started_at, last_advanced_at, completed_at)
       VALUES (?, 'owner', 'completed', ?, ?, ?)`,
      [OLD_HANDLE, now, now, now],
    )
    raw.close()
  })

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = saved[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  test('`.url_slug` names the new handle → the old-scope rows move onto it', async () => {
    // This is the rename orchestrator's output, and the ONLY provenance that
    // reaches the reconciler as `source: 'file'`. Mutating that literal to
    // 'fallback' arms the direction guard here and strands the row.
    writeFileSync(join(home, '.url_slug'), `${NEW_HANDLE}\n`, 'utf8')

    const handle = await boot({ port: 0 })
    try {
      // POSITIVE CONTROL FIRST: the boot really did resolve the new handle from
      // the file, so a green result below cannot come from the test having
      // seeded the new handle itself.
      expect(
        resolveOwnerSlugSourceFromConfig(resolveBootConfig(process.env)),
      ).toEqual({ slug: NEW_HANDLE, source: 'file' })
      expect(
        handle.db
          .all<{ project_slug: string }, []>(
            'SELECT DISTINCT project_slug FROM onboarding_state ORDER BY project_slug',
          )
          .map((r) => r.project_slug),
      ).toEqual([NEW_HANDLE])
      // The re-key committed, so the ledger moved with it.
      expect(
        handle.db.get<{ project_slug: string }, []>(
          'SELECT project_slug FROM instance_scope_ledger WHERE id = 1',
        )?.project_slug,
      ).toBe(NEW_HANDLE)
    } finally {
      await handle.shutdown({ force: true })
    }

    // A forward re-key REPAIRS a database, so unlike a refusal it journals a
    // repair row — and never a refusal row.
    const db = ProjectDb.open(dbPath)
    try {
      const names = db
        .all<{ event_name: string }, []>('SELECT event_name FROM system_events', [])
        .map((r) => r.event_name)
      expect(names).toContain('instance_scope_rekeyed')
      expect(names).not.toContain('instance_scope_rekey_refused')
    } finally {
      db.close()
    }
  }, 60_000)
})
