/** Manual consuming check: bun run runtime/adapters/codex-cli/persistent/project-control-broker.smoke.ts
 * Requires installed Codex and a PTY. Uses only a disposable CODEX_HOME and a
 * loopback model fixture; it does not use owner credentials or a real provider.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProjectControlBroker, type ProjectControlBroker } from './project-control-broker.ts'
import { createProjectControlStdioTransport, type ProjectControlTransport } from './project-control-broker-transport.ts'

async function until(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 20_000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Native smoke timeout: ${label}`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

async function run(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'project-broker-native-'))
  const cwd = join(dir, 'project')
  const codexHome = join(dir, 'home')
  const foreign = join(dir, 'foreign')
  mkdirSync(cwd); mkdirSync(codexHome); mkdirSync(foreign)
  const inputs: string[] = []
  const provider = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    inputs.push(await request.text())
    const responseId = `response-${inputs.length}`
    const item = { id: `message-${inputs.length}`, type: 'message', status: 'completed', role: 'assistant',
      content: [{ type: 'output_text', text: 'BROKER_NATIVE_REPLY', annotations: [] }] }
    const events = [
      { type: 'response.created', response: { id: responseId, status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
      { type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
      { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'BROKER_NATIVE_REPLY' },
      { type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text: 'BROKER_NATIVE_REPLY' },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id: responseId, status: 'completed', output: [item], usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 } } },
    ]
    return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
  } })
  const configOverrides = ['model_provider="fixture"', 'model="gpt-5.5"',
    `model_providers.fixture={name="fixture",base_url="http://127.0.0.1:${provider.port}/v1",wire_api="responses",requires_openai_auth=false}`,
    'analytics.enabled=false', 'feedback.enabled=false', 'check_for_update_on_startup=false', `projects.${JSON.stringify(cwd)}.trust_level="trusted"`]
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', TERM: 'xterm-256color', LANG: 'C.UTF-8', CODEX_HOME: codexHome }
  const transportOptions = { binary: 'codex', cwd, codexHome, env, configOverrides }
  let transport: ProjectControlTransport | undefined
  let broker: ProjectControlBroker | undefined
  let tui: ReturnType<typeof Bun.spawn> | undefined
  let output = ''
  try {
    // Materialize the disposable thread before attachment. This fixture seed is
    // not a production empty-thread creation strategy.
    transport = createProjectControlStdioTransport(transportOptions)
    let sequence = 0
    const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>()
    let completed = false
    transport.listen(raw => {
      const message = raw as Record<string, any>
      if (message.method === 'turn/completed') completed = true
      const entry = pending.get(message.id)
      if (!entry) return
      pending.delete(message.id)
      if (message.error) entry.reject(new Error('Native fixture RPC refused'))
      else entry.resolve(message.result)
    }, error => { for (const entry of pending.values()) entry.reject(error); pending.clear() })
    const call = (method: string, params: Record<string, unknown>): Promise<any> => new Promise((resolve, reject) => {
      const requestId = ++sequence
      pending.set(requestId, { resolve, reject })
      transport!.send({ id: requestId, method, params })
    })
    await call('initialize', { clientInfo: { name: 'broker-fixture', version: '1' }, capabilities: { experimentalApi: true, requestAttestation: false } })
    transport.send({ method: 'initialized' })
    const seed = await call('thread/start', { cwd, model: 'gpt-5.5', modelProvider: 'fixture', approvalPolicy: 'never', sandbox: 'read-only' })
    const threadId: string = seed.thread.id
    await call('turn/start', { threadId, input: [{ type: 'text', text: 'DISPOSABLE_SEED' }] })
    await until(() => completed, 'seed completion')
    transport.close()
    transport = createProjectControlStdioTransport(transportOptions)
    const requests: Record<string, unknown>[] = []
    const observed: ProjectControlTransport = {
      send(message) { requests.push(message); transport!.send(message) },
      listen(message, disconnect) { transport!.listen(message, disconnect) }, close() { transport!.close() },
    }
    const socketPath = join(dir, 'control.sock')
    broker = await createProjectControlBroker({ socketPath, cwd, codexHome, threadId, upstream: observed })
    tui = Bun.spawn(['codex', '--remote', `unix://${socketPath}`, ...configOverrides.flatMap(value => ['-c', value]), 'resume', threadId], {
      cwd, env, terminal: { cols: 100, rows: 30, data(terminal, bytes) {
        const chunk = new TextDecoder().decode(bytes)
        output += chunk
        if (chunk.includes('\x1b[6n')) terminal.write('\x1b[1;1R')
      } },
    })
    await until(() => requests.some(message => message.method === 'thread/resume') && broker?.state().phase === 'idle', 'native TUI resume')
    await until(() => output.includes('BROKER_NATIVE_REPLY'), 'native history render')
    const beforeNativeTurn = output.length
    tui.terminal!.write('NATIVE_BROKER_MARKER')
    await new Promise(resolve => setTimeout(resolve, 250))
    tui.terminal!.write('\r')
    await until(() => inputs.some(input => input.includes('NATIVE_BROKER_MARKER')), 'native input through broker')
    await until(() => broker?.state().phase === 'idle' && output.slice(beforeNativeTurn).includes('BROKER_NATIVE_REPLY'), 'native completion render')
    const gateway = broker.gateway('smoke-gateway')
    const epoch = broker.state().epoch
    const sentBeforeRefusal = requests.filter(message => message.method === 'turn/start').length
    let refused = false
    try {
      await gateway.request('turn/start', { threadId, input: [{ type: 'text', text: 'FORBIDDEN_ENVIRONMENT_MARKER' }],
        environments: [{ environmentId: 'local', cwd: foreign, runtimeWorkspaceRoots: [foreign] }],
      }, epoch)
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('scope')) throw error
      refused = true
    }
    if (!refused) {
      await until(() => broker?.state().phase === 'idle', 'bypass native completion')
      const snapshot = await gateway.request('thread/read', { threadId }) as { thread: { cwd: string; environments?: unknown } }
      process.stderr.write(`BYPASS: native thread after foreign environment mutation ${JSON.stringify(snapshot.thread.environments)}\n`)
      throw new Error('Foreign environment reached native app-server')
    }
    assert.equal(requests.filter(message => message.method === 'turn/start').length, sentBeforeRefusal)
    assert.equal(broker.state().epoch, epoch)
    assert(inputs.every(input => !input.includes('FORBIDDEN_ENVIRONMENT_MARKER')))
    await gateway.request('turn/start', { threadId, input: [{ type: 'text', text: 'GATEWAY_BROKER_MARKER' }],
      environments: [{ environmentId: 'local', cwd, runtimeWorkspaceRoots: [cwd] }],
    }, epoch)
    await until(() => broker?.state().phase === 'idle' && inputs.some(input => input.includes('GATEWAY_BROKER_MARKER')), 'gateway with attached TUI')
    await until(() => output.includes('GATEWAY_BROKER_MARKER'), 'gateway turn rendered in native TUI')
    assert(inputs.at(-1)?.includes('NATIVE_BROKER_MARKER'))
    assert(inputs.at(-1)?.includes('DISPOSABLE_SEED'))
    const finalSnapshot = await gateway.request('thread/read', { threadId, includeTurns: false }) as { thread: { cwd: string; environments: unknown } }
    assert.equal(finalSnapshot.thread.cwd, cwd)
    assert.deepEqual(finalSnapshot.thread.environments, [{ environmentId: 'local', cwd, runtimeWorkspaceRoots: [cwd] }])
    assert(requests.filter(message => message.method === 'initialize').length === 1)
    assert(requests.filter(message => message.method === 'turn/start').length === 2)
    assert(requests.filter(message => message.method === 'turn/start').every(message => (message.params as Record<string, unknown>).threadId === threadId))
    const oldEpoch = broker.state().epoch
    const oldGeneration = broker.state().generation
    tui.kill(); await tui.exited; tui.terminal?.close(); tui = undefined
    broker.close()
    transport = createProjectControlStdioTransport(transportOptions)
    broker = await createProjectControlBroker({ socketPath, cwd, codexHome, threadId, upstream: observed })
    assert.equal(broker.state().generation, oldGeneration + 1)
    const recovered = broker.gateway('recovered-gateway')
    await assert.rejects(recovered.request('thread/settings/update', { threadId, model: 'gpt-5.5' }, oldEpoch), /Stale/)
    await recovered.request('thread/resume', { threadId, cwd }, broker.state().epoch)
    await until(() => broker?.state().phase === 'idle', 'recovered resume')
    await recovered.request('turn/start', { threadId, input: [{ type: 'text', text: 'RECOVERED_BROKER_MARKER' }] }, broker.state().epoch)
    await until(() => broker?.state().phase === 'idle' && inputs.some(input => input.includes('RECOVERED_BROKER_MARKER')), 'recovered native completion')
    for (const marker of ['DISPOSABLE_SEED', 'NATIVE_BROKER_MARKER', 'GATEWAY_BROKER_MARKER']) assert(inputs.at(-1)?.includes(marker))
    process.stdout.write('PASS: scope fencing, native TUI and gateway shared one thread; restart fenced stale epoch and retained native history; local provider only.\n')
  } catch (error) {
    process.stderr.write(`${output.slice(-4000).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')}\n`)
    throw error
  } finally {
    tui?.kill(); tui?.terminal?.close()
    broker?.close(); transport?.close(); provider.stop(true)
    rmSync(dir, { recursive: true, force: true })
  }
}

if (import.meta.main) await run()
