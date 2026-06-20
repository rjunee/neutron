import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Database } from 'bun:sqlite'

import {
  CoreInstallationsStore,
  SecretAuditLog,
  buildBundledRegistry,
  installCore,
  uninstallCore,
  type SecretsPrompter,
} from '@neutronai/cores-runtime'

import { applyMigrations } from '../../../../migrations/runner.ts'
import { ProjectDb } from '../../../../persistence/index.ts'
import { SecretsStore } from '../../../../auth/secrets-store.ts'

import {
  CORE_PACKAGE_NAME,
  CORE_SLUG,
  loadManifest,
} from '../src/manifest.ts'
import { NotesStoreResolver } from '../src/store-resolver.ts'

/**
 * The Notes Core source on disk lives at
 * `<repo-root>/cores/free/notes/`. Tests need to install the Core via
 * the runtime lifecycle, which reads from a `<coreDir>/package.json`.
 * We copy the Notes Core directory (package.json + src/ + index.ts)
 * into a tmp fixture so each test runs against an isolated rootDir
 * the bundled-Core registry can walk.
 */
const HERE = dirname(fileURLToPath(import.meta.url))
const NOTES_SRC_DIR = join(HERE, '..')

class NoopPrompter implements SecretsPrompter {
  async promptApiKey(): Promise<string | null> {
    return null
  }
  async promptOauthToken(): Promise<{ access_token: string; expires_at?: number } | null> {
    return null
  }
  async promptOauthClient(): Promise<{ client_id: string; client_secret: string } | null> {
    return null
  }
}

interface TestEnv {
  tmp: string
  projectDb: ProjectDb
  dataDir: string
  secretsStore: SecretsStore
  audit: SecretAuditLog
  installations: CoreInstallationsStore
}

let env: TestEnv

beforeEach(() => {
  const tmp = mkdtempSync(join(tmpdir(), 'notes-install-'))
  const dataDir = join(tmp, 'data')
  mkdirSync(dataDir, { recursive: true })
  const dbPath = join(dataDir, 'project.db')
  const raw = new Database(dbPath, { create: true })
  applyMigrations(raw)
  raw.close()
  const projectDb = ProjectDb.open(dbPath)
  const secretsStore = new SecretsStore({ data_dir: dataDir, db: projectDb })
  const audit = new SecretAuditLog({ db: projectDb })
  const installations = new CoreInstallationsStore({ db: projectDb })
  env = { tmp, projectDb, dataDir, secretsStore, audit, installations }
})

afterEach(() => {
  env.projectDb.close()
  rmSync(env.tmp, { recursive: true, force: true })
})

function copyNotesIntoFixture(fixtureRoot: string, mountedAs = 'notes'): string {
  const dest = join(fixtureRoot, 'cores', mountedAs)
  mkdirSync(dirname(dest), { recursive: true })
  cpSync(NOTES_SRC_DIR, dest, {
    recursive: true,
    filter: (src) => {
      // Skip __tests__ + node_modules so the bundled-registry walk
      // doesn't try to validate test files. The Core's runtime entry
      // points (index.ts, src/*, package.json) are copied verbatim.
      if (src.endsWith('__tests__')) return false
      if (src.endsWith('node_modules')) return false
      return true
    },
  })
  return dest
}

describe('install lifecycle — Notes Core round-trip', () => {
  test('installCore: validates manifest, allocates notes.db sidecar, records core_installations row', async () => {
    const coreDir = copyNotesIntoFixture(env.tmp)
    const prompter = new NoopPrompter()
    const result = await installCore({
      project_slug: 'owner_a',
      coreDir,
      projectDb: env.projectDb,
      dataDir: env.dataDir,
      secretsStore: env.secretsStore,
      audit: env.audit,
      installations: env.installations,
      prompter,
    })

    expect(result.core.slug).toBe(CORE_SLUG)
    expect(result.core.package_name).toBe(CORE_PACKAGE_NAME)
    expect(result.namespace.layout).toBe('sidecar')
    if (result.namespace.layout === 'sidecar') {
      expect(result.namespace.sidecar_db_path).toContain('cores/notes.db')
      // Close the sidecar so the afterEach rmSync isn't blocked on
      // an open WAL handle.
      result.namespace.sidecar_db.close()
    }
    expect(result.installation.uninstalled_at).toBeNull()
    expect(result.installation.data_layout).toBe('sidecar')

    // Notes declares zero secrets — no secrets prompts must fire.
    const rows = await env.audit.list({
      project_slug: 'owner_a',
      core_slug: CORE_SLUG,
    })
    expect(rows.filter((r) => r.op === 'put')).toHaveLength(0)
  })

  test('installCore + uninstallCore round-trip cleans up sidecar + marks row uninstalled', async () => {
    const coreDir = copyNotesIntoFixture(env.tmp)
    const prompter = new NoopPrompter()
    const installed = await installCore({
      project_slug: 'owner_b',
      coreDir,
      projectDb: env.projectDb,
      dataDir: env.dataDir,
      secretsStore: env.secretsStore,
      audit: env.audit,
      installations: env.installations,
      prompter,
    })
    if (installed.namespace.layout === 'sidecar') {
      installed.namespace.sidecar_db.close()
    }

    await uninstallCore({
      project_slug: 'owner_b',
      core_slug: CORE_SLUG,
      projectDb: env.projectDb,
      dataDir: env.dataDir,
      secretsStore: env.secretsStore,
      audit: env.audit,
      installations: env.installations,
    })

    const after = await env.installations.get('owner_b', CORE_SLUG)
    expect(after).not.toBeNull()
    expect(after?.uninstalled_at).not.toBeNull()
  })
})

describe('bundled registry — Notes Core discovery', () => {
  test('buildBundledRegistry against a single-root layout discovers Notes', () => {
    // Lay the Notes Core out under a tmp root's `cores/<slug>/` so
    // the single-root registry walk picks it up. This is the
    // existing single-root API; the multi-root API lands in PR #139.
    const root = env.tmp
    copyNotesIntoFixture(root)

    const reg = buildBundledRegistry({ rootDir: root })
    const slugs = reg.list().map((c) => c.slug).sort()
    expect(slugs).toContain('notes')
    const notes = reg.get('notes')
    expect(notes?.package_name).toBe(CORE_PACKAGE_NAME)
    expect(notes?.manifest.capabilities).toContain('write:notes.db')
    expect(notes?.manifest.capabilities).toContain('read:notes.db')
  })

  test('Notes coexists with another bundled Core under the same registry root', () => {
    // Forward-compat smoke: when the runtime's bundled-Core registry
    // is booted from a root that ALSO contains another Core (today
    // the monorepo's `cores/dtc-analytics`, tomorrow's
    // `cores/free/<sibling>` Cores after PR #139 multi-root lands),
    // Notes loads alongside it without slug or manifest collisions.
    // We emulate that here by writing both Notes and a synthetic
    // sibling Core into the same fixture root.
    const root = env.tmp
    copyNotesIntoFixture(root)

    // Synthetic sibling Core — small inline manifest so the test stays
    // self-contained.
    const sibling = join(root, 'cores', 'tasks-stub')
    mkdirSync(sibling, { recursive: true })
    const siblingManifest = {
      capabilities: ['read:project.db'],
      tier_support: ['regular'],
      tools: [],
      ui_components: [],
      billing_hooks: [],
      linked_sources: [],
      secrets: [],
      compat: { coreApi: '^0.1.0' },
      build: { neutronVersion: '0.1.0' },
    }
    const siblingPkg = {
      name: '@neutronai/tasks-stub',
      version: '0.0.0',
      type: 'module',
      neutron: siblingManifest,
    }
    require('node:fs').writeFileSync(
      join(sibling, 'package.json'),
      JSON.stringify(siblingPkg),
    )

    const reg = buildBundledRegistry({ rootDir: root })
    const slugs = reg.list().map((c) => c.slug).sort()
    // Both Cores resolve; the registry is deterministic about lookup.
    expect(slugs).toContain('notes')
    expect(slugs).toContain('tasks_stub')
    expect(reg.get('notes')?.package_name).toBe(CORE_PACKAGE_NAME)
    expect(reg.get('tasks_stub')?.package_name).toBe('@neutronai/tasks-stub')
  })
})

describe('loadManifest pulls the package.json shipped on disk', () => {
  test('the shipped package.json validates clean against the runtime loader', () => {
    // Belt-and-suspenders: `loadManifest()` should validate the file
    // the registry test above also reads. If a future edit drifts the
    // capabilities[] or tools[] block out of shape, this test fails
    // BEFORE the registry test does — surfacing the cause directly.
    expect(() => loadManifest()).not.toThrow()
  })

  test('the eight tool names + four capabilities are declared', () => {
    const m = loadManifest()
    const names = new Set(m.tools.map((t) => t.name))
    expect(names.has('notes_write')).toBe(true)
    expect(names.has('notes_recall')).toBe(true)
    expect(names.has('notes_list')).toBe(true)
    expect(names.has('notes_link')).toBe(true)
    expect(names.has('notes_create_drawer')).toBe(true)
    expect(names.has('notes_drawer_list')).toBe(true)
    expect(names.has('notes_search')).toBe(true)
    expect(names.has('notes_traverse')).toBe(true)
    expect(m.capabilities).toContain('read:notes.db')
    expect(m.capabilities).toContain('write:notes.db')
    expect(m.capabilities).toContain('read:notes.fts')
    expect(m.capabilities).toContain('write:notes.fts')
  })
})

describe('per-project storage — Notes Core S1', () => {
  test('NotesStoreResolver writes to <owner_home>/Projects/<id>/notes/notes.db', async () => {
    // Instance home is `env.tmp` here so the per-project sidecar lands
    // at `<env.tmp>/Projects/<id>/notes/notes.db`. This is the path
    // the brief mandates and the gateway resolver pulls from
    // `resolveOwnerHome(process.env)` in production.
    const resolver = new NotesStoreResolver({ owner_home: env.tmp })
    const store = await resolver.resolve('demo-proj')
    expect(store.project_id).toBe('demo-proj')
    expect(resolver.pathFor('demo-proj')).toContain('Projects/demo-proj/notes/notes.db')
    const result = store.write({ content: 'first per-project note' })
    expect(typeof result.id).toBe('string')
    expect(store.listNotes()).toHaveLength(1)
    resolver.closeAll()
  })
})
