/**
 * @neutronai/migrations — the checkout's tracked-file list, read out of git's index.
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
 * Answering "does this checkout know about this file at all?" needs the
 * checkout's own file list, and git already keeps one: `.git/index` lists every
 * tracked path. This module reads it.
 *
 * WHAT THE INDEX IS, EXACTLY — and the limit that follows, stated here rather
 * than left for a reader to discover. The index is the STAGED tree, which is a
 * SUPERSET of the committed tree: a file that has been `git add`ed but never
 * committed is listed, and this module reports it as tracked. So the guard built
 * on top of this catches the stray that nothing ever told git about — which is
 * every occurrence of the incident above, none of which involved a `git add` —
 * and does NOT catch a stray somebody staged. That residual is a deliberate
 * scope decision, not an oversight:
 *
 *   Verifying against HEAD's tree instead would mean reading commit and tree
 *   OBJECTS, and in any clone those live in a packfile — so it would mean an
 *   `.idx` search plus delta reconstruction (`OFS_DELTA`/`REF_DELTA`), hundreds
 *   of lines of binary decoding, on the boot path, to close a hole narrower than
 *   the one being closed. The NO SUBPROCESS constraint below is what rules out
 *   the cheap version of that (`git ls-tree`), and the reason it exists applies
 *   with more force to a hand-rolled packfile reader: this check exists to stop a
 *   boot outage and must not become a new cause of one.
 *
 *   The narrowing that IS cheap is applied: an intent-to-add entry (`git add -N`)
 *   is EXCLUDED, because such an entry is git recording a path with no staged
 *   content — definitionally not in any tree, present in the index only as a
 *   note-to-self.
 *
 * The honest name for what a caller learns is therefore "tracked in the index",
 * and that is the phrase the ledger records (`runner.ts`,
 * `TRACKED_IN_DEPLOYED_TREE`). Naming it "in the deployed commit" would be an
 * overclaim, and an overclaimed provenance value is worse than a modest one —
 * the whole point of these columns is that a later investigation can trust them.
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
 *   them are `cannot verify`. Two mechanisms enforce that, and they catch
 *   different things:
 *
 *     THE FILE'S OWN CHECKSUM IS VERIFIED. Git closes every index with the SHA-1
 *     of everything before it. Without checking it, a flipped byte INSIDE a
 *     pathname is invisible — entry lengths are unchanged, so the walk lands
 *     exactly where it should and returns an authoritative-looking list holding
 *     a corrupted name. The real file then reads as untracked and a legitimate
 *     deploy refuses to boot: a false refusal produced by trusting bytes that
 *     carried their own proof of corruption.
 *
 *     PARSING IS STRICT ABOUT LANDING exactly on that checksum, because a
 *     half-parsed index yields a PARTIAL file list — the other way to arrive at
 *     a false refusal, and the one a valid checksum cannot rule out.
 *
 * Format reference: git's `Documentation/gitformat-index.txt`.
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Why a tracked-file list could not be established from an index. */
export type GitIndexUnreadable =
  | 'no-index'
  | 'unreadable-index'
  | 'unsupported-index-version'
  | 'split-index'
  | 'sparse-index'
  | 'index-checksum-mismatch'
  | 'index-hash-skipped'

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
/**
 * Extended-flags bit 13 — `git add -N`. Git has been told the path exists but
 * nothing has been staged for it, so it is in no tree and cannot be "part of the
 * deployed tree" under any reading. Listing it would let `git add -N` alone
 * satisfy the guard, which is the one staging operation that provably stages
 * nothing.
 */
const EXTENDED_INTENT_TO_ADD = 0x2000
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

  // BEFORE ANY PATH IS DECODED, because a corrupt path that decodes cleanly is
  // the failure this catches and nothing downstream can catch it. See the header.
  const integrity = checkTrailingChecksum(bytes)
  if (integrity !== null) return unreadable(integrity)

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
    const extended = (flags & EXTENDED_FLAG) !== 0
    const extendedFlags = extended ? view.getUint16(offset + ENTRY_FIXED_BYTES) : 0
    const nameStart = offset + ENTRY_FIXED_BYTES + (extended ? 2 : 0)
    const declared = flags & NAME_LENGTH_MASK
    // The length field saturates, so a longer path is delimited by its NUL
    // instead. Every entry has at least one NUL of padding, so a missing
    // terminator is a truncated file.
    const nameEnd = declared === NAME_LENGTH_MASK ? bytes.indexOf(0, nameStart) : nameStart + declared
    if (nameEnd < nameStart || nameEnd >= bytes.length) return unreadable('unreadable-index')
    // The entry is still WALKED — it occupies bytes and the offset must advance
    // past it — it is simply not reported as tracked.
    if ((extendedFlags & EXTENDED_INTENT_TO_ADD) === 0) {
      paths.add(pathBetween(bytes, nameStart, nameEnd))
    }

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

/**
 * Whether the index's trailing hash matches its contents — `null` when it does,
 * otherwise the reason it cannot be trusted.
 *
 * TWO DISTINCT ANSWERS, because they mean different things to whoever reads the
 * ledger row that results. A MISMATCH is corruption, or a file this reader has
 * misunderstood (a SHA-256 repository closes its index with 32 bytes, not 20).
 * An ALL-ZERO trailer is git working as configured: `index.skipHash` (which
 * `feature.manyFiles` turns on) deliberately writes no hash, trading integrity
 * checking for speed.
 *
 * Both are `cannot verify`, and skipHash is the more interesting of the two: the
 * index's paths are almost certainly fine, but nothing on disk PROVES it, and a
 * fail-closed boot gate does not get to assume. Recording
 * `unverifiable:index-hash-skipped` says exactly that, and it is the honest
 * answer — an operator who wants the guard active on such a machine can turn
 * `index.skipHash` off, and the row tells them that is the lever.
 */
function checkTrailingChecksum(bytes: Uint8Array): GitIndexUnreadable | null {
  const split = bytes.length - CHECKSUM_BYTES
  const trailer = bytes.subarray(split)
  if (trailer.every((b) => b === 0)) return 'index-hash-skipped'
  const actual = createHash('sha1').update(bytes.subarray(0, split)).digest()
  if (actual.length !== trailer.length) return 'index-checksum-mismatch'
  for (let i = 0; i < trailer.length; i++) {
    if (actual[i] !== trailer[i]) return 'index-checksum-mismatch'
  }
  return null
}

/** A 4-byte signature, which is ASCII by the format's definition. */
function signatureAt(bytes: Uint8Array, start: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + 4))
}

/** A path, which git stores as raw bytes and this tree writes as utf8. */
function pathBetween(bytes: Uint8Array, start: number, end: number): string {
  return new TextDecoder('utf-8').decode(bytes.subarray(start, end))
}
