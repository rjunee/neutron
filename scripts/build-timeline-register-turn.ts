#!/usr/bin/env bun
/** Manual, exact native task attribution. Private configuration only; never a transcript inference. */
import { open, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import { importCodexOperations, type CodexImportOptions } from './build-timeline-codex-import.ts'

type Binding = NonNullable<CodexImportOptions['turnBindings']>[number]
type Registration = { config: string; rollout: string; observations: string; binding: Binding }

async function attestTurn(path: string, binding: Binding): Promise<void> {
  const file = await open(path, 'r')
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > 512 * 1024 * 1024 || stat.size === 0) throw new Error('Invalid source bounds')
    const stream = file.createReadStream({ end: stat.size - 1, autoClose: false })
    const lines = createInterface({ input: stream, crlfDelay: Infinity })
    let session: string | undefined, found = false, count = 0
    try {
      for await (const line of lines) {
        if (++count > 1_000_000 || Buffer.byteLength(line) > 8 * 1024 * 1024) throw new Error('Invalid source bounds')
        if (!line.trim()) continue
        const row = JSON.parse(line)
        if (row?.type === 'session_meta') {
          if (session !== undefined || row.payload?.id !== binding.sessionId) throw new Error('Native session mismatch')
          session = row.payload.id
        }
        if (row?.type === 'turn_context' && session === binding.sessionId && row.payload?.turn_id === binding.turnId) found = true
      }
      if (!session || !found) throw new Error('Exact native turn context required')
    } finally { lines.close(); stream.destroy() }
  } finally { await file.close() }
}

/** Serialize with the dashboard refresh/recorder. An atomic config replacement
 * lets an in-flight importer finish its old snapshot; the next refresh sees this binding.
 * The observation journal is never edited, and an existing attribution is immutable. */
export async function registerNativeTurn(options: Registration): Promise<'registered' | 'already-registered'> {
  if (!options.config || !options.rollout || !options.observations ||
      new Set([options.config, options.rollout, options.observations]).size !== 3) throw new Error('Distinct private paths required')
  const lockPath = `${options.observations}.lock`
  const lock = await open(lockPath, 'wx', 0o600)
  const temporary = `${options.config}.${randomUUID()}.tmp`
  try {
    const config: CodexImportOptions = JSON.parse(await readFile(options.config, 'utf8'))
    // Reuse the importer's scope/category/duplicate validator, before touching disk.
    await importCodexOperations([], { ...config, turnBindings: [options.binding] })
    await importCodexOperations([], config)
    await attestTurn(options.rollout, options.binding)
    const current = config.turnBindings ?? []
    const existing = current.find(b => b.sessionId === options.binding.sessionId && b.turnId === options.binding.turnId)
    if (existing) {
      const links = (binding: Binding) => binding.links.map(l => `${l.repository}#${l.prNumber}`).sort().join('\n')
      if (existing.phase !== options.binding.phase || links(existing) !== links(options.binding)) throw new Error('Native turn attribution is immutable')
      return 'already-registered'
    }
    await writeFile(temporary, JSON.stringify({ ...config, turnBindings: [...current, options.binding] }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    await rename(temporary, options.config)
    return 'registered'
  } finally {
    await unlink(temporary).catch(() => {})
    await lock.close()
    await unlink(lockPath)
  }
}

if (import.meta.main) {
  try {
    // Binding JSON is a private file so identifiers do not need shell interpolation.
    const [config, rollout, observations, bindingFile, ...extra] = process.argv.slice(2)
    if (!config || !rollout || !observations || !bindingFile || extra.length) throw new Error('Missing registration arguments')
    const binding = JSON.parse(await readFile(bindingFile, 'utf8')) as Binding
    console.log(JSON.stringify({ status: await registerNativeTurn({ config, rollout, observations, binding }) }))
  } catch {
    console.error('Native turn registration refused: verify private paths, exact identity, scope and recorder lock.')
    process.exitCode = 1
  }
}
