/**
 * landing/chat-react — shared MARKDOWN renderer (2026-06-30).
 *
 * One sanitized markdown surface used by BOTH the chat (agent message bodies)
 * and the Documents viewer, so the rendering + the dark theme stay identical.
 *
 * ── CANONICAL renderer (refactor unit W2 / D-13) ─────────────────────────────
 * This react-markdown + `remark-gfm` + `rehype-sanitize` pipeline is THE
 * canonical markdown grammar for the tree (D-13 resolved: react-markdown). The
 * legacy hand-rolled web renderer (`landing/markdown.ts`) was deleted in the
 * wave-1 dead-code kill; the native Expo hand parser
 * (`app/lib/markdown-render.tsx`) is FROZEN pending the W4 shell spike. New
 * markdown features on web belong HERE, not in a second grammar. See
 * docs/plans/2026-07-02-world-class-refactor-plan.md §W2.
 *
 * ── Sanitized ───────────────────────────────────────────────────────────────
 * `rehype-sanitize` runs on the parsed HAST with the default GitHub schema, so
 * raw HTML, `javascript:`/`data:` URLs, event handlers, and `<script>`/`<style>`
 * are stripped before render — agent + document text is untrusted content. GFM
 * (`remark-gfm`) adds tables, strikethrough, task lists, and autolinks.
 *
 * ── Links open safely ───────────────────────────────────────────────────────
 * Anchors render with `target="_blank"` + `rel="noopener noreferrer"` so a
 * tapped link can't reach back into the opener.
 *
 * The element styling is plain CSS under `.car-md` (defined in chat-react.html),
 * matching the existing dark theme tokens — no inline styles, no CSS-in-JS.
 *
 * ── Document frontmatter ──────────────────────────────────────────────────────
 * Project docs (STATUS.md, README.md, …) carry a leading YAML frontmatter fence
 * (`---\nkey: value\n---`). Rendered as markdown that fence becomes a run-on bold
 * blob at the top of the doc (the first `---`/`---` pair reads as a setext
 * heading), which is noise to a human reader. The Documents viewer passes
 * `stripFrontmatter` so the fence is hidden from the rendered body; the raw view
 * still shows it verbatim. Chat message bodies never carry frontmatter, so the
 * chat surface leaves this off (default) and is unaffected.
 */

import { useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeSanitize from 'rehype-sanitize'

import { parseWebDocLinkHref, webifyDocLinkHref } from './doc-link-nav.ts'

/**
 * FIX #376 — rehype transform that rewrites a RAW agent doc-link href
 * (`docs:/<id>/<path>` marker or `neutron://docs/<id>/<path>` native scheme)
 * into the same-origin web doc-link URL (`/projects/<id>/docs?path=…`) the app
 * intercepts. It MUST run BEFORE {@link rehypeSanitize}: sanitize strips a
 * `docs:`/`neutron:` scheme href, so a chat bubble carrying either shape would
 * otherwise render a DEAD link (no `href` → a click does nothing). After the
 * rewrite the href is same-origin + root-relative, sanitize keeps it, and the
 * anchor `onClick` below (or the SPA boot handler) opens it in the Documents
 * tab. Non-doc-link hrefs (web shape, external URLs) are left untouched.
 *
 * Hand-walks the HAST (no `unist-util-visit` dep) — the chat markdown tree is
 * tiny and this keeps the browser bundle lean, matching the module's no-extra-
 * deps convention.
 */
function rehypeWebifyDocLinks() {
  interface HNode {
    type?: string
    tagName?: string
    properties?: { href?: unknown }
    children?: HNode[]
  }
  const walk = (node: HNode): void => {
    if (
      node.type === 'element' &&
      node.tagName === 'a' &&
      node.properties !== undefined &&
      typeof node.properties.href === 'string'
    ) {
      const web = webifyDocLinkHref(node.properties.href)
      if (web !== null) node.properties.href = web
    }
    if (Array.isArray(node.children)) for (const child of node.children) walk(child)
  }
  return (tree: HNode): void => {
    walk(tree)
  }
}

const REMARK_PLUGINS = [remarkGfm]
const REHYPE_PLUGINS = [rehypeWebifyDocLinks, rehypeSanitize]

/** Copy `text` to the clipboard, degrading gracefully to `false` (never a throw)
 *  when the Clipboard API is unavailable or denied. FIX #359 (Codex r1 P1):
 *  `navigator.clipboard` is `undefined` in an insecure context / older browser,
 *  and property access on it throws SYNCHRONOUSLY — a `.catch()` on the
 *  `writeText` promise never runs, so the click handler crashed instead of
 *  staying inert. Guard the property access, then catch the async rejection
 *  (permission denied) too. */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined
  if (!clip || typeof clip.writeText !== 'function') return false
  try {
    await clip.writeText(text)
    return true
  } catch {
    return false
  }
}

/** FIX #359 — Telegram-style one-tap copy button on fenced code blocks. Wraps
 *  the sanitized `<pre>` in a positioned container so a small button can sit in
 *  its corner (CSS shows it on hover/focus; always visible on touch via
 *  `(hover: none)`, since there's no hover gesture to reveal it there). Reads
 *  the rendered `<pre>`'s own text — exactly what's on screen, post-sanitize —
 *  rather than re-deriving it from the markdown AST. */
function CodeBlock(props: React.ComponentPropsWithoutRef<'pre'>): React.JSX.Element {
  const preRef = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)
  const handleCopy = (): void => {
    const text = preRef.current?.textContent ?? ''
    if (text.length === 0) return
    void copyTextToClipboard(text).then((ok) => {
      if (!ok) return // API unavailable/denied — button stays inert, no crash.
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    })
  }
  return (
    <div className="car-md-pre-wrap">
      <pre {...props} ref={preRef} />
      <button
        type="button"
        className="car-md-copy"
        aria-label={copied ? 'Copied to clipboard' : 'Copy code'}
        onClick={handleCopy}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}

/**
 * Strip a leading YAML frontmatter fence from a document body so it is not
 * rendered as a bold blob. Only a fence at the very start of the text is
 * removed: an optional BOM/leading whitespace, then `---`, the frontmatter
 * lines, and a closing `---` on its own line. Text with no leading fence is
 * returned unchanged (a bare `---` horizontal rule with no closing fence does
 * NOT match). Pure + total — never throws.
 *
 * Exported for unit testing.
 */
export function stripLeadingFrontmatter(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return text
  // ^ (optional BOM + one leading blank) --- <frontmatter> \n --- (eol|EOF).
  // A bare `---` horizontal rule (no closing fence) never matches.
  const fence = /^﻿?[ \t]*\r?\n?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/
  const m = fence.exec(text)
  if (m === null) return text
  // Drop the fence, then any blank lines immediately after it, so the rendered
  // body starts at real content instead of a leading gap.
  return text.slice(m[0].length).replace(/^(?:[ \t]*\r?\n)+/, '')
}

/** Render `text` as sanitized GitHub-flavored markdown inside a `.car-md` block.
 *  `className` lets a caller add a surface-specific modifier (e.g. the docs
 *  viewer).
 *
 *  P-A — when `onDocLink` + `origin` are supplied, a tap on an in-app doc link
 *  (the agent's `[name](docs:/<id>/<path>)` rewritten to the web doc-link URL)
 *  is intercepted: instead of opening a dead new tab, the click switches to the
 *  Documents tab and opens that doc. All other links open normally in a new
 *  tab. */
export function Markdown({
  text,
  className,
  onDocLink,
  origin,
  stripFrontmatter,
}: {
  text: string
  className?: string
  /** Called with (projectId, docsRootRelativePath) when an in-app doc link is
   *  tapped. Omit to leave all links as plain new-tab anchors. */
  onDocLink?: (projectId: string, path: string) => void
  /** Page origin — needed to recognise an absolute same-origin doc-link URL. */
  origin?: string
  /** Documents viewer only — hide a leading YAML frontmatter fence from the
   *  rendered body (see module header). Chat bodies leave this off. */
  stripFrontmatter?: boolean
}): React.JSX.Element {
  const body = stripFrontmatter === true ? stripLeadingFrontmatter(text) : text
  return (
    <div className={className !== undefined ? `car-md ${className}` : 'car-md'}>
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        components={{
          pre: ({ node: _node, ...props }) => <CodeBlock {...props} />,
          a: ({ node: _node, href, ...props }) => (
            <a
              {...props}
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => {
                if (onDocLink === undefined || typeof href !== 'string') return
                const target = parseWebDocLinkHref(href, origin ?? '')
                if (target === null) return
                // In-app doc link — open it in the Documents tab instead of a
                // new browser tab.
                e.preventDefault()
                onDocLink(target.projectId, target.path)
              }}
            />
          ),
        }}
      >
        {body}
      </ReactMarkdown>
    </div>
  )
}
