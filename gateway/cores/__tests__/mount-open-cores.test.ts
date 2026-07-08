/**
 * Parity gap #2 (Cores→Open) — `mountOpenCores` wiring tests.
 *
 * Proves the brief's central claim: an Open boot COMPOSES the Calendar / Email /
 * Google-Workspace Core backends AND chains their chat-command filters, so a typed
 * `/cal` / `/email` is ROUTED to its Core — optional-until-credentialed, and with
 * zero creds the box still composes (in-memory clients, no throw, no boot block).
 */

import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { SecretsStore } from '@neutronai/auth/secrets-store.ts'
import { ProjectCredentialStore } from '@neutronai/project-credentials/store.ts'
import { ToolRegistry } from '@neutronai/tools/registry.ts'
import { installBundledCores } from '../install-bundled.ts'
import { mountOpenCores, GOOGLE_CLIENT_ID_ENV } from '../mount-open-cores.ts'

const OWNER = 'mount-open-cores-test'
const REPO_ROOT = join(import.meta.dir, '..', '..', '..')

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

function makeBench(env: NodeJS.ProcessEnv = {}): {
  db: ProjectDb
  owner_home: string
  secretsStore: SecretsStore
  projectCredentialStore: ProjectCredentialStore
  env: NodeJS.ProcessEnv
} {
  const owner_home = mkdtempSync(join(tmpdir(), 'mount-open-cores-'))
  cleanups.push(() => rmSync(owner_home, { recursive: true, force: true }))
  const dbPath = join(owner_home, 'owner.db')
  const raw = new Database(dbPath, { create: true })
  applyMigrations(raw)
  raw.close()
  const db = ProjectDb.open(dbPath)
  cleanups.push(() => db.close())
  const secretsStore = new SecretsStore({ data_dir: owner_home, db })
  const projectCredentialStore = new ProjectCredentialStore(db, { crypto: secretsStore })
  return { db, owner_home, secretsStore, projectCredentialStore, env }
}

test('composes the bundled free-Core backend factory map (Calendar/Email/Google + siblings)', async () => {
  const { db, owner_home, secretsStore, projectCredentialStore, env } = makeBench()
  const mounted = await mountOpenCores({
    projectDb: db,
    owner_home,
    project_slug: OWNER,
    secretsStore,
    projectCredentialStore,
    env,
    substrate: null,
  })
  cleanups.push(() => mounted.cleanup())

  for (const key of [
    'calendar_core',
    'email_managed_core',
    'google_workspace_core',
    'reminders_core',
    'research_core',
    'agent_settings',
  ]) {
    expect(typeof mounted.backends[key]).toBe('function')
  }
})

test('agent_settings is threaded with a LIVE profile (update_agent_name persists, no unavailable error)', async () => {
  const { readFileSync } = await import('node:fs')
  const { SETTINGS_BACKEND_UNAVAILABLE_ERROR } = await import(
    '@neutronai/agent-settings'
  )
  const { buildOpenAgentProfileBackend } = await import('@neutronai/open/agent-profile-backend.ts')
  const { db, owner_home, secretsStore, projectCredentialStore, env } = makeBench()
  const reloads: string[] = []
  const mounted = await mountOpenCores({
    projectDb: db,
    owner_home,
    project_slug: OWNER,
    secretsStore,
    projectCredentialStore,
    env,
    substrate: null,
    // L3 — the agent-profile backend is now INJECTED (built by the composer),
    // not constructed inside mountOpenCores from an `onPersonaReload` callback.
    agentSettingsProfile: buildOpenAgentProfileBackend({
      owner_home,
      env,
      onProfileChange: () => reloads.push('SOUL.md'),
    }),
  })
  cleanups.push(() => mounted.cleanup())

  // Invoke the factory the way installBundledCores does, then drive the
  // real `update_agent_name` / `update_personality` backend methods.
  // The agent_settings factory ignores its context args; cast a minimal stub.
  const factoryCtx = { project_slug: OWNER } as unknown as Parameters<
    NonNullable<(typeof mounted.backends)['agent_settings']>
  >[0]
  const built = (await mounted.backends['agent_settings']!(factoryCtx)) as {
    backend: import('../../../cores/free/agent-settings/index.ts').AgentSettingsBackend
  }
  const nameRes = await built.backend.updateAgentName('Nova')
  expect(nameRes.success).toBe(true)
  expect(nameRes.error).toBeUndefined()
  expect(nameRes.error).not.toBe(SETTINGS_BACKEND_UNAVAILABLE_ERROR)

  const persRes = await built.backend.updatePersonality({
    new_archetype: 'calm strategist',
    new_description: 'precise, warm',
  })
  expect(persRes.success).toBe(true)

  // The change actually landed in the file the PersonaPromptLoader reads,
  // and the composer's persona-reload hook fired.
  const soul = readFileSync(join(owner_home, 'persona', 'SOUL.md'), 'utf8')
  expect(soul).toContain('You are Nova.')
  expect(soul).toContain('calm strategist')
  expect(reloads).toContain('SOUL.md')
})

test('chains the free-Core chat-command filters — /cal and /email are ROUTED', async () => {
  const { db, owner_home, secretsStore, projectCredentialStore, env } = makeBench()
  const mounted = await mountOpenCores({
    projectDb: db,
    owner_home,
    project_slug: OWNER,
    secretsStore,
    projectCredentialStore,
    env,
    substrate: null,
  })
  cleanups.push(() => mounted.cleanup())

  const base = {
    user_id: 'owner',
    project_slug: OWNER,
    channel_topic_id: `web:owner`,
  }

  // /cal → claimed by the Calendar Core (non-null result).
  const cal = await mounted.chatCommandFilter.match({ ...base, body: '/cal help' })
  expect(cal).not.toBeNull()
  expect(typeof cal?.text).toBe('string')

  // /email → claimed by the Email Core.
  const email = await mounted.chatCommandFilter.match({ ...base, body: '/email help' })
  expect(email).not.toBeNull()
  expect(typeof email?.text).toBe('string')

  // /remind → claimed by the Reminders Core (the chain is general, not one-off).
  const remind = await mounted.chatCommandFilter.match({ ...base, body: '/remind me tomorrow' })
  expect(remind).not.toBeNull()

  // Plain prose falls through (null) so it reaches the live agent unchanged.
  const prose = await mounted.chatCommandFilter.match({
    ...base,
    body: 'what is on my calendar today?',
  })
  expect(prose).toBeNull()
})

test('optional-until-credentialed: zero creds → in-memory clients, composes, never throws', async () => {
  const { db, owner_home, secretsStore, projectCredentialStore, env } = makeBench() // env has no Google client id
  const mounted = await mountOpenCores({
    projectDb: db,
    owner_home,
    project_slug: OWNER,
    secretsStore,
    projectCredentialStore,
    env,
    substrate: null,
  })
  cleanups.push(() => mounted.cleanup())

  expect(mounted.oauthConfigured).toBe(false)
  // /cal against the in-memory (empty) calendar still returns a graceful reply.
  const cal = await mounted.chatCommandFilter.match({
    user_id: 'owner',
    project_slug: OWNER,
    channel_topic_id: 'web:owner',
    body: '/cal help',
  })
  expect(cal).not.toBeNull()
})

test('install layer: Google Cores are HIDDEN with no grant, LIVE once the OAuth token exists', async () => {
  // No grant: installBundledCores with the helper's backends + prompter → the
  // Calendar Core's required `google_calendar` secret is unsatisfied, so install
  // fails-soft (hidden) WITHOUT blocking boot. The other Cores still install.
  const a = makeBench()
  const aCores = await mountOpenCores({
    projectDb: a.db,
    owner_home: a.owner_home,
    project_slug: OWNER,
    secretsStore: a.secretsStore,
    projectCredentialStore: a.projectCredentialStore,
    env: a.env,
    substrate: null,
  })
  cleanups.push(() => aCores.cleanup())
  const aResult = await installBundledCores({
    project_slug: OWNER,
    projectDb: a.db,
    dataDir: a.owner_home,
    tools: new ToolRegistry(),
    secretsStore: a.secretsStore,
    rootDirs: [REPO_ROOT],
    backends: aCores.backends,
    prompter: aCores.prompter,
  })
  expect(aResult.installed.has('calendar_core')).toBe(false)
  expect(aResult.failures.some((f) => f.core_slug === 'calendar_core')).toBe(true)

  // With a connected grant: seed the `google_calendar` oauth_token in the store,
  // then install → the prompter surfaces it and the Calendar Core installs LIVE.
  const b = makeBench()
  await b.secretsStore.put({
    internal_handle: OWNER,
    kind: 'oauth_token',
    label: 'google_calendar',
    plaintext: 'access-token',
    expires_at: Date.now() + 3_600_000,
  })
  const bCores = await mountOpenCores({
    projectDb: b.db,
    owner_home: b.owner_home,
    project_slug: OWNER,
    secretsStore: b.secretsStore,
    projectCredentialStore: b.projectCredentialStore,
    env: b.env,
    substrate: null,
  })
  cleanups.push(() => bCores.cleanup())
  const bResult = await installBundledCores({
    project_slug: OWNER,
    projectDb: b.db,
    dataDir: b.owner_home,
    tools: new ToolRegistry(),
    secretsStore: b.secretsStore,
    rootDirs: [REPO_ROOT],
    backends: bCores.backends,
    prompter: bCores.prompter,
  })
  expect(bResult.installed.has('calendar_core')).toBe(true)
})

test('with Google OAuth client configured → oauthConfigured flips true (live-cred path)', async () => {
  const { db, owner_home, secretsStore, projectCredentialStore } = makeBench()
  const env: NodeJS.ProcessEnv = {
    [GOOGLE_CLIENT_ID_ENV]: 'test-client-id.apps.googleusercontent.com',
    NEUTRON_CORES_GOOGLE_CLIENT_SECRET: 'test-secret',
  }
  const mounted = await mountOpenCores({
    projectDb: db,
    owner_home,
    project_slug: OWNER,
    secretsStore,
    projectCredentialStore,
    env,
    substrate: null,
  })
  cleanups.push(() => mounted.cleanup())

  expect(mounted.oauthConfigured).toBe(true)
  // Still boots + routes even though no grant is connected yet (the Google
  // client treats a null access token as "not connected", never a hard error).
  const cal = await mounted.chatCommandFilter.match({
    user_id: 'owner',
    project_slug: OWNER,
    channel_topic_id: 'web:owner',
    body: '/cal help',
  })
  expect(cal).not.toBeNull()
})
