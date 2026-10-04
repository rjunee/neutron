import { afterEach, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { ReplSession } from '../repl-session.ts'
import { EventChannel } from '../event-channel.ts'
import { sink } from '../pool-state.ts'
import { getReplSinkInfo } from '../repl-sink.ts'
import { TurnIdEcho } from '../turn-id-echo.ts'

const registered: ReplSession[] = []
afterEach(() => { for (const session of registered.splice(0)) sink.unregisterIf(session.sessionId, session) })

function fixture() {
  const session = new ReplSession('native-failure', randomUUID(), randomUUID(), 'native-channel', '/tmp')
  registered.push(session)
  sink.register(session.sessionId, session)
  let settled = 0
  const turn = { channel: new EventChannel(), settled: false, settle: () => { settled++ },
    substrateInstanceId: 'fixture', sessionId: session.sessionId, turnId: session.nextTurnId() }
  session.activeTurn = turn
  const promptId = randomUUID()
  const prompt = { session_id: session.sessionId, hook_event_name: 'UserPromptSubmit', prompt_id: promptId,
    prompt: `<channel source="native-channel" session_id="${session.sessionId}" user="neutron" turn_id="${turn.turnId}">\nReadiness.\n</channel>` }
  const failure = { session_id: session.sessionId, hook_event_name: 'StopFailure', prompt_id: promptId,
    error: 'server_error', last_assistant_message: 'API Error: Connection dropped (ECONNRESET)' }
  return { session, turn, prompt, failure, settled: () => settled }
}

test('authenticated exact-generation terminal hook emits the native error once and no completion', async () => {
  const f = fixture()
  f.session.armNativeTurn(f.turn.turnId)
  const { port } = await getReplSinkInfo()
  const post = async (body: unknown, token = sink.credentialFor(f.session)) => fetch(`http://127.0.0.1:${port}/native-turn`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Sink-Token': token }, body: JSON.stringify(body),
  })
  expect((await post(f.prompt, 'unregistered-generation')).status).toBe(401)
  expect(await (await post(f.failure)).json()).toEqual({ status: 'ignored' })
  expect(await (await post(f.prompt)).json()).toEqual({ status: 'bound' })
  expect(await (await post(f.failure)).json()).toEqual({ status: 'failed' })
  expect(await (await post(f.failure)).json()).toEqual({ status: 'ignored' })
  expect(await Array.fromAsync(f.turn.channel)).toEqual([
    { kind: 'error', message: 'API Error: Connection dropped (ECONNRESET)', retryable: false },
  ])
  expect(f.settled()).toBe(1)
  expect(f.session.poisoned).toBe(false)
})

test.each(['unarmed', 'startup', 'history', 'quoted', 'batched', 'wrong-session', 'wrong-prompt', 'child', 'retry', 'working', 'fenced', 'replacement', 'unrelated-prompt'])(
  '%s evidence cannot end the active turn; a correlated reply still succeeds', async mode => {
    const f = fixture()
    if (mode !== 'unarmed') f.session.armNativeTurn(f.turn.turnId)
    let prompt = { ...f.prompt }
    if (mode === 'startup') prompt.prompt = 'Startup readiness'
    if (mode === 'history') prompt.prompt = prompt.prompt.replace(f.turn.turnId, 'old-incarnation:1')
    if (mode === 'quoted') prompt.prompt = `The log quoted: ${prompt.prompt}`
    if (mode === 'batched') prompt.prompt += `\n${prompt.prompt.replace(f.turn.turnId, 'other:1')}`
    f.session.onNativeTurnHook(prompt)
    const failure: Record<string, unknown> = { ...f.failure }
    if (mode === 'wrong-session') failure['session_id'] = randomUUID()
    if (mode === 'wrong-prompt') failure['prompt_id'] = randomUUID()
    if (mode === 'child') failure['agent_id'] = 'background-child'
    if (mode === 'retry') failure['hook_event_name'] = 'Notification'
    if (mode === 'working') failure['hook_event_name'] = 'UserPromptSubmit'
    if (mode === 'fenced') f.session.fenced = true
    if (mode === 'replacement') f.session.activeTurn = { ...f.turn, turnId: f.session.nextTurnId() }
    if (mode === 'unrelated-prompt') f.session.onNativeTurnHook({ ...f.prompt, prompt_id: randomUUID(), prompt: 'Background work reports back' })
    expect(f.session.onNativeTurnHook(failure)).toBe('ignored')
    expect(f.turn.channel.closed).toBe(false)
    expect(f.settled()).toBe(0)
    f.session.fenced = false
    f.session.activeTurn = f.turn
    f.session.onReply('Still the real reply.', f.turn.turnId)
    const events = await Array.fromAsync(f.turn.channel)
    expect(events.map(event => event.kind)).toEqual(['token', 'completion'])
    expect(f.settled()).toBe(1)
  },
)

test('foreign generation cannot bind or fail the replacement with the same native session ID', async () => {
  const f = fixture()
  const oldCredential = sink.credentialFor(f.session)
  const replacement = new ReplSession('replacement', randomUUID(), f.session.sessionId, 'native-channel', '/tmp')
  registered.push(replacement)
  sink.register(replacement.sessionId, replacement)
  replacement.activeTurn = f.turn
  replacement.armNativeTurn(f.turn.turnId)
  const { port } = await getReplSinkInfo()
  for (const body of [f.prompt, f.failure]) {
    const response = await fetch(`http://127.0.0.1:${port}/native-turn`, { method: 'POST',
      headers: { 'X-Sink-Token': oldCredential }, body: JSON.stringify(body) })
    expect(response.status).toBe(401)
  }
  expect(f.turn.channel.closed).toBe(false)
  expect(f.settled()).toBe(0)
})

test('exact error retirement preserves older stale-reply debt and rejects foreign turns', () => {
  const echo = new TurnIdEcho()
  echo.onInject('old:1')
  echo.onInject('current:2')
  expect(echo.onTerminalFailure('foreign:2')).toBe(false)
  expect(echo.onTerminalFailure('current:2')).toBe(true)
  expect(echo.staleReplyDebt).toBe(1)
  echo.onInject('current:3')
  expect(echo.onTerminalFailure('current:2')).toBe(true)
  expect(echo.staleReplyDebt).toBe(1)
  expect(echo.onReply()).toBeUndefined()
  expect(echo.onReply()).toBe('current:3')
})

test('real dev-channel authenticates retirement and echoes the next warm reply', async () => {
  const ready = Promise.withResolvers<number>()
  const reply = Promise.withResolvers<Record<string, unknown>>()
  const token = randomUUID()
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const body = await req.json() as Record<string, unknown>
    if (new URL(req.url).pathname === '/channel-ready') ready.resolve(body['channel_port'] as number)
    if (new URL(req.url).pathname === '/reply') reply.resolve(body)
    return Response.json({ status: 'ok' })
  } })
  const proc = Bun.spawn({ cmd: [process.execPath, fileURLToPath(new URL('../dev-channel.ts', import.meta.url))],
    env: { ...process.env, SINK_PORT: String(server.port), SINK_TOKEN: token,
      SESSION_ID: 'native-failure-fixture', CHANNEL_NAME: 'native-channel' },
    stdin: 'pipe', stdout: 'ignore', stderr: 'ignore' })
  try {
    const port = await ready.promise
    const post = (path: string, turnId: string, credential: string = token) => fetch(`http://127.0.0.1:${port}/${path}`, {
      method: 'POST', headers: { 'X-Sink-Token': credential, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Readiness.', turn_id: turnId }),
    })
    expect((await post('message', 'incarnation:1')).status).toBe(200)
    expect((await post('turn-ended', 'incarnation:1', 'foreign-generation')).status).toBe(401)
    expect((await post('turn-ended', 'foreign:1')).status).toBe(409)
    expect((await post('turn-ended', 'incarnation:1')).status).toBe(200)
    expect((await post('message', 'incarnation:2')).status).toBe(200)
    expect((await post('turn-ended', 'incarnation:1')).status).toBe(200)
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'reply', arguments: { text: 'Warm reply.' } } })}\n`)
    expect((await reply.promise)['turn_id']).toBe('incarnation:2')
  } finally {
    proc.stdin.end()
    proc.kill('SIGKILL')
    await proc.exited
    server.stop(true)
  }
}, 10_000)
