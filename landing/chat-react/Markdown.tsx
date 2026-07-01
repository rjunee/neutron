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
 */

import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeSanitize from 'rehype-sanitize'

import { parseWebDocLinkHref } from './doc-link-nav.ts'

const REMARK_PLUGINS = [remarkGfm]
const REHYPE_PLUGINS = [rehypeSanitize]

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
}: {
  text: string
  className?: string
  /** Called with (projectId, docsRootRelativePath) when an in-app doc link is
   *  tapped. Omit to leave all links as plain new-tab anchors. */
  onDocLink?: (projectId: string, path: string) => void
  /** Page origin — needed to recognise an absolute same-origin doc-link URL. */
  origin?: string
}): React.JSX.Element {
  return (
    <div className={className !== undefined ? `car-md ${className}` : 'car-md'}>
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        components={{
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
        {text}
      </ReactMarkdown>
    </div>
  )
}
