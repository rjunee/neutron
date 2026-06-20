import { describe, expect, test } from 'bun:test'
import schemaJson from './manifest.schema.json' with { type: 'json' }
import { validateAgainstSchema } from './_schema-runner.ts'
import type { NeutronManifest } from './types.ts'
import {
  ERROR_CODES,
  WARNING_CODES,
  isValidSemverRange,
  validateNeutronManifest,
} from './validator.ts'

const minimalManifest: NeutronManifest = {
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

const fullManifest: NeutronManifest = {
  capabilities: [
    'read:gmail',
    'write:gmail',
    'read:project_data',
    'write:project_data',
    'network:external',
    'fs:project_data',
    'fs:cache',
    'agent:dispatch_subagent',
    'mcp:tool_register',
  ],
  tier_support: ['regular', 'private', 'both'],
  tools: [
    {
      name: 'list_threads',
      description: "List Gmail threads in the user's inbox.",
      input_schema: { type: 'object', properties: { limit: { type: 'number' } } },
      output_schema: { type: 'object', properties: { threads: { type: 'array' } } },
      capability_required: 'read:gmail',
    },
  ],
  ui_components: [
    {
      name: 'EmailLauncher',
      entry_point: './ui/EmailLauncher.tsx',
      surface: 'launcher_icon',
      props_schema: { type: 'object' },
    },
    {
      name: 'EmailProjectTab',
      entry_point: './ui/EmailProjectTab.tsx',
      surface: 'project_tab',
    },
    {
      name: 'EmailSettings',
      entry_point: './ui/EmailSettings.tsx',
      surface: 'settings_panel',
    },
    {
      name: 'EmailAdmin',
      entry_point: './ui/EmailAdmin.tsx',
      surface: 'route_mount',
      mount_path: '/admin',
    },
  ],
  billing_hooks: [
    {
      model: 'flat_monthly',
      price_cents: 999,
      currency: 'USD',
      on_install: './hooks/onInstall.ts',
      on_uninstall: './hooks/onUninstall.ts',
    },
    {
      model: 'usage_metered',
      price_cents: 1,
      currency: 'USD',
    },
  ],
  linked_sources: [
    {
      kind: 'gmail',
      scope: 'read',
      target_kinds: ['user', 'workspace'],
    },
    {
      kind: 'calendar',
      scope: 'read_write',
      target_kinds: ['workspace'],
    },
  ],
  secrets: [
    {
      name: 'gmail_oauth',
      kind: 'oauth_token',
      label: 'google',
      scope: 'https://www.googleapis.com/auth/gmail.readonly',
      required: true,
      install_prompt: 'Connect Gmail to triage your inbox.',
    },
  ],
  compat: { coreApi: '>=1.0.0 <2.0.0' },
  build: { neutronVersion: '0.1.0' },
}

describe('validateNeutronManifest — happy paths', () => {
  test('valid minimal manifest passes (test #1)', () => {
    const result = validateNeutronManifest(minimalManifest)
    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
    expect(result.warnings).toEqual([])
  })

  test('valid full manifest passes (test #2)', () => {
    const result = validateNeutronManifest(fullManifest)
    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
    expect(result.warnings).toEqual([])
  })
})

describe('validateNeutronManifest — error paths', () => {
  test('missing required field surfaces E_REQUIRED_MISSING with correct path (test #3)', () => {
    const { compat: _omit, ...withoutCompat } = minimalManifest
    const result = validateNeutronManifest(withoutCompat)
    expect(result.valid).toBe(false)
    const compatErr = result.errors.find((e) => e.path === '/compat')
    expect(compatErr).toBeDefined()
    expect(compatErr?.code).toBe(ERROR_CODES.REQUIRED_MISSING)
  })

  test('wrong type for required field surfaces E_TYPE_MISMATCH (test #4)', () => {
    const result = validateNeutronManifest({
      ...minimalManifest,
      capabilities: 'read:gmail',
    })
    expect(result.valid).toBe(false)
    const typeErr = result.errors.find((e) => e.path === '/capabilities')
    expect(typeErr).toBeDefined()
    expect(typeErr?.code).toBe(ERROR_CODES.TYPE_MISMATCH)
  })

  test('unknown capability string surfaces E_UNKNOWN_CAPABILITY (test #5)', () => {
    const result = validateNeutronManifest({
      ...minimalManifest,
      capabilities: ['read:gmail', 'read:nonsense'],
    })
    expect(result.valid).toBe(false)
    const unknownErr = result.errors.find((e) => e.path === '/capabilities/1')
    expect(unknownErr).toBeDefined()
    expect(unknownErr?.code).toBe(ERROR_CODES.UNKNOWN_CAPABILITY)
  })

  test('malformed semver in compat.coreApi surfaces E_INVALID_SEMVER (test #6)', () => {
    const result = validateNeutronManifest({
      ...minimalManifest,
      compat: { coreApi: 'not-a-version' },
    })
    expect(result.valid).toBe(false)
    const semverErr = result.errors.find((e) => e.path === '/compat/coreApi')
    expect(semverErr).toBeDefined()
    expect(semverErr?.code).toBe(ERROR_CODES.INVALID_SEMVER)
  })

  test('invalid tier_support value surfaces E_INVALID_TIER_SUPPORT (test #7)', () => {
    const result = validateNeutronManifest({
      ...minimalManifest,
      tier_support: ['regular', 'experimental'],
    })
    expect(result.valid).toBe(false)
    const tierErr = result.errors.find((e) => e.path === '/tier_support/1')
    expect(tierErr).toBeDefined()
    expect(tierErr?.code).toBe(ERROR_CODES.INVALID_TIER_SUPPORT)
  })
})

describe('validateNeutronManifest — warnings', () => {
  test('linked_source with empty target_kinds emits W_EMPTY_TARGET_KINDS (test #8)', () => {
    const result = validateNeutronManifest({
      ...minimalManifest,
      linked_sources: [{ kind: 'gmail', scope: 'read', target_kinds: [] }],
    })
    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
    expect(result.warnings.length).toBe(1)
    expect(result.warnings[0]?.code).toBe(WARNING_CODES.EMPTY_TARGET_KINDS)
    expect(result.warnings[0]?.path).toBe('/linked_sources/0/target_kinds')
  })
})

describe('isValidSemverRange', () => {
  test('accepts common range syntaxes', () => {
    expect(isValidSemverRange('1.2.3')).toBe(true)
    expect(isValidSemverRange('^1.2.3')).toBe(true)
    expect(isValidSemverRange('~1.2.3')).toBe(true)
    expect(isValidSemverRange('>=1.0.0 <2.0.0')).toBe(true)
    expect(isValidSemverRange('^1.0.0 || ^2.0.0')).toBe(true)
    expect(isValidSemverRange('1.2.3-rc.1')).toBe(true)
    expect(isValidSemverRange('*')).toBe(true)
  })

  test('rejects malformed inputs', () => {
    expect(isValidSemverRange('')).toBe(false)
    expect(isValidSemverRange('not-a-version')).toBe(false)
    expect(isValidSemverRange(123)).toBe(false)
    expect(isValidSemverRange(null)).toBe(false)
    expect(isValidSemverRange('1..2.3')).toBe(false)
  })

  // Regression for codex review (Sprint 2B P2) — TS validator and JSON-Schema mirror disagreed
  // on these inputs. Canonical npm-style grammar is the source of truth and both must accept.
  test('accepts npm whitespace-after-comparator (>= 1.0.0)', () => {
    expect(isValidSemverRange('>= 1.0.0')).toBe(true)
    expect(isValidSemverRange('>= 1.0.0 <2.0.0')).toBe(true)
    expect(isValidSemverRange('>= 1.0.0 < 2.0.0')).toBe(true)
    expect(isValidSemverRange('= 1.2.3')).toBe(true)
  })

  // Regression for codex cross-model review (PR #4) — without the digit lookahead in the
  // whitespace-collapse step, `> =1.0.0` would normalize to `>=1.0.0` and the TS validator
  // would accept it while the JSON-Schema mirror correctly rejects.
  test('rejects split comparison operators that the schema also rejects', () => {
    expect(isValidSemverRange('> =1.0.0')).toBe(false)
    expect(isValidSemverRange('< = 2.0.0')).toBe(false)
    expect(isValidSemverRange('> = 1.0.0')).toBe(false)
  })

  // Regression for codex cross-model review (PR #4 round 3) — `*` should be valid as a clause
  // inside a `||` union, not just as the entire range.
  test('accepts wildcard `*` as a union clause', () => {
    expect(isValidSemverRange('* || ^1.0.0')).toBe(true)
    expect(isValidSemverRange('^1.0.0 || *')).toBe(true)
    expect(isValidSemverRange('* || * || ^2.0.0')).toBe(true)
  })
})

describe('manifest.schema.json — round-trip parity (bonus test #9)', () => {
  const fixtures: ReadonlyArray<{
    label: string
    input: unknown
    expectedValid: boolean
  }> = [
    { label: 'minimal', input: minimalManifest, expectedValid: true },
    { label: 'full', input: fullManifest, expectedValid: true },
    {
      label: 'missing compat',
      input: { ...minimalManifest, compat: undefined },
      expectedValid: false,
    },
    {
      label: 'capabilities-not-array',
      input: { ...minimalManifest, capabilities: 'read:gmail' },
      expectedValid: false,
    },
    {
      label: 'unknown-capability',
      input: {
        ...minimalManifest,
        capabilities: ['read:gmail', 'read:bogus'],
      },
      expectedValid: false,
    },
    {
      label: 'malformed-semver',
      input: { ...minimalManifest, compat: { coreApi: 'not-a-version' } },
      expectedValid: false,
    },
    {
      label: 'invalid-tier-support',
      input: { ...minimalManifest, tier_support: ['regular', 'experimental'] },
      expectedValid: false,
    },
    {
      label: 'tier-support-empty',
      input: { ...minimalManifest, tier_support: [] },
      expectedValid: false,
    },
    // Regression fixtures for codex review (Sprint 2B P2) — these inputs disagreed across
    // the TS validator and the JSON-Schema mirror before the canonical-npm-grammar fix.
    {
      label: 'semver-wildcard-star',
      input: { ...minimalManifest, compat: { coreApi: '*' } },
      expectedValid: true,
    },
    {
      label: 'semver-whitespace-after-comparator',
      input: { ...minimalManifest, compat: { coreApi: '>= 1.0.0 <2.0.0' } },
      expectedValid: true,
    },
    {
      label: 'semver-split-comparator',
      input: { ...minimalManifest, compat: { coreApi: '> =1.0.0' } },
      expectedValid: false,
    },
    {
      label: 'semver-wildcard-in-union',
      input: { ...minimalManifest, compat: { coreApi: '* || ^1.0.0' } },
      expectedValid: true,
    },
    {
      label: 'semver-wildcard-trailing-union',
      input: { ...minimalManifest, compat: { coreApi: '^1.0.0 || *' } },
      expectedValid: true,
    },
    {
      label: 'billing-hook-on_install-not-string',
      input: {
        ...minimalManifest,
        billing_hooks: [
          { model: 'flat_monthly', price_cents: 999, currency: 'USD', on_install: 123 },
        ],
      },
      expectedValid: false,
    },
    {
      label: 'billing-hook-on_uninstall-not-string',
      input: {
        ...minimalManifest,
        billing_hooks: [
          { model: 'flat_monthly', price_cents: 999, currency: 'USD', on_uninstall: { fn: 'x' } },
        ],
      },
      expectedValid: false,
    },
    {
      label: 'ui-component-props_schema-array',
      input: {
        ...minimalManifest,
        ui_components: [
          {
            name: 'Foo',
            entry_point: './ui/Foo.tsx',
            surface: 'launcher_icon',
            props_schema: ['array'],
          },
        ],
      },
      expectedValid: false,
    },
    {
      label: 'ui-component-props_schema-string',
      input: {
        ...minimalManifest,
        ui_components: [
          {
            name: 'Foo',
            entry_point: './ui/Foo.tsx',
            surface: 'launcher_icon',
            props_schema: 'not-an-object',
          },
        ],
      },
      expectedValid: false,
    },
  ]

  for (const fixture of fixtures) {
    test(`TS validator and JSON-Schema runner agree on ${fixture.label}`, () => {
      const tsResult = validateNeutronManifest(fixture.input)
      const schemaResult = validateAgainstSchema(
        schemaJson as Record<string, unknown>,
        fixture.input,
      )
      expect(tsResult.valid).toBe(fixture.expectedValid)
      expect(schemaResult.valid).toBe(fixture.expectedValid)
    })
  }
})

describe('billing_hooks optional entry points (codex review Sprint 2B P2)', () => {
  test('rejects on_install with non-string value', () => {
    const result = validateNeutronManifest({
      ...minimalManifest,
      billing_hooks: [
        { model: 'flat_monthly', price_cents: 999, currency: 'USD', on_install: 123 },
      ],
    })
    expect(result.valid).toBe(false)
    const e = result.errors.find((x) => x.path === '/billing_hooks/0/on_install')
    expect(e?.code).toBe(ERROR_CODES.TYPE_MISMATCH)
  })

  test('rejects on_uninstall with non-string value', () => {
    const result = validateNeutronManifest({
      ...minimalManifest,
      billing_hooks: [
        { model: 'flat_monthly', price_cents: 999, currency: 'USD', on_uninstall: { fn: 'x' } },
      ],
    })
    expect(result.valid).toBe(false)
    const e = result.errors.find((x) => x.path === '/billing_hooks/0/on_uninstall')
    expect(e?.code).toBe(ERROR_CODES.TYPE_MISMATCH)
  })

  test('accepts billing hook with both optional entry points present and string-typed', () => {
    const result = validateNeutronManifest({
      ...minimalManifest,
      billing_hooks: [
        {
          model: 'flat_monthly',
          price_cents: 999,
          currency: 'USD',
          on_install: './hooks/install.ts',
          on_uninstall: './hooks/uninstall.ts',
        },
      ],
    })
    expect(result.valid).toBe(true)
  })
})

describe('ui_components props_schema (codex review Sprint 2B P2)', () => {
  test('rejects props_schema as array', () => {
    const result = validateNeutronManifest({
      ...minimalManifest,
      ui_components: [
        {
          name: 'Foo',
          entry_point: './ui/Foo.tsx',
          surface: 'launcher_icon',
          props_schema: ['array'],
        },
      ],
    })
    expect(result.valid).toBe(false)
    const e = result.errors.find((x) => x.path === '/ui_components/0/props_schema')
    expect(e?.code).toBe(ERROR_CODES.TYPE_MISMATCH)
  })

  test('rejects props_schema as null', () => {
    const result = validateNeutronManifest({
      ...minimalManifest,
      ui_components: [
        {
          name: 'Foo',
          entry_point: './ui/Foo.tsx',
          surface: 'launcher_icon',
          props_schema: null,
        },
      ],
    })
    expect(result.valid).toBe(false)
    const e = result.errors.find((x) => x.path === '/ui_components/0/props_schema')
    expect(e?.code).toBe(ERROR_CODES.TYPE_MISMATCH)
  })

  test('accepts ui_components without props_schema (still optional)', () => {
    const result = validateNeutronManifest({
      ...minimalManifest,
      ui_components: [
        {
          name: 'Foo',
          entry_point: './ui/Foo.tsx',
          surface: 'launcher_icon',
        },
      ],
    })
    expect(result.valid).toBe(true)
  })
})

describe('capabilities — project.db / project_data canonical (OSS-split C4-a § 2.3)', () => {
  // Canonical project vocabulary (SD1) — the only accepted shared-DB / data-dir
  // capability forms. The pre-rename shared-DB / data-dir aliases were
  // dropped post-split (no back-compat).
  test('accepts read:project.db', () => {
    const result = validateNeutronManifest({
      ...minimalManifest,
      capabilities: ['read:project.db'],
    })
    expect(result.valid).toBe(true)
  })

  test('accepts write:project.db', () => {
    const result = validateNeutronManifest({
      ...minimalManifest,
      capabilities: ['write:project.db'],
    })
    expect(result.valid).toBe(true)
  })

  test('accepts fs:project_data', () => {
    const result = validateNeutronManifest({
      ...minimalManifest,
      capabilities: ['fs:project_data'],
    })
    expect(result.valid).toBe(true)
  })

  test('accepts a manifest declaring the full canonical shared-DB + data-dir set', () => {
    const result = validateNeutronManifest({
      ...minimalManifest,
      capabilities: ['read:project.db', 'write:project.db', 'fs:project_data'],
    })
    expect(result.valid).toBe(true)
  })
})

describe('ui_components route_mount surface (Sprint 24 Codex r3)', () => {
  test('accepts route_mount with mount_path', () => {
    const result = validateNeutronManifest({
      ...minimalManifest,
      ui_components: [
        {
          name: 'Admin',
          entry_point: './ui/Admin.tsx',
          surface: 'route_mount',
          mount_path: '/admin',
        },
      ],
    })
    expect(result.valid).toBe(true)
  })

  test('rejects route_mount missing mount_path', () => {
    const result = validateNeutronManifest({
      ...minimalManifest,
      ui_components: [
        {
          name: 'Admin',
          entry_point: './ui/Admin.tsx',
          surface: 'route_mount',
        },
      ],
    })
    expect(result.valid).toBe(false)
    const e = result.errors.find((x) => x.path === '/ui_components/0/mount_path')
    expect(e?.code).toBe(ERROR_CODES.TYPE_MISMATCH)
  })

  test('rejects route_mount with empty mount_path', () => {
    const result = validateNeutronManifest({
      ...minimalManifest,
      ui_components: [
        {
          name: 'Admin',
          entry_point: './ui/Admin.tsx',
          surface: 'route_mount',
          mount_path: '',
        },
      ],
    })
    expect(result.valid).toBe(false)
  })

  test('rejects relative mount_path (Codex r7 P2)', () => {
    const result = validateNeutronManifest({
      ...minimalManifest,
      ui_components: [
        {
          name: 'Admin',
          entry_point: './ui/Admin.tsx',
          surface: 'route_mount',
          mount_path: 'admin',
        },
      ],
    })
    expect(result.valid).toBe(false)
  })

  test('rejects trailing-slash mount_path', () => {
    const result = validateNeutronManifest({
      ...minimalManifest,
      ui_components: [
        {
          name: 'Admin',
          entry_point: './ui/Admin.tsx',
          surface: 'route_mount',
          mount_path: '/admin/',
        },
      ],
    })
    expect(result.valid).toBe(false)
  })
})

describe('ui_components app_tab surface (Tasks Core Tier 1 S1)', () => {
  test('accepts app_tab surface with props_schema metadata', () => {
    const result = validateNeutronManifest({
      ...minimalManifest,
      ui_components: [
        {
          name: 'TasksTab',
          entry_point: './ui/tasks-tab.ts',
          surface: 'app_tab',
          props_schema: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              label: { type: 'string' },
              emoji: { type: 'string' },
              order: { type: 'number' },
            },
          },
        },
      ],
    })
    expect(result.valid).toBe(true)
    // No surface-validation error against this entry.
    expect(
      result.errors.find((e) => e.path === '/ui_components/0/surface'),
    ).toBeUndefined()
  })

  test('accepts app_tab surface without mount_path (mount_path is route_mount-only)', () => {
    const result = validateNeutronManifest({
      ...minimalManifest,
      ui_components: [
        {
          name: 'TasksTab',
          entry_point: './ui/tasks-tab.ts',
          surface: 'app_tab',
        },
      ],
    })
    expect(result.valid).toBe(true)
  })
})
