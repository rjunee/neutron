import { describe, expect, test } from 'bun:test'

import { parseManifest } from '@neutronai/cores-sdk'

import {
  CORE_PACKAGE_NAME,
  CORE_SLUG,
  DOCS_READ_CAPABILITY,
  DOCS_WRITE_CAPABILITY,
  DRIVE_READ_CAPABILITY,
  DRIVE_WRITE_CAPABILITY,
  OAUTH_SECRET_LABEL,
  SHEETS_READ_CAPABILITY,
  SHEETS_WRITE_CAPABILITY,
  TOOL_NAMES,
  loadManifest,
} from '../src/manifest.ts'

import pkg from '../package.json'

describe('Google Workspace Core — manifest', () => {
  test('package.json round-trips through @neutronai/cores-sdk parseManifest', () => {
    expect(() => loadManifest()).not.toThrow()
    const m = loadManifest()
    expect(m.tier_support).toEqual(['regular'])
    expect(m.billing_hooks).toEqual([])
    expect(m.compat.coreApi).toBe('^0.1.0')
    expect(m.build.neutronVersion).toBe('0.1.0')
  })

  test('declares the six per-service read/write capabilities', () => {
    const m = loadManifest()
    for (const cap of [
      DRIVE_READ_CAPABILITY,
      DRIVE_WRITE_CAPABILITY,
      SHEETS_READ_CAPABILITY,
      SHEETS_WRITE_CAPABILITY,
      DOCS_READ_CAPABILITY,
      DOCS_WRITE_CAPABILITY,
    ]) {
      expect(m.capabilities).toContain(cap)
    }
  })

  test('declares ONE required Google OAuth secret covering drive + spreadsheets + documents (per-Core, distinct label)', () => {
    const m = loadManifest()
    expect(m.secrets).toHaveLength(1)
    const secret = m.secrets[0]
    expect(secret?.kind).toBe('oauth_token')
    expect(secret?.label).toBe(OAUTH_SECRET_LABEL)
    // Distinct from Calendar (`google_calendar`) + Email (`gmail_compose`)
    // so each Core's grant connects/disconnects independently — per-Core
    // OAuth, NOT a shared global token.
    expect(OAUTH_SECRET_LABEL).toBe('google_workspace')
    expect(secret?.required).toBe(true)
    const scope = secret?.scope ?? ''
    expect(scope).toContain('https://www.googleapis.com/auth/drive')
    expect(scope).toContain('https://www.googleapis.com/auth/spreadsheets')
    expect(scope).toContain('https://www.googleapis.com/auth/documents')
    expect(secret?.install_prompt.length).toBeGreaterThan(0)
  })

  test('declares google-drive as a read_write linked source', () => {
    const m = loadManifest()
    expect(m.linked_sources).toHaveLength(1)
    const ls = m.linked_sources[0]
    expect(ls?.kind).toBe('google-drive')
    expect(ls?.scope).toBe('read_write')
    expect(ls?.target_kinds).toContain('user')
  })

  test('nine tools with locked per-service capability_required values', () => {
    const m = loadManifest()
    const byName = new Map(m.tools.map((t) => [t.name, t]))
    expect(byName.size).toBe(9)
    expect(byName.get('drive_list')?.capability_required).toBe(DRIVE_READ_CAPABILITY)
    expect(byName.get('drive_read')?.capability_required).toBe(DRIVE_READ_CAPABILITY)
    expect(byName.get('drive_upload')?.capability_required).toBe(DRIVE_WRITE_CAPABILITY)
    expect(byName.get('sheets_read')?.capability_required).toBe(SHEETS_READ_CAPABILITY)
    expect(byName.get('sheets_append')?.capability_required).toBe(SHEETS_WRITE_CAPABILITY)
    expect(byName.get('sheets_update')?.capability_required).toBe(SHEETS_WRITE_CAPABILITY)
    expect(byName.get('docs_read')?.capability_required).toBe(DOCS_READ_CAPABILITY)
    expect(byName.get('docs_create')?.capability_required).toBe(DOCS_WRITE_CAPABILITY)
    expect(byName.get('docs_update')?.capability_required).toBe(DOCS_WRITE_CAPABILITY)
  })

  test('every tool capability_required is also declared in capabilities[]', () => {
    const m = loadManifest()
    for (const t of m.tools) {
      expect(m.capabilities).toContain(t.capability_required)
    }
  })

  test('NO `.db`-suffixed capability — persistence delegated to Google (no sidecar)', () => {
    const m = loadManifest()
    for (const cap of m.capabilities) {
      expect(cap.endsWith('.db')).toBe(false)
    }
  })

  test('TOOL_NAMES tuple matches manifest tools[] one-to-one', () => {
    const m = loadManifest()
    const fromManifest = m.tools.map((t) => t.name).sort()
    const fromConst = [...TOOL_NAMES].sort()
    expect(fromManifest).toEqual(fromConst)
  })

  test('no UI components declared (no admin UI this sprint)', () => {
    const m = loadManifest()
    expect(m.ui_components).toEqual([])
  })

  test('CORE_SLUG / CORE_PACKAGE_NAME pinned to the shipped package.json', () => {
    expect(CORE_PACKAGE_NAME).toBe('@neutronai/google-workspace-core')
    expect(CORE_SLUG).toBe('google_workspace_core')
    expect(pkg.name).toBe(CORE_PACKAGE_NAME)
  })

  test('manifest body parses cleanly via the SDK directly (no loader indirection)', () => {
    const direct = parseManifest((pkg as { neutron: unknown }).neutron)
    expect(direct.tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort())
  })

  test('loadManifest rejects a package.json without a "neutron" section', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'gws-core-manifest-'))
    const path = join(dir, 'package.json')
    writeFileSync(
      path,
      JSON.stringify({ name: '@neutronai/google-workspace-core-bad', version: '0.0.0' }),
    )
    expect(() => loadManifest({ package_json_path: path })).toThrow(/no "neutron" section/)
  })
})
