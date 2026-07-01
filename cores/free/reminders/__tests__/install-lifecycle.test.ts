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

import { applyMigrations } from '../../../../migrations/runner.ts'
import { ProjectDb } from '../../../../persistence/index.ts'
import { SecretsStore } from '../../../../auth/secrets-store.ts'

import { ReminderStore } from '@neutronai/reminders'

import {
  CORE_PACKAGE_NAME,
  CORE_SLUG,
  loadManifest,
} from '../src/manifest.ts'
import {
  CORE_SOURCE_TAG,
  buildReminderStoreBackend,
  cancelOwnedReminders,
} from '../src/backend.ts'

/**
 * The Reminders Core source on disk lives at
 * `<repo-root>/cores/free/reminders/`. Tests need to install the Core
 * via the runtime lifecycle, which reads from a
 * `<coreDir>/package.json`. We copy the Reminders Core directory
 * (package.json + src/ + index.ts) into a tmp fixture so each test
 * runs against an isolated rootDir the bundled-Core registry can walk.
 */
const HERE = dirname(fileURLToPath(import.meta.url))
const REMINDERS_SRC_DIR = join(HERE, '..')

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
  const tmp = mkdtempSync(join(tmpdir(), 'reminders-install-'))
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

function copyRemindersIntoFixture(fixtureRoot: string, mountedAs = 'reminders'): string {
  const dest = join(fixtureRoot, 'cores', mountedAs)
  mkdirSync(dirname(dest), { recursive: true })
  cpSync(REMINDERS_SRC_DIR, dest, {
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

describe('install lifecycle — Reminders Core round-trip', () => {
  test('installCore: validates manifest, allocates reminders_core.db sidecar, records core_installations row', async () => {
    const coreDir = copyRemindersIntoFixture(env.tmp)
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
      expect(result.namespace.sidecar_db_path).toContain('cores/reminders_core.db')
      // Close the sidecar so the afterEach rmSync isn't blocked on
      // an open WAL handle.
      result.namespace.sidecar_db.close()
    }
    expect(result.installation.uninstalled_at).toBeNull()
    expect(result.installation.data_layout).toBe('sidecar')

    // Reminders declares zero secrets — no secrets prompts must fire.
    const rows = await env.audit.list({
      project_slug: 'owner_a',
      core_slug: CORE_SLUG,
    })
    expect(rows.filter((r) => r.op === 'put')).toHaveLength(0)
  })

  test('installCore + uninstallCore round-trip cleans up sidecar + marks row uninstalled', async () => {
    const coreDir = copyRemindersIntoFixture(env.tmp)
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

  test('cancelOwnedReminders sweeps Core-tagged rows but leaves organic engine rows alone', async () => {
    // Argus r1 BLOCKING fix. The Core piggybacks on the shared engine
    // `reminders` table — without this hook every Core-created row
    // would orphan in `project.db` and KEEP FIRING via the engine's
    // tick loop after the Core is gone. The fix tags each Core write
    // with `source = '@neutronai/reminders-core'` and the sweep scopes
    // on that tag so organic engine writes (gateway reminder agents,
    // wow-moment actions — all of which carry `source = NULL`) are
    // untouched.
    const ownerSlug = 'owner_c'
    const coreDir = copyRemindersIntoFixture(env.tmp)
    const prompter = new NoopPrompter()
    const installed = await installCore({
      project_slug: ownerSlug,
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

    // Two Core-created reminders + one organic engine row.
    const backend = buildReminderStoreBackend({
      project_slug: ownerSlug,
      projectDb: env.projectDb,
    })
    const coreA = await backend.create({ message: 'core-a', fire_at: 1_700_000_001 })
    const coreB = await backend.create({ message: 'core-b', fire_at: 1_700_000_002 })

    // Organic engine write — NO source tag, simulating the gateway's
    // own reminder agent or a wow-moment lifestyle nudge.
    const rawStore = new ReminderStore(env.projectDb)
    const organic = await rawStore.create({
      project_slug: ownerSlug,
      topic_id: null,
      fire_at: 1_700_000_003,
      message: 'organic-engine-row',
    })

    // Pre-sweep: all three are pending; only the Core-tagged ones
    // appear in the source-scoped listing.
    expect(rawStore.get(coreA.id)?.status).toBe('pending')
    expect(rawStore.get(coreB.id)?.status).toBe('pending')
    expect(rawStore.get(organic.id)?.status).toBe('pending')
    expect(rawStore.get(coreA.id)?.source).toBe(CORE_SOURCE_TAG)
    expect(rawStore.get(coreB.id)?.source).toBe(CORE_SOURCE_TAG)
    expect(rawStore.get(organic.id)?.source).toBeNull()
    const ownedBefore = rawStore.listPendingBySource(ownerSlug, CORE_SOURCE_TAG)
    expect(ownedBefore.map((r) => r.id).sort()).toEqual([coreA.id, coreB.id].sort())

    // Sweep.
    const swept = await cancelOwnedReminders({
      project_slug: ownerSlug,
      projectDb: env.projectDb,
    })
    expect(swept.cancelled).toBe(2)

    // Post-sweep: Core-tagged rows are cancelled; organic row is
    // STILL pending (the engine's tick loop must keep firing it).
    expect(rawStore.get(coreA.id)?.status).toBe('cancelled')
    expect(rawStore.get(coreB.id)?.status).toBe('cancelled')
    expect(rawStore.get(organic.id)?.status).toBe('pending')

    // Idempotent — a second sweep finds nothing left.
    const swept2 = await cancelOwnedReminders({
      project_slug: ownerSlug,
      projectDb: env.projectDb,
    })
    expect(swept2.cancelled).toBe(0)

    // Belt-and-suspenders: the engine's own `listDue` for the
    // the owner at a time AFTER every fire_at returns ONLY the organic
    // row — the cancelled Core rows must NOT fire even though their
    // fire_at is in the past. This is the user-visible failure mode
    // the BLOCKING issue named ("reminders keep firing via tick loop
    // after uninstall").
    const due = rawStore.listDue(1_700_001_000)
    expect(due.map((r) => r.id)).toEqual([organic.id])

    // Now run the runtime uninstall (which deletes the sidecar +
    // marks the install row uninstalled). Order matches the README's
    // documented contract: cancelOwnedReminders FIRST, then
    // uninstallCore.
    await uninstallCore({
      project_slug: ownerSlug,
      core_slug: CORE_SLUG,
      projectDb: env.projectDb,
      dataDir: env.dataDir,
      secretsStore: env.secretsStore,
      audit: env.audit,
      installations: env.installations,
    })
    const after = await env.installations.get(ownerSlug, CORE_SLUG)
    expect(after?.uninstalled_at).not.toBeNull()
  })

  test('snooze on an organic engine row preserves NULL source so cancelOwnedReminders leaves it alone', async () => {
    // Argus r2 BLOCKING fix (symmetric inverse of r1). `list()`
    // returns every pending row for the owner — including organic
    // engine rows whose `source` is NULL (gateway reminder-agents,
    // wow-moment lifestyle nudges, interest-check-ins, etc.). Nothing
    // stops a user from `snooze`ing one of those ids. Pre-r3, snooze
    // hardcoded `source: CORE_SOURCE_TAG` on the replacement, so the
    // organic row's replacement got re-tagged as Core-owned and the
    // uninstall sweep would later cancel a reminder the Core never
    // created. The fix preserves `original.source` on the replacement
    // so a snoozed organic row stays organic and the sweep skips it.
    const ownerSlug = 'owner_d'
    const coreDir = copyRemindersIntoFixture(env.tmp)
    const prompter = new NoopPrompter()
    const installed = await installCore({
      project_slug: ownerSlug,
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

    const backend = buildReminderStoreBackend({
      project_slug: ownerSlug,
      projectDb: env.projectDb,
    })

    // Organic engine row: written directly via ReminderStore with no
    // source tag, simulating the gateway's own reminder agents.
    const rawStore = new ReminderStore(env.projectDb)
    const organic = await rawStore.create({
      project_slug: ownerSlug,
      topic_id: null,
      fire_at: 1_700_000_100,
      message: 'organic-engine-row',
    })
    expect(rawStore.get(organic.id)?.source).toBeNull()

    // A Core-created row alongside, to prove the sweep still cancels
    // the Core-owned row in the same pass while leaving the organic
    // replacement untouched.
    const coreOwned = await backend.create({
      message: 'core-owned',
      fire_at: 1_700_000_200,
    })
    expect(rawStore.get(coreOwned.id)?.source).toBe(CORE_SOURCE_TAG)

    // Snooze the organic row via the Core's adapter. The user learned
    // the id from `list()`, which surfaces every pending row for the
    // the owner regardless of source.
    const snoozed = await backend.snooze({
      id: organic.id,
      new_fire_at: 1_700_500_000,
    })

    // Original organic row is cancelled, replacement exists, and
    // CRITICALLY the replacement carries NULL source — NOT
    // CORE_SOURCE_TAG. This is the regression the r2 BLOCKING named.
    expect(rawStore.get(organic.id)?.status).toBe('cancelled')
    const replacement = rawStore.get(snoozed.id)
    expect(replacement).not.toBeNull()
    expect(replacement?.status).toBe('pending')
    expect(replacement?.fire_at).toBe(1_700_500_000)
    expect(replacement?.source).toBeNull()
    expect(replacement?.message).toBe('organic-engine-row')

    // Sweep — must cancel the Core-owned row only. The organic
    // replacement stays pending.
    const swept = await cancelOwnedReminders({
      project_slug: ownerSlug,
      projectDb: env.projectDb,
    })
    expect(swept.cancelled).toBe(1)
    expect(rawStore.get(coreOwned.id)?.status).toBe('cancelled')
    expect(rawStore.get(snoozed.id)?.status).toBe('pending')

    // Belt-and-suspenders: the engine's `listDue` after the sweep at
    // a time past every fire_at returns ONLY the organic replacement
    // — proving the tick loop will keep firing it while the cancelled
    // Core row stays dormant.
    const due = rawStore.listDue(1_700_999_999)
    expect(due.map((r) => r.id)).toEqual([snoozed.id])
  })
})

describe('bundled registry — Reminders Core discovery', () => {
  test('buildBundledRegistry against a single-root layout discovers Reminders', () => {
    // Lay the Reminders Core out under a tmp root's `cores/<slug>/` so
    // the single-root registry walk picks it up.
    const root = env.tmp
    copyRemindersIntoFixture(root)

    const reg = buildBundledRegistry({ rootDir: root })
    const slugs = reg.list().map((c) => c.slug).sort()
    expect(slugs).toContain(CORE_SLUG)
    const reminders = reg.get(CORE_SLUG)
    expect(reminders?.package_name).toBe(CORE_PACKAGE_NAME)
    expect(reminders?.manifest.capabilities).toContain('write:reminders_core.db')
    expect(reminders?.manifest.capabilities).toContain('read:reminders_core.db')
  })

  test('Reminders coexists with another bundled Core under the same registry root', () => {
    // Forward-compat smoke: when the runtime's bundled-Core registry
    // boots from a root that ALSO contains another Core, Reminders
    // loads alongside it without slug or manifest collisions.
    const root = env.tmp
    copyRemindersIntoFixture(root)

    const sibling = join(root, 'cores', 'demo-stub')
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
      name: '@neutronai/demo-stub',
      version: '0.0.0',
      type: 'module',
      neutron: siblingManifest,
    }
    writeFileSync(
      join(sibling, 'package.json'),
      JSON.stringify(siblingPkg),
    )

    const reg = buildBundledRegistry({ rootDir: root })
    const slugs = reg.list().map((c) => c.slug).sort()
    expect(slugs).toContain(CORE_SLUG)
    expect(slugs).toContain('demo_stub')
    expect(reg.get(CORE_SLUG)?.package_name).toBe(CORE_PACKAGE_NAME)
    expect(reg.get('demo_stub')?.package_name).toBe('@neutronai/demo-stub')
  })
})

describe('loadManifest pulls the package.json shipped on disk', () => {
  test('the shipped package.json validates clean against the runtime loader', () => {
    expect(() => loadManifest()).not.toThrow()
  })

  test('S1 — declares 6 tools (5 legacy + reminders_update) and 2 ui_components (launcher_icon + app_tab)', () => {
    const m = loadManifest()
    const toolNames = m.tools.map((t) => t.name).sort()
    expect(toolNames).toEqual(
      [
        'reminders_cancel',
        'reminders_convert_to_task',
        'reminders_create',
        'reminders_list',
        'reminders_snooze',
        'reminders_update',
      ].sort(),
    )
    const surfaces = m.ui_components.map((u) => u.surface).sort()
    expect(new Set(surfaces)).toEqual(new Set(['launcher_icon', 'app_tab']))
  })
})
