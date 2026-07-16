import { asOwnerHandle } from '@neutronai/persistence/index.ts'
/**
 * Sprint 31 — P3 Cores runtime behavioral spec.
 *
 * End-to-end fixture exercising the install → tool-call → audit row →
 * uninstall path against a synthetic Core.  Must hold green to claim
 * Sprint 31 as shipped:
 *
 *  1. Migration 0021 lands `secret_audit_log` + `core_installations`.
 *  2. The runtime composes loader + namespace + audit + capability-guard.
 *  3. A synthetic Core can be installed from a local directory.
 *  4. A wrapped tool handler dispatches when capability declared, denies
 *     when not, and writes the audit row in either case.
 *  5. SecretsAccessor capability-gates against the manifest.
 *  6. uninstallCore drops the Core's tables, deletes its secrets, and
 *     marks the install row uninstalled.
 *
 *  The test bootstraps a real instance DB + real platform SecretsStore so
 *  the integration is end-to-end, not stubbed.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { SecretsStore } from '@neutronai/auth/secrets-store.ts'

import {
  CapabilityDeniedError,
  CapabilityGuard,
  CoreInstallationsStore,
  SecretAuditLog,
  installCore,
  runScopedSql,
  uninstallCore,
  type SecretsPrompter,
} from '@neutronai/cores-runtime/index.ts'

let tmp: string
let dataDir: string
let projectDb: ProjectDb
let secretsStore: SecretsStore
let audit: SecretAuditLog
let installs: CoreInstallationsStore

const OWNER = asOwnerHandle('owner-zero')

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'sprint-31-spec-'))
  dataDir = join(tmp, 'owner')
  mkdirSync(dataDir, { recursive: true })
  const dbPath = join(dataDir, 'owner.db')
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

const SYNTHETIC_MANIFEST = {
  capabilities: ['read:project.db', 'write:project.db'],
  tier_support: ['regular'],
  tools: [
    {
      name: 'list_things',
      description: 'list tracked things',
      input_schema: { type: 'object' },
      output_schema: { type: 'object' },
      capability_required: 'read:project.db',
    },
    {
      name: 'persist_thing',
      description: 'write a thing',
      input_schema: { type: 'object' },
      output_schema: { type: 'object' },
      capability_required: 'write:project.db',
    },
  ],
  ui_components: [],
  billing_hooks: [],
  linked_sources: [],
  secrets: [
    {
      name: 'sendgrid_api_key',
      kind: 'byo_api_key',
      label: 'sendgrid',
      required: true,
      install_prompt: 'Paste a SendGrid API key.',
    },
  ],
  compat: { coreApi: '^0.1.0' },
  build: { neutronVersion: '0.1.0' },
}

class TestPrompter implements SecretsPrompter {
  async promptApiKey(): Promise<string | null> { return 'sg.test-token' }
  async promptOauthToken(): Promise<{ access_token: string; expires_at?: number } | null> {
    return { access_token: 'oauth-test', expires_at: Date.now() + 60_000 }
  }
  async promptOauthClient(): Promise<{ client_id: string; client_secret: string } | null> {
    return { client_id: 'cid', client_secret: 'csec' }
  }
}

test('Sprint 31 — synthetic Core install → tool call → audit → uninstall', async () => {
  // 0. Bootstrap a Core directory on disk.
  const coreDir = join(tmp, 'synthetic-core')
  mkdirSync(coreDir, { recursive: true })
  writeFileSync(
    join(coreDir, 'package.json'),
    JSON.stringify({
      name: '@neutronai/synthetic',
      version: '0.1.0',
      type: 'module',
      neutron: SYNTHETIC_MANIFEST,
    }),
  )

  // 1. Install — drives loader + namespace + secrets prompt.
  const prompter = new TestPrompter()
  const installed = await installCore({
    project_slug: OWNER, coreDir,
    projectDb, dataDir, secretsStore, audit, installations: installs, prompter,
  })
  expect(installed.core.slug).toBe('synthetic')
  expect(installed.namespace.layout).toBe('tables')
  expect(installed.installation.uninstalled_at).toBeNull()
  expect(installed.installation.capabilities).toEqual(['read:project.db', 'write:project.db'])

  // The install row is persisted.
  const row = await installs.get(OWNER, 'synthetic')
  expect(row?.package_version).toBe('0.1.0')

  // The secret was persisted via the prompter + a put audit row landed.
  expect(await secretsStore.get({ owner_handle: OWNER, kind: 'byo_api_key', label: 'sendgrid',
  })).toBe('sg.test-token')
  const installAudits = await audit.list({ project_slug: OWNER, core_slug: 'synthetic' })
  expect(installAudits.find((a) => a.op === 'put' && a.label === 'sendgrid' && a.outcome === 'ok')).toBeDefined()

  // 2. SecretsAccessor capability gate — declared OK, undeclared denied.
  expect(await installed.secrets_accessor.get('byo_api_key', 'sendgrid')).toBe('sg.test-token')
  await expect(
    installed.secrets_accessor.get('byo_api_key', 'shopify-undeclared'),
  ).rejects.toThrow(/did not declare secret/)

  // The Cores-runtime audit log saw the SDK-side gate-passing get (the
  // wrapped store wrote a row). Specifically, the byo_api_key/sendgrid
  // get audited as 'ok'.
  const afterAccessAudits = await audit.list({ project_slug: OWNER, core_slug: 'synthetic' })
  expect(afterAccessAudits.find((a) =>
    a.op === 'get' && a.kind === 'byo_api_key' && a.label === 'sendgrid' && a.outcome === 'ok',
  )).toBeDefined()

  // 3. CapabilityGuard exercise on a wrapped tool handler.
  const guard = new CapabilityGuard({
    manifest: installed.core.manifest, core_slug: installed.core.slug,
    project_slug: OWNER, audit,
  })
  const listThings = guard.wrapToolHandler({
    tool_name: 'list_things',
    capability_required: 'read:project.db',
    fn: async (_input: { limit: number }) => ({ items: [], count: 0 }),
  })
  const result = await listThings({ limit: 10 })
  expect(result.count).toBe(0)
  // Audit row landed with outcome=ok.
  const okRow = (await audit.list({ project_slug: OWNER, core_slug: 'synthetic' }))
    .find((a) => a.op === 'tool_call' && a.label === 'list_things' && a.outcome === 'ok')
  expect(okRow).toBeDefined()

  // 3b. An undeclared tool → CapabilityDeniedError + denied audit row.
  const rogue = guard.wrapToolHandler({
    tool_name: 'rogue_tool',
    capability_required: 'read:project.db',
    fn: async () => ({ x: 1 }),
  })
  await expect(rogue({})).rejects.toThrow(CapabilityDeniedError)
  const deniedRow = (await audit.list({ project_slug: OWNER, core_slug: 'synthetic' }))
    .find((a) => a.op === 'tool_call' && a.label === 'rogue_tool' && a.outcome === 'capability_denied')
  expect(deniedRow).toBeDefined()

  // 4. Per-Core data namespace exercise — runScopedSql accepts own prefix.
  await runScopedSql({
    sql: 'CREATE TABLE core_synthetic_things (id TEXT PRIMARY KEY, label TEXT)',
    params: [],
    slug: 'synthetic',
    manifest_capabilities: installed.core.manifest.capabilities,
    projectDb,
  })
  await runScopedSql({
    sql: 'INSERT INTO core_synthetic_things (id, label) VALUES (?, ?)',
    params: ['t1', 'first'],
    slug: 'synthetic',
    manifest_capabilities: installed.core.manifest.capabilities,
    projectDb,
  })
  const things = projectDb.raw().query<{ id: string; label: string }, []>(
    'SELECT id, label FROM core_synthetic_things',
  ).all()
  expect(things).toHaveLength(1)
  expect(things[0]?.id).toBe('t1')

  // 4b. runScopedSql refuses cross-Core access.
  await expect(
    runScopedSql({
      sql: 'SELECT * FROM core_other_secret_table',
      params: [],
      slug: 'synthetic',
      manifest_capabilities: installed.core.manifest.capabilities,
      other_core_slugs: ['other'],
      projectDb,
    }),
  ).rejects.toThrow(expect.objectContaining({ code: 'sql_namespace_violation' }))

  // 5. Uninstall — drops core_synthetic_* tables, deletes secret, marks row uninstalled.
  const revoked: Array<{ kind: string; label: string }> = []
  await uninstallCore({
    project_slug: OWNER, core_slug: 'synthetic',
    projectDb, dataDir, secretsStore, audit, installations: installs,
    revokeOAuth: async (s) => { revoked.push(s) },
  })

  // Tables gone.
  const remaining = projectDb.raw().query<{ name: string }, []>(
    `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'core_synthetic_%'`,
  ).all()
  expect(remaining).toHaveLength(0)

  // Secret gone.
  expect(await secretsStore.get({ owner_handle: OWNER, kind: 'byo_api_key', label: 'sendgrid',
  })).toBeNull()

  // revokeOAuth fired for the byo_api_key (best-effort across all kinds).
  expect(revoked.some((r) => r.label === 'sendgrid')).toBe(true)

  // Install row is now soft-deleted.
  const finalRow = await installs.get(OWNER, 'synthetic')
  expect(finalRow?.uninstalled_at).not.toBeNull()

  // Final audit-log shape: exactly one capability_denied row + at least one
  // tool_call=ok + at least one secret put + delete entry.
  const finalAudits = await audit.list({ project_slug: OWNER, core_slug: 'synthetic', limit: 200 })
  expect(finalAudits.filter((a) => a.outcome === 'capability_denied')).toHaveLength(1)
  expect(finalAudits.find((a) => a.op === 'tool_call' && a.outcome === 'ok')).toBeDefined()
  expect(finalAudits.find((a) => a.op === 'put' && a.label === 'sendgrid' && a.outcome === 'ok')).toBeDefined()
  expect(finalAudits.find((a) => a.op === 'delete' && a.label === 'sendgrid' && a.outcome === 'ok')).toBeDefined()
})
