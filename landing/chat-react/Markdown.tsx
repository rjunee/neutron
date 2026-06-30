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

const REMARK_PLUGINS = [remarkGfm]
const REHYPE_PLUGINS = [rehypeSanitize]

/** Render `text` as sanitized GitHub-flavored markdown inside a `.car-md` block.
 *  `className` lets a caller add a surface-specific modifier (e.g. the docs
 *  viewer). */
export function Markdown({
  text,
  className,
}: {
  text: string
  className?: string
}): React.JSX.Element {
  return (
    <div className={className !== undefined ? `car-md ${className}` : 'car-md'}>
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        components={{
          a: ({ node: _node, ...props }) => (
            <a {...props} target="_blank" rel="noopener noreferrer" />
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
