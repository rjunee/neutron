import { describe, expect, test } from 'bun:test'

import { parseManifest } from '@neutronai/cores-sdk'

import {
  CORE_PACKAGE_NAME,
  CORE_SLUG,
  OAUTH_SECRET_LABEL,
  PROJECT_ID_EXTENDED_PROPERTY,
  READ_CAPABILITY,
  TOOL_NAMES,
  WRITE_CAPABILITY,
  loadManifest,
} from '../src/manifest.ts'

import pkg from '../package.json'

describe('Calendar Core — manifest', () => {
  test('package.json round-trip through @neutronai/cores-sdk parseManifest', () => {
    expect(() => loadManifest()).not.toThrow()
    const m = loadManifest()
    expect(m.capabilities).toContain(READ_CAPABILITY)
    expect(m.capabilities).toContain(WRITE_CAPABILITY)
    expect(m.tier_support).toEqual(['regular'])
    expect(m.billing_hooks).toEqual([])
    expect(m.compat.coreApi).toBe('^0.1.0')
    expect(m.build.neutronVersion).toBe('0.1.0')
  })

  test('manifest declares one required Google Calendar OAuth secret', () => {
    const m = loadManifest()
    expect(m.secrets).toHaveLength(1)
    const secret = m.secrets[0]
    expect(secret?.kind).toBe('oauth_token')
    expect(secret?.label).toBe(OAUTH_SECRET_LABEL)
    expect(secret?.required).toBe(true)
    expect(secret?.scope).toContain('googleapis.com/auth/calendar')
    expect(secret?.install_prompt.length).toBeGreaterThan(0)
  })

  test('manifest declares Google Calendar as a linked source', () => {
    const m = loadManifest()
    expect(m.linked_sources).toHaveLength(1)
    const ls = m.linked_sources[0]
    expect(ls?.kind).toBe('google-calendar')
    expect(ls?.scope).toBe('read_write')
    expect(ls?.target_kinds).toContain('user')
  })

  test('nine tools declared with locked capability_required values', () => {
    const m = loadManifest()
    const byName = new Map(m.tools.map((t) => [t.name, t]))
    expect(byName.size).toBe(9)
    expect(byName.get('calendar_list')?.capability_required).toBe(READ_CAPABILITY)
    expect(byName.get('calendar_create')?.capability_required).toBe(WRITE_CAPABILITY)
    expect(byName.get('calendar_update')?.capability_required).toBe(WRITE_CAPABILITY)
    expect(byName.get('calendar_cancel')?.capability_required).toBe(WRITE_CAPABILITY)
    expect(byName.get('calendar_brief')?.capability_required).toBe(READ_CAPABILITY)
    // S1 additions:
    expect(byName.get('calendar_freebusy')?.capability_required).toBe(READ_CAPABILITY)
    expect(byName.get('calendar_find_time')?.capability_required).toBe(READ_CAPABILITY)
    expect(byName.get('calendar_invite')?.capability_required).toBe(WRITE_CAPABILITY)
    expect(byName.get('calendar_send_pre_meeting_brief')?.capability_required).toBe(
      READ_CAPABILITY,
    )
  })

  test('PROJECT_ID_EXTENDED_PROPERTY locked at "neutron_project_id"', () => {
    expect(PROJECT_ID_EXTENDED_PROPERTY).toBe('neutron_project_id')
  })

  test('S1 tools accept the expected input fields per the manifest schema', () => {
    const m = loadManifest()
    const byName = new Map(m.tools.map((t) => [t.name, t]))
    // calendar_freebusy
    const freebusyProps = (byName.get('calendar_freebusy')?.input_schema.properties ?? {}) as Record<
      string,
      { type: unknown }
    >
    expect(freebusyProps['attendees']).toBeDefined()
    expect(freebusyProps['window_start']).toBeDefined()
    expect(freebusyProps['window_end']).toBeDefined()
    // calendar_find_time
    const findTimeProps = (byName.get('calendar_find_time')?.input_schema.properties ?? {}) as Record<
      string,
      { type: unknown }
    >
    expect(findTimeProps['duration_minutes']).toBeDefined()
    expect(findTimeProps['granularity_minutes']).toBeDefined()
    expect(findTimeProps['max_slots']).toBeDefined()
    // calendar_invite
    const inviteProps = (byName.get('calendar_invite')?.input_schema.properties ?? {}) as Record<
      string,
      { type: unknown }
    >
    expect(inviteProps['add_emails']).toBeDefined()
    expect(inviteProps['send_updates']).toBeDefined()
    // calendar_send_pre_meeting_brief
    const briefProps = (byName.get('calendar_send_pre_meeting_brief')?.input_schema
      .properties ?? {}) as Record<string, { type: unknown }>
    expect(briefProps['project_id']).toBeDefined()
    expect(briefProps['dry_run']).toBeDefined()
  })

  test('TOOL_NAMES tuple matches manifest tools[] one-to-one', () => {
    const m = loadManifest()
    const fromManifest = m.tools.map((t) => t.name).sort()
    const fromConst = [...TOOL_NAMES].sort()
    expect(fromManifest).toEqual(fromConst)
  })

  test('launcher_icon + app_tab UI surfaces are present', () => {
    const m = loadManifest()
    expect(m.ui_components).toHaveLength(2)
    const icon = m.ui_components.find((c) => c.surface === 'launcher_icon')
    expect(icon?.name).toBe('CalendarLauncherIcon')
    expect(icon?.entry_point).toBe('./src/ui/launcher-icon.ts')
    const tab = m.ui_components.find((c) => c.surface === 'app_tab')
    expect(tab?.name).toBe('CalendarAppTab')
    expect(tab?.entry_point).toBe('./src/ui/app-tab-surface.ts')
  })

  test('CORE_SLUG / CORE_PACKAGE_NAME constants pinned to the shipped package.json', () => {
    expect(CORE_PACKAGE_NAME).toBe('@neutronai/calendar-core')
    expect(CORE_SLUG).toBe('calendar_core')
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
    const dir = mkdtempSync(join(tmpdir(), 'calendar-core-manifest-'))
    const path = join(dir, 'package.json')
    writeFileSync(
      path,
      JSON.stringify({ name: '@neutronai/calendar-core-bad', version: '0.0.0' }),
    )
    expect(() => loadManifest({ package_json_path: path })).toThrow(
      /no "neutron" section/,
    )
  })

  test('loadManifest rejects when tier_support is empty', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'calendar-core-manifest-'))
    const path = join(dir, 'package.json')
    const bad = {
      name: '@neutronai/calendar-core-bad',
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
