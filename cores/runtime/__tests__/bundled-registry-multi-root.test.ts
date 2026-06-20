/**
 * cores/runtime — bundled-registry multi-root tests.
 *
 * Locks the precedence semantics + telemetry contract introduced by the
 * 2-tier Cores layout (see
 * `docs/research/neutron-cores-marketplace-split-2026-05-17.md § 3`).
 *
 * Specifically asserts:
 *   - single string `rootDir` still works (backward-compat)
 *   - two roots, no duplicates → both Cores load
 *   - two roots, duplicate slug → first root wins; one telemetry event
 *   - three roots → precedence holds transitively (two events on triple-dup)
 *   - empty `rootDir[]` → registry boots with zero Cores, no crash
 *   - non-existent root path → registry skips with `cores.root_skipped` event
 *   - existing single-root tests continue to pass (covered in
 *     bundled-registry.test.ts; this file does not duplicate them)
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CoreInstallError,
  buildBundledRegistry,
  type BundledRegistryEvent,
} from '../index.ts'

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cores-multi-root-'))
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

/**
 * Writes a Core into `<rootDir>/cores/<dirName>/` with a `package.json`
 * whose `name` field controls the resulting slug. Two roots can declare
 * the same `packageName` to provoke a duplicate-slug collision.
 */
function writeCore(
  rootDir: string,
  dirName: string,
  packageName: string,
  version = '0.1.0',
  manifest: unknown = MIN_MANIFEST,
): void {
  const dir = join(rootDir, 'cores', dirName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name: packageName,
      version,
      type: 'module',
      neutron: manifest,
    }),
  )
}

function mkRoot(name: string): string {
  const dir = join(tmp, name)
  mkdirSync(dir, { recursive: true })
  return dir
}

function recorder(): {
  events: BundledRegistryEvent[]
  sink: (e: BundledRegistryEvent) => void
} {
  const events: BundledRegistryEvent[] = []
  return {
    events,
    sink: (e): void => {
      events.push(e)
    },
  }
}

// ---------------------------------------------------------------------------

test('rootDir: string keeps working (backward-compat)', () => {
  writeCore(tmp, 'email', '@neutronai/email')
  writeCore(tmp, 'calendar', '@neutronai/calendar')
  const reg = buildBundledRegistry({ rootDir: tmp })
  expect(reg.list().map((c) => c.slug).sort()).toEqual(['calendar', 'email'])
})

test('two roots, no duplicates: both Cores load', () => {
  const rootA = mkRoot('open')
  const rootB = mkRoot('managed')
  writeCore(rootA, 'email', '@neutronai/email')
  writeCore(rootB, 'legal', '@neutron-paid/legal-core')

  const { events, sink } = recorder()
  const reg = buildBundledRegistry({ rootDir: [rootA, rootB], telemetry: sink })

  const slugs = reg.list().map((c) => c.slug).sort()
  expect(slugs).toEqual(['email', 'legal_core'])
  // No collisions; telemetry should be silent.
  expect(events).toEqual([])
  // BundledCore should carry the originating root for downstream
  // composer + telemetry use.
  expect(reg.get('email')?.rootDir).toBe(rootA)
  expect(reg.get('legal_core')?.rootDir).toBe(rootB)
})

test('same-root duplicate slug throws CoreInstallError(duplicate_install)', () => {
  // Two Cores in the SAME root that normalize to the same slug is a
  // packaging misconfiguration, not a precedence resolution. The
  // pre-multi-root invariant (one slug per root) must hold.
  const rootA = mkRoot('open')
  writeCore(rootA, 'email', '@neutronai/email', '0.1.0')
  writeCore(rootA, 'email-copy', '@neutronai/email', '0.2.0')

  const { events, sink } = recorder()
  let caught: unknown
  try {
    buildBundledRegistry({ rootDir: [rootA], telemetry: sink })
  } catch (err) {
    caught = err
  }
  expect(caught).toBeInstanceOf(CoreInstallError)
  expect((caught as CoreInstallError).code).toBe('duplicate_install')
  // Same-root duplicates must NOT emit the cross-root telemetry event —
  // that channel is reserved for legitimate precedence resolutions.
  expect(
    events.filter((e) => e.event_name === 'cores.duplicate_slug_resolved'),
  ).toEqual([])
})

test('same-root duplicate slug throws even when an earlier root shadows it', () => {
  // Regression: before the per-root seen-set landed, the second copy
  // of B's slug would hit bySlug (which still pointed at A's email)
  // and silently fall through the cross-root precedence branch — two
  // telemetry events, zero throw, packaging bug absorbed. Now the
  // per-root same-slug invariant fires first.
  const rootA = mkRoot('open')
  const rootB = mkRoot('managed')
  writeCore(rootA, 'email', '@neutronai/email', '0.1.0')
  writeCore(rootB, 'email', '@neutronai/email', '0.2.0')
  writeCore(rootB, 'email-copy', '@neutronai/email', '0.3.0')

  const { events, sink } = recorder()
  let caught: unknown
  try {
    buildBundledRegistry({ rootDir: [rootA, rootB], telemetry: sink })
  } catch (err) {
    caught = err
  }
  expect(caught).toBeInstanceOf(CoreInstallError)
  const installErr = caught as CoreInstallError
  expect(installErr.code).toBe('duplicate_install')
  expect(installErr.message).toContain('email')
  expect(installErr.message).toContain(rootB)
  // The throw must happen BEFORE any cross-root resolution is emitted
  // for the duplicated B copy — otherwise the packaging bug stays
  // hidden behind a "this was a precedence resolution" event stream.
  expect(
    events.filter((e) => e.event_name === 'cores.duplicate_slug_resolved'),
  ).toEqual([])
})

test('two roots, duplicate slug: first root wins + emits one event', () => {
  const rootA = mkRoot('open')
  const rootB = mkRoot('managed')
  // Both roots ship the same slug (different versions).
  writeCore(rootA, 'email', '@neutronai/email', '0.1.0')
  writeCore(rootB, 'email', '@neutronai/email', '0.9.9')

  const { events, sink } = recorder()
  const reg = buildBundledRegistry({ rootDir: [rootA, rootB], telemetry: sink })

  // First root wins → version 0.1.0.
  expect(reg.get('email')?.package_version).toBe('0.1.0')
  expect(reg.get('email')?.rootDir).toBe(rootA)
  expect(reg.list().length).toBe(1)

  expect(events).toEqual([
    {
      event_name: 'cores.duplicate_slug_resolved',
      slug: 'email',
      winning_root: rootA,
      losing_root: rootB,
    },
  ])
})

test('three roots: precedence holds transitively (two duplicate events)', () => {
  const rootA = mkRoot('a')
  const rootB = mkRoot('b')
  const rootC = mkRoot('c')
  // All three roots declare the same slug.
  writeCore(rootA, 'email', '@neutronai/email', '1.0.0')
  writeCore(rootB, 'email', '@neutronai/email', '2.0.0')
  writeCore(rootC, 'email', '@neutronai/email', '3.0.0')
  // C also declares a unique Core to prove the rest of the walk still
  // happens after a collision.
  writeCore(rootC, 'notes', '@neutronai/notes', '1.0.0')

  const { events, sink } = recorder()
  const reg = buildBundledRegistry({
    rootDir: [rootA, rootB, rootC],
    telemetry: sink,
  })

  expect(reg.get('email')?.package_version).toBe('1.0.0')
  expect(reg.get('email')?.rootDir).toBe(rootA)
  expect(reg.get('notes')?.rootDir).toBe(rootC)
  expect(reg.list().map((c) => c.slug).sort()).toEqual(['email', 'notes'])

  // Exactly one event per losing duplicate — never per Core file read.
  expect(events).toEqual([
    {
      event_name: 'cores.duplicate_slug_resolved',
      slug: 'email',
      winning_root: rootA,
      losing_root: rootB,
    },
    {
      event_name: 'cores.duplicate_slug_resolved',
      slug: 'email',
      winning_root: rootA,
      losing_root: rootC,
    },
  ])
})

test('empty rootDir[]: registry boots with zero Cores, no crash', () => {
  const { events, sink } = recorder()
  const reg = buildBundledRegistry({ rootDir: [], telemetry: sink })
  expect(reg.list()).toEqual([])
  expect(reg.get('anything')).toBeNull()
  expect(events).toEqual([])
})

test('non-existent root path: registry skips with warning event, does not crash', () => {
  const rootA = mkRoot('open')
  writeCore(rootA, 'email', '@neutronai/email')
  const ghost = join(tmp, 'does-not-exist')

  const { events, sink } = recorder()
  const reg = buildBundledRegistry({
    rootDir: [rootA, ghost],
    telemetry: sink,
  })

  // Existing root still loads; ghost root emits a skip event.
  expect(reg.list().map((c) => c.slug)).toEqual(['email'])
  expect(events).toEqual([
    {
      event_name: 'cores.root_skipped',
      rootDir: ghost,
      reason: 'not_found',
    },
  ])
})

test('non-existent root path: works even when its position is first', () => {
  const ghost = join(tmp, 'ghost')
  const rootB = mkRoot('managed')
  writeCore(rootB, 'legal', '@neutron-paid/legal-core')

  const { events, sink } = recorder()
  const reg = buildBundledRegistry({
    rootDir: [ghost, rootB],
    telemetry: sink,
  })
  expect(reg.list().map((c) => c.slug)).toEqual(['legal_core'])
  expect(events).toEqual([
    {
      event_name: 'cores.root_skipped',
      rootDir: ghost,
      reason: 'not_found',
    },
  ])
})

test('two roots, second is empty: first root still loads, no events', () => {
  const rootA = mkRoot('open')
  const rootB = mkRoot('managed')  // exists but has no cores/ subdir
  writeCore(rootA, 'email', '@neutronai/email')

  const { events, sink } = recorder()
  const reg = buildBundledRegistry({
    rootDir: [rootA, rootB],
    telemetry: sink,
  })
  expect(reg.list().map((c) => c.slug)).toEqual(['email'])
  // Empty cores/ in an existing root is NOT a skip — it's just a
  // present-but-empty walk. No event.
  expect(events).toEqual([])
})

test('telemetry defaults to no-op when not supplied', () => {
  const rootA = mkRoot('a')
  const rootB = mkRoot('b')
  writeCore(rootA, 'email', '@neutronai/email')
  writeCore(rootB, 'email', '@neutronai/email')

  // No telemetry hook — should not throw.
  const reg = buildBundledRegistry({ rootDir: [rootA, rootB] })
  expect(reg.list().map((c) => c.slug)).toEqual(['email'])
})

test('multi-root: excludeSlugs still excludes across all roots', () => {
  const rootA = mkRoot('a')
  const rootB = mkRoot('b')
  writeCore(rootA, 'email', '@neutronai/email')
  writeCore(rootB, 'experimental', '@neutron-paid/experimental')

  const reg = buildBundledRegistry({
    rootDir: [rootA, rootB],
    excludeSlugs: ['experimental'],
  })
  expect(reg.list().map((c) => c.slug)).toEqual(['email'])
})

test('multi-root: BundledCore.rootDir + .source are both populated', () => {
  const rootA = mkRoot('a')
  const rootB = mkRoot('b')
  writeCore(rootA, 'email', '@neutronai/email')
  writeCore(rootB, 'legal', '@neutron-paid/legal-core')

  const reg = buildBundledRegistry({ rootDir: [rootA, rootB] })
  const email = reg.get('email')
  const legal = reg.get('legal_core')
  expect(email?.source).toBe('bundled')
  expect(email?.rootDir).toBe(rootA)
  expect(legal?.source).toBe('bundled')
  expect(legal?.rootDir).toBe(rootB)
})
