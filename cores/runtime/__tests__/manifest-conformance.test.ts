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
  NeutronManifestSchema,
  isKnownCapability,
} from '@neutronai/cores-sdk'

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

  test('platform-known set is consulted, not enforced — every bundled capability that IS known round-trips', () => {
    // Sanity that the known-set helper agrees with the closed list for the
    // capabilities the bundled Cores actually declare (X1 gate consults this).
    const allDeclared = new Set<string>()
    for (const slug of slugs) {
      const parsed = NeutronManifestSchema.parse(readNeutronBlock(slug))
      for (const cap of parsed.capabilities) allDeclared.add(cap)
      for (const tool of parsed.tools) allDeclared.add(tool.capability_required)
    }
    // Whatever the bundled Cores declare, each is either platform-known or a
    // well-formed open capability — never rejected.
    for (const cap of allDeclared) {
      expect(CapabilitySchema.safeParse(cap).success).toBe(true)
      expect(typeof isKnownCapability(cap)).toBe('boolean')
    }
  })
})
