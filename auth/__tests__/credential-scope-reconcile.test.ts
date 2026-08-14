/**
 * Credential-scope reconciler — acceptance (a), (a2), (c) and (d) of the
 * 2026-08-14 card "Credentials orphaned by a changed owner handle".
 *
 * The card names two FAKE TESTS to guard against, and both guards live here:
 *   1. "A test that only asserts null-on-miss passes with the bug present." —
 *      every case carries a POSITIVE CONTROL: the same lookup SUCCEEDS under
 *      the correct handle.
 *   2. "An ambiguous-case test that seeds rows under two handles but never
 *      checks WHICH value survived." — the ambiguous case asserts the
 *      DECRYPTED VALUES ('fresh-token' vs 'stale-token'), not row counts.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { ProjectDb, asOwnerHandle } from '@neutronai/persistence/index.ts'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { SecretsStore, SHARED_KEY_ENCRYPTED_TABLES } from '../secrets-store.ts'
import {
  CREDENTIAL_SCOPE_COLUMNS,
  CREDENTIAL_SCOPE_COMPANION_TABLES,
  credentialScopeSweepColumns,
  reconcileCredentialScope,
} from '../credential-scope-reconcile.ts'

let workdir: string
let dataDir: string
let db: ProjectDb

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'neutron-cred-scope-'))
  dataDir = join(workdir, 'project')
  mkdirSync(dataDir, { recursive: true })
  const dbPath = join(workdir, 'project.db')
  const raw = new Database(dbPath, { create: true })
  applyMigrations(raw)
  raw.close()
  db = ProjectDb.open(dbPath)
})

afterEach(() => {
  db.close()
  rmSync(workdir, { recursive: true, force: true })
})

function buildStore(): SecretsStore {
  return new SecretsStore({ data_dir: dataDir, db, now: () => 1_700_000_000_000 })
}

/** The ciphertext of one secret row, keyed the way the store keys it. */
function ciphertextOf(handle: string, kind: string, label: string): string | null {
  const row = db.get<{ ciphertext: string }, [string, string, string]>(
    'SELECT ciphertext FROM secrets WHERE project_slug = ? AND kind = ? AND label = ?',
    [handle, kind, label],
  )
  return row === null ? null : row.ciphertext
}

/** Seed a `project_credentials` row directly (its store lives in another package). */
async function seedProjectCredential(
  owner_slug: string,
  service: string,
  ciphertext: string,
): Promise<void> {
  await db.run(
    `INSERT INTO project_credentials
       (id, owner_slug, project_id, scope, service, ciphertext, label, created_at, updated_at, expires_at)
     VALUES (?, ?, '', 'global', ?, ?, NULL, '2026-08-14T00:00:00Z', '2026-08-14T00:00:00Z', NULL)`,
    [`${owner_slug}-${service}`, owner_slug, service, ciphertext],
  )
}

/** Seed the `api_keys` metadata companion row. */
async function seedApiKey(
  project_slug: string,
  provider: string,
  label: string,
  secret_id: string,
): Promise<void> {
  await db.run(
    `INSERT INTO api_keys (id, project_slug, provider, label, secret_id, added_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, 1, NULL)`,
    [`${project_slug}-${provider}-${label}`, project_slug, provider, label, secret_id],
  )
}

function countRows(table: string, column: string, handle: string): number {
  const row = db.get<{ n: number }, [string]>(
    `SELECT count(*) AS n FROM ${table} WHERE ${column} = ?`,
    [handle],
  )
  return row === null ? 0 : row.n
}

// ── acceptance (d) helper ─────────────────────────────────────────────────
/**
 * Assert a serialized payload leaks no secret material. Returns the list of
 * offending needles so the POSITIVE CONTROL below can prove the helper can
 * actually fail (a leak-assertion that cannot fail is the third fake test).
 */
function secretLeaks(payload: unknown, needles: readonly string[]): string[] {
  const serialized = JSON.stringify(payload) ?? ''
  const found: string[] = []
  for (const needle of needles) {
    if (needle.length > 0 && serialized.includes(needle)) found.push(needle)
  }
  for (const fragment of ['iv_b64', 'ct_b64', 'tag_b64']) {
    if (serialized.includes(fragment)) found.push(fragment)
  }
  return found
}

// ── (c) — structural coverage of every shared-key credential table ─────────

test('(c) every SHARED_KEY_ENCRYPTED_TABLES member has a scope column, and api_keys rides along', () => {
  // The compile-time half is the `Record<(typeof SHARED_KEY_ENCRYPTED_TABLES)[number], string>`
  // type in the module: a new table without a scope column does not typecheck.
  // This is the runtime half — it catches a member whose entry was added as an
  // empty string, which the type would accept.
  for (const table of SHARED_KEY_ENCRYPTED_TABLES) {
    const column = CREDENTIAL_SCOPE_COLUMNS[table]
    expect(typeof column).toBe('string')
    expect(column.length).toBeGreaterThan(0)
  }
  const swept = credentialScopeSweepColumns().map((c) => c.table)
  for (const table of SHARED_KEY_ENCRYPTED_TABLES) expect(swept).toContain(table)
  for (const c of CREDENTIAL_SCOPE_COMPANION_TABLES) expect(swept).toContain(c.table)
  expect(swept).toContain('api_keys')
})

// ── (a) — the UNAMBIGUOUS case ────────────────────────────────────────────

test('(a) a DB seeded entirely under an old handle migrates onto the boot handle, ciphertext byte-identical', async () => {
  const store = buildStore()
  const { id: secretId } = await store.put({
    owner_handle: asOwnerHandle('dev'),
    kind: 'byo_api_key',
    label: 'anthropic:prod',
    plaintext: 'ghp-orphaned-github-token',
  })
  await seedProjectCredential('dev', 'apify', store.encryptPlaintext('apify-token'))
  await seedApiKey('dev', 'anthropic', 'prod', secretId)

  // Pre-move ciphertext bytes, read straight off the column.
  const before = ciphertextOf('dev', 'byo_api_key', 'anthropic:prod')
  expect(before).not.toBeNull()

  // Baseline: the boot handle can see nothing (this alone is the FAKE test the
  // card warns about — the positive control below is what makes it real).
  expect(
    await store.get({
      owner_handle: asOwnerHandle('juno'),
      kind: 'byo_api_key',
      label: 'anthropic:prod',
    }),
  ).toBeNull()

  const result = await reconcileCredentialScope(db, 'juno')
  expect(result.action).toBe('migrated')
  if (result.action !== 'migrated') throw new Error('unreachable')
  expect(result.stale_handles).toEqual(['dev'])
  expect(result.boot_handle).toBe('juno')

  // POSITIVE CONTROL: the same lookup now SUCCEEDS under the boot handle.
  expect(
    await store.get({
      owner_handle: asOwnerHandle('juno'),
      kind: 'byo_api_key',
      label: 'anthropic:prod',
    }),
  ).toBe('ghp-orphaned-github-token')
  // …and returns null under the old one.
  expect(
    await store.get({
      owner_handle: asOwnerHandle('dev'),
      kind: 'byo_api_key',
      label: 'anthropic:prod',
    }),
  ).toBeNull()

  // METADATA MOVE, NEVER A RE-ENCRYPT: the ciphertext column is byte-identical.
  const after = ciphertextOf('juno', 'byo_api_key', 'anthropic:prod')
  expect(after).toBe(before)

  // (c) both shared-key tables moved, and so did the api_keys companion.
  expect(countRows('project_credentials', 'owner_slug', 'juno')).toBe(1)
  expect(countRows('project_credentials', 'owner_slug', 'dev')).toBe(0)
  expect(countRows('api_keys', 'project_slug', 'juno')).toBe(1)
  expect(countRows('api_keys', 'project_slug', 'dev')).toBe(0)
  const movedTables = result.moved.map((m) => m.table).sort()
  expect(movedTables).toEqual(['api_keys', 'project_credentials', 'secrets'])
  for (const m of result.moved) expect(m.rows).toBe(1)

  // (d) the result carries counts/handles/tables only.
  expect(
    secretLeaks(result, ['ghp-orphaned-github-token', 'apify-token', before ?? '']),
  ).toEqual([])
})

test('a DB already entirely on the boot handle is a noop', async () => {
  const store = buildStore()
  await store.put({
    owner_handle: asOwnerHandle('juno'),
    kind: 'bot_token',
    label: 'primary',
    plaintext: 'bot-token',
  })
  const result = await reconcileCredentialScope(db, 'juno')
  expect(result.action).toBe('noop')
  expect(countRows('secrets', 'project_slug', 'juno')).toBe(1)
})

// ── (a2) — the AMBIGUOUS case: the ROTATION HAZARD ────────────────────────

test('(a2) stale + fresh rows for the SAME (kind,label): nothing moves and the FRESH value survives', async () => {
  const store = buildStore()
  await store.put({
    owner_handle: asOwnerHandle('dev'),
    kind: 'chatgpt_oauth',
    label: 'codex',
    plaintext: 'stale-token',
  })
  await store.put({
    owner_handle: asOwnerHandle('juno'),
    kind: 'chatgpt_oauth',
    label: 'codex',
    plaintext: 'fresh-token',
  })

  const result = await reconcileCredentialScope(db, 'juno')
  expect(result.action).toBe('orphaned')
  if (result.action !== 'orphaned') throw new Error('unreachable')
  expect(result.stale_handles).toEqual(['dev'])
  expect(result.orphan_counts).toEqual([{ table: 'secrets', handle: 'dev', rows: 1 }])

  // THE ASSERTION THAT MATTERS — the DECRYPTED value, not the row count. A
  // blind rewrite would silently put the instance back on yesterday's token.
  expect(
    await store.get({
      owner_handle: asOwnerHandle('juno'),
      kind: 'chatgpt_oauth',
      label: 'codex',
    }),
  ).toBe('fresh-token')
  // The stale row is untouched, still readable under its own handle.
  expect(
    await store.get({
      owner_handle: asOwnerHandle('dev'),
      kind: 'chatgpt_oauth',
      label: 'codex',
    }),
  ).toBe('stale-token')

  expect(countRows('secrets', 'project_slug', 'dev')).toBe(1)
  expect(countRows('secrets', 'project_slug', 'juno')).toBe(1)

  // (d)
  expect(secretLeaks(result, ['stale-token', 'fresh-token'])).toEqual([])
})

test('(a2) a boot-handle row in ANY swept table blocks the automatic branch', async () => {
  const store = buildStore()
  await store.put({
    owner_handle: asOwnerHandle('dev'),
    kind: 'byo_api_key',
    label: 'anthropic:prod',
    plaintext: 'stale-anthropic-key',
  })
  // The only boot-handle row lives in the COMPANION table — the precondition is
  // "zero rows under the boot handle in EVERY swept table", not just `secrets`.
  await seedApiKey('juno', 'openai', 'prod', 'some-other-secret-id')

  const result = await reconcileCredentialScope(db, 'juno')
  expect(result.action).toBe('orphaned')
  expect(countRows('secrets', 'project_slug', 'dev')).toBe(1)
  expect(countRows('secrets', 'project_slug', 'juno')).toBe(0)
  expect(countRows('api_keys', 'project_slug', 'juno')).toBe(1)
  expect(
    await store.get({
      owner_handle: asOwnerHandle('dev'),
      kind: 'byo_api_key',
      label: 'anthropic:prod',
    }),
  ).toBe('stale-anthropic-key')
})

test('two stale handles with zero boot-handle rows: orphaned, zero writes', async () => {
  const store = buildStore()
  await store.put({
    owner_handle: asOwnerHandle('dev'),
    kind: 'bot_token',
    label: 'primary',
    plaintext: 'dev-bot-token',
  })
  await store.put({
    owner_handle: asOwnerHandle('staging'),
    kind: 'bot_token',
    label: 'primary',
    plaintext: 'staging-bot-token',
  })
  await seedProjectCredential('staging', 'apify', store.encryptPlaintext('apify-token'))

  const result = await reconcileCredentialScope(db, 'juno')
  expect(result.action).toBe('orphaned')
  if (result.action !== 'orphaned') throw new Error('unreachable')
  expect(result.stale_handles).toEqual(['dev', 'staging'])
  expect(result.orphan_counts).toEqual([
    { table: 'secrets', handle: 'dev', rows: 1 },
    { table: 'secrets', handle: 'staging', rows: 1 },
    { table: 'project_credentials', handle: 'staging', rows: 1 },
  ])

  expect(countRows('secrets', 'project_slug', 'dev')).toBe(1)
  expect(countRows('secrets', 'project_slug', 'staging')).toBe(1)
  expect(countRows('secrets', 'project_slug', 'juno')).toBe(0)
  expect(countRows('project_credentials', 'owner_slug', 'juno')).toBe(0)
  expect(
    await store.get({
      owner_handle: asOwnerHandle('dev'),
      kind: 'bot_token',
      label: 'primary',
    }),
  ).toBe('dev-bot-token')
  expect(secretLeaks(result, ['dev-bot-token', 'staging-bot-token'])).toEqual([])
})

// ── (d) — the leak assertion can actually fail ────────────────────────────

test('(d) POSITIVE CONTROL: the leak helper flags a deliberately-poisoned payload', () => {
  const poisoned = {
    action: 'migrated',
    boot_handle: 'juno',
    // What a careless implementation might have included.
    debug_value: 'ghp-orphaned-github-token',
    envelope: '{"v":1,"iv_b64":"AAAA","ct_b64":"BBBB","tag_b64":"CCCC"}',
  }
  const leaks = secretLeaks(poisoned, ['ghp-orphaned-github-token'])
  expect(leaks).toContain('ghp-orphaned-github-token')
  expect(leaks).toContain('ct_b64')
})
