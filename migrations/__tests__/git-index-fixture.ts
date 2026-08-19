/**
 * A git index file, built to the on-disk format, for tests.
 *
 * WHY BUILD ONE BY HAND rather than run `git add`: the shapes that matter most
 * are the ones git will not produce on demand inside a test — a version-4 index
 * (`feature.manyFiles`), a split index (`core.splitIndex`), a sparse index of
 * directory entries (`index.sparse`), a truncated file. Those are exactly the
 * shapes that must degrade to "cannot verify" instead of to a partial file list,
 * because a partial list reads as "these files are not tracked" and would refuse
 * a legitimate boot.
 *
 * The encoder is kept honest about the ORDINARY case by a control that does not
 * use it at all: `untracked-migration.test.ts` compares the parser's output
 * against `git ls-files` on this repository's own real index. That control is
 * load-bearing for the trailing checksum in particular — an encoder and a parser
 * that agreed on a WRONG hash would both pass every fixture here and reject every
 * real index on earth.
 *
 * Format reference: git's `Documentation/gitformat-index.txt`.
 */

import { createHash } from 'node:crypto'

export interface FixtureEntry {
  readonly path: string
  /** Defaults to a regular file. `0o040000` makes it a sparse DIRECTORY entry. */
  readonly mode?: number
  /**
   * `git add -N` — a path git has been told about with no staged content. Sets the
   * extended flag (so the entry carries its extra 16-bit flags word) and
   * intent-to-add within it. Any such entry forces index version 3, because
   * extended entries do not exist in version 2.
   */
  readonly intentToAdd?: boolean
}

/**
 * How to close the index.
 *
 * `valid` is git's normal behaviour: SHA-1 of every preceding byte. `zero` is
 * `index.skipHash` (which `feature.manyFiles` enables), where git deliberately
 * writes no hash. `stale` writes a valid hash for DIFFERENT content, which is what
 * on-disk corruption looks like — a caller that then flips a byte in the payload
 * gets the same effect without having to know the layout.
 */
export type FixtureChecksum = 'valid' | 'zero' | 'stale'

export interface FixtureOptions {
  /** Defaults to 2, or 3 if any entry is extended. Version 4 must be refused. */
  readonly version?: number
  /** `[signature, payload length]` — `['link', 4]` marks a split index. */
  readonly extensions?: ReadonlyArray<readonly [string, number]>
  /** Defaults to `valid`. */
  readonly checksum?: FixtureChecksum
}

/** Flags bit 14 — this entry carries two extra bytes of flags. */
const EXTENDED_FLAG = 0x4000
/** Extended-flags bit 13 — intent-to-add. */
const EXTENDED_INTENT_TO_ADD = 0x2000

function be32(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]
}

function be16(n: number): number[] {
  return [(n >>> 8) & 0xff, n & 0xff]
}

export function encodeIndex(
  entries: readonly FixtureEntry[],
  options: FixtureOptions = {},
): Uint8Array {
  const extended = entries.some((e) => e.intentToAdd === true)
  const out: number[] = [...new TextEncoder().encode('DIRC')]
  out.push(...be32(options.version ?? (extended ? 3 : 2)), ...be32(entries.length))
  for (const entry of entries) {
    const start = out.length
    const name = [...new TextEncoder().encode(entry.path)]
    out.push(...new Array<number>(24).fill(0)) // ctime, mtime, dev, ino
    out.push(...be32(entry.mode ?? 0o100644))
    out.push(...new Array<number>(12).fill(0)) // uid, gid, size
    out.push(...new Array<number>(20).fill(0)) // object id
    // flags — the low 12 bits are the path length, bit 14 the extended marker.
    const flags = name.length | (entry.intentToAdd === true ? EXTENDED_FLAG : 0)
    out.push(...be16(flags))
    if (entry.intentToAdd === true) out.push(...be16(EXTENDED_INTENT_TO_ADD))
    out.push(...name)
    // Padded with 1-8 NULs to a multiple of 8 bytes from the entry's start.
    const written = out.length - start
    out.push(...new Array<number>(((written + 8) & ~7) - written).fill(0))
  }
  for (const [signature, size] of options.extensions ?? []) {
    out.push(...new TextEncoder().encode(signature), ...be32(size))
    out.push(...new Array<number>(size).fill(0))
  }
  return Uint8Array.from([...out, ...trailer(out, options.checksum ?? 'valid')])
}

/**
 * The 20-byte trailer. A REAL SHA-1 by default, because the parser verifies it —
 * the encoder writing zeros here (as it did while the parser ignored the field)
 * would make every fixture read as `index-hash-skipped` and silently switch off
 * every refusal these tests assert.
 */
function trailer(payload: readonly number[], kind: FixtureChecksum): number[] {
  if (kind === 'zero') return new Array<number>(20).fill(0)
  const over = kind === 'stale' ? [...payload, 0] : payload
  return [...createHash('sha1').update(Uint8Array.from(over)).digest()]
}
