/**
 * Regression test for the chat-bubble word-wrap CSS contract.
 *
 * Failure mode pinned: 2026-05-12 screenshots showed user replies
 * rendered into a ~6-character column with mid-word breaks
 * (`Conti / nue`). Root cause was the grid-placement regression PR #56
 * fixed; this test pins the four CSS rules that together guarantee the
 * regression cannot return:
 *
 *   1. `overflow-wrap: break-word`  — break at word boundaries, not chars
 *   2. `word-break: normal`         — never break-all
 *   3. `max-width: min(60ch, 80%)`  — cap wide-viewport bubble width
 *   4. `min-width: 4ch`             — single-char replies don't stutter
 *
 * The test parses chat.html's inline <style> body with a regex rather
 * than mounting in happy-dom because the regression is about CSS
 * declarations, not computed layout. happy-dom's CSS engine has known
 * gaps around `min(...)` resolution and CSS variables; parsing the
 * source is the cheapest assertion that survives across happy-dom
 * upgrades.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const chatHtml = readFileSync(join(import.meta.dir, '..', 'chat.html'), 'utf8')

/**
 * Strip `/* ... *\/` comments from CSS source so a literal mention of
 * `overflow-wrap: anywhere` inside a "previously this was wrong"
 * comment doesn't fail the `not.toMatch` assertions.
 */
function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

/**
 * Extract the body of a CSS rule by selector. Returns the content
 * between the first `{` after the selector and its matching `}`. Tolerates
 * nested braces (none in this file today, but cheap insurance).
 */
function extractRuleBody(css: string, selector: string): string {
  const idx = css.indexOf(selector)
  if (idx < 0) throw new Error(`selector ${selector} not found in chat.html <style>`)
  const open = css.indexOf('{', idx)
  if (open < 0) throw new Error(`no opening brace after ${selector}`)
  let depth = 1
  let i = open + 1
  while (i < css.length && depth > 0) {
    const ch = css[i]
    if (ch === '{') depth++
    else if (ch === '}') depth--
    if (depth === 0) break
    i++
  }
  return css.slice(open + 1, i)
}

describe('chat.html — bubble word-wrap CSS contract', () => {
  test('--max-bubble-width is min(60ch, 80%) — caps desktop width AND keeps mobile 80%', () => {
    // The single source of truth lives on :root so user + agent bubbles
    // inherit the same cap. The test asserts the *declaration*, not the
    // computed style — a future refactor that switches to a media-query
    // ladder MUST update this assertion deliberately.
    expect(chatHtml).toMatch(/--max-bubble-width:\s*min\(60ch,\s*80%\)/)
  })

  test('--min-bubble-width is 4ch — single-char replies stay legible', () => {
    expect(chatHtml).toMatch(/--min-bubble-width:\s*4ch/)
  })

  test('.bubble declares overflow-wrap: break-word + word-break: normal', () => {
    const body = stripCssComments(extractRuleBody(chatHtml, '\n  .bubble {'))
    // Whole-word wrapping. NOT `anywhere` (mid-word) and NOT `break-all`
    // (mid-char). Both were prior regression sources.
    expect(body).toMatch(/overflow-wrap:\s*break-word/)
    expect(body).toMatch(/word-break:\s*normal/)
    expect(body).not.toMatch(/word-break:\s*break-all/)
    expect(body).not.toMatch(/overflow-wrap:\s*anywhere/)
  })

  test('.bubble applies both max-width AND min-width via the CSS vars', () => {
    const body = extractRuleBody(chatHtml, '\n  .bubble {')
    expect(body).toMatch(/max-width:\s*var\(--max-bubble-width\)/)
    expect(body).toMatch(/min-width:\s*var\(--min-bubble-width\)/)
  })

  test('user-run grid keeps a single 1fr column (no implicit auto squeeze)', () => {
    // The 2026-05-09 mid-word-wrap regression was specifically a
    // `.run.run-user` grid-template-columns bug — inherited 2-column
    // template squeezed the user bubble into a `auto` implicit column
    // that 1fr starved to ~24px. The fix lives at chat.html:117.
    const body = extractRuleBody(chatHtml, '\n  .run.run-user {')
    expect(body).toMatch(/grid-template-columns:\s*1fr/)
  })

  test('no rule re-introduces word-break: break-all on .bubble descendants', () => {
    // Belt-and-braces: a stray `word-break: break-all` inside any
    // user-bubble selector would re-create the failure. Scan the full
    // stylesheet for any rule that pairs `break-all` with a bubble
    // selector — the only legitimate `break-all` in the file is on the
    // install-token-page sister surface, which this test does not load.
    const styleStart = chatHtml.indexOf('<style>')
    const styleEnd = chatHtml.indexOf('</style>')
    expect(styleStart).toBeGreaterThan(0)
    expect(styleEnd).toBeGreaterThan(styleStart)
    const stylesheet = stripCssComments(chatHtml.slice(styleStart, styleEnd))
    expect(stylesheet).not.toMatch(/\.bubble[^{}]*\{[^}]*word-break:\s*break-all/)
    expect(stylesheet).not.toMatch(/\.run-user[^{}]*\{[^}]*word-break:\s*break-all/)
    expect(stylesheet).not.toMatch(/\.run-agent[^{}]*\{[^}]*word-break:\s*break-all/)
  })
})
