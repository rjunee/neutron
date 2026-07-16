import { asOwnerHandle } from '@neutronai/persistence/index.ts'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CoreInstallError,
  buildBundledRegistry,
  installCore,
  uninstallCore,
  type SecretsPrompter,
} from '@neutronai/cores-runtime'
import {
  NoopPrompter,
  copyCoreIntoFixture,
  createInstallLifecycleEnv,
  destroyInstallLifecycleEnv,
  type InstallLifecycleEnv,
} from '@neutronai/cores-runtime/testkit/install-lifecycle.ts'

import {
  CORE_PACKAGE_NAME,
  CORE_SLUG,
  OAUTH_SECRET_LABEL,
  loadManifest,
} from '../src/manifest.ts'

/**
 * Email-Managed Core lives at `<repo-root>/cores/free/email/`.
 * The runtime lifecycle reads `<coreDir>/package.json`; the bundled
 * registry walk resolves a Core's slug + manifest by reading the
 * same file. Each test copies the directory into a tmp fixture so
 * the lifecycle / registry walks run against an isolated rootDir
 * with no cross-test contamination.
 */
const HERE = dirname(fileURLToPath(import.meta.url))
const EMAIL_SRC_DIR = join(HERE, '..')

class GmailOauthPrompter implements SecretsPrompter {
  constructor(private readonly access_token: string = 'ya29.fake-gmail-token') {}
  async promptApiKey(): Promise<string | null> {
    return null
  }
  async promptOauthToken(): Promise<{ access_token: string; expires_at?: number } | null> {
    return { access_token: this.access_token, expires_at: Date.now() + 3600_000 }
  }
  async promptOauthClient(): Promise<{ client_id: string; client_secret: string } | null> {
    return null
  }
}

let env: InstallLifecycleEnv

beforeEach(() => {
  env = createInstallLifecycleEnv('email-managed-core-install-')
})

afterEach(() => {
  destroyInstallLifecycleEnv(env)
})

function copyEmailManagedIntoFixture(
  fixtureRoot: string,
  mountedAs = 'email_managed_core',
): string {
  return copyCoreIntoFixture(EMAIL_SRC_DIR, fixtureRoot, mountedAs)
}

describe('install lifecycle — Email-Managed Core happy path', () => {
  test('installCore prompts for and persists the required Gmail OAuth token', async () => {
    const coreDir = copyEmailManagedIntoFixture(env.tmp)
    const prompter = new GmailOauthPrompter('ya29.test-gmail-access')
    const result = await installCore({
      project_slug: asOwnerHandle('owner_a'),
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
    // Email-Managed Core delegates persistence to Gmail; the
    // capabilities declare `read:email_managed_core.messages` +
    // `write:email_managed_core.drafts`, not `.db`-suffixed. The
    // runtime's `decideDataLayout` therefore falls through to the
    // 'tables' layout (with no tables actually created).
    expect(result.namespace.layout).toBe('tables')
    expect(result.installation.uninstalled_at).toBeNull()
    expect(result.installation.data_layout).toBe('tables')

    // Exactly one audit `put` row — for the OAuth token.
    const rows = await env.audit.list({
      project_slug: asOwnerHandle('owner_a'),
      core_slug: CORE_SLUG,
    })
    const puts = rows.filter((r) => r.op === 'put')
    expect(puts).toHaveLength(1)
    expect(puts[0]?.kind).toBe('oauth_token')
    expect(puts[0]?.label).toBe(OAUTH_SECRET_LABEL)
    expect(puts[0]?.outcome).toBe('ok')

    // Persisted via the platform store — the live token is readable.
    const stored = await env.secretsStore.list({
      owner_handle: asOwnerHandle('owner_a'),
      kind: 'oauth_token',
    })
    expect(stored.length).toBe(1)
    expect(stored[0]?.label).toBe(OAUTH_SECRET_LABEL)
    // Label tracks the OAuth scope honestly — no more
    // `gmail_readonly` overstatement after Codex r1 P1 finding.
    expect(stored[0]?.label).toBe('gmail_compose')
  })

  test('installCore + uninstallCore round-trip marks row uninstalled + clears secret', async () => {
    const coreDir = copyEmailManagedIntoFixture(env.tmp)
    const prompter = new GmailOauthPrompter()
    await installCore({
      project_slug: asOwnerHandle('owner_b'),
      coreDir,
      projectDb: env.projectDb,
      dataDir: env.dataDir,
      secretsStore: env.secretsStore,
      audit: env.audit,
      installations: env.installations,
      prompter,
    })

    await uninstallCore({
      project_slug: asOwnerHandle('owner_b'),
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

    // Secret deleted as part of uninstall.
    const stored = await env.secretsStore.list({
      owner_handle: asOwnerHandle('owner_b'),
      kind: 'oauth_token',
    })
    expect(stored.find((r) => r.label === OAUTH_SECRET_LABEL)).toBeUndefined()

    // Audit log includes the delete row.
    const rows = await env.audit.list({
      project_slug: asOwnerHandle('owner_b'),
      core_slug: CORE_SLUG,
    })
    const deletes = rows.filter((r) => r.op === 'delete')
    expect(deletes.length).toBeGreaterThanOrEqual(1)
  })
})

describe('install lifecycle — Email-Managed Core OAuth gating', () => {
  test('installCore aborts with CoreInstallError when the required OAuth secret is not provided — regression-guards the manifest required:true contract', async () => {
    const coreDir = copyEmailManagedIntoFixture(env.tmp)
    const prompter = new NoopPrompter()

    let caught: unknown
    try {
      await installCore({
        project_slug: asOwnerHandle('owner_c'),
        coreDir,
        projectDb: env.projectDb,
        dataDir: env.dataDir,
        secretsStore: env.secretsStore,
        audit: env.audit,
        installations: env.installations,
        prompter,
      })
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(CoreInstallError)
    expect((caught as CoreInstallError).code).toBe('manifest_invalid')
  })
})

describe('bundled registry — Email-Managed Core discovery', () => {
  test('buildBundledRegistry against a single-root layout discovers Email-Managed Core', () => {
    const root = env.tmp
    copyEmailManagedIntoFixture(root)

    const reg = buildBundledRegistry({ rootDir: root })
    const slugs = reg.list().map((c) => c.slug).sort()
    expect(slugs).toContain('email_managed_core')
    const em = reg.get('email_managed_core')
    expect(em?.package_name).toBe(CORE_PACKAGE_NAME)
    expect(em?.manifest.capabilities).toContain(
      'read:email_managed_core.messages',
    )
    expect(em?.manifest.capabilities).toContain(
      'write:email_managed_core.drafts',
    )
    expect(em?.manifest.tools.map((t) => t.name).sort()).toEqual([
      'email_draft_prepare',
      'email_list',
      'email_read',
      'email_search',
      'email_send',
      'email_summarize',
      'email_thread',
      'email_triage',
    ])
    // Exactly one required OAuth secret carrying the 4-scope grant
    // (readonly + modify + compose + send).
    expect(em?.manifest.secrets).toHaveLength(1)
    expect(em?.manifest.secrets[0]?.required).toBe(true)
    const scope = em?.manifest.secrets[0]?.scope ?? ''
    expect(scope).toContain('https://www.googleapis.com/auth/gmail.readonly')
    expect(scope).toContain('https://www.googleapis.com/auth/gmail.modify')
    expect(scope).toContain('https://www.googleapis.com/auth/gmail.compose')
    // gap-audit P0 (2026-06-20) — gmail.send now part of the grant.
    expect(scope).toContain('https://www.googleapis.com/auth/gmail.send')
  })

  test('Email-Managed coexists with another bundled Core under the same registry root', () => {
    // Forward-compat smoke: a multi-root mount with another Tier 1
    // Core present should also surface Email-Managed.
    const root = env.tmp
    copyEmailManagedIntoFixture(root)

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
    expect(slugs).toContain('email_managed_core')
    expect(slugs).toContain('sibling_stub')
  })
})

describe('loadManifest pulls the package.json shipped on disk', () => {
  test('the shipped package.json validates clean against the runtime loader', () => {
    expect(() => loadManifest()).not.toThrow()
  })
})
