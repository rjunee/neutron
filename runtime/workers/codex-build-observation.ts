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
  let discarding = false
  let thread: string | null = null
  let completed = false
  let invalid = false
  let telemetryInvalid = false
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
  const record = (line: string, terminated: boolean) => {
    line = line.trimStart()
    if (!line.trim()) return
    const couldBeEnvelope = line.trimStart().startsWith('{')
    if (line.length > 8 * 1024 * 1024) {
      if (couldBeEnvelope) { invalid = true; ownershipInvalid = true }
      telemetryInvalid = true
      return
    }
    if (line.length > 1024 * 1024 || !terminated) telemetryInvalid = true
    try {
      const event = JSON.parse(line)
      if (!event || typeof event.type !== 'string') { telemetryInvalid = true; return }
      if (event.type === 'thread.started') {
        if (thread !== null || completed || typeof event.thread_id !== 'string'
          || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(event.thread_id)
          || (requestedThread !== null && event.thread_id !== requestedThread)) { invalid = true; ownershipInvalid = true }
        else if (terminated) thread = event.thread_id
      }
      observeEvent(event)
      if (event.type === 'turn.failed') invalid = true
      if (event.type === 'error') telemetryInvalid = true
      if (event.type === 'turn.completed') {
        if (completed || thread === null) invalid = true
        if (terminated) completed = true
        const u = event.usage
        if (u && Number.isSafeInteger(u.input_tokens) && u.input_tokens >= 0
          && Number.isSafeInteger(u.output_tokens) && u.output_tokens >= 0) {
          usage = { input_tokens: u.input_tokens, output_tokens: u.output_tokens,
            ...(Number.isSafeInteger(u.cached_input_tokens) && u.cached_input_tokens >= 0
              ? { cache_read_input_tokens: u.cached_input_tokens } : {}) }
        }
        if (typeof event.model === 'string' && event.model.trim()) model = event.model
      }
    } catch {
      // An unreadable object may carry an authority contradiction. Only clearly
      // non-envelope diagnostics can be ignored without inventing that absence.
      if (couldBeEnvelope) { invalid = true; ownershipInvalid = true }
      telemetryInvalid = true
    }
  }
  return {
    push(chunk: string) {
      if (discarding) {
        const boundary = chunk.indexOf('\n')
        if (boundary < 0) return
        chunk = chunk.slice(boundary + 1)
        discarding = false
      }
      pending = (pending + chunk).trimStart()
      let end: number
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1)
        record(line, true)
      }
      pending = pending.trimStart()
      if (pending.length > 8 * 1024 * 1024) {
        record(pending, false)
        pending = ''; discarding = true
      }
    },
    finish(): CodexBuildObservation | null {
      if (pending) { record(pending, false); pending = '' }
      return invalid || !completed || thread === null ? null
        : { thread_id: thread, usage: telemetryInvalid || pending.trim() ? null : usage,
          model_reported: telemetryInvalid || pending.trim() ? null : model }
    },
    snapshot(started: number, finished: number) {
      // A complete final JSON object without newline remains telemetry only;
      // finish() still refuses an unterminated completion as result authority.
      try { if (pending.length <= 1024 * 1024) observeEvent(JSON.parse(pending)) } catch { /* Partial bytes are unknown. */ }
      // Retain spend already observed for the accepted thread if later protocol
      // events lose ownership. observeEvent refuses every subsequent update.
      const owned = thread !== null
      return { ...codexObservation(owned ? reportedUsage : undefined, owned ? thread : null, started, finished),
        model_reported: owned ? model : null }
    },
  }
}
