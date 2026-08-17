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
 * against `git ls-files` on this repository's own real index.
 *
 * Format reference: git's `Documentation/gitformat-index.txt`.
 */

export interface FixtureEntry {
  readonly path: string
  /** Defaults to a regular file. `0o040000` makes it a sparse DIRECTORY entry. */
  readonly mode?: number
}

export interface FixtureOptions {
  /** Defaults to 2. Version 4 is prefix-compressed and must be refused. */
  readonly version?: number
  /** `[signature, payload length]` — `['link', 4]` marks a split index. */
  readonly extensions?: ReadonlyArray<readonly [string, number]>
}

function be32(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]
}

export function encodeIndex(
  entries: readonly FixtureEntry[],
  options: FixtureOptions = {},
): Uint8Array {
  const out: number[] = [...new TextEncoder().encode('DIRC')]
  out.push(...be32(options.version ?? 2), ...be32(entries.length))
  for (const entry of entries) {
    const start = out.length
    const name = [...new TextEncoder().encode(entry.path)]
    out.push(...new Array<number>(24).fill(0)) // ctime, mtime, dev, ino
    out.push(...be32(entry.mode ?? 0o100644))
    out.push(...new Array<number>(12).fill(0)) // uid, gid, size
    out.push(...new Array<number>(20).fill(0)) // object id
    out.push(...be32(name.length).slice(2)) // flags — the low 12 bits are the path length
    out.push(...name)
    // Padded with 1-8 NULs to a multiple of 8 bytes from the entry's start.
    const written = out.length - start
    out.push(...new Array<number>(((written + 8) & ~7) - written).fill(0))
  }
  for (const [signature, size] of options.extensions ?? []) {
    out.push(...new TextEncoder().encode(signature), ...be32(size))
    out.push(...new Array<number>(size).fill(0))
  }
  out.push(...new Array<number>(20).fill(0)) // trailing checksum, which the parser does not verify
  return Uint8Array.from(out)
}
