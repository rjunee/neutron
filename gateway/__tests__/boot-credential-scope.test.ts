/**
 * Acceptance (a3) of the 2026-08-14 card "Credentials orphaned by a changed
 * owner handle": through a REAL `boot()`.
 *
 * This file is ALSO the mutation guard the card demands — "deleting the
 * migration must turn a test red". The unambiguous case below reads the token
 * back under the BOOT slug after a real boot, so removing the
 * `reconcileCredentialScope` call from `gateway/index.ts` fails it. (Verified by
 * commenting the call out: this suite goes red, the auth unit suite stays
 * green — which is exactly why the boot-level test has to exist.)
 *
 * Both cases also assert boot NEVER refuses: `boot()` resolves, and the
 * ambiguous one leaves every row exactly where it was.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { ProjectDb, asOwnerHandle } from '@neutronai/persistence/index.ts'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { SecretsStore } from '@neutronai/auth/secrets-store.ts'
import { boot } from '../index.ts'
import type { GraphComposer } from '../boot-composition-types.ts'

const BOOT_SLUG = 'juno'
const STALE_SLUG = 'dev'

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
  home = mkdtempSync(join(tmpdir(), 'neutron-boot-cred-scope-'))
  dbPath = join(home, 'project.db')
  process.env['NEUTRON_HOME'] = home
  // `resolveOwnerSlugFromConfig` prefers `<ownerHome ?? neutronHome>/.url_slug`
  // over `NEUTRON_INSTANCE_SLUG`, so this pins the boot handle to 'juno'.
  writeFileSync(join(home, '.url_slug'), `${BOOT_SLUG}\n`, 'utf8')
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

/** Open the seeded DB directly (boot is not running yet / any more). */
function openDb(): ProjectDb {
  return ProjectDb.open(dbPath)
}

function seedStore(db: ProjectDb): SecretsStore {
  return new SecretsStore({ data_dir: home, db })
}

function systemEventNames(): string[] {
  const db = openDb()
  try {
    return db
      .all<{ event_name: string }, []>(
        'SELECT event_name FROM system_events ORDER BY ts ASC',
        [],
      )
      .map((r) => r.event_name)
  } finally {
    db.close()
  }
}

function systemEventPayloads(event: string): string[] {
  const db = openDb()
  try {
    return db
      .all<{ payload_json: string }, [string]>(
        'SELECT payload_json FROM system_events WHERE event_name = ?',
        [event],
      )
      .map((r) => r.payload_json)
  } finally {
    db.close()
  }
}

/** Acceptance (d): the serialized payload carries no secret material. */
function assertNoSecretMaterial(serialized: string, needles: readonly string[]): void {
  for (const needle of needles) expect(serialized).not.toContain(needle)
  for (const fragment of ['iv_b64', 'ct_b64', 'tag_b64']) {
    expect(serialized).not.toContain(fragment)
  }
}

test('(a3) UNAMBIGUOUS: a real boot migrates, the token reads back under the boot slug, and an audit row lands', async () => {
  const seedDb = openDb()
  let ciphertextBefore: string
  try {
    const store = seedStore(seedDb)
    await store.put({
      owner_handle: asOwnerHandle(STALE_SLUG),
      kind: 'byo_api_key',
      label: 'anthropic:prod',
      plaintext: 'ghp-orphaned-boot-token',
    })
    await seedDb.run(
      `INSERT INTO project_credentials
         (id, owner_slug, project_id, scope, service, ciphertext, label, created_at, updated_at, expires_at)
       VALUES ('pc1', ?, '', 'global', 'apify', ?, NULL, '2026-08-14T00:00:00Z', '2026-08-14T00:00:00Z', NULL)`,
      [STALE_SLUG, store.encryptPlaintext('apify-boot-token')],
    )
    ciphertextBefore = seedDb.get<{ ciphertext: string }, [string]>(
      'SELECT ciphertext FROM secrets WHERE project_slug = ?',
      [STALE_SLUG],
    )!.ciphertext
  } finally {
    seedDb.close()
  }

  // Boot MUST resolve — never refuse (a3).
  const handle = await boot({ port: 0 })
  try {
    const store = new SecretsStore({ data_dir: home, db: handle.db })
    // POSITIVE CONTROL: the lookup that returned null pre-boot now succeeds.
    expect(
      await store.get({
        owner_handle: asOwnerHandle(BOOT_SLUG),
        kind: 'byo_api_key',
        label: 'anthropic:prod',
      }),
    ).toBe('ghp-orphaned-boot-token')
    expect(
      await store.get({
        owner_handle: asOwnerHandle(STALE_SLUG),
        kind: 'byo_api_key',
        label: 'anthropic:prod',
      }),
    ).toBeNull()
    // Metadata move, not a re-encrypt.
    expect(
      handle.db.get<{ ciphertext: string }, [string]>(
        'SELECT ciphertext FROM secrets WHERE project_slug = ?',
        [BOOT_SLUG],
      )!.ciphertext,
    ).toBe(ciphertextBefore)
    // (c) the second shared-key table moved too.
    expect(
      handle.db.get<{ n: number }, [string]>(
        'SELECT count(*) AS n FROM project_credentials WHERE owner_slug = ?',
        [BOOT_SLUG],
      )!.n,
    ).toBe(1)
  } finally {
    // shutdown() drains the system_events sink, so the journal row is durable
    // by the time this resolves.
    await handle.shutdown({ force: true })
  }

  expect(systemEventNames()).toContain('credential_scope_migrated')
  const payloads = systemEventPayloads('credential_scope_migrated')
  expect(payloads).toHaveLength(1)
  // (d)
  assertNoSecretMaterial(payloads[0]!, [
    'ghp-orphaned-boot-token',
    'apify-boot-token',
    ciphertextBefore,
  ])
  expect(JSON.parse(payloads[0]!)).toEqual({
    from: [STALE_SLUG],
    tables: [
      { table: 'secrets', rows: 1 },
      { table: 'project_credentials', rows: 1 },
    ],
  })
})

test('(a3) AMBIGUOUS: a real boot changes nothing, the FRESH value survives, and an orphaned row lands', async () => {
  const seedDb = openDb()
  try {
    const store = seedStore(seedDb)
    await store.put({
      owner_handle: asOwnerHandle(STALE_SLUG),
      kind: 'chatgpt_oauth',
      label: 'codex',
      plaintext: 'stale-token',
    })
    await store.put({
      owner_handle: asOwnerHandle(BOOT_SLUG),
      kind: 'chatgpt_oauth',
      label: 'codex',
      plaintext: 'fresh-token',
    })
  } finally {
    seedDb.close()
  }

  const handle = await boot({ port: 0 })
  try {
    const store = new SecretsStore({ data_dir: home, db: handle.db })
    // The rotation hazard, asserted on the DECRYPTED value.
    expect(
      await store.get({
        owner_handle: asOwnerHandle(BOOT_SLUG),
        kind: 'chatgpt_oauth',
        label: 'codex',
      }),
    ).toBe('fresh-token')
    expect(
      await store.get({
        owner_handle: asOwnerHandle(STALE_SLUG),
        kind: 'chatgpt_oauth',
        label: 'codex',
      }),
    ).toBe('stale-token')
    expect(
      handle.db.get<{ n: number }, [string]>(
        'SELECT count(*) AS n FROM secrets WHERE project_slug = ?',
        [STALE_SLUG],
      )!.n,
    ).toBe(1)
  } finally {
    await handle.shutdown({ force: true })
  }

  const names = systemEventNames()
  expect(names).toContain('credential_scope_orphaned')
  expect(names).not.toContain('credential_scope_migrated')
  const payloads = systemEventPayloads('credential_scope_orphaned')
  expect(payloads).toHaveLength(1)
  assertNoSecretMaterial(payloads[0]!, ['stale-token', 'fresh-token'])
  // `reason` distinguishes the two ways this event happens, which needed
  // opposite operator responses and rendered identically before: AMBIGUOUS data
  // says "look at your credential rows"; a refused direction says "this process
  // has no configured handle". Asserted by exact equality, like the rest of this
  // payload — an audit row that grows a field silently is how one starts
  // carrying something it should not.
  expect(JSON.parse(payloads[0]!)).toEqual({
    from: [STALE_SLUG],
    orphan_counts: [{ table: 'secrets', handle: STALE_SLUG, rows: 1 }],
    reason: 'ambiguous_census',
  })
})

// ── THE FALLBACK BOOT, AT THE AUDIT BOUNDARY ──────────────────────────────
/**
 * A review round pointed out the reason field had no boundary coverage: only
 * `ambiguous_census` was ever asserted, so an inverted branch or a typo in
 * `fallback_boot_handle_refused_direction` stayed green while the operator got
 * the wrong instruction — and the wrong instruction here points at the one
 * action that must not be taken.
 *
 * So this boots for real with NO `.url_slug` and no instance slug set, which is
 * what an anonymous process actually is: `resolveOwnerSlugSourceFromConfig`
 * returns the documented fallback, and the rows below belong to somebody else.
 */
test('a real FALLBACK boot refuses, says why in the audit row, and leaves the rows alone', async () => {
  const LIVE = 'live-owner'
  // The log line and the journal payload compute `reason` INDEPENDENTLY, and
  // the as-built promises both. Asserting only the journal leaves the log free
  // to be deleted or mistyped with every test still green — and the log is what
  // an operator actually reads at 3am.
  const warned: string[] = []
  const realWarn = console.warn
  // The distinguishing act: no `.url_slug`, so nothing has told this process
  // who it is. (`beforeEach` wrote one; an anonymous boot is its absence.)
  rmSync(join(home, '.url_slug'), { force: true })
  delete process.env['NEUTRON_INSTANCE_SLUG']

  const seedDb = ProjectDb.open(dbPath)
  try {
    const store = new SecretsStore({ data_dir: home, db: seedDb })
    await store.put({
      owner_handle: asOwnerHandle(LIVE),
      kind: 'byo_api_key',
      label: 'anthropic:prod',
      plaintext: 'live-token',
    })
  } finally {
    seedDb.close()
  }

  // The mock goes on INSIDE the try that restores it. Installed before an
  // `await boot()` that sits outside one, a boot rejection leaks the global into
  // every later test in the file — which happened during review when listener
  // creation failed.
  try {
    console.warn = (...args: unknown[]): void => {
      warned.push(args.map(String).join(' '))
    }
    const handle = await boot({ port: 0 })
    try {
      // The rows are exactly where they were. Asserted on the VALUE, because a
      // migration that moved and re-encrypted would also leave one row here.
      const store = new SecretsStore({ data_dir: home, db: handle.db })
      expect(
        await store.get({
          owner_handle: asOwnerHandle(LIVE),
          kind: 'byo_api_key',
          label: 'anthropic:prod',
        }),
      ).toBe('live-token')
    } finally {
      // THE JOURNAL IS READ AFTER THIS, NOT BEFORE. The write is
      // fire-and-forget and microtask-scheduled (`persistence/system-events.ts`),
      // so only shutdown's drain makes it durable — reading earlier is a race
      // that passes on a fast machine and fails on a loaded one, which is the
      // worst kind of test.
      await handle.shutdown({ force: true })
    }

    const names = systemEventNames()
    expect(names).toContain('credential_scope_orphaned')
    expect(names).not.toContain('credential_scope_migrated')

    // THE POINT: the reason, by exact equality on the whole payload. A generic
    // orphan row would send the reader to the migration that just refused.
    const payloads = systemEventPayloads('credential_scope_orphaned')
    expect(payloads).toHaveLength(1)
    assertNoSecretMaterial(payloads[0]!, ['live-token'])
    expect(JSON.parse(payloads[0]!)).toEqual({
      from: [LIVE],
      orphan_counts: [{ table: 'secrets', handle: LIVE, rows: 1 }],
      reason: 'fallback_boot_handle_refused_direction',
    })

    // AND the operator-facing line carries it too.
    const orphanLines = warned.filter((l) => l.includes('credential_scope_orphaned'))
    expect(orphanLines.length).toBeGreaterThan(0)
    expect(orphanLines.join('\n')).toContain('fallback_boot_handle_refused_direction')
  } finally {
    console.warn = realWarn
  }
})

// ── THE BOOT → COMPOSER HANDOFF ───────────────────────────────────────────
/**
 * A review round found the last hole in this chain: `GraphComposer`'s
 * `slug_is_fallback` is OPTIONAL, so deleting the property at the boot handoff
 * still typechecks — and every configured production boot then reaches the
 * composer with `undefined`, which normalises to fallback and silently refuses
 * to migrate. The provenance test one layer down cannot see it, because it calls
 * the composer with literal booleans rather than being handed them by boot.
 *
 * The failure is invisible by construction: the wrong answer and the safe
 * default are the same value. So the only thing that can catch it is a REAL boot
 * with a composer that records what it was actually given.
 */
async function bootCapturingProvenance(): Promise<boolean | undefined> {
  let seen: boolean | undefined
  const handle = await boot({
    port: 0,
    composer: (({ db, slug_is_fallback }: { db: ProjectDb; slug_is_fallback?: boolean }) => {
      seen = slug_is_fallback
      // Deliberately the narrowest object boot will accept, and cast rather
      // than filled out: this test is about WHAT BOOT HANDS THE COMPOSER, and
      // fabricating a whole composition to satisfy the type would add a large
      // fixture whose every field is irrelevant to the one assertion.
      //
      // Hand BACK the db boot gave us rather than opening another: `shutdown`
      // closes only boot's own connection, so a second one leaks per test.
      return { db, project_slug: BOOT_SLUG }
    }) as unknown as GraphComposer,
  })
  await handle.shutdown({ force: true })
  return seen
}

test('a CONFIGURED boot hands the composer a configured provenance', async () => {
  // `beforeEach` wrote `.url_slug`, so this boot knows who it is.
  expect(await bootCapturingProvenance()).toBe(false)
})

test('a FALLBACK boot hands the composer a fallback provenance', async () => {
  rmSync(join(home, '.url_slug'), { force: true })
  delete process.env['NEUTRON_INSTANCE_SLUG']
  expect(await bootCapturingProvenance()).toBe(true)
})

test('an EMPTY instance slug is anonymous, not configured', async () => {
  // Review repro: `NEUTRON_INSTANCE_SLUG=''` classified as `source:'env'`, so the
  // guard read `false` and the explicit migration moved rows onto the empty
  // handle. An empty variable is not an identity.
  rmSync(join(home, '.url_slug'), { force: true })
  process.env['NEUTRON_INSTANCE_SLUG'] = '   '
  try {
    expect(await bootCapturingProvenance()).toBe(true)
  } finally {
    delete process.env['NEUTRON_INSTANCE_SLUG']
  }
})
