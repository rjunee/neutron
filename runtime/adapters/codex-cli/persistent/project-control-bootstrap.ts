import { createHash, randomBytes } from 'node:crypto'
import { lstatSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import type { ServerWebSocket } from 'bun'
import type { PtyHost } from '../../claude-code/persistent/pty-host.ts'
import type { ProjectPanePlacement } from '../../claude-code/persistent/project-workspaces.ts'
import { createProjectControlBroker, classifyProjectControlMethod, type ProjectControlBroker, type ProjectControlGateway } from './project-control-broker.ts'
import { openProjectControlJournal } from './project-control-broker-journal.ts'
import { BROKER_MAX_MESSAGE_BYTES, createProjectControlStdioTransport, type ProjectControlTransport } from './project-control-broker-transport.ts'
import { validateProjectControlScope } from './project-control-broker-scope.ts'
import { admitsBootstrapConfig, admitsOwnerTui, OWNER_BOOTSTRAP_ORIGINATOR as ORIGINATOR, validateBootstrapMultiAgent, validateBootstrapThread } from './project-control-bootstrap-validation.ts'
import { OWNER_INSTALLED_GATEWAY_TOOL } from './owner-installed-gateway.ts'

type Rpc = Record<string, unknown>
const object = (value: unknown): value is Rpc => typeof value === 'object' && value !== null && !Array.isArray(value)
const START_FIELDS = new Set(['model', 'modelProvider', 'cwd', 'runtimeWorkspaceRoots', 'approvalPolicy', 'approvalsReviewer',
  'sandbox', 'permissions', 'config', 'serviceName', 'baseInstructions', 'developerInstructions', 'personality', 'multiAgentMode',
  'ephemeral', 'historyMode', 'sessionStartSource', 'threadSource', 'projectId', 'environments', 'dynamicTools',
  'selectedCapabilityRoots', 'mockExperimentalField'])

declare const bindingBrand: unique symbol
/** Runtime authority is WeakMap membership, not this compile-time brand. */
export interface CodexOwnerBinding { readonly [bindingBrand]: true }
export interface CodexOwnerBindingFacts {
  readonly threadId: string
  readonly sessionId: string
  readonly cwd: string
  readonly codexHome: string
  readonly rolloutPath: string
  readonly paneHandle: string
  readonly bindingRevision: string
  readonly generation: number
  readonly brokerGeneration: number
  readonly credentialFingerprint: string
  readonly modelProvider: string
  readonly controlSocketPath: string
  readonly nativeMetadata: Readonly<{ sessionId: string; source: string; originator: string }>
  /** Native thread feature report, observed before sealing; no model turn is seeded. */
  readonly capabilities: Readonly<{ multiAgentV2: true; evidence: 'native-thread-feature-report'; ownerInstalledMcp?: true }>
}
const bindings = new WeakMap<object, { facts: CodexOwnerBindingFacts; assertCurrent(): void }>()
export function readCodexOwnerBinding(handle: CodexOwnerBinding): CodexOwnerBindingFacts {
  const entry = bindings.get(handle)
  if (!entry) throw new Error('Unattested owner binding')
  entry.assertCurrent()
  return entry.facts
}

/** Attach to an already running helper. No launch, journal claim, or fallback. */
export interface CodexOwnerAttachment extends CodexOwnerBootstrap {
  /** broker.state() is a cached observation. Await this before deciding that a
   * native turn has settled; writes are independently fenced by the helper. */
  refreshState(): Promise<ReturnType<ProjectControlBroker['state']>>
  /** Resolves only after the exact retained native writer accepts the reply. */
  replyApproval(clientId: string, id: string | number, result: unknown, expectedEpoch: number): Promise<void>
}
export async function attachCodexOwner(options: {
  descriptorPath: string
  expected: CodexOwnerBindingFacts
  timeoutMs?: number
}): Promise<CodexOwnerAttachment> {
  const { connectCodexOwnerHelper } = await import('./project-owner-helper-client.ts')
  const connection = await connectCodexOwnerHelper(options)
  const handle = Object.freeze({}) as CodexOwnerBinding
  bindings.set(handle, { facts: connection.facts, assertCurrent: connection.assertCurrent })
  return { binding: handle, broker: connection.broker,
    refreshState: connection.refreshState, replyApproval: connection.replyApproval,
    writeTerminal() { throw new Error('Use the native owner pane for terminal input') },
    async close() { connection.close() } }
}

export interface CodexOwnerBootstrap {
  readonly binding: CodexOwnerBinding
  readonly broker: ProjectControlBroker
  /** Terminal bytes, not model input; future pane integration owns presentation. */
  writeTerminal(bytes: string): void
  close(): Promise<void>
}

/** Fresh owner creation only. A prior sealed or uncertain generation refuses;
 * reattachment/recovery must reconcile the existing native owner separately.
 * The random bearer authenticates the launched TUI, not a hostile same-UID
 * process able to read its environment or ptrace it. No Unix-auth downgrade.
 */
export async function bootstrapCodexOwner(options: {
  binary: string
  socketPath: string
  cwd: string
  codexHome: string
  env: Readonly<Record<string, string>>
  configOverrides?: readonly string[]
  timeoutMs?: number
  onTerminalData?(bytes: Uint8Array): void
  /** Existing host boundary; Herdr gives the native TUI its own visible pane. */
  terminalHost?: PtyHost
  projectPlacement?: ProjectPanePlacement
  onTerminalScreen?(screen: string): void
}): Promise<CodexOwnerBootstrap> {
  if (options.projectPlacement !== undefined && options.terminalHost === undefined) {
    throw new Error('Explicit Codex project placement requires a terminal host')
  }
  options = { ...options, env: { ...options.env }, configOverrides: [...options.configOverrides ?? [], 'features.multi_agent_v2=true'] }
  const timeout = options.timeoutMs ?? 15_000
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('Invalid bootstrap deadline')
  for (const path of [options.cwd, options.codexHome, dirname(options.socketPath)]) {
    if (!isAbsolute(path) || realpathSync(path) !== path || !lstatSync(path).isDirectory()) throw new Error('Canonical bootstrap paths required')
  }
  const parent = lstatSync(dirname(options.socketPath))
  if ((parent.mode & 0o077) !== 0 || parent.uid !== process.getuid?.()) throw new Error('Private owned bootstrap directory required')
  const home = lstatSync(options.codexHome)
  if ((home.mode & 0o077) !== 0 || home.uid !== process.getuid?.()) throw new Error('Private owned Codex namespace required')
  // The fixed namespace is claimed before any child or native request exists.
  const journal = openProjectControlJournal({ ...options, socketPath: join(options.codexHome, '.neutron-owner-bootstrap'), threadId: 'fresh-owner-bootstrap' })
  let upstream: ProjectControlTransport | undefined
  let broker: ProjectControlBroker | undefined
  let gateway: ProjectControlGateway | undefined
  let tui: { pid: number; paneHandle?: string | undefined; hasExited(): boolean; exited: Promise<number | null>; write(bytes: string): void; kill(): void; dispose(): void } | undefined
  let server: ReturnType<typeof Bun.serve<undefined>> | undefined
  let socket: ServerWebSocket<undefined> | undefined
  let closed = false
  let failure: Error | undefined
  let upstreamReceive: ((message: unknown) => void) | undefined
  let upstreamDisconnect: ((error: Error) => void) | undefined
  let sequence = 0
  let started = false
  let initializedClient = false
  let nativeThread: Rpc | undefined
  const held: Rpc[] = []
  const pending = new Map<string, { resolve(value: Rpc): void; reject(error: Error): void }>()
  let resolveReady!: (value: CodexOwnerBootstrap) => void
  let rejectReady!: (error: Error) => void
  const ready = new Promise<CodexOwnerBootstrap>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  // Avoid an unhandled rejection if initialization fails before awaiting ready.
  ready.catch(() => {})
  const stop = (error = new Error('Owner bootstrap closed')): void => {
    if (closed) return
    closed = true; failure = error
    clearTimeout(deadline)
    for (const request of pending.values()) request.reject(error)
    pending.clear()
    rejectReady(error)
    gateway?.close(); broker?.close(); upstream?.close()
    tui?.kill(); server?.stop(true); journal.close()
  }
  const deadline = setTimeout(() => stop(new Error('Owner bootstrap deadline expired')), timeout)
  const emit = (message: Rpc): void => { socket?.send(JSON.stringify(message)) }
  const native = (method: string, params: Rpc): Promise<Rpc> => {
    journal.assertOwned()
    if (closed || pending.size >= 64) return Promise.reject(failure ?? new Error('Too many bootstrap requests'))
    const id = `bootstrap-${++sequence}`
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      try { upstream!.send({ id, method, params }) } catch (error) { stop(error as Error) }
    })
  }
  const assertCurrent = (): void => {
    if (closed || !tui || tui.hasExited() || !broker || broker.state().phase === 'closed') throw new Error('Stale owner binding')
    journal.assertOwned()
  }
  try {
    if (journal.attestation() !== null || journal.unresolved !== null) throw new Error('Existing owner needs explicit recovery')
    upstream = createProjectControlStdioTransport(options)
    upstream.listen(raw => {
      if (closed) return
      try {
        journal.assertOwned()
        if (!object(raw)) throw new Error('Malformed native bootstrap envelope')
        if (typeof raw.id === 'string' && pending.has(raw.id) && typeof raw.method !== 'string') {
          const request = pending.get(raw.id)!; pending.delete(raw.id)
          if (object(raw.error)) request.reject(new Error('Native bootstrap request refused'))
          else if (object(raw.result)) request.resolve(raw.result)
          else request.reject(new Error('Malformed native bootstrap response'))
          return
        }
        if (!broker) {
          if (raw.method === 'thread/started' && object(raw.params) && object(raw.params.thread)) {
            if (nativeThread || !started) throw new Error('Unexpected native owner thread')
            nativeThread = raw.params.thread
          }
          if (held.length >= 256) throw new Error('Bootstrap notification limit')
          held.push(raw)
        } else upstreamReceive?.(raw)
      } catch (error) { stop(error as Error) }
    }, error => { upstreamDisconnect?.(error); stop(error) })
    const initialized = await native('initialize', { clientInfo: { name: ORIGINATOR, version: '1' },
      capabilities: { experimentalApi: true, requestAttestation: false } })
    upstream.send({ method: 'initialized' })
    const account = await native('account/read', {})
    // Native account evidence is hashed; no email, account ID, or credential is journaled.
    const credentialFingerprint = createHash('sha256').update(JSON.stringify(account)).digest('hex')
    const token = randomBytes(32).toString('hex')
    const bind = async (response: Rpc): Promise<void> => {
      const thread = response.thread
      while ((!nativeThread || !tui) && !closed) await Bun.sleep(5)
      if (closed) throw new Error('Owner closed before terminal binding')
      validateBootstrapThread(thread, nativeThread, options.cwd, options.codexHome)
      validateBootstrapMultiAgent(await native('experimentalFeature/list', { threadId: thread.id, limit: 1000 }))
      const transport: ProjectControlTransport = {
        listen(receive, disconnect) { upstreamReceive = receive; upstreamDisconnect = disconnect },
        send(message) {
          assertCurrentForTransport()
          if (message.method === 'initialize') queueMicrotask(() => upstreamReceive?.({ id: message.id, result: initialized }))
          else if (message.method !== 'initialized') upstream!.send(message)
        },
        close() { upstream?.close() },
      }
      const assertCurrentForTransport = (): void => { journal.assertOwned(); if (closed) throw new Error('Bootstrap closed') }
      broker = await createProjectControlBroker({ ...options, threadId: thread.id, upstream: transport })
      const facts: CodexOwnerBindingFacts = Object.freeze({ threadId: thread.id, sessionId: thread.sessionId,
        cwd: options.cwd, codexHome: options.codexHome, rolloutPath: thread.path,
        paneHandle: tui!.paneHandle ?? `owned-pty:${tui!.pid}`, bindingRevision: randomBytes(32).toString('hex'),
        generation: journal.generation, brokerGeneration: broker.state().generation, credentialFingerprint,
        modelProvider: thread.modelProvider, controlSocketPath: options.socketPath,
        capabilities: Object.freeze({ multiAgentV2: true, evidence: 'native-thread-feature-report', ownerInstalledMcp: true }),
        nativeMetadata: Object.freeze({ sessionId: thread.sessionId, source: thread.source, originator: thread.originator }) })
      journal.sealAttestation(JSON.stringify(facts))
      journal.settle()
      const handle = Object.freeze({}) as CodexOwnerBinding
      bindings.set(handle, { facts, assertCurrent })
      gateway = broker.gateway('owned-native-tui')
      gateway.subscribe(emit)
      clearTimeout(deadline)
      for (const event of held.splice(0)) {
        if (object(event.params) && object(event.params.thread) && event.params.thread.id === thread.id) emit(event)
      }
      resolveReady({ binding: handle, broker, writeTerminal(bytes) { assertCurrent(); tui!.write(bytes) },
        async close() { stop(); await tui?.exited; tui?.dispose() } })
    }
    const handleRequest = async (raw: Rpc): Promise<void> => {
      const id = raw.id
      const params = object(raw.params) ? structuredClone(raw.params) : {}
      if (raw.method === 'initialize') {
        if (initializedClient) throw new Error('Duplicate TUI initialize')
        initializedClient = true; emit({ id, result: initialized }); return
      }
      if (raw.method === 'initialized' && id === undefined) return
      if (!initializedClient || typeof id !== 'string' && typeof id !== 'number') throw new Error('Uninitialized TUI request')
      if (typeof raw.method !== 'string') {
        if (!gateway || !('result' in raw) || 'error' in raw) throw new Error('Invalid native approval')
        gateway.reply(id, raw.result, broker!.state().epoch); return
      }
      if (gateway) {
        if (raw.method === 'thread/unsubscribe' && params.threadId === nativeThread?.id) { emit({ id, result: {} }); return }
        const result = await gateway.request(raw.method, params,
          classifyProjectControlMethod(raw.method) === 'mutation' ? broker!.state().epoch : undefined)
        emit({ id, result }); return
      }
      if (raw.method === 'thread/start') {
        if (started || Object.keys(params).some(key => !START_FIELDS.has(key)) || params.ephemeral !== false
          || params.cwd != null && params.cwd !== options.cwd || params.projectId != null
          || params.sessionStartSource != null || params.threadSource !== 'user'
          || params.modelProvider != null || params.baseInstructions != null || params.developerInstructions != null
          || params.permissions != null || params.selectedCapabilityRoots != null
          || !admitsBootstrapConfig(params.config)) {
          throw new Error('Bootstrap thread scope refused')
        }
        validateProjectControlScope('thread/start', params, options.cwd, message => new Error(message))
        // Preserve authenticated native TUI tools, but reserve our fixed route.
        // Registration occurs once on the root, never through a resume override.
        const nativeTools = params.dynamicTools ?? []
        if (!Array.isArray(nativeTools) || nativeTools.some(tool => !object(tool) || tool.name === OWNER_INSTALLED_GATEWAY_TOOL.name)) throw new Error('Reserved owner dynamic tool')
        params.dynamicTools = [...nativeTools, { type: 'function', ...structuredClone(OWNER_INSTALLED_GATEWAY_TOOL) }]
        started = true; journal.record('thread/start')
        const response = await native(raw.method, params)
        await bind(response)
        emit({ id, result: response }); return
      }
      // Before a thread exists, expose only initialization reads. No thread lists,
      // history, caller-created thread, or mutation can race binding.
      if (!['account/read', 'model/list', 'configRequirements/read', 'collaborationMode/list', 'hooks/list', 'config/read'].includes(raw.method)) {
        throw new Error('Bootstrap RPC refused')
      }
      if (raw.method === 'config/read' && params.cwd === '.') params.cwd = options.cwd
      if (params.filePath != null && params.filePath !== join(options.codexHome, 'config.toml')) throw new Error('Foreign config')
      validateProjectControlScope(raw.method, params, options.cwd, message => new Error(message))
      emit({ id, result: await native(raw.method, params) })
    }
    server = Bun.serve<undefined>({ hostname: '127.0.0.1', port: 0,
      fetch(request, instance) {
        if (closed || !admitsOwnerTui(request, token, socket !== undefined)) return new Response('Refused', { status: 403 })
        return instance.upgrade(request, { data: undefined }) ? undefined : new Response('WebSocket required', { status: 400 })
      },
      websocket: { maxPayloadLength: BROKER_MAX_MESSAGE_BYTES,
        open(client) { if (socket) { client.close(1008); return }; socket = client },
        message(_client, data) {
          let raw: Rpc
          try { const parsed: unknown = JSON.parse(data.toString()); if (!object(parsed)) throw new Error(); raw = parsed }
          catch { stop(new Error('Malformed TUI request')); return }
          handleRequest(raw).catch(error => {
            emit({ id: raw.id, error: { code: -32001, message: 'Owner request refused' } })
            if (raw.method === 'thread/start' && !gateway) stop(error as Error)
          })
        },
        close(client) { if (client === socket) stop(new Error('Owned TUI disconnected')) },
      },
    })
    const argv = [options.binary, '--remote', `ws://127.0.0.1:${server.port}`, '--remote-auth-token-env', 'NEUTRON_OWNER_TOKEN',
      ...(options.configOverrides ?? []).flatMap(value => ['-c', value])]
    const launch = {
      cwd: options.cwd, env: { ...options.env, CODEX_HOME: options.codexHome, NEUTRON_OWNER_TOKEN: token },
    }
    if (options.terminalHost) {
      const terminal = await options.terminalHost.spawn(argv, { ...launch, label: 'codex-native-owner',
        ...(options.projectPlacement === undefined ? {} : { projectPlacement: options.projectPlacement }),
        onScreen(screen) { options.onTerminalScreen?.(screen) } })
      tui = { pid: terminal.pid, paneHandle: terminal.paneHandle, hasExited: terminal.hasExited,
        exited: terminal.exited, write: bytes => terminal.write(bytes), kill: () => terminal.kill(), dispose: () => terminal.detach?.() }
      terminal.beginOutput?.()
      if (closed) { tui.kill(); throw new Error('Owner closed during terminal launch') }
    } else {
      const terminal = Bun.spawn(argv, { ...launch,
        terminal: { cols: 100, rows: 30, data(terminal, bytes) {
          if (new TextDecoder().decode(bytes).includes('\x1b[6n')) terminal.write('\x1b[1;1R')
          options.onTerminalData?.(bytes)
        } },
      })
      tui = { pid: terminal.pid, hasExited: () => terminal.exitCode !== null, exited: terminal.exited,
        write: bytes => { terminal.terminal?.write(bytes) }, kill: () => terminal.kill(), dispose: () => terminal.terminal?.close() }
    }
    tui.exited.then(() => stop(new Error('Owned TUI exited')))
    return await ready
  } catch (error) {
    stop(error as Error)
    await tui?.exited; tui?.dispose()
    throw error
  }
}
