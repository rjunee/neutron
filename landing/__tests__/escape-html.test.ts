/**
 * `escapeHtml` — split out of the deleted `landing/markdown.ts` renderer
 * during the wave-1 dead-code kill (refactor plan §K1). Still live via
 * `landing/mobile-install-config.ts`.
 */
import { describe, expect, test } from 'bun:test'
import { escapeHtml } from '../escape-html.ts'

describe('escapeHtml', () => {
  test('escapes the five significant characters', () => {
    expect(escapeHtml('a & b < c > d "e" \'f\'')).toBe(
      'a &amp; b &lt; c &gt; d &quot;e&quot; &#39;f&#39;',
    )
  })
})
