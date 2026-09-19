import { createHash } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { DEFAULT_INHERITED_ENV_VARS, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import {
  ClientRequestSchema, ResultSchema,
  type Implementation, type Notification, type Progress, type Result, type ServerCapabilities,
} from '@modelcontextprotocol/sdk/types.js'
import { parseOwnerMcpServerInput, type ResolvedOwnerMcpServer } from '../../../mcp-servers.js'

/** Supplied by the authenticated project transport, never by MCP request params. */
export interface ApprovedMcpContext {
  projectId: string
  sessionId: string
  threadId: string
  generation: string
  leaseId: string
  phase: 'prepared' | 'active'
  idle: boolean
}

export interface ApprovedMcpServerMetadata {
  name: string
  capabilities: ServerCapabilities
  serverInfo: Implementation
  instructions?: string
  /** Preparation-time discovery pages, safe to serve locally before native start. */
  catalog: Array<{ method: string; params?: { cursor: string }; result: Result }>
}

export interface ApprovedMcpBrokerOptions {
  currentContext(): ApprovedMcpContext | null
  /** Reserved explicit owner lease plus native idle, before submitting its turn. */
  assertOwnerPreparation(context: ApprovedMcpContext): void
  /** Live coordinator authority: owner-facing lease only, never a restricted build. */
  assertOwnerConversation(context: ApprovedMcpContext): void
  /** The existing approval-store intersection, scoped to this project's owner. */
  resolveApproved(context: ApprovedMcpContext): Promise<readonly ResolvedOwnerMcpServer[]>
  onNotification?(context: ApprovedMcpContext, serverName: string, notification: Notification,
    consumerIds?: readonly string[]): Promise<void>
  /** Downstream routing must retire with the exact approved subprocess surface. */
  onRetired?(): void
  onServerRetired?(name: string): void
  connectTimeoutMs?: number
  requestTimeoutMs?: number
}

interface Binding {
  context: ApprovedMcpContext
  fingerprint: string
  serverFingerprints: Map<string, string>
  clients: Map<string, Client>
  metadata: ApprovedMcpServerMetadata[]
  consumers: Map<string, Consumer>
  subscriptions: Map<string, Map<string, Subscription>>
  subscriptionTail: Promise<void>
  retirement?: Promise<void>
}

interface Consumer { id: string; server: string; closed: boolean; abort: AbortController }
interface Subscription { consumers: Set<Consumer>; upstream: boolean; confirmed: boolean }

export interface ApprovedMcpRequestHooks {
  /** An authenticated downstream MCP session identity, never a model argument. */
  consumerId: string
  onProgress?(progress: Progress): Promise<void>
}

const FORWARDED_METHODS = new Set([
  'ping', 'tools/list', 'tools/call', 'resources/list', 'resources/templates/list',
  'resources/read', 'resources/subscribe', 'resources/unsubscribe',
  'prompts/list', 'prompts/get', 'completion/complete', 'logging/setLevel',
  'tasks/get', 'tasks/list', 'tasks/result', 'tasks/cancel',
])

function identity(context: ApprovedMcpContext): string {
  return JSON.stringify([context.projectId, context.sessionId, context.threadId, context.generation])
}

function refused(): Error { return new Error('Installed MCP binding is unavailable or changed') }

/** Include the FULL spec AND values; approval's grant hash intentionally excludes values. */
function snapshot(servers: readonly ResolvedOwnerMcpServer[]): { servers: ResolvedOwnerMcpServer[]; fingerprint: string } {
  const names = new Set<string>()
  const copied = servers.map((server) => {
    const parsed = parseOwnerMcpServerInput(server)
    if (!parsed.spec || parsed.errors.length || names.has(server.name)
      || JSON.stringify([...server.env_names].sort()) !== JSON.stringify(Object.keys(server.env).sort())) throw refused()
    names.add(server.name)
    return { ...server, args: [...server.args], env_names: [...server.env_names], env: { ...server.env } }
  }).sort((a, b) => a.name.localeCompare(b.name))
  const canonical = copied.map((server) => [server.name, server.command, server.args,
    [...server.env_names].sort(), Object.entries(server.env).sort(([a], [b]) => a.localeCompare(b))])
  return { servers: copied, fingerprint: createHash('sha256').update(JSON.stringify(canonical)).digest('hex') }
}

function declaredEnvironment(server: ResolvedOwnerMcpServer): Record<string, string> {
  // SDK stdio merges these defaults even when env is supplied. Node/cross-spawn
  // omit undefined values; mask those defaults, then overlay only approved names.
  // The SDK's env type does not express unset, hence this boundary-local cast.
  const env: Record<string, string | undefined> = {}
  for (const name of DEFAULT_INHERITED_ENV_VARS) env[name] = undefined
  for (const name of server.env_names) env[name] = server.env[name]
  return env as Record<string, string>
}

/**
 * Host-memory-only SDK connections. The project transport owns authentication,
 * native MCP initialization and routing; this broker never owns credentials,
 * registry rows, native configuration, or the project process.
 */
export class ApprovedMcpBroker {
  private binding: Binding | null = null
  private pending: Binding | null = null
  private closed = false
  private inFlight = 0
  private admitting = false
  private retiring: Promise<void> = Promise.resolve()
  private reconciling = 0

  constructor(private readonly options: ApprovedMcpBrokerOptions) {}

  /** Store-triggered retirement needs no active turn and never starts a peer. */
  async retireRevoked(): Promise<void> {
    this.reconciling++
    try {
      for (const binding of new Set([this.binding, this.pending])) {
        if (!binding) continue
        let live: ReturnType<typeof snapshot>
        try { live = snapshot(await this.options.resolveApproved({ ...binding.context })) }
        catch { await this.dispose(binding); continue }
        if (this.binding !== binding && this.pending !== binding) continue
        const approved = new Map(live.servers.map(server => [server.name, snapshot([server]).fingerprint]))
        // Fence the entire reserved admission set, including candidates that
        // have not spawned while another peer's handshake is awaiting IO.
        for (const [name, fingerprint] of binding.serverFingerprints) {
          if (approved.get(name) !== fingerprint) binding.serverFingerprints.delete(name)
        }
        const closing: Promise<void>[] = []
        for (const [name, client] of binding.clients) {
          if (approved.has(name) && approved.get(name) === binding.serverFingerprints.get(name)) continue
          binding.clients.delete(name)
          binding.serverFingerprints.delete(name)
          binding.metadata = binding.metadata.filter(entry => entry.name !== name)
          binding.subscriptions.delete(name)
          for (const [id, consumer] of binding.consumers) if (consumer.server === name) {
            consumer.closed = true; consumer.abort.abort(); binding.consumers.delete(id)
          }
          this.options.onServerRetired?.(name)
          closing.push(client.close().catch(() => {}))
        }
        // Record the checked approval surface, but admit missing peers only at
        // the next explicit idle owner preparation.
        binding.fingerprint = live.fingerprint
        await Promise.all(closing)
      }
    } finally { this.reconciling-- }
  }

  private requireScope(context: ApprovedMcpContext, idle = false): void {
    const current = this.options.currentContext()
    if (this.closed || !current || context.phase !== 'active' || current.phase !== 'active'
      || identity(context) !== identity(current) || context.leaseId !== current.leaseId
      || (idle && (!context.idle || !current.idle))) throw refused()
  }

  private requireContext(context: ApprovedMcpContext, idle = false): void {
    this.requireScope(context, idle)
    if (idle) this.options.assertOwnerPreparation({ ...context })
    else this.options.assertOwnerConversation({ ...context })
  }

  private async dispose(binding: Binding): Promise<void> {
    if (binding.retirement) return binding.retirement
    if (this.binding === binding) this.binding = null
    if (this.pending === binding) this.pending = null
    // Install the shared retirement promise before closing clients: SDK onclose
    // may re-enter disposal. Retirement is immediate, cleanup is awaited once.
    binding.retirement = Promise.resolve().then(async () => {
      for (const consumer of binding.consumers.values()) { consumer.closed = true; consumer.abort.abort() }
      binding.consumers.clear()
      binding.subscriptions.clear()
      await Promise.all([...binding.clients.values()].map(async (client) => {
        try { await client.close() } catch { /* Only this broker's owned client is closed. */ }
      }))
    })
    this.retiring = Promise.all([this.retiring, binding.retirement]).then(() => {})
    this.options.onRetired?.()
    return binding.retirement
  }

  private async verify(binding: Binding, context: ApprovedMcpContext, idle = false): Promise<void> {
    try {
      this.requireContext(context, idle)
      if (identity(context) !== identity(binding.context)) throw refused()
      const live = snapshot(await this.options.resolveApproved({ ...context }))
      this.requireContext(context, idle)
      if (live.fingerprint !== binding.fingerprint
        || (this.binding !== binding && this.pending !== binding)) throw refused()
    } catch {
      await this.dispose(binding)
      throw refused()
    }
  }

  private async notificationSurfaceCurrent(binding: Binding): Promise<boolean> {
    if (this.binding !== binding) return false
    // An idle owner lease cannot RECEIVE a notification. That is not itself a
    // revocation of this approved warm subprocess. Validate stable surface first.
    try {
      const current = this.options.currentContext()
      if (!current || current.phase !== 'active' || identity(current) !== identity(binding.context)) throw refused()
      const live = snapshot(await this.options.resolveApproved({ ...current }))
      const latest = this.options.currentContext()
      if (!latest || latest.phase !== 'active' || identity(latest) !== identity(binding.context)
        || live.fingerprint !== binding.fingerprint || this.binding !== binding) throw refused()
    } catch {
      await this.dispose(binding)
      return false
    }
    return true
  }

  private async notify(binding: Binding, serverName: string, client: Client, notification: Notification): Promise<void> {
    if (!await this.notificationSurfaceCurrent(binding) || binding.clients.get(serverName) !== client) return
    try {
      this.requireContext(binding.context)
      let consumers: string[] | undefined
      if (notification.method === 'notifications/resources/updated') {
        const uri = notification.params?.uri
        if (typeof uri !== 'string') return
        consumers = [...(binding.subscriptions.get(serverName)?.get(uri)?.consumers ?? [])]
          .filter((consumer) => !consumer.closed).map((consumer) => consumer.id)
        if (!consumers.length) return
      }
      await this.options.onNotification?.({ ...binding.context }, serverName, notification, consumers)
    } catch { /* No current owner recipient: drop, preserving the approved warm peer. */ }
  }

  /** Explicit idle admission. Requests never acquire new grants or respawn clients. */
  async bind(context: ApprovedMcpContext, signal?: AbortSignal): Promise<readonly ApprovedMcpServerMetadata[]> {
    context = { ...context }
    this.requireContext(context, true)
    signal?.throwIfAborted()
    if (this.admitting || this.inFlight || this.reconciling) throw refused()
    this.admitting = true
    try {
      return await this.admit(context, signal)
    } finally { this.admitting = false }
  }

  private async admit(context: ApprovedMcpContext, signal?: AbortSignal): Promise<readonly ApprovedMcpServerMetadata[]> {
    await this.retiring
    this.requireContext(context, true)
    signal?.throwIfAborted()
    if (this.binding) {
      const previous = this.binding
      try {
        const live = snapshot(await this.options.resolveApproved({ ...context }))
        this.requireContext(context, true)
        signal?.throwIfAborted()
        if (this.binding !== previous || identity(context) !== identity(previous.context)) throw refused()
        if (live.fingerprint === previous.fingerprint && live.servers.every(server => previous.clients.has(server.name))) {
          await this.reconcileOrphans(previous, context, signal)
          await this.verify(previous, context, true)
          previous.context = { ...context }
          return structuredClone(previous.metadata)
        }
        // This explicit, idle owner admission may replace grants. An ordinary
        // operation only retires a changed binding and NEVER takes this path.
        if (live.fingerprint !== previous.fingerprint) await this.dispose(previous)
        this.requireContext(context, true)
        signal?.throwIfAborted()
      } catch {
        await this.dispose(previous)
        throw refused()
      }
    }
    // Reserve before the first asynchronous authority read, excluding parallel binds.
    const binding: Binding = this.binding ?? { context: { ...context }, fingerprint: '', serverFingerprints: new Map(), clients: new Map(), metadata: [],
      consumers: new Map(), subscriptions: new Map(), subscriptionTail: Promise.resolve() }
    this.pending = binding
    try {
      const approved = snapshot(await this.options.resolveApproved({ ...context }))
      this.requireContext(context, true)
      signal?.throwIfAborted()
      if (this.pending !== binding) throw refused()
      binding.fingerprint = approved.fingerprint
      for (const server of approved.servers) binding.serverFingerprints.set(server.name, snapshot([server]).fingerprint)
      for (const server of approved.servers) {
        if (binding.clients.has(server.name)) continue
        await this.verify(binding, context, true)
        signal?.throwIfAborted()
        if (binding.serverFingerprints.get(server.name) !== snapshot([server]).fingerprint) continue
        const client = new Client({ name: 'neutron-approved-mcp-broker', version: '1.0.0' }, { capabilities: {} })
        const transport = new StdioClientTransport({ command: server.command, args: [...server.args],
          env: declaredEnvironment(server), stderr: 'pipe' })
        // Never log provider stderr: installed programs may print credentials.
        transport.stderr?.on('data', () => {})
        binding.clients.set(server.name, client)
        binding.serverFingerprints.set(server.name, snapshot([server]).fingerprint)
        client.onclose = () => { if (binding.clients.get(server.name) === client) this.dispose(binding).catch(() => {}) }
        client.fallbackNotificationHandler = async (notification) => {
          if (binding.clients.get(server.name) === client) await this.notify(binding, server.name, client, notification)
        }
        await client.connect(transport, { ...(signal ? { signal } : {}), timeout: this.options.connectTimeoutMs ?? 10_000 })
        await this.verify(binding, context, true)
        signal?.throwIfAborted()
        const capabilities = client.getServerCapabilities()
        const serverInfo = client.getServerVersion()
        if (!capabilities || !serverInfo) throw refused()
        const instructions = client.getInstructions()
        const catalog: ApprovedMcpServerMetadata['catalog'] = []
        const methods = [
          ...(capabilities.tools ? ['tools/list'] : []),
          ...(capabilities.resources ? ['resources/list', 'resources/templates/list'] : []),
          ...(capabilities.prompts ? ['prompts/list'] : []),
        ]
        for (const method of methods) {
          let cursor: string | undefined
          const seen = new Set<string>()
          do {
            const params = cursor === undefined ? {} : { params: { cursor } }
            await this.verify(binding, context, true)
            signal?.throwIfAborted()
            const result = await client.request(ClientRequestSchema.parse({ method, ...params }), ResultSchema,
              { ...(signal ? { signal } : {}), timeout: this.options.requestTimeoutMs ?? 60_000 })
            await this.verify(binding, context, true)
            signal?.throwIfAborted()
            catalog.push({ method, ...params, result })
            if (result.nextCursor !== undefined && typeof result.nextCursor !== 'string') throw refused()
            cursor = result.nextCursor as string | undefined
            if (cursor !== undefined) {
              if (seen.has(cursor)) throw refused()
              seen.add(cursor)
            }
          } while (cursor !== undefined)
        }
        binding.metadata.push({ name: server.name, capabilities, serverInfo,
          ...(instructions === undefined ? {} : { instructions }), catalog })
      }
      await this.verify(binding, context, true)
      signal?.throwIfAborted()
      this.pending = null
      binding.context = { ...context }
      this.binding = binding
      return structuredClone(binding.metadata)
    } catch {
      await this.dispose(binding)
      throw refused()
    }
  }

  async request(context: ApprovedMcpContext, serverName: string,
    request: { method: string; params?: Record<string, unknown> }, signal?: AbortSignal,
    hooks?: ApprovedMcpRequestHooks): Promise<Result> {
    context = { ...context }
    hooks = hooks ? { ...hooks } : undefined
    this.requireContext(context)
    signal?.throwIfAborted()
    if (!FORWARDED_METHODS.has(request.method)) throw new Error('Unsupported installed MCP request')
    const parsed = ClientRequestSchema.safeParse(request)
    if (!parsed.success) throw new Error('Invalid installed MCP request')
    const binding = this.binding
    const client = binding?.clients.get(serverName)
    if (!binding || !client) throw refused()
    const subscription = request.method === 'resources/subscribe' || request.method === 'resources/unsubscribe'
    const subscriptionUri = (parsed.data.params as Record<string, unknown> | undefined)?.uri as string
    if ((subscription && !hooks?.consumerId) || (hooks && !hooks.consumerId)) throw new Error('Installed MCP consumer identity is required')
    let consumer: Consumer | undefined
    if (hooks) {
      consumer = binding.consumers.get(hooks.consumerId)
      if (!consumer) {
        consumer = { id: hooks.consumerId, server: serverName, closed: false, abort: new AbortController() }
        binding.consumers.set(consumer.id, consumer)
      }
      signal = AbortSignal.any([consumer.abort.signal, ...(signal ? [signal] : [])])
    }
    const requestSignal = signal
    const perform = async (): Promise<Result> => {
      await this.verify(binding, context)
      if (binding.clients.get(serverName) !== client) throw refused()
      requestSignal?.throwIfAborted()
      const result = await client.request(parsed.data, ResultSchema, {
        ...(requestSignal ? { signal: requestSignal } : {}), timeout: this.options.requestTimeoutMs ?? 60_000,
        ...(hooks?.onProgress ? { onprogress: (progress: Progress) => {
          this.deliverProgress(binding, context, progress, hooks, requestSignal).catch(() => {})
        } } : {}),
      })
      await this.verify(binding, context)
      if (binding.clients.get(serverName) !== client) throw refused()
      requestSignal?.throwIfAborted()
      return result
    }
    this.inFlight++
    try {
      if (!subscription) return await perform()
      const previous = binding.subscriptionTail
      let unlock!: () => void
      binding.subscriptionTail = new Promise<void>((resolve) => { unlock = resolve })
      try {
        await previous
        await this.verify(binding, context)
        requestSignal?.throwIfAborted()
        return await this.changeSubscription(binding, serverName, parsed.data.method,
          subscriptionUri, consumer!, perform)
      } finally { unlock() }
    } catch {
      // Do not leak arbitrary child error text (which may include credentials).
      throw new Error('Installed MCP request failed or its binding changed')
    } finally { this.inFlight-- }
  }

  private async deliverProgress(binding: Binding, context: ApprovedMcpContext, progress: Progress,
    hooks: ApprovedMcpRequestHooks, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted || !await this.notificationSurfaceCurrent(binding)) return
    try {
      this.requireContext(context)
      signal?.throwIfAborted()
      await hooks.onProgress?.(progress)
    } catch { /* A settled/cancelled predecessor has no recipient in the successor turn. */ }
  }

  private async changeSubscription(binding: Binding, server: string, method: string, uri: string,
    consumer: Consumer, perform: () => Promise<Result>): Promise<Result> {
    if (consumer.closed) throw refused()
    let resources = binding.subscriptions.get(server)
    if (!resources) { resources = new Map(); binding.subscriptions.set(server, resources) }
    let subscription = resources.get(uri)
    if (method === 'resources/subscribe') {
      if (!subscription) { subscription = { consumers: new Set(), upstream: false, confirmed: false }; resources.set(uri, subscription) }
      if (subscription.consumers.has(consumer)) return {}
      if (subscription.upstream && !subscription.confirmed) throw refused()
      subscription.consumers.add(consumer)
      if (subscription.upstream) return {}
      // Once sent, cancellation cannot prove the peer did not subscribe. Keep an
      // orphan to reconcile at the next explicit owner preparation if it fails.
      subscription.upstream = true
      try {
        const result = await perform()
        subscription.confirmed = true
        return result
      }
      catch (error) { subscription.consumers.delete(consumer); throw error }
    }
    if (!subscription?.consumers.delete(consumer) || subscription.consumers.size) return {}
    if (subscription.upstream) {
      // The peer may unsubscribe even when cancellation or a changed lease makes
      // its result unacceptable. Never lend that uncertain subscription onward.
      subscription.confirmed = false
      const result = await perform()
      resources.delete(uri)
      return result
    }
    resources.delete(uri)
    return {}
  }

  /** Local cleanup is permitted while idle; it never issues an upstream operation. */
  async releaseConsumer(context: ApprovedMcpContext, consumerId: string): Promise<void> {
    context = { ...context }
    this.requireScope(context)
    const binding = this.binding
    if (!binding || identity(binding.context) !== identity(context)) throw refused()
    const consumer = binding.consumers.get(consumerId)
    if (!consumer) return
    consumer.closed = true
    consumer.abort.abort()
    binding.consumers.delete(consumerId)
    for (const resources of binding.subscriptions.values()) {
      for (const subscription of resources.values()) subscription.consumers.delete(consumer)
    }
    // No tombstone registry: queued calls retain the closed Consumer object.
    // Orphans are bounded by already-owned upstream URIs, not by DELETE traffic.
  }

  private async reconcileOrphans(binding: Binding, context: ApprovedMcpContext, signal?: AbortSignal): Promise<void> {
    for (const [server, resources] of binding.subscriptions) {
      for (const [uri, subscription] of resources) {
        if (subscription.consumers.size || !subscription.upstream) continue
        await this.verify(binding, context, true)
        signal?.throwIfAborted()
        await binding.clients.get(server)!.request({ method: 'resources/unsubscribe', params: { uri } }, ResultSchema,
          { ...(signal ? { signal } : {}), timeout: this.options.requestTimeoutMs ?? 60_000 })
        await this.verify(binding, context, true)
        signal?.throwIfAborted()
        resources.delete(uri)
      }
    }
  }

  /** Revalidated local discovery only; never sends a request to an installed peer. */
  async preparedMetadata(context: ApprovedMcpContext): Promise<readonly ApprovedMcpServerMetadata[]> {
    context = { ...context }
    this.requireContext(context, true)
    const binding = this.binding
    if (!binding) throw refused()
    await this.verify(binding, context, true)
    return structuredClone(binding.metadata)
  }

  /** Execution-time handshake/notification metadata, with no artificial upstream ping. */
  async activeMetadata(context: ApprovedMcpContext): Promise<readonly ApprovedMcpServerMetadata[]> {
    context = { ...context }
    this.requireContext(context)
    const binding = this.binding
    if (!binding) throw refused()
    await this.verify(binding, context)
    return structuredClone(binding.metadata)
  }

  async close(): Promise<void> {
    this.closed = true
    const owned = new Set([this.binding, this.pending])
    await Promise.all([...owned].map(async (binding) => { if (binding) await this.dispose(binding) }))
    await this.retiring
  }
}
