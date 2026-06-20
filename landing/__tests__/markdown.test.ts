/**
 * ISSUES #116 — XSS-safe inline-markdown renderer for chat bubbles.
 *
 * Pins: escape-before-format ordering (the security invariant), the
 * supported shapes (bold/italic/code/lists), and the "plain text round-
 * trips unchanged" property that keeps the pre-#116 `textContent`
 * rendering byte-identical for messages with no markdown.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { escapeHtml, renderMarkdown } from '../markdown.ts'

beforeAll(() => {
  GlobalRegistrator.register({ url: 'https://t-test.neutron.test/chat' })
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

describe('escapeHtml', () => {
  test('escapes the five significant characters', () => {
    expect(escapeHtml('a & b < c > d "e" \'f\'')).toBe(
      'a &amp; b &lt; c &gt; d &quot;e&quot; &#39;f&#39;',
    )
  })
})

describe('renderMarkdown — security', () => {
  test('escapes raw HTML before any formatting (no injection sink)', () => {
    const out = renderMarkdown('<script>alert(1)</script>')
    expect(out).not.toContain('<script>')
    expect(out).toContain('&lt;script&gt;')
  })

  test('an injected tag inside bold stays inert', () => {
    const out = renderMarkdown('**<img src=x onerror=alert(1)>**')
    expect(out).toContain('<strong>')
    expect(out).not.toContain('<img')
    expect(out).toContain('&lt;img')
  })

  test('only ever emits whitelisted tags', () => {
    const out = renderMarkdown('**b** *i* `c`\n- one\n1. two')
    const tags = (out.match(/<\/?([a-z]+)/g) ?? []).map((t) => t.replace(/<\/?/, ''))
    for (const t of tags) {
      expect(['strong', 'em', 'code', 'ul', 'ol', 'li']).toContain(t)
    }
  })
})

describe('renderMarkdown — inline', () => {
  test('bold via **', () => {
    expect(renderMarkdown('say **hello** now')).toBe('say <strong>hello</strong> now')
  })

  test('the literal Sam-signup defect: ** renders as bold not raw', () => {
    const out = renderMarkdown("Here's your **agent name** — keep it?")
    expect(out).toContain('<strong>agent name</strong>')
    expect(out).not.toContain('**')
  })

  test('italic via single *', () => {
    expect(renderMarkdown('this is *important*')).toBe('this is <em>important</em>')
  })

  test('bold via __ and italic via _', () => {
    expect(renderMarkdown('__bold__ and _it_')).toBe('<strong>bold</strong> and <em>it</em>')
  })

  test('inline code', () => {
    expect(renderMarkdown('run `bun test` please')).toBe(
      'run <code>bun test</code> please',
    )
  })

  test('emphasis markers inside code stay literal', () => {
    expect(renderMarkdown('`a*b*c`')).toBe('<code>a*b*c</code>')
  })

  test('snake_case identifiers are NOT italicised', () => {
    expect(renderMarkdown('the foo_bar_baz value')).toBe('the foo_bar_baz value')
  })

  test('bold wins over italic for ** pairs', () => {
    expect(renderMarkdown('**x**')).toBe('<strong>x</strong>')
  })
})

describe('renderMarkdown — lists', () => {
  test('unordered list collapses consecutive - lines', () => {
    expect(renderMarkdown('- one\n- two\n- three')).toBe(
      '<ul><li>one</li><li>two</li><li>three</li></ul>',
    )
  })

  test('ordered list', () => {
    expect(renderMarkdown('1. first\n2. second')).toBe(
      '<ol><li>first</li><li>second</li></ol>',
    )
  })

  test('list items render inline emphasis', () => {
    expect(renderMarkdown('- **a**\n- `b`')).toBe(
      '<ul><li><strong>a</strong></li><li><code>b</code></li></ul>',
    )
  })

  test('intro text + list + trailing text — no stray blank lines around the block', () => {
    expect(renderMarkdown('Options:\n- a\n- b\nPick one')).toBe(
      'Options:<ul><li>a</li><li>b</li></ul>Pick one',
    )
  })

  test('* and + list markers (not confused with italic)', () => {
    expect(renderMarkdown('* star\n+ plus')).toBe('<ul><li>star</li><li>plus</li></ul>')
  })
})

describe('renderMarkdown — plain-text round-trip (pre-#116 parity)', () => {
  test('plain text with no markdown is unchanged', () => {
    expect(renderMarkdown('Hello there')).toBe('Hello there')
  })

  test('newlines outside lists are preserved verbatim (pre-wrap renders them)', () => {
    expect(renderMarkdown('line one\nline two')).toBe('line one\nline two')
  })

  test('setting innerHTML then reading textContent recovers the plain text', () => {
    const div = document.createElement('div')
    div.innerHTML = renderMarkdown('a < b & c > d')
    expect(div.textContent).toBe('a < b & c > d')
  })
})
