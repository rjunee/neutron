import { describe, expect, test } from 'bun:test'

import {
  NeutronManifestSchema,
  parseManifest,
  safeParseManifest,
  type NeutronManifest,
} from '../manifest.ts'

const validManifest: NeutronManifest = {
  capabilities: ['read:project.db', 'write:project.db', 'connect:shopify'],
  tier_support: ['regular'],
  tools: [
    {
      name: 'rebuild_cm_daily',
      description: 'Rebuild materialized cm_daily table.',
      input_schema: { type: 'object', properties: {} },
      output_schema: { type: 'object', properties: { rows: { type: 'number' } } },
      capability_required: 'write:project.db',
    },
  ],
  ui_components: [
    {
      name: 'DtcAdmin',
      entry_point: './admin/index.tsx',
      surface: 'route_mount',
      mount_path: '/admin',
    },
  ],
  billing_hooks: [],
  linked_sources: [
    { kind: 'shopify', scope: 'read', target_kinds: ['user'] },
  ],
  secrets: [
    {
      name: 'shopify_access_token',
      kind: 'byo_api_key',
      label: 'shopify',
      scope: 'read:orders',
      required: true,
      install_prompt: 'Paste your Shopify Admin API token.',
    },
  ],
  compat: { coreApi: '^1.0.0' },
  build: { neutronVersion: '0.1.0' },
}

describe('manifest — Zod round-trip', () => {
  test('parseManifest accepts a fully populated valid manifest', () => {
    const parsed = parseManifest(validManifest)
    expect(parsed.capabilities).toContain('read:project.db')
    expect(parsed.tier_support).toEqual(['regular'])
    expect(parsed.ui_components[0]?.mount_path).toBe('/admin')
  })

  test('safeParseManifest returns success on a valid manifest', () => {
    const r = safeParseManifest(validManifest)
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.secrets[0]?.kind).toBe('byo_api_key')
    }
  })

  test('schema parses an empty-arrays-everywhere skeleton', () => {
    const skeleton: NeutronManifest = {
      capabilities: [],
      tier_support: ['regular'],
      tools: [],
      ui_components: [],
      billing_hooks: [],
      linked_sources: [],
      secrets: [],
      compat: { coreApi: '^1.0.0' },
      build: { neutronVersion: '0.1.0' },
    }
    expect(() => parseManifest(skeleton)).not.toThrow()
  })
})

describe('manifest — compat + build (core-sdk parity)', () => {
  test('rejects missing compat block', () => {
    const { compat: _omit, ...rest } = validManifest
    const r = NeutronManifestSchema.safeParse(rest)
    expect(r.success).toBe(false)
  })

  test('rejects missing build block', () => {
    const { build: _omit, ...rest } = validManifest
    const r = NeutronManifestSchema.safeParse(rest)
    expect(r.success).toBe(false)
  })

  test('rejects compat.coreApi empty string', () => {
    const r = NeutronManifestSchema.safeParse({
      ...validManifest,
      compat: { coreApi: '' },
    })
    expect(r.success).toBe(false)
  })

  test('rejects build.neutronVersion empty string', () => {
    const r = NeutronManifestSchema.safeParse({
      ...validManifest,
      build: { neutronVersion: '' },
    })
    expect(r.success).toBe(false)
  })
})

describe('manifest — required-field rejection', () => {
  test('rejects missing tier_support', () => {
    const { tier_support: _omit, ...rest } = validManifest
    const r = NeutronManifestSchema.safeParse(rest)
    expect(r.success).toBe(false)
  })

  test('rejects empty tier_support', () => {
    const r = NeutronManifestSchema.safeParse({ ...validManifest, tier_support: [] })
    expect(r.success).toBe(false)
  })

  test('rejects unknown tier_support value', () => {
    const r = NeutronManifestSchema.safeParse({
      ...validManifest,
      tier_support: ['premium'],
    })
    expect(r.success).toBe(false)
  })

  test("accepts tier_support 'both' (Codex r4 — core-sdk parity)", () => {
    const r = NeutronManifestSchema.safeParse({
      ...validManifest,
      tier_support: ['both'],
    })
    expect(r.success).toBe(true)
  })

  test('rejects missing secrets array (cannot be omitted)', () => {
    const { secrets: _omit, ...rest } = validManifest
    const r = NeutronManifestSchema.safeParse(rest)
    expect(r.success).toBe(false)
  })
})

describe('manifest — capability format', () => {
  test('accepts <verb>:<resource> shape', () => {
    const r = NeutronManifestSchema.safeParse({
      ...validManifest,
      capabilities: ['read:gmail', 'connect:google-ads', 'fs:project_data'],
    })
    expect(r.success).toBe(true)
  })

  test('accepts the canonical project.db shared-DB capability', () => {
    const r = NeutronManifestSchema.safeParse({
      ...validManifest,
      capabilities: ['read:project.db', 'write:project.db'],
    })
    expect(r.success).toBe(true)
  })

  test('rejects bare-verb capability without colon', () => {
    const r = NeutronManifestSchema.safeParse({
      ...validManifest,
      capabilities: ['read'],
    })
    expect(r.success).toBe(false)
  })

  test('rejects empty capability string', () => {
    const r = NeutronManifestSchema.safeParse({
      ...validManifest,
      capabilities: [''],
    })
    expect(r.success).toBe(false)
  })

  test('rejects mixed-case capability (Codex r5 P2)', () => {
    // Lowercase-only — core-sdk's KNOWN_CAPABILITIES match is exact,
    // so accepting `Read:Gmail` here would split the validators.
    const r = NeutronManifestSchema.safeParse({
      ...validManifest,
      capabilities: ['Read:Gmail'],
    })
    expect(r.success).toBe(false)
  })
})

describe('manifest — route_mount refinement', () => {
  test('parseManifest throws when route_mount has no mount_path', () => {
    const bad = {
      ...validManifest,
      ui_components: [
        {
          name: 'X',
          entry_point: './x.tsx',
          surface: 'route_mount' as const,
          // mount_path omitted — Zod accepts this on the per-field schema,
          // but the refinement in parseManifest must reject.
        },
      ],
    }
    expect(() => parseManifest(bad)).toThrow()
  })

  test('safeParseManifest returns failure for missing mount_path', () => {
    const bad = {
      ...validManifest,
      ui_components: [
        {
          name: 'X',
          entry_point: './x.tsx',
          surface: 'route_mount' as const,
        },
      ],
    }
    const r = safeParseManifest(bad)
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues[0]?.path.join('.')).toContain('mount_path')
    }
  })

  test('rejects relative mount_path (Codex r7 P2)', () => {
    const bad = {
      ...validManifest,
      ui_components: [
        {
          name: 'Admin',
          entry_point: './admin/index.tsx',
          surface: 'route_mount' as const,
          mount_path: 'admin',
        },
      ],
    }
    expect(() => parseManifest(bad)).toThrow()
  })

  test('rejects trailing-slash mount_path', () => {
    const bad = {
      ...validManifest,
      ui_components: [
        {
          name: 'Admin',
          entry_point: './admin/index.tsx',
          surface: 'route_mount' as const,
          mount_path: '/admin/',
        },
      ],
    }
    expect(() => parseManifest(bad)).toThrow()
  })

  test('accepts nested absolute mount_path', () => {
    const ok = {
      ...validManifest,
      ui_components: [
        {
          name: 'Admin',
          entry_point: './admin/index.tsx',
          surface: 'route_mount' as const,
          mount_path: '/admin/settings',
        },
      ],
    }
    expect(() => parseManifest(ok)).not.toThrow()
  })

  test('NeutronManifestSchema.safeParse enforces refinement directly (Codex r8 P2)', () => {
    // Callers that bypass parseManifest by reaching for the raw
    // schema must STILL get the route_mount cross-field check.
    const bad = {
      ...validManifest,
      ui_components: [
        {
          name: 'Admin',
          entry_point: './admin/index.tsx',
          surface: 'route_mount' as const,
          // mount_path omitted
        },
      ],
    }
    const r = NeutronManifestSchema.safeParse(bad)
    expect(r.success).toBe(false)
    if (!r.success) {
      const paths = r.error.issues.map((i) => i.path.join('.'))
      expect(paths.some((p) => p.includes('mount_path'))).toBe(true)
    }
  })

  test('non-route_mount surfaces ignore mount_path', () => {
    const ok = {
      ...validManifest,
      ui_components: [
        {
          name: 'Launcher',
          entry_point: './launcher.tsx',
          surface: 'launcher_icon' as const,
        },
      ],
    }
    expect(() => parseManifest(ok)).not.toThrow()
  })
})

describe('manifest — linked_sources (Codex r4 — core-sdk parity)', () => {
  test('accepts free-form kind with required scope + target_kinds', () => {
    const r = NeutronManifestSchema.safeParse({
      ...validManifest,
      linked_sources: [
        { kind: 'shopify', scope: 'read', target_kinds: ['user'] },
        { kind: 'google-ads', scope: 'read', target_kinds: ['user', 'workspace'] },
      ],
    })
    expect(r.success).toBe(true)
  })

  test('rejects linked_sources entry missing scope', () => {
    const r = NeutronManifestSchema.safeParse({
      ...validManifest,
      linked_sources: [{ kind: 'shopify', target_kinds: [] }],
    })
    expect(r.success).toBe(false)
  })

  test('rejects linked_sources entry missing target_kinds', () => {
    const r = NeutronManifestSchema.safeParse({
      ...validManifest,
      linked_sources: [{ kind: 'shopify', scope: 'read' }],
    })
    expect(r.success).toBe(false)
  })
})

describe('manifest — billing_hooks (Codex r4 — core-sdk parity)', () => {
  test('accepts billing_hooks with full price shape', () => {
    const r = NeutronManifestSchema.safeParse({
      ...validManifest,
      billing_hooks: [
        { model: 'flat_monthly', price_cents: 999, currency: 'USD' },
      ],
    })
    expect(r.success).toBe(true)
  })

  test('rejects unknown billing model', () => {
    const r = NeutronManifestSchema.safeParse({
      ...validManifest,
      billing_hooks: [
        { model: 'subscription', price_cents: 100, currency: 'USD' },
      ],
    })
    expect(r.success).toBe(false)
  })
})

describe('manifest — secrets block', () => {
  test('accepts oauth_token with scope', () => {
    const r = NeutronManifestSchema.safeParse({
      ...validManifest,
      secrets: [
        {
          name: 'gmail_oauth',
          kind: 'oauth_token',
          label: 'google',
          scope: 'https://www.googleapis.com/auth/gmail.readonly',
          required: true,
          install_prompt: 'Connect Gmail.',
        },
      ],
    })
    expect(r.success).toBe(true)
  })

  test('rejects unknown secret kind', () => {
    const r = NeutronManifestSchema.safeParse({
      ...validManifest,
      secrets: [
        {
          name: 'x',
          kind: 'aes_master',
          label: 'x',
          required: true,
          install_prompt: 'x',
        },
      ],
    })
    expect(r.success).toBe(false)
  })
})
