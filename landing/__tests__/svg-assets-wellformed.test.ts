import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// REGRESSION (2026-07-19): landing/favicon.svg was NOT well-formed XML — its
// comment referenced the CSS custom property "--accent", and an XML comment may
// not contain a double-hyphen. Browsers parse SVG strictly as XML, so the asset
// served 200 with the right content-type and then rendered as NOTHING: a blank
// browser tab. Guard every shipped SVG, not just this one.
const SVG_ASSETS = ['landing/favicon.svg'] as const

for (const rel of SVG_ASSETS) {
  test(`${rel} is well-formed XML (no '--' inside comments)`, () => {
    const src = readFileSync(join(import.meta.dir, '..', '..', rel), 'utf8')
    for (const m of src.matchAll(/<!--([\s\S]*?)-->/g)) {
      expect(m[1]).not.toContain('--')
    }
  })
}
