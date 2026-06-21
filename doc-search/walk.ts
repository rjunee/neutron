/**
 * @neutronai/doc-search — project markdown walker + path-safe reader.
 *
 * The indexer needs the set of markdown files under a project folder
 * (`<owner_home>/Projects/<id>/`). Per
 * docs/plans/project-folder-convention.md a project carries
 * `README.md`, `STATUS.md`, `CLAUDE.md` at the root plus `docs/`,
 * `research/`, `notes/`, `archive/` subtrees — all of which are real
 * doc content the agent should be able to search.
 *
 * Walking rules:
 *   - Recurse the whole project tree, but SKIP any segment that starts
 *     with `.` (so `.git`, `.obsidian`, dotfiles never get indexed) and
 *     skip `node_modules`.
 *   - Only `.md` / `.markdown` files (case-insensitive) are returned.
 *   - Files larger than `maxBytes` (default 5 MB, matching the doc
 *     store's write cap) are skipped — a runaway file shouldn't bloat
 *     the index.
 *   - Symlinks are resolved and the result must stay inside the project
 *     root (defense-in-depth against a symlink escape).
 */

import type { Dirent } from 'node:fs'
import { realpath, readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

/** Markdown extensions the walker + reader accept (case-insensitive). */
export const MARKDOWN_EXTENSIONS = Object.freeze(['.md', '.markdown']) as readonly string[]

const MARKDOWN_RE = new RegExp(`\\.(?:${MARKDOWN_EXTENSIONS.map((e) => e.slice(1)).join('|')})$`, 'i')

/** Default per-file size cap (5 MB) — mirrors `gateway/http/doc-store.ts`. */
export const MAX_DOC_BYTES = 5 * 1024 * 1024

/** A markdown file discovered under a project root. */
export interface WalkedFile {
  /** POSIX-style path relative to the project root, e.g. `docs/plan.md`. */
  relpath: string
  /** Absolute on-disk path. */
  absPath: string
  /** File mtime in ms — drives incremental reindexing. */
  mtimeMs: number
  /** File size in bytes. */
  size: number
}

export interface WalkOptions {
  maxBytes?: number
  /** Defensive recursion cap so a pathological tree can't run away. */
  maxDepth?: number
}

const DEFAULT_MAX_DEPTH = 12

/** True iff a path segment is safe to descend into / index. */
function segmentAllowed(name: string): boolean {
  if (name.startsWith('.')) return false
  if (name === 'node_modules') return false
  return true
}

/**
 * Enumerate markdown files under `projectRoot`, sorted by relpath for
 * deterministic output. Returns `[]` when the root doesn't exist (a
 * freshly-created project with no docs yet is the steady state, not an
 * error).
 */
export async function walkProjectMarkdown(
  projectRoot: string,
  options: WalkOptions = {},
): Promise<WalkedFile[]> {
  const maxBytes = options.maxBytes ?? MAX_DOC_BYTES
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH

  let rootReal: string
  try {
    rootReal = await realpath(projectRoot)
  } catch {
    return []
  }

  const out: WalkedFile[] = []

  async function descend(dirAbs: string, depth: number): Promise<void> {
    if (depth > maxDepth) return
    let entries: Dirent[]
    try {
      entries = await readdir(dirAbs, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!segmentAllowed(entry.name)) continue
      const childAbs = join(dirAbs, entry.name)
      if (entry.isDirectory()) {
        await descend(childAbs, depth + 1)
        continue
      }
      if (entry.isSymbolicLink()) {
        // Resolve + containment-check before treating it as a file.
        let real: string
        try {
          real = await realpath(childAbs)
        } catch {
          continue
        }
        if (!isInside(rootReal, real)) continue
        const info = await statSafe(real)
        if (info === null || !info.isFile()) continue
        await consider(childAbs, info.mtimeMs, info.size)
        continue
      }
      if (entry.isFile()) {
        const info = await statSafe(childAbs)
        if (info === null) continue
        await consider(childAbs, info.mtimeMs, info.size)
      }
    }
  }

  async function consider(absPath: string, mtimeMs: number, size: number): Promise<void> {
    if (!MARKDOWN_RE.test(absPath)) return
    if (size > maxBytes) return
    const rel = relative(rootReal, absPath).split(sep).join('/')
    if (rel.length === 0 || rel.startsWith('..')) return
    out.push({ relpath: rel, absPath, mtimeMs, size })
  }

  await descend(rootReal, 0)
  out.sort((a, b) => a.relpath.localeCompare(b.relpath))
  return out
}

async function statSafe(p: string): Promise<{ isFile(): boolean; mtimeMs: number; size: number } | null> {
  try {
    const s = await stat(p)
    return { isFile: () => s.isFile(), mtimeMs: s.mtimeMs, size: s.size }
  } catch {
    return null
  }
}

/** True iff `child` is `parent` or sits inside it (realpath'd inputs). */
function isInside(parent: string, child: string): boolean {
  if (child === parent) return true
  const withSep = parent.endsWith(sep) ? parent : parent + sep
  return child.startsWith(withSep)
}

/** Grammar for a project_id folder name (mirrors `gateway/projects/enumerate.ts`). */
const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/**
 * Read a single project doc by (project, relpath), path-safe. Returns
 * the file content or `null` when the project_id is malformed, the path
 * escapes the project root, the extension isn't markdown, the file is
 * missing, or it exceeds the size cap.
 *
 * This backs the `doc_read` agent tool: search surfaces a path, then
 * the agent reads it. Scoping the read to `<owner_home>/Projects/<id>/`
 * keeps the tool from becoming an arbitrary-file-read primitive.
 */
export async function readProjectDoc(
  ownerHome: string,
  project: string,
  relpath: string,
  options: { maxBytes?: number } = {},
): Promise<{ project: string; path: string; content: string } | null> {
  const maxBytes = options.maxBytes ?? MAX_DOC_BYTES
  if (!PROJECT_ID_RE.test(project)) return null
  if (typeof relpath !== 'string' || relpath.length === 0) return null
  if (relpath.startsWith('/')) return null
  const segments = relpath.split(/[\\/]+/)
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') return null
    if (seg.startsWith('.')) return null
  }
  if (!MARKDOWN_RE.test(relpath)) return null

  const projectRoot = join(ownerHome, 'Projects', project)
  const target = join(projectRoot, ...segments)
  let rootReal: string
  let targetReal: string
  try {
    rootReal = await realpath(projectRoot)
    targetReal = await realpath(target)
  } catch {
    return null
  }
  if (!isInside(rootReal, targetReal)) return null

  const info = await statSafe(targetReal)
  if (info === null || !info.isFile() || info.size > maxBytes) return null
  try {
    const content = await readFile(targetReal, 'utf8')
    return { project, path: segments.join('/'), content }
  } catch {
    return null
  }
}
