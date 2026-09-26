import { randomBytes } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { fireAndForget } from '@neutronai/logger/fire-and-forget.ts'
import type { CodexOwnerBindingFacts, CodexOwnerRetirement } from './project-control-bootstrap.ts'
import { ProjectControlAdmissionRefusal, ReviewPermissionBusy, type ProjectControlBroker, type ProjectControlGateway, type ProjectControlState } from './project-control-broker.ts'
import { BROKER_MAX_MESSAGE_BYTES } from './project-control-broker-transport.ts'
import { exactFacts, object, readOwnerHelperDescriptor, socketIdentity, type Rpc } from './project-owner-helper-protocol.ts'
import { MAX_REVIEW_SETTLEMENT_WAIT_MS, type ReviewPermissionLease, type ReviewPermissionRequest } from './project-review-permissions.ts'

/** A lost response body is an unknown request outcome, just like a lost socket. */
export async function decodeOwnerHelperResponse(response: Response, fail: (error: Error) => void): Promise<Rpc> {
  try {
    const text = await response.text()
    if (Buffer.byteLength(text) > BROKER_MAX_MESSAGE_BYTES * 2) throw new Error('Oversized owner helper response')
    const raw: unknown = JSON.parse(text)
    if (!object(raw)) throw new Error('Invalid owner helper response')
    return raw
  } catch {
    const error = new Error('Owner helper response lost or invalid; request outcome may be unknown')
    fail(error); throw error
  }
}

/** Disk supplies a locator; only the authenticated live helper supplies authority. */
export async function connectCodexOwnerHelper(options: { descriptorPath: string; expected: CodexOwnerBindingFacts; timeoutMs?: number }) {
  const timeout = options.timeoutMs ?? 10_000
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('Invalid helper deadline')
  const expected = structuredClone(options.expected)
  const descriptor = readOwnerHelperDescriptor(options.descriptorPath)
  exactFacts(descriptor.facts, expected)
  const abort = new AbortController()
  let closed: Error | undefined
  let state: ProjectControlState
  let grant: string
  let observation = 0
  let retirementPending = false
  type Writer = { listeners: Set<(message: Rpc) => void>; approvals: Map<string | number, Rpc>; ready: Promise<void>; writerGrant: string; cursor: number; detached: boolean }
  const writers = new Map<string, Writer>()
  const close = (error = new Error('Owner frontend detached')) => { closed ??= error; abort.abort(); for (const writer of writers.values()) writer.listeners.clear() }
  const assertCurrent = () => {
    if (closed) throw closed
    if (socketIdentity(descriptor.socketPath) !== descriptor.socketIdentity) { close(new Error('Owner helper socket replaced')); throw closed }
  }
  const call = async (body: Rpc, deadlineMs = timeout): Promise<Rpc> => {
    assertCurrent()
    const json = JSON.stringify(body)
    if (Buffer.byteLength(json) > BROKER_MAX_MESSAGE_BYTES) throw new Error('Oversized helper request')
    let response: Response
    try {
      response = await fetch('http://localhost/owner', { unix: descriptor.socketPath, method: 'POST',
        headers: { authorization: `Bearer ${descriptor.token}`, 'content-type': 'application/json' }, body: json,
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(deadlineMs)]) })
    } catch { close(new Error('Owner helper transport failed; request outcome may be unknown')); throw closed }
    const raw = await decodeOwnerHelperResponse(response, close)
    if (!response.ok) throw new Error(typeof raw.error === 'string' ? raw.error : 'Owner helper refused')
    assertCurrent()
    if (!object(raw.state) || !Number.isSafeInteger(raw.observation)) { close(new Error('Unobserved owner helper state')); throw closed }
    if (Number(raw.observation) > observation) {
      observation = Number(raw.observation)
      state = Object.freeze(raw.state) as unknown as ProjectControlState
    }
    return raw
  }
  try {
    const challenge = randomBytes(32).toString('hex')
    const ready = await call({ operation: 'attach', expected, challenge })
    exactFacts(ready.facts, expected)
    if (ready.challenge !== challenge || !isDeepStrictEqual(ready.helper, descriptor.helper) || typeof ready.grant !== 'string'
      || !state! || state.generation !== expected.brokerGeneration || state.phase === 'closed' || state.phase === 'recovery') throw new Error('Owner helper reconciliation refused')
    grant = ready.grant
  } catch (error) { close(error as Error); throw error }
  const refreshState = async () => {
    try { await call({ operation: 'state', grant }); return { ...state } }
    catch (error) { close(error as Error); throw error }
  }
  const watchState = async () => { while (!closed) { await Bun.sleep(100); if (!closed && !retirementPending) await refreshState() } }
  fireAndForget('codex-cli.owner-helper.watch-state', watchState(), error => close(error as Error))
  const writerCall = (clientId: string, writer: Writer, body: Rpc) => call({ ...body, grant, clientId, writerGrant: writer.writerGrant })
  const poll = async (clientId: string, writer: Writer) => {
    while (!closed && !writer.detached) {
      const response = await writerCall(clientId, writer, { operation: 'poll', cursor: writer.cursor })
      if (!Array.isArray(response.events) || !Number.isSafeInteger(response.cursor)) throw new Error('Invalid owner event response')
      writer.cursor = response.cursor as number
      for (const event of response.events) {
        if (!object(event) || !object(event.message)) throw new Error('Invalid owner event')
        const message = event.message
        if (typeof message.id === 'string' || typeof message.id === 'number') writer.approvals.set(message.id, message)
        if (message.method === 'turn/completed') writer.approvals.clear()
        if (!writer.detached) for (const listener of writer.listeners) listener(message)
      }
    }
  }
  const replyApproval = async (clientId: string, id: string | number, result: unknown, expectedEpoch: number) => {
    const writer = writers.get(clientId)
    if (!writer || writer.detached) throw new Error('Exact approval writer is not attached')
    await writer.ready
    await writerCall(clientId, writer, { operation: 'reply', id, result, epoch: expectedEpoch })
    writer.approvals.delete(id)
  }
  const reviewPrepare = async (request: ReviewPermissionRequest, expectedEpoch: number): Promise<ReviewPermissionLease> => {
    const reviewCall = async (body: Rpc, deadlineMs = timeout) => {
      try { return await call(body, deadlineMs) } catch (error) { close(error as Error); throw error }
    }
    const ready = await reviewCall({ operation: 'reviewPrepare', grant, stageDir: request.stageDir, network: request.network, epoch: expectedEpoch })
    if (ready.refused === 'busy') throw new ReviewPermissionBusy('Native review busy; current owner turn remains attached')
    if (typeof ready.lease !== 'string' || !/^[a-f0-9]{64}$/.test(ready.lease)) { close(new Error('Invalid private review lease')); throw closed }
    const lease = ready.lease
    let phase: 'ready' | 'started' | 'waiting' | 'settled' | 'restoring' | 'restored' | 'releasing' | 'released' | 'abandoned' = 'ready'
    return {
      async start(input) {
        assertCurrent()
        if (phase !== 'ready') throw new Error('Review dispatch lease unavailable')
        phase = 'started'
        const result = await reviewCall({ operation: 'reviewStart', grant, lease, input })
        if (typeof result.turnId !== 'string' || !result.turnId) { close(new Error('Invalid review dispatch receipt')); throw closed }
        return { turnId: result.turnId }
      },
      async restore() {
        assertCurrent()
        if (phase !== 'started' && phase !== 'settled') throw new Error('Review restoration lease unavailable')
        phase = 'restoring'
        const restored = await reviewCall({ operation: 'reviewRestore', grant, lease })
        if (restored.restored !== true) { close(new Error('Unverified review restoration')); throw closed }
        phase = 'restored'
      },
      async waitSettled(timeoutMs) {
        assertCurrent()
        if (phase !== 'started' || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0
          || timeoutMs > MAX_REVIEW_SETTLEMENT_WAIT_MS) throw new Error('Invalid private review settlement wait')
        phase = 'waiting'
        const result = await reviewCall({ operation: 'reviewWaitSettled', grant, lease, timeoutMs }, timeoutMs + timeout)
        if (result.settled !== true) { close(new Error('Native review settlement unknown')); throw closed }
        phase = 'settled'
        return true
      },
      async release() {
        assertCurrent()
        if (phase !== 'restored') throw new Error('Review release unavailable')
        phase = 'releasing'
        const acknowledged = await reviewCall({ operation: 'reviewAcknowledge', grant, lease })
        if (acknowledged.acknowledged !== true) { close(new Error('Unverified review acknowledgement')); throw closed }
        // This request proves receipt before releasing the native writer lock.
        const released = await reviewCall({ operation: 'reviewRelease', grant, lease })
        if (released.released !== true) { close(new Error('Unverified review release')); throw closed }
        phase = 'released'
      },
      abandon() {
        if (phase === 'released' || phase === 'abandoned') return
        phase = 'abandoned'
        // Start the one best-effort notice before fencing this proxy synchronously.
        // Do not abort that notice: an absent response still retains the helper lease.
        if (!closed) fireAndForget('codex-cli.owner-helper.review-abandon', call({ operation: 'reviewAbandon', grant, lease }))
        closed ??= new Error('Owner review abandoned; reconciliation required')
        for (const writer of writers.values()) writer.listeners.clear()
      },
    }
  }
  const broker: ProjectControlBroker = {
    reviewPermissions: reviewPrepare,
    state() { return closed ? { ...state, phase: 'closed' } : { ...state } },
    gateway(clientId): ProjectControlGateway {
      assertCurrent()
      if (!clientId || writers.has(clientId)) throw new Error('Gateway identity unavailable')
      const writer: Writer = { listeners: new Set(), approvals: new Map(), writerGrant: '', cursor: 0, detached: false, ready: Promise.resolve() }
      writers.set(clientId, writer)
      writer.ready = (async () => {
        const ready = await call({ operation: 'open', grant, clientId })
        if (typeof ready.grant !== 'string' || !Number.isSafeInteger(ready.cursor) || !Array.isArray(ready.approvals)) throw new Error('Invalid retained writer')
        writer.writerGrant = ready.grant; writer.cursor = ready.cursor as number
        for (const message of ready.approvals) {
          if (!object(message) || typeof message.id !== 'string' && typeof message.id !== 'number') throw new Error('Invalid retained approval')
          writer.approvals.set(message.id, message)
        }
        for (const listener of writer.listeners) for (const approval of writer.approvals.values()) listener(approval)
        fireAndForget('codex-cli.owner-helper.poll', poll(clientId, writer), error => { if (!writer.detached) close(error as Error) })
      })()
      fireAndForget('codex-cli.owner-helper.writer-ready', writer.ready, error => close(error as Error))
      const current = () => { assertCurrent(); if (writer.detached) throw new Error('Gateway frontend closed') }
      return {
        async request(method, params, expectedEpoch) {
          current(); await writer.ready; current()
          const response = await writerCall(clientId, writer, { operation: 'request', method, params, epoch: expectedEpoch })
          if (response.refused === 'admission' && !('result' in response)) {
            throw new ProjectControlAdmissionRefusal('Native project writer admission refused before delivery')
          }
          if ('refused' in response || !('result' in response)) { close(new Error('Invalid native gateway response')); throw closed }
          return response.result
        },
        reply() { throw new Error('Remote approval requires awaited replyApproval(clientId, id, result, epoch)') },
        subscribe(listener) {
          current(); writer.listeners.add(listener)
          queueMicrotask(() => { if (!writer.detached && !closed && writer.listeners.has(listener)) for (const approval of writer.approvals.values()) listener(approval) })
          return () => { writer.listeners.delete(listener) }
        },
        close() {
          if (writer.detached) return
          writer.detached = true; writer.listeners.clear()
          fireAndForget('codex-cli.owner-helper.close-writer', writer.ready.then(() => writerCall(clientId, writer, { operation: 'closeWriter' })).then(() => {
            if (writers.get(clientId) === writer) writers.delete(clientId)
          }), error => { if (!closed) close(error as Error) })
        },
      }
    },
    close() { close() },
  }
  const facts = Object.freeze({ ...descriptor.facts, nativeMetadata: Object.freeze({ ...descriptor.facts.nativeMetadata }),
    capabilities: Object.freeze({ ...descriptor.facts.capabilities }) })
  const retire = async (expectedEpoch: number): Promise<CodexOwnerRetirement> => {
    if (retirementPending) return { status: 'busy', reason: 'Native owner retirement is already pending' }
    retirementPending = true
    try {
      const response = await call({ operation: 'retire', grant, epoch: expectedEpoch })
      if (response.status === 'busy' || response.status === 'unknown') {
        retirementPending = false
        return { status: response.status, reason: typeof response.reason === 'string' ? response.reason : 'Native retirement refused' }
      }
      if (response.status !== 'retired' || !object(response.receipt)) throw new Error('Native retirement acknowledgement is incomplete')
      exactFacts(response.receipt.facts, expected)
      close(new Error('Native owner retired'))
      return { status: 'retired', receipt: response.receipt as unknown as Extract<CodexOwnerRetirement, { status: 'retired' }>['receipt'] }
    } catch (error) {
      close(error as Error)
      return { status: 'unknown', reason: error instanceof Error ? error.message : 'Native retirement reply lost' }
    }
  }
  return { facts, assertCurrent, broker, refreshState, replyApproval, reviewPrepare, retire, close: () => close() }
}
