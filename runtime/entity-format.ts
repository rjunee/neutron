/**
 * @neutronai/runtime — entity-format: the SINGLE entity-page codec (leaf).
 *
 * Refactor P8 (docs/plans/2026-07-02-world-class-refactor-plan.md §P8).
 * One module owns the on-disk entity-page format end to end:
 *
 *   - render side: `renderEntityPage` + `renderYamlFrontmatter` — emit the
 *     canonical `---\n<frontmatter>---\n\n<compiled>\n---\n\n## Timeline\n\n…`
 *     page shape (deterministic, byte-stable, sorted frontmatter keys)
 *   - parse side: `parseFrontmatter` (the exact inverse of
 *     `renderYamlFrontmatter`), `extractCompiledTruth`, `extractTimeline`
 *   - the kind ↔ directory maps: `KIND_TO_DIR` and its derived inverse
 *     `DIR_TO_KIND`
 *   - `mergeTimeline` — the (ts, source, body)-deduped newest-first merge
 *
 * History: the render side + `extractCompiledTruth`/`extractTimeline` lived in
 * `runtime/entity-writer.ts`; the parse side (`parseFrontmatter`/
 * `parseYamlScalar`) and a byte-for-byte `extractCompiledTruth` copy were
 * HAND-MIRRORED in `scribe/write-to-gbrain.ts`, and `DIR_TO_KIND` was
 * hand-mirrored in `gbrain-memory/GBrainSyncHook.ts`. The G3 golden test
 * (`runtime/__tests__/entity-format-golden-mirror.test.ts`) pinned their
 * agreement; P8 deleted the mirrors against that test so this module is now
 * the only codec. The golden test still pins the render → parse → re-render
 * round trip byte-for-byte.
 *
 * This module is a LEAF: no imports. Both `runtime/entity-writer.ts` (which
 * re-exports the shared types for its existing callers) and the downstream
 * scribe/gbrain-memory packages import from here.
 */

export type EntityKind =
  | 'person'
  | 'company'
  | 'project'
  | 'meeting'
  | 'concept'
  | 'original'

export const ENTITY_KINDS: ReadonlyArray<EntityKind> = Object.freeze([
  'person',
  'company',
  'project',
  'meeting',
  'concept',
  'original',
])

/** Entity-writer on-disk directory per kind (`entities/<dir>/<slug>.md`). */
export const KIND_TO_DIR: Readonly<Record<EntityKind, string>> = Object.freeze({
  person: 'people',
  company: 'companies',
  project: 'projects',
  meeting: 'meetings',
  concept: 'concepts',
  original: 'originals',
})

/**
 * Map the on-disk `entities/<dir>/` subdirectory name back to the entity kind
 * that produced it. Derived from `KIND_TO_DIR` so the two can never drift.
 */
export const DIR_TO_KIND: Readonly<Record<string, EntityKind>> = Object.freeze(
  Object.fromEntries(
    (Object.entries(KIND_TO_DIR) as Array<[EntityKind, string]>).map(
      ([kind, dir]) => [dir, kind],
    ),
  ) as Record<string, EntityKind>,
)

export interface TimelineEntry {
  /** ISO-8601 timestamp. Caller is responsible for time-zone conventions. */
  ts: string
  /** Source pointer: file path or external URI. Single-line, <512 chars. */
  source: string
  /** One-line body. Newlines flattened to spaces by the renderer. */
  body: string
}

/**
 * Error surface shared by the codec and the entity writer. The codec itself
 * throws only `invalid_frontmatter`; the writer (`runtime/entity-writer.ts`)
 * uses the full code set. Defined here (the leaf) so the writer can re-export
 * it without creating an import cycle.
 */
export class EntityWriteError extends Error {
  constructor(
    public readonly code:
      | 'invalid_kind'
      | 'invalid_slug'
      | 'invalid_frontmatter'
      | 'invalid_timeline_entry'
      | 'invalid_owner_data_dir'
      | 'path_escape'
      | 'symlink_rejected'
      | 'read_failed'
      | 'write_failed',
    message: string,
  ) {
    super(message)
    this.name = 'EntityWriteError'
  }
}

/**
 * Render the final on-disk body. The order is locked:
 *
 *   1. `---\n` frontmatter open
 *   2. sorted-key YAML frontmatter
 *   3. `---\n\n` frontmatter close + blank line
 *   4. compiled-truth (with trailing newline normalised)
 *   5. `\n---\n\n## Timeline\n\n` separator
 *   6. timeline rows newest-first
 *
 * Deterministic so the roundtrip test can byte-compare.
 */
export function renderEntityPage(input: {
  frontmatter: Record<string, unknown>
  compiledTruth: string
  timeline: TimelineEntry[]
}): string {
  const fm = renderYamlFrontmatter(input.frontmatter)
  const compiled = ensureTrailingNewline(input.compiledTruth.trimEnd())
  const sortedTimeline = [...input.timeline].sort((a, b) =>
    a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0,
  )
  const timeline =
    sortedTimeline.length === 0
      ? ''
      : sortedTimeline
          .map((e) => {
            const flat = e.body.replace(/\n+/g, ' ').trim()
            return `- ${e.ts} | ${e.source} | ${flat}\n`
          })
          .join('')
  return `---\n${fm}---\n\n${compiled}\n---\n\n## Timeline\n\n${timeline}`
}

/**
 * Tiny deterministic YAML emitter — covers strings, numbers, booleans,
 * null, arrays-of-scalars, and one level of object nesting. Quotes
 * strings only when ambiguity requires it (contains `:`, `#`, leading
 * `-`, or YAML keywords). Sorts top-level keys lexicographically so
 * roundtrip writes are byte-stable.
 *
 * Not a full YAML implementation. Throws on unsupported shapes so the
 * caller catches schema drift early.
 */
export function renderYamlFrontmatter(fm: Record<string, unknown>): string {
  const keys = Object.keys(fm).sort()
  let out = ''
  for (const k of keys) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
      throw new EntityWriteError(
        'invalid_frontmatter',
        `frontmatter key "${k}" is not a simple identifier`,
      )
    }
    const v = fm[k]
    out += `${k}: ${renderYamlValue(v)}\n`
  }
  return out
}

function renderYamlValue(v: unknown): string {
  if (v === null) return '~'
  if (v === undefined) return '~'
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) {
      throw new EntityWriteError(
        'invalid_frontmatter',
        `non-finite number in frontmatter: ${v}`,
      )
    }
    return String(v)
  }
  if (typeof v === 'string') return renderYamlString(v)
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]'
    const items = v.map((x) => {
      if (
        x === null ||
        typeof x === 'boolean' ||
        typeof x === 'number' ||
        typeof x === 'string'
      ) {
        return renderYamlValue(x)
      }
      throw new EntityWriteError(
        'invalid_frontmatter',
        `arrays in frontmatter must be scalar — got ${typeof x}`,
      )
    })
    return `[${items.join(', ')}]`
  }
  throw new EntityWriteError(
    'invalid_frontmatter',
    `unsupported frontmatter value type: ${typeof v}`,
  )
}

const YAML_KEYWORDS = new Set([
  'true',
  'false',
  'null',
  '~',
  'yes',
  'no',
  'on',
  'off',
])

function renderYamlString(s: string): string {
  if (s.length === 0) return '""'
  if (s.includes('\n') || s.includes('\r')) {
    throw new EntityWriteError(
      'invalid_frontmatter',
      'multi-line strings in frontmatter are not supported',
    )
  }
  const needsQuotes =
    /[:#\[\]{},&*!|>'"%@`]/.test(s) ||
    /^[-?]/.test(s) ||
    /^\s|\s$/.test(s) ||
    YAML_KEYWORDS.has(s.toLowerCase()) ||
    /^[+-]?[0-9]/.test(s)
  if (!needsQuotes) return s
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * Parse the YAML frontmatter block of an on-disk entity page into a key→value
 * map — the inverse of `renderYamlFrontmatter`. Handles the exact shapes that
 * emitter produces (scalars, `~` null, `[a, b]` scalar arrays, `"quoted"`
 * strings). Returns `{}` when there's no frontmatter fence. Values are typed
 * so re-emitting them round-trips byte-for-byte (idempotency). Lines with a
 * non-identifier key are skipped (the renderer would reject them anyway).
 */
export function parseFrontmatter(body: string): Record<string, unknown> {
  if (!body.startsWith('---\n')) return {}
  const fmEnd = body.indexOf('\n---\n', 4)
  if (fmEnd === -1) return {}
  const block = body.slice(4, fmEnd) // between the opening `---\n` and `\n---\n`
  const out: Record<string, unknown> = {}
  for (const line of block.split('\n')) {
    if (line.length === 0) continue
    const idx = line.indexOf(':')
    if (idx === -1) continue
    const key = line.slice(0, idx).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    out[key] = parseYamlScalar(line.slice(idx + 1).trim())
  }
  return out
}

/** Inverse of `renderYamlValue` for the scalar + scalar-array shapes that
 *  emitter produces. Anything unrecognised stays a raw string. */
export function parseYamlScalar(raw: string): unknown {
  if (raw === '~' || raw === '') return null
  if (raw === 'true') return true
  if (raw === 'false') return false
  if (raw.startsWith('[') && raw.endsWith(']')) {
    const inner = raw.slice(1, -1).trim()
    if (inner.length === 0) return []
    return splitTopLevelCommas(inner).map((x) => parseYamlScalar(x.trim()))
  }
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    return raw.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw)) {
    const n = Number(raw)
    if (Number.isFinite(n)) return n
  }
  return raw
}

/** Split on top-level commas, respecting `"…"` quoting (array items may be
 *  quoted strings that contain commas). */
function splitTopLevelCommas(s: string): string[] {
  const parts: string[] = []
  let cur = ''
  let inQuote = false
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i]
    if (ch === '"' && s[i - 1] !== '\\') inQuote = !inQuote
    if (ch === ',' && !inQuote) {
      parts.push(cur)
      cur = ''
      continue
    }
    cur += ch
  }
  parts.push(cur)
  return parts
}

/**
 * Pull the compiled-truth block out of an on-disk page. The renderer
 * emits the canonical shape `---\n<frontmatter>---\n\n<compiled>\n---\n\n##
 * Timeline\n\n...`; this helper scans for the second `---\n` (closing the
 * frontmatter), then for the `\n---\n\n## Timeline` separator (opening
 * the timeline). Everything in between is the compiled truth.
 *
 * Liberal parsing — if the page is hand-edited and doesn't match the
 * canonical shape, the helper returns the entire body (so a downstream
 * call to `extractTypedLinks` may include timeline references; that's a
 * larger surface than ideal but it's preferable to silently dropping
 * the previous-link set used for the removed-links diff).
 */
export function extractCompiledTruth(body: string): string {
  // Find the frontmatter close: first `---\n` at column 0 after position 0.
  // The page starts with `---\n`, so we look for the NEXT line-anchored `---\n`.
  if (!body.startsWith('---\n')) return body
  const fmEnd = body.indexOf('\n---\n', 4)
  if (fmEnd === -1) return body
  let afterFm = fmEnd + '\n---\n'.length
  // The renderer emits `---\n\n${compiled}` — skip the separator blank line
  // so the returned slice is the compiled truth alone, without leading
  // structural whitespace.
  if (body[afterFm] === '\n') afterFm += 1
  // Find the timeline separator. Canonical form is `\n---\n\n## Timeline`.
  // Be liberal with the whitespace between the `---` and the `## Timeline`.
  const timelineMatch = body.slice(afterFm).match(
    /\n---\n+##\s+Timeline\s*\n/i,
  )
  const end =
    timelineMatch !== null && timelineMatch.index !== undefined
      ? afterFm + timelineMatch.index
      : body.length
  return body.slice(afterFm, end)
}

/**
 * Pull existing timeline rows out of an on-disk page. Recognises the
 * `## Timeline` section header (case-insensitive) and parses lines of
 * the form `- <ts> | <source> | <body>`. Lines that don't match are
 * skipped — the parser is deliberately liberal in what it accepts since
 * existing pages may have been hand-edited.
 */
export function extractTimeline(body: string): TimelineEntry[] {
  const lines = body.split('\n')
  let i = 0
  for (; i < lines.length; i += 1) {
    if (/^##\s+timeline\s*$/i.test(lines[i]!.trim())) {
      i += 1
      break
    }
  }
  if (i >= lines.length) return []
  const entries: TimelineEntry[] = []
  for (; i < lines.length; i += 1) {
    const raw = lines[i]!
    const m = raw.match(/^-\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*(.*)$/)
    if (m === null) continue
    entries.push({ ts: m[1]!.trim(), source: m[2]!.trim(), body: m[3]!.trim() })
  }
  return entries
}

/**
 * Merge a new entry into an existing timeline. Dedup on `(ts, source,
 * body)`; sort newest-first by `ts` (lexicographic ISO-8601 sort).
 */
export function mergeTimeline(
  existing: TimelineEntry[],
  next: TimelineEntry,
): TimelineEntry[] {
  const flatNext: TimelineEntry = {
    ts: next.ts,
    source: next.source,
    body: next.body.replace(/\n+/g, ' ').trim(),
  }
  const key = (e: TimelineEntry) => `${e.ts}\x1f${e.source}\x1f${e.body}`
  const seen = new Set<string>()
  const merged: TimelineEntry[] = []
  for (const e of [flatNext, ...existing]) {
    const k = key(e)
    if (seen.has(k)) continue
    seen.add(k)
    merged.push(e)
  }
  merged.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0))
  return merged
}

export function ensureTrailingNewline(s: string): string {
  return s.endsWith('\n') ? s : `${s}\n`
}
