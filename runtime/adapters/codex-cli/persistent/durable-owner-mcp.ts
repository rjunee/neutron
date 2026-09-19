import { ApprovedMcpBroker, type ApprovedMcpContext } from './approved-mcp-broker.ts'
import { CodexOwnerInstalledGateway, type CodexOwnerToolRequest } from './owner-installed-gateway.ts'
import type { ResolvedOwnerMcpServer } from '../../../mcp-servers.ts'

/** One approved SDK connection surface per durable owner binding. A turn supplies
 * fresh host authority; model arguments and consumer handles supply none. */
export class DurableOwnerMcp {
  private context: ApprovedMcpContext | undefined
  private assertPreparation: () => void = () => { throw new Error('No owner preparation') }
  private assertConversation: () => void = () => { throw new Error('No owner conversation') }
  private signal = AbortSignal.abort()
  private readonly broker: ApprovedMcpBroker
  private readonly gateway: CodexOwnerInstalledGateway
  constructor(resolveApproved: () => Promise<readonly ResolvedOwnerMcpServer[]>) {
    this.broker = new ApprovedMcpBroker({
      currentContext: () => this.context ? { ...this.context } : null,
      assertOwnerPreparation: () => this.assertPreparation(),
      assertOwnerConversation: () => this.assertConversation(),
      resolveApproved,
      onRetired: () => this.gateway.retireConsumers(),
      onServerRetired: name => this.gateway.retireServer(name),
      onNotification: (context, server, notification, consumers) => this.gateway.notify(context, server, notification, consumers),
    })
    this.gateway = new CodexOwnerInstalledGateway({ broker: this.broker,
      context: () => { if (!this.context) throw new Error('No owner MCP binding'); return { ...this.context } },
      assertCurrent: () => this.assertConversation(),
    })
  }
  async prepare(context: ApprovedMcpContext, signal: AbortSignal, assertPreparation: () => void, assertConversation: () => void) {
    assertPreparation()
    this.context = { ...context, idle: true }
    this.signal = signal
    this.assertPreparation = assertPreparation
    this.assertConversation = assertConversation
    await this.broker.bind(this.context, signal)
    assertPreparation()
    this.context.idle = false
  }
  handle(request: CodexOwnerToolRequest, leaseId: string, assertTurn: () => void): Promise<unknown> {
    return this.gateway.handle(request, this.signal, assertTurn, leaseId)
  }
  retireTurn(leaseId: string) {
    if (this.context?.leaseId === leaseId) this.context.idle = true
  }
  close(): Promise<void> { this.context = undefined; return this.gateway.close() }
  retireRevoked(): Promise<void> { return this.broker.retireRevoked() }
}
