/**
 * @neutronai/migrations — the deployed tree's file list, read out of git's index.
 *
 * WHY THIS EXISTS. `loadMigrations` applies every `NNNN_*.sql` file that is
 * PRESENT IN THE DIRECTORY, tracked or not. So a stray `.sql` that appears in
 * `migrations/` for a moment — a scratch copy, a half-finished branch, an editor
 * artifact, a file written by something else on the box — is applied at boot,
 * recorded in `_migrations` permanently, and then vanishes with the next
 * checkout. What is left is a ledger row naming a migration the repository never
 * contained, which is precisely the state that crash-looped a live instance
 * twice (see `docs/AS_BUILT.md`, and `migrations/repairs.json`).
 *
 * Answering "is this file part of the deployed tree?" needs the tree's own file
 * list, and git already keeps one: `.git/index` lists every tracked path. This
 * module reads it.
 *
 * TWO CONSTRAINTS SHAPE EVERY LINE HERE, and both come from the failure being
 * fixed rather than from taste:
 *
 *   NO SUBPROCESS. `git ls-files` would be shorter and is not available: `git`
 *   may not be installed on a self-hosted box, and a subprocess on the boot path
 *   can hang on a slow mount or a held `index.lock`. The check exists to prevent
 *   a boot outage; introducing a new way to block boot would be a bad trade.
 *   The index is read as a plain file, exactly as `provenance.ts` reads `HEAD`.
 *
 *   AN UNPARSEABLE INDEX IS "CANNOT VERIFY", NEVER "NOT TRACKED". Every failure
 *   returns a REASON rather than an empty file list, because those two answers
 *   have opposite consequences: a reason makes the caller record that provenance
 *   was not established, while an empty list would make it refuse a boot for a
 *   legitimate install. Git can write index shapes this parser deliberately does
 *   not decode (version 4's prefix compression, a split index, a sparse index of
 *   directory entries), and it can be handed a truncated or corrupt file. All of
 *   them are `cannot verify`. Parsing is also STRICT about landing exactly on
 *   the trailing checksum, because a half-parsed index yields a PARTIAL file
 *   list — the one wrong answer that produces a false refusal.
 *
 * Format reference: git's `Documentation/gitformat-index.txt`.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Why a tracked-file list could not be established from an index. */
export type GitIndexUnreadable =
  | 'no-index'
  | 'unreadable-index'
  | 'unsupported-index-version'
  | 'split-index'
  | 'sparse-index'

export type GitIndexRead =
  | { readonly ok: true; readonly paths: ReadonlySet<string> }
  | { readonly ok: false; readonly reason: GitIndexUnreadable }

/** `DIRC`, the index's magic number. */
const SIGNATURE = 'DIRC'
/** Signature (4) + version (4) + entry count (4). */
const HEADER_BYTES = 12
/** ctime, mtime, dev, ino, mode, uid, gid, size, object id, flags. */
const ENTRY_FIXED_BYTES = 62
/** Byte offset of the entry's mode, within the entry. */
const ENTRY_MODE_OFFSET = 24
/** Byte offset of the entry's flags, within the entry. */
const ENTRY_FLAGS_OFFSET = 60
/** Flags bit 14 — a version-3 entry carrying two extra bytes of flags. */
const EXTENDED_FLAG = 0x4000
/** Flags bits 0-11 — the path length, or `0x0fff` meaning "longer than this". */
const NAME_LENGTH_MASK = 0x0fff
/** The trailing SHA-1 of everything before it. */
const CHECKSUM_BYTES = 20
/** An extension's signature (4) + payload length (4). */
const EXTENSION_HEADER_BYTES = 8
/** File-type bits of an entry's mode. */
const MODE_TYPE_MASK = 0o170000
/** A directory entry, which only a SPARSE index contains. */
const MODE_DIRECTORY = 0o040000
/** The extension a split index carries: most entries live in a shared file. */
const SPLIT_INDEX_EXTENSION = 'link'
/** The extension a sparse index carries alongside its directory entries. */
const SPARSE_INDEX_EXTENSION = 'sdir'

function unreadable(reason: GitIndexUnreadable): GitIndexRead {
  return { ok: false, reason }
}

/**
 * Every path listed in `<gitDir>/index`, or the reason there is no list.
 *
 * Paths are as git stores them: relative to the checkout root, `/`-separated,
 * whatever the host platform. Conflicted entries appear once per stage and are
 * de-duplicated by the set — a file in conflict is still tracked.
 */
export function readGitIndex(gitDir: string): GitIndexRead {
  const path = join(gitDir, 'index')
  if (!existsSync(path)) return unreadable('no-index')
  try {
    return parseGitIndex(readFileSync(path))
  } catch {
    return unreadable('unreadable-index')
  }
}

/**
 * Parse an index file's bytes. TOTAL: any malformed input is a reason, never a
 * throw and never a partial list.
 *
 * Exported for its own tests. `readGitIndex` is what production calls.
 */
export function parseGitIndex(bytes: Uint8Array): GitIndexRead {
  try {
    return parse(bytes)
  } catch {
    // A DataView read past the end, a decode failure — the file is not an index
    // this code can read, which is the same answer as any other malformed shape.
    return unreadable('unreadable-index')
  }
}

function parse(bytes: Uint8Array): GitIndexRead {
  if (bytes.length < HEADER_BYTES + CHECKSUM_BYTES) return unreadable('unreadable-index')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (signatureAt(bytes, 0) !== SIGNATURE) return unreadable('unreadable-index')

  // Version 4 prefix-compresses every path against the previous one and drops
  // the padding, so it needs a different decoder. `feature.manyFiles` turns it
  // on, so this is a real shape on real machines — and the honest answer for it
  // is "cannot verify", not a partial list.
  const version = view.getUint32(4)
  if (version !== 2 && version !== 3) return unreadable('unsupported-index-version')

  const count = view.getUint32(8)
  const paths = new Set<string>()
  let offset = HEADER_BYTES
  for (let i = 0; i < count; i++) {
    if (offset + ENTRY_FIXED_BYTES > bytes.length) return unreadable('unreadable-index')

    // A directory entry means this is a SPARSE index: whole directories are
    // collapsed to one entry and the files inside them are NOT listed. Reading
    // it as a flat file list would report every file in a collapsed directory
    // as untracked — a false refusal for a legitimate checkout.
    const mode = view.getUint32(offset + ENTRY_MODE_OFFSET)
    if ((mode & MODE_TYPE_MASK) === MODE_DIRECTORY) return unreadable('sparse-index')

    const flags = view.getUint16(offset + ENTRY_FLAGS_OFFSET)
    const nameStart = offset + ENTRY_FIXED_BYTES + ((flags & EXTENDED_FLAG) === 0 ? 0 : 2)
    const declared = flags & NAME_LENGTH_MASK
    // The length field saturates, so a longer path is delimited by its NUL
    // instead. Every entry has at least one NUL of padding, so a missing
    // terminator is a truncated file.
    const nameEnd = declared === NAME_LENGTH_MASK ? bytes.indexOf(0, nameStart) : nameStart + declared
    if (nameEnd < nameStart || nameEnd >= bytes.length) return unreadable('unreadable-index')
    paths.add(pathBetween(bytes, nameStart, nameEnd))

    // Entries are padded with 1-8 NULs to a multiple of 8 bytes, measured from
    // the start of the entry (git: `(offsetof(name) + len + 8) & ~7`).
    offset += (nameEnd - offset + 8) & ~7
  }

  while (offset + EXTENSION_HEADER_BYTES + CHECKSUM_BYTES <= bytes.length) {
    const signature = signatureAt(bytes, offset)
    // A split index keeps most entries in a SHARED index file, so what was
    // parsed above is only the difference against it — a partial list.
    if (signature === SPLIT_INDEX_EXTENSION) return unreadable('split-index')
    if (signature === SPARSE_INDEX_EXTENSION) return unreadable('sparse-index')
    // Git's convention: an extension whose signature starts lowercase is one a
    // reader MUST understand to interpret the index correctly. We do not, so we
    // do not claim to.
    if (/^[a-z]/.test(signature)) return unreadable('unreadable-index')
    offset += EXTENSION_HEADER_BYTES + view.getUint32(offset + 4)
    if (offset > bytes.length) return unreadable('unreadable-index')
  }

  // STRICT LANDING. Anything else means the walk above misread an entry, and a
  // misread produces a PARTIAL path list — which would read as "these files are
  // not tracked" and refuse a legitimate boot. Better to verify nothing than to
  // verify against half a list.
  if (offset !== bytes.length - CHECKSUM_BYTES) return unreadable('unreadable-index')
  return { ok: true, paths }
}

/** A 4-byte signature, which is ASCII by the format's definition. */
function signatureAt(bytes: Uint8Array, start: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + 4))
}

/** A path, which git stores as raw bytes and this tree writes as utf8. */
function pathBetween(bytes: Uint8Array, start: number, end: number): string {
  return new TextDecoder('utf-8').decode(bytes.subarray(start, end))
}
