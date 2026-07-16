import { asOwnerHandle } from '@neutronai/persistence/index.ts'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { SecretsStore } from '@neutronai/auth/secrets-store.ts'

import {
  CoreInstallError,
  CoreInstallationsStore,
  SecretAuditLog,
  installCore,
  installCoreGlobally,
  manifestSupportsScope,
  uninstallCore,
  uninstallCoreGlobally,
  upgradeCore,
  type SecretsPrompter,
} from '../index.ts'

let tmp: string
let projectDb: ProjectDb
let dataDir: string
let secretsStore: SecretsStore
let audit: SecretAuditLog
let installs: CoreInstallationsStore

const OWNER = asOwnerHandle('t1')

function manifestFor(opts: {
  capabilities?: string[]
  secrets?: Array<{ kind: string; label: string; required: boolean; install_prompt?: string }>
  tools?: Array<{ name: string; capability_required: string }>
  install_scopes?: string[]
} = {}): unknown {
  return {
    capabilities: opts.capabilities ?? ['read:project.db'],
    tier_support: ['regular'],
    ...(opts.install_scopes !== undefined ? { install_scopes: opts.install_scopes } : {}),
    tools: (opts.tools ?? []).map((t) => ({
      name: t.name,
      description: 'desc',
      input_schema: { type: 'object' },
      output_schema: { type: 'object' },
      capability_required: t.capability_required,
    })),
    ui_components: [],
    billing_hooks: [],
    linked_sources: [],
    secrets: (opts.secrets ?? []).map((s) => ({
      name: s.label,
      kind: s.kind,
      label: s.label,
      required: s.required,
      install_prompt: s.install_prompt ?? `provide ${s.label}`,
    })),
    compat: { coreApi: '^0.1.0' },
    build: { neutronVersion: '0.1.0' },
  }
}

function writeCorePackage(name: string, manifest: unknown, version = '0.1.0'): string {
  const dir = join(tmp, 'cores', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: `@test/${name}`,
    version,
    type: 'module',
    neutron: manifest,
  }))
  return dir
}

class RecordingPrompter implements SecretsPrompter {
  apiKeys: string[] = []
  oauthTokens: string[] = []
  oauthClients: string[] = []
  apiResponse: string | null = 'paste-token'
  oauthResponse: { access_token: string; expires_at?: number } | null = { access_token: 'oauth-token', expires_at: Date.now() + 60 * 60 * 1000 }
  oauthClientResponse: { client_id: string; client_secret: string } | null = { client_id: 'cid', client_secret: 'csec' }

  async promptApiKey(input: { kind: 'byo_api_key' | 'webhook_secret'; label: string }): Promise<string | null> {
    this.apiKeys.push(`${input.kind}:${input.label}`)
    return this.apiResponse
  }
  async promptOauthToken(input: { kind: 'oauth_token'; label: string }): Promise<{ access_token: string; expires_at?: number } | null> {
    this.oauthTokens.push(input.label)
    return this.oauthResponse
  }
  async promptOauthClient(input: { kind: 'oauth_client'; label: string }): Promise<{ client_id: string; client_secret: string } | null> {
    this.oauthClients.push(input.label)
    return this.oauthClientResponse
  }
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cores-runtime-lifecycle-'))
  dataDir = join(tmp, 'data')
  mkdirSync(dataDir, { recursive: true })
  const dbPath = join(dataDir, 'project.db')
  const raw = new Database(dbPath, { create: true })
  applyMigrations(raw)
  raw.close()
  projectDb = ProjectDb.open(dbPath)
  secretsStore = new SecretsStore({ data_dir: dataDir, db: projectDb })
  audit = new SecretAuditLog({ db: projectDb })
  installs = new CoreInstallationsStore({ db: projectDb })
})

afterEach(() => {
  projectDb.close()
  rmSync(tmp, { recursive: true, force: true })
})

test('installCore: tables-layout no-secrets happy path', async () => {
  const dir = writeCorePackage('tasks', manifestFor({
    tools: [{ name: 'ping', capability_required: 'read:project.db' }],
  }))
  const prompter = new RecordingPrompter()
  const result = await installCore({
    project_slug: OWNER,
    coreDir: dir,
    projectDb, dataDir,
    secretsStore, audit, installations: installs, prompter,
  })
  expect(result.core.slug).toBe('tasks')
  expect(result.namespace.layout).toBe('tables')
  expect(result.installation.uninstalled_at).toBeNull()
  expect(prompter.apiKeys).toHaveLength(0)
  expect(prompter.oauthTokens).toHaveLength(0)
})

test('installCore: sidecar-layout when manifest declares <slug>.db capability', async () => {
  const dir = writeCorePackage('dtc', manifestFor({
    capabilities: ['read:dtc.db', 'write:dtc.db'],
  }))
  const prompter = new RecordingPrompter()
  const result = await installCore({
    project_slug: OWNER,
    coreDir: dir,
    projectDb, dataDir,
    secretsStore, audit, installations: installs, prompter,
  })
  expect(result.namespace.layout).toBe('sidecar')
  expect(result.installation.data_layout).toBe('sidecar')
  if (result.namespace.layout === 'sidecar') {
    result.namespace.sidecar_db.close()
  }
})

test('installCore: prompts for declared secrets + writes audit ok rows', async () => {
  const dir = writeCorePackage('mailer', manifestFor({
    secrets: [
      { kind: 'byo_api_key', label: 'sendgrid', required: true },
      { kind: 'oauth_token', label: 'google', required: true },
    ],
  }))
  const prompter = new RecordingPrompter()
  await installCore({
    project_slug: OWNER,
    coreDir: dir,
    projectDb, dataDir,
    secretsStore, audit, installations: installs, prompter,
  })
  expect(prompter.apiKeys).toContain('byo_api_key:sendgrid')
  expect(prompter.oauthTokens).toContain('google')

  const audits = await audit.list({ project_slug: OWNER, core_slug: 'mailer' })
  expect(audits.find((r) => r.kind === 'byo_api_key' && r.label === 'sendgrid' && r.outcome === 'ok')).toBeDefined()
  expect(audits.find((r) => r.kind === 'oauth_token' && r.label === 'google' && r.outcome === 'ok')).toBeDefined()

  // Round-trip the persisted secret.
  const tok = await secretsStore.get({ internal_handle: OWNER, kind: 'oauth_token', label: 'google' })
  expect(tok).toBe('oauth-token')
})

test('installCore: required secret skipped → CoreInstallError', async () => {
  const dir = writeCorePackage('mailer', manifestFor({
    secrets: [{ kind: 'byo_api_key', label: 'sendgrid', required: true }],
  }))
  const prompter = new RecordingPrompter()
  prompter.apiResponse = null
  await expect(
    installCore({
      project_slug: OWNER,
      coreDir: dir, projectDb, dataDir,
      secretsStore, audit, installations: installs, prompter,
    }),
  ).rejects.toThrow(CoreInstallError)
})

test('installCore: optional secret skipped does not block install', async () => {
  const dir = writeCorePackage('mailer', manifestFor({
    secrets: [{ kind: 'byo_api_key', label: 'sendgrid', required: false }],
  }))
  const prompter = new RecordingPrompter()
  prompter.apiResponse = null
  const result = await installCore({
    project_slug: OWNER,
    coreDir: dir, projectDb, dataDir,
    secretsStore, audit, installations: installs, prompter,
  })
  expect(result.installation.core_slug).toBe('mailer')
})

test('installCore: rejects duplicate live install (same version)', async () => {
  const dir = writeCorePackage('tasks', manifestFor({}))
  const prompter = new RecordingPrompter()
  await installCore({ project_slug: OWNER, coreDir: dir, projectDb, dataDir, secretsStore, audit, installations: installs, prompter })
  await expect(
    installCore({ project_slug: OWNER, coreDir: dir, projectDb, dataDir, secretsStore, audit, installations: installs, prompter }),
  ).rejects.toThrow(expect.objectContaining({ code: 'duplicate_install' }))
})

test('installCore: SecretsAccessor enforces capability gate against undeclared secret', async () => {
  const dir = writeCorePackage('mailer', manifestFor({
    secrets: [{ kind: 'byo_api_key', label: 'sendgrid', required: true }],
  }))
  const prompter = new RecordingPrompter()
  const result = await installCore({
    project_slug: OWNER, coreDir: dir, projectDb, dataDir,
    secretsStore, audit, installations: installs, prompter,
  })
  // Declared (kind, label) → ok.
  expect(await result.secrets_accessor.get('byo_api_key', 'sendgrid')).toBe('paste-token')
  // Undeclared → CapabilityDeniedError.
  await expect(result.secrets_accessor.get('byo_api_key', 'shopify')).rejects.toThrow(/did not declare secret/)
})

test('uninstallCore: drops Core tables, deletes secrets, calls revokeOAuth', async () => {
  const dir = writeCorePackage('mailer', manifestFor({
    capabilities: ['read:project.db', 'write:project.db'],
    secrets: [{ kind: 'oauth_token', label: 'google', required: true }],
  }))
  const prompter = new RecordingPrompter()
  await installCore({ project_slug: OWNER, coreDir: dir, projectDb, dataDir, secretsStore, audit, installations: installs, prompter })

  // Manually create a Core-namespaced table.
  await projectDb.exec('CREATE TABLE core_mailer_log (id TEXT)')

  const revoked: Array<{ kind: string; label: string }> = []
  await uninstallCore({
    project_slug: OWNER, core_slug: 'mailer',
    projectDb, dataDir, secretsStore, audit, installations: installs,
    revokeOAuth: async (s) => { revoked.push(s) },
  })

  // Table dropped.
  const tbl = projectDb.raw().query<{ name: string }, []>(
    `SELECT name FROM sqlite_master WHERE name='core_mailer_log'`,
  ).get()
  expect(tbl).toBeNull()

  // Secret deleted.
  expect(await secretsStore.get({ internal_handle: OWNER, kind: 'oauth_token', label: 'google' })).toBeNull()

  // revokeOAuth invoked at least once for the oauth_token row.
  expect(revoked.some((r) => r.label === 'google')).toBe(true)

  // Install row marked uninstalled.
  const row = await installs.get(OWNER, 'mailer')
  expect(row?.uninstalled_at).not.toBeNull()
})

test('uninstallCore: idempotent on already-uninstalled', async () => {
  const dir = writeCorePackage('tasks', manifestFor({}))
  const prompter = new RecordingPrompter()
  await installCore({ project_slug: OWNER, coreDir: dir, projectDb, dataDir, secretsStore, audit, installations: installs, prompter })
  await uninstallCore({ project_slug: OWNER, core_slug: 'tasks', projectDb, dataDir, secretsStore, audit, installations: installs })
  // Second call → no throw.
  await uninstallCore({ project_slug: OWNER, core_slug: 'tasks', projectDb, dataDir, secretsStore, audit, installations: installs })
})

test('uninstallCore: throws unknown_core when never installed', async () => {
  await expect(
    uninstallCore({
      project_slug: OWNER, core_slug: 'nope',
      projectDb, dataDir, secretsStore, audit, installations: installs,
    }),
  ).rejects.toThrow(expect.objectContaining({ code: 'unknown_core' }))
})

test('upgradeCore: REMOVE-only capability change rolls forward without consent', async () => {
  const dir = writeCorePackage('tasks', manifestFor({
    capabilities: ['read:project.db', 'write:project.db'],
  }))
  const prompter = new RecordingPrompter()
  await installCore({ project_slug: OWNER, coreDir: dir, projectDb, dataDir, secretsStore, audit, installations: installs, prompter })

  // Re-write the package with fewer capabilities (REMOVE) and bumped version.
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: '@test/tasks', version: '0.2.0', type: 'module',
    neutron: manifestFor({ capabilities: ['read:project.db'] }),
  }))

  const result = await upgradeCore({
    project_slug: OWNER, newCoreDir: dir,
    projectDb, dataDir, secretsStore, audit, installations: installs, prompter,
  })
  expect(result.installation.package_version).toBe('0.2.0')
  expect(result.removed_capabilities).toContain('write:project.db')
  expect(result.added_capabilities).toEqual([])
})

test('upgradeCore: ADD without consent → capability_escalation_requires_consent', async () => {
  const dir = writeCorePackage('tasks', manifestFor({
    capabilities: ['read:project.db'],
  }))
  const prompter = new RecordingPrompter()
  await installCore({ project_slug: OWNER, coreDir: dir, projectDb, dataDir, secretsStore, audit, installations: installs, prompter })

  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: '@test/tasks', version: '0.2.0', type: 'module',
    neutron: manifestFor({ capabilities: ['read:project.db', 'write:project.db', 'network:external'] }),
  }))

  await expect(
    upgradeCore({
      project_slug: OWNER, newCoreDir: dir,
      projectDb, dataDir, secretsStore, audit, installations: installs, prompter,
    }),
  ).rejects.toThrow(expect.objectContaining({ code: 'capability_escalation_requires_consent' }))
})

test('upgradeCore: ADD with consent rolls forward + prompts for newly-declared secrets', async () => {
  const dir = writeCorePackage('mailer', manifestFor({
    capabilities: ['read:project.db'],
    secrets: [{ kind: 'byo_api_key', label: 'sendgrid', required: true }],
  }))
  const prompter = new RecordingPrompter()
  await installCore({ project_slug: OWNER, coreDir: dir, projectDb, dataDir, secretsStore, audit, installations: installs, prompter })

  // New manifest adds a capability AND a new secret.
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: '@test/mailer', version: '0.2.0', type: 'module',
    neutron: manifestFor({
      capabilities: ['read:project.db', 'write:project.db'],
      secrets: [
        { kind: 'byo_api_key', label: 'sendgrid', required: true },
        { kind: 'oauth_token', label: 'google', required: true },
      ],
    }),
  }))

  prompter.oauthTokens = []
  prompter.apiKeys = []
  const result = await upgradeCore({
    project_slug: OWNER, newCoreDir: dir,
    projectDb, dataDir, secretsStore, audit, installations: installs, prompter,
    consent_acknowledged: true,
  })
  expect(result.installation.package_version).toBe('0.2.0')
  expect(result.added_capabilities).toContain('write:project.db')

  // Sendgrid was already persisted at install time → NOT re-prompted on upgrade.
  expect(prompter.apiKeys.find((k) => k.endsWith(':sendgrid'))).toBeUndefined()
  // Newly declared google oauth → prompted.
  expect(prompter.oauthTokens).toContain('google')
})

test('upgradeCore: layout change tables→sidecar rejected', async () => {
  const dir = writeCorePackage('tasks', manifestFor({ capabilities: ['read:project.db'] }))
  const prompter = new RecordingPrompter()
  await installCore({ project_slug: OWNER, coreDir: dir, projectDb, dataDir, secretsStore, audit, installations: installs, prompter })

  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: '@test/tasks', version: '0.2.0', type: 'module',
    neutron: manifestFor({ capabilities: ['read:tasks.db', 'write:tasks.db'] }),
  }))

  await expect(
    upgradeCore({
      project_slug: OWNER, newCoreDir: dir,
      projectDb, dataDir, secretsStore, audit, installations: installs, prompter,
      consent_acknowledged: true,
    }),
  ).rejects.toThrow(expect.objectContaining({ code: 'data_layout_change_not_supported' }))
})

// ── GLOBAL install scope (WAVE 3 PR-2) ─────────────────────────────────────

test('manifestSupportsScope: omitted install_scopes ⇒ project-only', () => {
  const manifest = { install_scopes: undefined, capabilities: [] } as never
  expect(manifestSupportsScope(manifest, 'project')).toBe(true)
  expect(manifestSupportsScope(manifest, 'global')).toBe(false)
})

test('installCoreGlobally: records a global install when manifest allows global', async () => {
  const dir = writeCorePackage(
    'admin',
    manifestFor({ install_scopes: ['project', 'global'] }),
  )
  const rec = await installCoreGlobally({ coreDir: dir, installations: installs })
  expect(rec.core_slug).toBe('admin')
  expect(rec.uninstalled_at).toBeNull()
  expect((await installs.listGlobalLive()).map((r) => r.core_slug)).toEqual(['admin'])
  // It does NOT create a per-project row.
  expect(await installs.get(OWNER, 'admin')).toBeNull()
})

test('installCoreGlobally: rejects a Core that does not declare global scope', async () => {
  const dir = writeCorePackage('notes', manifestFor({ install_scopes: ['project'] }))
  await expect(
    installCoreGlobally({ coreDir: dir, installations: installs }),
  ).rejects.toThrow(expect.objectContaining({ code: 'scope_not_supported' }))
  // Default (no install_scopes) is also project-only → rejected.
  const dir2 = writeCorePackage('calendar', manifestFor({}))
  await expect(
    installCoreGlobally({ coreDir: dir2, installations: installs }),
  ).rejects.toThrow(expect.objectContaining({ code: 'scope_not_supported' }))
})

test('installCoreGlobally: refuses a duplicate live global install', async () => {
  const dir = writeCorePackage('admin', manifestFor({ install_scopes: ['global'] }))
  await installCoreGlobally({ coreDir: dir, installations: installs })
  await expect(
    installCoreGlobally({ coreDir: dir, installations: installs }),
  ).rejects.toThrow(expect.objectContaining({ code: 'duplicate_install' }))
})

test('uninstallCoreGlobally: tombstones the install; re-install allowed after', async () => {
  const dir = writeCorePackage('admin', manifestFor({ install_scopes: ['global'] }))
  await installCoreGlobally({ coreDir: dir, installations: installs })
  await uninstallCoreGlobally({ core_slug: 'admin', installations: installs })
  expect(await installs.listGlobalLive()).toHaveLength(0)
  // Re-install works after uninstall.
  await installCoreGlobally({ coreDir: dir, installations: installs })
  expect((await installs.listGlobalLive()).map((r) => r.core_slug)).toEqual(['admin'])
})

test('uninstallCoreGlobally: idempotent no-op for an unknown core', async () => {
  await uninstallCoreGlobally({ core_slug: 'nope', installations: installs })
  expect(await installs.listGlobal()).toHaveLength(0)
})
