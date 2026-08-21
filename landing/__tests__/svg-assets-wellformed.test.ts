import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// REGRESSION (2026-07-19): landing/favicon.svg was NOT well-formed XML — its
// comment referenced the CSS custom property "--accent", and an XML comment may
// not contain a double-hyphen. Browsers parse SVG strictly as XML, so the asset
// served 200 with the right content-type and then rendered as NOTHING: a blank
// browser tab. Guard every shipped SVG, not just this one.
//
// logo.svg ADDED 2026-08-11. The comment above says "every shipped SVG" and the list
// held one file. landing/logo.svg is served at /logo.svg (landing/boot-impl.ts) and worn
// at 56px by landing/onboarding-telegram.html, and it is HAND-MAINTAINED as a
// byte-identical twin of favicon.svg carrying its own long docblock — i.e. the same
// asset class, the same failure mode, and MORE prose to trip the double-hyphen rule
// than the file that originally tripped it. It is also loaded behind an `onerror`
// handler, which swallows a malformed file silently instead of showing a broken image.
// If a third shipped SVG appears, it goes here too.
const SVG_ASSETS = ['landing/favicon.svg', 'landing/logo.svg'] as const

for (const rel of SVG_ASSETS) {
  test(`${rel} is well-formed XML (no '--' inside comments)`, () => {
    const src = readFileSync(join(import.meta.dir, '..', '..', rel), 'utf8')
    for (const m of src.matchAll(/<!--([\s\S]*?)-->/g)) {
      expect(m[1]).not.toContain('--')
    }
  })
}
