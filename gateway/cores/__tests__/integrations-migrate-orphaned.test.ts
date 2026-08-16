/**
 * T3 — THE EXPLICIT MIGRATE ACTION, COLLISION-GUARDED (card 2026-08-14).
 *
 * Boot auto-migrates only the UNAMBIGUOUS case (T1); T2 made the ambiguous
 * leftovers legible as `orphaned` instead of "not connected". This is the way
 * OUT of them — and it must not become the data-loss bug the ambiguous branch
 * exists to prevent. Quoting the card: "if a stale `dev` row and a freshly-
 * connected `juno` row both exist for the same service, rewriting the stale one
 * overwrites the new one." An EXPLICIT request does not make that acceptable,
 * so every orphaned row whose UNIQUE slot is FREE under the boot handle moves
 * and every row that would collide is SKIPPED and reported.
 *
 * THE CARD'S FAKE-TEST GUARDS, both of them:
 *   - T3.1 asserts on the DECRYPTED VALUE of the colliding slot, not on a row
 *     count: a migration that clobbered the fresh credential would still leave
 *     exactly one row under the boot handle, so counting proves nothing.
 *   - T3.1 also reads the NON-colliding secret back decrypted under the boot
 *     handle. Stub the move to a noop and that assertion goes red — the
 *     delete-the-migration mutation guard.
 *
 * Plus acceptance (c) — all three swept tables move — and (d): no plaintext or
 * ciphertext in the result, the message, or the audit row (T3.2).
 */

import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import {
  ProjectDb,
  asOwnerHandle,
  type OwnerHandle,
  type SystemEventInput,
  type SystemEventSink,
} from '@neutronai/persistence/index.ts'
import { SecretsStore } from '@neutronai/auth/secrets-store.ts'
import { ToolRegistry } from '@neutronai/tools/registry.ts'
import type { ToolCallContext, ToolRegistration } from '@neutronai/tools/registry.ts'
import { installBundledCores } from '../install-bundled.ts'
import { OAuthTokenManager, GOOGLE_REVOKE_URL } from '../oauth-token-manager.ts'
import { buildIntegrationsTools } from '../integrations-tools.ts'
import {
  buildIntegrationsStatus,
  migrateOrphanedCredentials,
  MIGRATE_ORPHANED_ACTION,
  type MigrateOrphanedCredentialsResult,
} from '../integrations.ts'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..')
/** The handle this process "boots" as. */
const BOOT = asOwnerHandle('juno-test')
/** The pre-provisioning handle the stale rows were frozen under. */
const STALE = asOwnerHandle('dev-old')

/** The FRESH credential occupying the `tavily` slot under BOOT — must survive. */
const FRESH = 'tvly-FRESH-must-survive'
/** The STALE twin of that slot — must NOT overwrite FRESH. */
const STALE_VAL = 'tvly-STALE-must-not-win'
/** A stale-only secret with a free slot — must move and read back. */
const OTHER = 'other-key-plaintext-must-move'
/** Filler for the `project_credentials` ciphertext column; never decrypted. */
const CREDENTIAL_CIPHERTEXT = 'Y2lwaGVydGV4dC1maWxsZXItZG8tbm90LWxlYWs='

const CTX: ToolCallContext = {
  project_slug: BOOT,
  project_id: null,
  topic_id: null,
  call_id: 'call-1',
  speaker_user_id: null,
}

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function makeBench() {
  const home = mkdtempSync(join(tmpdir(), 'neutron-integrations-migrate-'))
  cleanups.push(() => rmSync(home, { recursive: true, force: true }))
  const dbDir = join(home, 'db')
  mkdirSync(dbDir, { recursive: true })
  const dbPath = join(dbDir, 'owner.db')
  const raw = new Database(dbPath, { create: true })
  applyMigrations(raw)
  raw.close()
  const db = ProjectDb.open(dbPath)
  cleanups.push(() => db.close())
  const secrets = new SecretsStore({ data_dir: home, db })
  const tools = new ToolRegistry()
  const cores = await installBundledCores({
    project_slug: BOOT,
    projectDb: db,
    dataDir: home,
    tools,
    secretsStore: secrets,
    rootDirs: [REPO_ROOT],
  })
  const fakeFetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url.startsWith(GOOGLE_REVOKE_URL)) return new Response('{}', { status: 200 })
    return new Response('not found', { status: 404 })
  }) as (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  const tokens = new OAuthTokenManager({
    secretsStore: secrets,
    owner_handle: BOOT,
    client_id: 'cid',
    client_secret: 'csecret',
    fetch: fakeFetch,
  })
  return { home, db, secrets, tokens, registry: cores.registry }
}

/**
 * Seed a `byo_api_key` secret under `owner`. The SecretsStore keys on the
 * handle, so this is exactly how a row ends up frozen under a stale one.
 */
async function seedSecret(
  secrets: SecretsStore,
  owner: OwnerHandle,
  label: string,
  plaintext: string,
): Promise<void> {
  await secrets.put({ owner_handle: owner, kind: 'byo_api_key', label, plaintext })
}

/** Raw `project_credentials` insert (its store lives in another package). */
async function seedProjectCredential(db: ProjectDb, owner_slug: string): Promise<void> {
  await db.run(
    `INSERT INTO project_credentials
       (id, owner_slug, project_id, scope, service, ciphertext, label, created_at, updated_at, expires_at)
     VALUES (?, ?, '', 'global', 'codex', ?, NULL, '2026-08-14T00:00:00Z', '2026-08-14T00:00:00Z', NULL)`,
    [`${owner_slug}-codex`, owner_slug, CREDENTIAL_CIPHERTEXT],
  )
}

/** Raw `api_keys` metadata insert — the BYO read path keys off ITS project_slug. */
async function seedApiKeyRow(db: ProjectDb, project_slug: string): Promise<void> {
  await db.run(
    `INSERT INTO api_keys (id, project_slug, provider, label, secret_id, added_at, last_used_at)
     VALUES (?, ?, 'openai', 'onboarding', ?, 1755100000000, NULL)`,
    [`${project_slug}-openai`, project_slug, `${project_slug}-secret-id`],
  )
}

/** The stored ciphertext of one `secrets` row, addressed by (handle, label). */
function ciphertextOf(db: ProjectDb, handle: string, label: string): string | null {
  const row = db.get<{ ciphertext: string }, [string, string]>(
    "SELECT ciphertext FROM secrets WHERE project_slug = ? AND kind = 'byo_api_key' AND label = ?",
    [handle, label],
  )
  return row === null ? null : row.ciphertext
}

/** Rows in any swept table under one handle — the tables `countSecrets` cannot see. */
function countRows(db: ProjectDb, table: string, column: string, handle: string): number {
  const row = db.get<{ n: number }, [string]>(
    `SELECT count(*) AS n FROM ${table} WHERE ${column} = ?`,
    [handle],
  )
  return row === null ? 0 : row.n
}

function countSecrets(db: ProjectDb, handle: string, label: string): number {
  const row = db.get<{ n: number }, [string, string]>(
    'SELECT count(*) AS n FROM secrets WHERE project_slug = ? AND label = ?',
    [handle, label],
  )
  return row === null ? 0 : row.n
}

function byName(tools: ToolRegistration[], name: string): ToolRegistration {
  const t = tools.find((x) => x.name === name)
  if (t === undefined) throw new Error(`tool ${name} not built`)
  return t
}

/** Fake sink capturing every journaled event (see `SystemEventSink`). */
function fakeSink(): { sink: SystemEventSink; captured: SystemEventInput[] } {
  const captured: SystemEventInput[] = []
  return {
    captured,
    sink: {
      record: (e: SystemEventInput) => {
        captured.push(e)
        return { id: 'x' }
      },
    },
  }
}

/**
 * The T3.1 fixture: one COLLIDING slot (`tavily` under both handles) plus three
 * stale-only rows with free slots, one in each swept table.
 */
async function seedAmbiguous(b: { db: ProjectDb; secrets: SecretsStore }): Promise<void> {
  await seedSecret(b.secrets, BOOT, 'tavily', FRESH)
  await seedSecret(b.secrets, STALE, 'tavily', STALE_VAL)
  await seedSecret(b.secrets, STALE, 'other_key', OTHER)
  await seedProjectCredential(b.db, STALE)
  await seedApiKeyRow(b.db, STALE)
}

// ── T3.1 THE ROTATION HAZARD, ASSERTED ON THE VALUE ───────────────────────
test('the explicit migrate moves free slots across all three tables and never clobbers a fresh credential', async () => {
  const b = await makeBench()
  await seedAmbiguous(b)

  // Pinned BEFORE the move: a re-scope is a metadata move, so these bytes must
  // come out identical (the crypto binds no AAD — nothing is re-encrypted).
  const otherCiphertextBefore = ciphertextOf(b.db, STALE, 'other_key')
  expect(otherCiphertextBefore).not.toBeNull()

  const result = await migrateOrphanedCredentials({ db: b.db, project_slug: BOOT, slug_is_fallback: false })

  // (i) THE POINT: the FRESH value still occupies the slot. A clobbering
  // migration would also leave exactly one row here — only the decrypted value
  // tells the two apart.
  expect(
    await b.secrets.get({ owner_handle: BOOT, kind: 'byo_api_key', label: 'tavily' }),
  ).toBe(FRESH)

  // (ii) …and the colliding stale row is still sitting under STALE, untouched,
  // for the owner to reconnect or disconnect deliberately.
  expect(countSecrets(b.db, STALE, 'tavily')).toBe(1)

  // (iii) THE MUTATION GUARD: the non-colliding stale secret is now readable
  // under the BOOT handle and decrypts to its original plaintext. Stub the move
  // to a noop and this line goes red.
  expect(
    await b.secrets.get({ owner_handle: BOOT, kind: 'byo_api_key', label: 'other_key' }),
  ).toBe(OTHER)

  // (iv) acceptance (c): EVERY swept table moves, not just `secrets`.
  expect(
    b.db.get<{ owner_slug: string }, []>(
      "SELECT owner_slug FROM project_credentials WHERE service = 'codex'",
      [],
    )?.owner_slug,
  ).toBe(BOOT)
  expect(
    b.db.get<{ project_slug: string }, []>(
      "SELECT project_slug FROM api_keys WHERE provider = 'openai' AND label = 'onboarding'",
      [],
    )?.project_slug,
  ).toBe(BOOT)

  // (v) the skip is REPORTED, not silent — and the three free slots all moved.
  expect(result.skipped).toEqual([{ table: 'secrets', handle: STALE, rows: 1 }])
  expect(result.total_skipped).toBe(1)
  expect(result.total_moved).toBe(3)
  expect(result.moved).toContainEqual({ table: 'secrets', rows: 1 })
  expect(result.moved).toContainEqual({ table: 'project_credentials', rows: 1 })
  expect(result.moved).toContainEqual({ table: 'api_keys', rows: 1 })
  expect(result.stale_handles).toEqual([STALE])
  expect(result.message).toContain('Skipped 1 row(s)')

  // (vi) metadata move, not a re-encrypt: byte-identical ciphertext.
  expect(ciphertextOf(b.db, BOOT, 'other_key')).toBe(otherCiphertextBefore)
})

// ── T3.2 AUDIT ROW + NO SECRET MATERIAL (acceptance (d)) ──────────────────
test('the migration journals credential_scope_migrated with counts only — no secret material anywhere', async () => {
  const b = await makeBench()
  await seedAmbiguous(b)
  const { sink, captured } = fakeSink()

  const result = await migrateOrphanedCredentials({ db: b.db, project_slug: BOOT, slug_is_fallback: false, sink })

  expect(captured).toHaveLength(1)
  const event = captured[0]!
  expect(event.event).toBe('credential_scope_migrated')
  expect(event.project_slug).toBe(BOOT)
  expect(event.payload).toEqual({
    from: [STALE],
    tables: result.moved,
    skipped: result.skipped,
  })

  const journaled = JSON.stringify(event)
  const returned = JSON.stringify(result)
  for (const secret of [FRESH, STALE_VAL, OTHER, CREDENTIAL_CIPHERTEXT]) {
    expect(journaled).not.toContain(secret)
    expect(returned).not.toContain(secret)
  }
  // …and no envelope fragment either (the ciphertext column is never SELECTed).
  expect(journaled).not.toContain('iv_b64')
  expect(returned).not.toContain('iv_b64')
})

// ── T3.3 NOOP WHEN THERE IS NOTHING TO MOVE ───────────────────────────────
test('with every row already on the boot handle the migration moves nothing and journals nothing', async () => {
  const b = await makeBench()
  await seedSecret(b.secrets, BOOT, 'tavily', FRESH)
  await seedProjectCredential(b.db, BOOT)
  await seedApiKeyRow(b.db, BOOT)
  const { sink, captured } = fakeSink()

  const result = await migrateOrphanedCredentials({ db: b.db, project_slug: BOOT, slug_is_fallback: false, sink })

  expect(result.total_moved).toBe(0)
  expect(result.moved).toEqual([])
  expect(result.skipped).toEqual([])
  expect(result.stale_handles).toEqual([])
  expect(result.message).toBe('No credential rows are scoped to a previous owner handle.')
  expect(captured).toHaveLength(0)
  // Nothing was disturbed.
  expect(
    await b.secrets.get({ owner_handle: BOOT, kind: 'byo_api_key', label: 'tavily' }),
  ).toBe(FRESH)
})

// ── T3.4 THE TOOL SURFACE IS THE ACTION THE STATUS NAMES ──────────────────
test('integrations_migrate_orphaned is registered under the advertised name and really migrates', async () => {
  const b = await makeBench()
  await seedSecret(b.secrets, STALE, 'other_key', OTHER)

  const built = buildIntegrationsTools({
    registry: b.registry,
    tokens: b.tokens,
    secretsStore: b.secrets,
    project_slug: BOOT,
    slug_is_fallback: false,
    db: b.db,
    startOAuth: async (labels: string[]) => ({
      ok: true as const,
      authorize_url: `https://accounts.google.com/o/oauth2/v2/auth?labels=${labels.join(',')}`,
      state: 'st-1',
      expires_at: 0,
    }),
  })
  const tool = byName(built, MIGRATE_ORPHANED_ACTION)
  // A write the owner must consent to — never `auto`.
  expect(tool.approval_policy).toBe('prompt-user')
  expect(tool.capability_required).toBe('write:project_data')

  const out = (await tool.handler({}, CTX)) as MigrateOrphanedCredentialsResult
  expect(out.ok).toBe(true)
  expect(out.total_moved).toBe(1)
  expect(
    await b.secrets.get({ owner_handle: BOOT, kind: 'byo_api_key', label: 'other_key' }),
  ).toBe(OTHER)
})

// ── T3.5 THE STATUS SURFACE CLOSES THE LOOP ───────────────────────────────
test('after migrating, the status reports ONLY the skipped colliding row as orphaned', async () => {
  const b = await makeBench()
  await seedAmbiguous(b)
  await migrateOrphanedCredentials({ db: b.db, project_slug: BOOT, slug_is_fallback: false })

  const status = await buildIntegrationsStatus({
    registry: b.registry,
    tokens: b.tokens,
    secretsStore: b.secrets,
    project_slug: BOOT,
    slug_is_fallback: false,
    db: b.db,
  })

  const summary = status.orphaned_credentials
  expect(summary).not.toBeNull()
  expect(summary!.total_rows).toBe(1)
  expect(summary!.tables).toEqual([{ table: 'secrets', handle: STALE, rows: 1 }])
  // The slot the fresh credential won reads plainly connected, not orphaned.
  const tavily = status.api_keys.find((k) => k.label === 'tavily')
  expect(tavily?.connected).toBe(true)
  expect(tavily?.orphaned).toBe(false)
})

// ── THE DIRECTION GUARD ON THE EXPLICIT SURFACE ───────────────────────────
/**
 * A review found the guard was real and bypassable in one step: the boot path
 * refused an anonymous fallback, the explicit migration took only a handle and
 * moved the rows anyway. The repro was one seeded row and one dispatch.
 *
 * Asserted THROUGH THE SHARED BRAIN, not by calling a tool handler. Every
 * surface — the tool, the HTTP route — funnels here, so this is the boundary
 * where the refusal has to hold; a test that reaches past it into the handler
 * proves nothing about what a caller actually gets, which is exactly how the
 * gap survived its original test suite.
 */
test('a fallback boot handle cannot claim rows through the explicit migrate either', async () => {
  const b = await makeBench()
  // UNAMBIGUOUS on purpose: one stale handle, nothing under the boot handle.
  // This is the census the reconciler is happiest about, and it is precisely
  // the dangerous one — all the rows belong to someone else and none belong to
  // the process asking.
  await seedSecret(b.secrets, STALE, 'tavily', STALE_VAL)
  await seedProjectCredential(b.db, STALE)
  await seedApiKeyRow(b.db, STALE)

  const refused = await migrateOrphanedCredentials({
    db: b.db,
    project_slug: BOOT,
    slug_is_fallback: true,
  })

  expect(refused.total_moved).toBe(0)
  // STRUCTURAL, NOT PROSE. This assertion used to read
  // `expect(refused.message).toContain('Refused')`, and it was the only thing
  // standing between the direction guard and a silent regression: a refusal
  // returned `{ok:true, total_moved:0}`, byte-identical to a collision skip and
  // to a clean no-op, so editing one English sentence in
  // `gateway/cores/integrations.ts` disarmed every guard assertion at once while
  // leaving the guard itself untested. The refusal is data now.
  expect(refused.refused_direction).toBe(true)
  // The rows are untouched where they belong, and the anonymous handle still
  // owns nothing. Counting only the boot handle would pass against a migration
  // that DELETED them, so both sides are asserted.
  expect(countSecrets(b.db, STALE, 'tavily')).toBe(1)
  expect(countSecrets(b.db, BOOT, 'tavily')).toBe(0)
  expect(await b.secrets.get({ owner_handle: STALE, kind: 'byo_api_key', label: 'tavily' })).toBe(
    STALE_VAL,
  )

  // ALL THREE SWEPT TABLES, not just `secrets`. The fixture seeds three because
  // the guard's claim is about every surface and every table; verifying one and
  // trusting the implementation's own aggregate for the rest would let a guard
  // that covers `secrets` alone pass as if it covered everything — the aggregate
  // is the thing under test, so it cannot also be the evidence.
  expect(countRows(b.db, 'project_credentials', 'owner_slug', STALE)).toBe(1)
  expect(countRows(b.db, 'project_credentials', 'owner_slug', BOOT)).toBe(0)
  expect(countRows(b.db, 'api_keys', 'project_slug', STALE)).toBe(1)
  expect(countRows(b.db, 'api_keys', 'project_slug', BOOT)).toBe(0)

  // And the refusal reports every orphan as skipped rather than quietly
  // shortening the list.
  expect(refused.total_skipped).toBe(3)
  expect([...refused.skipped].map((s) => s.table).sort()).toEqual([
    'api_keys',
    'project_credentials',
    'secrets',
  ])

  // POSITIVE CONTROL — the same fixture, the same call, provenance the only
  // difference. Without it this test passes just as well against a migration
  // that never had anything to move.
  const allowed = await migrateOrphanedCredentials({
    db: b.db,
    project_slug: BOOT,
    slug_is_fallback: false,
  })
  expect(allowed.total_moved).toBeGreaterThan(0)
  expect(countSecrets(b.db, BOOT, 'tavily')).toBe(1)
  // …and the marker is ABSENT on the allowed path, so `refused_direction` is a
  // discriminator rather than a constant that happens to read true.
  expect(allowed.refused_direction).toBeUndefined()
  expect('refused_direction' in allowed).toBe(false)
})

/**
 * A REFUSAL LEAVES AN AUDIT ROW. IT WAS THE ONE EVENT WITH NO RECORD.
 *
 * `migrateOrphanedCredentials` journals only when `total_moved > 0`, and a
 * refusal moves nothing — so a security-relevant refusal reachable from HTTP and
 * from an agent tool wrote nothing at all, while the AUTOMATIC path journals the
 * same situation with a reason (`gateway/index.ts` — `credential_scope_orphaned`
 * with `reason: 'fallback_boot_handle_refused_direction'`, pinned by exact
 * equality in `gateway/__tests__/boot-credential-scope.test.ts`).
 *
 * Same event and same reason as boot so one journal query finds both; `surface`
 * says which one refused.
 */
test('a refused explicit migration journals credential_scope_orphaned with the reason and no secret material', async () => {
  const b = await makeBench()
  await seedSecret(b.secrets, STALE, 'tavily', STALE_VAL)
  await seedProjectCredential(b.db, STALE)
  await seedApiKeyRow(b.db, STALE)
  const { sink, captured } = fakeSink()

  const refused = await migrateOrphanedCredentials({
    db: b.db,
    project_slug: BOOT,
    slug_is_fallback: true,
    sink,
  })
  expect(refused.refused_direction).toBe(true)

  // EXACT equality on the whole payload, matching the boot test's discipline: a
  // `toContain`-style check would let a future edit smuggle a credential VALUE
  // into the audit row unnoticed.
  //
  // SCOPE + SHAPE ARE BOOT'S (Argus r1 on PR #322, 2026-08-16 — INVARIANTS
  // #116(b)). This fixture records no owner identity (no ledger row, no
  // `onboarding_state` row), so the planner lands on its documented FLOOR: the
  // attempting handle, `BOOT`. That is the same value the old unconditional
  // write used, which is exactly why the defect was invisible here — the test
  // below that seeds a ledger is the one that can tell the two apart. The
  // PAYLOAD changed regardless: every foreign handle is now a COUNT, because a
  // frozen handle's NAME in an instance-scoped feed is the cross-scope
  // disclosure the strict predicate exists to prevent. The owner is told the
  // volume; the live integrations surface, already scoped to him, names them.
  expect(captured).toHaveLength(1)
  const event = captured[0]!
  expect(event.event).toBe('credential_scope_orphaned')
  expect(event.level).toBe('warn')
  expect(event.module).toBe('gateway')
  expect(event.project_slug).toBe(BOOT)
  expect(event.payload).toEqual({
    refused_direction: true,
    orphaned_handles: 1,
    orphaned_rows: refused.skipped.reduce((sum, s) => sum + s.rows, 0),
    orphaned_tables: [...new Set(refused.skipped.map((s) => s.table))].sort(),
    attempted_by_slug: BOOT,
    reason: 'fallback_boot_handle_refused_direction',
    surface: 'explicit_migrate',
  })
  // And the frozen handle's NAME is nowhere in the row.
  expect(JSON.stringify(event.payload)).not.toContain(STALE)

  const journaled = JSON.stringify(event)
  for (const secret of [FRESH, STALE_VAL, OTHER, CREDENTIAL_CIPHERTEXT]) {
    expect(journaled).not.toContain(secret)
  }
  expect(journaled).not.toContain('iv_b64')
  // The CONTROL for this row — the same fixture with provenance the only
  // difference journals `credential_scope_migrated` instead — lives in the test
  // immediately below, which needs the same two calls anyway.
})

/**
 * THE BLOCKER (Argus r1 on PR #322, 2026-08-16 — INVARIANTS #116(b)).
 *
 * This surface refuses ONLY when the handle it was called with is the anonymous
 * FALLBACK — that is the guard's entire condition. So writing the audit row
 * under `input.project_slug` put the record of a security-relevant refusal under
 * the one handle no owner ever opens a diagnostics page under: the same
 * invisibility the boot half of this card exists to remove, on the surface
 * (b) already claimed to cover ("on ANY surface"). It is not exempt for being
 * owner-initiated — an anonymous process has no owner to have asked it.
 *
 * The fixture above cannot see the difference, because a database with no
 * recorded identity lands on the FLOOR, which IS the attempting handle. This one
 * records an identity, so the two answers diverge and the assertion has teeth.
 */
test('the explicit refusal is journalled where the OWNER reads, not under the fallback that asked', async () => {
  const b = await makeBench()
  await seedSecret(b.secrets, STALE, 'tavily', STALE_VAL)
  const { sink, captured } = fakeSink()

  // This database records who it belongs to — the handle the owner's gateway
  // boots as and therefore the only one his diagnostics feed queries.
  const LIVE = 'juno-live'
  await b.db.run(
    `INSERT INTO instance_scope_ledger (id, project_slug, updated_at) VALUES (1, ?, 1)`,
    [LIVE],
  )

  const refused = await migrateOrphanedCredentials({
    db: b.db,
    project_slug: BOOT,
    slug_is_fallback: true,
    sink,
  })
  expect(refused.refused_direction).toBe(true)

  expect(captured).toHaveLength(1)
  expect(captured[0]!.project_slug).toBe(LIVE)
  // The attempting handle is not lost — it rides in the payload, which is where
  // it is information rather than an unreadable address.
  expect(captured[0]!.payload!['attempted_by_slug']).toBe(BOOT)

  // CONTROL — the same call with provenance the ONLY difference migrates and
  // journals under the boot handle, so the scope above is caused by the refusal
  // path and not by this surface having become ledger-scoped for everything.
  const { sink: sink2, captured: captured2 } = fakeSink()
  const allowed = await migrateOrphanedCredentials({
    db: b.db,
    project_slug: BOOT,
    slug_is_fallback: false,
    sink: sink2,
  })
  expect(allowed.total_moved).toBeGreaterThan(0)
  expect(captured2).toHaveLength(1)
  expect(captured2[0]!.event).toBe('credential_scope_migrated')
  expect(captured2[0]!.project_slug).toBe(BOOT)
  expect(captured2.map((e) => e.event)).toEqual(['credential_scope_migrated'])
})

/**
 * NOTHING TO MOVE IS NOT A REFUSAL, EVEN FROM AN ANONYMOUS PROCESS.
 *
 * The guard returns early on an empty census before it is ever consulted
 * (`auth/credential-scope-reconcile.ts:510-512`), so a fallback boot on a clean
 * box must answer the ordinary no-op sentence and journal nothing. Without this,
 * a "fix" that set `refused_direction` from `slug_is_fallback` alone would pass
 * every other assertion in this file.
 */
test('a fallback boot with nothing orphaned is a plain no-op, not a refusal', async () => {
  const b = await makeBench()
  await seedSecret(b.secrets, BOOT, 'tavily', FRESH)
  const { sink, captured } = fakeSink()

  const result = await migrateOrphanedCredentials({
    db: b.db,
    project_slug: BOOT,
    slug_is_fallback: true,
    sink,
  })

  expect(result.refused_direction).toBeUndefined()
  expect(result.total_moved).toBe(0)
  expect(result.stale_handles).toEqual([])
  expect(result.message).toBe('No credential rows are scoped to a previous owner handle.')
  expect(captured).toHaveLength(0)
})
