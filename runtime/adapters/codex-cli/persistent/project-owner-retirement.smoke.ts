/** Disposable native owner retirement/resume proof. No account or live workspace.
 * bun run runtime/adapters/codex-cli/persistent/project-owner-retirement.smoke.ts
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { bootstrapCodexOwner, readCodexOwnerBinding } from './project-control-bootstrap.ts'
import { helperIdentity } from './project-owner-helper-protocol.ts'
import { nextOwnerDirectory, readCompletedOwnerRetirement } from './project-owner-retirement.ts'

const wait = async (predicate: () => boolean) => {
  const end = Date.now() + 20_000
  while (!predicate()) { if (Date.now() >= end) throw new Error('Native retirement smoke timed out'); await Bun.sleep(25) }
}

async function worker() {
  const options = JSON.parse(await Bun.stdin.text()) as Parameters<typeof bootstrapCodexOwner>[0]
  let screen = ''
  const owner = await bootstrapCodexOwner({ ...options, onTerminalData(bytes) { screen += new TextDecoder().decode(bytes) } }).catch(error => {
    process.stderr.write(`Native fixture terminal before failure:\n${screen.slice(-5000).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')}\n`)
    throw error
  })
  try {
    const facts = readCodexOwnerBinding(owner.binding)
    if (!options.resume) {
      const empty = await owner.retire!(owner.broker.state().epoch)
      assert.equal(empty.status, 'unknown', JSON.stringify(empty))
      assert.equal(readCodexOwnerBinding(owner.binding).threadId, facts.threadId)
    }
    const writer = owner.broker.gateway('retirement-fixture')
    await writer.request('turn/start', { threadId: facts.threadId,
      input: [{ type: 'text', text: options.resume ? 'RESUMED_OWNER_INPUT' : 'ORIGINAL_OWNER_INPUT' }] }, owner.broker.state().epoch)
    const busy = await owner.retire!(owner.broker.state().epoch)
    assert.equal(busy.status, 'busy', JSON.stringify(busy))
    await wait(() => owner.broker.state().phase === 'idle')
    const result = await owner.retire!(owner.broker.state().epoch)
    assert.equal(result.status, 'retired', JSON.stringify(result))
    if (result.status !== 'retired') throw new Error('retirement did not complete')
    const state = options.ownerStateDirectory ?? options.codexHome
    const helper = helperIdentity()
    writeFileSync(join(state, '.neutron-owner-authority.json'), JSON.stringify({ facts, helper }), { flag: 'wx', mode: 0o600 })
    writeFileSync(join(state, '.neutron-owner-retired.json'), JSON.stringify({ ...result.receipt, helper }), { flag: 'wx', mode: 0o600 })
    process.stdout.write(JSON.stringify({ status: result.status, resumed: !!options.resume }) + '\n')
  } finally { await owner.close() }
}

async function run() {
  const dir = mkdtempSync('/tmp/owner-retirement-native-')
  const cwd = join(dir, 'p'), codexHome = join(dir, 'h')
  mkdirSync(cwd); mkdirSync(codexHome, { mode: 0o700 })
  // Acknowledge the native migration notice only in this disposable home, so
  // onboarding cannot block the real TUI before it attaches to the owner.
  writeFileSync(join(codexHome, 'config.toml'), '[notice.model_migrations]\n"gpt-5.5" = "gpt-6-sol"\n', { mode: 0o600 })
  const inputs: Record<string, any>[] = []
  const provider = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    inputs.push(await request.json() as Record<string, any>)
    // Keep the owner turn open long enough for the real denial control.
    await Bun.sleep(100)
    const item = { id: 'reply', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'RETIREMENT_REPLY', annotations: [] }] }
    const events = [
      { type: 'response.created', response: { id: 'fixture-response', status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id: 'fixture-response', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ]
    return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
  } })
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', TERM: 'xterm-256color', LANG: 'C.UTF-8', CODEX_HOME: codexHome }
  const options: Parameters<typeof bootstrapCodexOwner>[0] = { binary: 'codex', socketPath: join(codexHome, 'owner.sock'), cwd, codexHome, env,
    configOverrides: ['model_provider="fixture"', 'model="gpt-5.5"', 'features.multi_agent_v2=true',
      `model_providers.fixture={name="fixture",base_url="http://127.0.0.1:${provider.port}/v1",wire_api="responses",requires_openai_auth=false}`,
      'analytics.enabled=false', 'feedback.enabled=false', 'check_for_update_on_startup=false', `projects.${JSON.stringify(cwd)}.trust_level="trusted"`] }
  const execute = async (input: typeof options) => {
    const child = Bun.spawn([process.execPath, import.meta.path, 'worker'], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
    child.stdin.write(JSON.stringify(input)); child.stdin.end()
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    assert.equal(code, 0, `${stdout}\n${stderr}`)
    process.stdout.write(stdout)
  }
  try {
    await execute(options)
    const receipt = readCompletedOwnerRetirement(codexHome)
    assert(existsSync(receipt.facts.rolloutPath))
    const previousTranscript = readFileSync(receipt.facts.rolloutPath, 'utf8')
    const next = nextOwnerDirectory(receipt.facts)
    mkdirSync(next, { recursive: true, mode: 0o700 })
    await execute({ ...options, ownerStateDirectory: next, resume: { predecessorDirectory: codexHome, receipt } })
    const resumed = readCompletedOwnerRetirement(next)
    assert.equal(resumed.facts.threadId, receipt.facts.threadId)
    assert.equal(resumed.facts.sessionId, receipt.facts.sessionId)
    assert.equal(resumed.facts.rolloutPath, receipt.facts.rolloutPath)
    assert.notEqual(resumed.facts.bindingRevision, receipt.facts.bindingRevision)
    assert(readFileSync(receipt.facts.rolloutPath, 'utf8').startsWith(previousTranscript))
    const resumedInput = inputs.find(input => Array.isArray(input.tools) && JSON.stringify(input.input).includes('RESUMED_OWNER_INPUT'))
    assert(resumedInput && JSON.stringify(resumedInput.input).includes('ORIGINAL_OWNER_INPUT'))
    assert(resumedInput.tools.some((tool: any) => tool.name === 'collaboration'))
    assert(resumedInput.tools.some((tool: any) => tool.name === 'neutron_owner_mcp'))
    process.stdout.write('PASS: native busy refusal, exact exit, immutable predecessor and resumed same-thread history/native children/root MCP.\n')
  } finally { provider.stop(true); rmSync(dir, { recursive: true, force: true }) }
}

if (import.meta.main) {
  if (process.argv[2] === 'worker') await worker()
  else await run()
}
