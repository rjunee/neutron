/** Manual native loopback-auth feasibility probe, not the consuming factory test.
 * bun run runtime/adapters/codex-cli/persistent/project-control-bootstrap-attestation.smoke.ts
 * Uses a disposable home, local provider and one native app-server. No seed turn.
 */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProjectControlStdioTransport } from './project-control-broker-transport.ts'

type Rpc = Record<string, any>
async function until(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 15_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Native bootstrap timeout: ${label}`)
    await Bun.sleep(25)
  }
}

async function run(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'owner-native-bootstrap-'))
  const cwd = join(dir, 'project'), codexHome = join(dir, 'home')
  mkdirSync(cwd); mkdirSync(codexHome)
  const inputs: string[] = []
  const provider = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    inputs.push(await request.text())
    const item = { id: 'native-bootstrap-answer', type: 'message', status: 'completed', role: 'assistant',
      content: [{ type: 'output_text', text: 'OWNER_BOOTSTRAP_REPLY', annotations: [] }] }
    const events = [
      { type: 'response.created', response: { id: 'bootstrap-response', status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
      { type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
      { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'OWNER_BOOTSTRAP_REPLY' },
      { type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text: 'OWNER_BOOTSTRAP_REPLY' },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id: 'bootstrap-response', status: 'completed', output: [item], usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 } } },
    ]
    return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
      { headers: { 'content-type': 'text/event-stream' } })
  } })
  const configOverrides = ['model_provider="fixture"', 'model="gpt-5.5"',
    `model_providers.fixture={name="fixture",base_url="http://127.0.0.1:${provider.port}/v1",wire_api="responses",requires_openai_auth=false}`,
    'analytics.enabled=false', 'feedback.enabled=false', 'check_for_update_on_startup=false',
    `projects.${JSON.stringify(cwd)}.trust_level="trusted"`]
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', TERM: 'xterm-256color', LANG: 'C.UTF-8', CODEX_HOME: codexHome }
  const transport = createProjectControlStdioTransport({ binary: 'codex', cwd, codexHome, env, configOverrides })
  const requests: Rpc[] = []
  const replies = new Map<string | number, Rpc>()
  const sockets = new Set<{ send(data: string): unknown }>()
  let thread: Rpc | undefined, completed = false, failure: Error | undefined
  transport.listen(raw => {
    const message = raw as Rpc
    if (message.id !== undefined && !message.method) replies.set(message.id, message)
    if (message.method === 'thread/started' && message.params.thread.ephemeral === false && thread === undefined) thread = message.params.thread
    if (message.method === 'turn/completed' && message.params.threadId === thread?.id) completed = true
    for (const socket of sockets) socket.send(JSON.stringify(message))
  }, error => { failure = error })
  transport.send({ id: 'probe-initialize', method: 'initialize', params: {
    clientInfo: { name: 'owner-bootstrap-probe', version: '1' },
    capabilities: { experimentalApi: true, requestAttestation: false },
  } })
  let initialized: Rpc
  try {
    await until(() => replies.has('probe-initialize') || failure !== undefined, 'native initialize')
    if (failure) throw failure
    initialized = replies.get('probe-initialize')!
    assert(!initialized.error)
  } catch (error) {
    transport.close(); provider.stop(true)
    rmSync(dir, { recursive: true, force: true })
    throw error
  }
  transport.send({ method: 'initialized' })
  const token = randomBytes(32).toString('hex')
  let rejected = 0
  const proxy = Bun.serve({ hostname: '127.0.0.1', port: 0,
    fetch(request, server) {
      if (request.headers.get('authorization') !== `Bearer ${token}` || request.headers.has('origin')) {
        rejected++
        return new Response('Refused', { status: 403 })
      }
      return server.upgrade(request) ? undefined : new Response('WebSocket required', { status: 400 })
    },
    websocket: {
      open(socket) { sockets.add(socket) },
      message(socket, raw) {
        const message = JSON.parse(raw.toString()) as Rpc
        requests.push(message)
        if (message.method === 'initialize') {
          socket.send(JSON.stringify({ id: message.id, result: initialized.result })); return
        }
        if (message.method === 'initialized') return
        transport.send(message)
      },
      close(socket) { sockets.delete(socket) },
    },
  })
  for (const headers of [{}, { authorization: 'Bearer foreign-token' }]) {
    assert.equal((await fetch(`http://127.0.0.1:${proxy.port}/rpc`, { headers })).status, 403)
  }
  assert.equal(rejected, 2)
  let output = ''
  const tui = Bun.spawn(['codex', '--remote', `ws://127.0.0.1:${proxy.port}`, '--remote-auth-token-env', 'NEUTRON_BOOTSTRAP_TOKEN', ...configOverrides.flatMap(value => ['-c', value])], {
    cwd, env: { ...env, NEUTRON_BOOTSTRAP_TOKEN: token }, terminal: { cols: 100, rows: 30, data(terminal, bytes) {
      const chunk = new TextDecoder().decode(bytes)
      output += chunk
      if (chunk.includes('\x1b[6n')) terminal.write('\x1b[1;1R')
    } },
  })
  try {
    await until(() => thread !== undefined || failure !== undefined, 'fresh TUI thread/start')
    if (failure) throw failure
    assert(thread && typeof thread.id === 'string' && typeof thread.sessionId === 'string')
    assert.equal(thread.cwd, cwd)
    assert.equal(inputs.length, 0)
    assert.equal(requests.filter(message => message.method === 'turn/start').length, 0)
    const before = existsSync(thread.path)
    const observerModule = process.env.CODEX_OBSERVER_MODULE
    const observer = observerModule ? new (await import(observerModule)).CodexRolloutObserver({
      projectId: 'fixture-project', paneHandle: `fixture-pty-${tui.pid}`, threadId: thread.id,
      rolloutPath: thread.path, cwd, bindingRevision: 'fixture-native-revision',
      nativeMetadata: { sessionId: thread.sessionId, source: thread.source, originator: thread.originator },
    }, 'FIRST_REAL_OWNER_MESSAGE\nwith ordinary multiline text') : undefined
    assert.equal(thread.source, 'vscode')
    assert.equal(thread.originator, 'owner-bootstrap-probe')
    process.stdout.write(`Fresh TUI started exact thread; rollout exists before first user message: ${before}\n`)
    // The proxy is a feasibility probe. Production must admit this through its
    // fenced broker, not copy this unguarded transport access.
    transport.send({ id: 'probe-gateway-first-turn', method: 'turn/start', params: {
      threadId: thread.id, input: [{ type: 'text', text: 'FIRST_REAL_OWNER_MESSAGE\nwith ordinary multiline text' }],
    } })
    await until(() => replies.has('probe-gateway-first-turn') || failure !== undefined, 'first gateway receipt')
    assert(!failure)
    const receipt = replies.get('probe-gateway-first-turn')!
    assert(!receipt.error, JSON.stringify(receipt.error))
    assert.equal(typeof receipt.result?.turn?.id, 'string')
    observer?.bindReceipt({ threadId: thread.id, turnId: receipt.result.turn.id, rolloutPath: thread.path,
      bindingRevision: 'fixture-native-revision' })
    await until(() => completed && inputs.length > 0, 'first real owner completion')
    await until(() => output.includes('OWNER_BOOTSTRAP_REPLY'), 'first gateway reply rendered by native TUI')
    // The native TUI may make a separate title-generation provider request.
    process.stdout.write(`Native TUI ancillary mutations: ${JSON.stringify(requests.filter(message =>
      ['thread/start', 'turn/start'].includes(message.method)).map(message => ({ method: message.method,
        sameOwnerThread: message.params?.threadId === thread?.id, ephemeral: message.params?.ephemeral })))}\n`)
    assert.equal(requests.filter(message => message.method === 'turn/start' && message.params.threadId === thread!.id).length, 0)
    assert(inputs[0]!.includes('FIRST_REAL_OWNER_MESSAGE'))
    assert(existsSync(thread.path))
    if (observer) {
      await until(() => { observer.read(); return observer.completed }, 'native rollout observer completion')
      observer.close()
      process.stdout.write('PASS: actual native first-turn rollout consumed by deferred observer\n')
    }
    process.stdout.write('PASS: fresh native remote TUI and gateway shared the first real multiline owner turn; no seed or second app-server.\n')
    process.stdout.write('LIMIT: authentication probe only; consuming factory smoke separately verifies generation and binding guards.\n')
  } catch (error) {
    process.stderr.write(`${output.slice(-2000).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')}\n`)
    throw error
  } finally {
    tui.kill(); await tui.exited; tui.terminal?.close()
    proxy.stop(true); transport.close(); provider.stop(true)
    rmSync(dir, { recursive: true, force: true })
  }
}

if (import.meta.main) await run()
