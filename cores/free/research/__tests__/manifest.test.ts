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
    // S1 — Research Core supports both regular + private tiers.
    expect(m.tier_support).toEqual(['regular', 'private'])
    expect(m.capabilities).toContain(READ_CAPABILITY)
    expect(m.capabilities).toContain(WRITE_CAPABILITY)
    // S1 — `network:browse` (new SDK capability) + `agent:dispatch_subagent`
    // are declared for the `/research deep` sub-agent path.
    expect(m.capabilities).toContain('network:browse')
    expect(m.capabilities).toContain('agent:dispatch_subagent')
    // Research Core is sidecar-only — no project.db access.
    expect(m.capabilities).not.toContain('read:project.db')
    expect(m.capabilities).not.toContain('write:project.db')
  })

  test('declares the eight MCP tools with locked capability_required values', () => {
    const m = loadManifest()
    const byName = new Map(m.tools.map((t) => [t.name, t]))
    expect(byName.get('research_start')?.capability_required).toBe(WRITE_CAPABILITY)
    expect(byName.get('research_status')?.capability_required).toBe(READ_CAPABILITY)
    expect(byName.get('research_fetch')?.capability_required).toBe(READ_CAPABILITY)
    expect(byName.get('research_deep')?.capability_required).toBe(WRITE_CAPABILITY)
    expect(byName.get('research_list')?.capability_required).toBe(READ_CAPABILITY)
    expect(byName.get('research_find')?.capability_required).toBe(READ_CAPABILITY)
    expect(byName.get('research_cite')?.capability_required).toBe(WRITE_CAPABILITY)
    expect(byName.get('research_claims_list')?.capability_required).toBe(READ_CAPABILITY)
    expect(m.tools).toHaveLength(TOOL_NAMES.length)
  })

  test('declares the tavily secret as optional + linked-source for discoverability', () => {
    const m = loadManifest()
    expect(m.secrets).toHaveLength(1)
    const tavily = m.secrets[0]
    expect(tavily?.label).toBe('tavily')
    expect(tavily?.required).toBe(false)
    expect(m.linked_sources.length).toBeGreaterThanOrEqual(1)
  })

  test('billing_hooks empty per Tier 1 free lock', () => {
    const m = loadManifest()
    expect(m.billing_hooks).toEqual([])
  })

  test('declares a launcher_icon + app_tab ui_component (P5.3 + P5.x)', () => {
    const m = loadManifest()
    const launcher = m.ui_components.find((u) => u.surface === 'launcher_icon')
    expect(launcher).toBeDefined()
    expect(launcher?.name).toBe('ResearchLauncherIcon')
    const appTab = m.ui_components.find((u) => u.surface === 'app_tab')
    expect(appTab).toBeDefined()
    expect(appTab?.name).toBe('ResearchAppTab')
  })

  test('CORE_SLUG and CORE_PACKAGE_NAME constants match the locked values', () => {
    expect(CORE_SLUG).toBe('research_core')
    expect(CORE_PACKAGE_NAME).toBe('@neutronai/research-core')
  })

  test('capability resource name matches the Core slug so decideDataLayout picks sidecar', () => {
    expect(READ_CAPABILITY).toBe(`read:${CORE_SLUG}.db`)
    expect(WRITE_CAPABILITY).toBe(`write:${CORE_SLUG}.db`)
  })

  test('research_fetch output schema pins the brief shape contract', () => {
    // The brief shape is the public contract; lock it into the schema so a
    // drift in the package.json body trips this test before the runtime
    // composer ever sees it.
    const m = loadManifest()
    const fetchTool = m.tools.find((t) => t.name === 'research_fetch')
    expect(fetchTool).toBeDefined()
    const output = fetchTool?.output_schema as
      | { properties?: Record<string, unknown> }
      | undefined
    const briefSchema = output?.properties?.['brief'] as
      | {
          required?: string[]
          properties?: Record<string, unknown>
        }
      | undefined
    expect(briefSchema).toBeDefined()
    expect(briefSchema?.required?.sort()).toEqual(
      [
        'topic',
        'key_findings',
        'sources',
        'confidence_level',
        'recommendations',
      ].sort(),
    )
    const confidence = briefSchema?.properties?.['confidence_level'] as
      | { enum?: string[] }
      | undefined
    expect(confidence?.enum).toEqual(['low', 'medium', 'high'])
  })
})

describe('manifest — error paths', () => {
  test('throws on missing "neutron" section', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'research-manifest-'))
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
    const tmp = mkdtempSync(join(tmpdir(), 'research-manifest-'))
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
  test('runtime-style parse on the bundled package.json round-trips', () => {
    const m = loadManifest()
    const r = parseManifest(m as unknown)
    expect(r.compat.coreApi).toBe('^0.1.0')
    expect(r.build.neutronVersion).toBe('0.2.0')
  })
})
