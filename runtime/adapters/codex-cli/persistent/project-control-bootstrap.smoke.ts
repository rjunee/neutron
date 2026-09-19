/** Manual consuming factory smoke; no live account or seeded turn.
 * bun run runtime/adapters/codex-cli/persistent/project-control-bootstrap.smoke.ts
 * Uses a disposable home, local provider and one native app-server. No seed turn.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bootstrapCodexOwner, readCodexOwnerBinding } from './project-control-bootstrap.ts'

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
  mkdirSync(cwd); mkdirSync(codexHome, { mode: 0o700 })
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

  let output = ''
  const options = { binary: 'codex', socketPath: join(dir, 'owner'), cwd, codexHome, env, configOverrides,
    onTerminalData(bytes: Uint8Array) { output += new TextDecoder().decode(bytes) } }
  let owner: Awaited<ReturnType<typeof bootstrapCodexOwner>> | undefined
  try {
    owner = await bootstrapCodexOwner(options)
    const facts = readCodexOwnerBinding(owner.binding)
    assert.equal(facts.cwd, cwd)
    assert.equal(facts.codexHome, codexHome)
    assert.equal(inputs.length, 0)
    assert(!existsSync(facts.rolloutPath))
    assert.throws(() => readCodexOwnerBinding({} as never), /Unattested/)
    assert.throws(() => readCodexOwnerBinding({ ...owner!.binding } as never), /Unattested/)
    await assert.rejects(bootstrapCodexOwner(options), /still live/)
    await assert.rejects(bootstrapCodexOwner({ ...options, socketPath: join(dir, 'other-socket') }), /still live/)
    const gateway = owner.broker.gateway('fixture-owner')
    for (const params of [
      { threadId: 'foreign', input: [] },
      { threadId: facts.threadId, cwd: dir, input: [] },
      { threadId: facts.threadId, environments: [{ environmentId: 'local', cwd: dir }], input: [] },
    ]) await assert.rejects(gateway.request('turn/start', params, owner.broker.state().epoch))
    await assert.rejects(gateway.request('turn/start', { threadId: facts.threadId, input: [] }, -1))
    assert.equal(inputs.length, 0)
    const prompt = 'FIRST_REAL_OWNER_MESSAGE\nwith ordinary multiline text'
    const observerModule = process.env.CODEX_OBSERVER_MODULE
    const observer = observerModule ? new (await import(observerModule)).CodexRolloutObserver({
      projectId: 'fixture-project', ...facts,
    }, prompt) : undefined
    const receipt = await gateway.request('turn/start', { threadId: facts.threadId, input: [{ type: 'text', text: prompt }] },
      owner.broker.state().epoch) as Rpc
    observer?.bindReceipt({ threadId: facts.threadId, turnId: receipt.turn.id, rolloutPath: facts.rolloutPath,
      bindingRevision: facts.bindingRevision })
    await until(() => output.includes('OWNER_BOOTSTRAP_REPLY') && owner!.broker.state().phase === 'idle', 'gateway reply in TUI')
    assert(inputs[0]!.includes('FIRST_REAL_OWNER_MESSAGE'))
    if (observer) {
      await until(() => { observer.read(); return observer.completed }, 'first native rollout')
      observer.close()
    }
    owner.writeTerminal('SECOND_REAL_TUI_MESSAGE')
    await Bun.sleep(100)
    owner.writeTerminal('\r')
    await until(() => inputs.some(input => input.includes('SECOND_REAL_TUI_MESSAGE')), 'TUI turn reached provider')
    await until(() => owner!.broker.state().phase === 'idle', 'TUI turn completed')
    const handle = owner.binding
    await owner.close()
    assert.throws(() => readCodexOwnerBinding(handle), /Stale|generation/)
    await assert.rejects(bootstrapCodexOwner(options), /explicit recovery/)
    console.log('PASS: owned authenticated TUI bootstrap, sealed binding, gateway and TUI turns, foreign/scope/stale/forged controls')
  } catch (error) {
    console.error(output.slice(-2000).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ''))
    throw error
  } finally {
    await owner?.close()
    provider.stop(true)
    rmSync(dir, { recursive: true, force: true })
  }
}
if (import.meta.main) await run()
