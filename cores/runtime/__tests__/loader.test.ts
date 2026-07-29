import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CoreInstallError,
  findCoreDirs,
  loadCoreFromDir,
  packageNameToSlug,
  readCorePackage,
} from '../index.ts'

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cores-runtime-loader-'))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

const VALID_MANIFEST = {
  capabilities: ['read:project.db', 'write:project.db'],
  tier_support: ['regular'],
  tools: [
    {
      name: 'ping',
      description: 'echo back',
      input_schema: { type: 'object' },
      output_schema: { type: 'object' },
      capability_required: 'read:project.db',
    },
  ],
  ui_components: [],
  billing_hooks: [],
  linked_sources: [],
  secrets: [],
  compat: { coreApi: '^0.1.0' },
  build: { neutronVersion: '0.1.0' },
}

function writeCore(
  name: string,
  pkg: Partial<{ name: string; version: string; neutron: unknown }> & { neutron?: unknown },
  dir = tmp,
): string {
  const coreDir = join(dir, name)
  mkdirSync(coreDir, { recursive: true })
  const fullPkg = {
    name: pkg.name ?? `@test/${name}`,
    version: pkg.version ?? '0.1.0',
    type: 'module',
    neutron: pkg.neutron ?? VALID_MANIFEST,
  }
  writeFileSync(join(coreDir, 'package.json'), JSON.stringify(fullPkg, null, 2))
  return coreDir
}

describe('packageNameToSlug', () => {
  test('strips @scope/ prefix and lowercases', () => {
    expect(packageNameToSlug('@neutronai/dtc-analytics')).toBe('dtc_analytics')
    expect(packageNameToSlug('@scope/Some-Pkg')).toBe('some_pkg')
  })
  test('replaces non-alphanum with underscore + collapses', () => {
    expect(packageNameToSlug('foo--bar.baz')).toBe('foo_bar_baz')
  })
  test('throws on empty result', () => {
    expect(() => packageNameToSlug('---')).toThrow(CoreInstallError)
    expect(() => packageNameToSlug('')).toThrow(CoreInstallError)
  })
})

describe('readCorePackage', () => {
  test('happy path returns name+version+neutron', () => {
    const dir = writeCore('happy', {})
    const pkg = readCorePackage(dir)
    expect(pkg.name).toBe('@test/happy')
    expect(pkg.version).toBe('0.1.0')
    expect(pkg.neutron).toBeDefined()
  })

  test('package_not_found when directory missing', () => {
    expect(() => readCorePackage(join(tmp, 'nope'))).toThrow(
      expect.objectContaining({ code: 'package_not_found' }),
    )
  })

  test('package_not_found when package.json missing', () => {
    const dir = join(tmp, 'no-pkg')
    mkdirSync(dir)
    expect(() => readCorePackage(dir)).toThrow(
      expect.objectContaining({ code: 'package_not_found' }),
    )
  })

  test('package_json_unreadable on bad JSON', () => {
    const dir = join(tmp, 'bad-json')
    mkdirSync(dir)
    writeFileSync(join(dir, 'package.json'), '{ not valid json')
    expect(() => readCorePackage(dir)).toThrow(
      expect.objectContaining({ code: 'package_json_unreadable' }),
    )
  })

  test('no_neutron_section when block absent', () => {
    const dir = join(tmp, 'no-neutron')
    mkdirSync(dir)
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'x', version: '1.0.0' }),
    )
    expect(() => readCorePackage(dir)).toThrow(
      expect.objectContaining({ code: 'no_neutron_section' }),
    )
  })

  test('manifest_invalid when name missing', () => {
    const dir = join(tmp, 'no-name')
    mkdirSync(dir)
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ version: '1.0.0', neutron: {} }),
    )
    expect(() => readCorePackage(dir)).toThrow(
      expect.objectContaining({ code: 'manifest_invalid' }),
    )
  })
})

describe('loadCoreFromDir', () => {
  test('returns LoadedCore with derived slug', () => {
    const dir = writeCore('happy', {})
    const core = loadCoreFromDir(dir)
    expect(core.slug).toBe('happy')
    expect(core.package_name).toBe('@test/happy')
    expect(core.package_version).toBe('0.1.0')
    expect(core.manifest.tier_support).toEqual(['regular'])
    expect(core.manifest.tools).toHaveLength(1)
    expect(core.coreDir).toBe(dir)
  })

  test('manifest_invalid surfaces every Zod issue', () => {
    const dir = writeCore('bad', {
      neutron: {
        capabilities: ['Read:Gmail'],
        tier_support: [],
        tools: [],
        ui_components: [{ name: 'X', entry_point: './x', surface: 'route_mount' }],
        billing_hooks: [],
        linked_sources: [],
        secrets: [],
        compat: { coreApi: '^0.1.0' },
        build: { neutronVersion: '0.1.0' },
      },
    })
    let caught: unknown
    try {
      loadCoreFromDir(dir)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(CoreInstallError)
    const e = caught as CoreInstallError
    expect(e.code).toBe('manifest_invalid')
    expect(Array.isArray(e.details?.issues)).toBe(true)
    const issues = e.details!.issues as Array<{ path: string }>
    // Multiple issues — tier_support empty + capability casing + missing mount_path.
    expect(issues.length).toBeGreaterThan(1)
  })
})

describe('findCoreDirs', () => {
  test('returns absolute paths sorted lexicographically', () => {
    writeCore('beta', {})
    writeCore('alpha', {})
    // A child directory without package.json AND without grandchildren
    // — should be skipped (no Cores nested inside).
    mkdirSync(join(tmp, 'no-pkg-here'))

    const dirs = findCoreDirs(tmp)
    expect(dirs.map((d) => d.split('/').pop())).toEqual(['alpha', 'beta'])
  })

  test('returns empty for missing parent', () => {
    expect(findCoreDirs(join(tmp, 'absent'))).toEqual([])
  })

  test('returns empty when parent is a file', () => {
    const filePath = join(tmp, 'plain-file')
    writeFileSync(filePath, 'hi')
    expect(findCoreDirs(filePath)).toEqual([])
  })

  test('recurses one level into containers without package.json', () => {
    // The 2-tier Cores layout puts Tier 1 free Cores under
    // `cores/free/<slug>/` and Tier 2 paid Cores under
    // `cores/managed/<slug>/`. Both containers have no package.json of
    // their own, so the walk must descend into them.
    const free = join(tmp, 'free')
    const managed = join(tmp, 'managed')
    mkdirSync(free)
    mkdirSync(managed)
    writeCore('notes', {}, free)
    writeCore('tasks', {}, free)
    writeCore('legal', {}, managed)
    // Also keep a direct-child Core for backward-compat.
    writeCore('dtc-analytics', {})

    const dirs = findCoreDirs(tmp)
    const rel = dirs.map((d) => d.slice(tmp.length + 1)).sort()
    expect(rel).toEqual([
      'dtc-analytics',
      'free/notes',
      'free/tasks',
      'managed/legal',
    ])
  })

  test('does not recurse past one container level', () => {
    // `cores/free/<core>/inner/too-deep/package.json` must NOT be
    // discovered — only immediate children of containers count as
    // Cores. Otherwise a Core's own node_modules or __tests__ subdirs
    // could be mistaken for sibling Cores.
    const free = join(tmp, 'free')
    mkdirSync(free)
    writeCore('notes', {}, free)
    // Bury a fake Core two levels deep inside the notes Core (mimics
    // node_modules/some-dep/package.json).
    const tooDeep = join(free, 'notes', 'inner', 'too-deep')
    mkdirSync(tooDeep, { recursive: true })
    writeFileSync(
      join(tooDeep, 'package.json'),
      JSON.stringify({ name: 'too-deep', version: '0.0.1' }),
    )

    const dirs = findCoreDirs(tmp)
    const rel = dirs.map((d) => d.slice(tmp.length + 1))
    expect(rel).toEqual(['free/notes'])
  })

  test('container with no package.json-bearing children is silently skipped', () => {
    // A container that exists but holds nothing Core-shaped should not
    // crash the walk or produce any candidate paths.
    const empty = join(tmp, 'free')
    mkdirSync(empty)
    mkdirSync(join(empty, 'just-a-dir'))
    writeFileSync(join(empty, 'README.md'), '# free tier\n')

    expect(findCoreDirs(tmp)).toEqual([])
  })

  test('mixed: direct Core sibling to container survives full-path sort', () => {
    // Direct-child Cores and container-nested Cores interleave by
    // full-path order — `dtc-analytics` < `free/notes` lexicographically.
    const free = join(tmp, 'free')
    mkdirSync(free)
    writeCore('dtc-analytics', {})
    writeCore('notes', {}, free)

    const dirs = findCoreDirs(tmp)
    expect(dirs.map((d) => d.slice(tmp.length + 1))).toEqual([
      'dtc-analytics',
      'free/notes',
    ])
  })
})
