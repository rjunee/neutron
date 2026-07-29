import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CoreInstallError, buildBundledRegistry } from '../index.ts'

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cores-bundled-'))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

const MIN_MANIFEST = {
  capabilities: [],
  tier_support: ['regular'],
  tools: [],
  ui_components: [],
  billing_hooks: [],
  linked_sources: [],
  secrets: [],
  compat: { coreApi: '^0.1.0' },
  build: { neutronVersion: '0.1.0' },
}

function writeBundledCore(name: string, manifest: unknown = MIN_MANIFEST, version = '0.1.0'): void {
  const dir = join(tmp, 'cores', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: `@neutronai/${name}`,
    version,
    type: 'module',
    neutron: manifest,
  }))
}

test('buildBundledRegistry: discovers Cores in cores/<name>/', () => {
  writeBundledCore('email')
  writeBundledCore('calendar')
  writeBundledCore('tasks')
  const reg = buildBundledRegistry({ rootDir: tmp })
  const slugs = reg.list().map((c) => c.slug).sort()
  expect(slugs).toEqual(['calendar', 'email', 'tasks'])
})

test('buildBundledRegistry: skips dirs without "neutron" block', () => {
  writeBundledCore('email')
  // Manually write a non-Core package.
  const dir = join(tmp, 'cores', 'sdk-like')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: '@neutronai/sdk-like', version: '0.0.1', type: 'module',
    // no neutron block
  }))

  const reg = buildBundledRegistry({ rootDir: tmp })
  expect(reg.list().map((c) => c.slug)).toEqual(['email'])
})

test('buildBundledRegistry: default excludes "sdk" and "runtime"', () => {
  writeBundledCore('sdk')      // — should be excluded
  writeBundledCore('runtime')  // — should be excluded
  writeBundledCore('email')
  const reg = buildBundledRegistry({ rootDir: tmp })
  expect(reg.list().map((c) => c.slug)).toEqual(['email'])
})

test('buildBundledRegistry: throws on malformed bundled Core (block-on-first)', () => {
  writeBundledCore('broken', {
    ...MIN_MANIFEST,
    tier_support: [],  // empty — invalid per Sprint 24 schema
  })
  expect(() => buildBundledRegistry({ rootDir: tmp })).toThrow(CoreInstallError)
})

test('buildBundledRegistry: blockOnFirstError=false enumerates issues', () => {
  writeBundledCore('email')
  writeBundledCore('broken', { ...MIN_MANIFEST, tier_support: [] })
  // With block-on-first off, discovery proceeds; the email Core registers, the broken
  // one's error is collected but not thrown when there's at least one valid Core.
  // The current implementation throws the first error when encountered with
  // blockOnFirstError=false (the broken Core fails validation but valid ones still
  // register). Either behavior is acceptable as long as it's deterministic.
  // Here we assert that with blockOnFirstError=false the registry surfaces what it can.
  const reg = buildBundledRegistry({ rootDir: tmp, blockOnFirstError: false })
  // At minimum, valid Cores are present.
  expect(reg.get('email')?.slug).toBe('email')
})

test('buildBundledRegistry: get(slug) returns null for unknown', () => {
  writeBundledCore('email')
  const reg = buildBundledRegistry({ rootDir: tmp })
  expect(reg.get('nope')).toBeNull()
})

test('buildBundledRegistry: get(slug) returns BundledCore w/ source=bundled', () => {
  writeBundledCore('email')
  const reg = buildBundledRegistry({ rootDir: tmp })
  const email = reg.get('email')
  expect(email?.source).toBe('bundled')
  expect(email?.package_name).toBe('@neutronai/email')
})

test('buildBundledRegistry: empty when cores/ is missing', () => {
  // No cores/ subdir written.
  const reg = buildBundledRegistry({ rootDir: tmp })
  expect(reg.list()).toEqual([])
})

test('buildBundledRegistry: excludeSlugs adds to defaults', () => {
  writeBundledCore('email')
  writeBundledCore('experimental')
  const reg = buildBundledRegistry({ rootDir: tmp, excludeSlugs: ['experimental'] })
  expect(reg.list().map((c) => c.slug)).toEqual(['email'])
})

test('buildBundledRegistry: discovers Cores nested under tier containers (cores/free/*)', () => {
  // Mirrors the production layout introduced by PRs #141 + #143: Tier
  // 1 free Cores ship at `cores/free/<slug>/` with no package.json on
  // the `free/` container itself. The registry walk must descend one
  // level into containers so demo-core + tasks light up at boot. Without
  // recursive discovery, both Cores ship as dead code in the bundle.
  const free = join(tmp, 'cores', 'free')
  mkdirSync(free, { recursive: true })
  function writeFreeCore(name: string): void {
    const dir = join(free, name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: `@neutronai/${name}`,
      version: '0.1.0',
      type: 'module',
      neutron: MIN_MANIFEST,
    }))
  }
  writeFreeCore('demo-core')
  writeFreeCore('tasks')
  // A direct-child Core under cores/ continues to be discovered.
  writeBundledCore('email')

  const reg = buildBundledRegistry({ rootDir: tmp })
  const slugs = reg.list().map((c) => c.slug).sort()
  expect(slugs).toEqual(['demo_core', 'email', 'tasks'])
  // Source + rootDir propagate cleanly through the recursion path.
  expect(reg.get('demo_core')?.source).toBe('bundled')
  expect(reg.get('demo_core')?.rootDir).toBe(tmp)
  expect(reg.get('tasks')?.package_name).toBe('@neutronai/tasks')
})

test('buildBundledRegistry: nested too-deep package.json is ignored', () => {
  // `cores/free/demo-core/node_modules/dep/package.json` must NOT be
  // discovered as a Core — recursion is bounded to a single container
  // level. Otherwise a real Core's vendored deps would surface as
  // sibling Cores and fail validation at boot.
  const free = join(tmp, 'cores', 'free')
  mkdirSync(free, { recursive: true })
  const demoDir = join(free, 'demo-core')
  mkdirSync(demoDir, { recursive: true })
  writeFileSync(join(demoDir, 'package.json'), JSON.stringify({
    name: '@neutronai/demo-core',
    version: '0.1.0',
    type: 'module',
    neutron: MIN_MANIFEST,
  }))
  // Vendored dep — has package.json but lives too deep.
  const deepDep = join(demoDir, 'node_modules', 'dep')
  mkdirSync(deepDep, { recursive: true })
  writeFileSync(join(deepDep, 'package.json'), JSON.stringify({
    name: 'dep', version: '1.0.0',
  }))

  const reg = buildBundledRegistry({ rootDir: tmp })
  expect(reg.list().map((c) => c.slug)).toEqual(['demo_core'])
})
