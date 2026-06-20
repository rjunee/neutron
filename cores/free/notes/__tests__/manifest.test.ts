import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseManifest } from '@neutronai/cores-sdk'

import {
  CORE_PACKAGE_NAME,
  CORE_SLUG,
  FTS_READ_CAPABILITY,
  FTS_WRITE_CAPABILITY,
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
    // Notes Core S1 — FTS-scoped capability rows for finer audit.
    expect(m.capabilities).toContain(FTS_READ_CAPABILITY)
    expect(m.capabilities).toContain(FTS_WRITE_CAPABILITY)
    // No project.db capability — Notes is sidecar-only.
    expect(m.capabilities).not.toContain('read:project.db')
    expect(m.capabilities).not.toContain('write:project.db')
  })

  test('declares the eight MCP tools with locked capability_required values', () => {
    const m = loadManifest()
    const byName = new Map(m.tools.map((t) => [t.name, t]))
    expect(byName.get('notes_write')?.capability_required).toBe(WRITE_CAPABILITY)
    expect(byName.get('notes_recall')?.capability_required).toBe(READ_CAPABILITY)
    expect(byName.get('notes_list')?.capability_required).toBe(READ_CAPABILITY)
    expect(byName.get('notes_link')?.capability_required).toBe(WRITE_CAPABILITY)
    expect(byName.get('notes_create_drawer')?.capability_required).toBe(WRITE_CAPABILITY)
    expect(byName.get('notes_drawer_list')?.capability_required).toBe(READ_CAPABILITY)
    expect(byName.get('notes_search')?.capability_required).toBe(FTS_READ_CAPABILITY)
    expect(byName.get('notes_traverse')?.capability_required).toBe(READ_CAPABILITY)
    expect(m.tools).toHaveLength(TOOL_NAMES.length)
  })

  test('declares zero secrets — second-brain stores no external creds at v1', () => {
    const m = loadManifest()
    expect(m.secrets).toEqual([])
    expect(m.linked_sources).toEqual([])
  })

  test('billing_hooks empty per Tier 1 free lock', () => {
    const m = loadManifest()
    expect(m.billing_hooks).toEqual([])
  })

  test('declares a launcher_icon + app_tab ui_component for P5.3 tile binding', () => {
    const m = loadManifest()
    const launcher = m.ui_components.find((u) => u.surface === 'launcher_icon')
    expect(launcher).toBeDefined()
    expect(launcher?.name).toBe('NotesLauncherIcon')
    const appTab = m.ui_components.find((u) => u.surface === 'app_tab')
    expect(appTab).toBeDefined()
    expect(appTab?.name).toBe('NotesAppTab')
  })

  test('CORE_SLUG and CORE_PACKAGE_NAME constants match the locked values', () => {
    expect(CORE_SLUG).toBe('notes')
    expect(CORE_PACKAGE_NAME).toBe('@neutronai/notes')
  })
})

describe('manifest — error paths', () => {
  test('throws on missing "neutron" section', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'notes-manifest-'))
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
    const tmp = mkdtempSync(join(tmpdir(), 'notes-manifest-'))
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
