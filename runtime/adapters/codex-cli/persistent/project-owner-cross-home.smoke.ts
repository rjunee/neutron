/** Native transcript portability measurement, NOT an account-switch implementation.
 * Two disposable homes, a loopback fixture provider, no real credentials.
 * bun run runtime/adapters/codex-cli/persistent/project-owner-cross-home.smoke.ts
 */
import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { createProjectControlStdioTransport, type ProjectControlTransport } from './project-control-broker-transport.ts'

type Message = Record<string, any>

async function open(home: string, cwd: string, providerPort: number) {
  const transport = createProjectControlStdioTransport({ binary: 'codex', cwd, codexHome: home,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, CODEX_HOME: home,
      XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, TERM: 'xterm-256color', LANG: 'C.UTF-8' },
    configOverrides: ['model_provider="fixture"', 'model="gpt-5.5"', 'cli_auth_credentials_store="ephemeral"',
      `model_providers.fixture={name="fixture",base_url="http://127.0.0.1:${providerPort}/v1",wire_api="responses",requires_openai_auth=false}`,
      'analytics.enabled=false', 'feedback.enabled=false', 'check_for_update_on_startup=false'],
  })
  let sequence = 0
  const pending = new Map<number, { resolve(v: Message): void; reject(e: Error): void }>()
  const completed = new Set<string>()
  transport.listen(raw => {
    const message = raw as Message
    if (message.method === 'turn/completed') completed.add(message.params?.turn?.id)
    if (message.method && message.id !== undefined) {
      transport.send({ id: message.id, error: { code: -32000, message: 'Fixture refuses native requests' } })
      return
    }
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    if (message.error) request.reject(new Error(String(message.error.message)))
    else request.resolve(message.result)
  }, error => { for (const request of pending.values()) request.reject(error); pending.clear() })
  const request = (method: string, params: Message): Promise<Message> => new Promise((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Fixture RPC timed out: ${method}`)) }, 20_000)
    pending.set(id, { resolve(v) { clearTimeout(timer); resolve(v) }, reject(e) { clearTimeout(timer); reject(new Error(`${method}: ${e.message}`)) } })
    transport.send({ id, method, params })
  })
  try {
    await request('initialize', { clientInfo: { name: 'cross_home_fixture', version: '1' }, capabilities: { experimentalApi: true } })
    transport.send({ method: 'initialized' })
    return { transport, request, async turn(threadId: string, text: string) {
      const result = await request('turn/start', { threadId, input: [{ type: 'text', text }] })
      const deadline = Date.now() + 20_000
      while (!completed.has(result.turn.id)) {
        if (Date.now() > deadline) throw new Error('Fixture turn completion timed out')
        await Bun.sleep(20)
      }
    } }
  } catch (error) { transport.close(); await transport.exited; throw error }
}

async function main() {
  const root = mkdtempSync('/tmp/codex-cross-home-fixture-')
  const cwd = join(root, 'project'), firstHome = join(root, 'first'), secondHome = join(root, 'second')
  for (const directory of [cwd, firstHome, secondHome]) mkdirSync(directory, { mode: 0o700 })
  const requests: Message[] = []
  const provider = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    requests.push(await request.json() as Message)
    const item = { id: 'fixture-reply', type: 'message', status: 'completed', role: 'assistant',
      content: [{ type: 'output_text', text: 'FIXTURE_REPLY', annotations: [] }] }
    const events = [
      { type: 'response.created', response: { id: 'fixture-response', status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id: 'fixture-response', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ]
    return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
      { headers: { 'content-type': 'text/event-stream' } })
  } })
  const children = new Set<ProjectControlTransport>()
  try {
    const first = await open(firstHome, cwd, provider.port!)
    children.add(first.transport)
    const original = (await first.request('thread/start', { cwd, ephemeral: false, modelProvider: 'fixture', model: 'gpt-5.5' })).thread
    await first.turn(original.id, 'ORIGINAL_HOME_HISTORY')
    const observed = original
    assert.equal(typeof observed.path, 'string')
    first.transport.close()
    await first.transport.exited
    children.delete(first.transport)
    const transcript = readFileSync(observed.path, 'utf8')

    const sameHome = await open(firstHome, cwd, provider.port!)
    children.add(sameHome.transport)
    const same = (await sameHome.request('thread/resume', { threadId: original.id, cwd })).thread
    assert.equal(same.id, original.id)
    assert.equal(same.path, observed.path)
    sameHome.transport.close()
    await sameHome.transport.exited
    children.delete(sameHome.transport)
    process.stdout.write('CONTROL: a fresh process in the original home resumes the original thread.\n')

    const second = await open(secondHome, cwd, provider.port!)
    children.add(second.transport)
    await assert.rejects(second.request('thread/resume', { threadId: original.id, cwd }), /no rollout found/)
    process.stdout.write('CONTROL: a fresh home cannot resolve the old thread by ID alone.\n')
    await assert.rejects(second.request('thread/resume', { threadId: original.id, path: observed.path, cwd }), /no rollout found/)
    // Only the already-retired fixture transcript moves namespaces. No auth is
    // created or copied, and this is not production migration authority.
    const targetTranscript = join(secondHome, 'sessions', `handoff-${'a'.repeat(64)}`, basename(observed.path))
    mkdirSync(dirname(targetTranscript), { recursive: true, mode: 0o700 })
    copyFileSync(observed.path, targetTranscript)
    assert.equal(readFileSync(targetTranscript, 'utf8'), readFileSync(observed.path, 'utf8'))
    // The remote native TUI reads its resume candidate before opening it.
    const beforeResume = (await second.request('thread/read', { threadId: original.id, includeTurns: false })).thread
    assert.equal(beforeResume.id, original.id)
    assert.equal(beforeResume.path, targetTranscript)
    // The installed schema states path overrides threadId for a non-running thread.
    // This control proves why a successful RPC alone cannot attest owner identity.
    const resumed = (await second.request('thread/resume', {
      threadId: '00000000-0000-4000-8000-000000000000', path: targetTranscript, cwd,
    })).thread
    assert.equal(resumed.id, original.id)
    assert.equal(resumed.sessionId, observed.sessionId)
    assert.equal(resumed.path, targetTranscript)
    assert.equal(resumed.cwd, cwd)
    await second.turn(resumed.id, 'SECOND_HOME_CONTINUATION')
    const continuation = requests.find(request => JSON.stringify(request.input).includes('SECOND_HOME_CONTINUATION'))
    assert(continuation && JSON.stringify(continuation.input).includes('ORIGINAL_HOME_HISTORY'))
    assert(readFileSync(targetTranscript, 'utf8').startsWith(transcript))
    assert(!existsSync(join(firstHome, 'auth.json')) && !existsSync(join(secondHome, 'auth.json')))
    process.stdout.write('PASS: transcript migration, not a cross-home path alone, preserves native thread/session/history without credentials. No account authentication or production handoff is proven.\n')
  } finally {
    for (const child of children) child.close()
    await Promise.allSettled([...children].map(child => child.exited))
    provider.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
}

if (import.meta.main) await main()
