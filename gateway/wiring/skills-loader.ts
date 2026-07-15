/**
 * @neutronai/gateway/wiring/skills-loader
 *
 * Sprint A — GBrain methodology integration v2 (2026-05-12).
 * Plan: docs/plans/2026-05-09-gbrain-methodology-integration-v2.md § 9.1.
 *
 * Reads `<instance-data-dir>/skills/conventions/*.md` at session-start and
 * concatenates them into a single block the system prompt embeds.
 *
 * Per Garry's rule (`gbrain_THIN_HARNESS_FAT_SKILLS.md` L99-103): the loader
 * is HARNESS code — no judgment about which skill to load — it just reads
 * the directory and concatenates. Selection is the LLM's job (it sees the
 * concatenated block + the inbound message and reasons about which
 * convention applies).
 *
 * Cache:
 *   - keyed by `skillsDir`, per-process
 *   - mtime-based invalidation: every call restats every regular `.md`
 *     file under the subdirs; on any mtime mismatch the cache reloads
 *   - cache hit returns the same referentially-equal `LoadedSkills` object
 *
 * Safety:
 *   - symlinks rejected (use `lstat` not `stat`); prevents a skill file
 *     from escaping the instance data dir's `skills/` subtree via a symlink
 *   - non-`.md` files ignored
 *   - hidden files (leading `.`) ignored
 *   - combined body capped at 256 KB; throws `SkillsLoaderError` on
 *     `body_too_large`
 *   - missing or empty `skills/` directory → `{ body: '', mtimes: {}, files: [] }`
 *     (back-compat for instances created before Sprint A)
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'

export interface LoadedSkills {
  /**
   * Concatenated body in stable lexicographic order across all files,
   * separated by an `---`-fenced header pointing at the source path
   * (relative to `skillsDir`). Empty string when no `.md` files exist.
   */
  body: string
  /**
   * Per-file mtimes (ms since epoch) for cache invalidation. Keys are
   * paths relative to `skillsDir`.
   */
  mtimes: Record<string, number>
  /** Files surfaced, in the same order they appear in `body`. */
  files: string[]
}

export interface SkillsLoaderOptions {
  /** `<instance-data-dir>/skills/` root. */
  skillsDir: string
  /**
   * Subdirectory filter — defaults to `['conventions']`. Pass
   * `['conventions', 'onboarding']` to also pick up onboarding skills
   * if the engine is in that phase.
   */
  subdirs?: string[]
}

export class SkillsLoaderError extends Error {
  constructor(
    public readonly code:
      | 'body_too_large'
      | 'symlink_rejected'
      | 'read_failed',
    message: string,
  ) {
    super(message)
    this.name = 'SkillsLoaderError'
  }
}

/** Hard cap on the combined body. ~256 KB at 1 byte per char. */
export const MAX_BODY_BYTES = 256 * 1024

const DEFAULT_SUBDIRS = ['conventions'] as const

type CacheEntry = {
  loaded: LoadedSkills
  /** Mtimes captured at load time — checked against current mtimes on
   *  every subsequent call to decide cache hit vs miss. */
  capturedMtimes: Record<string, number>
}

const cache: Map<string, CacheEntry> = new Map()

/**
 * Reset the per-process cache. Tests call this in `beforeEach` to avoid
 * cross-test leakage. Not exported in production code paths.
 */
export function _resetSkillsLoaderCache(): void {
  cache.clear()
}

/**
 * Read every `.md` file under each subdir of `skillsDir`, concatenate
 * lexicographically, and return the cached `LoadedSkills`. Symlinks are
 * rejected (security). Caches per `skillsDir`; mtime mismatch on any
 * file invalidates the entry.
 */
export async function loadSkills(
  opts: SkillsLoaderOptions,
): Promise<LoadedSkills> {
  const subdirs =
    opts.subdirs !== undefined && opts.subdirs.length > 0
      ? opts.subdirs
      : [...DEFAULT_SUBDIRS]
  const cacheKey = `${opts.skillsDir}|${subdirs.join(',')}`

  // First, walk the directory tree to capture current mtimes. We need
  // this both for cache validation and for the cold load below.
  const currentEntries = await collectEntries(opts.skillsDir, subdirs)

  const cached = cache.get(cacheKey)
  if (cached !== undefined && sameMtimes(cached.capturedMtimes, currentEntries.mtimes)) {
    return cached.loaded
  }

  // Cache miss or first call — read every file and assemble the body.
  let body = ''
  let totalBytes = 0
  for (let i = 0; i < currentEntries.relativePaths.length; i += 1) {
    const rel = currentEntries.relativePaths[i]!
    const abs = currentEntries.absolutePaths[i]!
    let raw: string
    try {
      raw = await fs.readFile(abs, 'utf8')
    } catch (err) {
      throw new SkillsLoaderError(
        'read_failed',
        `failed to read ${rel}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    const header = `<!-- skill: ${rel} -->\n`
    const separator = body.length === 0 ? '' : '\n---\n\n'
    const chunk = `${separator}${header}${raw.endsWith('\n') ? raw : `${raw}\n`}`
    totalBytes += Buffer.byteLength(chunk, 'utf8')
    if (totalBytes > MAX_BODY_BYTES) {
      throw new SkillsLoaderError(
        'body_too_large',
        `combined skills body exceeds ${MAX_BODY_BYTES} bytes at ${rel}`,
      )
    }
    body += chunk
  }

  const loaded: LoadedSkills = Object.freeze({
    body,
    mtimes: Object.freeze({ ...currentEntries.mtimes }),
    files: Object.freeze([...currentEntries.relativePaths]) as unknown as string[],
  }) as LoadedSkills

  cache.set(cacheKey, {
    loaded,
    capturedMtimes: { ...currentEntries.mtimes },
  })
  return loaded
}

/**
 * Walk every subdir of `skillsDir` and return the absolute + relative
 * paths of every regular `.md` file plus their mtimes. Symlinks throw.
 * Missing dirs yield no entries (back-compat — pre-Sprint-A instances
 * keep working).
 */
async function collectEntries(
  skillsDir: string,
  subdirs: ReadonlyArray<string>,
): Promise<{
  absolutePaths: string[]
  relativePaths: string[]
  mtimes: Record<string, number>
}> {
  const absolutePaths: string[] = []
  const relativePaths: string[] = []
  const mtimes: Record<string, number> = {}

  // If the root doesn't exist, treat as empty — back-compat for instances
  // created before Sprint A. `lstat` so we don't follow a symlinked
  // root either.
  try {
    const rootStat = await fs.lstat(skillsDir)
    if (rootStat.isSymbolicLink()) {
      throw new SkillsLoaderError(
        'symlink_rejected',
        `skillsDir is a symlink: ${skillsDir}`,
      )
    }
    if (!rootStat.isDirectory()) {
      return { absolutePaths, relativePaths, mtimes }
    }
  } catch (err) {
    if (err instanceof SkillsLoaderError) throw err
    if (isENOENT(err)) {
      return { absolutePaths, relativePaths, mtimes }
    }
    throw err
  }

  for (const sub of subdirs) {
    const subAbs = join(skillsDir, sub)
    let subStat: Awaited<ReturnType<typeof fs.lstat>>
    try {
      subStat = await fs.lstat(subAbs)
    } catch (err) {
      if (isENOENT(err)) continue
      throw err
    }
    if (subStat.isSymbolicLink()) {
      throw new SkillsLoaderError(
        'symlink_rejected',
        `subdir is a symlink: ${sub}`,
      )
    }
    if (!subStat.isDirectory()) continue

    const dirents = await fs.readdir(subAbs, { withFileTypes: true })
    // Lexicographic for determinism.
    dirents.sort((a, b) => a.name.localeCompare(b.name))
    for (const dirent of dirents) {
      if (dirent.name.startsWith('.')) continue
      if (!dirent.name.endsWith('.md')) continue

      const fileAbs = join(subAbs, dirent.name)
      // `withFileTypes` returns symlink info on `isSymbolicLink()`; trust
      // it but `lstat` again defensively because some FS quirks (network
      // mounts) misreport via readdir.
      const fileStat = await fs.lstat(fileAbs)
      if (fileStat.isSymbolicLink()) {
        throw new SkillsLoaderError(
          'symlink_rejected',
          `skill file is a symlink: ${sub}/${dirent.name}`,
        )
      }
      if (!fileStat.isFile()) continue

      const rel = `${sub}/${dirent.name}`
      absolutePaths.push(fileAbs)
      relativePaths.push(rel)
      mtimes[rel] = fileStat.mtimeMs
    }
  }

  return { absolutePaths, relativePaths, mtimes }
}

function sameMtimes(
  a: Record<string, number>,
  b: Record<string, number>,
): boolean {
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) return false
  for (const k of aKeys) {
    if (b[k] !== a[k]) return false
  }
  return true
}

function isENOENT(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === 'ENOENT'
  )
}
