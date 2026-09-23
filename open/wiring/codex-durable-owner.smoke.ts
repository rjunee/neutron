/** Explicit disposable Herdr/session + gateway-service SIGKILL proof. */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexOwnerBindings } from './codex-owner-binding.ts'
import { openDurableCodexOwner } from './codex-durable-owner.ts'
import { attachCodexOwner } from '@neutronai/runtime/adapters/codex-cli/persistent/project-control-bootstrap.ts'
import { helperIdentity, readOwnerHelperDescriptor, type HelperIdentity } from '@neutronai/runtime/adapters/codex-cli/persistent/project-owner-helper-protocol.ts'
import { createHerdrRpc } from '@neutronai/runtime/adapters/claude-code/persistent/herdr-client.ts'

async function until(predicate: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 45_000
  while (!await predicate()) { if (Date.now() >= deadline) throw new Error(`Timeout: ${label}`); await Bun.sleep(25) }
}
async function command(argv: string[]) {
  const p = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe' })
  const [out, error, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  if (code) throw new Error(`${argv[0]} failed: ${error}`)
  return out
}
async function gateway(configPath: string, phase: string) {
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  const bindings = new CodexOwnerBindings(async () => ({ cwd: config.cwd, codexHome: config.codexHome, credentialIdentity: 'fixture', env: config.env }),
    options => openDurableCodexOwner({ ...options, binary: config.binary, configOverrides: config.configOverrides, timeoutMs: 30_000 }))
  await bindings.reconcile(['durable-owner-fixture'])
  const errors: string[] = []
  let completed = false
  for await (const event of bindings.start('durable-owner-fixture', { prompt: phase, tools: [], model_preference: [], turn_absolute_ceiling_ms: 60_000 }).events) {
    if (event.kind === 'error') errors.push(event.message)
    if (event.kind === 'completion') completed = true
    if (event.kind === 'tool_call' && event.tool_name === 'codex_owner_question') {
      const state = await bindings.controls.state('durable-owner-fixture')
      writeFileSync(join(config.root, `${phase}.json`), JSON.stringify({ identity: helperIdentity(), state }), { mode: 0o600 })
      // Deliberately stay in the native approval; parent kills only this gateway.
    }
  }
  writeFileSync(join(config.root, `${phase}.json`), JSON.stringify({ identity: helperIdentity(), completed, errors }), { mode: 0o600 })
  setInterval(() => {}, 1000)
}
async function run() {
  const socketPath = process.env.CODEX_HELPER_TEST_HERDR_SOCKET
  const workspaceId = process.env.CODEX_HELPER_TEST_HERDR_WORKSPACE_ID
  assert(socketPath && socketPath.includes('/sessions/codex-owner-helper-probe/') && workspaceId, 'explicit isolated helper probe session required')
  const rpc = createHerdrRpc({ socketPath })
  const root = mkdtempSync(join(tmpdir(), 'codex-durable-open-'))
  const cwd = join(root, 'project'), codexHome = join(root, 'home')
  mkdirSync(cwd); mkdirSync(codexHome, { mode: 0o700 })
  writeFileSync(join(codexHome, 'project-owner.json'), JSON.stringify('durable-owner-fixture'), { mode: 0o600 })
  // Synthetic subscription-shaped tokens: the loopback model requires no auth.
  // Rotate every volatile token field between gateways without an OAuth request.
  const credentials = (revision: number, account = 'fixture-account') => ({ tokens: {
    account_id: account, access_token: `fixture-access-${revision}`, refresh_token: `fixture-refresh-${revision}`,
    id_token: [Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url'), Buffer.from(JSON.stringify({
      email: 'owner@example.test', sub: 'fixture-subject', exp: Math.floor(Date.now() / 1000) + 3600 + revision,
      'https://api.openai.com/auth': { chatgpt_account_id: account, chatgpt_plan_type: 'plus' },
    })).toString('base64url'), 'fixture'].join('.'),
  }, last_refresh: new Date(Date.now() + revision * 1000).toISOString() })
  writeFileSync(join(codexHome, 'auth.json'), JSON.stringify(credentials(1)), { mode: 0o600 })
  const inputs: string[] = []
  let ask = false
  const provider = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    inputs.push(await request.text())
    const item = ask ? { type: 'function_call', id: 'approval', call_id: 'approval', namespace: 'functions', name: 'exec_command',
      arguments: JSON.stringify({ cmd: `touch ${JSON.stringify(join(root, 'must-not-execute'))}`, sandbox_permissions: 'require_escalated', justification: 'Disposable pending approval proof.' }) }
      : { id: 'answer', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'DURABLE_REPLY', annotations: [] }] }
    const events = [{ type: 'response.created', response: { id: 'response', status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
      ...(ask ? [] : [{ type: 'response.content_part.added', item_id: 'answer', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
        { type: 'response.output_text.delta', item_id: 'answer', output_index: 0, content_index: 0, delta: 'DURABLE_REPLY' },
        { type: 'response.output_text.done', item_id: 'answer', output_index: 0, content_index: 0, text: 'DURABLE_REPLY' }]),
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id: 'response', status: 'completed', output: [item], usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 } } }]
    return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
  } })
  const configPath = join(root, 'config.json')
  writeFileSync(configPath, JSON.stringify({ root, cwd, codexHome, binary: Bun.which('codex'),
    env: { PATH: process.env.PATH, TERM: 'xterm-256color', LANG: 'C.UTF-8', HERDR_SOCKET_PATH: socketPath, HERDR_WORKSPACE_ID: workspaceId },
    configOverrides: ['model_provider="fixture"', 'model="gpt-5.5"',
      `model_providers.fixture={name="fixture",base_url="http://127.0.0.1:${provider.port}/v1",wire_api="responses",requires_openai_auth=false}`,
      'analytics.enabled=false', 'feedback.enabled=false', 'check_for_update_on_startup=false', `projects.${JSON.stringify(cwd)}.trust_level="trusted"`] }), { mode: 0o600 })
  const units: string[] = [], identities: HelperIdentity[] = [], gatewayIdentities: HelperIdentity[] = []
  let passed = false
  const descriptorPath = join(codexHome, '.neutron-owner-helper.json')
  async function start(phase: string) {
    const unit = `codex-open-gateway-probe-${randomBytes(6).toString('hex')}`; units.push(unit)
    await command(['systemd-run', '--user', `--unit=${unit}`, '--collect', '--property=Type=exec', process.execPath, import.meta.path, '--gateway', configPath, phase])
    await until(() => existsSync(join(root, `${phase}.json`)), phase)
    const report = JSON.parse(readFileSync(join(root, `${phase}.json`), 'utf8'))
    gatewayIdentities.push(report.identity)
    return { unit, report }
  }
  async function kill(record: Awaited<ReturnType<typeof start>>) {
    assert.deepEqual(helperIdentity(record.report.identity.pid), record.report.identity)
    assert.equal(Number((await command(['systemctl', '--user', 'show', '--property=MainPID', '--value', `${record.unit}.service`])).trim()), record.report.identity.pid)
    await command(['systemctl', '--user', 'kill', '--kill-whom=main', '--signal=SIGKILL', `${record.unit}.service`])
    await until(() => !existsSync(`/proc/${record.report.identity.pid}`), 'gateway exit')
  }
  try {
    const first = await start('BEFORE_RESTART'); assert(first.report.completed, JSON.stringify(first.report.errors))
    assert(!existsSync(join(codexHome, '.neutron-owner-work.json')), 'completed native turn must settle its host lease before restart')
    const before = readOwnerHelperDescriptor(descriptorPath)
    const tui = await rpc.call('pane.process_info', { pane_id: before.facts.paneHandle }) as { process_info: { shell_pid: number } }
    const children = readFileSync(`/proc/${before.helper.pid}/task/${before.helper.pid}/children`, 'utf8').trim().split(/\s+/).map(Number)
    const servers = children.filter(pid => readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('stdio://'))
    assert.equal(servers.length, 1)
    identities.push(before.helper, helperIdentity(tui.process_info.shell_pid), helperIdentity(servers[0]))
    for (const id of identities) assert(!readFileSync(`/proc/${id.pid}/cgroup`, 'utf8').includes(first.unit))
    await kill(first)
    const previousCredentialBytes = readFileSync(join(codexHome, 'auth.json'), 'utf8')
    writeFileSync(join(codexHome, 'auth.json'), JSON.stringify(credentials(2)), { mode: 0o600 })
    assert.notEqual(readFileSync(join(codexHome, 'auth.json'), 'utf8'), previousCredentialBytes)
    const second = await start('AFTER_RESTART'); assert(second.report.completed, JSON.stringify(second.report.errors))
    assert.deepEqual(readOwnerHelperDescriptor(descriptorPath), before)
    assert(inputs.some(input => input.includes('BEFORE_RESTART') && input.includes('AFTER_RESTART')), 'native conversation history survives')
    for (const id of identities) assert.deepEqual(helperIdentity(id.pid), id)
    await kill(second)
    for (const revision of [1, 2]) {
      writeFileSync(join(codexHome, 'auth.json'), JSON.stringify({ ...credentials(revision + 2), OPENAI_API_KEY: `metered-fixture-${revision}` }), { mode: 0o600 })
      const beforeKey = inputs.length
      const metered = await start(`MIXED_KEY_${revision}_MUST_REFUSE`)
      assert.equal(metered.report.completed, false); assert(metered.report.errors.length)
      assert.equal(inputs.length, beforeKey)
      await kill(metered)
    }
    writeFileSync(join(codexHome, 'auth.json'), JSON.stringify(credentials(3, 'different-account')), { mode: 0o600 })
    const beforeForeign = inputs.length
    const foreign = await start('FOREIGN_ACCOUNT_MUST_REFUSE')
    assert.equal(foreign.report.completed, false); assert(foreign.report.errors.length)
    assert.equal(inputs.length, beforeForeign)
    await kill(foreign)
    writeFileSync(join(codexHome, 'auth.json'), JSON.stringify(credentials(4)), { mode: 0o600 })
    ask = true
    const pending = await start('PENDING_APPROVAL'); assert.equal(pending.report.state.pending.length, 1)
    await kill(pending)
    const count = inputs.length
    const refused = await start('MUST_REFUSE'); assert.equal(refused.report.completed, false); assert(refused.report.errors.length)
    assert.equal(inputs.length, count); assert(!existsSync(join(root, 'must-not-execute')))
    for (const id of identities) assert.deepEqual(helperIdentity(id.pid), id)
    const stale = await attachCodexOwner({ descriptorPath, expected: before.facts })
    const current = await attachCodexOwner({ descriptorPath, expected: before.facts })
    try {
      await assert.rejects(stale.refreshState(), /Stale|grant/)
      assert.equal((await current.refreshState()).activeTurnId, pending.report.state.turnId)
    } finally { await stale.close(); await current.close() }
    passed = true
  } finally {
    for (const unit of units) await command(['systemctl', '--user', 'stop', `${unit}.service`]).catch(() => {})
    const panes: string[] = []
    const panePath = join(codexHome, '.neutron-owner-pane.json')
    if (existsSync(panePath)) panes.push(JSON.parse(readFileSync(panePath, 'utf8')).handle)
    if (existsSync(descriptorPath)) panes.push(JSON.parse(readFileSync(descriptorPath, 'utf8')).facts.paneHandle)
    for (const pane of panes) {
      try { await rpc.call('pane.close', { pane_id: pane }) }
      catch (error) { if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'pane_not_found') throw error }
    }
    await until(() => [...identities, ...gatewayIdentities].every(id => { try { return !isAlive(id) } catch { return false } }), 'owned processes stopped')
    provider.stop(true)
    if (passed) rmSync(root, { recursive: true, force: true })
    else process.stderr.write(`Probe diagnostics retained: ${root}\n`)
  }
  process.stdout.write('PASS: production durable launcher and Open owner consumer; exact helper/app-server/TUI/thread across gateway SIGKILL and simulated OAuth token refresh; changed account and mixed/changed API keys refused; resumed idle conversation; pending approval refuses replay; stale frontend refused. Pending approval recovery and a live OAuth refresh request are NOT claimed.\n')
}
function isAlive(id: HelperIdentity) {
  try { return JSON.stringify(helperIdentity(id.pid)) === JSON.stringify(id) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof Error && error.message === 'Owner helper identity unknown') return false; throw error }
}
if (import.meta.main) {
  if (process.argv[2] === '--gateway') await gateway(process.argv[3]!, process.argv[4]!)
  else await run()
}
