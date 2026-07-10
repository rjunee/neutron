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
const NONFN_ROOT = join(import.meta.dir, 'fixtures', 'nonfn-root')
const SLUG_MISMATCH_ROOT = join(import.meta.dir, 'fixtures', 'slug-mismatch-root')
const TOOLNAMES_MISMATCH_ROOT = join(import.meta.dir, 'fixtures', 'toolnames-mismatch-root')
const CTXECHO_ROOT = join(import.meta.dir, 'fixtures', 'ctxecho-root')
const SPLIT_SURFACE_ROOT = join(import.meta.dir, 'fixtures', 'split-surface-root')
const EXTRA_WINS_ROOT = join(import.meta.dir, 'fixtures', 'extra-wins-root')

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

  test('a declared tool mapped to a NON-FUNCTION is under-implementation (not a valid handler)', async () => {
    // `{ nonfn_bad: undefined }` has the property but it is not callable — it
    // would crash at dispatch. The coverage check must reject it.
    const result = await installBundledCores({
      project_slug: 'test',
      projectDb: bench.db,
      dataDir: bench.ownerHome,
      tools: bench.tools,
      secretsStore: bench.secrets,
      rootDirs: [NONFN_ROOT],
      backends: { nonfn_core: () => ({ backend: {} }) },
      hardFailFailureRatio: 1,
    })
    expect(result.installed.has('nonfn_core')).toBe(false)
    const failure = result.failures.find((f) => f.core_slug === 'nonfn_core')
    expect(failure?.code).toBe('manifest_incomplete')
    expect(failure?.message).toContain('nonfn_bad')
    expect(bench.tools.get('nonfn_bad')).toBeUndefined()
    expect(bench.tools.get('nonfn_ok')).toBeUndefined()
  })

  test('a defineCore() contract that misdeclares its slug hard-fails (core_contract_mismatch)', async () => {
    // package @neutronai/slugmatch-core → slug 'slugmatch_core', but the
    // contract declares slug 'impostor_core'.
    const result = await installBundledCores({
      project_slug: 'test',
      projectDb: bench.db,
      dataDir: bench.ownerHome,
      tools: bench.tools,
      secretsStore: bench.secrets,
      rootDirs: [SLUG_MISMATCH_ROOT],
      backends: { slugmatch_core: () => ({ backend: {} }) },
      hardFailFailureRatio: 1,
    })
    expect(result.installed.has('slugmatch_core')).toBe(false)
    const failure = result.failures.find((f) => f.core_slug === 'slugmatch_core')
    expect(failure?.code).toBe('core_contract_mismatch')
    expect(failure?.message).toContain('impostor_core')
    expect(bench.tools.get('sm_do')).toBeUndefined()
  })

  test('a defineCore() contract whose toolNames drift from the manifest hard-fails', async () => {
    // manifest declares [tn_a, tn_b] (both implemented) but toolNames = [tn_a].
    const result = await installBundledCores({
      project_slug: 'test',
      projectDb: bench.db,
      dataDir: bench.ownerHome,
      tools: bench.tools,
      secretsStore: bench.secrets,
      rootDirs: [TOOLNAMES_MISMATCH_ROOT],
      backends: { tnmatch_core: () => ({ backend: {} }) },
      hardFailFailureRatio: 1,
    })
    expect(result.installed.has('tnmatch_core')).toBe(false)
    const failure = result.failures.find((f) => f.core_slug === 'tnmatch_core')
    expect(failure?.code).toBe('core_contract_mismatch')
    expect(failure?.message).toContain('tn_b')
    expect(bench.tools.get('tn_a')).toBeUndefined()
    expect(bench.tools.get('tn_b')).toBeUndefined()
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

  test('split-surface overlap (buildTools + buildExtraTools share a tool) installs clean — no false failure telemetry', async () => {
    const events: Array<{ event_name?: string; code?: string; core_slug?: string }> = []
    const result = await installBundledCores({
      project_slug: 'test',
      projectDb: bench.db,
      dataDir: bench.ownerHome,
      tools: bench.tools,
      secretsStore: bench.secrets,
      rootDirs: [SPLIT_SURFACE_ROOT],
      backends: { split_core: () => ({ backend: {} }) },
      hardFailFailureRatio: 1,
      log: (e) => events.push(e as { event_name?: string }),
    })
    expect(result.installed.has('split_core')).toBe(true)
    expect(result.failures).toEqual([])
    // Both tools registered; the buildTools handler wins the overlap.
    expect(bench.tools.get('split_a')).toBeDefined()
    expect(bench.tools.get('split_b')).toBeDefined()
    // NO tool_registration_failed / extra_tool_name_collision telemetry.
    const noisy = events.filter(
      (e) =>
        e.event_name === 'cores.tool_registration_failed' ||
        e.code === 'extra_tool_name_collision',
    )
    expect(noisy).toEqual([])
    // The overlap kept the buildTools handler (not buildExtraTools').
    const out = (await bench.tools.get('split_b')!.handler({}, {
      project_slug: 'test',
      project_id: null,
      topic_id: null,
      call_id: 'c',
      speaker_user_id: null,
    })) as { from: string }
    expect(out.from).toBe('base')
  })

  test('a callable extra handler WINS over a non-callable base placeholder (installs, not manifest_incomplete)', async () => {
    // buildTools returns { ew_b: undefined } (placeholder); buildExtraTools
    // returns the real ew_b handler. The merge must install the extra's
    // handler rather than keep the placeholder and wrongly hard-fail.
    const events: Array<{ event_name?: string; code?: string }> = []
    const result = await installBundledCores({
      project_slug: 'test',
      projectDb: bench.db,
      dataDir: bench.ownerHome,
      tools: bench.tools,
      secretsStore: bench.secrets,
      rootDirs: [EXTRA_WINS_ROOT],
      backends: { extrawins_core: () => ({ backend: {} }) },
      hardFailFailureRatio: 1,
      log: (e) => events.push(e as { event_name?: string }),
    })
    expect(result.installed.has('extrawins_core')).toBe(true)
    expect(result.failures).toEqual([])
    expect(bench.tools.get('ew_a')).toBeDefined()
    expect(bench.tools.get('ew_b')).toBeDefined()
    // The registered ew_b handler is the EXTRA's (the base was a placeholder).
    const out = (await bench.tools.get('ew_b')!.handler({}, {
      project_slug: 'test',
      project_id: null,
      topic_id: null,
      call_id: 'c',
      speaker_user_id: null,
    })) as { from: string }
    expect(out.from).toBe('extra')
    // No false failure telemetry on this healthy install.
    const noisy = events.filter((e) => e.event_name === 'cores.tool_registration_failed')
    expect(noisy).toEqual([])
  })

  test('wrapHandler THREADS the per-call ToolCallContext into the Core handler at dispatch', async () => {
    // Behavioral proof (not just type assignability): a Core handler that
    // echoes ctx into its backend must receive the exact ctx the registry
    // dispatches with — every field, all non-null. Replacing wrapHandler's
    // `fn(args, ctx)` with the old `fn(args)` would make `captured` null here.
    const capturedRef: { current: RegistryToolCallContext | null } = { current: null }
    const result = await installBundledCores({
      project_slug: 'test',
      projectDb: bench.db,
      dataDir: bench.ownerHome,
      tools: bench.tools,
      secretsStore: bench.secrets,
      rootDirs: [CTXECHO_ROOT],
      backends: {
        ctxecho_core: () => ({
          backend: {
            capture: (ctx: RegistryToolCallContext) => {
              capturedRef.current = ctx
            },
          },
        }),
      },
      hardFailFailureRatio: 1,
    })
    expect(result.installed.has('ctxecho_core')).toBe(true)

    const reg = bench.tools.get('ctx_echo')
    expect(reg, 'ctx_echo must register with a real handler').toBeDefined()

    const ctx: RegistryToolCallContext = {
      project_slug: 'owner-slug',
      project_id: 'project-42',
      topic_id: 'topic-9',
      call_id: 'call-abc',
      speaker_user_id: 'user-7',
    }
    await reg!.handler({ hello: 'world' }, ctx)
    const captured = capturedRef.current
    expect(captured).not.toBeNull()
    expect(captured).toEqual(ctx)
    // Explicitly pin the fields Codex called out as the X6 enabler.
    expect(captured?.project_id).toBe('project-42')
    expect(captured?.topic_id).toBe('topic-9')
    expect(captured?.speaker_user_id).toBe('user-7')
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
