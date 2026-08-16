/**
 * T2 — A MISS IS DISTINGUISHABLE (acceptance (b), card 2026-08-14).
 *
 * The expensive half of the orphaned-credentials bug was never that the rows
 * sat under the wrong owner handle — it was that a wrong-scope miss and "you
 * never connected this" printed the SAME sentence, so a night of failed
 * publishes was diagnosed as a blinking GitHub token. These tests pin that the
 * two sentences are now different, in BOTH directions:
 *
 *   - rows under a previous handle  ⇒ `orphaned: true` + a summary naming the
 *     migrate action (T2.1, T2.7);
 *   - rows under the boot handle    ⇒ `connected: true`, no summary (T2.2);
 *   - no rows at all                ⇒ plain `connected:false, orphaned:false`
 *     (T2.3) — the control that keeps "orphaned" meaningful.
 *
 * The card's FAKE-TEST guards apply here too: T2.2 is the positive control (the
 * same seeded rows read CONNECTED under the correct handle), and T2.4 pins the
 * rotation hazard from the read side — a fresh boot-handle credential wins the
 * slot and is never re-labelled `orphaned`. Reverting the annotation logic turns
 * T2.1 red, because it asserts `orphaned === true`, not merely null-on-miss.
 *
 * Read-only feature: nothing here (or in the code under test) writes to a
 * credential table, and no plaintext or ciphertext may appear in the status
 * (T2.6, acceptance (d)).
 */

import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb, asOwnerHandle, type OwnerHandle } from '@neutronai/persistence/index.ts'
import { SecretsStore } from '@neutronai/auth/secrets-store.ts'
import { ToolRegistry } from '@neutronai/tools/registry.ts'
import type { ToolCallContext, ToolRegistration } from '@neutronai/tools/registry.ts'
import { installBundledCores } from '../install-bundled.ts'
import { OAuthTokenManager, GOOGLE_REVOKE_URL, metaLabel } from '../oauth-token-manager.ts'
import { buildIntegrationsTools } from '../integrations-tools.ts'
import {
  buildIntegrationsStatus,
  type ApiKeyIntegration,
  type IntegrationsStatus,
  type OAuthAccountIntegration,
} from '../integrations.ts'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..')
/** The handle this process "boots" as. */
const BOOT = asOwnerHandle('juno-test')
/** The pre-provisioning handle the rows were frozen under. */
const STALE = asOwnerHandle('dev-old')

/** Plaintexts seeded below — none of them may reach the status (T2.6). */
const ACCESS_PLAINTEXT = 'access-token-plaintext-do-not-leak'
const TAVILY_PLAINTEXT = 'tvly-plaintext-do-not-leak'
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
  const home = mkdtempSync(join(tmpdir(), 'neutron-integrations-orphan-'))
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
    // The manager reads as the BOOT handle — which is exactly why a row frozen
    // under STALE is invisible to it.
    owner_handle: BOOT,
    client_id: 'cid',
    client_secret: 'csecret',
    fetch: fakeFetch,
  })
  return { home, db, secrets, cores, tokens, registry: cores.registry }
}

/** Seed an OAuth access row + meta under `owner` so getStatus can report connected. */
async function seedOAuth(
  secrets: SecretsStore,
  owner: OwnerHandle,
  label: string,
  email: string,
): Promise<void> {
  await secrets.put({
    owner_handle: owner,
    kind: 'oauth_token',
    label,
    plaintext: ACCESS_PLAINTEXT,
    expires_at: Date.now() + 3_600_000,
  })
  await secrets.put({
    owner_handle: owner,
    kind: 'oauth_token',
    label: metaLabel(label),
    plaintext: JSON.stringify({
      scopes: ['https://www.googleapis.com/auth/calendar'],
      email,
      connected_at: Date.now(),
      last_refresh_at: null,
      last_refresh_outcome: 'ok',
    }),
  })
}

/** Seed the Research Core's `tavily` byo_api_key slot under `owner`. */
async function seedApiKey(secrets: SecretsStore, owner: OwnerHandle): Promise<void> {
  await secrets.put({
    owner_handle: owner,
    kind: 'byo_api_key',
    label: 'tavily',
    plaintext: TAVILY_PLAINTEXT,
  })
}

/**
 * Seed a `project_credentials` row directly (its store lives in another
 * package). The ciphertext is filler — this surface never decrypts anything.
 */
async function seedProjectCredential(db: ProjectDb, owner_slug: string): Promise<void> {
  await db.run(
    `INSERT INTO project_credentials
       (id, owner_slug, project_id, scope, service, ciphertext, label, created_at, updated_at, expires_at)
     VALUES (?, ?, '', 'global', 'codex', ?, NULL, '2026-08-14T00:00:00Z', '2026-08-14T00:00:00Z', NULL)`,
    [`${owner_slug}-codex`, owner_slug, CREDENTIAL_CIPHERTEXT],
  )
}

function oauthEntry(status: IntegrationsStatus, service: string): OAuthAccountIntegration {
  const found = status.oauth.find((o) => o.service === service)
  if (found === undefined) throw new Error(`no oauth entry for ${service}`)
  return found
}

function apiKeyEntry(status: IntegrationsStatus, label: string): ApiKeyIntegration {
  const found = status.api_keys.find((k) => k.label === label)
  if (found === undefined) throw new Error(`no api_key entry for ${label}`)
  return found
}

function byName(tools: ToolRegistration[], name: string): ToolRegistration {
  const t = tools.find((x) => x.name === name)
  if (t === undefined) throw new Error(`tool ${name} not built`)
  return t
}

// ── T2.1 ORPHANED IS REPORTED (acceptance (b)) ────────────────────────────
test('rows scoped to a previous owner handle report orphaned, not "not connected"', async () => {
  const b = await makeBench()
  await seedOAuth(b.secrets, STALE, 'google_calendar', 'owner@example.com')
  await seedApiKey(b.secrets, STALE)
  await seedProjectCredential(b.db, STALE)

  const status = await buildIntegrationsStatus({
    registry: b.registry,
    tokens: b.tokens,
    secretsStore: b.secrets,
    project_slug: BOOT,
    db: b.db,
  })

  const summary = status.orphaned_credentials
  expect(summary).not.toBeNull()
  expect(summary!.stale_handles).toEqual(['dev-old'])
  // The summary covers EVERY swept table — moving `secrets` but not
  // `project_credentials` leaves codex orphaned (acceptance (c)).
  expect(summary!.tables).toContainEqual({ table: 'secrets', handle: 'dev-old', rows: 3 })
  expect(summary!.tables).toContainEqual({
    table: 'project_credentials',
    handle: 'dev-old',
    rows: 1,
  })
  // 2 oauth rows (access + meta) + 1 byo_api_key + 1 project_credentials.
  expect(summary!.total_rows).toBe(4)
  expect(summary!.migrate_action).toBe('integrations_migrate_orphaned')
  expect(summary!.message).toContain('scoped to a previous owner handle')
  expect(summary!.message).toContain('integrations_migrate_orphaned')

  // THE POINT OF THE CARD: the slots read disconnected AND say why.
  const calendar = oauthEntry(status, 'google_calendar')
  expect(calendar.connected).toBe(false)
  expect(calendar.orphaned).toBe(true)
  const tavily = apiKeyEntry(status, 'tavily')
  expect(tavily.connected).toBe(false)
  expect(tavily.orphaned).toBe(true)

  // ── T2.6 NO SECRET MATERIAL (acceptance (d)) ────────────────────────────
  const serialized = JSON.stringify(status)
  expect(serialized).not.toContain(ACCESS_PLAINTEXT)
  expect(serialized).not.toContain(TAVILY_PLAINTEXT)
  expect(serialized).not.toContain(CREDENTIAL_CIPHERTEXT)
})

// ── T2.2 POSITIVE CONTROL (the card's fake-test guard) ────────────────────
test('the SAME rows under the boot handle read connected, with no orphan summary', async () => {
  const b = await makeBench()
  await seedOAuth(b.secrets, BOOT, 'google_calendar', 'owner@example.com')
  await seedApiKey(b.secrets, BOOT)
  await seedProjectCredential(b.db, BOOT)

  const status = await buildIntegrationsStatus({
    registry: b.registry,
    tokens: b.tokens,
    secretsStore: b.secrets,
    project_slug: BOOT,
    db: b.db,
  })

  const calendar = oauthEntry(status, 'google_calendar')
  expect(calendar.connected).toBe(true)
  expect(calendar.orphaned).toBe(false)
  const tavily = apiKeyEntry(status, 'tavily')
  expect(tavily.connected).toBe(true)
  expect(tavily.orphaned).toBe(false)
  expect(status.orphaned_credentials).toBeNull()
})

// ── T2.3 GENUINELY UNCONNECTED STAYS PLAIN ────────────────────────────────
test('a genuinely unconnected slot still reads plain connected:false, orphaned:false', async () => {
  const b = await makeBench()
  const status = await buildIntegrationsStatus({
    registry: b.registry,
    tokens: b.tokens,
    secretsStore: b.secrets,
    project_slug: BOOT,
    db: b.db,
  })

  expect(status.orphaned_credentials).toBeNull()
  for (const entry of status.oauth) {
    expect(entry.connected).toBe(false)
    expect(entry.orphaned).toBe(false)
  }
  for (const entry of status.api_keys) {
    expect(entry.connected).toBe(false)
    expect(entry.orphaned).toBe(false)
  }
})

// ── T2.4 A FRESH CREDENTIAL WINS THE SLOT (rotation hazard, read side) ────
test('a fresh boot-handle credential wins the slot; the stale twin stays in the summary', async () => {
  const b = await makeBench()
  await seedOAuth(b.secrets, BOOT, 'google_calendar', 'fresh@example.com')
  await seedOAuth(b.secrets, STALE, 'google_calendar', 'stale@example.com')

  const status = await buildIntegrationsStatus({
    registry: b.registry,
    tokens: b.tokens,
    secretsStore: b.secrets,
    project_slug: BOOT,
    db: b.db,
  })

  const calendar = oauthEntry(status, 'google_calendar')
  expect(calendar.connected).toBe(true)
  // Never re-label a working slot as needing migration.
  expect(calendar.orphaned).toBe(false)
  expect(calendar.email).toBe('fresh@example.com')
  // …but the stale rows are still reported, because they still need moving.
  expect(status.orphaned_credentials).not.toBeNull()
  expect(status.orphaned_credentials!.stale_handles).toEqual(['dev-old'])
  expect(status.orphaned_credentials!.total_rows).toBe(2)
})

// ── T2.5 NO DB ⇒ UNCHANGED SHAPE ──────────────────────────────────────────
test('without a db the status degrades to presence-only (no orphan detection)', async () => {
  const b = await makeBench()
  await seedOAuth(b.secrets, STALE, 'google_calendar', 'owner@example.com')
  await seedApiKey(b.secrets, STALE)

  const status = await buildIntegrationsStatus({
    registry: b.registry,
    tokens: b.tokens,
    secretsStore: b.secrets,
    project_slug: BOOT,
  })

  expect(status.orphaned_credentials).toBeNull()
  for (const entry of [...status.oauth, ...status.api_keys]) {
    expect(entry.orphaned).toBe(false)
  }
})

// ── T2.7 THE AGENT-VISIBLE SENTENCE CHANGED, NOT JUST THE BRAIN ───────────
test('integrations_list surfaces the orphan summary and names the migrate action', async () => {
  const b = await makeBench()
  await seedOAuth(b.secrets, STALE, 'google_calendar', 'owner@example.com')
  await seedApiKey(b.secrets, STALE)
  await seedProjectCredential(b.db, STALE)

  const built = buildIntegrationsTools({
    registry: b.registry,
    tokens: b.tokens,
    secretsStore: b.secrets,
    project_slug: BOOT,
    db: b.db,
    startOAuth: async (labels: string[]) => ({
      ok: true as const,
      authorize_url: `https://accounts.google.com/o/oauth2/v2/auth?labels=${labels.join(',')}`,
      state: 'st-1',
      expires_at: 0,
    }),
  })
  const listTool = byName(built, 'integrations_list')
  const out = (await listTool.handler({}, CTX)) as IntegrationsStatus

  expect(out.orphaned_credentials).not.toBeNull()
  expect(out.orphaned_credentials!.migrate_action).toBe('integrations_migrate_orphaned')
  expect(out.orphaned_credentials!.total_rows).toBe(4)
  expect(oauthEntry(out, 'google_calendar').orphaned).toBe(true)
  expect(apiKeyEntry(out, 'tavily').orphaned).toBe(true)
  // The tool's own description must tell the agent the distinction exists.
  expect(listTool.description).toContain('orphaned')
})
