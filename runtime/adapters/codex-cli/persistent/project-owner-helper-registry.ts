import { randomBytes } from 'node:crypto'
import type { ProjectControlBroker } from './project-control-broker.ts'
import { OwnerHelperSession } from './project-owner-helper-session.ts'
import { object, type Rpc } from './project-owner-helper-protocol.ts'

/** Preserves the broker's exact Client-object ownership across gateway transport
 * replacement. A frontend grant never becomes another logical writer's grant.
 */
export class OwnerHelperRegistry {
  private readonly writers = new Map<string, OwnerHelperSession>()
  private readonly retiring = new Set<string>()
  private frontendGrant: string | undefined
  constructor(private broker: ProjectControlBroker, private assertOwner: () => void) {}
  attach() {
    this.assertOwner()
    this.frontendGrant = randomBytes(32).toString('hex')
    return { grant: this.frontendGrant }
  }
  async handle(raw: Rpc, signal: AbortSignal): Promise<Rpc> {
    this.assertOwner()
    if (!this.frontendGrant || raw.grant !== this.frontendGrant) throw new Error('Stale owner frontend grant')
    for (const clientId of this.retiring) {
      const writer = this.writers.get(clientId)
      if (writer?.canRetire()) { writer.destroy(); this.writers.delete(clientId); this.retiring.delete(clientId) }
    }
    if (raw.operation === 'state') return {}
    if (typeof raw.clientId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(raw.clientId)) throw new Error('Exact gateway client identity required')
    if (raw.operation === 'open') {
      let writer = this.writers.get(raw.clientId)
      if (!writer) {
        if (this.writers.size >= 64) throw new Error('Retained gateway capacity exceeded; reconcile outstanding writers')
        writer = new OwnerHelperSession(this.broker.gateway(raw.clientId), () => this.broker.state(), this.assertOwner)
        this.writers.set(raw.clientId, writer)
      }
      this.retiring.delete(raw.clientId)
      return writer.attach()
    }
    const writer = this.writers.get(raw.clientId)
    if (!writer) throw new Error('Gateway writer was not attached')
    let result: Rpc
    switch (raw.operation) {
      case 'request':
        if (typeof raw.method !== 'string' || !object(raw.params) || raw.epoch !== undefined && !Number.isSafeInteger(raw.epoch)) throw new Error('Invalid native request')
        result = await writer.request(raw.writerGrant, raw.method, raw.params, raw.epoch as number | undefined)
        break
      case 'reply':
        if (typeof raw.id !== 'string' && !Number.isSafeInteger(raw.id) || !Number.isSafeInteger(raw.epoch)) throw new Error('Invalid approval reply')
        result = writer.reply(raw.writerGrant, raw.id as string | number, raw.result, raw.epoch as number)
        break
      case 'poll': result = await writer.poll(raw.writerGrant, raw.cursor as number, signal); break
      case 'closeWriter':
        writer.detach(raw.writerGrant)
        this.retiring.add(raw.clientId)
        if (writer.canRetire()) { writer.destroy(); this.writers.delete(raw.clientId); this.retiring.delete(raw.clientId) }
        result = { retired: !this.writers.has(raw.clientId) }
        break
      default: throw new Error('Unclassified owner helper operation')
    }
    this.assertOwner()
    if (raw.grant !== this.frontendGrant) throw new Error('Stale owner frontend grant; request outcome may be unknown')
    return result
  }
  destroy() { this.frontendGrant = undefined; for (const writer of this.writers.values()) writer.destroy(); this.writers.clear(); this.retiring.clear() }
}
