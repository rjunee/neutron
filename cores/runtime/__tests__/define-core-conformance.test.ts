/**
 * X2 — typed Core module contract: conformance over ALL 9 bundled Cores.
 *
 * Every bundled Core's barrel MUST export `core = defineCore({ ... })` — the
 * ONE typed declaration the install composer (`gateway/cores/install-bundled.ts`)
 * reads instead of duck-typing undeclared `buildTools`/`buildExtraTools`
 * exports and a drift-prone `BACKEND_KEY_BY_SLUG` table.
 *
 * This test proves, at CI rather than at install time, that for each of the 9
 * bundled Cores:
 *   1. the barrel exports a genuine `defineCore()` `CoreModule`;
 *   2. `core.slug` equals the package-derived slug the loader computes;
 *   3. `core.backendKey` is a declared, non-empty deps key;
 *   4. `core.toolNames` set-equals the Core's on-disk manifest `tools[]` — a
 *      manifest tool the Core forgot to declare (or a phantom declaration)
 *      fails here; and
 *   5. the Core does NOT UNDER-IMPLEMENT its manifest — the union of the
 *      handlers `buildTools` + `buildExtraTools` actually return covers every
 *      manifest-declared tool name. This is the compile-adjacent proof behind
 *      the install composer's runtime hard-fail (`manifest_incomplete`): a
 *      Core that under-implements its manifest cannot install silently-broken.
 *
 * Handlers are enumerated by CONSTRUCTING the tool maps with permissive stand-in
 * deps (a Proxy that hands back the real manifest + a no-op for every backend
 * key). The factories build their handler closures without invoking the
 * backend, so `Object.keys(...)` yields the real implemented tool surface with
 * no live backend wiring required.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { describe, expect, test } from 'bun:test'
import { NeutronManifestSchema, defineCore, isCoreModule, type CoreModule } from '@neutronai/cores-sdk'

import { loadCoreFromDir } from '../loader.ts'

const FREE_CORES_DIR = join(import.meta.dir, '..', '..', 'free')

function bundledCoreDirs(): string[] {
  return readdirSync(FREE_CORES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
}

/** Import a Core barrel and return its `defineCore()` contract. */
async function loadCoreModule(dir: string): Promise<unknown> {
  const indexPath = join(FREE_CORES_DIR, dir, 'index.ts')
  const mod = (await import(pathToFileURL(indexPath).href)) as { core?: unknown }
  return mod.core
}

/**
 * Permissive stand-in deps for enumerating a Core's tool surface without a
 * live backend. Returns the REAL manifest (the `CapabilityGuard` the factories
 * build at construction iterates `manifest.tools`), a string `project_slug`, a
 * stub `audit`, and a no-op callable for every other key a factory might read
 * (`store` / `backend` / `client` / `orchestrator` / `summarizer` / `pickNext`
 * / ...). No handler body runs during construction, so no real backend is
 * needed.
 */
function stubDeps(manifest: unknown): Record<string, unknown> {
  const noopFn = (): undefined => undefined
  const noopBackend: unknown = new Proxy(noopFn, { get: () => noopFn })
  const base: Record<string, unknown> = {
    manifest,
    project_slug: 'conformance',
    audit: { record: noopFn, put: noopFn, get: noopFn },
  }
  return new Proxy(base, {
    get(target, prop: string) {
      if (prop in target) return target[prop]
      return noopBackend
    },
    has() {
      // Every key "exists" so `if (deps.pickNext)` / `'x' in deps` guards
      // include their optional tools during enumeration.
      return true
    },
  })
}

/**
 * Set of tool names `buildTools` + `buildExtraTools` return a CALLABLE handler
 * for. Mirrors the install composer's coverage check
 * (`typeof built[name] === 'function'`, install-bundled.ts) — a declared name
 * mapped to a non-function (e.g. `{ tool: undefined }`) is NOT counted, so it
 * surfaces as under-implementation here exactly as it would at install.
 */
function implementedToolNames(core: CoreModule, manifest: unknown): Set<string> {
  const deps = stubDeps(manifest)
  const built: Record<string, unknown> = { ...core.buildTools(deps) }
  if (core.buildExtraTools !== undefined) {
    Object.assign(built, core.buildExtraTools(deps))
  }
  return new Set(
    Object.entries(built)
      .filter(([, handler]) => typeof handler === 'function')
      .map(([name]) => name),
  )
}

describe('bundled Core defineCore() conformance (X2 — typed Core module contract)', () => {
  const dirs = bundledCoreDirs()

  test('discovers exactly the 9 bundled Cores', () => {
    expect(dirs).toEqual([
      'agent-settings',
      'calendar',
      'code-gen',
      'email',
      'google-workspace',
      'reminders',
      'research',
      'scraping',
      'tasks',
    ])
  })

  for (const dir of dirs) {
    describe(dir, () => {
      test('barrel exports a genuine defineCore() CoreModule', async () => {
        const core = await loadCoreModule(dir)
        expect(
          isCoreModule(core),
          `${dir}/index.ts must export \`export const core = defineCore({ ... })\``,
        ).toBe(true)
      })

      test('slug matches the package-derived slug + backendKey is declared', async () => {
        const core = (await loadCoreModule(dir)) as CoreModule
        const loaded = loadCoreFromDir(join(FREE_CORES_DIR, dir))
        expect(core.slug).toBe(loaded.slug)
        expect(typeof core.backendKey).toBe('string')
        expect(core.backendKey.length).toBeGreaterThan(0)
      })

      test('toolNames set-equals the on-disk manifest tools[]', async () => {
        const core = (await loadCoreModule(dir)) as CoreModule
        const loaded = loadCoreFromDir(join(FREE_CORES_DIR, dir))
        const declared = new Set(core.toolNames)
        const manifestTools = new Set(loaded.manifest.tools.map((t) => t.name))
        expect(
          [...declared].sort(),
          `${dir}: defineCore.toolNames must match manifest.tools[]`,
        ).toEqual([...manifestTools].sort())
      })

      test('does NOT under-implement its manifest — every declared tool has a handler', async () => {
        const core = (await loadCoreModule(dir)) as CoreModule
        const loaded = loadCoreFromDir(join(FREE_CORES_DIR, dir))
        const implemented = implementedToolNames(core, loaded.manifest)
        const missing = loaded.manifest.tools
          .map((t) => t.name)
          .filter((name) => !implemented.has(name))
        expect(
          missing,
          `${dir}: manifest declares tools with no buildTools/buildExtraTools handler`,
        ).toEqual([])
      })
    })
  }

  test('coverage boundary — a declared tool mapped to a non-function is NOT counted as implemented', () => {
    // Guards the sweep itself: `Object.keys` alone would count `{ x: undefined }`
    // as implemented, diverging from the install composer's callable check.
    const nonCallableCore = defineCore({
      slug: 'boundary_core',
      backendKey: 'backend',
      toolNames: ['ok', 'bad'],
      buildTools: () => ({
        ok: async (): Promise<Record<string, never>> => ({}),
        bad: undefined as unknown as () => Promise<unknown>,
      }),
    })
    const implemented = implementedToolNames(nonCallableCore, { tools: [] })
    expect(implemented.has('ok')).toBe(true)
    expect(implemented.has('bad')).toBe(false)
  })

  test('every bundled Core barrel exports a valid contract (aggregate)', async () => {
    for (const dir of dirs) {
      const core = await loadCoreModule(dir)
      expect(isCoreModule(core), `${dir}: missing defineCore() contract`).toBe(true)
      // Sanity: the on-disk manifest still validates under the single schema,
      // so the tool-name cross-check above compares against a real manifest.
      const pkgPath = join(FREE_CORES_DIR, dir, 'package.json')
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<string, unknown>
      expect(NeutronManifestSchema.safeParse(pkg['neutron']).success).toBe(true)
    }
  })
})
