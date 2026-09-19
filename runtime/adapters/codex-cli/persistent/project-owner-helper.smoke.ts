/** Native durable-owner proof using an explicitly supplied isolated Herdr server.
 * CODEX_HELPER_TEST_HERDR_SOCKET=<test-session-socket> bun run <this file>
 * Creates only disposable panes and one transient user gateway service.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { attachCodexOwner, readCodexOwnerBinding } from './project-control-bootstrap.ts'
import { helperIdentity, readOwnerHelperDescriptor, type HelperIdentity } from './project-owner-helper-protocol.ts'
import { createHerdrRpc } from '../../claude-code/persistent/herdr-client.ts'
import { HerdrHost } from '../../claude-code/persistent/herdr-host.ts'

type Rpc = Record<string, any>
async function until(predicate: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 25_000
  while (!await predicate()) { if (Date.now() >= deadline) throw new Error(`Durable owner timeout: ${label}`); await Bun.sleep(25) }
}
async function command(argv: string[]) {
  const child = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw new Error(`Fixture command refused (${argv[0]}): ${stderr}`)
  return stdout
}
function stopped(recorded: HelperIdentity): boolean {
  const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
  assert(boot, 'process boot identity must remain observable')
  try {
    const stat = readFileSync(`/proc/${recorded.pid}/stat`, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    assert(fields[19] && /^\d+$/.test(fields[19]), 'process start identity must remain observable')
    return boot !== recorded.boot || fields[19] !== recorded.start || ['Z', 'X'].includes(fields[0]!)
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error }
}
async function gatewayChild(path: string, output: string) {
  writeFileSync(`${output}.starting`, JSON.stringify(helperIdentity()), { mode: 0o600 })
  await until(() => existsSync(path), 'owner helper publication')
  const descriptor = readOwnerHelperDescriptor(path)
  const owner = await attachCodexOwner({ descriptorPath: path, expected: descriptor.facts })
  await until(() => existsSync(`${output}.release`), 'parent releases first real turn')
  if (process.argv[5]) await consumeOpen(owner, 'BEFORE_GATEWAY_DEATH', process.argv[5])
  else {
    const writer = owner.broker.gateway('gateway-child')
    await writer.request('turn/start', { threadId: descriptor.facts.threadId, input: [{ type: 'text', text: 'BEFORE_GATEWAY_DEATH' }] }, owner.broker.state().epoch)
  }
  await until(() => owner.broker.state().phase === 'idle', 'first completed turn')
  writeFileSync(output, JSON.stringify({ identity: helperIdentity(), facts: readCodexOwnerBinding(owner.binding), state: owner.broker.state(), cgroup: readFileSync('/proc/self/cgroup', 'utf8') }), { mode: 0o600 })
  setInterval(() => {}, 1000)
}
async function consumeOpen(owner: Awaited<ReturnType<typeof attachCodexOwner>>, prompt: string, modulePath: string) {
  const { CodexOwnerBindings } = await import(modulePath)
  const facts = readCodexOwnerBinding(owner.binding)
  const bindings = new CodexOwnerBindings(async () => ({ cwd: facts.cwd, codexHome: facts.codexHome, env: {} }),
    async () => owner, readCodexOwnerBinding)
  let thread: string | undefined
  for await (const event of bindings.start('durable-owner-fixture', { prompt, tools: [], model_preference: [], turn_absolute_ceiling_ms: 25_000 }).events) {
    if (event.kind === 'error') throw new Error(event.message)
    if (event.kind === 'completion') thread = event.session?.id
  }
  assert.equal(thread, facts.threadId, 'actual Open consumer completed on the native owner thread')
}
async function run() {
  const socketPath = process.env.CODEX_HELPER_TEST_HERDR_SOCKET
  assert(socketPath && socketPath.includes('/sessions/codex-owner-helper-probe/'), 'explicit independent test Herdr session required')
  const workspaceId = process.env.CODEX_HELPER_TEST_HERDR_WORKSPACE_ID
  assert(workspaceId, 'explicit test workspace returned by Herdr is required')
  assert.equal(Bun.spawnSync(['codex', '--version']).stdout.toString().trim(), 'codex-cli 0.154.0')
  const rpc = createHerdrRpc({ socketPath })
  const dir = mkdtempSync(join(tmpdir(), 'durable-codex-owner-'))
  const cwd = join(dir, 'project'), codexHome = join(dir, 'home')
  mkdirSync(cwd); mkdirSync(codexHome, { mode: 0o700 })
  writeFileSync(join(codexHome, 'project-owner.json'), JSON.stringify('durable-owner-fixture'), { mode: 0o600 })
  const inputs: string[] = []
  const provider = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    inputs.push(await request.text())
    const text = `DURABLE_NATIVE_REPLY_${inputs.length}`
    const item = { id: `answer-${inputs.length}`, type: 'message', status: 'completed', role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }] }
    const events = [
      { type: 'response.created', response: { id: 'durable-response', status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
      { type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
      { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: text },
      { type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id: 'durable-response', status: 'completed', output: [item], usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 } } },
    ]
    return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
  } })
  const config = join(dir, 'launch.json'), descriptorPath = join(codexHome, '.neutron-owner-helper.json')
  const launch = { projectId: 'durable-owner-fixture', binary: Bun.which('codex'), socketPath: join(dir, 'broker.sock'), cwd, codexHome,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', TERM: 'xterm-256color', LANG: 'C.UTF-8' }, timeoutMs: 25_000,
    configOverrides: ['model_provider="fixture"', 'model="gpt-5.5"',
      `model_providers.fixture={name="fixture",base_url="http://127.0.0.1:${provider.port}/v1",wire_api="responses",requires_openai_auth=false}`,
      'analytics.enabled=false', 'feedback.enabled=false', 'check_for_update_on_startup=false',
      `projects.${JSON.stringify(cwd)}.trust_level="trusted"`] }
  const unit = `codex-owner-gateway-probe-${randomBytes(6).toString('hex')}`
  let helperPane: string | undefined, tuiPane: string | undefined
  let owner: Awaited<ReturnType<typeof attachCodexOwner>> | undefined
  let serviceCreated = false
  let identities: HelperIdentity[] = []
  let completed = false
  try {
    const reportPath = join(dir, 'gateway.json')
    await command(['systemd-run', '--user', `--unit=${unit}`, '--collect', '--property=Type=exec', process.execPath, import.meta.path,
      '--gateway-child', descriptorPath, reportPath, process.env.CODEX_OWNER_OPEN_BINDING_MODULE ?? ''])
    serviceCreated = true
    await until(() => existsSync(`${reportPath}.starting`), 'gateway service identity')
    const gatewayIdentity = JSON.parse(readFileSync(`${reportPath}.starting`, 'utf8')) as HelperIdentity
    assert.deepEqual(helperIdentity(gatewayIdentity.pid), gatewayIdentity)
    assert(readFileSync(`/proc/${gatewayIdentity.pid}/cgroup`, 'utf8').includes(`${unit}.service`))
    writeFileSync(config, JSON.stringify({ ...launch, gatewayIdentity }), { mode: 0o600 })
    const layout = await rpc.call('layout.apply', { workspace_id: workspaceId, focus: false, root: { type: 'pane', label: 'durable-codex-owner-helper',
      command: [process.execPath, new URL('./project-owner-helper-main.ts', import.meta.url).pathname, config], cwd,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } } }) as Rpc
    helperPane = layout.layout.root.pane_id
    await until(() => existsSync(descriptorPath), 'helper native binding')
    const descriptor = readOwnerHelperDescriptor(descriptorPath)
    tuiPane = descriptor.facts.paneHandle
    const tui = await rpc.call('pane.process_info', { pane_id: tuiPane }) as Rpc
    const tuiIdentity = helperIdentity(tui.process_info.shell_pid)
    const children = readFileSync(`/proc/${descriptor.helper.pid}/task/${descriptor.helper.pid}/children`, 'utf8').trim().split(/\s+/).map(Number)
    const appServers = children.filter(pid => readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('stdio://'))
    assert.equal(appServers.length, 1)
    identities = [descriptor.helper, tuiIdentity, helperIdentity(appServers[0])]
    assert.equal(inputs.length, 0, 'no seed turn')
    writeFileSync(`${reportPath}.release`, 'release', { mode: 0o600 })
    await until(() => existsSync(reportPath), 'gateway service consuming turn')
    const before = JSON.parse(readFileSync(reportPath, 'utf8')) as { identity: HelperIdentity; facts: typeof descriptor.facts; state: Rpc; cgroup: string }
    assert(before.cgroup.includes(`${unit}.service`))
    for (const identity of identities) {
      assert.deepEqual(helperIdentity(identity.pid), identity)
      assert(!readFileSync(`/proc/${identity.pid}/cgroup`, 'utf8').includes(`${unit}.service`), 'owner must be outside gateway service cgroup')
    }
    const mainPid = Number((await command(['systemctl', '--user', 'show', '--property=MainPID', '--value', `${unit}.service`])).trim())
    assert.equal(mainPid, before.identity.pid, 'kill targets exactly the gateway service process we observed')
    await command(['systemctl', '--user', 'kill', '--kill-whom=main', '--signal=SIGKILL', `${unit}.service`])
    await until(() => !existsSync(`/proc/${before.identity.pid}`), 'gateway process killed')
    for (const identity of identities) assert.deepEqual(helperIdentity(identity.pid), identity)
    for (const patch of [{ threadId: 'foreign' }, { sessionId: 'foreign' }, { brokerGeneration: descriptor.facts.brokerGeneration + 1 }, { bindingRevision: 'forged' }]) {
      await assert.rejects(attachCodexOwner({ descriptorPath, expected: { ...descriptor.facts, ...patch } }), /mismatch/)
    }
    const rejected = await fetch('http://localhost/owner', { unix: descriptor.socketPath, method: 'POST', body: '{}' })
    assert.equal(rejected.status, 403)
    const forged = await fetch('http://localhost/owner', { unix: descriptor.socketPath, method: 'POST',
      headers: { authorization: `Bearer ${descriptor.token}` },
      body: JSON.stringify({ operation: 'attach', expected: { ...descriptor.facts, sessionId: 'foreign' }, challenge: randomBytes(32).toString('hex') }) })
    assert.equal(forged.status, 409, 'helper itself refuses wrong native identity')
    for (const headers of [{ authorization: 'Bearer foreign' }, { authorization: `Bearer ${descriptor.token}`, origin: 'http://foreign.test' }]) {
      assert.equal((await fetch('http://localhost/owner', { unix: descriptor.socketPath, method: 'POST', headers, body: '{}' })).status, 403)
    }
    owner = await attachCodexOwner({ descriptorPath, expected: before.facts })
    assert.deepEqual(readCodexOwnerBinding(owner.binding), before.facts)
    assert.equal(owner.broker.state().generation, before.state.generation)
    const writer = owner.broker.gateway('after-restart')
    await assert.rejects(writer.request('turn/start', { threadId: 'foreign', input: [] }, owner.broker.state().epoch))
    if (process.env.CODEX_OWNER_OPEN_BINDING_MODULE) await consumeOpen(owner, 'AFTER_GATEWAY_DEATH', process.env.CODEX_OWNER_OPEN_BINDING_MODULE)
    else await writer.request('turn/start', { threadId: before.facts.threadId, input: [{ type: 'text', text: 'AFTER_GATEWAY_DEATH' }] }, owner.broker.state().epoch)
    await until(() => owner!.broker.state().phase === 'idle', 'same-owner second turn')
    assert(inputs[1]!.includes('BEFORE_GATEWAY_DEATH') && inputs[1]!.includes('AFTER_GATEWAY_DEATH'), 'same native conversation')
    const host = new HerdrHost({ connect: async () => rpc })
    const terminal = await host.attach(tuiPane, { cwd, env: {}, onScreen() {} })
    try { terminal.beginOutput?.(); await terminal.submitLine!('DIRECT_NATIVE_TUI_AFTER_RESTART') }
    finally { terminal.detach?.() }
    await until(() => inputs.length === 3 && owner!.broker.state().phase === 'idle', 'actual Herdr native TUI turn')
    assert(inputs[2]!.includes('DIRECT_NATIVE_TUI_AFTER_RESTART'))
    await until(async () => {
      const screen = await rpc.call('pane.read', { pane_id: tuiPane, source: 'recent_unwrapped', lines: 200 }) as Rpc
      return typeof screen.read?.text === 'string' && screen.read.text.includes('DURABLE_NATIVE_REPLY_3')
    }, 'native reply rendered in its actual Herdr pane')
    for (const identity of identities) assert.deepEqual(helperIdentity(identity.pid), identity)
    const stale = owner
    owner = await attachCodexOwner({ descriptorPath, expected: before.facts })
    await assert.rejects(async () => stale.broker.gateway('stale').request('thread/read', { threadId: before.facts.threadId }), /Stale|grant/)
    await stale.close()
    completed = true
  } finally {
    await owner?.close()
    if (serviceCreated) await command(['systemctl', '--user', 'stop', `${unit}.service`]).catch(() => {})
    let cleanupCertain = true
    for (const pane of [helperPane, tuiPane]) {
      if (!pane) continue
      try {
        await rpc.call('pane.close', { pane_id: pane })
      } catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'pane_not_found') cleanupCertain = false }
      try { await rpc.call('pane.get', { pane_id: pane }); cleanupCertain = false }
      catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'pane_not_found') cleanupCertain = false }
    }
    try {
      await until(() => identities.every(stopped), 'owned native processes exit after scoped cleanup')
    } catch { cleanupCertain = false }
    provider.stop(true)
    process.stdout.write(`Cleanup: ${identities.length} recorded process identities and owned panes ${cleanupCertain ? 'verified stopped' : 'remain uncertain'}.\n`)
    if (completed && cleanupCertain) rmSync(dir, { recursive: true, force: true })
    else process.stderr.write(`Probe diagnostics retained: ${dir}\n`)
    if (!cleanupCertain) throw new Error('Owner probe cleanup uncertain; retained diagnostics, refusing successful exit')
  }
  process.stdout.write(`PASS: same native TUI/app-server/helper identities, thread/session/rollout/broker generation survive gateway service SIGKILL; second gateway turn and direct Herdr TUI turn; foreign/stale/unauthorized controls. Open consumer: ${process.env.CODEX_OWNER_OPEN_BINDING_MODULE ? 'before and after restart' : 'not exercised'}.\n`)
}
if (import.meta.main) {
  if (process.argv[2] === '--gateway-child') await gatewayChild(process.argv[3]!, process.argv[4]!)
  else await run()
}
