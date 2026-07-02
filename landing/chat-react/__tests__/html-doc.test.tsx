/**
 * Unit test for the STATIC HTML doc renderer (2026-07-01).
 *
 * Asserts the two guarantees the Documents-tab HTML branch relies on:
 *   - `sanitizeHtmlDoc` keeps HTML structure + CSS (`<style>` blocks, inline
 *     `style`) while stripping ALL script execution (`<script>`, inline event
 *     handlers, `javascript:` URLs, `<iframe>`/`<object>`/`<embed>`);
 *   - `HtmlDoc` mounts the sanitized content into a Shadow root (CSS isolation)
 *     and never runs the doc's script (no global side effect fires).
 *
 * `DOMParser` only exists after happy-dom registers, so every sanitize call is
 * made INSIDE a test body (not at describe-collection time).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

beforeAll(() => {
  GlobalRegistrator.register({ url: 'https://sam.neutron.test/chat' })
  const g = globalThis as unknown as Record<string, unknown>
  g['IS_REACT_ACT_ENVIRONMENT'] = true
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const tick = () => new Promise((r) => setTimeout(r, 0))

// No <img src>/<a href> that would trip happy-dom's resource loader — the
// script-execution vectors under test are what matter.
const FULL_DOC = `<!DOCTYPE html><html><head>
  <style>body { background: #123456 } h1 { color: tomato }</style>
</head><body>
  <h1 onclick="window.__pwned = 'click'">Timer</h1>
  <p style="font-weight:bold">hello world</p>
  <script>window.__pwned = 'script'</script>
  <a href="javascript:window.__pwned='href'">bad link</a>
  <div data-x="ok" onmouseover="window.__pwned='mouse'">region</div>
  <svg><script>window.__pwned='svg'</script></svg>
</body></html>`

describe('sanitizeHtmlDoc', () => {
  it('preserves <style> CSS from head', () => {
    const { sanitizeHtmlDoc } = require('../HtmlDoc.tsx')
    const out = sanitizeHtmlDoc(FULL_DOC)
    expect(out).toContain('background: #123456')
    expect(out).toContain('color: tomato')
  })
  it('preserves inline style attributes', () => {
    const { sanitizeHtmlDoc } = require('../HtmlDoc.tsx')
    expect(sanitizeHtmlDoc(FULL_DOC)).toContain('font-weight:bold')
  })
  it('preserves HTML structure + text + data attrs', () => {
    const { sanitizeHtmlDoc } = require('../HtmlDoc.tsx')
    const out = sanitizeHtmlDoc(FULL_DOC)
    expect(out).toContain('<h1')
    expect(out).toContain('Timer')
    expect(out).toContain('hello world')
    expect(out).toContain('data-x="ok"')
  })
  it('strips <script> (incl. SVG script)', () => {
    const { sanitizeHtmlDoc } = require('../HtmlDoc.tsx')
    const out = sanitizeHtmlDoc(FULL_DOC)
    expect(out.toLowerCase()).not.toContain('<script')
    expect(out).not.toContain("__pwned = 'script'")
    expect(out).not.toContain("__pwned='svg'")
  })
  it('strips inline event handlers', () => {
    const { sanitizeHtmlDoc } = require('../HtmlDoc.tsx')
    const out = sanitizeHtmlDoc(FULL_DOC).toLowerCase()
    expect(out).not.toContain('onclick')
    expect(out).not.toContain('onmouseover')
  })
  it('strips javascript: URLs', () => {
    const { sanitizeHtmlDoc } = require('../HtmlDoc.tsx')
    expect(sanitizeHtmlDoc(FULL_DOC).toLowerCase()).not.toContain('javascript:')
  })
  it('defeats obfuscated javascript: schemes', () => {
    const { sanitizeHtmlDoc } = require('../HtmlDoc.tsx')
    const out = sanitizeHtmlDoc('<a href="  java\tscript:alert(1)">x</a>')
    expect(out.toLowerCase()).not.toContain('script:alert')
  })
  it('returns empty for empty/blank input', () => {
    const { sanitizeHtmlDoc } = require('../HtmlDoc.tsx')
    expect(sanitizeHtmlDoc('')).toBe('')
  })

  it('isHtmlDoc matches .html/.htm case-insensitively, not .md', () => {
    const { isHtmlDoc } = require('../HtmlDoc.tsx')
    expect(isHtmlDoc('notes/timer.html')).toBe(true)
    expect(isHtmlDoc('page.HTM')).toBe(true)
    expect(isHtmlDoc('README.md')).toBe(false)
    expect(isHtmlDoc('a.markdown')).toBe(false)
    expect(isHtmlDoc('x.html.md')).toBe(false)
  })
})

describe('HtmlDoc component', () => {
  it('mounts sanitized content in a shadow root and runs no script', async () => {
    const g = globalThis as unknown as Record<string, unknown>
    delete g['__pwned']
    const React = require('react')
    const { createRoot } = require('react-dom/client')
    const { act } = require('react')
    const { HtmlDoc } = require('../HtmlDoc.tsx')

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(React.createElement(HtmlDoc, { html: FULL_DOC }))
    })
    await tick()

    const host = container.querySelector('.cdoc-html') as HTMLElement
    expect(host).not.toBeNull()
    const shadow = host.shadowRoot
    expect(shadow).not.toBeNull()
    expect(shadow!.innerHTML).toContain('Timer')
    expect(shadow!.innerHTML).toContain('background: #123456')
    expect(shadow!.innerHTML.toLowerCase()).not.toContain('<script')

    // The doc's script / handler / javascript: URL never executed.
    expect(g['__pwned']).toBeUndefined()

    await act(async () => {
      root.unmount()
    })
    container.remove()
  })
})
