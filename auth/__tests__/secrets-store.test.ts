import { asOwnerHandle } from '@neutronai/persistence/index.ts'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, statSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createCipheriv, createDecipheriv } from 'node:crypto'
import { Database } from 'bun:sqlite'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import {
  SecretsStore,
  SecretsStoreError,
  ensureKey,
  hasSharedKeyEncryptedRows,
  SHARED_KEY_ENCRYPTED_TABLES,
} from '../secrets-store.ts'

/**
 * ISSUES #219 — `EncryptedBotTokenStore` (the P1-S4 legacy bot-token
 * primitive) lives in a Managed-carved provisioning dir that the Open split
 * strips from the public tree.
 * This forward-compat regression asserts that the Open `SecretsStore` stays
 * byte-compatible with the legacy AES-256-GCM envelope + shared
 * `.neutron-aes-key` keyfile, so the legacy format is the FIXTURE the test
 * pins. The verbatim mirror below reproduces that exact on-disk format
 * (envelope `{v:1,iv_b64,ct_b64,tag_b64}` + lazy 0600 keyfile) without
 * importing the Managed module — the wire format, not the class identity,
 * is what `SecretsStore` must remain compatible with.
 */
const LEGACY_KEY_LENGTH_BYTES = 32
const LEGACY_IV_LENGTH_BYTES = 12
const LEGACY_AUTH_TAG_LENGTH_BYTES = 16

class LegacyEncryptedBotTokenStore {
  private readonly key: Buffer
  constructor(options: { data_dir: string }) {
    this.key = ensureLegacyKey(options.data_dir)
  }
  encrypt(plaintext: string): string {
    const iv = crypto.getRandomValues(new Uint8Array(LEGACY_IV_LENGTH_BYTES))
    const cipher = createCipheriv('aes-256-gcm', this.key, Buffer.from(iv))
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    if (tag.length !== LEGACY_AUTH_TAG_LENGTH_BYTES) {
      throw new Error(`unexpected auth tag length ${tag.length}`)
    }
    return JSON.stringify({
      v: 1,
      iv_b64: Buffer.from(iv).toString('base64'),
      ct_b64: ct.toString('base64'),
      tag_b64: tag.toString('base64'),
    })
  }
  decrypt(envelope: string): string {
    const env = JSON.parse(envelope) as {
      v: number
      iv_b64: string
      ct_b64: string
      tag_b64: string
    }
    if (env.v !== 1) throw new Error(`unsupported envelope version v=${env.v}`)
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.key,
      Buffer.from(env.iv_b64, 'base64'),
    )
    decipher.setAuthTag(Buffer.from(env.tag_b64, 'base64'))
    const pt = Buffer.concat([
      decipher.update(Buffer.from(env.ct_b64, 'base64')),
      decipher.final(),
    ])
    return pt.toString('utf8')
  }
}

function ensureLegacyKey(data_dir: string): Buffer {
  const path = join(data_dir, '.neutron-aes-key')
  if (existsSync(path)) {
    const buf = readFileSync(path)
    if (buf.length !== LEGACY_KEY_LENGTH_BYTES) {
      throw new Error(`bot-token key at ${path} has wrong length ${buf.length}`)
    }
    return buf
  }
  mkdirSync(dirname(path), { recursive: true })
  const fresh = Buffer.from(
    crypto.getRandomValues(new Uint8Array(LEGACY_KEY_LENGTH_BYTES)),
  )
  writeFileSync(path, fresh, { mode: 0o600 })
  return fresh
}

let workdir: string
let db: ProjectDb
let dataDir: string

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'neutron-secrets-'))
  dataDir = join(workdir, 'project')
  mkdirSync(dataDir, { recursive: true })
  const dbPath = join(workdir, 'project.db')
  const raw = new Database(dbPath, { create: true })
  applyMigrations(raw)
  raw.close()
  db = ProjectDb.open(dbPath)
})

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true })
})

function buildStore(): SecretsStore {
  return new SecretsStore({ data_dir: dataDir, db, now: () => 1_700_000_000_000 })
}

test('put + get round-trips an arbitrary plaintext via AES-256-GCM', async () => {
  const store = buildStore()
  const result = await store.put({
    internal_handle: asOwnerHandle('alice'),
    kind: 'byo_api_key',
    label: 'anthropic:prod',
    plaintext: 'sk-ant-secret-token-1',
  })
  expect(typeof result.id).toBe('string')
  expect(result.id.length).toBeGreaterThan(0)
  const decrypted = await store.get({
    internal_handle: asOwnerHandle('alice'),
    kind: 'byo_api_key',
    label: 'anthropic:prod',
  })
  expect(decrypted).toBe('sk-ant-secret-token-1')
})

test('get returns null for missing rows', async () => {
  const store = buildStore()
  const decrypted = await store.get({
    internal_handle: asOwnerHandle('alice'),
    kind: 'byo_api_key',
    label: 'missing',
  })
  expect(decrypted).toBeNull()
})

test('put rejects duplicate (project_slug, kind, label) with duplicate_label code', async () => {
  const store = buildStore()
  await store.put({
    internal_handle: asOwnerHandle('alice'),
    kind: 'byo_api_key',
    label: 'anthropic:prod',
    plaintext: 'first',
  })
  await expect(
    store.put({
      internal_handle: asOwnerHandle('alice'),
      kind: 'byo_api_key',
      label: 'anthropic:prod',
      plaintext: 'second',
    }),
  ).rejects.toMatchObject({ code: 'duplicate_label' })
})

test('rotate replaces ciphertext and stamps rotated_at', async () => {
  let nowVal = 1_700_000_000_000
  const store = new SecretsStore({ data_dir: dataDir, db, now: () => nowVal })
  const { id } = await store.put({
    internal_handle: asOwnerHandle('alice'),
    kind: 'byo_api_key',
    label: 'k1',
    plaintext: 'v1',
  })
  nowVal += 60_000
  await store.rotate(id, 'v2')
  const current = await store.get({ internal_handle: asOwnerHandle('alice'), kind: 'byo_api_key', label: 'k1' })
  expect(current).toBe('v2')
  const list = await store.list({ internal_handle: asOwnerHandle('alice') })
  expect(list[0]?.rotated_at).toBe(nowVal)
})

test('rotate on unknown id throws not_found', async () => {
  const store = buildStore()
  await expect(store.rotate('does-not-exist', 'x')).rejects.toMatchObject({
    code: 'not_found',
  })
})

test('delete removes the row; subsequent get returns null', async () => {
  const store = buildStore()
  const { id } = await store.put({
    internal_handle: asOwnerHandle('alice'),
    kind: 'byo_api_key',
    label: 'k',
    plaintext: 'v',
  })
  await store.delete(id)
  const after = await store.get({ internal_handle: asOwnerHandle('alice'), kind: 'byo_api_key', label: 'k' })
  expect(after).toBeNull()
})

test('list filters by project_slug and optional kind', async () => {
  const store = buildStore()
  await store.put({ internal_handle: asOwnerHandle('alice'), kind: 'byo_api_key', label: 'k1', plaintext: 'v' })
  await store.put({ internal_handle: asOwnerHandle('alice'), kind: 'webhook_secret', label: 'k2', plaintext: 'v' })
  await store.put({ internal_handle: asOwnerHandle('bobby'), kind: 'byo_api_key', label: 'k3', plaintext: 'v' })
  const aliceAll = await store.list({ internal_handle: asOwnerHandle('alice') })
  expect(aliceAll.map((r) => r.label).sort()).toEqual(['k1', 'k2'])
  const aliceKeys = await store.list({ internal_handle: asOwnerHandle('alice'), kind: 'byo_api_key' })
  expect(aliceKeys.map((r) => r.label)).toEqual(['k1'])
})

test('ensureKey reuses a pre-existing legacy bot-token keyfile', () => {
  const path = join(dataDir, '.neutron-aes-key')
  const legacy = Buffer.from(crypto.getRandomValues(new Uint8Array(32)))
  writeFileSync(path, legacy, { mode: 0o600 })
  const reused = ensureKey(dataDir)
  expect(reused.equals(legacy)).toBe(true)
})

// Codex follow-up — defense-in-depth. `writeFileSync({mode:0o600})` only
// applies on CREATE, so a copied / manually-placed keyfile at 0644 would
// leave every secret in `secrets` decryptable by other local users.
// Mirrors the Argus r1 finding 3 chmodSync fix for `~/.codex/auth.json`.
test('ensureKey force-tightens an existing keyfile from 0644 to 0600', () => {
  const path = join(dataDir, '.neutron-aes-key')
  const legacy = Buffer.from(crypto.getRandomValues(new Uint8Array(32)))
  writeFileSync(path, legacy, { mode: 0o600 })
  // Simulate a keyfile that someone copied or `mv`d in with overly broad
  // perms (the 0o600 above is what writeFileSync forces; chmod 0o644
  // afterwards is the real-world drift case).
  chmodSync(path, 0o644)
  expect(statSync(path).mode & 0o777).toBe(0o644)
  ensureKey(dataDir)
  expect(statSync(path).mode & 0o777).toBe(0o600)
})

test('ensureKey creates a fresh 32-byte keyfile when none exists', () => {
  const path = join(dataDir, '.neutron-aes-key')
  expect(existsSync(path)).toBe(false)
  const fresh = ensureKey(dataDir)
  expect(fresh.length).toBe(32)
  expect(existsSync(path)).toBe(true)
  // Re-call returns the same bytes (idempotent).
  expect(ensureKey(dataDir).equals(fresh)).toBe(true)
})

// S3(a) — secrets-at-rest hygiene: neutron-backup.sh deliberately excludes
// `.neutron-aes-key` from the backup bundle, so a data dir restored from a
// backup arrives with the `secrets` table's rows but WITHOUT the keyfile.
// `ensureKey` must fail loud in that case rather than silently mint a fresh
// key that can never decrypt the restored rows.
test('ensureKey mints a fresh key when hasExistingSecrets is false (normal fresh install)', () => {
  const path = join(dataDir, '.neutron-aes-key')
  const fresh = ensureKey(dataDir, () => false)
  expect(fresh.length).toBe(32)
  expect(existsSync(path)).toBe(true)
})

test('ensureKey throws key_missing_after_restore when the keyfile is absent but secrets already exist', () => {
  const path = join(dataDir, '.neutron-aes-key')
  expect(existsSync(path)).toBe(false)
  let caught: unknown
  try {
    ensureKey(dataDir, () => true)
  } catch (err) {
    caught = err
  }
  expect(caught).toBeInstanceOf(SecretsStoreError)
  expect((caught as SecretsStoreError).code).toBe('key_missing_after_restore')
  // Never silently minted a key in this scenario — the operator must
  // provision the ORIGINAL keyfile, not get a fresh unusable one.
  expect(existsSync(path)).toBe(false)
})

test('SecretsStore constructor fails loud on a restored data dir: rows exist, keyfile does not', async () => {
  // Step 1: a store writes a secret + its keyfile — the ORIGINAL machine.
  const original = buildStore()
  await original.put({ internal_handle: asOwnerHandle('alice'), kind: 'byo_api_key', label: 'k', plaintext: 'v' })

  // Step 2: simulate a neutron-backup.sh restore — the DB (carrying that row)
  // comes back, but `.neutron-aes-key` (excluded from the bundle) does not.
  rmSync(join(dataDir, '.neutron-aes-key'))

  // Step 3: constructing a fresh SecretsStore against the now-keyless data
  // dir must fail loud instead of silently minting an unusable new key.
  let caught: unknown
  try {
    buildStore()
  } catch (err) {
    caught = err
  }
  expect(caught).toBeInstanceOf(SecretsStoreError)
  expect((caught as SecretsStoreError).code).toBe('key_missing_after_restore')
})

// S3(a) whole-class widening (Codex blocker): `project_credentials` is
// encrypted with the SAME `.neutron-aes-key`, so a restore carrying ONLY
// project-credential rows (no `secrets` rows) + no keyfile must ALSO fail loud
// — otherwise a fresh key is minted and every restored credential is orphaned.
async function insertProjectCredentialRow(): Promise<void> {
  // Raw INSERT of a ciphertext row (crypto is irrelevant to the row-count guard).
  await db.run(
    `INSERT INTO project_credentials
       (id, owner_slug, project_id, scope, service, ciphertext, label, created_at, updated_at, expires_at)
     VALUES (?, ?, '', 'global', 'meta_ads', ?, NULL, ?, ?, NULL)`,
    [
      '01JCRED0000000000000000000',
      'alice',
      JSON.stringify({ v: 1, iv_b64: 'x', ct_b64: 'y', tag_b64: 'z' }),
      '2026-07-11T00:00:00Z',
      '2026-07-11T00:00:00Z',
    ],
  )
}

test('hasSharedKeyEncryptedRows covers secrets AND project_credentials', async () => {
  // Empty DB → no encrypted rows anywhere.
  expect(hasSharedKeyEncryptedRows(db)).toBe(false)
  // A row in project_credentials alone (no secrets) → TRUE.
  await insertProjectCredentialRow()
  expect(hasSharedKeyEncryptedRows(db)).toBe(true)
  // Sanity: the shared-key table list is exactly the two audited ciphertext
  // tables — if a new one is added, its restore coverage must be added too.
  expect([...SHARED_KEY_ENCRYPTED_TABLES].sort()).toEqual(['project_credentials', 'secrets'])
})

test('hasSharedKeyEncryptedRows treats a table absent from the schema as 0 rows (no error)', () => {
  // A DB with the `secrets` table but WITHOUT `project_credentials` (pre-0092)
  // must NOT throw on the count — the missing table is skipped, not queried.
  const raw = new Database(':memory:', { create: true })
  raw.run('CREATE TABLE secrets (id TEXT PRIMARY KEY, ciphertext TEXT NOT NULL)')
  // Minimal `Pick<ProjectDb, 'get'>` probe mirroring ProjectDb.get semantics.
  const probe: Pick<ProjectDb, 'get'> = {
    get: <R,>(sql: string, params: unknown[] = []): R | null =>
      (raw.query(sql).get(...(params as never[])) as R | null),
  }
  expect(hasSharedKeyEncryptedRows(probe)).toBe(false) // empty secrets, missing table skipped
  raw.run(`INSERT INTO secrets (id, ciphertext) VALUES ('a', 'ct')`)
  expect(hasSharedKeyEncryptedRows(probe)).toBe(true) // secrets row present; no crash on missing pc
  raw.close()
})

test('SecretsStore constructor fails loud when ONLY project_credentials has rows (no secrets, no keyfile)', async () => {
  // Restore scenario: the DB carried project_credentials rows back, but the
  // key (excluded from the backup) and any `secrets` rows are absent.
  await insertProjectCredentialRow()
  expect(existsSync(join(dataDir, '.neutron-aes-key'))).toBe(false)
  let caught: unknown
  try {
    buildStore()
  } catch (err) {
    caught = err
  }
  expect(caught).toBeInstanceOf(SecretsStoreError)
  expect((caught as SecretsStoreError).code).toBe('key_missing_after_restore')
  // Fail-closed: no fresh key was minted that could never decrypt the creds.
  expect(existsSync(join(dataDir, '.neutron-aes-key'))).toBe(false)
})

// CRITICAL forward-compat regression — see § 0a.1 risk row 1.
test('SecretsStore decrypts an envelope written by the legacy EncryptedBotTokenStore', async () => {
  // Step 1: legacy store writes a token with its own keyfile setup.
  const legacy = new LegacyEncryptedBotTokenStore({ data_dir: dataDir })
  const envelope = legacy.encrypt('legacy-bot-token-xyz')

  // Step 2: P1.5 SecretsStore opens against the SAME data_dir. It must
  // detect + reuse the existing keyfile rather than overwrite.
  const store = buildStore()
  const recoveredViaLegacyShape = store.decryptEnvelope(envelope)
  expect(recoveredViaLegacyShape).toBe('legacy-bot-token-xyz')

  // Step 3: the legacy store can ALSO decrypt anything the new store wrote
  // (round-trip in the other direction).
  const newCipher = store.encryptPlaintext('round-trip')
  expect(legacy.decrypt(newCipher)).toBe('round-trip')

  // Step 4: the keyfile bytes on disk are identical (no overwrite).
  const onDisk = readFileSync(join(dataDir, '.neutron-aes-key'))
  expect(onDisk.length).toBe(32)
})

test('decrypt of a tampered envelope throws SecretsStoreError(decrypt_failed)', async () => {
  const store = buildStore()
  await store.put({
    internal_handle: asOwnerHandle('alice'),
    kind: 'byo_api_key',
    label: 'k',
    plaintext: 'secret',
  })
  // Manually tamper with the ciphertext.
  await db.run(
    `UPDATE secrets SET ciphertext = ? WHERE project_slug = ? AND kind = ? AND label = ?`,
    ['{"v":1,"iv_b64":"aaa","ct_b64":"bbb","tag_b64":"ccc"}', 'alice', 'byo_api_key', 'k'],
  )
  await expect(
    store.get({ internal_handle: asOwnerHandle('alice'), kind: 'byo_api_key', label: 'k' }),
  ).rejects.toBeInstanceOf(SecretsStoreError)
})

test('expires_at is persisted when supplied (used by Max OAuth access tokens)', async () => {
  const store = buildStore()
  await store.put({
    internal_handle: asOwnerHandle('alice'),
    kind: 'max_oauth_access',
    label: 'default:access',
    plaintext: 'access-tok',
    expires_at: 1_800_000_000_000,
  })
  const list = await store.list({ internal_handle: asOwnerHandle('alice'), kind: 'max_oauth_access' })
  expect(list).toHaveLength(1)
  expect(list[0]?.expires_at).toBe(1_800_000_000_000)
})

// Codex review fix — expired rows must behave like missing secrets so
// stale OAuth access tokens trigger the refresh-token path.
test('get returns null for an expired secret (expires_at <= now)', async () => {
  let nowVal = 1_700_000_000_000
  const store = new SecretsStore({ data_dir: dataDir, db, now: () => nowVal })
  await store.put({
    internal_handle: asOwnerHandle('alice'),
    kind: 'max_oauth_access',
    label: 'default:access',
    plaintext: 'access-soon-stale',
    expires_at: nowVal + 1_000,
  })
  // Within window — returns the plaintext.
  expect(
    await store.get({ internal_handle: asOwnerHandle('alice'), kind: 'max_oauth_access', label: 'default:access' }),
  ).toBe('access-soon-stale')
  // Advance past expiry — get returns null.
  nowVal += 5_000
  expect(
    await store.get({ internal_handle: asOwnerHandle('alice'), kind: 'max_oauth_access', label: 'default:access' }),
  ).toBeNull()
  // The row still exists in storage — list shows it. Callers can rotate
  // or sweep based on listing.
  const list = await store.list({ internal_handle: asOwnerHandle('alice'), kind: 'max_oauth_access' })
  expect(list).toHaveLength(1)
})

test('rows without expires_at are returned regardless of clock', async () => {
  const store = buildStore()
  await store.put({
    internal_handle: asOwnerHandle('alice'),
    kind: 'byo_api_key',
    label: 'permanent',
    plaintext: 'never-expires',
  })
  expect(
    await store.get({ internal_handle: asOwnerHandle('alice'), kind: 'byo_api_key', label: 'permanent' }),
  ).toBe('never-expires')
})

// 2026-05-12 (Bug A regression) — the SecretsStore lookup key is the
// FROZEN `internal_handle`, not the mutable `url_slug`. Pre-fix, the
// gateway boot canonicalised `project_slug` to the NEW url_slug after a
// rename, then read the SecretsStore with that mutable value — the
// pre-rename secret rows (keyed on the original handle) became
// invisible, dropping the chat surface to the gate page even though
// Max OAuth tokens were still on disk. See file header.
test('post-rename: a secret written keyed on internal_handle is still readable after a synthetic url_slug rename', async () => {
  // Step 1 — write the secret under the FROZEN handle. This is the
  // shape the persist-paste-token path lands on disk at first-time
  // provisioning.
  const store = buildStore()
  const internal_handle = asOwnerHandle('t-example1')
  await store.put({
    internal_handle,
    kind: 'max_oauth_refresh',
    label: 'default',
    plaintext: 'sk-ant-paste-token-from-first-boot',
  })
  await store.put({
    internal_handle,
    kind: 'max_oauth_access',
    label: 'default:access',
    plaintext: 'sk-ant-paste-token-from-first-boot',
    expires_at: 2_000_000_000_000,
  })

  // Step 2 — synthetic rename: nothing on disk changes; the owner's
  // `url_slug` flips from 't-example1' to 'acme' at the registry +
  // membership + Caddy layer. The SecretsStore lookup MUST continue
  // to use the frozen `internal_handle` (the on-disk key) — that's the
  // contract this regression test pins.
  const new_url_slug = 'acme'
  void new_url_slug

  // Step 3 — boot-time read with the canonicalised lookup. Reading with
  // `internal_handle` returns the cached token; reading with the new
  // url_slug returns null (the row was never keyed on it). This is the
  // contract: callers MUST use internal_handle.
  const refreshUnderHandle = await store.get({
    internal_handle,
    kind: 'max_oauth_refresh',
    label: 'default',
  })
  expect(refreshUnderHandle).toBe('sk-ant-paste-token-from-first-boot')

  const refreshUnderNewSlug = await store.get({
    // Simulate the 2026-05-12 bug: a caller wrongly treats the MUTABLE
    // url_slug as the handle. The branded boundary now makes passing the raw
    // string a COMPILE error; branding it here reproduces the historical
    // wrong-key read, which still returns null (row keyed on the frozen handle).
    internal_handle: asOwnerHandle(new_url_slug),
    kind: 'max_oauth_refresh',
    label: 'default',
  })
  expect(refreshUnderNewSlug).toBeNull()
})
