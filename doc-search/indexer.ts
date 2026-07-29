/**
 * @neutronai/doc-search — corpus indexer.
 *
 * Walks `<owner_home>/Projects/<id>/` for every project, chunks each
 * markdown file, and upserts it into the `DocSearchIndex`. Reindexing
 * is INCREMENTAL: a file whose mtime is unchanged since its last index
 * is skipped, files that vanished from disk are dropped, and projects
 * that no longer exist are purged. A full first run indexes everything;
 * subsequent refreshes touch only what changed, so the agent can call
 * `ensureFresh()` cheaply before every search.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { chunkMarkdown } from './chunk.ts'
import { enumerateProjects as defaultEnumerate } from './projects.ts'
import type { DocSearchIndex } from './store.ts'

export interface RefreshStats {
  projects: number
  filesIndexed: number
  filesSkipped: number
  filesRemoved: number
  projectsRemoved: number
}

export interface RefreshDeps {
  ownerHome: string
  index: DocSearchIndex
  /** Override the project enumerator (tests). Defaults to a disk scan. */
  enumerateProjects?: (ownerHome: string) => Promise<string[]>
  /** Override the markdown walker (tests). Defaults to `walkProjectMarkdown`. */
  walk?: (projectRoot: string) => Promise<
    Array<{ relpath: string; absPath: string; mtimeMs: number; size: number }>
  >
  /** Soft cap per chunk (chars). Forwarded to the chunker. */
  maxChunkChars?: number
  log?: (msg: string) => void
}

/**
 * Bring the index up to date with what's on disk. Idempotent: running
 * it twice with no filesystem changes indexes 0 files the second time.
 */
export async function refreshIndex(deps: RefreshDeps): Promise<RefreshStats> {
  const enumerate = deps.enumerateProjects ?? defaultEnumerate
  // Lazy import so a test that injects `walk` never pulls fs realpath.
  const walk =
    deps.walk ?? ((root: string) => import('./walk.ts').then((m) => m.walkProjectMarkdown(root)))

  const stats: RefreshStats = {
    projects: 0,
    filesIndexed: 0,
    filesSkipped: 0,
    filesRemoved: 0,
    projectsRemoved: 0,
  }

  const projects = await enumerate(deps.ownerHome)
  const liveProjects = new Set(projects)
  stats.projects = projects.length

  // Purge projects that disappeared from disk.
  for (const indexed of deps.index.indexedProjects()) {
    if (!liveProjects.has(indexed)) {
      deps.index.removeProject(indexed)
      stats.projectsRemoved += 1
    }
  }

  for (const project of projects) {
    const projectRoot = join(deps.ownerHome, 'Projects', project)
    const files = await walk(projectRoot)
    const onDisk = new Set<string>()
    const known = deps.index.fileMtimes(project)

    for (const file of files) {
      onDisk.add(file.relpath)
      const knownMtime = known.get(file.relpath)
      if (knownMtime !== undefined && knownMtime === file.mtimeMs) {
        stats.filesSkipped += 1
        continue
      }
      let content: string
      try {
        content = await readFile(file.absPath, 'utf8')
      } catch {
        continue
      }
      const opts: { filename: string; maxChars?: number } = { filename: file.relpath }
      if (deps.maxChunkChars !== undefined) opts.maxChars = deps.maxChunkChars
      const { title, chunks } = chunkMarkdown(content, opts)
      await deps.index.indexFile({
        project,
        relpath: file.relpath,
        absPath: file.absPath,
        title,
        mtimeMs: file.mtimeMs,
        chunks,
      })
      stats.filesIndexed += 1
    }

    // Drop files that were indexed before but are gone from disk now.
    for (const relpath of known.keys()) {
      if (!onDisk.has(relpath)) {
        deps.index.removeFile(project, relpath)
        stats.filesRemoved += 1
      }
    }
  }

  deps.log?.(
    `[doc-search] refresh: ${stats.filesIndexed} indexed, ${stats.filesSkipped} unchanged, ` +
      `${stats.filesRemoved} removed, ${stats.projectsRemoved} projects purged`,
  )
  return stats
}
