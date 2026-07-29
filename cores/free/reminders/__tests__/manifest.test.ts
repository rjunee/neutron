import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseManifest } from '@neutronai/cores-sdk'

import {
  CORE_PACKAGE_NAME,
  CORE_SLUG,
  READ_CAPABILITY,
  TOOL_NAMES,
  WRITE_CAPABILITY,
  loadManifest,
} from '../src/manifest.ts'

describe('manifest — package.json round-trip', () => {
  test('the bundled package.json parses through @neutronai/cores-sdk parseManifest', () => {
    const m = loadManifest()
    expect(m.tier_support).toEqual(['regular'])
    expect(m.capabilities).toContain(READ_CAPABILITY)
    expect(m.capabilities).toContain(WRITE_CAPABILITY)
    // Reminders Core is sidecar-only — no project.db capability is
    // declared (the v1 wiring routes through the engine, which DOES
    // touch the shared reminders table, but the Core's manifest
    // contract stays scoped to its own namespace name).
    expect(m.capabilities).not.toContain('read:project.db')
    expect(m.capabilities).not.toContain('write:project.db')
  })

  test('declares all six MCP tools with locked capability_required values', () => {
    const m = loadManifest()
    const byName = new Map(m.tools.map((t) => [t.name, t]))
    expect(byName.get('reminders_create')?.capability_required).toBe(WRITE_CAPABILITY)
    expect(byName.get('reminders_list')?.capability_required).toBe(READ_CAPABILITY)
    expect(byName.get('reminders_snooze')?.capability_required).toBe(WRITE_CAPABILITY)
    expect(byName.get('reminders_cancel')?.capability_required).toBe(WRITE_CAPABILITY)
    expect(byName.get('reminders_convert_to_task')?.capability_required).toBe(WRITE_CAPABILITY)
    expect(byName.get('reminders_update')?.capability_required).toBe(WRITE_CAPABILITY)
    expect(m.tools).toHaveLength(TOOL_NAMES.length)
    expect(TOOL_NAMES).toContain('reminders_update')
  })

  test('declares zero secrets — reminders v1 stores no external creds', () => {
    const m = loadManifest()
    expect(m.secrets).toEqual([])
    expect(m.linked_sources).toEqual([])
  })

  test('billing_hooks empty per Tier 1 free lock', () => {
    const m = loadManifest()
    expect(m.billing_hooks).toEqual([])
  })

  test('declares a launcher_icon ui_component for the P5.3 launcher tile', () => {
    const m = loadManifest()
    const launcher = m.ui_components.find((u) => u.surface === 'launcher_icon')
    expect(launcher).toBeDefined()
    expect(launcher?.name).toBe('RemindersLauncherIcon')
  })

  test('declares an app_tab ui_component pointing at the P5.5 reminders tab', () => {
    // S1 — the manifest binds the launcher tile to the existing P5.5
    // reminders tab via the `app_tab` surface kind that Notes Core S1
    // (PR #247, merged 2026-05-20) added to the SDK. P5.5 already
    // mounts /api/app/projects/<id>/reminders; the Core does NOT add
    // a parallel HTTP surface. Brief § 8 item 10 path (i).
    const m = loadManifest()
    const tab = m.ui_components.find((u) => u.surface === 'app_tab')
    expect(tab).toBeDefined()
    expect(tab?.name).toBe('RemindersAppTab')
  })

  test('CORE_SLUG and CORE_PACKAGE_NAME constants match the locked values', () => {
    expect(CORE_SLUG).toBe('reminders_core')
    expect(CORE_PACKAGE_NAME).toBe('@neutronai/reminders-core')
  })

  test('capability resource name matches the Core slug so decideDataLayout picks sidecar', () => {
    // The runtime's decideDataLayout matches the substring after the
    // colon (`<slug>.db`) against the Core's derived slug. We assert
    // that pairing here so a future edit that drifts one without the
    // other surfaces immediately.
    expect(READ_CAPABILITY).toBe(`read:${CORE_SLUG}.db`)
    expect(WRITE_CAPABILITY).toBe(`write:${CORE_SLUG}.db`)
  })
})

describe('manifest — error paths', () => {
  test('throws on missing "neutron" section', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'reminders-manifest-'))
    try {
      const path = join(tmp, 'package.json')
      writeFileSync(path, JSON.stringify({ name: '@neutronai/x', version: '0.0.0' }))
      expect(() => loadManifest({ package_json_path: path })).toThrow(
        /no "neutron" section/,
      )
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('throws on a manifest missing required fields (defense-in-depth re Zod)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'reminders-manifest-'))
    try {
      const path = join(tmp, 'package.json')
      writeFileSync(
        path,
        JSON.stringify({
          name: '@neutronai/x',
          version: '0.0.0',
          neutron: {
            capabilities: [],
            // tier_support omitted — must throw
            tools: [],
            ui_components: [],
            billing_hooks: [],
            linked_sources: [],
            secrets: [],
            compat: { coreApi: '^0.1.0' },
            build: { neutronVersion: '0.1.0' },
          },
        }),
      )
      expect(() => loadManifest({ package_json_path: path })).toThrow()
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('manifest — independent re-parse via @neutronai/cores-sdk', () => {
  // Belt-and-suspenders: parse the bundled manifest body through the
  // SDK's parseManifest directly, mirroring what the runtime's loader
  // does at install time. This catches any drift between
  // loadManifest() and the canonical Sprint 24 contract.
  test('runtime-style parse on the bundled package.json round-trips', () => {
    const m = loadManifest()
    const r = parseManifest(m as unknown)
    expect(r.compat.coreApi).toBe('^0.1.0')
    expect(r.build.neutronVersion).toBe('0.1.0')
  })
})
