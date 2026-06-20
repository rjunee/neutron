/**
 * @neutronai/landing — tight, XSS-safe markdown → HTML renderer for chat
 * bubbles (ISSUES #116).
 *
 * The landing chat bubble previously rendered agent text via
 * `element.textContent = body`, so the agent's markdown output
 * (`**bold**`, `*italic*`, `` `code` ``, `- lists`) showed its raw
 * source markers instead of formatted text — Sam hit this in a live
 * signup (literal `**` in the bubble).
 *
 * This renderer covers ONLY the shapes the onboarding agent actually
 * emits — bold, italic, inline code, and unordered/ordered lists — and
 * is deliberately NOT a general CommonMark implementation (no raw HTML,
 * no links, no images, no block quotes). The brief is explicit: a tight
 * inline renderer, not a heavy lib.
 *
 * ── Security ────────────────────────────────────────────────────────
 * The ONLY safe ordering is **escape first, then format**:
 *   1. Every `&  <  >  "  '` in the raw text is HTML-escaped up front, so
 *      any markup the agent (or, via prompt-injection, the user's pasted
 *      history) emits is rendered inert (`<script>` → `&lt;script&gt;`).
 *   2. The formatting passes then introduce a FIXED whitelist of tags
 *      (`<strong> <em> <code> <ul> <ol> <li>`) with NO attributes and NO
 *      interpolated URLs — there is no sink for an injected `href`,
 *      `onerror`, or `<script>`.
 * Because step 1 runs before any tag is introduced and the capture
 * groups only ever contain already-escaped text, the output is
 * injection-safe by construction. Callers assign the result via
 * `innerHTML`; that is the intended + audited use.
 */

/** HTML-escape the five significant characters. Runs FIRST, before any
 *  formatting tag is introduced (see module security note). */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// Private-use sentinel wrapping inline-code placeholders so the
// bold/italic passes can't reach inside a code span (e.g. `` `a*b*c` ``
// must NOT italicise `b`). Restored verbatim after all emphasis passes.
const CODE_OPEN = '\uE000'
const CODE_CLOSE = '\uE001'

/**
 * Apply inline emphasis (code → bold → italic) to a single already-
 * HTML-escaped text segment. Inline code is extracted to sentinels
 * first so emphasis markers inside a code span stay literal, then
 * restored last.
 */
function renderInline(escaped: string): string {
  const codeSpans: string[] = []
  let s = escaped.replace(/`([^`\n]+)`/g, (_m, code: string) => {
    codeSpans.push(code)
    return `${CODE_OPEN}${codeSpans.length - 1}${CODE_CLOSE}`
  })
  // Bold before italic so `**x**` becomes <strong>, not <em>*x*</em>.
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
  // `__bold__` — only at non-word boundaries so `a__b__c` (rare, but
  // possible in pasted code-ish text) doesn't get mangled.
  s = s.replace(/(^|[^\w])__([^_\n]+)__(?![\w])/g, '$1<strong>$2</strong>')
  // `*italic*` — single asterisk pair.
  s = s.replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
  // `_italic_` — bounded by non-word chars on BOTH sides so snake_case
  // identifiers (`foo_bar_baz`) are left untouched.
  s = s.replace(/(^|[^\w])_([^_\n]+)_(?![\w])/g, '$1<em>$2</em>')
  // Restore inline code, wrapping the (already-escaped) inner text.
  s = s.replace(
    new RegExp(`${CODE_OPEN}(\\d+)${CODE_CLOSE}`, 'g'),
    (_m, i: string) => `<code>${codeSpans[Number(i)] ?? ''}</code>`,
  )
  return s
}

const UL_ITEM = /^\s*[-*+]\s+(.*)$/
const OL_ITEM = /^\s*\d+\.\s+(.*)$/

/**
 * Render a tight subset of markdown to XSS-safe HTML for a chat bubble.
 *
 * Supported: `**bold**` / `__bold__`, `*italic*` / `_italic_`,
 * `` `inline code` ``, and `- ` / `* ` / `+ ` / `1. ` lists (consecutive
 * marker lines collapse into one `<ul>` / `<ol>`). Everything else is
 * literal text. Newlines OUTSIDE list blocks are preserved as `\n` and
 * rely on the bubble's `white-space: pre-wrap` to render as line breaks
 * (no `<br>` injected) — this keeps plain-text agent messages
 * byte-identical to the pre-#116 `textContent` rendering. List blocks
 * consume their own surrounding newlines (the `<ul>`/`<ol>` margin owns
 * the spacing) so pre-wrap doesn't add a blank line above/below them.
 */
export function renderMarkdown(raw: string): string {
  const lines = escapeHtml(raw).split('\n')
  const out: string[] = []
  let textRun: string[] = []
  const flushText = (): void => {
    if (textRun.length === 0) return
    out.push(textRun.map(renderInline).join('\n'))
    textRun = []
  }
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    const isUl = UL_ITEM.test(line)
    const isOl = !isUl && OL_ITEM.test(line)
    if (isUl || isOl) {
      flushText()
      const tag = isUl ? 'ul' : 'ol'
      const pattern = isUl ? UL_ITEM : OL_ITEM
      const items: string[] = []
      while (i < lines.length) {
        const m = pattern.exec(lines[i] ?? '')
        if (m === null) break
        items.push(`<li>${renderInline(m[1] ?? '')}</li>`)
        i += 1
      }
      out.push(`<${tag}>${items.join('')}</${tag}>`)
      continue
    }
    textRun.push(line)
    i += 1
  }
  flushText()
  return out.join('')
}
