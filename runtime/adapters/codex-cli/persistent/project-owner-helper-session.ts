import { randomBytes } from 'node:crypto'
import type { ProjectControlGateway, ProjectControlState } from './project-control-broker.ts'
import type { Rpc } from './project-owner-helper-protocol.ts'
import { BROKER_MAX_MESSAGE_BYTES } from './project-control-broker-transport.ts'

/** One stable gateway principal. Frontend grants are replaceable; its native
 * approval and active-turn authority is retained until the helper is destroyed.
 */
export class OwnerHelperSession {
  private grant: string | undefined
  private sequence = 0
  private events: { sequence: number; message: Rpc; bytes: number }[] = []
  private eventBytes = 0
  private failure: Error | undefined
  private outstanding = 0
  private approvals = new Map<string | number, Rpc>()
  private listeners = new Set<() => void>()
  private unsubscribe: () => void
  constructor(private writer: ProjectControlGateway, private state: () => ProjectControlState, private assertOwner: () => void) {
    this.unsubscribe = writer.subscribe(message => {
      if (typeof message.method === 'string' && (typeof message.id === 'string' || typeof message.id === 'number')) {
        this.approvals.set(message.id, message)
        if (this.approvals.size > 64 || Buffer.byteLength(JSON.stringify([...this.approvals.values()])) > BROKER_MAX_MESSAGE_BYTES) {
          this.approvals.delete(message.id)
          this.failure = new Error('Retained owner approval capacity exceeded; reconciliation unknown')
        }
      }
      if (message.method === 'turn/completed') this.approvals.clear()
      const bytes = Buffer.byteLength(JSON.stringify(message))
      this.events.push({ sequence: ++this.sequence, message, bytes })
      this.eventBytes += bytes
      while (this.events.length > 512 || this.eventBytes > BROKER_MAX_MESSAGE_BYTES) this.eventBytes -= this.events.shift()!.bytes
      for (const listener of this.listeners) listener()
    })
  }
  attach() {
    this.assertOwner()
    if (this.failure) throw this.failure
    this.grant = randomBytes(32).toString('hex')
    for (const listener of this.listeners) listener()
    return { grant: this.grant, state: this.state(), cursor: this.sequence, approvals: [...this.approvals.values()] }
  }
  assertGrant(grant: unknown): void {
    this.assertOwner()
    if (this.failure) throw this.failure
    if (!this.grant || grant !== this.grant) throw new Error('Stale owner frontend grant')
  }
  detach(grant: unknown): void {
    this.assertGrant(grant)
    this.grant = undefined
    for (const listener of this.listeners) listener()
  }
  async request(grant: unknown, method: string, params: Rpc, epoch?: number) {
    this.assertGrant(grant)
    this.outstanding++
    try {
      const result = await this.writer.request(method, params, epoch)
      this.assertGrant(grant)
      return { result, state: this.state() }
    } finally { this.outstanding-- }
  }
  reply(grant: unknown, id: string | number, result: unknown, epoch: number) {
    this.assertGrant(grant)
    this.writer.reply(id, result, epoch)
    this.approvals.delete(id)
    return { state: this.state() }
  }
  async poll(grant: unknown, cursor: number, signal: AbortSignal) {
    this.assertGrant(grant)
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > this.sequence) throw new Error('Invalid owner event cursor')
    if (cursor === this.sequence && !signal.aborted) await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); this.listeners.delete(finish); signal.removeEventListener('abort', finish); resolve() }
      const timer = setTimeout(finish, 500)
      this.listeners.add(finish); signal.addEventListener('abort', finish, { once: true })
    })
    this.assertGrant(grant)
    if (cursor < (this.events[0]?.sequence ?? 1) - 1) throw new Error('Owner event history gap; reattach and reconcile the native rollout')
    return { events: this.events.filter(event => event.sequence > cursor), cursor: this.sequence, state: this.state() }
  }
  destroy(): void {
    this.grant = undefined
    for (const listener of this.listeners) listener()
    this.unsubscribe(); this.writer.close()
  }
  canRetire(): boolean { return !this.failure && this.outstanding === 0 && this.state().phase === 'idle' && this.approvals.size === 0 }
}
