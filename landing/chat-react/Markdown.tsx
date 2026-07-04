/**
 * landing/chat-react — shared MARKDOWN renderer (2026-06-30).
 *
 * One sanitized markdown surface used by BOTH the chat (agent message bodies)
 * and the Documents viewer, so the rendering + the dark theme stay identical.
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

import { parseWebDocLinkHref } from './doc-link-nav.ts'

const REMARK_PLUGINS = [remarkGfm]
const REHYPE_PLUGINS = [rehypeSanitize]

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
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1500)
      })
      .catch(() => {
        // Clipboard API unavailable/denied (e.g. insecure context, permission
        // denied) — leave the button inert rather than crash the render.
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
