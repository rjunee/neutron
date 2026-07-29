/**
 * @neutronai/tasks/projection — STATUS.md marker-block detection + replace.
 *
 * Per the P6 brief § 4.10, the projection layer rewrites ONLY a marked
 * block inside the project's STATUS.md so Sam's narrative content
 * outside the block is never touched. Markers:
 *
 *     <!-- tasks-projection:start - DO NOT EDIT BELOW - regenerated from project.db -->
 *     <body>
 *     <!-- tasks-projection:end - DO NOT EDIT ABOVE -->
 *
 * If neither marker exists, the projection appends a fresh block at
 * end-of-file (after any existing content + a blank line). Pure
 * functions — no I/O.
 *
 * Back-compat (OSS-split C4-a1, execution brief § 3.3): blocks written
 * before the vocabulary rename carry "regenerated from project.db" in
 * the start marker. START_RE matches on the `tasks-projection:start`
 * stem with any suffix, so old blocks are still detected and replaced
 * — the next projection write upgrades them to the new marker text.
 */

export const PROJECTION_BLOCK_START =
  '<!-- tasks-projection:start - DO NOT EDIT BELOW - regenerated from project.db -->'

export const PROJECTION_BLOCK_END =
  '<!-- tasks-projection:end - DO NOT EDIT ABOVE -->'

const START_RE = /<!--\s*tasks-projection:start\b[^>]*-->/
const END_RE = /<!--\s*tasks-projection:end\b[^>]*-->/

export interface MarkedBlockRange {
  /** Byte offset of the start marker (inclusive). */
  start: number
  /** Byte offset just past the end marker (exclusive). */
  end: number
}

/**
 * Return the (start, end) byte range of the existing marked block, or
 * null when no well-formed block exists. The range INCLUDES the
 * markers themselves so a slice-replace overwrites them in one shot.
 *
 * Returns null when:
 *   - Neither marker is found.
 *   - Only one marker is found (malformed half-edit).
 *   - The end marker comes BEFORE the start marker (very malformed).
 */
export function findMarkedBlock(content: string): MarkedBlockRange | null {
  const startMatch = START_RE.exec(content)
  if (startMatch === null) return null
  const endMatch = END_RE.exec(content)
  if (endMatch === null) return null
  const startIdx = startMatch.index
  const endIdx = endMatch.index + endMatch[0].length
  if (endIdx <= startIdx) return null
  return { start: startIdx, end: endIdx }
}

/**
 * Replace the marked block inside `existing` with `new_body` wrapped
 * in fresh start/end markers. When no block is found, APPEND a new
 * block at end-of-file (separated by a blank line from any existing
 * content).
 *
 * `new_body` is the raw inner body without markers; this function
 * adds the standard markers + a leading/trailing blank line so the
 * block reads naturally inside the surrounding markdown.
 */
export function replaceMarkedBlock(existing: string, new_body: string): string {
  const block = composeBlock(new_body)
  const range = findMarkedBlock(existing)
  if (range !== null) {
    return existing.slice(0, range.start) + block + existing.slice(range.end)
  }
  // Append. Make sure the existing content ends with a newline + a
  // blank line so the new block visually separates from preceding
  // narrative (or frontmatter).
  const trimmed = existing.replace(/\s+$/u, '')
  const separator = trimmed.length === 0 ? '' : '\n\n'
  return `${trimmed}${separator}${block}\n`
}

function composeBlock(body: string): string {
  const cleaned = body.replace(/^\n+/, '').replace(/\n+$/, '')
  return `${PROJECTION_BLOCK_START}\n\n${cleaned}\n\n${PROJECTION_BLOCK_END}`
}
