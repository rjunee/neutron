import { describe, expect, test } from 'bun:test'

import { parseManifest } from '@neutronai/cores-sdk'

import {
  CORE_PACKAGE_NAME,
  CORE_SLUG,
  READ_CAPABILITY,
  TOOL_NAMES,
  WRITE_CAPABILITY,
  loadManifest,
} from '../src/manifest.ts'

import pkg from '../package.json'

describe('Tasks Core — manifest', () => {
  test('package.json round-trip through @neutronai/cores-sdk parseManifest', () => {
    expect(() => loadManifest()).not.toThrow()
    const m = loadManifest()
    expect(m.capabilities).toContain(READ_CAPABILITY)
    expect(m.capabilities).toContain(WRITE_CAPABILITY)
    expect(m.tier_support).toEqual(['regular'])
    expect(m.secrets).toEqual([])
    expect(m.linked_sources).toEqual([])
    expect(m.billing_hooks).toEqual([])
    expect(m.compat.coreApi).toBe('^0.1.0')
    expect(m.build.neutronVersion).toBe('0.2.0')
  })

  test('six tools declared with locked capability_required values (incl. tasks_pick_next)', () => {
    const m = loadManifest()
    const byName = new Map(m.tools.map((t) => [t.name, t]))
    expect(byName.size).toBe(6)
    expect(byName.get('tasks_create')?.capability_required).toBe(WRITE_CAPABILITY)
    expect(byName.get('tasks_list')?.capability_required).toBe(READ_CAPABILITY)
    expect(byName.get('tasks_update')?.capability_required).toBe(WRITE_CAPABILITY)
    expect(byName.get('tasks_complete')?.capability_required).toBe(WRITE_CAPABILITY)
    expect(byName.get('tasks_delete')?.capability_required).toBe(WRITE_CAPABILITY)
    // tasks_pick_next gates on the READ capability — it surfaces the
    // focus-score-ranked top open tasks without mutating any row.
    expect(byName.get('tasks_pick_next')?.capability_required).toBe(READ_CAPABILITY)
  })

  test('TOOL_NAMES tuple matches manifest tools[] one-to-one', () => {
    const m = loadManifest()
    const fromManifest = m.tools.map((t) => t.name).sort()
    const fromConst = [...TOOL_NAMES].sort()
    expect(fromManifest).toEqual(fromConst)
  })

  test('launcher_icon + app_tab UI surfaces are present (S1 P5.3 launcher + P5.4 tab binding)', () => {
    const m = loadManifest()
    expect(m.ui_components).toHaveLength(2)
    const icon = m.ui_components.find((c) => c.surface === 'launcher_icon')
    expect(icon).not.toBeUndefined()
    expect(icon?.name).toBe('TasksLauncherIcon')
    expect(icon?.entry_point).toBe('./src/ui/launcher-icon.ts')

    const tab = m.ui_components.find((c) => c.surface === 'app_tab')
    expect(tab).not.toBeUndefined()
    expect(tab?.name).toBe('TasksAppTab')
    expect(tab?.entry_point).toBe('./src/ui/app-tab-surface.ts')
    // The app_tab path round-trips through props_schema verbatim — the
    // P5.3 launcher reads `<project_id>` from the manifest at boot.
    const props = (tab?.props_schema ?? {}) as {
      properties?: { path?: { const?: string } }
    }
    expect(props.properties?.path?.const).toBe('/projects/<project_id>/tasks')
  })

  test('CORE_SLUG / CORE_PACKAGE_NAME constants pinned to the shipped package.json', () => {
    expect(CORE_PACKAGE_NAME).toBe('@neutronai/tasks-core')
    expect(CORE_SLUG).toBe('tasks_core')
    // The package.json key these constants mirror — drift trips the test.
    expect(pkg.name).toBe(CORE_PACKAGE_NAME)
  })

  test('manifest body in-package parses cleanly via the SDK directly (no loader indirection)', () => {
    const direct = parseManifest((pkg as { neutron: unknown }).neutron)
    expect(direct.capabilities).toContain(WRITE_CAPABILITY)
    expect(direct.tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort())
  })

  test('loadManifest rejects when given a package.json without a "neutron" section', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'tasks-core-manifest-'))
    const path = join(dir, 'package.json')
    writeFileSync(
      path,
      JSON.stringify({ name: '@neutronai/tasks-core-bad', version: '0.0.0' }),
    )
    expect(() => loadManifest({ package_json_path: path })).toThrow(
      /no "neutron" section/,
    )
  })

  test('loadManifest rejects when tier_support is empty', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'tasks-core-manifest-'))
    const path = join(dir, 'package.json')
    const bad = {
      name: '@neutronai/tasks-core-bad',
      version: '0.0.0',
      neutron: {
        capabilities: [READ_CAPABILITY, WRITE_CAPABILITY],
        tier_support: [],
        tools: [],
        ui_components: [],
        billing_hooks: [],
        linked_sources: [],
        secrets: [],
        compat: { coreApi: '^0.1.0' },
        build: { neutronVersion: '0.1.0' },
      },
    }
    writeFileSync(path, JSON.stringify(bad))
    expect(() => loadManifest({ package_json_path: path })).toThrow()
  })
})
