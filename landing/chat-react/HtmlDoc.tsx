/**
 * landing/chat-react — STATIC HTML doc renderer (2026-07-01).
 *
 * The Documents tab renders a `.md` doc via the Markdown path and a `.html` /
 * `.htm` doc via THIS component: the doc's HTML structure + its CSS are shown
 * as a styled page, but script execution is stripped. An `.html` doc is a
 * styled page, NOT a JS sandbox — interactive JS apps route to the app
 * launcher (a separate surface), never here.
 *
 * ── No JS execution (sanitize) ──────────────────────────────────────────────
 * `sanitizeHtmlDoc` parses the raw doc and removes every script-execution
 * vector while PRESERVING HTML structure + CSS:
 *   - drops `<script>` (incl. SVG `<script>`), `<iframe>`, `<object>`,
 *     `<embed>`, `<base>`, `<meta>`, `<link>`, `<frame>`/`<frameset>`,
 *     `<applet>`;
 *   - strips EVERY inline event handler (`on*` attribute) from all elements;
 *   - neutralizes `javascript:` / `vbscript:` / `data:text/html` URLs on
 *     href/src/action/xlink:href;
 *   - keeps `<style>` blocks (head + body) and inline `style` attributes so the
 *     page keeps its CSS.
 * The doc is trusted single-owner content, but we still never execute its JS in
 * the Documents renderer — that boundary is what routes interactive apps to the
 * launcher instead of the doc viewer. Defense in depth: the sanitized markup is
 * injected via `innerHTML`, which per the HTML spec never runs `<script>`.
 *
 * The sanitizer is a DOM-walk over `DOMParser.parseFromString(..., 'text/html')`
 * (faithful in the browser AND under happy-dom), so the security behavior is
 * unit-tested in CI rather than relying on a library that only runs in a real
 * browser.
 *
 * ── CSS isolation via Shadow DOM ────────────────────────────────────────────
 * A doc's `<style>` can carry broad selectors (`body{…}`, `*{…}`) that would
 * otherwise restyle the whole chat app. We inject the sanitized HTML into a
 * Shadow root so the doc's CSS is scoped to its own subtree and can't leak out
 * (and the app's CSS can't bleed in). Shadow DOM does NOT stop scripts from
 * running, so the sanitize pass above is still what guarantees "no JS".
 */

import { useEffect, useRef } from 'react'

/** True when a doc path is an HTML doc (`.html` / `.htm`, case-insensitive) and
 *  should render through {@link HtmlDoc} instead of the Markdown path. Mirrors
 *  the gateway's `HTML_EXTENSIONS` allowlist (gateway/http/doc-store.ts). */
export function isHtmlDoc(path: string): boolean {
  return /\.(html|htm)$/i.test(path)
}

/** Elements dropped wholesale — script executors, framing/plugin embeds, and
 *  document-context changers. Removing an element removes its subtree too. */
const FORBIDDEN_TAGS = new Set([
  'SCRIPT',
  'IFRAME',
  'OBJECT',
  'EMBED',
  'BASE',
  'META',
  'LINK',
  'FRAME',
  'FRAMESET',
  'APPLET',
  'NOSCRIPT',
])

/** URL-bearing attributes whose value we screen for script schemes. */
const URL_ATTRS = ['href', 'src', 'action', 'formaction', 'xlink:href', 'poster']

/**
 * True when a URL attribute value carries a script scheme. The HTML parser has
 * already decoded entities (so `&#106;avascript:` arrives as `javascript:`);
 * browsers additionally ignore leading/interior whitespace + control chars in
 * the scheme, so we strip those before matching.
 */
function isDangerousUrl(value: string): boolean {
  // Strip whitespace + C0 control chars the browser ignores inside a scheme
  // before matching (defeats `java\tscript:` tricks). \u0020 = space.
  const normalized = value.replace(/[\u0000-\u0020]+/g, '').toLowerCase()
  return (
    normalized.startsWith('javascript:') ||
    normalized.startsWith('vbscript:') ||
    normalized.startsWith('data:text/html')
  )
}

/** Strip script vectors from a single element in place: drop `on*` handlers and
 *  neutralize dangerous URL attributes. */
function sanitizeElement(el: Element): void {
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name.toLowerCase()
    if (name.startsWith('on')) {
      el.removeAttribute(attr.name)
      continue
    }
    if (URL_ATTRS.includes(name) && isDangerousUrl(attr.value)) {
      el.removeAttribute(attr.name)
    }
  }
}

/**
 * Parse a raw HTML doc and strip every script-execution vector IN PLACE,
 * returning the sanitized `Document` (or `null` for empty/unparseable input).
 * Keeps the full `<html>`/`<head>`/`<body>` structure so document-level CSS
 * (`html{…}`, `body{…}`) and body attributes are preserved. Shared by
 * {@link sanitizeHtmlDoc} (string form, for tests) and {@link HtmlDoc} (live
 * node adoption, for render).
 */
function parseAndSanitize(raw: string): Document | null {
  if (typeof raw !== 'string' || raw.length === 0) return null
  let doc: Document
  try {
    doc = new DOMParser().parseFromString(raw, 'text/html')
  } catch {
    // Parsing should never throw for a string, but never surface raw markup if
    // it somehow does — an empty render is safe.
    return null
  }
  // Remove forbidden elements everywhere (head + body, any nesting/namespace).
  for (const el of Array.from(doc.querySelectorAll('*'))) {
    if (FORBIDDEN_TAGS.has(el.tagName.toUpperCase())) {
      el.remove()
    }
  }
  // Strip handlers + dangerous URLs from every surviving element.
  for (const el of Array.from(doc.querySelectorAll('*'))) {
    sanitizeElement(el)
  }
  return doc
}

/**
 * Sanitize a raw HTML doc string for STATIC render: strip all script execution
 * while keeping HTML structure + CSS. Pure + total — returns the sanitized
 * FULL-document HTML (`<html>…</html>`, so head `<style>` blocks + `<body>`
 * attributes/selectors survive) or `''` for empty/unparseable input. Exported
 * for unit testing without mounting the component.
 */
export function sanitizeHtmlDoc(raw: string): string {
  const doc = parseAndSanitize(raw)
  return doc?.documentElement?.outerHTML ?? ''
}

/**
 * Render a `.html` / `.htm` doc as a static styled page inside a Shadow-DOM
 * island. `html` is the raw file content; it is sanitized (no JS) and injected
 * into a shadow root so its CSS is scoped to this subtree.
 */
export function HtmlDoc({
  html,
  className,
}: {
  html: string
  className?: string
}): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const shadowRef = useRef<ShadowRoot | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (host === null) return
    // Attach the shadow root once, then re-write its contents as the doc
    // changes. `attachShadow` throws if called twice on the same host.
    if (shadowRef.current === null) {
      try {
        shadowRef.current = host.attachShadow({ mode: 'open' })
      } catch {
        // Host already has a shadow root (StrictMode double-invoke) — reuse it.
        shadowRef.current = host.shadowRoot
      }
    }
    const root: ShadowRoot | HTMLElement = shadowRef.current ?? host
    // Clear any prior render.
    root.textContent = ''
    // Adopt the sanitized document's LIVE nodes (not an innerHTML string): the
    // HTML fragment parser strips `<html>`/`<body>` tags, which would drop
    // `body{…}` / `html{…}` selectors + body attributes. Importing the real
    // `<documentElement>` keeps them, so document-level CSS renders correctly.
    // `importNode`/`appendChild` never execute the (already-removed) scripts.
    const doc = parseAndSanitize(html)
    if (doc?.documentElement != null) {
      root.appendChild(document.importNode(doc.documentElement, true))
    }
  }, [html])

  return (
    <div
      ref={hostRef}
      className={className !== undefined ? `cdoc-html ${className}` : 'cdoc-html'}
      // Content lives in the shadow root; the light DOM is just the named host.
      aria-label="Rendered HTML document"
    />
  )
}
