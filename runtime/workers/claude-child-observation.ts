import { constants } from 'node:fs'
import { open, opendir } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { BoundedWorkRequest, ProviderObservation } from '../bounded-work.ts'

const fields = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'] as const
const count = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
type Counts = Record<typeof fields[number], number | null>

export const CHILD_OBSERVATION_MAX_BYTES = 8 * 1024 * 1024
export const CHILD_OBSERVATION_MAX_LINE = 256 * 1024
export const CHILD_OBSERVATION_TIMEOUT_MS = 250

async function snapshot(path: string, limit: number, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    signal.throwIfAborted()
    const info = await file.stat()
    if (!info.isFile() || info.size > limit) throw new Error('Observation exceeds regular snapshot bounds')
    const bytes = Buffer.alloc(info.size)
    let offset = 0
    while (offset < bytes.length) {
      signal.throwIfAborted()
      const read = await file.read(bytes, offset, bytes.length - offset, offset)
      if (!read.bytesRead) throw new Error('Observation snapshot was truncated')
      offset += read.bytesRead
    }
    signal.throwIfAborted()
    return bytes.toString('utf8')
  } finally { await file.close() }
}

/** Provider transcript only, never worker result text. Host times describe this
 * read window, not reconstructed execution times. The first user envelope must
 * bind the complete request; every counted assistant envelope binds the child.
 * Repeated content blocks for one provider message carry cumulative usage, so
 * retain maxima by message id instead of charging the same message repeatedly. */
export async function observeClaudeChildUsage(directory: string, sessionId: string,
  request: BoundedWorkRequest): Promise<ProviderObservation | undefined> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<undefined>(resolve => {
    timer = setTimeout(() => { controller.abort(); resolve(undefined) }, CHILD_OBSERVATION_TIMEOUT_MS)
  })
  try { return await Promise.race([collect(directory, sessionId, request, controller.signal), expired]) }
  finally { clearTimeout(timer); controller.abort() }
}

async function collect(directory: string, sessionId: string, request: BoundedWorkRequest,
  signal: AbortSignal): Promise<ProviderObservation | undefined> {
  const started_at_ms = Date.now()
  try {
    const matches: string[] = []
    let entries = 0
    for await (const entry of await opendir(directory)) {
      signal.throwIfAborted()
      if (++entries > 4096) return undefined
      const name = entry.name
      if (!/^agent-.+\.meta\.json$/.test(name)) continue
      try {
        const meta = JSON.parse(await snapshot(join(directory, name), 16 * 1024, signal))
        if (meta?.description === `${request.role}: ${request.step_id}`) matches.push(name.slice(6, -10))
      } catch { return undefined /* Cannot establish uniqueness across unreadable metadata. */ }
    }
    if (matches.length !== 1) return undefined
    const agentId = matches[0]!
    const bytes = await snapshot(join(directory, `agent-${agentId}.jsonl`), CHILD_OBSERVATION_MAX_BYTES, signal)
    const messages = new Map<string, Counts>()
    const models = new Set<string>()
    const owns = (row: Record<string, unknown>) => row.agentId === agentId && row.sessionId === sessionId && row.isSidechain === true
    let first = true
      for (const line of bytes.split('\n')) {
        signal.throwIfAborted()
        if (Date.now() - started_at_ms >= CHILD_OBSERVATION_TIMEOUT_MS || line.length > CHILD_OBSERVATION_MAX_LINE) return undefined
        let row
        try { row = JSON.parse(line) } catch { if (first) return undefined; continue }
        if (!row || typeof row !== 'object') { if (first) return undefined; continue }
        if (first) {
          first = false
          if (!owns(row) || row.type !== 'user' || row.message?.role !== 'user' || typeof row.message.content !== 'string') return undefined
          const requests = row.message.content.split('\n').filter((value: string) => value.startsWith('Request (data): '))
          if (requests.length !== 1 || !isDeepStrictEqual(JSON.parse(requests[0]!.slice(16)), request)) return undefined
          continue
        }
        if (!owns(row) || row.type !== 'assistant' || row.message?.role !== 'assistant' || row.isApiErrorMessage === true) continue
        const message = row.message
        if (typeof message.id !== 'string' || !message.id || typeof message.model !== 'string' || !message.model || message.model === '<synthetic>') continue
        models.add(message.model)
        const previous = messages.get(message.id)
        const counts = {} as Counts
        for (const field of fields) {
          const value = count(message.usage?.[field]), prior = previous?.[field] ?? null
          counts[field] = value === null ? prior : prior === null ? value : Math.max(prior, value)
        }
        messages.set(message.id, counts)
      }
    if (first) return undefined
    const totals = {} as Counts
    for (const field of fields) {
      let total: number | null = messages.size === 0 ? null : 0
      for (const message of messages.values()) total = total === null || message[field] === null ? null : count(total + message[field]!)
      totals[field] = total
    }
    const finished_at_ms = Date.now()
    return { source: 'claude-repl-jsonl', started_at_ms, finished_at_ms, observed_at_ms: finished_at_ms,
      thread_id: agentId, model_reported: models.size === 1 ? [...models][0]! : null,
      usage: { ...totals, cost_usd: null } }
  } catch { return undefined }
}
