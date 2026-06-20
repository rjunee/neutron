/**
 * Regression test for the chat body viewport-height CSS contract.
 *
 * Symptom (Sam, 2026-05-27, Android Chrome ~574x1280): the
 * `rainman.neutron.example/chat` composer (textarea + send button)
 * rendered BELOW the visible fold — the last agent bubble + the two
 * option buttons were visible, but the input was clipped off the
 * bottom. Free-form typing was impossible.
 *
 * Root cause: chat.html's `body` rule paired `height: 100dvh` (correct
 * — tracks the currently visible viewport on mobile) with
 * `min-height: 100vh` (wrong — `100vh` is the LARGEST possible
 * viewport, i.e. browser chrome fully collapsed). The `min-height`
 * floor forced the body taller than the visible viewport, pushing the
 * composer (the final flex child) below the fold.
 *
 * Fix: drop `min-height: 100vh`. `100dvh` alone resolves correctly on
 * every relevant browser (iOS Safari ≥15.4, Chrome ≥108, Firefox
 * ≥101 — all GA for 2+ years).
 *
 * Test strategy follows __tests__/chat-bubble-css.test.ts and
 * __tests__/chat-scroll-up.test.ts: parse the inline <style> body with
 * regex assertions. happy-dom does NOT compute layout for `dvh` /
 * `vh` viewport units, so a "mount the DOM and read computed style"
 * check would either silently pass against the buggy CSS or fail
 * against the correct CSS for the wrong reason. CSS-source assertions
 * are the durable contract.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const chatHtml = readFileSync(join(import.meta.dir, '..', 'chat.html'), 'utf8')

function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

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

describe('chat.html — body viewport-height CSS contract', () => {
  test('body declares height: 100dvh — tracks currently visible viewport', () => {
    // The single source of truth for body height on mobile. dvh
    // shrinks and grows with browser chrome, keeping the composer
    // inside the viewport at all UI states.
    const body = stripCssComments(extractRuleBody(chatHtml, '\n  body {'))
    expect(body).toMatch(/height:\s*100dvh/)
  })

  test('body does NOT declare min-height: 100vh — that pattern causes the off-screen composer regression', () => {
    // `min-height: 100vh` forces the body taller than the currently
    // visible viewport, because `100vh` is the LARGEST possible
    // viewport on mobile (chrome fully collapsed). The final flex
    // child (the composer) ends up below the fold. Caught on Android
    // Chrome 2026-05-27.
    const body = stripCssComments(extractRuleBody(chatHtml, '\n  body {'))
    expect(body).not.toMatch(/min-height:\s*100vh/)
  })

  test('body does NOT declare height: 100vh — must use dvh on mobile', () => {
    // Belt-and-braces: a future "simplification" that swaps dvh back
    // to vh re-creates a different mobile-viewport bug (vh ignores
    // browser chrome, so the body stays at max-viewport when the
    // chrome is visible, pushing the composer below the fold).
    const body = stripCssComments(extractRuleBody(chatHtml, '\n  body {'))
    expect(body).not.toMatch(/(?<!d)(?<!s)height:\s*100vh/)
  })

  test('no rule re-introduces min-height: 100vh inside the body declaration', () => {
    // Belt-and-braces scan of the entire stylesheet for any rule
    // whose selector starts with `body` and that contains
    // `min-height: 100vh`. A stray `body.something { min-height:
    // 100vh }` would re-create the regression.
    const styleStart = chatHtml.indexOf('<style>')
    const styleEnd = chatHtml.indexOf('</style>')
    expect(styleStart).toBeGreaterThan(0)
    expect(styleEnd).toBeGreaterThan(styleStart)
    const stylesheet = stripCssComments(chatHtml.slice(styleStart, styleEnd))
    expect(stylesheet).not.toMatch(/\bbody[^{}]*\{[^}]*min-height:\s*100vh/)
  })
})
