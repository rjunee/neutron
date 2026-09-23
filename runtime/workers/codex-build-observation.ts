import type { Usage } from '../bounded-work.ts'
import { codexObservation } from './provider-observation.ts'

export interface CodexBuildObservation {
  thread_id: string
  usage: Usage | null
  model_reported: string | null
}

export function isCodexBuildObservation(value: unknown): value is CodexBuildObservation {
  if (!value || typeof value !== 'object') return false
  const v = value as CodexBuildObservation
  const count = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0
  return typeof v.thread_id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(v.thread_id)
    && (v.model_reported === null || (typeof v.model_reported === 'string' && !!v.model_reported.trim()))
    && (v.usage === null || (!!v.usage && count(v.usage.input_tokens) && count(v.usage.output_tokens)
      && (v.usage.cache_read_input_tokens === undefined || count(v.usage.cache_read_input_tokens))))
}

/** Only protocol events count. Model text, including nested event-shaped strings,
 * is data. Multiple starts/completions or a failed turn cannot certify a build. */
export function codexBuildObservation(requestedThread: string | null) {
  let pending = ''
  let thread: string | null = null
  let completed = false
  let invalid = false
  let usage: Usage | null = null
  let model: string | null = null
  let ownershipInvalid = false
  const reportedUsage: Record<string, number> = {}
  const observeEvent = (event: { type?: unknown; usage?: Record<string, unknown>; model?: unknown }) => {
    if (thread === null || ownershipInvalid) return
    if (event.type !== 'turn.completed' && event.type !== 'turn.failed') return
    for (const key of ['input_tokens', 'output_tokens', 'cached_input_tokens']) {
      const value = event.usage?.[key]
      if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) reportedUsage[key] = Math.max(reportedUsage[key] ?? 0, value)
    }
    if (typeof event.model === 'string' && event.model.trim()) model = event.model
  }
  return {
    push(chunk: string) {
      pending += chunk
      let end: number
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1)
        if (!line.trim()) continue
        if (line.length > 1024 * 1024) { invalid = true; continue }
        try {
          const event = JSON.parse(line)
          if (!event || typeof event.type !== 'string') { invalid = true; continue }
          if (event.type === 'thread.started') {
            if (thread !== null || completed || typeof event.thread_id !== 'string'
              || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(event.thread_id)
              || (requestedThread !== null && event.thread_id !== requestedThread)) { invalid = true; ownershipInvalid = true }
            else thread = event.thread_id
          }
          observeEvent(event)
          if (event.type === 'turn.failed' || event.type === 'error') invalid = true
          if (event.type === 'turn.completed') {
            if (completed || thread === null) invalid = true
            completed = true
            const u = event.usage
            // Missing/malformed telemetry stays unknown. It is not a result gate.
            if (u && Number.isSafeInteger(u.input_tokens) && u.input_tokens >= 0
              && Number.isSafeInteger(u.output_tokens) && u.output_tokens >= 0) {
              usage = { input_tokens: u.input_tokens, output_tokens: u.output_tokens,
                ...(Number.isSafeInteger(u.cached_input_tokens) && u.cached_input_tokens >= 0
                  ? { cache_read_input_tokens: u.cached_input_tokens } : {}) }
            }
            if (typeof event.model === 'string' && event.model.trim()) model = event.model
          }
        } catch { invalid = true }
      }
      if (pending.length > 1024 * 1024) { invalid = true; pending = '' }
    },
    finish(): CodexBuildObservation | null {
      return invalid || pending.trim() || !completed || thread === null ? null
        : { thread_id: thread, usage, model_reported: model }
    },
    snapshot(started: number, finished: number) {
      // A complete final JSON object without newline remains telemetry only;
      // finish() still refuses an unterminated completion as result authority.
      try { observeEvent(JSON.parse(pending)) } catch { /* Partial bytes are unknown. */ }
      // Retain spend already observed for the accepted thread if later protocol
      // events lose ownership. observeEvent refuses every subsequent update.
      const owned = thread !== null
      return { ...codexObservation(owned ? reportedUsage : undefined, owned ? thread : null, started, finished),
        model_reported: owned ? model : null }
    },
  }
}
