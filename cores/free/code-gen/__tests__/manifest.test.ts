import { describe, expect, test } from 'bun:test'

import { parseManifest } from '@neutronai/cores-sdk'

import {
  CORE_PACKAGE_NAME,
  CORE_SLUG,
  DISPATCH_SUBAGENT_CAPABILITY,
  HOST_GH_CAPABILITY,
  NETWORK_GITHUB_CAPABILITY,
  READ_CAPABILITY,
  TOOL_NAMES,
  WRITE_CAPABILITY,
  loadManifest,
} from '../src/manifest.ts'

import pkg from '../package.json'

describe('Code-Gen Core — manifest', () => {
  test('package.json round-trip through @neutronai/cores-sdk parseManifest', () => {
    expect(() => loadManifest()).not.toThrow()
    const m = loadManifest()
    expect(m.capabilities).toContain(READ_CAPABILITY)
    expect(m.capabilities).toContain(WRITE_CAPABILITY)
    expect(m.capabilities).toContain(DISPATCH_SUBAGENT_CAPABILITY)
    expect(m.capabilities).toContain(HOST_GH_CAPABILITY)
    expect(m.capabilities).toContain(NETWORK_GITHUB_CAPABILITY)
    expect(m.tier_support).toEqual(['regular'])
    expect(m.billing_hooks).toEqual([])
    expect(m.secrets).toEqual([])
    expect(m.linked_sources).toEqual([])
    expect(m.compat.coreApi).toBe('^0.1.0')
    expect(m.build.neutronVersion).toBe('0.1.0')
  })

  test('four tools declared with locked capability_required values (S2 narrowed surface)', () => {
    const m = loadManifest()
    const byName = new Map(m.tools.map((t) => [t.name, t]))
    expect(byName.size).toBe(4)
    expect(byName.get('codegen_dispatch')?.capability_required).toBe(WRITE_CAPABILITY)
    expect(byName.get('codegen_status')?.capability_required).toBe(READ_CAPABILITY)
    expect(byName.get('codegen_fetch')?.capability_required).toBe(READ_CAPABILITY)
    expect(byName.get('codegen_cancel')?.capability_required).toBe(WRITE_CAPABILITY)
    // The S1 extras (review / merge / judge / history) were removed in
    // S2 — the autonomous Forge → Argus → merge loop subsumes them.
    expect(byName.has('codegen_review')).toBe(false)
    expect(byName.has('codegen_merge')).toBe(false)
    expect(byName.has('codegen_judge')).toBe(false)
    expect(byName.has('codegen_history')).toBe(false)
  })

  test('TOOL_NAMES tuple matches manifest tools[] one-to-one', () => {
    const m = loadManifest()
    const fromManifest = m.tools.map((t) => t.name).sort()
    const fromConst = [...TOOL_NAMES].sort()
    expect(fromManifest).toEqual(fromConst)
  })

  test('codegen_status output enum locks the full pending/running/completed/failed/cancelled surface', () => {
    const m = loadManifest()
    const status = m.tools.find((t) => t.name === 'codegen_status')
    expect(status).toBeDefined()
    const props = (status?.output_schema as { properties?: Record<string, unknown> } | undefined)
      ?.properties
    const statusProp = props?.['status'] as { enum?: string[] } | undefined
    expect(statusProp).toBeDefined()
    expect(statusProp?.enum?.sort()).toEqual(
      ['cancelled', 'completed', 'failed', 'pending', 'running'],
    )
  })

  test('UI surfaces — launcher_icon + app_tab both declared', () => {
    const m = loadManifest()
    expect(m.ui_components).toHaveLength(2)
    const surfaces = m.ui_components.map((u) => u.surface).sort()
    expect(surfaces).toEqual(['app_tab', 'launcher_icon'])
    const icon = m.ui_components.find((u) => u.surface === 'launcher_icon')
    expect(icon?.name).toBe('CodeGenLauncherIcon')
    expect(icon?.entry_point).toBe('./src/ui/launcher-icon.ts')
    const tab = m.ui_components.find((u) => u.surface === 'app_tab')
    expect(tab?.name).toBe('CodeGenAppTab')
    expect(tab?.entry_point).toBe('./src/ui/app-tab-surface.ts')
  })

  test('CORE_SLUG / CORE_PACKAGE_NAME constants pinned to the shipped package.json', () => {
    expect(CORE_PACKAGE_NAME).toBe('@neutronai/codegen-core')
    expect(CORE_SLUG).toBe('codegen_core')
    expect(pkg.name).toBe(CORE_PACKAGE_NAME)
  })

  test('raw package.json neutron block passes parseManifest', () => {
    expect(() => parseManifest((pkg as { neutron: unknown }).neutron)).not.toThrow()
  })
})
