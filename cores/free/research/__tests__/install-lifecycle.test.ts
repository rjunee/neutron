import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
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

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { SecretsStore } from '@neutronai/auth/secrets-store.ts'

import {
  CORE_PACKAGE_NAME,
  CORE_SLUG,
  loadManifest,
} from '../src/manifest.ts'

/**
 * The Research Core source on disk lives at
 * `<repo-root>/cores/free/research/`. Tests need to install the Core
 * via the runtime lifecycle, which reads from a
 * `<coreDir>/package.json`. We copy the Research Core directory
 * (package.json + src/ + index.ts) into a tmp fixture so each test
 * runs against an isolated rootDir the bundled-Core registry can walk.
 */
const HERE = dirname(fileURLToPath(import.meta.url))
const RESEARCH_SRC_DIR = join(HERE, '..')

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
  const tmp = mkdtempSync(join(tmpdir(), 'research-core-install-'))
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

function copyResearchIntoFixture(
  fixtureRoot: string,
  mountedAs = 'research_core',
): string {
  const dest = join(fixtureRoot, 'cores', mountedAs)
  mkdirSync(dirname(dest), { recursive: true })
  cpSync(RESEARCH_SRC_DIR, dest, {
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

describe('install lifecycle — Research Core round-trip', () => {
  test('installCore: validates manifest, allocates research_core.db sidecar, records core_installations row', async () => {
    const coreDir = copyResearchIntoFixture(env.tmp)
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
      expect(result.namespace.sidecar_db_path).toContain('cores/research_core.db')
      // Close the sidecar so the afterEach rmSync isn't blocked on
      // an open WAL handle.
      result.namespace.sidecar_db.close()
    }
    expect(result.installation.uninstalled_at).toBeNull()
    expect(result.installation.data_layout).toBe('sidecar')

    // Research declares zero secrets — no secrets prompts must fire.
    const rows = await env.audit.list({
      project_slug: 'owner_a',
      core_slug: CORE_SLUG,
    })
    expect(rows.filter((r) => r.op === 'put')).toHaveLength(0)
  })

  test('installCore + uninstallCore round-trip cleans up sidecar + marks row uninstalled', async () => {
    const coreDir = copyResearchIntoFixture(env.tmp)
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

describe('bundled registry — Research Core discovery', () => {
  test('buildBundledRegistry against a single-root layout discovers Research', () => {
    const root = env.tmp
    copyResearchIntoFixture(root)

    const reg = buildBundledRegistry({ rootDir: root })
    const slugs = reg.list().map((c) => c.slug).sort()
    expect(slugs).toContain(CORE_SLUG)
    const research = reg.get(CORE_SLUG)
    expect(research?.package_name).toBe(CORE_PACKAGE_NAME)
    expect(research?.manifest.capabilities).toContain('write:research_core.db')
    expect(research?.manifest.capabilities).toContain('read:research_core.db')
    expect(research?.manifest.tools.map((t) => t.name).sort()).toEqual([
      'research_cite',
      'research_claims_list',
      'research_deep',
      'research_fetch',
      'research_find',
      'research_list',
      'research_start',
      'research_status',
    ])
  })

  test('Research coexists with another bundled Core under the same registry root', () => {
    // Forward-compat smoke: when the runtime's bundled-Core registry
    // is booted from a root that ALSO contains another Core, Research
    // loads alongside it without slug or manifest collisions.
    const root = env.tmp
    copyResearchIntoFixture(root)

    const sibling = join(root, 'cores', 'sibling-stub')
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
      name: '@neutronai/sibling-stub',
      version: '0.0.0',
      type: 'module',
      neutron: siblingManifest,
    }
    writeFileSync(join(sibling, 'package.json'), JSON.stringify(siblingPkg))

    const reg = buildBundledRegistry({ rootDir: root })
    const slugs = reg.list().map((c) => c.slug).sort()
    expect(slugs).toContain(CORE_SLUG)
    expect(slugs).toContain('sibling_stub')
    expect(reg.get(CORE_SLUG)?.package_name).toBe(CORE_PACKAGE_NAME)
    expect(reg.get('sibling_stub')?.package_name).toBe('@neutronai/sibling-stub')
  })
})

describe('loadManifest pulls the package.json shipped on disk', () => {
  test('the shipped package.json validates clean against the runtime loader', () => {
    expect(() => loadManifest()).not.toThrow()
  })
})
