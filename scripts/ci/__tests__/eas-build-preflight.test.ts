/**
 * The EAS submit preflight (ISSUES #513).
 *
 * The bug it guards is a MEASUREMENT taken against the wrong tree, so the test that
 * matters is the historical one: the exact `expo-haptics` state that produced a
 * build wearing the wrong runtime identity must fail here.
 *
 * The rest pin the ways a check like this is usually wrong: passing vacuously on an
 * empty manifest, ignoring devDependencies because they "aren't shipped", or
 * resolving only against the app's own `node_modules` in a workspace repo where
 * hoisting puts most packages at the root.
 */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { makeIsLinked, unlinkedDependencies } from '../eas-build-preflight.ts'

const linkedSet = (names: readonly string[]) => (n: string) => names.includes(n)

describe('unlinkedDependencies', () => {
  test('THE #513 CASE — declared and locked but never installed', () => {
    // The precise state on 2026-08-07: expo-haptics in package.json, absent from
    // node_modules, everything else fine. This is the input that must not build.
    const missing = unlinkedDependencies({
      manifest: { dependencies: { expo: '~54.0.0', 'expo-haptics': '~15.0.8' } },
      isLinked: linkedSet(['expo']),
    })
    expect(missing).toEqual(['expo-haptics'])
  })

  test('a fully installed tree is silent', () => {
    expect(
      unlinkedDependencies({
        manifest: { dependencies: { expo: '~54.0.0', 'expo-haptics': '~15.0.8' } },
        isLinked: linkedSet(['expo', 'expo-haptics']),
      }),
    ).toEqual([])
  })

  test('devDependencies count too — a config plugin feeds the fingerprint', () => {
    // "It is only a dev dependency" is not a reason to trust the measurement: a
    // dev-only package can carry a config plugin or an expo-module.config.json.
    expect(
      unlinkedDependencies({
        manifest: { dependencies: {}, devDependencies: { 'some-config-plugin': '1.0.0' } },
        isLinked: linkedSet([]),
      }),
    ).toEqual(['some-config-plugin'])
  })

  test('a name in BOTH blocks is reported once', () => {
    expect(
      unlinkedDependencies({
        manifest: { dependencies: { dup: '1' }, devDependencies: { dup: '1' } },
        isLinked: linkedSet([]),
      }),
    ).toEqual(['dup'])
  })

  test('the report is sorted, so it is stable across runs', () => {
    expect(
      unlinkedDependencies({
        manifest: { dependencies: { zeta: '1', alpha: '1', mid: '1' } },
        isLinked: linkedSet([]),
      }),
    ).toEqual(['alpha', 'mid', 'zeta'])
  })

  test('an empty manifest is not treated as a pass by accident', () => {
    // It IS a pass — there is nothing declared — but assert it explicitly, because
    // "no dependencies found" is the shape a broken manifest read would take, and a
    // silent success there is exactly the lie this whole file exists to prevent.
    expect(unlinkedDependencies({ manifest: {}, isLinked: linkedSet([]) })).toEqual([])
  })
})

describe('makeIsLinked — resolution against a real workspace', () => {
  test('finds a package hoisted to the REPO ROOT, not just app/node_modules', () => {
    // This repo is a bun workspace, so most packages are hoisted. Resolving only
    // against app/node_modules would report nearly everything as missing and the
    // gate would be permanently red — which trains you to bypass it.
    const root = mkdtempSync(join(tmpdir(), 'preflight-'))
    mkdirSync(join(root, 'node_modules', 'hoisted-pkg'), { recursive: true })
    mkdirSync(join(root, 'app', 'node_modules', 'app-local-pkg'), { recursive: true })
    const isLinked = makeIsLinked(join(root, 'app'), root)

    expect(isLinked('hoisted-pkg')).toBe(true)
    expect(isLinked('app-local-pkg')).toBe(true)
    expect(isLinked('never-installed')).toBe(false)
  })

  test('a scoped package resolves through its @scope directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'preflight-scoped-'))
    mkdirSync(join(root, 'node_modules', '@scope', 'thing'), { recursive: true })
    expect(makeIsLinked(join(root, 'app'), root)('@scope/thing')).toBe(true)
    expect(makeIsLinked(join(root, 'app'), root)('@scope/other')).toBe(false)
  })
})

describe('against THIS repo', () => {
  test('the real app manifest is fully installed — the gate is not vacuous', () => {
    // Proves the two halves compose on real inputs. If this ever fails, the tree is
    // genuinely mid-install and the message is the correct one to act on.
    const repoRoot = join(import.meta.dir, '..', '..', '..')
    const manifest = JSON.parse(
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      require('node:fs').readFileSync(join(repoRoot, 'app', 'package.json'), 'utf8') as string,
    ) as { dependencies?: Record<string, string> }
    // Sanity: the manifest really was read, so an empty result below means "linked",
    // not "nothing parsed".
    expect(Object.keys(manifest.dependencies ?? {}).length).toBeGreaterThan(5)
    expect(
      unlinkedDependencies({ manifest, isLinked: makeIsLinked(join(repoRoot, 'app'), repoRoot) }),
    ).toEqual([])
  })
})

describe('the CLI writes a message naming the fix', () => {
  test('a failing tree exits 1 and names both the package and `bun install`', async () => {
    const root = mkdtempSync(join(tmpdir(), 'preflight-cli-'))
    mkdirSync(join(root, 'app'), { recursive: true })
    writeFileSync(
      join(root, 'app', 'package.json'),
      JSON.stringify({ dependencies: { 'expo-haptics': '~15.0.8' } }),
    )
    const proc = Bun.spawnSync([
      process.execPath,
      join(import.meta.dir, '..', 'eas-build-preflight.ts'),
      root,
    ])
    const out = new TextDecoder().decode(proc.stdout)
    expect(proc.exitCode).toBe(1)
    expect(out).toContain('expo-haptics')
    // A gate that says only "failed" gets bypassed; the remedy has to be in it.
    expect(out).toContain('bun install')
    expect(out).toContain('#513')
  })

  test('a tree with no app/ at all exits 0 rather than failing open-endedly', async () => {
    const root = mkdtempSync(join(tmpdir(), 'preflight-noapp-'))
    const proc = Bun.spawnSync([
      process.execPath,
      join(import.meta.dir, '..', 'eas-build-preflight.ts'),
      root,
    ])
    expect(proc.exitCode).toBe(0)
  })
})
