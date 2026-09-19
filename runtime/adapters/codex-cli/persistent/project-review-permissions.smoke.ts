/** Isolated native permission spike. Uses a disposable home and local fixture only. */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createProjectControlStdioTransport } from './project-control-broker-transport.ts'
import { createProjectControlBroker, type ProjectControlBroker } from './project-control-broker.ts'

const root = mkdtempSync('/tmp/codex-review-permissions-')
const cwd = join(root, 'project'), codexHome = join(root, 'home'), stage = join(cwd, '.neutron', 'build-results', 'a'.repeat(64))
for (const path of [cwd, codexHome, stage]) mkdirSync(path, { recursive: true })
const targets = [join(cwd, 'sentinel'), join(root, 'unrelated-tmp'), join(codexHome, 'canonical'), join(stage, 'result.json')]
for (const path of targets) writeFileSync(path, 'before\n')
let spawned = false, childRound = 0, restoredRound = 0, grandchildSpawned = false, grandchildRequested = false
let releaseGrandchild!: () => void
const grandchildGate = new Promise<void>(resolve => { releaseGrandchild = resolve })
const requests: unknown[] = [], notifications: Record<string, any>[] = [], native: unknown[] = []
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(strings)
  return value && typeof value === 'object' ? Object.values(value).flatMap(strings) : []
}
const fixture = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const body = await request.json() as Record<string, unknown>
  requests.push(body)
  const input = strings(body.input)
  const child = input.some(text => text.startsWith('CHILD_REVIEW_PROBE'))
  if (input.some(text => text.startsWith('GRANDCHILD_REVIEW_PROBE'))) {
    grandchildRequested = true
    await grandchildGate
  }
  let item: Record<string, unknown> = { id: `answer-${requests.length}`, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'DONE', annotations: [] }] }
  if (child && childRound < targets.length + 2) {
    const round = childRound++
    const target = targets[round < 3 ? round : 3]!
    item = { id: `patch-${childRound}`, call_id: `patch-${childRound}`, type: 'custom_tool_call', namespace: 'functions', name: 'apply_patch',
      input: `*** Begin Patch\n*** Update File: ${target}\n@@\n-before\n+after\n*** End Patch` }
    if (round === 3) {
      const quote = (path: string): string => `'${path.replaceAll("'", "'\\''")}'`
      item = { id: 'shell-control', call_id: 'shell-control', type: 'function_call', namespace: 'functions', name: 'exec_command', arguments: JSON.stringify({
        cmd: [...targets.slice(0, 3).map(path => `printf forbidden > ${quote(path)}`),
          `ln -s ${quote(targets[0]!)} ${quote(join(stage, 'escape'))}`, `printf forbidden > ${quote(join(stage, 'escape'))}`,
          `printf shell-control > ${quote(join(stage, 'shell-control'))}`].join('; '), max_output_tokens: 1000,
      }) }
    } else if (round === 4) {
      item = { id: 'escalation-control', call_id: 'escalation-control', type: 'function_call', namespace: 'functions', name: 'exec_command',
        arguments: JSON.stringify({ cmd: `printf escalated > '${targets[0]}'`, sandbox_permissions: 'require_escalated', justification: 'Disposable forbidden fixture write.' }) }
    }
  } else if (child && !grandchildSpawned) {
    grandchildSpawned = true
    item = { id: 'grandchild-spawn', call_id: 'grandchild-spawn', type: 'function_call', namespace: 'collaboration', name: 'spawn_agent',
      arguments: JSON.stringify({ task_name: 'grandchild_probe', fork_turns: 'none', message: 'GRANDCHILD_REVIEW_PROBE: remain active until the fixture releases the model response' }) }
  } else if (!child && input.some(text => text === 'PARENT_RESTORED_PROBE') && restoredRound++ === 0) {
    item = { id: 'restored-patch', call_id: 'restored-patch', type: 'custom_tool_call', namespace: 'functions', name: 'apply_patch',
      input: `*** Begin Patch\n*** Update File: ${targets[0]}\n@@\n-before\n+owner-restored\n*** End Patch` }
  } else if (!child && input.some(text => text === 'PARENT_REVIEW_PROBE') && !spawned) {
    spawned = true
    item = { id: 'spawn', call_id: 'spawn', type: 'function_call', namespace: 'collaboration', name: 'spawn_agent',
      arguments: JSON.stringify({ task_name: 'permission_probe', fork_turns: 'none', message: 'CHILD_REVIEW_PROBE: deterministic native file permission control' }) }
  }
  const events = [
    { type: 'response.created', response: { id: `response-${requests.length}`, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress' } },
    ...(item.type === 'message' ? [
      { type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
      { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'DONE' },
      { type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text: 'DONE' },
    ] : []),
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: `response-${requests.length}`, status: 'completed', output: [item], usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 } } },
  ]
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
} })
const transportOptions = { binary: 'codex', cwd, codexHome,
  env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8', TERM: 'xterm-256color' },
  configOverrides: ['model_provider="fixture"', 'model="gpt-6-astra"', 'features.multi_agent_v2=true', 'features.code_mode=false',
    `model_providers.fixture={name="fixture",base_url="http://127.0.0.1:${fixture.port}/v1",wire_api="responses",requires_openai_auth=false}`,
    'analytics.enabled=false', 'feedback.enabled=false', 'check_for_update_on_startup=false',
    `projects.${JSON.stringify(cwd)}.trust_level="trusted"`],
}
let transport = createProjectControlStdioTransport(transportOptions)
let broker: ProjectControlBroker | undefined
let sequence = 0
const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>()
transport.listen(raw => {
  const message = raw as Record<string, any>
  if (message.method) notifications.push(message)
  const waiter = pending.get(message.id)
  if (!waiter) return
  pending.delete(message.id)
  if (message.error) waiter.reject(new Error(JSON.stringify(message.error)))
  else waiter.resolve(message.result)
}, error => { for (const waiter of pending.values()) waiter.reject(error); pending.clear() })
const call = (method: string, params: Record<string, unknown>): Promise<any> => new Promise((resolve, reject) => {
  const id = ++sequence
  pending.set(id, { resolve, reject })
  transport.send({ id, method, params })
})
async function until(check: () => boolean): Promise<void> {
  const end = Date.now() + 30_000
  while (!check()) { if (Date.now() > end) throw new Error('Native spike deadline expired'); await Bun.sleep(25) }
}
try {
  await call('initialize', { clientInfo: { name: 'review-permissions-fixture', version: '1' }, capabilities: { experimentalApi: true, requestAttestation: false } })
  transport.send({ method: 'initialized' })
  const started = await call('thread/start', { cwd, model: 'gpt-6-astra', modelProvider: 'fixture', approvalPolicy: 'never', sandbox: 'workspace-write' })
  const threadId = started.thread.id as string
  await call('turn/start', { threadId, sandboxPolicy: { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: true,
    excludeTmpdirEnvVar: false, excludeSlashTmp: false }, input: [{ type: 'text', text: 'SEED_REVIEW_PROBE' }] })
  await until(() => notifications.some(message => message.method === 'turn/completed' && message.params.threadId === threadId))
  transport.close()
  transport = createProjectControlStdioTransport(transportOptions)
  broker = await createProjectControlBroker({ socketPath: join(root, 'control.sock'), threadId, cwd, codexHome, upstream: {
    send(message) { native.push(message); transport.send(message) }, close() { transport.close() },
    listen(receive, disconnect) { transport.listen(raw => { native.push(raw); const message = raw as Record<string, any>; if (message.method) notifications.push(message); receive(raw) }, disconnect) },
  } })
  const gateway = broker.gateway('fixture')
  await gateway.request('thread/resume', { threadId, cwd }, broker.state().epoch)
  await gateway.request('thread/settings/update', { threadId, sandboxPolicy: { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: true,
    excludeTmpdirEnvVar: false, excludeSlashTmp: false } }, broker.state().epoch)
  const lease = await broker.reviewPermissions!({ stageDir: stage, network: false }, broker.state().epoch)
  const reviewTurn = await lease.start([{ type: 'text', text: 'PARENT_REVIEW_PROBE' }])
  await until(() => childRound === targets.length + 2 && requests.some(body => strings((body as Record<string, unknown>).input).some(text => text.includes('patch-6'))))
  await until(() => notifications.some(message => message.method === 'turn/completed' && message.params.threadId !== threadId))
  await until(() => notifications.some(message => message.method === 'turn/completed' && message.params.threadId === threadId && message.params.turn.id === reviewTurn.turnId))
  await until(() => grandchildRequested && notifications.some(message => message.params?.item?.agentPath === '/root/permission_probe/grandchild_probe'))
  const grandchildId = notifications.find(message => message.params?.item?.agentPath === '/root/permission_probe/grandchild_probe')!.params.item.agentThreadId as string
  assert(notifications.some(message => message.method === 'turn/started' && message.params.threadId === grandchildId), 'native grandchild started')
  assert(!notifications.some(message => message.method === 'turn/completed' && message.params.threadId === grandchildId), 'native grandchild outlives direct child and parent')
  assert.equal(readFileSync(targets[0]!, 'utf8'), 'before\n', 'repository write refused')
  assert.equal(readFileSync(targets[1]!, 'utf8'), 'before\n', 'unrelated temporary write refused')
  assert.equal(readFileSync(targets[2]!, 'utf8'), 'before\n', 'canonical host write refused')
  assert.equal(readFileSync(targets[3]!, 'utf8'), 'after\n', 'staged result write allowed')
  assert.equal(readFileSync(join(stage, 'shell-control'), 'utf8'), 'shell-control', 'actual subprocess can write its stage while other subprocess writes are denied')
  if (Bun.argv.includes('--pending-descendant')) {
    await assert.rejects(lease.restore(), /settlement/)
    assert.equal(broker.state().phase, 'closed', 'active native grandchild keeps the owner fenced')
    process.stdout.write('PASS: real native grandchild outlived direct child and parent; attempted restoration fenced the broker\n')
  } else {
    releaseGrandchild()
    await until(() => notifications.some(message => message.method === 'turn/completed' && message.params.threadId === grandchildId))
    await lease.restore()
    await assert.rejects(gateway.request('turn/start', { threadId, input: [{ type: 'text', text: 'PARENT_RESTORED_PROBE' }] }, broker.state().epoch))
    assert.equal(readFileSync(targets[0]!, 'utf8'), 'before\n', 'direct owner gateway cannot write before host release acknowledgement')
    await lease.release()
    assert.equal(broker.state().phase, 'idle')
    const next = await gateway.request('turn/start', { threadId, input: [{ type: 'text', text: 'PARENT_RESTORED_PROBE' }] }, broker.state().epoch) as { turn: { id: string } }
    await until(() => notifications.some(message => message.method === 'turn/completed' && message.params.threadId === threadId && message.params.turn.id === next.turn.id))
    assert.equal(readFileSync(targets[0]!, 'utf8'), 'owner-restored\n', 'restored owner can write the project again')
    process.stdout.write('PASS: native stage isolation; grandchild outlived direct child; the complete descendant tree settled before verified owner restoration\n')
  }
} catch (error) {
  writeFileSync('/tmp/codex-review-permissions-spike-evidence.json', JSON.stringify({ notifications, requests, native }, null, 2))
  throw error
} finally { broker?.close(); transport.close(); releaseGrandchild(); fixture.stop(true); rmSync(root, { recursive: true, force: true }) }
