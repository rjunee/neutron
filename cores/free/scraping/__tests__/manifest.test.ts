import { describe, expect, test } from 'bun:test'

import { parseManifest } from '@neutronai/cores-sdk'

import {
  APIFY_SECRET_KIND,
  APIFY_SECRET_LABEL,
  BROWSE_CAPABILITY,
  CORE_PACKAGE_NAME,
  CORE_SLUG,
  TOOL_NAMES,
  loadManifest,
} from '../src/manifest.ts'

describe('scraping-core manifest — package.json round-trip', () => {
  test('the bundled package.json parses through @neutronai/cores-sdk parseManifest', () => {
    const m = loadManifest()
    expect(m.tier_support).toEqual(['regular', 'private'])
    expect(m.capabilities).toEqual([BROWSE_CAPABILITY])
    // Scraping Core is network-only — no sidecar DB.
    expect(m.capabilities).not.toContain('read:scraping_core.db')
    expect(m.capabilities).not.toContain('read:project.db')
  })

  test('declares scrape_instagram + scrape_x with network:browse', () => {
    const m = loadManifest()
    expect(m.tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort())
    for (const t of m.tools) {
      expect(t.capability_required).toBe(BROWSE_CAPABILITY)
      expect(t.input_schema).toBeDefined()
      expect(t.output_schema).toBeDefined()
    }
  })

  test('declares the optional apify byo_api_key admin slot', () => {
    const m = loadManifest()
    const apify = m.secrets.find((s) => s.label === APIFY_SECRET_LABEL)
    expect(apify).toBeDefined()
    expect(apify?.kind).toBe(APIFY_SECRET_KIND)
    // OPTIONAL-until-credentialed: required MUST be false so the Core
    // installs (and the capability hides) without a token.
    expect(apify?.required).toBe(false)
    expect(apify?.install_prompt.length).toBeGreaterThan(0)
  })

  test('CORE_SLUG matches the packageNameToSlug derivation of the package name', () => {
    // '@neutronai/scraping-core' → 'scraping_core'
    const derived = CORE_PACKAGE_NAME.replace(/^@[^/]+\//, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
    expect(derived).toBe(CORE_SLUG)
  })

  test('re-validates idempotently via parseManifest on the raw neutron block', () => {
    const m = loadManifest()
    // parseManifest accepts the already-parsed manifest shape unchanged.
    expect(() => parseManifest(m)).not.toThrow()
  })
})
