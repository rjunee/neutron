import { describe, expect, test } from 'bun:test'

import { parseManifest } from '@neutronai/cores-sdk'

import {
  CORE_PACKAGE_NAME,
  CORE_SLUG,
  OAUTH_SECRET_LABEL,
  READ_CAPABILITY,
  SEND_CAPABILITY,
  TOOL_NAMES,
  WRITE_CAPABILITY,
  loadManifest,
} from '../src/manifest.ts'

import pkg from '../package.json'

describe('Email-Managed Core — manifest', () => {
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

  test('manifest declares one required Gmail OAuth secret with the FOUR-scope grant (readonly + modify + compose + send)', () => {
    const m = loadManifest()
    expect(m.secrets).toHaveLength(1)
    const secret = m.secrets[0]
    expect(secret?.kind).toBe('oauth_token')
    expect(secret?.label).toBe(OAUTH_SECRET_LABEL)
    expect(secret?.required).toBe(true)
    // Argus r1 BLOCKER #2 (2026-05-21) — the prior single-scope shape
    // (gmail.compose only) would 403 against real Gmail on every
    // read path (messages.list / messages.get) AND on the threads.
    // modify call the Sam 4-point draft policy fires after every
    // drafts.create. The 3-scope split:
    //   - gmail.readonly  → list/read/search/summarize/triage
    //   - gmail.modify    → threads.modify for the 4-point labels
    //   - gmail.compose   → drafts.create
    // gmail.send is INTENTIONALLY EXCLUDED — Tier 1 is drafts-only
    // by product AND by OAuth grant. The persisted token cannot
    // send mail with these three scopes.
    const scope = secret?.scope ?? ''
    expect(scope).toContain('https://www.googleapis.com/auth/gmail.readonly')
    expect(scope).toContain('https://www.googleapis.com/auth/gmail.modify')
    expect(scope).toContain('https://www.googleapis.com/auth/gmail.compose')
    // gap-audit P0 (2026-06-20) — Gmail-send shipped; the grant now
    // also covers gmail.send for the email_send tool.
    expect(scope).toContain('https://www.googleapis.com/auth/gmail.send')
    expect(secret?.install_prompt.length).toBeGreaterThan(0)
  })

  test('manifest declares Gmail as a linked source', () => {
    const m = loadManifest()
    expect(m.linked_sources).toHaveLength(1)
    const ls = m.linked_sources[0]
    expect(ls?.kind).toBe('gmail')
    expect(ls?.scope).toBe('read_write')
    expect(ls?.target_kinds).toContain('user')
  })

  test('seven tools declared with locked capability_required values — drafts vs send write capabilities, five read', () => {
    const m = loadManifest()
    const byName = new Map(m.tools.map((t) => [t.name, t]))
    expect(byName.size).toBe(7)
    expect(byName.get('email_list')?.capability_required).toBe(READ_CAPABILITY)
    expect(byName.get('email_read')?.capability_required).toBe(READ_CAPABILITY)
    expect(byName.get('email_search')?.capability_required).toBe(READ_CAPABILITY)
    expect(byName.get('email_summarize')?.capability_required).toBe(READ_CAPABILITY)
    expect(byName.get('email_triage')?.capability_required).toBe(READ_CAPABILITY)
    expect(byName.get('email_draft_prepare')?.capability_required).toBe(WRITE_CAPABILITY)
    // Send gets its OWN write capability (distinct from drafts) for
    // clean audit attribution.
    expect(byName.get('email_send')?.capability_required).toBe(SEND_CAPABILITY)
  })

  test('email_send tool shipped with its own send capability + gmail.send grant (gap-audit P0 reversal)', () => {
    // HISTORY: send was originally carved OUT (Tier 1 drafts-only,
    // reserved for a Tier 2 paid Core). The gap-audit (2026-06-20, P0)
    // reversed that product decision — Gmail-send is a daily-driver
    // need — so this guard now asserts the INVERSE of the old one:
    // the email_send tool is declared, it requires its OWN distinct
    // send capability (clean audit attribution), and the OAuth grant
    // includes gmail.send. The 4-point DRAFT rule is unchanged (see
    // the draft-prepare + draft-policy tests).
    const m = loadManifest()
    const toolNames = m.tools.map((t) => t.name)
    expect(toolNames).toContain('email_send')
    const send = m.tools.find((t) => t.name === 'email_send')
    expect(send?.capability_required).toBe(SEND_CAPABILITY)
    expect(SEND_CAPABILITY).toBe('write:email_managed_core.send')
    // Send capability is DISTINCT from the drafts write capability.
    expect(SEND_CAPABILITY).not.toBe(WRITE_CAPABILITY)
    expect(m.capabilities).toContain(SEND_CAPABILITY)
    const scope = m.secrets[0]?.scope ?? ''
    expect(scope).toContain('gmail.send')
    // email_send applied_labels output is part of the contract.
    const out = send?.output_schema as { properties?: Record<string, unknown> }
    expect(out.properties?.['applied_labels']).toBeDefined()
  })

  test('NO `.db`-suffixed capability — Email-Managed Core delegates persistence to Gmail (tables layout, no sidecar)', () => {
    // Regression: a capability like `read:email_managed_core.db` would
    // trigger the runtime's sidecar allocator (a sidecar SQLite file
    // at `<dataDir>/cores/email_managed_core.db`), but the Core has no
    // local mirror — every read/write goes to Gmail. The `.messages`
    // / `.drafts` suffixes are deliberately NOT `.db`.
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

  test('launcher_icon + app_tab UI surfaces are present (S1 manifest extension)', () => {
    const m = loadManifest()
    expect(m.ui_components).toHaveLength(2)
    const icon = m.ui_components.find((u) => u.surface === 'launcher_icon')
    expect(icon).toBeDefined()
    expect(icon?.name).toBe('EmailManagedLauncherIcon')
    expect(icon?.entry_point).toBe('./src/ui/launcher-icon.ts')
    const appTab = m.ui_components.find((u) => u.surface === 'app_tab')
    expect(appTab).toBeDefined()
    expect(appTab?.name).toBe('EmailManagedAppTab')
    expect(appTab?.entry_point).toBe('./src/ui/app-tab-surface.ts')
  })

  test('email_triage MCP tool is present (S1 manifest extension)', () => {
    const m = loadManifest()
    const triage = m.tools.find((t) => t.name === 'email_triage')
    expect(triage).toBeDefined()
    expect(triage?.capability_required).toBe(READ_CAPABILITY)
  })

  test('email_summarize input schema honors as_brief flag (S1 extension)', () => {
    const m = loadManifest()
    const summarize = m.tools.find((t) => t.name === 'email_summarize')
    expect(summarize).toBeDefined()
    const schema = summarize?.input_schema as {
      properties?: Record<string, unknown>
    }
    expect(schema.properties).toBeDefined()
    expect(schema.properties!['as_brief']).toBeDefined()
  })

  test('email_draft_prepare output schema includes applied_labels (S1 4-point requirement)', () => {
    const m = loadManifest()
    const draft = m.tools.find((t) => t.name === 'email_draft_prepare')
    expect(draft).toBeDefined()
    const schema = draft?.output_schema as {
      properties?: Record<string, unknown>
      required?: string[]
    }
    expect(schema.properties).toBeDefined()
    expect(schema.properties!['applied_labels']).toBeDefined()
    expect(schema.required).toContain('applied_labels')
  })

  test('CORE_SLUG / CORE_PACKAGE_NAME constants pinned to the shipped package.json', () => {
    expect(CORE_PACKAGE_NAME).toBe('@neutronai/email-managed-core')
    expect(CORE_SLUG).toBe('email_managed_core')
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
    const dir = mkdtempSync(join(tmpdir(), 'email-managed-core-manifest-'))
    const path = join(dir, 'package.json')
    writeFileSync(
      path,
      JSON.stringify({ name: '@neutronai/email-managed-core-bad', version: '0.0.0' }),
    )
    expect(() => loadManifest({ package_json_path: path })).toThrow(
      /no "neutron" section/,
    )
  })

  test('loadManifest rejects when tier_support is empty', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'email-managed-core-manifest-'))
    const path = join(dir, 'package.json')
    const bad = {
      name: '@neutronai/email-managed-core-bad',
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
