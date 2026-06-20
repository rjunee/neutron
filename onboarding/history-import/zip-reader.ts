/**
 * @neutronai/onboarding/history-import — minimal zip central-directory reader.
 *
 * ChatGPT exports ship as a single zip with `conversations.json`,
 * `message_feedback.json`, `model_comparisons.json`, etc. Claude.ai
 * exports ship a similar shape with `conversations.json`. We need to
 * pull a single named entry out of the zip without loading the whole
 * archive into memory the way `JSZip.loadAsync` would.
 *
 * Approach (no external zip dep; uses node:zlib for inflate-raw):
 *   1. Read the end-of-central-directory record (search the last 64K
 *      of the buffer for the EOCD signature 0x06054b50).
 *   2. Walk the central directory entries from the offset+size in EOCD;
 *      yield `{name, compressed_size, uncompressed_size, local_header_offset, method}`.
 *   3. For an entry the caller cares about, read the local file header
 *      at `local_header_offset` and decompress the data range.
 *
 * Pure-Node, no `JSZip` / `adm-zip` / `unzipper`. Validated against:
 *   - synthetic fixture authored by `onboarding/history-import/__fixtures__/build.ts`
 *   - real ChatGPT exports' file structure (deflate or stored, no
 *     encryption, no zip64 — those are escalation paths logged here
 *     for completeness; current runtime throws on encountering them).
 */

import { inflateRawSync } from 'node:zlib'

const EOCD_SIGNATURE = 0x06054b50
const EOCD_MAX_TRAIL = 65_557 // zip standard: comment field + record header
const CENTRAL_DIR_SIGNATURE = 0x02014b50
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50

export interface ZipEntry {
  /** Zip entry name (path within the archive). */
  name: string
  /** Compressed byte length. */
  compressed_size: number
  /** Uncompressed byte length. */
  uncompressed_size: number
  /** Offset of the local file header within the archive. */
  local_header_offset: number
  /** Compression method: 0 = stored (no compression), 8 = deflate. */
  method: number
}

export class ZipReadError extends Error {
  override readonly name = 'ZipReadError'
  constructor(
    readonly code:
      | 'eocd_not_found'
      | 'central_dir_corrupt'
      | 'local_header_corrupt'
      | 'unsupported_method'
      | 'zip64_unsupported'
      | 'encrypted_unsupported',
    message: string,
  ) {
    super(message)
  }
}

/**
 * Parse the central directory and return an iterable of entries. The
 * callback is invoked once per entry; throwing from inside the callback
 * cancels iteration. The data is NOT read here — call `readEntry` on the
 * archive + entry to materialize the bytes.
 */
export function listEntries(buffer: Buffer): ZipEntry[] {
  const eocd = findEocd(buffer)
  const totalEntries = buffer.readUInt16LE(eocd + 10)
  const cdSize = buffer.readUInt32LE(eocd + 12)
  const cdOffset = buffer.readUInt32LE(eocd + 16)

  if (cdOffset === 0xffffffff || cdSize === 0xffffffff || totalEntries === 0xffff) {
    throw new ZipReadError(
      'zip64_unsupported',
      'zip64 archives are not supported by this minimal reader',
    )
  }

  const entries: ZipEntry[] = []
  let cursor = cdOffset
  for (let i = 0; i < totalEntries; i++) {
    const sig = buffer.readUInt32LE(cursor)
    if (sig !== CENTRAL_DIR_SIGNATURE) {
      throw new ZipReadError(
        'central_dir_corrupt',
        `expected central-directory signature at offset ${cursor}, got 0x${sig.toString(16)}`,
      )
    }
    const generalPurposeFlag = buffer.readUInt16LE(cursor + 8)
    if ((generalPurposeFlag & 0x0001) !== 0) {
      throw new ZipReadError(
        'encrypted_unsupported',
        `entry at offset ${cursor} is encrypted; encrypted ZIPs are not supported`,
      )
    }
    const method = buffer.readUInt16LE(cursor + 10)
    const compressed_size = buffer.readUInt32LE(cursor + 20)
    const uncompressed_size = buffer.readUInt32LE(cursor + 24)
    const nameLen = buffer.readUInt16LE(cursor + 28)
    const extraLen = buffer.readUInt16LE(cursor + 30)
    const commentLen = buffer.readUInt16LE(cursor + 32)
    const local_header_offset = buffer.readUInt32LE(cursor + 42)
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLen)
    entries.push({
      name,
      compressed_size,
      uncompressed_size,
      local_header_offset,
      method,
    })
    cursor += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

/**
 * Read + decompress the bytes for a single entry. Streams the deflate
 * inflation through `node:zlib.inflateRawSync` — the synchronous form
 * is fine because we only inflate on-demand per entry, and the runner
 * yields between entries.
 */
export function readEntry(buffer: Buffer, entry: ZipEntry): Buffer {
  const offset = entry.local_header_offset
  const sig = buffer.readUInt32LE(offset)
  if (sig !== LOCAL_FILE_HEADER_SIGNATURE) {
    throw new ZipReadError(
      'local_header_corrupt',
      `expected local-file-header signature at offset ${offset}, got 0x${sig.toString(16)}`,
    )
  }
  const nameLen = buffer.readUInt16LE(offset + 26)
  const extraLen = buffer.readUInt16LE(offset + 28)
  const dataStart = offset + 30 + nameLen + extraLen
  const dataEnd = dataStart + entry.compressed_size
  const compressed = buffer.subarray(dataStart, dataEnd)

  if (entry.method === 0) {
    return Buffer.from(compressed)
  }
  if (entry.method === 8) {
    return inflateRawSync(compressed)
  }
  throw new ZipReadError(
    'unsupported_method',
    `compression method ${entry.method} is not supported (only stored=0, deflate=8)`,
  )
}

/** Convenience — find one entry by exact name; null if absent. */
export function findEntry(entries: ZipEntry[], name: string): ZipEntry | null {
  return entries.find((e) => e.name === name) ?? null
}

function findEocd(buffer: Buffer): number {
  const len = buffer.length
  const start = Math.max(0, len - EOCD_MAX_TRAIL)
  for (let i = len - 22; i >= start; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) {
      return i
    }
  }
  throw new ZipReadError(
    'eocd_not_found',
    'end-of-central-directory record not found in the last 64KB; archive may be truncated or corrupt',
  )
}
