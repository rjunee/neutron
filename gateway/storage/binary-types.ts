/**
 * @neutronai/gateway/storage — shared types + constants for the P7.5
 * binary surface. Lifted into its own module so doc-store /
 * app-docs-surface / tests can import constants and error subclasses
 * without pulling in the bun-sqlite-backed BinaryStore implementation.
 *
 * Per docs/plans/P7.5-binary-large-file-handling-sprint-brief.md §§ 2-3.
 */

/**
 * Maximum byte size accepted by `PUT /docs/binary`. 25 MiB matches the
 * brief default. Configurable via `BinaryStoreOptions.max_bytes` so
 * tests can lower it without recompiling and a future per-project
 * capability flag can raise it.
 */
export const MAX_BINARY_BYTES = 25 * 1024 * 1024

/**
 * Extensions the binary surface accepts. The list is also asserted to
 * be a strict subset of `DOC_VERSION_GITIGNORE` in
 * binary-store-init.test.ts so a future drift (someone adds an ext
 * here but forgets the .gitignore in P7.4) lights up a unit failure.
 */
export const BINARY_EXTENSIONS = Object.freeze([
  // Images
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  // Documents
  '.pdf',
  // Audio
  '.mp3',
  '.m4a',
  '.wav',
  // Video (small)
  '.mp4',
]) as readonly string[]

/**
 * MIME types accepted post-magic-byte-sniff. The canonical form lives
 * in this set; legacy variants (audio/x-wav, image/jpg) are mapped to
 * canonical via `canonicalizeMime`.
 */
export const BINARY_MIME_WHITELIST = Object.freeze([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'application/pdf',
  'audio/mpeg',
  'audio/mp4',
  'audio/wav',
  'video/mp4',
]) as readonly string[]

/** Lowercased map of legacy MIME → canonical MIME. */
const MIME_ALIASES: Record<string, string> = Object.freeze({
  'audio/x-wav': 'audio/wav',
  'audio/wave': 'audio/wav',
  'audio/x-pn-wav': 'audio/wav',
  'audio/x-m4a': 'audio/mp4',
  'audio/aac': 'audio/mp4',
  'audio/mp3': 'audio/mpeg',
  'audio/x-mpeg': 'audio/mpeg',
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'image/x-png': 'image/png',
  'application/x-pdf': 'application/pdf',
  'video/mpeg4': 'video/mp4',
  'video/x-mp4': 'video/mp4',
})

/** Canonicalize a declared MIME by trimming parameters and mapping
 *  aliases to the whitelist form. Returns the canonical lowercase
 *  string. */
export function canonicalizeMime(mime: string | null | undefined): string | null {
  if (typeof mime !== 'string') return null
  const trimmed = mime.split(';')[0]?.trim().toLowerCase() ?? ''
  if (trimmed.length === 0) return null
  return MIME_ALIASES[trimmed] ?? trimmed
}

/** Return `true` if the (lowercase) name ends in a binary extension. */
export function isBinaryExtension(name: string): boolean {
  const lower = name.toLowerCase()
  for (const ext of BINARY_EXTENSIONS) {
    if (lower.endsWith(ext)) return true
  }
  return false
}

/** Mapping from extension → canonical MIME. Used only for sanity-checking
 *  declared content-type vs path extension at the route layer; the sniff
 *  table is still authoritative. */
export const EXTENSION_TO_MIME: Readonly<Record<string, string>> = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
})

/** Return the canonical MIME implied by a path's extension, or null. */
export function mimeFromExtension(path: string): string | null {
  const lower = path.toLowerCase()
  const dot = lower.lastIndexOf('.')
  if (dot < 0) return null
  return EXTENSION_TO_MIME[lower.slice(dot)] ?? null
}

/** Which kinds of media track an ISO-BMFF file declares. */
export interface IsoBmffTrackKinds {
  audio: boolean
  video: boolean
}

/** Guard against a malformed file driving an unbounded walk. */
const ISO_BMFF_MAX_BOXES = 4096

/**
 * Read the media handler types out of an ISO base media file (MP4 / M4A), by
 * walking the box tree to `moov > trak > mdia > hdlr` and collecting each
 * track's 4-character handler type (`soun` = audio, `vide` = video).
 *
 * This is a STRUCTURAL walk, not a byte scan: each box header is a 32-bit
 * big-endian size followed by a 4-character type, so we step box-to-box by
 * size and only descend into the four container boxes on the path. That
 * matters because a naive search for the ASCII bytes `hdlr` would happily hit
 * a false positive inside compressed `mdat` audio data.
 *
 * Handles the two size escapes from ISO/IEC 14496-12: `size == 1` means a
 * 64-bit size follows the type, `size == 0` means "runs to end of file".
 * Recorders differ on where they put `moov` — Android's MediaRecorder writes
 * it AFTER the `mdat` payload — so the walk must be able to skip a large
 * `mdat` and keep going, which stepping by size does for free.
 *
 * Returns all-false when nothing parses; callers treat that as indeterminate.
 */
export function isoBmffTrackKinds(bytes: Uint8Array): IsoBmffTrackKinds {
  const found: IsoBmffTrackKinds = { audio: false, video: false }
  // Only these boxes are containers on the path to `hdlr`; everything else is
  // skipped wholesale by its size.
  const CONTAINERS = new Set(['moov', 'trak', 'mdia'])
  let budget = ISO_BMFF_MAX_BOXES

  const readType = (at: number): string =>
    String.fromCharCode(
      bytes[at] ?? 0,
      bytes[at + 1] ?? 0,
      bytes[at + 2] ?? 0,
      bytes[at + 3] ?? 0,
    )

  const readU32 = (at: number): number =>
    ((bytes[at] ?? 0) * 0x1000000 +
      (bytes[at + 1] ?? 0) * 0x10000 +
      (bytes[at + 2] ?? 0) * 0x100 +
      (bytes[at + 3] ?? 0)) >>>
    0

  /** Walk the sibling boxes in [start, end). */
  const walk = (start: number, end: number): void => {
    let offset = start
    // A box header is 8 bytes minimum (size + type).
    while (offset + 8 <= end && budget > 0) {
      budget -= 1
      const declared = readU32(offset)
      const type = readType(offset + 4)
      let header = 8
      let size = declared
      if (declared === 1) {
        // 64-bit `largesize` follows the type. We only care about files well
        // under 10 MiB, so the high word must be zero for the box to be real.
        if (offset + 16 > end) return
        const high = readU32(offset + 8)
        const low = readU32(offset + 12)
        if (high !== 0) return
        size = low
        header = 16
      } else if (declared === 0) {
        // Extends to the end of the enclosing range.
        size = end - offset
      }
      if (size < header || offset + size > end) return

      if (type === 'hdlr') {
        // FullBox: 1 version + 3 flags, then 4 bytes `pre_defined`, then the
        // 4-character handler type.
        const handler_at = offset + header + 8
        if (handler_at + 4 <= end) {
          const handler = readType(handler_at)
          if (handler === 'soun') found.audio = true
          else if (handler === 'vide') found.video = true
        }
      } else if (CONTAINERS.has(type)) {
        walk(offset + header, offset + size)
      }
      offset += size
    }
  }

  walk(0, bytes.length)
  return found
}

/**
 * Sniff the canonical MIME from the first bytes of a blob. Returns the
 * canonical MIME (matching `BINARY_MIME_WHITELIST`) or `null` if the
 * bytes don't match any known prefix. SVG is the only text shape; we
 * scan up to the first 512 bytes for a `<svg` element.
 */
export function magicByteSniff(bytes: Uint8Array): string | null {
  if (bytes.length < 4) return null
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png'
  }
  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  // GIF: 47 49 46 38 (37|39) 61
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return 'image/gif'
  }
  // RIFF prefix — disambiguate WEBP vs WAVE on bytes 8..11.
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46
  ) {
    if (
      bytes[8] === 0x57 &&
      bytes[9] === 0x45 &&
      bytes[10] === 0x42 &&
      bytes[11] === 0x50
    ) {
      return 'image/webp'
    }
    if (
      bytes[8] === 0x57 &&
      bytes[9] === 0x41 &&
      bytes[10] === 0x56 &&
      bytes[11] === 0x45
    ) {
      return 'audio/wav'
    }
  }
  // %PDF-
  if (
    bytes.length >= 5 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d
  ) {
    return 'application/pdf'
  }
  // MP3 — ID3 tag (49 44 33) or MPEG-frame sync.
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    return 'audio/mpeg'
  }
  if (bytes[0] === 0xff && bytes[1] !== undefined) {
    // Round-2 MINOR #1 — match any MPEG-audio frame sync (top 3 bits
    // of byte[1] set). Covers MPEG-1 / MPEG-2 / MPEG-2.5 across all
    // layers including the 0xE_ range used by MPEG-2.5 frame headers
    // that iOS Voice Memos and Xing VBR-tagged files emit. Without
    // the wider mask, a Voice-Memo upload sniffs as <unknown> and
    // 415s even when the extension says `.mp3` and the bytes are a
    // valid stream.
    if ((bytes[1] & 0xe0) === 0xe0) return 'audio/mpeg'
  }
  // ISO BMFF / ftyp — bytes 4-7 spell "ftyp", brand at 8..11.
  if (
    bytes.length >= 12 &&
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70
  ) {
    const brand = String.fromCharCode(
      bytes[8] ?? 0,
      bytes[9] ?? 0,
      bytes[10] ?? 0,
      bytes[11] ?? 0,
    )
    if (brand === 'M4A ' || brand === 'M4A\0' || brand.startsWith('M4A')) {
      return 'audio/mp4'
    }
    if (
      brand === 'isom' ||
      brand === 'mp42' ||
      brand === 'mp41' ||
      brand === 'avc1' ||
      brand === 'iso2' ||
      brand === 'iso4' ||
      brand === 'iso5'
    ) {
      // A GENERIC brand says "ISO base media file", not "video". Android's
      // MediaRecorder stamps every `MediaRecorder.OutputFormat.MPEG_4` file —
      // including an audio-only voice note — with the major brand `mp42`
      // (AOSP `MPEG4Writer::writeFtypBox`), and plenty of desktop muxers write
      // `isom` for a plain `.m4a`. Reading the brand alone therefore classifies
      // real voice notes as video and 415s them at the chat-upload whitelist.
      //
      // So when the brand is ambiguous, ask the TRACK TABLE instead: an
      // audio-only file has a `soun` handler and no `vide` handler.
      // Indeterminate (truncated / no parsable `moov`) keeps the historical
      // `video/mp4` answer rather than guessing audio.
      const tracks = isoBmffTrackKinds(bytes)
      if (!tracks.video && tracks.audio) return 'audio/mp4'
      return 'video/mp4'
    }
  }
  // SVG — scan first 2048 bytes for `<svg`. Round-2 MINOR #2 — 512
  // bytes was too tight: an XML prolog (`<?xml ...?>`), DOCTYPE, and
  // a long copyright comment can push `<svg` well past the original
  // 512-byte window. Bumping to 2KB still bounds the linear scan (this
  // path runs on every upload) while accepting the real-world payloads
  // from Illustrator / Inkscape exports.
  const head = bytes.subarray(0, Math.min(bytes.length, 2048))
  // Quick rejection: SVG payloads always contain `<` early.
  for (let i = 0; i < head.length; i++) {
    if (head[i] === 0x3c /* '<' */) {
      // Look for `<svg` (case-insensitive) starting here.
      if (
        head[i + 1] === 0x73 /* s */ &&
        head[i + 2] === 0x76 /* v */ &&
        head[i + 3] === 0x67 /* g */
      ) {
        return 'image/svg+xml'
      }
      if (
        head[i + 1] === 0x53 /* S */ &&
        head[i + 2] === 0x56 /* V */ &&
        head[i + 3] === 0x47 /* G */
      ) {
        return 'image/svg+xml'
      }
    }
  }
  return null
}

/* ─── Error subclasses ────────────────────────────────────────────── */

export class BinaryPathError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'BinaryPathError'
    this.code = code
  }
}

export class BinarySizeError extends Error {
  readonly code = 'binary_too_large' as const
  readonly limit: number
  readonly actual: number
  constructor(actual: number, limit: number) {
    super(`binary exceeds ${limit} bytes (got ${actual})`)
    this.name = 'BinarySizeError'
    this.actual = actual
    this.limit = limit
  }
}

export class BinaryTypeError extends Error {
  readonly code: 'unsupported_type' | 'content_type_spoof'
  readonly declared: string | null
  readonly sniffed: string | null
  constructor(
    code: 'unsupported_type' | 'content_type_spoof',
    message: string,
    details: { declared?: string | null; sniffed?: string | null } = {},
  ) {
    super(message)
    this.name = 'BinaryTypeError'
    this.code = code
    this.declared = details.declared ?? null
    this.sniffed = details.sniffed ?? null
  }
}

export class BinaryNotFoundError extends Error {
  readonly code = 'binary_not_found' as const
  constructor(message: string) {
    super(message)
    this.name = 'BinaryNotFoundError'
  }
}

export class BinaryCorruptedError extends Error {
  readonly code = 'binary_corrupted' as const
  readonly hash: string
  readonly path: string
  constructor(path: string, hash: string) {
    super(`binary at path=${path} (hash=${hash}) is missing on disk`)
    this.name = 'BinaryCorruptedError'
    this.path = path
    this.hash = hash
  }
}

export class BinaryStorageError extends Error {
  readonly code = 'storage_full' as const
  constructor(message: string) {
    super(message)
    this.name = 'BinaryStorageError'
  }
}

/* ─── Result shapes ───────────────────────────────────────────────── */

export interface BinaryPutResult {
  path: string
  hash: string
  size_bytes: number
  content_type: string
  modified_at: number
}

export interface BinaryDeleteResult {
  deleted_path: string
  still_referenced_by: string[]
}

export interface BinaryRow {
  path: string
  hash: string
  size_bytes: number
  content_type: string
  modified_at: number
  referenced_by_count: number
}

export interface BinaryReadResult {
  path: string
  hash: string
  size_bytes: number
  content_type: string
  modified_at: number
  abs_path: string
}

export type BinaryStoreLogger = (
  event: string,
  fields: Record<string, unknown>,
) => void

export interface BinaryStoreOptions {
  owner_home: string
  resolveProjectRoot?: (project_id: string) => string
  max_bytes?: number
  allowed_extensions?: readonly string[]
  allowed_mime_types?: readonly string[]
  logger?: BinaryStoreLogger
}
