/**
 * X2 — a Core that UNDER-IMPLEMENTS its manifest cannot install
 * silently-broken (acceptance for the typed Core module contract).
 *
 * Drives `installBundledCores` against a synthetic fixture Core
 * (`gateway/__tests__/fixtures/underimpl-root/`) whose manifest declares two
 * tools but whose `buildTools` returns a handler for only one. With a backend
 * factory wired (so the factories actually run), the composer's coverage check
 * must:
 *   - land the Core in `state.failures` with code `manifest_incomplete`,
 *   - NOT list it in `state.installed`, and
 *   - register NEITHER tool in the ToolRegistry (no silent throw-stub for the
 *     missing tool, and the sibling tool is dropped with the failed install).
 *
 * Formerly (ISSUE #330) the missing tool silently became a throwing stub that
 * `/api/cores` advertised as part of the Core's surface. Now it is a surfaced
 * install failure (`install_state: 'failed'` + `install_error`).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { SecretsStore } from '@neutronai/auth/secrets-store.ts'
import { ToolRegistry } from '@neutronai/tools/registry.ts'
import type { ToolCallContext as RegistryToolCallContext } from '@neutronai/tools/registry.ts'
import type { ToolCallContext as SdkToolCallContext } from '@neutronai/cores-sdk'
import { CoreInstallationsStore } from '@neutronai/cores-runtime/installations-store.ts'
import type { SecretsPrompter } from '@neutronai/cores-runtime/lifecycle.ts'
import { installBundledCores, reinstallFailedCore } from '../cores/install-bundled.ts'

const NOOP_PROMPTER: SecretsPrompter = {
  async promptApiKey() {
    return null
  },
  async promptOauthToken() {
    return null
  },
  async promptOauthClient() {
    return null
  },
}

// The fixture root's `cores/synth/underimpl-core/` is discovered by the
// registry's `cores/<container>/<core>` walk. Its barrel resolves
// `@neutronai/cores-sdk` via the worktree node_modules (walking up), so
// `defineCore()` loads for real — unlike a /tmp copy whose node_modules
// symlinks would be broken.
const FIXTURE_ROOT = join(import.meta.dir, 'fixtures', 'underimpl-root')
const UNDERIMPL_SLUG = 'underimpl_core'

interface Bench {
  ownerHome: string
  db: ProjectDb
  secrets: SecretsStore
  tools: ToolRegistry
}

const cleanups: Array<() => void | Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop()!
    await fn()
  }
})

function makeBench(): Bench {
  const ownerHome = mkdtempSync(join(tmpdir(), 'neutron-underimpl-'))
  cleanups.push(() => rmSync(ownerHome, { recursive: true, force: true }))
  const dbDir = join(ownerHome, 'db')
  mkdirSync(dbDir, { recursive: true })
  const dbPath = join(dbDir, 'owner.db')
  const raw = new Database(dbPath, { create: true })
  applyMigrations(raw)
  raw.close()
  const db = ProjectDb.open(dbPath)
  cleanups.push(() => db.close())
  const secrets = new SecretsStore({ data_dir: ownerHome, db })
  const tools = new ToolRegistry()
  return { ownerHome, db, secrets, tools }
}

describe('X2 — under-implementing Core cannot install silently-broken', () => {
  let bench: Bench
  beforeEach(() => {
    bench = makeBench()
  })

  test('backend wired + manifest tool has no handler → hard install failure', async () => {
    const result = await installBundledCores({
      project_slug: 'test',
      projectDb: bench.db,
      dataDir: bench.ownerHome,
      tools: bench.tools,
      secretsStore: bench.secrets,
      rootDirs: [FIXTURE_ROOT],
      // Wire a backend so buildTools actually runs (the coverage check only
      // fires once a backend is present — no-backend is the intentional
      // uniformly-stubbed deploy state, not under-implementation).
      backends: {
        [UNDERIMPL_SLUG]: () => ({ backend: {} }),
      },
      // Single Core in this fixture — disable the >50% failure-rate gate so
      // we observe the per-Core failure shape rather than a boot-abort throw.
      hardFailFailureRatio: 1,
    })

    expect(result.discovered).toBe(1)
    expect(result.installed.has(UNDERIMPL_SLUG)).toBe(false)

    const failure = result.failures.find((f) => f.core_slug === UNDERIMPL_SLUG)
    expect(failure, 'under-implementing Core must be in failures').toBeDefined()
    expect(failure?.code).toBe('manifest_incomplete')
    expect(failure?.message).toContain('underimpl_missing')

    // NEITHER tool registered — the failed install registers nothing (no
    // silent throw-stub for the missing tool, and the sibling is dropped).
    expect(bench.tools.get('underimpl_missing')).toBeUndefined()
    expect(bench.tools.get('underimpl_ok')).toBeUndefined()
  })

  test('surfaces as install_state:failed data (failures carry code + message)', async () => {
    const events: Array<{ event_name?: string; core_slug?: string; code?: string }> = []
    const result = await installBundledCores({
      project_slug: 'test',
      projectDb: bench.db,
      dataDir: bench.ownerHome,
      tools: bench.tools,
      secretsStore: bench.secrets,
      rootDirs: [FIXTURE_ROOT],
      backends: { [UNDERIMPL_SLUG]: () => ({ backend: {} }) },
      hardFailFailureRatio: 1,
      log: (e) => events.push(e as { event_name?: string }),
    })
    // The failure telemetry event carries the structured code the /api/cores
    // surface renders as install_error.{code,message}.
    const failEvent = events.find(
      (e) => e.event_name === 'cores.install_failed' && e.core_slug === UNDERIMPL_SLUG,
    )
    expect(failEvent?.code).toBe('manifest_incomplete')
    expect(result.failures[0]?.code).toBe('manifest_incomplete')
  })

  test('retry rehydrates the persisted row — no spurious duplicate_install masks the real failure', async () => {
    // `installCore` persists the core_installations row BEFORE tool
    // registration, and the manifest_incomplete failure throws AFTER. So the
    // row is live while the Core is in `failures`. `reinstallFailedCore` must
    // rehydrate that row (not raise `duplicate_install`) and re-surface the
    // REAL failure while the Core still under-implements.
    const state = await installBundledCores({
      project_slug: 'test',
      projectDb: bench.db,
      dataDir: bench.ownerHome,
      tools: bench.tools,
      secretsStore: bench.secrets,
      rootDirs: [FIXTURE_ROOT],
      backends: { [UNDERIMPL_SLUG]: () => ({ backend: {} }) },
      hardFailFailureRatio: 1,
    })
    expect(state.failures[0]?.code).toBe('manifest_incomplete')

    // The row was persisted by installCore before registration threw.
    const installations = new CoreInstallationsStore({ db: bench.db })
    const row = await installations.get('test', UNDERIMPL_SLUG)
    expect(row, 'installCore persisted the row before registration threw').not.toBeNull()

    // Retry: the Core still under-implements, so we expect the REAL
    // manifest_incomplete error to surface — NOT a spurious duplicate_install.
    let threw: unknown = null
    try {
      await reinstallFailedCore({
        slug: UNDERIMPL_SLUG,
        state,
        project_slug: 'test',
        projectDb: bench.db,
        dataDir: bench.ownerHome,
        tools: bench.tools,
        secretsStore: bench.secrets,
        prompter: NOOP_PROMPTER,
        backends: { [UNDERIMPL_SLUG]: () => ({ backend: {} }) },
      })
    } catch (err) {
      threw = err
    }
    expect(threw).not.toBeNull()
    expect((threw as { code?: string }).code).toBe('manifest_incomplete')
    expect((threw as Error).message).toContain('underimpl_missing')
  })

  test('SDK ToolCallContext stays field-identical to the registry ToolCallContext', () => {
    // X2 threads the registry's per-call ctx into Core handlers via
    // wrapHandler. `cores/sdk` is a contracts-band leaf and cannot import the
    // platform-band `@neutronai/tools`, so it re-declares ToolCallContext
    // structurally. Mutual assignability below is a COMPILE-TIME guard: adding
    // or renaming a field on either side breaks tsc here, catching drift.
    const sample: RegistryToolCallContext = {
      project_slug: 'p',
      project_id: null,
      topic_id: null,
      call_id: 'c',
      speaker_user_id: null,
    }
    const asSdk: SdkToolCallContext = sample // registry → sdk
    const back: RegistryToolCallContext = asSdk // sdk → registry
    expect(back).toBe(sample)
  })
})
