import { chmodSync, lstatSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import type { ServerWebSocket } from 'bun'
import { fireAndForget } from '@neutronai/logger/fire-and-forget.ts'
import { BROKER_MAX_MESSAGE_BYTES, type ProjectControlTransport } from './project-control-broker-transport.ts'
import { validateProjectControlScope } from './project-control-broker-scope.ts'
import { openProjectControlJournal } from './project-control-broker-journal.ts'
import { createReviewPermissionTransaction, type ReviewPermissionLease, type ReviewPermissionRequest } from './project-review-permissions.ts'
import { inspectNativeRetirement, type PreparedNativeRetirement, type NativeOwnerRetirement } from './project-control-retirement.ts'
export type { PreparedNativeRetirement, NativeOwnerRetirement } from './project-control-retirement.ts'

type Rpc = Record<string, unknown>
type Id = string | number
const object = (value: unknown): value is Rpc => typeof value === 'object' && value !== null && !Array.isArray(value)
const id = (value: unknown): value is Id => typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value))
const READS = new Set(['account/read', 'model/list', 'config/read', 'configRequirements/read', 'collaborationMode/list',
  'hooks/list', 'skills/list', 'plugin/list', 'thread/read', 'thread/turns/list', 'thread/items/list',
  'thread/loaded/list', 'thread/list', 'thread/goal/get'])
const MUTATIONS = new Set(['thread/resume', 'turn/start', 'thread/settings/update', 'config/batchWrite', 'turn/interrupt'])
const APPROVALS = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval',
  'item/permissions/requestApproval', 'item/tool/requestUserInput', 'mcpServer/elicitation/request', 'item/tool/call'])
export function classifyProjectControlMethod(method: string): 'read' | 'mutation' | 'refuse' {
  return READS.has(method) ? 'read' : MUTATIONS.has(method) ? 'mutation' : 'refuse'
}

export class ProjectControlRefusal extends Error {
  readonly code = -32001
}
/** A local gateway refusal before journal reservation or native delivery. */
export class ProjectControlAdmissionRefusal extends ProjectControlRefusal {}
/** This review attempt was refused before any reservation, journal or native mutation. */
export class ReviewPermissionBusy extends ProjectControlRefusal {}
export interface ProjectControlState {
  generation: number
  epoch: number
  phase: 'idle' | 'mutation' | 'turn' | 'recovery' | 'closed'
  activeTurnId: string | null
  unresolved: string | null
}
export interface ProjectControlGateway {
  request(method: string, params: Rpc, expectedEpoch?: number): Promise<unknown>
  reply(requestId: Id, result: unknown, expectedEpoch: number): void
  subscribe(listener: (message: Rpc) => void): () => void
  close(): void
}
export interface ProjectControlBroker {
  state(): ProjectControlState
  gateway(clientId: string): ProjectControlGateway
  /** Host-only exact-stage transaction; never exposed through the control socket. */
  reviewPermissions?(request: ReviewPermissionRequest, expectedEpoch: number): Promise<ReviewPermissionLease>
  prepareRetirement?(expectedEpoch: number): Promise<PreparedNativeRetirement>
  close(): void
}
type Client = { name: string; initialized: boolean; emit(message: Rpc): void; closed: boolean }
type Work = { client: Client; method: string; params: Rpc; epoch: number; resolve(value: unknown): void; reject(error: Error): void }

/** Bounded transport/fencing primitive, not a project lifecycle manager.
 * One project-specific child must be supplied. A timeout closes the broker because
 * a lost acknowledgement cannot prove a mutation did not execute upstream.
 */
export async function createProjectControlBroker(options: {
  socketPath: string
  threadId: string
  cwd: string
  codexHome: string
  upstream: ProjectControlTransport
  requestTimeoutMs?: number
}): Promise<ProjectControlBroker & { reviewPermissions(request: ReviewPermissionRequest, expectedEpoch: number): Promise<ReviewPermissionLease>; prepareRetirement(expectedEpoch: number): Promise<PreparedNativeRetirement> }> {
  const { upstream } = options
  let upstreamClosed = false
  const closeUpstream = (): void => {
    if (upstreamClosed) return
    upstreamClosed = true
    upstream.close()
  }
  const timeout = options.requestTimeoutMs ?? 10_000
  try {
    if (!Number.isFinite(timeout) || timeout <= 0 || !options.threadId || !isAbsolute(options.socketPath)
      || !isAbsolute(options.cwd) || !isAbsolute(options.codexHome)) throw new Error('Invalid broker binding')
    const parent = lstatSync(dirname(options.socketPath))
    if (!parent.isDirectory() || (parent.mode & 0o077) !== 0 || parent.uid !== process.getuid?.()
      || realpathSync(dirname(options.socketPath)) !== dirname(options.socketPath)) throw new Error('Broker socket needs a private owned directory')
  } catch (error) { closeUpstream(); throw error }
  let journal: ReturnType<typeof openProjectControlJournal>
  try { journal = openProjectControlJournal(options) } catch (error) { closeUpstream(); throw error }
  const clients = new Set<Client>()
  const sockets = new Set<ServerWebSocket<{ client: Client }>>()
  const pending = new Map<string, { method: string; resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()
  const approvals = new Map<Id, { client: Client; epoch: number }>()
  const queue: Work[] = []
  let epoch = journal.epoch
  let sequence = 0
  let closed: Error | undefined
  let current: Work | undefined
  let active: { client: Client; epoch: number; turnId: string | null; completed: boolean } | undefined
  let review: ReturnType<typeof createReviewPermissionTransaction> | undefined
  let retirement: object | undefined
  let retiringProcess = false
  let nativeRevision = 0
  const observedThreads = new Set<string>()
  let server: ReturnType<typeof Bun.serve<{ client: Client }>> | undefined
  const refusal = (message: string): ProjectControlRefusal => new ProjectControlRefusal(message)
  const admissionRefusal = (message: string): ProjectControlAdmissionRefusal => new ProjectControlAdmissionRefusal(message)
  const close = (error = new Error('Project broker closed')): void => {
    if (closed) return
    closed = error
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error) }
    pending.clear()
    for (const work of queue.splice(0)) work.reject(error)
    approvals.clear()
    for (const socket of sockets) socket.close(1011, 'Project broker closed')
    server?.stop(true)
    closeUpstream()
    journal.close()
  }
  const send = (message: Rpc): void => {
    if (closed) throw closed
    try {
      journal.assertOwned()
      if (typeof message.method === 'string' && classifyProjectControlMethod(message.method) === 'mutation') journal.record(message.method)
      upstream.send(message)
    } catch { close(new Error('Native transport or broker generation failed')); throw closed }
  }
  const native = (method: string, params: Rpc, censusRead = false): Promise<unknown> => {
    if (closed) return Promise.reject(closed)
    if (pending.size >= 128) return Promise.reject(refusal('Too many pending requests'))
    const requestId = `broker-${++sequence}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (censusRead) {
          pending.delete(requestId)
          reject(new Error('Native retirement census deadline expired; liveness unknown'))
        } else close(new Error('Native response deadline expired; mutation outcome unknown'))
      }, timeout)
      pending.set(requestId, { method, resolve, reject, timer })
      try { send({ id: requestId, method, params }) } catch (error) { reject(error as Error) }
    })
  }
  const releaseCompletedTurn = (): void => {
    if (active?.completed && !current && !closed) {
      active = undefined; approvals.clear()
      try { journal.settle() } catch { close(new Error('Broker journal settlement failed; outcome unknown')) }
    }
  }
  try { upstream.listen(raw => {
    if (closed) return
    try { journal.assertOwned() } catch { close(new Error('Stale broker generation')); return }
    if (!object(raw)) { close(new Error('Invalid native envelope')); return }
    review?.observe(raw)
    if (typeof raw.method !== 'string') {
      if (typeof raw.id !== 'string') return
      const entry = pending.get(raw.id)
      if (!entry) return
      pending.delete(raw.id)
      clearTimeout(entry.timer)
      if (object(raw.error)) entry.reject(refusal(`Native ${entry.method} refused`))
      else if ('result' in raw) entry.resolve(raw.result)
      else { const error = new Error('Invalid native response'); entry.reject(error); close(error) }
      return
    }
    const params = object(raw.params) ? raw.params : {}
    // Include child/global notifications before project filtering. Any native
    // activity invalidates an in-flight census, including an unseen child.
    nativeRevision++
    if (review && id(raw.id)) {
      send({ id: raw.id, error: { code: -32001, message: 'Review permission lease forbids approvals' } }); return
    }
    const threadId = params.threadId ?? (object(params.thread) ? params.thread.id : undefined)
    if (typeof threadId === 'string') observedThreads.add(threadId)
    if (object(params.item) && params.item.type === 'subAgentActivity' && typeof params.item.agentThreadId === 'string') observedThreads.add(params.item.agentThreadId)
    if (threadId !== undefined && threadId !== options.threadId) {
      // Native children may inherit the fixed tool declaration, never its grant.
      // Reject requests explicitly so a child cannot hang awaiting an owner tool.
      if (id(raw.id)) send({ id: raw.id, error: { code: -32001, message: 'No matching project turn owner' } })
      return
    }
    if (params.threadId !== undefined && object(params.thread) && params.thread.id !== undefined && params.thread.id !== params.threadId) return
    if (id(raw.id)) {
      if (!APPROVALS.has(raw.method) || threadId !== options.threadId || !active || active.client.closed
        || typeof params.turnId !== 'string' || params.turnId !== active.turnId) {
        send({ id: raw.id, error: { code: -32001, message: 'No matching project turn owner' } }); return
      }
      approvals.set(raw.id, { client: active.client, epoch: active.epoch })
      active.client.emit(raw)
      return
    }
    if (threadId === options.threadId && object(params.turn) && typeof params.turn.id === 'string' && active) {
      if (raw.method === 'turn/started' && active.turnId === null) active.turnId = params.turn.id
      if (raw.method === 'turn/completed' && active.turnId === params.turn.id) {
        active.completed = true
        releaseCompletedTurn()
        queueMicrotask(pump)
      }
    }
    // Project events only. Unknown global notifications are not a cross-project feed.
    if (threadId === options.threadId) for (const client of clients) if (client.initialized && !client.closed) client.emit(raw)
  }, error => { if (!retiringProcess) close(error) }) } catch (error) { close(); throw error }

  let initialized: unknown
  try {
    initialized = await native('initialize', { clientInfo: { name: 'neutron-project-broker', version: '1' },
      capabilities: { experimentalApi: true, requestAttestation: false } })
    send({ method: 'initialized' })
  } catch (error) { close(); throw error }

  const validate = (method: string, params: Rpc): void => {
    if (classifyProjectControlMethod(method) === 'refuse') throw refusal('Unclassified project RPC refused')
    if (method.startsWith('thread/') && !['thread/list', 'thread/loaded/list'].includes(method) || method.startsWith('turn/')) {
      if (params.threadId !== options.threadId) throw refusal('Exact project thread required')
    }
    validateProjectControlScope(method, params, options.cwd, refusal)
    if (method === 'thread/resume' && (params.path != null || params.history != null)) throw refusal('Thread replacement refused')
    if (method === 'thread/resume' && params.config != null && (!object(params.config)
      || Object.keys(params.config).some(key => !['personality', 'web_search'].includes(key)))) throw refusal('Unclassified resume config refused')
    if (method === 'config/read' && params.filePath != null && params.filePath !== join(options.codexHome, 'config.toml')) throw refusal('Foreign config refused')
    if (method === 'config/batchWrite') {
      if (params.filePath != null && params.filePath !== join(options.codexHome, 'config.toml')) throw refusal('Foreign config refused')
      if (!Array.isArray(params.edits) || !params.edits.length || params.edits.some(edit => !object(edit)
        || !['model', 'model_reasoning_effort'].includes(String(edit.keyPath)) || edit.mergeStrategy !== 'replace'
        || (edit.value !== null && typeof edit.value !== 'string'))) throw refusal('Unclassified config mutation refused')
    }
  }
  const filter = (method: string, result: unknown): unknown => {
    if (object(result) && Array.isArray(result.data) && ['thread/list', 'thread/loaded/list'].includes(method)) {
      return { ...result, data: result.data.filter(value => value === options.threadId || object(value) && value.id === options.threadId), nextCursor: null }
    }
    return result
  }
  const pump = (): void => {
    if (closed || current || active) return
    const work = queue.shift()
    if (!work) return
    current = work
    if (work.method === 'turn/start') active = { client: work.client, epoch: work.epoch, turnId: null, completed: false }
    const settleCurrent = (): void => {
      current = undefined
      releaseCompletedTurn()
      if (!closed && !active) {
        try { journal.settle() } catch { close(new Error('Broker journal settlement failed; outcome unknown')) }
      }
    }
    fireAndForget('codex-cli.project-control-broker.mutation', native(work.method, work.params).then(result => {
      if (work.method === 'turn/start') {
        if (!object(result) || !object(result.turn) || typeof result.turn.id !== 'string' || !active
          || active.turnId !== null && active.turnId !== result.turn.id) { close(new Error('Native turn identity unknown')); work.reject(closed!); return }
        active.turnId = result.turn.id
      }
      // A fulfilled caller may close immediately. Commit settlement before
      // publishing the acknowledgement; active turns retain their marker.
      settleCurrent()
      if (closed) work.reject(closed)
      else work.resolve(result)
      pump()
    }), error => {
      if (work.method === 'turn/start') {
        if (active && active.turnId !== null) close(new Error('Native turn started before refusal; outcome unknown'))
        else active = undefined
      }
      settleCurrent()
      work.reject(closed ?? error as Error)
      pump()
    })
  }
  const request = (client: Client, method: string, params: Rpc, expectedEpoch?: number): Promise<unknown> => {
    try {
      if (closed || client.closed) throw closed ?? refusal('Client closed')
      if (retirement) throw admissionRefusal('Project writer busy with native retirement')
      params = structuredClone(params)
      validate(method, params)
      if (classifyProjectControlMethod(method) === 'read') return native(method, params).then(result => filter(method, result))
      if (review) throw admissionRefusal('Project writer busy with native review permissions')
      if (journal.unresolved !== null) throw admissionRefusal('Prior broker mutation unresolved; recovery inspection required')
      if (expectedEpoch !== undefined && expectedEpoch !== epoch) throw admissionRefusal('Stale broker epoch')
      if (method === 'turn/interrupt') {
        if (!active || active.client !== client || active.turnId === null || params.turnId !== active.turnId) throw refusal('Exact active turn owner required')
        return native(method, params)
      }
      if (active || current && current.client !== client || queue.some(work => work.client !== client)) throw admissionRefusal('Project writer busy')
      if (queue.length >= 32) throw admissionRefusal('Project mutation queue full')
      const reserved = epoch = journal.reserve()
      return new Promise((resolve, reject) => { queue.push({ client, method, params, epoch: reserved, resolve, reject }); pump() })
    } catch (error) { return Promise.reject(error) }
  }
  const reply = (client: Client, requestId: Id, result: unknown, expectedEpoch?: number): void => {
    if (retirement) throw admissionRefusal('Project writer busy with native retirement')
    const approval = approvals.get(requestId)
    if (!approval || approval.client !== client || client.closed || !active || active.epoch !== approval.epoch
      || expectedEpoch !== undefined && expectedEpoch !== epoch) throw refusal('Stale or foreign approval reply')
    approvals.delete(requestId)
    send({ id: requestId, result })
  }
  const detach = (client: Client): void => {
    client.closed = true
    clients.delete(client)
    for (let index = queue.length - 1; index >= 0; index--) if (queue[index]?.client === client) queue.splice(index, 1)[0]!.reject(refusal('Client disconnected'))
    for (const [requestId, approval] of approvals) if (approval.client === client) {
      approvals.delete(requestId)
      send({ id: requestId, error: { code: -32001, message: 'Project turn owner disconnected' } })
    }
    // An admitted native turn outlives a frontend disconnect; terminal evidence releases it.
  }
  try {
    server = Bun.serve<{ client: Client }>({
      unix: options.socketPath,
      fetch(req, instance) {
        if (new URL(req.url).pathname !== '/rpc' || req.headers.has('origin')) return new Response('Refused', { status: 403 })
        const client: Client = { name: `tui-${++sequence}`, initialized: false, closed: false, emit() {} }
        return instance.upgrade(req, { data: { client } }) ? undefined : new Response('WebSocket required', { status: 400 })
      },
      websocket: {
        maxPayloadLength: BROKER_MAX_MESSAGE_BYTES,
        open(socket) { sockets.add(socket); clients.add(socket.data.client); socket.data.client.emit = message => { socket.send(JSON.stringify(message)) } },
        message(socket, data) {
          const client = socket.data.client
          let raw: Rpc
          try { const value: unknown = JSON.parse(typeof data === 'string' ? data : data.toString()); if (!object(value)) throw new Error(); raw = value }
          catch { socket.close(1008, 'Invalid RPC'); return }
          const requestId = raw.id
          if (!id(requestId)) {
            if (raw.method !== 'initialized') socket.close(1008, 'Unclassified notification')
            return
          }
          const respondError = (error: unknown): void => client.emit({ id: requestId, error: { code: -32001, message: error instanceof ProjectControlRefusal ? error.message : 'Project broker unavailable' } })
          if (typeof raw.method !== 'string') {
            try { if (!('result' in raw) || 'error' in raw) throw refusal('Invalid approval reply'); reply(client, requestId, raw.result) } catch (error) { respondError(error) }
            return
          }
          if (raw.method === 'initialize') {
            if (client.initialized) { respondError(refusal('Already initialized')); return }
            client.initialized = true
            client.emit({ id: requestId, result: initialized })
            return
          }
          if (!client.initialized) { respondError(refusal('Not initialized')); return }
          if (raw.method === 'thread/unsubscribe') {
            if (!object(raw.params) || raw.params.threadId !== options.threadId) respondError(refusal('Exact project thread required'))
            else client.emit({ id: requestId, result: {} })
            return
          }
          fireAndForget('codex-cli.project-control-broker.response', request(client, raw.method, object(raw.params) ? raw.params : {}).then(result => client.emit({ id: requestId, result })), respondError)
        },
        close(socket) { sockets.delete(socket); detach(socket.data.client) },
      },
    })
    chmodSync(options.socketPath, 0o600)
    journal.bound()
  } catch (error) { close(); throw error }
  return {
    state: () => ({ generation: journal.generation, epoch, phase: closed ? 'closed' : journal.unresolved !== null ? 'recovery' : active ? 'turn' : retirement || review || current || queue.length ? 'mutation' : 'idle', activeTurnId: active?.turnId ?? null, unresolved: journal.unresolved }),
    async prepareRetirement(expectedEpoch) {
      if (closed || journal.unresolved !== null || expectedEpoch !== epoch) return { status: 'unknown', reason: 'Native owner generation is not current' }
      if (retirement || review || active || current || queue.length || pending.size || approvals.size) return { status: 'busy', reason: 'Native owner has admitted work' }
      if (!upstream.exited) return { status: 'unknown', reason: 'Native transport cannot prove process exit' }
      const token = retirement = {}
      const inspect = async () => {
        const revision = nativeRevision
        const result = await inspectNativeRetirement((method, params) => native(method, params, true), options.threadId, observedThreads)
        if (closed || retirement !== token) return { status: 'unknown' as const, reason: 'Native retirement lost its owner' }
        try { journal.assertOwned() } catch { return { status: 'unknown' as const, reason: 'Native retirement lost its generation' } }
        if (revision !== nativeRevision) return { status: 'busy' as const, reason: 'Native activity changed during retirement census' }
        return result
      }
      const observed = await inspect()
      if (observed.status !== 'idle') { if (retirement === token) retirement = undefined; return observed }
      const facts = { generation: journal.generation, epoch, threadId: options.threadId, rolloutPath: observed.rolloutPath }
      let consumed = false
      return { status: 'prepared', lease: { ...facts,
        abort() { if (!consumed && retirement === token) { consumed = true; retirement = undefined } },
        async retire(): Promise<NativeOwnerRetirement> {
          if (consumed || closed || retirement !== token) return { status: 'unknown', reason: 'Native retirement lease is no longer current' }
          consumed = true
          const final = await inspect()
          if (final.status !== 'idle') { if (retirement === token) retirement = undefined; return final }
          if (final.rolloutPath !== facts.rolloutPath) { retirement = undefined; return { status: 'unknown', reason: 'Native resume identity changed' } }
          try {
            journal.record('native-retirement')
            retiringProcess = true
            closeUpstream()
            let timer: ReturnType<typeof setTimeout> | undefined
            const exit = await Promise.race([upstream.exited!, new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error('Native process exit unconfirmed')), timeout)
            })]).finally(() => { if (timer) clearTimeout(timer) })
            if (closed || retirement !== token) throw new Error('Native retirement owner changed before exit')
            journal.assertOwned()
            journal.settle()
            close()
            return { status: 'retired', ...facts, exit }
          } catch (error) {
            close(new Error('Native retirement outcome unknown'))
            return { status: 'unknown', reason: error instanceof Error ? error.message : 'Native retirement failed' }
          }
        },
      } }
    },
    async reviewPermissions(request, expectedEpoch) {
      if (closed || retirement || review || active || current || queue.length || journal.unresolved !== null || expectedEpoch !== epoch) throw new ReviewPermissionBusy('Native review requires the idle current project writer')
      review = createReviewPermissionTransaction({ cwd: options.cwd, codexHome: options.codexHome, threadId: options.threadId, rpc: native,
        assertCurrent() { if (closed) throw closed; journal.assertOwned() },
        finish() { if (closed) throw closed; journal.assertOwned(); journal.settle(); review = undefined },
        fence() { close(new Error('Native review permissions unresolved; project owner fenced')) },
      }, structuredClone(request))
      try {
        epoch = journal.reserve()
        journal.record('review-permissions')
        return await review.prepare()
      } catch (error) { close(new Error('Native review permissions unresolved; project owner fenced')); throw error }
    },
    gateway(clientId) {
      if (closed || !clientId || [...clients].some(client => client.name === clientId)) throw refusal('Gateway identity unavailable')
      const listeners = new Set<(message: Rpc) => void>()
      const client: Client = { name: clientId, initialized: true, closed: false, emit: message => { for (const listener of listeners) listener(message) } }
      clients.add(client)
      return {
        request(method, params, expectedEpoch) {
          if (classifyProjectControlMethod(method) === 'mutation' && expectedEpoch === undefined) return Promise.reject(refusal('Gateway mutation requires broker epoch'))
          return request(client, method, params, expectedEpoch)
        },
        reply(requestId, result, expectedEpoch) { reply(client, requestId, result, expectedEpoch) },
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
        close() { detach(client); listeners.clear() },
      }
    },
    close,
  }
}
