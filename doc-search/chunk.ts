/**
 * @neutronai/doc-search — markdown chunker.
 *
 * Splits a markdown document into heading-scoped chunks for the doc
 * search index. A chunk is the unit of retrieval: when the agent
 * searches docs, we want a hit to point at the relevant SECTION (a
 * heading + its prose), not the whole file, so the snippet and the
 * `heading` field are useful for "research before asking".
 *
 * Chunking rules (deterministic — no I/O, no randomness):
 *
 *   1. The TITLE is the first level-1 ATX heading (`# Foo`). When the
 *      doc has no `# ` heading the title falls back to the supplied
 *      filename (de-slugged) or `Untitled`.
 *   2. A new chunk starts at every ATX heading line (`#`..`######`).
 *      The chunk's `heading` is that heading's text; the body includes
 *      the heading line itself plus everything until the next heading.
 *   3. Content before the first heading becomes a preamble chunk with
 *      `heading: ''`.
 *   4. A long section is split into multiple sub-chunks at a character
 *      budget (`maxChars`), preferring blank-line (paragraph)
 *      boundaries so we never split mid-sentence when avoidable. Every
 *      sub-chunk of a section keeps the section's heading.
 *   5. Heading-looking lines inside fenced code blocks (``` / ~~~) are
 *      NOT treated as headings — a shell comment `# do the thing` in a
 *      code fence must not start a new section.
 *
 * Empty / whitespace-only chunks are dropped so the FTS index never
 * carries blank rows.
 */

/** One retrieval unit within a document. */
export interface DocChunk {
  /** 0-based order of the chunk within its document. */
  ordinal: number
  /** Nearest heading text, or '' for the pre-first-heading preamble. */
  heading: string
  /** The chunk body (heading line + prose), trimmed. */
  body: string
}

export interface ChunkedDoc {
  /** First `# ` heading, else de-slugged filename, else 'Untitled'. */
  title: string
  chunks: DocChunk[]
}

export interface ChunkOptions {
  /** Source filename — used to derive the title when no `# ` heading exists. */
  filename?: string
  /**
   * Soft cap on chunk body length. A section longer than this is split
   * into sub-chunks at paragraph boundaries. Default 1200.
   */
  maxChars?: number
}

const DEFAULT_MAX_CHARS = 1200

const ATX_HEADING_RE = /^(#{1,6})\s+(.*)$/
const FENCE_RE = /^(\s{0,3})(`{3,}|~{3,})/

/** A raw section captured during the first pass (heading + its lines). */
interface RawSection {
  heading: string
  lines: string[]
}

/**
 * Chunk a markdown document. Pure + deterministic: same input always
 * yields the same chunk list.
 */
export function chunkMarkdown(content: string, options: ChunkOptions = {}): ChunkedDoc {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS
  const lines = content.split('\n')

  const sections: RawSection[] = []
  let current: RawSection = { heading: '', lines: [] }
  let firstH1: string | null = null

  // Fenced-code state: track the opening fence marker so heading-like
  // lines inside the fence are treated as plain content.
  let fence: string | null = null

  for (const line of lines) {
    const fenceMatch = FENCE_RE.exec(line)
    if (fenceMatch !== null) {
      const marker = fenceMatch[2]!
      if (fence === null) {
        fence = marker[0]! // remember fence char (` or ~)
      } else if (marker[0] === fence) {
        fence = null
      }
      current.lines.push(line)
      continue
    }

    if (fence === null) {
      const headingMatch = ATX_HEADING_RE.exec(line)
      if (headingMatch !== null) {
        const hashes = headingMatch[1]!
        const text = headingMatch[2]!.trim().replace(/\s+#+\s*$/, '') // strip closing ###
        if (firstH1 === null && hashes.length === 1 && text.length > 0) {
          firstH1 = text
        }
        // Flush the current section if it carries any content.
        if (current.heading.length > 0 || current.lines.join('').trim().length > 0) {
          sections.push(current)
        }
        current = { heading: text, lines: [line] }
        continue
      }
    }

    current.lines.push(line)
  }
  if (current.heading.length > 0 || current.lines.join('').trim().length > 0) {
    sections.push(current)
  }

  const title = firstH1 ?? deriveTitleFromFilename(options.filename)

  const chunks: DocChunk[] = []
  let ordinal = 0
  for (const section of sections) {
    const body = section.lines.join('\n').trim()
    if (body.length === 0) continue
    for (const piece of splitBody(body, maxChars)) {
      const trimmed = piece.trim()
      if (trimmed.length === 0) continue
      chunks.push({ ordinal, heading: section.heading, body: trimmed })
      ordinal += 1
    }
  }

  return { title, chunks }
}

/**
 * Split a section body into sub-chunks of at most ~maxChars, preferring
 * blank-line (paragraph) boundaries. A single paragraph longer than
 * maxChars is emitted whole rather than cut mid-sentence — the FTS
 * tokenizer handles long bodies fine; the budget is about keeping
 * snippets focused, not a hard limit.
 */
function splitBody(body: string, maxChars: number): string[] {
  if (body.length <= maxChars) return [body]
  const paragraphs = body.split(/\n{2,}/)
  const out: string[] = []
  let buf = ''
  for (const para of paragraphs) {
    if (buf.length === 0) {
      buf = para
    } else if (buf.length + para.length + 2 <= maxChars) {
      buf = `${buf}\n\n${para}`
    } else {
      out.push(buf)
      buf = para
    }
  }
  if (buf.length > 0) out.push(buf)
  return out
}

/**
 * Turn a filename into a human-ish title: drop the directory, drop the
 * `.md`/`.markdown` extension, turn separators into spaces, and
 * capitalise. `STATUS.md` → `STATUS`; `kickoff-notes.md` → `Kickoff
 * notes`.
 */
export function deriveTitleFromFilename(filename?: string): string {
  if (filename === undefined || filename.length === 0) return 'Untitled'
  const base = filename.split('/').pop() ?? filename
  const stem = base.replace(/\.(md|markdown)$/i, '')
  if (stem.length === 0) return 'Untitled'
  // Keep ALL-CAPS stems (README, STATUS, CLAUDE) verbatim.
  if (/^[A-Z0-9]+$/.test(stem)) return stem
  const words = stem.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (words.length === 0) return 'Untitled'
  return words.charAt(0).toUpperCase() + words.slice(1)
}
