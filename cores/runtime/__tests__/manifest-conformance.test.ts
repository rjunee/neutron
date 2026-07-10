/**
 * X3 — one manifest contract: conformance over ALL bundled Cores.
 *
 * Every bundled Core ships its manifest in the `"neutron"` block of its
 * `package.json`. This test proves each one validates under the SINGLE Zod
 * schema (`@neutronai/cores-sdk` `NeutronManifestSchema`) — the only manifest
 * contract after the 650-line hand validator was deleted. If a Core's
 * manifest drifts out of the schema, this fails at CI, not at install time.
 *
 * It ALSO pins the two-part `capability_required` contract X3 established:
 *   1. Every declared tool capability satisfies the OPEN `CapabilitySchema`
 *      (`<verb>:<resource>` shape) — the deliberately-wide validated string.
 *   2. `isKnownCapability()` partitions those into platform-known vs
 *      platform-unknown WITHOUT rejecting the unknown ones — the enabler for
 *      X1's install-time capability gate. We assert at least one bundled Core
 *      declares a well-formed capability OUTSIDE the platform-known set and
 *      that it still validates, so a regression that narrows the schema to a
 *      closed enum trips here.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'
import {
  CapabilitySchema,
  ERROR_CODES,
  KNOWN_CAPABILITIES,
  NeutronManifestSchema,
  WARNING_CODES,
  isKnownCapability,
  isValidSemverRange,
  validateNeutronManifest,
} from '@neutronai/cores-sdk'

/** Minimal green manifest, one field overridden per negative test. */
function baseManifest(): Record<string, unknown> {
  return {
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
}

const FREE_CORES_DIR = join(import.meta.dir, '..', '..', 'free')

function bundledCoreSlugs(): string[] {
  return readdirSync(FREE_CORES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
}

function readNeutronBlock(slug: string): unknown {
  const pkgPath = join(FREE_CORES_DIR, slug, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<string, unknown>
  return pkg['neutron']
}

describe('bundled Core manifest conformance (X3 — one schema)', () => {
  const slugs = bundledCoreSlugs()

  test('discovers exactly the 9 bundled Cores', () => {
    expect(slugs).toEqual([
      'agent-settings',
      'calendar',
      'code-gen',
      'email',
      'google-workspace',
      'reminders',
      'research',
      'scraping',
      'tasks',
    ])
  })

  for (const slug of slugs) {
    test(`${slug} — package.json "neutron" block validates under the single Zod schema`, () => {
      const block = readNeutronBlock(slug)
      expect(block, `${slug} package.json missing "neutron" block`).toBeDefined()
      const result = NeutronManifestSchema.safeParse(block)
      if (!result.success) {
        throw new Error(
          `${slug} manifest failed the single schema:\n${JSON.stringify(result.error.issues, null, 2)}`,
        )
      }
      expect(result.success).toBe(true)
    })

    test(`${slug} — every tool capability_required satisfies the OPEN capability shape`, () => {
      const parsed = NeutronManifestSchema.parse(readNeutronBlock(slug))
      for (const tool of parsed.tools) {
        // Openness: shape-validates, regardless of platform-known membership.
        expect(CapabilitySchema.safeParse(tool.capability_required).success).toBe(true)
      }
    })
  }

  test('openness preserved — a well-formed capability OUTSIDE the platform-known set still validates', () => {
    // Not a member of KNOWN_CAPABILITIES, but a legal <verb>:<resource> string
    // (the exact class of thing a third-party / sidecar Core declares).
    const thirdParty = 'connect:google-ads'
    expect(isKnownCapability(thirdParty)).toBe(false)
    expect(CapabilitySchema.safeParse(thirdParty).success).toBe(true)
    // And a full manifest carrying only that capability parses green.
    const manifest = {
      capabilities: [thirdParty],
      tier_support: ['regular'],
      tools: [],
      ui_components: [],
      billing_hooks: [],
      linked_sources: [],
      secrets: [],
      compat: { coreApi: '^1.0.0' },
      build: { neutronVersion: '0.1.0' },
    }
    expect(NeutronManifestSchema.safeParse(manifest).success).toBe(true)
  })

  describe('compat.coreApi semver validation preserved from the deleted hand validator', () => {
    test('valid semver ranges parse green (positive boundaries — every parser branch)', () => {
      const valid = [
        '^0.1.0',
        '^1.0.0',
        '1.2.3',
        '>=1.2.3-rc.1', // prerelease
        '>=1.0.0 <2.0.0', // space-joined intersection
        '>= 1.0.0 <2.0.0', // comparator-then-whitespace branch (npm tolerates)
        '^1.0.0 || ^2.0.0', // union
        '*', // bare wildcard
        '* || ^1.0.0', // wildcard clause leading a union
        '^1.0.0 || *', // wildcard clause trailing a union
      ]
      for (const coreApi of valid) {
        expect(isValidSemverRange(coreApi), `expected VALID: ${coreApi}`).toBe(true)
        const m = { ...baseManifest(), compat: { coreApi } }
        expect(NeutronManifestSchema.safeParse(m).success, `expected VALID: ${coreApi}`).toBe(true)
      }
    })

    test('malformed compat.coreApi is REJECTED (single schema is not looser than the deleted validator)', () => {
      const invalid = [
        'not-a-version',
        'v1',
        '1.2.3.4.5', // too many version segments
        '>>1.0.0',
        '> =1.0.0', // split comparator — stays split, per-term regex rejects
        '^1.0.0 ||', // empty union clause
        '^1.0.0 || || ^2.0.0', // empty middle clause
        '', // empty string
      ]
      for (const coreApi of invalid) {
        expect(isValidSemverRange(coreApi), `expected INVALID: ${coreApi}`).toBe(false)
        const m = { ...baseManifest(), compat: { coreApi } }
        expect(NeutronManifestSchema.safeParse(m).success, `expected INVALID: ${coreApi}`).toBe(false)
      }
    })

    test('all 9 bundled Cores declare a valid semver coreApi', () => {
      for (const slug of slugs) {
        const parsed = NeutronManifestSchema.parse(readNeutronBlock(slug))
        expect(isValidSemverRange(parsed.compat.coreApi)).toBe(true)
      }
    })
  })

  test('KNOWN_CAPABILITIES is the authoritative platform-known set — drift trips this test', () => {
    // Pin the full set so removing/adding an entry to the single source
    // (cores/sdk/manifest.ts) fails here, not silently. This is the list
    // X1's install gate consults via isKnownCapability().
    const expected: string[] = [
      'read:gmail',
      'write:gmail',
      'read:calendar',
      'write:calendar',
      'read:tasks',
      'write:tasks',
      'read:docs',
      'write:docs',
      'read:project_data',
      'write:project_data',
      'read:memory',
      'write:memory',
      'read:project.db',
      'write:project.db',
      'network:external',
      'network:github',
      'network:browse',
      'fs:project_data',
      'fs:cache',
      'host:gh',
      'agent:dispatch_subagent',
      'mcp:tool_register',
    ]
    // Exact-set equality (order-insensitive) — a drop OR an add fails here.
    const known: string[] = [...KNOWN_CAPABILITIES]
    expect(known.slice().sort()).toEqual(expected.slice().sort())
    // Each known capability is positively recognized AND satisfies the open shape.
    for (const cap of expected) {
      expect(isKnownCapability(cap)).toBe(true)
      expect(CapabilitySchema.safeParse(cap).success).toBe(true)
    }
    // Negative: well-formed-but-unknown and malformed both behave correctly.
    expect(isKnownCapability('connect:google-ads')).toBe(false) // open, not known
    expect(isKnownCapability('not a capability')).toBe(false) // malformed
    expect(isKnownCapability('read:gmail_extra')).toBe(false) // near-miss, not a member
  })

  describe('validateNeutronManifest — generated adapter over the single schema', () => {
    test('valid manifest → { valid: true, no errors }', () => {
      const r = validateNeutronManifest(baseManifest())
      expect(r.valid).toBe(true)
      expect(r.errors).toEqual([])
    })

    test('all 9 bundled Cores pass the adapter', () => {
      for (const slug of slugs) {
        expect(validateNeutronManifest(readNeutronBlock(slug)).valid).toBe(true)
      }
    })

    test('invalid manifest → { valid: false } with JSON-pointer error paths', () => {
      const r = validateNeutronManifest({ ...baseManifest(), compat: { coreApi: 'nope' } })
      expect(r.valid).toBe(false)
      expect(r.errors.length).toBeGreaterThan(0)
      expect(r.errors.some((e) => e.path.includes('compat/coreApi'))).toBe(true)
    })

    test('non-object input → invalid (does not throw)', () => {
      expect(validateNeutronManifest(null).valid).toBe(false)
      expect(validateNeutronManifest('nope').valid).toBe(false)
    })

    test('Zod issues map to the legacy ERROR_CODES taxonomy', () => {
      const codeFor = (m: Record<string, unknown>, pathSubstr: string): string | undefined => {
        const r = validateNeutronManifest(m)
        return r.errors.find((e) => e.path.includes(pathSubstr))?.code
      }
      // REQUIRED_MISSING — omit a required field.
      const { tools: _omit, ...noTools } = baseManifest()
      expect(codeFor(noTools, 'tools')).toBe(ERROR_CODES.REQUIRED_MISSING)
      // TYPE_MISMATCH — wrong type for a required field.
      expect(codeFor({ ...baseManifest(), tools: 'nope' }, 'tools')).toBe(ERROR_CODES.TYPE_MISMATCH)
      // INVALID_SEMVER — malformed compat.coreApi.
      expect(codeFor({ ...baseManifest(), compat: { coreApi: 'nope' } }, 'coreApi')).toBe(
        ERROR_CODES.INVALID_SEMVER,
      )
      // INVALID_TIER_SUPPORT — bad enum member.
      expect(codeFor({ ...baseManifest(), tier_support: ['regular', 'bogus'] }, 'tier_support')).toBe(
        ERROR_CODES.INVALID_TIER_SUPPORT,
      )
      // UNKNOWN_CAPABILITY — malformed capability string.
      expect(codeFor({ ...baseManifest(), capabilities: ['BadCap'] }, 'capabilities')).toBe(
        ERROR_CODES.UNKNOWN_CAPABILITY,
      )
      // INVALID_LINKED_SOURCE — bad linked-source scope enum.
      expect(
        codeFor(
          { ...baseManifest(), linked_sources: [{ kind: 'gmail', scope: 'bogus', target_kinds: ['user'] }] },
          'linked_sources',
        ),
      ).toBe(ERROR_CODES.INVALID_LINKED_SOURCE)
    })

    test('advisory warnings are preserved (valid manifest, warnings never flip validity)', () => {
      const m = {
        ...baseManifest(),
        linked_sources: [{ kind: 'novel_provider', scope: 'read', target_kinds: [] }],
      }
      const r = validateNeutronManifest(m)
      expect(r.valid).toBe(true) // warnings do not fail validity
      const codes = r.warnings.map((w) => w.code)
      expect(codes).toContain(WARNING_CODES.UNKNOWN_LINKED_SOURCE_KIND)
      expect(codes).toContain(WARNING_CODES.EMPTY_TARGET_KINDS)
    })
  })

  test('every bundled-declared capability is either platform-known or a well-formed open cap — never rejected', () => {
    for (const slug of slugs) {
      const parsed = NeutronManifestSchema.parse(readNeutronBlock(slug))
      const declared = new Set<string>([
        ...parsed.capabilities,
        ...parsed.tools.map((t) => t.capability_required),
      ])
      for (const cap of declared) {
        expect(CapabilitySchema.safeParse(cap).success).toBe(true)
      }
    }
  })
})
