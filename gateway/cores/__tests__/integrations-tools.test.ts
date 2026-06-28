/**
 * WAVE 2 Track A — agent-native Integrations chat-tool tests.
 *
 * Asserts the AGENT TOOL PATH actually mutates stored connection state —
 * not just UI scaffolding. A chat-initiated connect of the Tavily key
 * writes the secret; a chat-initiated disconnect of an OAuth account
 * deletes the tokens; disconnect of an API key clears it.
 */

import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '../../../migrations/runner.ts'
import { ProjectDb } from '../../../persistence/index.ts'
import { SecretsStore } from '../../../auth/secrets-store.ts'
import { ToolRegistry } from '../../../tools/registry.ts'
import type { ToolCallContext, ToolRegistration } from '../../../tools/registry.ts'
import { installBundledCores, updateInstallState } from '../install-bundled.ts'
import { CoreInstallationsStore } from '../../../cores/runtime/installations-store.ts'
import { OAuthTokenManager, GOOGLE_REVOKE_URL } from '../oauth-token-manager.ts'
import { buildIntegrationsTools } from '../integrations-tools.ts'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..')
const OWNER = 'integrations-tools-test'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

const CTX: ToolCallContext = {
  project_slug: OWNER,
  topic_id: null,
  call_id: 'call-1',
  speaker_user_id: null,
}

function byName(tools: ToolRegistration[], name: string): ToolRegistration {
  const t = tools.find((x) => x.name === name)
  if (t === undefined) throw new Error(`tool ${name} not built`)
  return t
}

async function makeBench() {
  const home = mkdtempSync(join(tmpdir(), 'neutron-integrations-tools-'))
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
    project_slug: OWNER,
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
    internal_handle: OWNER,
    client_id: 'cid',
    client_secret: 'csecret',
    fetch: fakeFetch,
  })
  // Fake the OAuth surface's in-process start: records the labels it was
  // asked to start and returns a public Google-shaped authorize_url.
  const startedLabels: string[][] = []
  const startOAuth = async (labels: string[]) => {
    startedLabels.push(labels)
    return {
      ok: true as const,
      authorize_url: `https://accounts.google.com/o/oauth2/v2/auth?labels=${labels.join(',')}&state=st-1`,
      state: 'st-1',
      expires_at: 0,
    }
  }
  const built = buildIntegrationsTools({
    registry: cores.registry,
    tokens,
    secretsStore: secrets,
    project_slug: OWNER,
    db,
    startOAuth,
  })
  return { secrets, tokens, built, startedLabels, db, cores }
}

function readInstallState(db: ProjectDb, core_slug: string): string | null {
  const row = db
    .raw()
    .query<{ install_state: string }, [string, string]>(
      `SELECT install_state FROM core_installations WHERE project_slug = ? AND core_slug = ?`,
    )
    .get(OWNER, core_slug)
  return row?.install_state ?? null
}

test('integrations_list returns OAuth + API-key slots', async () => {
  const b = await makeBench()
  const out = (await byName(b.built, 'integrations_list').handler({}, CTX)) as {
    oauth: Array<{ label: string }>
    api_keys: Array<{ label: string }>
  }
  expect(out.oauth.map((o) => o.label).sort()).toEqual([
    'gmail_compose',
    'google_calendar',
    'google_workspace',
  ])
  // `apify` (Scraping Core, parity gap #6) joins `tavily` (Research Core) as an
  // agent-manageable byo_api_key slot, plus the system `openai_api_key` slot
  // (ND1 — manages the OpenAI key that flips memory to semantic embeddings).
  expect(out.api_keys.map((k) => k.label).sort()).toEqual(['apify', 'openai_api_key', 'tavily'])
})

test('integrations_connect on an API-key slot stores the key (state mutation)', async () => {
  const b = await makeBench()
  const out = (await byName(b.built, 'integrations_connect').handler(
    { label: 'tavily', value: 'tvly-from-chat' },
    CTX,
  )) as { kind: string; connected: boolean }
  expect(out.kind).toBe('api_key')
  expect(out.connected).toBe(true)
  // The secret is actually persisted where the Research Core reads it.
  expect(
    await b.secrets.get({ internal_handle: OWNER, kind: 'byo_api_key', label: 'tavily' }),
  ).toBe('tvly-from-chat')
})

test('integrations_connect on an OAuth label returns the public Google authorize_url', async () => {
  const b = await makeBench()
  const out = (await byName(b.built, 'integrations_connect').handler(
    { label: 'google_calendar' },
    CTX,
  )) as { kind: string; authorize_url: string }
  expect(out.kind).toBe('oauth')
  // The tool runs the SAME in-process start the UI runs and hands back the
  // PUBLIC Google consent URL — NOT a bearer-gated gateway /start link.
  expect(out.authorize_url).toStartWith('https://accounts.google.com/o/oauth2/v2/auth')
  expect(b.startedLabels).toEqual([['google_calendar']])
})

test('integrations_connect on an API-key slot without value throws empty_value', async () => {
  const b = await makeBench()
  await expect(
    byName(b.built, 'integrations_connect').handler({ label: 'tavily' }, CTX),
  ).rejects.toThrow(/non-empty/)
})

test('integrations_disconnect on an OAuth account deletes the stored tokens', async () => {
  const b = await makeBench()
  // Seed a connected Google account.
  await b.secrets.put({
    internal_handle: OWNER,
    kind: 'oauth_token',
    label: 'google_workspace',
    plaintext: 'access',
    expires_at: Date.now() + 3_600_000,
  })
  expect(
    await b.secrets.get({
      internal_handle: OWNER,
      kind: 'oauth_token',
      label: 'google_workspace',
    }),
  ).toBe('access')

  const out = (await byName(b.built, 'integrations_disconnect').handler(
    { label: 'google_workspace' },
    CTX,
  )) as { kind: string; disconnected: boolean }
  expect(out.kind).toBe('oauth')
  expect(out.disconnected).toBe(true)
  expect(
    await b.secrets.get({
      internal_handle: OWNER,
      kind: 'oauth_token',
      label: 'google_workspace',
    }),
  ).toBeNull()
})

test('integrations_disconnect on an OAuth account flags affected Cores dependency-missing (UI/chat parity)', async () => {
  const b = await makeBench()
  // A chat-initiated OAuth disconnect must leave /api/cores in the SAME state
  // the UI/HTTP path produces: the affected Core flipped to
  // install_failed_dependency_missing — NOT still reporting `installed`. This
  // is the divergence Argus PR #13 IMPORTANT #3 flagged: before the shared
  // `disconnectOAuth` brain, the chat path deleted tokens but never wrote the
  // install_state, so the Core stayed "installed" with a silently-broken dep.
  const installs = new CoreInstallationsStore({ db: b.db })
  await installs.record({
    project_slug: OWNER,
    core_slug: 'google_workspace_core',
    package_name: '@neutronai/google-workspace-core',
    package_version: '0.0.0',
    capabilities: [],
    data_layout: 'tables',
  })
  await updateInstallState(b.db, OWNER, 'google_workspace_core', 'install_ok')
  expect(readInstallState(b.db, 'google_workspace_core')).toBe('install_ok')

  await b.secrets.put({
    internal_handle: OWNER,
    kind: 'oauth_token',
    label: 'google_workspace',
    plaintext: 'access',
    expires_at: Date.now() + 3_600_000,
  })

  const out = (await byName(b.built, 'integrations_disconnect').handler(
    { label: 'google_workspace' },
    CTX,
  )) as { kind: string; disconnected: boolean; affected_cores: string[] }
  expect(out.kind).toBe('oauth')
  expect(out.disconnected).toBe(true)
  expect(out.affected_cores).toContain('google_workspace_core')
  // The real state mutation the UI path also performs.
  expect(readInstallState(b.db, 'google_workspace_core')).toBe(
    'install_failed_dependency_missing',
  )
})

test('integrations_disconnect on an API-key slot clears the stored key', async () => {
  const b = await makeBench()
  await byName(b.built, 'integrations_connect').handler(
    { label: 'tavily', value: 'tvly-x' },
    CTX,
  )
  const out = (await byName(b.built, 'integrations_disconnect').handler(
    { label: 'tavily' },
    CTX,
  )) as { kind: string; disconnected: boolean }
  expect(out.kind).toBe('api_key')
  expect(out.disconnected).toBe(true)
  expect(
    await b.secrets.get({ internal_handle: OWNER, kind: 'byo_api_key', label: 'tavily' }),
  ).toBeNull()
})

test('integrations_connect rejects an unknown label', async () => {
  const b = await makeBench()
  await expect(
    byName(b.built, 'integrations_connect').handler({ label: 'nope' }, CTX),
  ).rejects.toThrow(/not declared/)
})
