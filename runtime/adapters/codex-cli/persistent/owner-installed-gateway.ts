import { randomUUID } from 'node:crypto'
import type { Notification } from '@modelcontextprotocol/sdk/types.js'
import type { ApprovedMcpBroker, ApprovedMcpContext } from './approved-mcp-broker.ts'
export interface CodexOwnerToolRequest { id: string | number; method: string; params: Record<string, unknown> }

/** Registered once on the durable root. Arguments select routes, never authority. */
export const OWNER_INSTALLED_GATEWAY_TOOL = {
  name: 'neutron_owner_mcp',
  description: 'Access approved owner MCP servers. discover returns metadata and complete discovery pages; open(server) creates a consumer. request(handle, method, params) returns the original MCP result and remains pending until complete. receive(handle) concurrently receives original notification/progress envelopes (including the original progressToken), waiting up to 20 seconds. close(handle) retires that consumer. Handles persist across owner turns; notifications do not replay across turns.',
  inputSchema: { type: 'object', properties: {
    action: { type: 'string', enum: ['discover', 'open', 'request', 'receive', 'close'] },
    server: { type: 'string' }, handle: { type: 'string' }, method: { type: 'string' },
    params: { type: 'object', additionalProperties: true },
  }, required: ['action'], additionalProperties: false },
}

interface Consumer {
  id: string
  server: string
  abort: AbortController
  queue: Array<{ leaseId: string; notification: Notification; bytes: number }>
  bytes: number
  receiving: boolean
  wake?: () => void
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const LIMIT = 1024 * 1024

/** Host-owned routing and delivery only. Approval and upstream protocol remain
 * in ApprovedMcpBroker. Closing a consumer leaves uncertain subscriptions for
 * the broker's next explicit idle admission to reconcile. */
export class CodexOwnerInstalledGateway {
  private readonly consumers = new Map<string, Consumer>()
  private closed = false
  constructor(private readonly options: {
    broker: ApprovedMcpBroker
    context(): ApprovedMcpContext
    assertCurrent(): void
  }) {}

  private check(context: ApprovedMcpContext): void {
    this.options.assertCurrent()
    const current = this.options.context()
    if (this.closed || current.idle || current.phase !== 'active'
      || JSON.stringify([current.projectId, current.sessionId, current.threadId, current.generation, current.leaseId])
        !== JSON.stringify([context.projectId, context.sessionId, context.threadId, context.generation, context.leaseId])) {
      throw new Error('Installed MCP owner binding changed')
    }
  }

  private async authorized(context: ApprovedMcpContext): Promise<void> {
    this.check(context)
    await this.options.broker.activeMetadata(context)
    this.check(context)
  }

  private retire(handle: string, consumer: Consumer): void {
    if (this.consumers.get(handle) === consumer) this.consumers.delete(handle)
    consumer.abort.abort()
    consumer.wake?.()
    consumer.queue = []
    consumer.bytes = 0
  }

  async notify(context: ApprovedMcpContext, server: string, notification: Notification, ids?: readonly string[]): Promise<void> {
    await this.authorized(context)
    let overflow = false
    for (const [handle, consumer] of this.consumers) {
      if (consumer.server !== server || (ids !== undefined && !ids.includes(consumer.id))) continue
      // Deliberately no replay from a predecessor owner turn.
      consumer.queue = consumer.queue.filter(entry => entry.leaseId === context.leaseId)
      consumer.bytes = consumer.queue.reduce((sum, entry) => sum + entry.bytes, 0)
      const copy = structuredClone(notification)
      const bytes = Buffer.byteLength(JSON.stringify(copy))
      if (consumer.bytes + bytes > LIMIT || consumer.queue.length >= 256) {
        this.retire(handle, consumer)
        await this.options.broker.releaseConsumer(context, consumer.id)
        overflow = true
        continue
      }
      consumer.queue.push({ leaseId: context.leaseId, notification: copy, bytes })
      consumer.bytes += bytes
      consumer.wake?.()
    }
    if (overflow) throw new Error('Installed MCP notification consumer overflow; consumer retired')
  }

  async handle(request: CodexOwnerToolRequest, signal: AbortSignal,
    assertOwner: () => void, leaseId: string): Promise<unknown> {
    const context = { ...this.options.context() }
    const check = () => {
      signal.throwIfAborted()
      assertOwner()
      this.check(context)
      if (context.leaseId !== leaseId || request.method !== 'item/tool/call'
        || request.params.threadId !== context.threadId || request.params.tool !== OWNER_INSTALLED_GATEWAY_TOOL.name
        || typeof request.params.turnId !== 'string' || !request.params.turnId
        || typeof request.params.callId !== 'string' || !request.params.callId) throw new Error('Invalid installed MCP native request')
    }
    check()
    const args = request.params.arguments
    if (!object(args) || Buffer.byteLength(JSON.stringify(args)) > LIMIT) throw new Error('Invalid installed MCP arguments')
    const fields: Record<string, readonly string[]> = {
      discover: ['action'], open: ['action', 'server'], request: ['action', 'handle', 'method', 'params'],
      receive: ['action', 'handle'], close: ['action', 'handle'],
    }
    if (typeof args.action !== 'string' || !Object.hasOwn(fields, args.action)
      || Object.keys(args).some(key => !fields[args.action as string]!.includes(key))) throw new Error('Invalid installed MCP action')
    const metadata = await this.options.broker.activeMetadata(context)
    check()
    let result: unknown
    if (args.action === 'discover') result = { servers: metadata }
    else if (args.action === 'open') {
      const server = metadata.find(entry => entry.name === args.server)
      if (!server || this.consumers.size >= 32) throw new Error('Installed MCP server unavailable or consumer limit reached')
      const handle = randomUUID()
      this.consumers.set(handle, { id: randomUUID(), server: server.name, abort: new AbortController(), queue: [], bytes: 0, receiving: false })
      result = { handle, server }
    } else {
      const handle = typeof args.handle === 'string' ? args.handle : ''
      const consumer = this.consumers.get(handle)
      if (!consumer || consumer.abort.signal.aborted) throw new Error('Installed MCP consumer is unavailable or retired')
      const requestSignal = AbortSignal.any([signal, consumer.abort.signal])
      if (args.action === 'close') {
        this.retire(handle, consumer)
        await this.options.broker.releaseConsumer(context, consumer.id)
        result = { closed: true }
      } else if (args.action === 'request') {
        if (typeof args.method !== 'string' || (args.params !== undefined && !object(args.params))) throw new Error('Invalid installed MCP request arguments')
        const params = args.params as Record<string, unknown> | undefined
        const token = object(params?._meta) ? params._meta.progressToken : undefined
        result = await this.options.broker.request(context, consumer.server,
          { method: args.method, ...(params === undefined ? {} : { params }) }, requestSignal, {
            consumerId: consumer.id,
            ...((typeof token === 'string' || typeof token === 'number') ? { onProgress: async progress => {
              check()
              requestSignal.throwIfAborted()
              await this.notify(context, consumer.server, { method: 'notifications/progress', params: { ...progress, progressToken: token } }, [consumer.id])
            } } : {}),
          })
        requestSignal.throwIfAborted()
      } else {
        if (consumer.receiving) throw new Error('Installed MCP consumer already has a pending receive')
        consumer.receiving = true
        try {
          const deadline = Date.now() + 20_000
          for (;;) {
            await this.authorized(context)
            check()
            requestSignal.throwIfAborted()
            consumer.queue = consumer.queue.filter(entry => entry.leaseId === leaseId)
            consumer.bytes = consumer.queue.reduce((sum, entry) => sum + entry.bytes, 0)
            if (consumer.queue.length || Date.now() >= deadline) break
            await new Promise<void>(resolve => {
              const finish = () => { clearTimeout(timer); requestSignal.removeEventListener('abort', finish); delete consumer.wake; resolve() }
              const timer = setTimeout(finish, Math.min(250, deadline - Date.now()))
              consumer.wake = finish
              requestSignal.addEventListener('abort', finish, { once: true })
              if (requestSignal.aborted) finish()
            })
          }
          result = { notifications: consumer.queue.splice(0, 64).map(entry => entry.notification) }
          consumer.bytes = consumer.queue.reduce((sum, entry) => sum + entry.bytes, 0)
        } finally { consumer.receiving = false }
      }
    }
    check()
    return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(result) }] }
  }

  retireConsumers(): void {
    for (const [handle, consumer] of this.consumers) this.retire(handle, consumer)
  }

  retireServer(name: string): void {
    for (const [handle, consumer] of this.consumers) if (consumer.server === name) this.retire(handle, consumer)
  }

  async close(): Promise<void> {
    this.closed = true
    this.retireConsumers()
    await this.options.broker.close()
  }
}
