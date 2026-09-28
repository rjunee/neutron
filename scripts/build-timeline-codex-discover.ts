/** Discover native rollout receipts under one operator-authorized session tree. */
import { constants } from 'node:fs'
import { lstat, open, readFile, readdir, realpath } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { importCodexOperations, type CodexImportOptions } from './build-timeline-codex-import.ts'
import type { DirectPhaseObservation } from './build-timeline-sources.ts'

const MAX_ROLLOUTS = 256
const MAX_SOURCE_BYTES = 128 * 1024 * 1024
const MAX_ENTRIES = 4096
type RolloutIdentity = {
  path: string; dev: bigint; ino: bigint; size: number; mtimeNs: bigint; ctimeNs: bigint
}
export type DiscoveredCodexRollout = RolloutIdentity & { snapshot: Buffer }

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

function matchesIdentity(stat: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }, source: RolloutIdentity): boolean {
  return stat.dev === source.dev && stat.ino === source.ino && stat.size >= BigInt(source.size) &&
    (stat.size > BigInt(source.size) || (stat.mtimeNs === source.mtimeNs && stat.ctimeNs === source.ctimeNs))
}

/** Capture the discovered first N bytes once, before later appends can move the window. */
async function captureRollout(root: string, source: RolloutIdentity, beforeRead?: (path: string) => Promise<void>): Promise<Buffer> {
  const file = await open(source.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await file.stat({ bigint: true })
    const resolved = await realpath(source.path)
    if (!stat.isFile() || !insideRoot(root, resolved) || !matchesIdentity(stat, source)) {
      throw new Error('Native rollout changed after discovery')
    }
    await beforeRead?.(source.path)
    const buffer = Buffer.alloc(source.size)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset)
      if (!bytesRead) throw new Error('Native rollout changed during read')
      offset += bytesRead
    }
    const after = await file.stat({ bigint: true })
    if (!matchesIdentity(after, source)) throw new Error('Native rollout changed during read')
    return buffer
  } finally { await file.close() }
}

export interface CodexRolloutCheckpoint {
  version: 1
  path: string
  dev: string
  ino: string
  size: number
  mtimeNs: string
  ctimeNs: string
  offset: number
  /** Base64 bytes of the unfinished final line, not yet passed to the parser. */
  pending: string
  lines: string[]
}

const MAX_REGISTERED_BYTES = 1024 * 1024 * 1024
const MAX_LINE_BYTES = 8 * 1024 * 1024

/** Incremental receipt journal, private trusted state persisted atomically by the
 * caller. Attribution is recomputed with this source's current config on every
 * call; transcript-only records are discarded. No directory enumeration occurs. */
export async function importRegisteredCodexRollout(sessionsRoot: string, path: string,
  options: CodexImportOptions, checkpoint?: CodexRolloutCheckpoint,
  beforeRead?: (path: string) => Promise<void>) {
  await importCodexOperations([], options)
  const root = await authorizedRoot(sessionsRoot)
  if (!isAbsolute(path) || resolve(path) !== path ||
      !/^\d{4}\/\d{2}\/\d{2}\/rollout-[^/]+\.jsonl$/.test(relative(root, path))) {
    throw new Error('Invalid registered rollout path')
  }
  // Exact canonical paths forbid aliases through any dated directory, including
  // symlinks that happen to point back inside the authorized tree.
  if (await realpath(path) !== path) throw new Error('Aliased registered rollout')
  const stat = await lstat(path, { bigint: true })
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid registered rollout')
  const size = Number(stat.size)
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_REGISTERED_BYTES) throw new Error('Native discovery exceeds bounds')
  const source = { path, dev: stat.dev, ino: stat.ino, size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs }
  if (checkpoint && (checkpoint.version !== 1 || checkpoint.path !== path ||
      checkpoint.dev !== String(stat.dev) || checkpoint.ino !== String(stat.ino) ||
      !Number.isSafeInteger(checkpoint.size) || checkpoint.size < 0 || checkpoint.size > size ||
      checkpoint.offset !== checkpoint.size || typeof checkpoint.pending !== 'string' ||
      checkpoint.pending.length > Math.ceil(MAX_LINE_BYTES / 3) * 4 ||
      !/^\d+$/.test(checkpoint.mtimeNs) || !/^\d+$/.test(checkpoint.ctimeNs) ||
      (checkpoint.size === size && (checkpoint.mtimeNs !== String(stat.mtimeNs) || checkpoint.ctimeNs !== String(stat.ctimeNs))) ||
      !Array.isArray(checkpoint.lines) || checkpoint.lines.length > 1_000_000 ||
      checkpoint.lines.some(line => typeof line !== 'string' || Buffer.byteLength(line) > MAX_LINE_BYTES))) {
    throw new Error('Invalid or changed native checkpoint')
  }
  const lines = checkpoint ? [...checkpoint.lines] : []
  let pending: Buffer = checkpoint ? Buffer.from(checkpoint.pending, 'base64') : Buffer.alloc(0)
  if (pending.length > MAX_LINE_BYTES || pending.length > (checkpoint?.size ?? 0) ||
      (checkpoint && pending.toString('base64') !== checkpoint.pending) || pending.includes(10)) {
    throw new Error('Invalid native checkpoint pending bytes')
  }
  let retainedBytes = lines.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0)
  if (retainedBytes > MAX_SOURCE_BYTES) throw new Error('Native receipt journal exceeds bounds')
  let position = checkpoint?.offset ?? 0, scanned = 0, readBytes = 0
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const current = await file.stat({ bigint: true })
    if (!current.isFile() || await realpath(path) !== path || !matchesIdentity(current, source)) throw new Error('Native rollout changed after discovery')
    await beforeRead?.(path)
    const chunk = Buffer.alloc(64 * 1024)
    while (position < size) {
      const { bytesRead } = await file.read(chunk, 0, Math.min(chunk.length, size - position), position)
      if (!bytesRead) throw new Error('Native rollout changed during read')
      position += bytesRead
      readBytes += bytesRead
      pending = Buffer.concat([pending, chunk.subarray(0, bytesRead)])
      let start = 0, end: number
      while ((end = pending.indexOf(10, start)) !== -1) {
        if (++scanned > 1_000_000 || end - start > MAX_LINE_BYTES) throw new Error('Native discovery exceeds bounds')
        const line = pending.subarray(start, end).toString('utf8')
        start = end + 1
        // Keep invalid records as evidence of malformed coverage; bound them just
        // like relevant receipts. Valid transcript-only records can be discarded.
        let keep = true
        try {
          const row = JSON.parse(line)
          keep = ['session_meta', 'turn_context', 'token_usage_record'].includes(row?.type) ||
            (row?.type === 'event_msg' && ['item_completed', 'task_complete'].includes(row?.payload?.type))
        } catch { /* importer records malformed coverage */ }
        if (keep) {
          retainedBytes += Buffer.byteLength(line) + 1
          if (retainedBytes > MAX_SOURCE_BYTES || lines.length >= 1_000_000) throw new Error('Native receipt journal exceeds bounds')
          lines.push(line)
        }
      }
      pending = Buffer.from(pending.subarray(start))
      if (pending.length > MAX_LINE_BYTES) throw new Error('Native discovery exceeds bounds')
    }
    const after = await file.stat({ bigint: true })
    const named = await lstat(path, { bigint: true })
    if (!matchesIdentity(after, source) || !named.isFile() || !matchesIdentity(named, source) || await realpath(path) !== path) {
      throw new Error('Native rollout changed during read')
    }
  } finally { await file.close() }
  const result = await importCodexOperations(lines, options)
  if (pending.length || size === 0) result.coverage.incomplete++
  const next: CodexRolloutCheckpoint = { version: 1, path, dev: String(stat.dev), ino: String(stat.ino),
    size, mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs), offset: size, pending: pending.toString('base64'), lines }
  return { ...result, source: { dev: stat.dev, ino: stat.ino },
    scan: { sourceBytes: size, readBytes, partial: pending.length > 0 }, checkpoint: next }
}

/** The dated native layout is the discovery boundary; unrelated files are ignored. */
export async function discoverCodexRollouts(sessionsRoot: string, beforeRead?: (path: string) => Promise<void>): Promise<DiscoveredCodexRollout[]> {
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
      const stat = await lstat(path, { bigint: true })
      if (!stat.isFile() || stat.isSymbolicLink()) continue
      const size = Number(stat.size)
      totalBytes += size
      if (files.length + 1 > MAX_ROLLOUTS || totalBytes > MAX_SOURCE_BYTES) throw new Error('Native discovery exceeds bounds')
      const source = { path, dev: stat.dev, ino: stat.ino, size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs }
      files.push({ ...source, snapshot: await captureRollout(root, source, beforeRead) })
    }
  }
  await visit(root, 0)
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

/** Revalidate the path, then use the immutable captured bytes without a second full read. */
export async function readDiscoveredRollout(root: string, source: DiscoveredCodexRollout): Promise<string> {
  if (!Number.isSafeInteger(source.size) || source.size < 0 || source.size > MAX_SOURCE_BYTES ||
      !insideRoot(root, source.path) || source.snapshot.length !== source.size) throw new Error('Invalid discovered rollout')
  // A path replaced with a FIFO must not block before fstat can reject it.
  const file = await open(source.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await file.stat({ bigint: true })
    const resolved = await realpath(source.path)
    if (!stat.isFile() || !insideRoot(root, resolved) || !matchesIdentity(stat, source)) {
      throw new Error('Native rollout changed after discovery')
    }
    return source.snapshot.toString('utf8')
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
    if (file.size === 0) { incomplete++; continue }
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
