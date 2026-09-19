import { closeSync, constants, fstatSync, openSync, readSync, statSync } from 'node:fs'
import type { Event, TokenUsage } from '../../../events.ts'

/** Supplied by the host's verified pane binding, never discovered by cwd/mtime. */
export interface CodexRolloutIdentity {
  readonly projectId: string
  readonly paneHandle: string
  readonly threadId: string
  readonly rolloutPath: string
  readonly cwd: string
  readonly nativeMetadata?: { readonly sessionId: string; readonly source: string; readonly originator: string }
  readonly bindingRevision?: string
}

/** Exact native turn/start receipt, enriched with the same thread's rollout path. */
export interface CodexTurnReceipt {
  readonly threadId: string
  readonly turnId: string
  readonly rolloutPath: string
  readonly bindingRevision?: string
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
 * Construction validates an existing baseline before input. An absent first
 * rollout requires exact host metadata and a native delivery receipt before
 * reading its initial records. The host must hold an exclusive
 * turn lease throughout construction, submission, observation and cancellation.
 */
export class CodexRolloutObserver {
  private fd: number | undefined
  private rolloutPath: string | undefined
  private expectedTurn: string | undefined
  private deferred = false
  private metaValidated = false
  private offset = 0
  private pending = Buffer.alloc(0)
  private readonly seenTurns = new Set<string>()
  private readonly pendingChildren = new Set<string>()
  private activeTurn: string | undefined
  private echoed = false
  private terminal = false
  private aborted = false
  private closed = false
  private usage: TokenUsage = { input_tokens: 0, output_tokens: 0 }
  private device: number | undefined
  private inode: number | undefined

  constructor(readonly identity: CodexRolloutIdentity, private readonly prompt: string) {
    if ([identity.projectId, identity.paneHandle, identity.threadId, identity.cwd, identity.rolloutPath].some(value => !value)) {
      throw new Error('codex rollout refused: incomplete native identity')
    }
    this.rolloutPath = identity.rolloutPath
    if (!this.open()) {
      if (!identity.bindingRevision || !identity.nativeMetadata?.sessionId
        || !identity.nativeMetadata.source || !identity.nativeMetadata.originator) {
        throw new Error('codex rollout refused: deferred rollout requires attested native metadata')
      }
      this.deferred = true
      return
    }
    try {
      const info = fstatSync(this.fd!)
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
      this.metaValidated = true
      for (const record of baseline.slice(1)) this.consume(record, true)
      if (this.activeTurn !== undefined) throw new Error('codex rollout refused: native turn already active')
      this.terminal = false
    } catch (error) {
      this.close()
      throw error
    }
  }

  /** A missing rollout is safe only with a native receipt, never a latest-file lookup. */
  bindReceipt(receipt: CodexTurnReceipt | void): void {
    if (!receipt) {
      if (this.deferred) throw new Error('codex rollout refused: unknown delivery; native receipt required')
      return
    }
    if (this.expectedTurn !== undefined || receipt.threadId !== this.identity.threadId || !receipt.turnId
      || receipt.bindingRevision !== this.identity.bindingRevision
      || !receipt.rolloutPath || (this.rolloutPath !== undefined && receipt.rolloutPath !== this.rolloutPath)) {
      throw new Error('codex rollout refused: native receipt identity mismatch')
    }
    this.expectedTurn = receipt.turnId
    this.rolloutPath = receipt.rolloutPath
  }

  private open(): boolean {
    if (!this.rolloutPath) return false
    try { this.fd = openSync(this.rolloutPath, constants.O_RDONLY | constants.O_NOFOLLOW) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
    const info = fstatSync(this.fd)
    this.device = info.dev
    this.inode = info.ino
    return true
  }

  /** Cancellation is safe only after the exact submitted prompt is attested. */
  get turnId(): string | undefined { return this.echoed ? this.activeTurn : undefined }
  get completed(): boolean { return this.terminal && !this.aborted }
  get interrupted(): boolean { return this.terminal && this.aborted }

  read(): Event[] {
    if (this.closed) throw new Error('codex rollout refused: observer closed')
    if (this.terminal) return []
    try {
      if (this.deferred && !this.expectedTurn) throw new Error('codex rollout refused: unknown delivery; native receipt required')
      if (this.fd === undefined && !this.open()) return []
      const events: Event[] = []
      // Parse the entire append before returning success: a second start in the
      // same append is concurrent input, not permission to release the lease.
      for (const record of this.readAppend()) {
        if (!this.metaValidated) { this.validateMeta(record); this.metaValidated = true }
        else events.push(...this.consume(record, false))
      }
      return events
    } catch (error) {
      this.close()
      throw error
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.fd !== undefined) closeSync(this.fd)
  }

  private readAppend(): unknown[] {
    const named = statSync(this.rolloutPath!)
    const info = fstatSync(this.fd!)
    if (!info.isFile()) throw new Error('codex rollout refused: unsupported rollout')
    if (named.dev !== this.device || named.ino !== this.inode || info.size < this.offset) {
      throw new Error('codex rollout refused: file replaced or truncated')
    }
    if (info.size - this.offset > MAX_BASELINE_BYTES) throw new Error('codex rollout refused: append too large')
    const records: unknown[] = []
    while (this.offset < info.size) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, info.size - this.offset))
      const count = readSync(this.fd!, chunk, 0, chunk.length, this.offset)
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
    const native = this.identity.nativeMetadata
    if (record.type !== 'session_meta' || meta.id !== this.identity.threadId
      || meta.cwd !== this.identity.cwd || meta.source !== (native?.source ?? 'cli')
      || meta.originator !== (native?.originator ?? 'codex-tui')
      || (native !== undefined && meta.session_id !== native.sessionId)) {
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
      if (record.type === 'inter_agent_communication_metadata') {
        // Native child messages carry this non-authoritative scheduling marker.
        // It neither identifies a turn nor proves user input or completion.
        if (Object.keys(payload).length !== 1 || typeof payload.trigger_turn !== 'boolean') {
          throw new Error('codex rollout refused: malformed inter-agent metadata')
        }
        return []
      }
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
          || (!baseline && this.expectedTurn !== undefined && id !== this.expectedTurn)
          || (!baseline && this.terminal) || this.seenTurns.has(id)) {
          throw new Error('codex rollout refused: stale or concurrent native turn')
        }
        this.seenTurns.add(id)
        this.activeTurn = id
        return []
      }
      case 'item_completed': {
        const item = object(payload.item)
        if (item.type === 'SubAgentActivity' && (item.kind === 'started' || item.kind === 'completed')) {
          if (payload.thread_id !== this.identity.threadId
            || [payload.turn_id, item.agent_thread_id, item.agent_path].some(value => typeof value !== 'string' || value.length === 0)) {
            throw new Error('codex rollout refused: incomplete native child identity')
          }
          const child = JSON.stringify([payload.turn_id, item.agent_thread_id, item.agent_path])
          if (item.kind === 'started') {
            if (this.activeTurn === undefined || payload.turn_id !== this.activeTurn || this.pendingChildren.has(child)) {
              throw new Error('codex rollout refused: stale or duplicate native child start')
            }
            this.pendingChildren.add(child)
          } else {
            // Native completion notifications retain the dispatching parent turn,
            // even while a later owner turn is running. Only that observed child
            // can settle its activity; it cannot echo or complete the owner turn.
            if (!this.pendingChildren.delete(child)) throw new Error('codex rollout refused: unmatched native child completion')
            return []
          }
        }
        if (!baseline && (payload.turn_id !== this.activeTurn || payload.thread_id !== this.identity.threadId)) {
          throw new Error('codex rollout refused: wrong native item identity')
        }
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
        if (payload.type === 'turn_aborted') {
          if (!this.echoed || !this.expectedTurn || this.pendingChildren.size !== 0) {
            throw new Error('codex rollout refused: native abort lacks settled correlated turn')
          }
          this.terminal = true
          this.aborted = true
          this.activeTurn = undefined
          return [{ kind: 'error', code: 'aborted', retryable: false, message: 'Codex native turn interrupted' }]
        }
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
