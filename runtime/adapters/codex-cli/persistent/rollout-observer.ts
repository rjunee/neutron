import { closeSync, constants, fstatSync, openSync, readSync, statSync } from 'node:fs'
import type { Event, TokenUsage } from '../../../events.ts'

/** Supplied by the host's verified pane binding, never discovered by cwd/mtime. */
export interface CodexRolloutIdentity {
  readonly projectId: string
  readonly paneHandle: string
  readonly threadId: string
  readonly rolloutPath: string
  readonly cwd: string
}

type RecordValue = Record<string, unknown>
function object(value: unknown): RecordValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('codex rollout refused: malformed record')
  }
  return value as RecordValue
}

const MAX_RECORD_BYTES = 8 * 1024 * 1024
const MAX_BASELINE_BYTES = 64 * 1024 * 1024
const auxiliaryEvents = new Set([
  'item_started', 'item_completed', 'agent_message', 'agent_reasoning',
  'agent_reasoning_raw_content', 'token_count', 'thread_settings_applied',
])

/**
 * Native TUI rollout reader. task_started/item_completed/task_complete and
 * turn_aborted shapes were measured in native CLI rollouts; this is NOT the
 * different `codex exec --json` protocol. Unknown lifecycle records refuse.
 *
 * Construction validates the complete baseline before the host submits input.
 * Only appended records can answer this turn. The host must hold an exclusive
 * turn lease throughout construction, submission, observation and cancellation.
 */
export class CodexRolloutObserver {
  private readonly fd: number
  private offset = 0
  private pending = Buffer.alloc(0)
  private readonly seenTurns = new Set<string>()
  private activeTurn: string | undefined
  private echoed = false
  private terminal = false
  private closed = false
  private usage: TokenUsage = { input_tokens: 0, output_tokens: 0 }
  private readonly device: number
  private readonly inode: number

  constructor(readonly identity: CodexRolloutIdentity, private readonly prompt: string) {
    if (Object.values(identity).some((value) => value.length === 0)) {
      throw new Error('codex rollout refused: incomplete native identity')
    }
    this.fd = openSync(identity.rolloutPath, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const info = fstatSync(this.fd)
      if (!info.isFile() || info.size > MAX_BASELINE_BYTES) {
        throw new Error('codex rollout refused: unsupported baseline')
      }
      this.device = info.dev
      this.inode = info.ino
      const baseline = this.readAppend()
      if (this.pending.length !== 0 || baseline.length === 0) {
        throw new Error('codex rollout refused: incomplete baseline')
      }
      this.validateMeta(baseline[0])
      for (const record of baseline.slice(1)) this.consume(record, true)
      if (this.activeTurn !== undefined) throw new Error('codex rollout refused: native turn already active')
      this.terminal = false
    } catch (error) {
      closeSync(this.fd)
      throw error
    }
  }

  /** Cancellation is safe only after the exact submitted prompt is attested. */
  get turnId(): string | undefined { return this.echoed ? this.activeTurn : undefined }
  get completed(): boolean { return this.terminal }

  read(): Event[] {
    if (this.closed) throw new Error('codex rollout refused: observer closed')
    if (this.terminal) return []
    try {
      const events: Event[] = []
      // Parse the entire append before returning success: a second start in the
      // same append is concurrent input, not permission to release the lease.
      for (const record of this.readAppend()) events.push(...this.consume(record, false))
      return events
    } catch (error) {
      this.close()
      throw error
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    closeSync(this.fd)
  }

  private readAppend(): unknown[] {
    const named = statSync(this.identity.rolloutPath)
    const info = fstatSync(this.fd)
    if (named.dev !== this.device || named.ino !== this.inode || info.size < this.offset) {
      throw new Error('codex rollout refused: file replaced or truncated')
    }
    if (info.size - this.offset > MAX_BASELINE_BYTES) throw new Error('codex rollout refused: append too large')
    const records: unknown[] = []
    while (this.offset < info.size) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, info.size - this.offset))
      const count = readSync(this.fd, chunk, 0, chunk.length, this.offset)
      if (count === 0) throw new Error('codex rollout refused: file changed during read')
      this.offset += count
      this.pending = Buffer.concat([this.pending, chunk.subarray(0, count)])
      let end: number
      while ((end = this.pending.indexOf(10)) !== -1) {
        if (end > MAX_RECORD_BYTES) throw new Error('codex rollout refused: record too large')
        const line = this.pending.subarray(0, end).toString('utf8')
        this.pending = this.pending.subarray(end + 1)
        records.push(JSON.parse(line))
      }
      if (this.pending.length > MAX_RECORD_BYTES) throw new Error('codex rollout refused: record too large')
    }
    return records
  }

  private validateMeta(value: unknown): void {
    const record = object(value)
    const meta = object(record.payload)
    if (record.type !== 'session_meta' || meta.id !== this.identity.threadId
      || meta.cwd !== this.identity.cwd || meta.source !== 'cli' || meta.originator !== 'codex-tui') {
      throw new Error('codex rollout refused: native session identity mismatch')
    }
  }

  private consume(value: unknown, baseline: boolean): Event[] {
    const record = object(value)
    const payload = object(record.payload)
    if (record.type === 'session_meta') throw new Error('codex rollout refused: repeated session metadata')
    if (payload.thread_id !== undefined && payload.thread_id !== this.identity.threadId) {
      throw new Error('codex rollout refused: wrong native thread')
    }
    if (record.type === 'token_usage_record') {
      if (!baseline && payload.turn_id !== this.activeTurn) throw new Error('codex rollout refused: stale usage')
      if (!baseline) {
        const usage = object(payload.turn_token_usage)
        for (const key of ['input_tokens', 'output_tokens', 'cached_input_tokens']) {
          if (typeof usage[key] !== 'number' || !Number.isSafeInteger(usage[key]) || usage[key] < 0) {
            throw new Error('codex rollout refused: malformed usage')
          }
        }
        this.usage = {
          input_tokens: usage.input_tokens as number,
          output_tokens: usage.output_tokens as number,
          cache_read_input_tokens: usage.cached_input_tokens as number,
        }
      }
      return []
    }
    if (record.type !== 'event_msg') {
      if (!['response_item', 'turn_context', 'world_state', 'compacted'].includes(String(record.type))) {
        throw new Error('codex rollout refused: unknown native record')
      }
      if (record.type === 'turn_context' && !baseline && payload.turn_id !== this.activeTurn) {
        throw new Error('codex rollout refused: wrong turn context')
      }
      return []
    }
    switch (payload.type) {
      case 'task_started': {
        const id = payload.turn_id
        if (typeof id !== 'string' || id.length === 0 || this.activeTurn !== undefined
          || (!baseline && this.terminal) || this.seenTurns.has(id)) {
          throw new Error('codex rollout refused: stale or concurrent native turn')
        }
        this.seenTurns.add(id)
        this.activeTurn = id
        return []
      }
      case 'item_completed': {
        if (!baseline && (payload.turn_id !== this.activeTurn || payload.thread_id !== this.identity.threadId)) {
          throw new Error('codex rollout refused: wrong native item identity')
        }
        const item = object(payload.item)
        if (!baseline && item.type === 'UserMessage') {
          const content = item.content
          if (this.activeTurn === undefined || this.echoed || !Array.isArray(content) || content.length !== 1
            || object(content[0]).type !== 'text' || object(content[0]).text !== this.prompt) {
            throw new Error('codex rollout refused: submitted prompt does not match native turn')
          }
          this.echoed = true
        }
        return []
      }
      case 'task_complete':
      case 'turn_aborted': {
        if (this.activeTurn === undefined || payload.turn_id !== this.activeTurn) {
          throw new Error('codex rollout refused: completion does not match native turn')
        }
        if (baseline) { this.activeTurn = undefined; return [] }
        if (payload.type === 'turn_aborted') throw new Error('codex rollout refused: native turn aborted')
        if (!this.echoed || typeof payload.last_agent_message !== 'string') {
          throw new Error('codex rollout refused: completion lacks correlated reply')
        }
        this.terminal = true
        this.activeTurn = undefined
        return [
          { kind: 'token', text: payload.last_agent_message },
          { kind: 'completion', usage: this.usage, substrate_instance_id: this.identity.threadId,
            session: { id: this.identity.threadId, last_active_at: Date.now() } },
        ]
      }
      default:
        if (!auxiliaryEvents.has(String(payload.type))) throw new Error('codex rollout refused: unknown native event')
        if (!baseline && payload.turn_id !== undefined && payload.turn_id !== this.activeTurn) {
          throw new Error('codex rollout refused: wrong native event turn')
        }
        return []
    }
  }
}
