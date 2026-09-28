/** Discover native rollout receipts under one operator-authorized session tree. */
import { constants } from 'node:fs'
import { lstat, open, readFile, readdir, realpath } from 'node:fs/promises'
import { basename, join, relative, sep } from 'node:path'
import { importCodexOperations, type CodexImportOptions } from './build-timeline-codex-import.ts'
import type { DirectPhaseObservation } from './build-timeline-sources.ts'

const MAX_ROLLOUTS = 256
const MAX_SOURCE_BYTES = 128 * 1024 * 1024
const MAX_ENTRIES = 4096
export type DiscoveredCodexRollout = { path: string; dev: number; ino: number; size: number }

async function authorizedRoot(sessionsRoot: string): Promise<string> {
  if (!sessionsRoot || basename(sessionsRoot) !== 'sessions') throw new Error('Invalid native session root')
  const rootStat = await lstat(sessionsRoot)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Invalid native session root')
  return realpath(sessionsRoot)
}

function insideRoot(root: string, path: string): boolean {
  const inside = relative(root, path)
  return !!inside && inside !== '..' && !inside.startsWith(`..${sep}`) && !inside.startsWith(sep)
}

/** The dated native layout is the discovery boundary; unrelated files are ignored. */
export async function discoverCodexRollouts(sessionsRoot: string): Promise<DiscoveredCodexRollout[]> {
  const root = await authorizedRoot(sessionsRoot)
  const files: DiscoveredCodexRollout[] = []
  let totalBytes = 0, scannedEntries = 0
  async function visit(directory: string, level: number): Promise<void> {
    const resolvedDirectory = await realpath(directory)
    const insideDirectory = relative(root, resolvedDirectory)
    if (insideDirectory === '..' || insideDirectory.startsWith(`..${sep}`) || insideDirectory.startsWith(sep)) {
      throw new Error('Native session directory escaped authorized root')
    }
    const entries = await readdir(directory, { withFileTypes: true })
    scannedEntries += entries.length
    if (scannedEntries > MAX_ENTRIES) throw new Error('Native discovery exceeds bounds')
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const path = join(directory, entry.name)
      if (level < 3) {
        const pattern = level === 0 ? /^\d{4}$/ : /^\d{2}$/
        if (entry.isDirectory() && pattern.test(entry.name)) await visit(path, level + 1)
        continue
      }
      if (!entry.isFile() || !/^rollout-[^/]+\.jsonl$/.test(entry.name)) continue
      const resolved = await realpath(path)
      if (!insideRoot(root, resolved)) throw new Error('Native rollout escaped authorized root')
      const stat = await lstat(path)
      if (!stat.isFile() || stat.isSymbolicLink()) continue
      files.push({ path, dev: stat.dev, ino: stat.ino, size: stat.size })
      totalBytes += stat.size
      if (files.length > MAX_ROLLOUTS || totalBytes > MAX_SOURCE_BYTES) throw new Error('Native discovery exceeds bounds')
    }
  }
  await visit(root, 0)
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

/** Read the same inode discovered under the root, with a fixed byte budget. */
async function readDiscoveredRollout(root: string, source: DiscoveredCodexRollout): Promise<string> {
  if (!Number.isSafeInteger(source.size) || source.size < 1 || source.size > MAX_SOURCE_BYTES ||
      !insideRoot(root, source.path)) throw new Error('Invalid discovered rollout')
  // A path replaced with a FIFO must not block before fstat can reject it.
  const file = await open(source.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await file.stat()
    const resolved = await realpath(source.path)
    if (!stat.isFile() || !insideRoot(root, resolved) || stat.dev !== source.dev ||
        stat.ino !== source.ino || stat.size !== source.size) throw new Error('Native rollout changed after discovery')
    const buffer = Buffer.alloc(source.size)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset)
      if (!bytesRead) throw new Error('Native rollout changed during read')
      offset += bytesRead
    }
    const after = await file.stat()
    if (after.dev !== source.dev || after.ino !== source.ino || after.size !== source.size) {
      throw new Error('Native rollout changed during read')
    }
    return buffer.toString('utf8')
  } finally { await file.close() }
}

export async function importDiscoveredCodexRollouts(sessionsRoot: string, files: DiscoveredCodexRollout[], options: CodexImportOptions): Promise<{
  observations: DirectPhaseObservation[]
  coverage: { discovered: number; emitted: number; unbound: number; incomplete: number }
}> {
  // Invalid scope must fail even when the authorized tree has no rollout yet.
  await importCodexOperations([], options)
  const root = await authorizedRoot(sessionsRoot)
  if (files.length > MAX_ROLLOUTS || files.reduce((sum, file) => sum + file.size, 0) > MAX_SOURCE_BYTES) {
    throw new Error('Native discovery exceeds bounds')
  }
  const observations: DirectPhaseObservation[] = []
  const ids = new Set<string>()
  let unbound = 0, incomplete = 0
  for (const file of files) {
    const snapshot = await readDiscoveredRollout(root, file)
    const result = await importCodexOperations(snapshot.split(/\r?\n/), options)
    for (const observation of result.observations) {
      if (ids.has(observation.eventId)) throw new Error('Duplicate native receipt across rollouts')
      ids.add(observation.eventId)
      observations.push(observation)
    }
    unbound += result.coverage.unbound
    incomplete += result.coverage.incomplete
  }
  return { observations, coverage: { discovered: files.length, emitted: observations.length, unbound, incomplete } }
}

export async function importCodexSessionTree(sessionsRoot: string, options: CodexImportOptions) {
  return importDiscoveredCodexRollouts(sessionsRoot, await discoverCodexRollouts(sessionsRoot), options)
}

if (import.meta.main) {
  try {
    const [sessionsRoot, config, ...extra] = process.argv.slice(2)
    if (!sessionsRoot || !config || extra.length) throw new Error('Invalid arguments')
    const options: CodexImportOptions = JSON.parse(await readFile(config, 'utf8'))
    const result = await importCodexSessionTree(sessionsRoot, options)
    for (const observation of result.observations) process.stdout.write(`${JSON.stringify(observation)}\n`)
    process.stderr.write(`${JSON.stringify(result.coverage)}\n`)
  } catch {
    process.stderr.write('Codex session discovery refused: check authorized root, native input, scope, and bounds.\n')
    process.exitCode = 1
  }
}
