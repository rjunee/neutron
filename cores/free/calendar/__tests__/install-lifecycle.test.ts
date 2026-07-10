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
 * Calendar Core lives at `<repo-root>/cores/free/calendar/`. The
 * runtime lifecycle reads `<coreDir>/package.json`; the bundled
 * registry walk resolves a Core's slug + manifest by reading the same
 * file. Each test copies the directory into a tmp fixture so the
 * lifecycle / registry walks run against an isolated rootDir with no
 * cross-test contamination.
 */
const HERE = dirname(fileURLToPath(import.meta.url))
const CALENDAR_SRC_DIR = join(HERE, '..')

/**
 * Prompter that satisfies the required OAuth secret with a fixed
 * access token. Used by the happy-path install test; the
 * missing-token test uses the shared `NoopPrompter` that returns null.
 */
class GoogleOauthPrompter implements SecretsPrompter {
  constructor(private readonly access_token: string = 'ya29.fake-test-token') {}
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
  env = createInstallLifecycleEnv('calendar-core-install-')
})

afterEach(() => {
  destroyInstallLifecycleEnv(env)
})

function copyCalendarIntoFixture(
  fixtureRoot: string,
  mountedAs = 'calendar_core',
): string {
  return copyCoreIntoFixture(CALENDAR_SRC_DIR, fixtureRoot, mountedAs)
}

describe('install lifecycle — Calendar Core happy path', () => {
  test('installCore prompts for and persists the required Google Calendar OAuth token', async () => {
    const coreDir = copyCalendarIntoFixture(env.tmp)
    const prompter = new GoogleOauthPrompter('ya29.test-access')
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
    // Calendar Core delegates persistence to Google; the capabilities
    // declare `read:/write:calendar_core.events`, not `.db`-suffixed.
    // The runtime's `decideDataLayout` therefore falls through to the
    // 'tables' layout (with no tables actually created).
    expect(result.namespace.layout).toBe('tables')
    expect(result.installation.uninstalled_at).toBeNull()
    expect(result.installation.data_layout).toBe('tables')

    // Exactly one audit `put` row — for the OAuth token.
    const rows = await env.audit.list({
      project_slug: 'owner_a',
      core_slug: CORE_SLUG,
    })
    const puts = rows.filter((r) => r.op === 'put')
    expect(puts).toHaveLength(1)
    expect(puts[0]?.kind).toBe('oauth_token')
    expect(puts[0]?.label).toBe(OAUTH_SECRET_LABEL)
    expect(puts[0]?.outcome).toBe('ok')

    // Persisted via the platform store — the live token is readable.
    const stored = await env.secretsStore.list({
      internal_handle: 'owner_a',
      kind: 'oauth_token',
    })
    expect(stored.length).toBe(1)
    expect(stored[0]?.label).toBe(OAUTH_SECRET_LABEL)
  })

  test('installCore + uninstallCore round-trip marks row uninstalled + clears secret', async () => {
    const coreDir = copyCalendarIntoFixture(env.tmp)
    const prompter = new GoogleOauthPrompter()
    await installCore({
      project_slug: 'owner_b',
      coreDir,
      projectDb: env.projectDb,
      dataDir: env.dataDir,
      secretsStore: env.secretsStore,
      audit: env.audit,
      installations: env.installations,
      prompter,
    })

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

    // Secret deleted as part of uninstall.
    const stored = await env.secretsStore.list({
      internal_handle: 'owner_b',
      kind: 'oauth_token',
    })
    expect(stored.find((r) => r.label === OAUTH_SECRET_LABEL)).toBeUndefined()

    // Audit log includes the delete row.
    const rows = await env.audit.list({
      project_slug: 'owner_b',
      core_slug: CORE_SLUG,
    })
    const deletes = rows.filter((r) => r.op === 'delete')
    expect(deletes.length).toBeGreaterThanOrEqual(1)
  })
})

describe('install lifecycle — Calendar Core OAuth gating', () => {
  test('installCore aborts with CoreInstallError when the required OAuth secret is not provided', async () => {
    const coreDir = copyCalendarIntoFixture(env.tmp)
    const prompter = new NoopPrompter()

    let caught: unknown
    try {
      await installCore({
        project_slug: 'owner_c',
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
    // The runtime composer interprets this as "re-prompt for OAuth
    // consent"; the test asserts the typed code so a regression that
    // softened required→optional would surface immediately.
  })

  test('Calendar Core S1: reinstallFailedCore round-trip via SecretsStorePrompter', async () => {
    // The PR #210 substrate: an instance boots under NoopPrompter →
    // install fails with manifest_invalid; the Cores OAuth surface
    // /ingest handler writes the secret directly via
    // `SecretsStore.put`; the surface then calls `reinstallFailedCore`
    // with a `SecretsStorePrompter` reading the just-written row.
    // Assert the slug moves from `state.failures` → `state.installed`.
    const { reinstallFailedCore, SecretsStorePrompter, installBundledCores } =
      await import('@neutronai/gateway/cores/install-bundled.ts')
    const { ToolRegistry } = await import('@neutronai/tools/registry.ts')

    const tools = new ToolRegistry()

    // 1. Boot the bundled install pipeline against a NoopPrompter →
    //    expect Calendar Core in `failures`.
    const root = env.tmp
    copyCalendarIntoFixture(root)
    const state = await installBundledCores({
      project_slug: 'owner_reinstall',
      projectDb: env.projectDb,
      dataDir: env.dataDir,
      tools,
      secretsStore: env.secretsStore,
      rootDirs: [root],
      // No prompter — defaults to NoopPrompter that returns null.
      hardFailFailureRatio: 1, // disable the failure-rate gate so the test
                               // only asserts the specific slug's failure.
    })
    expect(state.failures.some((f) => f.core_slug === CORE_SLUG)).toBe(true)
    expect(state.installed.has(CORE_SLUG)).toBe(false)

    // 2. Write the OAuth secret directly via SecretsStore.put — the
    //    same shape `cores-oauth-surface.ts:/ingest` would after the
    //    Google token exchange.
    await env.secretsStore.put({
      internal_handle: 'owner_reinstall',
      kind: 'oauth_token',
      label: OAUTH_SECRET_LABEL,
      plaintext: 'ya29.fake-test-token',
      expires_at: Date.now() + 3600_000,
    })

    // 3. Invoke `reinstallFailedCore`.
    const result = await reinstallFailedCore({
      slug: CORE_SLUG,
      state,
      project_slug: 'owner_reinstall',
      projectDb: env.projectDb,
      dataDir: env.dataDir,
      tools,
      secretsStore: env.secretsStore,
      prompter: new SecretsStorePrompter({
        secretsStore: env.secretsStore,
        project_slug: 'owner_reinstall',
      }),
    })

    expect(result.updated).toBe(true)
    expect(state.failures.some((f) => f.core_slug === CORE_SLUG)).toBe(false)
    expect(state.installed.has(CORE_SLUG)).toBe(true)
  })
})

describe('bundled registry — Calendar Core discovery', () => {
  test('buildBundledRegistry against a single-root layout discovers Calendar Core', () => {
    const root = env.tmp
    copyCalendarIntoFixture(root)

    const reg = buildBundledRegistry({ rootDir: root })
    const slugs = reg.list().map((c) => c.slug).sort()
    expect(slugs).toContain('calendar_core')
    const cal = reg.get('calendar_core')
    expect(cal?.package_name).toBe(CORE_PACKAGE_NAME)
    expect(cal?.manifest.capabilities).toContain('write:calendar_core.events')
    expect(cal?.manifest.capabilities).toContain('read:calendar_core.events')
    expect(cal?.manifest.tools.map((t) => t.name).sort()).toEqual([
      'calendar_brief',
      'calendar_cancel',
      'calendar_create',
      'calendar_find_time',
      'calendar_freebusy',
      'calendar_invite',
      'calendar_list',
      'calendar_send_pre_meeting_brief',
      'calendar_update',
    ])
    // Exactly one required OAuth secret.
    expect(cal?.manifest.secrets).toHaveLength(1)
    expect(cal?.manifest.secrets[0]?.required).toBe(true)
  })

  test('Calendar coexists with another bundled Core under the same registry root', () => {
    // Forward-compat smoke: when the runtime's bundled-Core registry
    // is booted from a root that ALSO contains another Core (today
    // the monorepo's sibling `cores/free/*` Cores, tomorrow's
    // managed Cores), Calendar loads alongside it without slug or
    // manifest collisions.
    const root = env.tmp
    copyCalendarIntoFixture(root)

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
    expect(slugs).toContain('calendar_core')
    expect(slugs).toContain('sibling_stub')
  })
})

describe('loadManifest pulls the package.json shipped on disk', () => {
  test('the shipped package.json validates clean against the runtime loader', () => {
    expect(() => loadManifest()).not.toThrow()
  })
})
