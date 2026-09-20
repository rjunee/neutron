import { open } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import type { BoundedWorkRequest } from '../bounded-work.ts'

/** Read provider envelope fields, never assistant text. A matching description
 * alone cannot bind a child's error to this request: its initial user record
 * must contain the exact request and both records must name this session/child.
 * Only the last complete record can report the current turn's rate limit. */
export async function claudeChildRateLimited(path: string, agentId: string, sessionId: string, request: BoundedWorkRequest): Promise<boolean> {
  try {
    const file = await open(path, 'r')
    try {
      const { size } = await file.stat()
      const window = 64 * 1024
      const first = Buffer.alloc(Math.min(size, window))
      const last = Buffer.alloc(Math.min(size, window))
      await file.read(first, 0, first.length, 0)
      await file.read(last, 0, last.length, Math.max(0, size - window))
      // Partial writes and oversized envelope records preserve uncertainty.
      const start = first.toString('utf8')
      const tail = last.toString('utf8')
      if (!start.includes('\n') || !tail.endsWith('\n')) return false
      const initial = JSON.parse(start.slice(0, start.indexOf('\n')))
      const final = JSON.parse(tail.trimEnd().split('\n').at(-1)!)
      const owns = (row: { agentId?: unknown; sessionId?: unknown; isSidechain?: unknown }) =>
        row.agentId === agentId && row.sessionId === sessionId && row.isSidechain === true
      if (!owns(initial) || !owns(final) || initial.type !== 'user' || initial.message?.role !== 'user') return false
      const content = initial.message.content
      if (typeof content !== 'string') return false
      const requests = content.split('\n').filter(line => line.startsWith('Request (data): '))
      if (requests.length !== 1 || !isDeepStrictEqual(JSON.parse(requests[0]!.slice('Request (data): '.length)), request)) return false
      return final.type === 'assistant' && final.message?.role === 'assistant'
        && final.message.model === '<synthetic>' && final.isApiErrorMessage === true
        && final.error === 'rate_limit' && final.apiErrorStatus === 429
        && final.quotaLimits?.status === 'rejected'
        && typeof final.requestId === 'string' && final.requestId.length > 0
    } finally { await file.close() }
  } catch { return false }
}
