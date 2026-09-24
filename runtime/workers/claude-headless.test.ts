import { afterEach, expect, spyOn, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile, mkdir, symlink, unlink, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BoundedWorkRequest } from '../bounded-work.ts'
import { createHash } from 'node:crypto'
import { createClaudeHeadlessRunner } from './claude-headless.ts'
import { until, workerPlacementRig } from '../adapters/claude-code/persistent/__tests__/herdr-workspace-fake-server.ts'

const directories: string[] = []
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }) })
const flags = '--safe-mode --restricted --permission-prompts --permission-mode --tools --strict-mcp-config --mcp-config --disable-slash-commands --session-id --resume --setting-sources --model --effort --output-format --json-schema --add-dir'
function integrity(text: string) {
  const bytes = Buffer.from(text)
  let hash = 0x811c9dc5
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0
  return `${bytes.length}:${hash.toString(16).padStart(8, '0')}`
}

async function fixture(mode = 'success') {
  const root = await mkdtemp(join(tmpdir(), 'claude-headless-test-'))
  directories.push(root)
  const cwd = join(root, 'repo'), state = join(root, 'state')
  await mkdir(cwd); await mkdir(state)
  const cliPath = join(root, 'claude')
  const launched = join(root, 'launched.json')
  const counter = join(root, 'calls')
  // A process fixture exercises argv/stdin/environment, exit and durable receipts.
  // CLI capabilities are probed exactly as in production; no injected green probe.
  await writeFile(cliPath, `#!${process.execPath}
const {writeFileSync,appendFileSync,readFileSync}=require('node:fs');
const args=process.argv.slice(2);
if(args.includes('--help')) { writeFileSync(1,${JSON.stringify(mode === 'old-cli' ? flags.replace('--restricted', '') : flags)}); process.exit(0); }
if(args.includes('auth')) { writeFileSync(1,JSON.stringify({loggedIn:${mode !== 'no-auth'}})); process.exit(0); }
async function main() {
const prompt=readFileSync(0,'utf8');
writeFileSync(${JSON.stringify(join(state, 'provider.pid'))},String(process.pid));
writeFileSync(${JSON.stringify(launched)},JSON.stringify({args,prompt,env:process.env}));
appendFileSync(${JSON.stringify(counter)},'call\\n');
if(${JSON.stringify(mode)}==='hang') { setInterval(()=>{},1000); await new Promise(()=>{}); }
if(${JSON.stringify(mode)}==='hang-grandchild') {
  // A forked grandchild in the CLI's own process group that heartbeats forever.
  const g=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(`setInterval(()=>require('node:fs').writeFileSync(${JSON.stringify(join(root, 'heartbeat'))},String(Date.now())),20)`)}],{stdio:'ignore'});
  writeFileSync(${JSON.stringify(join(root, 'grandchild.pid'))},String(g.pid)); setInterval(()=>{},1000); await new Promise(()=>{}); }
if(${JSON.stringify(mode)}==='overflow') { writeFileSync(1,'x'.repeat(9*1024*1024)); process.exit(0); }
const req=JSON.parse(prompt.split('Request (data): ')[1].split('\\n')[0]);
let envelope={schema:req.result.schema,run_id:req.run_id,step_id:req.step_id,kind:'completed',result:{answer:'verified'}};
const mode=${JSON.stringify(mode)};
if(mode==='stale') envelope.step_id='another-step';
if(mode==='wrong-schema') envelope.schema='another-schema';
if(mode==='extra') envelope.usage={input_tokens:999};
if(mode==='invalid-payload') envelope.result={answer:42};
if(mode==='blocked') envelope={schema:req.result.schema,run_id:req.run_id,step_id:req.step_id,kind:'blocked',on:'Need source evidence.'};
const receipt={type:'result',subtype:'success',is_error:false,permission_denials:[],structured_output:envelope,
  session_id:args[args.indexOf(args.includes('--resume')?'--resume':'--session-id')+1],
  result:JSON.stringify(envelope),modelUsage:{[req.model_id]:{}},usage:{input_tokens:17,output_tokens:23,cache_read_input_tokens:11}};
if(mode==='text-only') delete receipt.structured_output;
if(mode==='error') receipt.is_error=true;
if(mode==='wrong-model') receipt.modelUsage={'claude-unrequested-model':{}};
if(mode==='class-model') receipt.modelUsage={['claude-'+req.model_id+'-fixture']:{}};
if(mode==='wrong-class') receipt.modelUsage={'claude-sonnet-fixture':{}};
if(mode==='wrong-session') receipt.session_id='00000000-0000-0000-0000-000000000000';
if(mode==='permission') receipt.permission_denials=[{tool_name:'AskUserQuestion'}];
if(mode==='no-permissions') delete receipt.permission_denials;
if(mode==='invalid-usage') receipt.usage={input_tokens:-1,output_tokens:0};
if(mode==='missing-usage') delete receipt.usage;
if(mode==='zero-usage') receipt.usage={input_tokens:0,output_tokens:0,cache_read_input_tokens:0,cache_creation_input_tokens:0};
writeFileSync(1,JSON.stringify(receipt));
writeFileSync(${JSON.stringify(join(state, 'receipt-ready'))},'ready');
if(mode==='usage-then-hang') { setInterval(()=>{},1000); await new Promise(()=>{}); }
if(mode==='exit-error') process.exit(2);
}
main();
`, { mode: 0o700 })
  const brief = 'Inspect the supplied evidence. Unicode: 🧭'
  const req: BoundedWorkRequest = { run_id: 'run-one', step_id: 'plan:1', role: 'plan', model_id: 'claude-test-model',
    effort: 'max', cwd, tools: 'edit-and-run', writable: true, network: true,
    brief: { path: join(state, 'brief'), integrity: integrity(brief) },
    result: { path: join(state, 'result'), schema: 'test-result' }, thread: null, budget: { wall_ms: 5000 }, needs_approval_decision: false }
  await writeFile(req.brief.path, brief)
  const options = { env: { PATH: '/usr/bin:/bin', HOME: root, GH_TOKEN: 'must-not-inherit',
    ANTHROPIC_BASE_URL: 'https://invalid.example', NODE_OPTIONS: '--trace-warnings',
    NEUTRON_REPLY_SINK: 'must-not-inherit', CLAUDE_CODE_OAUTH_TOKEN: 'selected-token' }, cwd, state_dir: state,
    schemas: new Map([['test-result', (value: unknown) => (value as { answer?: unknown })?.answer === 'verified']]), cliPath }
  const runner = createClaudeHeadlessRunner(options)
  return { root, cwd, state, req, runner, options, launched, counter, run: (request = req, signal = new AbortController().signal) => runner.run(request, 'headless', signal) }
}

for (const role of ['plan', 'review', 'synthesis'] as const) {
  test(`Claude ${role} recovery reads exact retained evidence without CLI invocation or reservation repair`, async () => {
    const f = await fixture()
    const req = { ...f.req, role }
    const signal = new AbortController().signal
    const snapshot = async () => Object.fromEntries(await Promise.all((await readdir(f.state)).sort()
      .map(async name => [name, await readFile(join(f.state, name), 'utf8')])))
    await writeFile(req.result.path, 'unowned previous result')
    const initial = await snapshot()
    const spawn = spyOn(Bun, 'spawn'), spawnSync = spyOn(Bun, 'spawnSync')
    try {
      expect((await f.runner.recover!(req, 'headless', signal)).kind).toBe('unknown')
      expect(spawn).not.toHaveBeenCalled()
      expect(spawnSync).not.toHaveBeenCalled()
      expect(await snapshot()).toEqual(initial)
      const first = await f.runner.run(req, 'headless', signal)
      expect(first.kind).toBe('completed')
      expect(spawn).toHaveBeenCalledTimes(1)
      const replacement = createClaudeHeadlessRunner(f.options)
      spawn.mockClear(); spawnSync.mockClear()
      const retained = await snapshot()
      expect(await replacement.recover!(req, 'headless', signal)).toEqual(first)
      const receipt = join(f.state, (await readdir(f.state)).find(name => /^claude-headless-receipt-.*\.json$/.test(name))!)
      const receiptBytes = await readFile(receipt, 'utf8')
      await unlink(receipt)
      const uncommitted = await snapshot()
      expect((await replacement.recover!(req, 'headless', signal)).kind).toBe('unknown')
      expect(await snapshot()).toEqual(uncommitted)
      await writeFile(receipt, receiptBytes)
      expect((await replacement.recover!({ ...req, model_id: 'claude-other-model' }, 'headless', signal)).kind).toBe('unknown')
      expect((await replacement.recover!({ ...req, network: !req.network }, 'headless', signal)).kind).toBe('unknown')
      expect(await snapshot()).toEqual(retained)
      // Completed receipt can restore only its own missing published result.
      await unlink(req.result.path)
      expect(await replacement.recover!(req, 'headless', signal)).toEqual(first)
      expect(await snapshot()).toEqual(retained)
      const reservation = join(f.state, (await readdir(f.state)).find(name => /^claude-step-/.test(name))!)
      for (const bytes of [JSON.stringify(req), 'corrupt', JSON.stringify({ ...req, model_id: 'foreign' }) + '\n#dispatch-armed\n']) {
        await writeFile(reservation, bytes)
        const before = await snapshot()
        expect((await replacement.recover!(req, 'headless', signal)).kind).toBe('unknown')
        expect(await snapshot()).toEqual(before)
      }
      await unlink(reservation)
      const lost = await snapshot()
      expect((await replacement.recover!(req, 'headless', signal)).kind).toBe('unknown')
      expect(await snapshot()).toEqual(lost)
      expect(await readFile(f.counter, 'utf8')).toBe('call\n')
      expect(spawn).not.toHaveBeenCalled()
      expect(spawnSync).not.toHaveBeenCalled()
    } finally { spawn.mockRestore(); spawnSync.mockRestore() }
  })
}

test('Claude host death after provider usage recovers spend before child completion without replay', async () => {
  const f = await fixture('usage-then-hang')
  const req = { ...f.req, budget: { wall_ms: 30_000 } }
  const hostPath = join(f.root, 'observation-host.ts')
  await writeFile(hostPath, `import {createClaudeHeadlessRunner} from ${JSON.stringify(import.meta.dir + '/claude-headless.ts')};\n` +
    `await createClaudeHeadlessRunner({...${JSON.stringify(f.options)},schemas:new Map([['test-result',(value)=>value?.answer==='verified']])}).run(${JSON.stringify(req)},'headless',new AbortController().signal);\n`)
  const host = Bun.spawn([process.execPath, hostPath], { stdout: 'ignore', stderr: 'ignore' })
  try {
    let observed
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      observed = await f.runner.observe!(req)
      if (observed?.usage.input_tokens === 17) break
      await Bun.sleep(10)
    }
    expect(observed?.usage.input_tokens).toBe(17)
    expect(host.exitCode).toBeNull()
    host.kill('SIGKILL'); await host.exited
    const runner = createClaudeHeadlessRunner(f.options)
    expect(await runner.observe!(req)).toEqual(observed)
    expect((await runner.run(req, 'headless', new AbortController().signal)).kind).toBe('unknown')
    expect(await readFile(f.counter, 'utf8')).toBe('call\n')
  } finally {
    host.kill('SIGKILL'); await host.exited
    try { process.kill(-Number(await readFile(join(f.state, 'provider.pid'), 'utf8')), 'SIGKILL') } catch { /* Gone or not started. */ }
  }
}, 10_000)

test('read-only recovery accepts the original symlink cwd and refuses a changed target', async () => {
  const f = await fixture()
  const alias = join(f.root, 'repo-link')
  await symlink(f.cwd, alias)
  const options = { ...f.options, cwd: alias }
  const runner = createClaudeHeadlessRunner(options)
  const request = { ...f.req, cwd: alias }
  const first = await runner.run(request, 'headless', new AbortController().signal)
  expect(first.kind).toBe('completed')
  expect(await runner.observe!(request)).toEqual(first.observation)
  await unlink(alias)
  const different = join(f.root, 'different-repo'); await mkdir(different); await symlink(different, alias)
  expect(await runner.observe!(request)).toBeUndefined()
  expect(await readFile(f.counter, 'utf8')).toBe('call\n')
})

for (const mode of ['exit-error', 'zero-usage'] as const) {
  test(`read-only observation recovery retains ${mode} without dispatch or lock changes`, async () => {
    const f = await fixture(mode)
    expect(await f.runner.observe!(f.req)).toBeUndefined()
    const first = await f.run()
    const before = await readdir(f.state)
    const calls = await readFile(f.counter, 'utf8')
    expect(await createClaudeHeadlessRunner(f.options).observe!(f.req)).toEqual(first.observation)
    expect((await f.runner.observe!(f.req))?.usage.input_tokens).toBe(mode === 'zero-usage' ? 0 : 17)
    expect(await f.runner.observe!({ ...f.req, model_id: 'claude-other' })).toBeUndefined()
    expect(await f.runner.observe!({ ...f.req, step_id: 'foreign' })).toBeUndefined()
    expect(await createClaudeHeadlessRunner({ ...f.options, env: { ...f.options.env, CLAUDE_CODE_OAUTH_TOKEN: 'different' } }).observe!(f.req)).toBeUndefined()
    expect(await readdir(f.state)).toEqual(before)
    expect(await readFile(f.counter, 'utf8')).toBe(calls)
  })
}

test('successful headless completion uses exact model, measured usage, isolated argv, stdin and host trailer', async () => {
  const f = await fixture()
  expect(await f.run()).toMatchObject({ kind: 'completed', result: { answer: 'verified' },
    usage: { input_tokens: 17, output_tokens: 23, cache_read_input_tokens: 11 }, model_reported: f.req.model_id, thread_id: expect.any(String) })
  const observed = JSON.parse(await readFile(f.launched, 'utf8'))
  for (const flag of ['--safe-mode', '--restricted', '--strict-mcp-config', '--disable-slash-commands', '--session-id']) expect(observed.args).toContain(flag)
  for (const [name, value] of [['--permission-prompts', 'none'], ['--permission-mode', 'dontAsk'], ['--tools', 'Read,Glob,Grep'], ['--mcp-config', '{"mcpServers":{}}'], ['--effort', 'max'], ['--model', f.req.model_id]]) {
    expect(observed.args[observed.args.indexOf(name) + 1]).toBe(value)
  }
  expect(observed.args).not.toContain('--dangerously-skip-permissions')
  expect(observed.args).not.toContain('--fallback-model')
  expect(observed.args.join(' ')).not.toContain('Inspect the supplied evidence')
  expect(observed.prompt).toContain('Unicode: 🧭')
  expect(observed.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('selected-token')
  expect(observed.env.CLAUDE_CONFIG_DIR).toBe(join(f.state, 'claude-headless-auth'))
  for (const key of ['GH_TOKEN', 'ANTHROPIC_BASE_URL', 'NODE_OPTIONS', 'NEUTRON_REPLY_SINK']) expect(observed.env[key]).toBeUndefined()
  expect(JSON.parse(await readFile(f.req.result.path, 'utf8'))).toEqual({ schema: f.req.result.schema,
    run_id: f.req.run_id, step_id: f.req.step_id, kind: 'completed', result: { answer: 'verified' } })
})

test('narrow role and placement admission has runnable positive controls', async () => {
  const f = await fixture()
  for (const role of ['plan', 'review', 'synthesis'] as const) expect(f.runner.supports(role, 'headless')).toEqual({ ok: true })
  expect(f.runner.supports('plan', 'in-repl')).toMatchObject({ ok: false, reason: 'placement-unavailable' })
  expect(f.runner.supports('build', 'headless')).toMatchObject({ ok: false, reason: 'capability-unsupported' })
  expect(await f.runner.run(f.req, 'in-repl', new AbortController().signal)).toMatchObject({ kind: 'refused' })
  for (const changes of [{ thread: { id: 'retained-session' } }, { model_id: 'unrequested-alias' }, { result: { ...f.req.result, schema: 'unregistered' } }]) {
    expect(await f.run({ ...f.req, ...changes })).toMatchObject({ kind: 'refused', reason: 'capability-unsupported' })
  }
  expect(await f.run()).toMatchObject({ kind: 'completed' })
})

test('credentials and installed CLI contract fail closed before admission', async () => {
  const f = await fixture()
  expect(createClaudeHeadlessRunner({ ...f.options, cliPath: join(f.root, 'missing-cli') }).supports('plan', 'headless')).toMatchObject({
    ok: false, reason: 'provider-not-connected', detail: 'Claude CLI is unavailable.',
  })
  expect(createClaudeHeadlessRunner({ ...f.options, env: {} }).supports('plan', 'headless')).toMatchObject({ ok: false, reason: 'provider-not-connected' })
  expect((await fixture('no-auth')).runner.supports('plan', 'headless')).toMatchObject({ ok: false, reason: 'provider-not-connected' })
  expect((await fixture('old-cli')).runner.supports('plan', 'headless')).toMatchObject({ ok: false, reason: 'cli-contract' })
  expect(f.runner.supports('plan', 'headless')).toEqual({ ok: true })
})

test('explicit model classes require reported concrete models in that same class', async () => {
  for (const model_id of ['opus', 'sonnet', 'haiku', 'fable']) {
    const f = await fixture('class-model')
    expect(await f.run({ ...f.req, model_id })).toMatchObject({ kind: 'completed', model_reported: `claude-${model_id}-fixture` })
  }
  const wrong = await fixture('wrong-class')
  expect(await wrong.run({ ...wrong.req, model_id: 'opus' })).toMatchObject({ kind: 'unknown' })
  await expect(readFile(wrong.req.result.path)).rejects.toMatchObject({ code: 'ENOENT' })
})

test('selected config credentials are bound by bytes and checked again on same-path rotation', async () => {
  const f = await fixture()
  const config = join(f.root, 'selected-config')
  await mkdir(config)
  const credentials = join(config, '.credentials.json')
  await writeFile(credentials, JSON.stringify({ account: 'fixture-account-a', token: 'fixture-token-a' }))
  const options = { ...f.options, env: { PATH: '/usr/bin:/bin', HOME: f.root, CLAUDE_CONFIG_DIR: config } }
  const runner = createClaudeHeadlessRunner(options)
  const first = await runner.run(f.req, 'headless', new AbortController().signal)
  if (first.kind !== 'completed' || !first.thread_id) throw Error('Expected selected config completion')
  const resumed = { ...f.req, step_id: 'review:2', thread: { id: first.thread_id } }
  expect(await createClaudeHeadlessRunner(options).run(resumed, 'headless', new AbortController().signal)).toMatchObject({ kind: 'completed', thread_id: first.thread_id })
  await writeFile(credentials, JSON.stringify({ account: 'fixture-account-b', token: 'fixture-token-b' }))
  const rotated = { ...resumed, step_id: 'review:3' }
  expect(await runner.run(rotated, 'headless', new AbortController().signal)).toMatchObject({ kind: 'refused' })
  expect(await createClaudeHeadlessRunner(options).run(rotated, 'headless', new AbortController().signal)).toMatchObject({ kind: 'refused' })
  expect(await readFile(f.counter, 'utf8')).toBe('call\ncall\n')
  await unlink(credentials)
  expect(createClaudeHeadlessRunner(options).supports('plan', 'headless')).toMatchObject({ ok: false, reason: 'provider-not-connected' })
})

for (const mode of ['text-only', 'stale', 'wrong-schema', 'invalid-payload', 'extra', 'error', 'wrong-model', 'wrong-session']) {
  test(`rejects ${mode} even when reply text contains a completed envelope`, async () => {
    const f = await fixture(mode)
    expect(await f.run()).toMatchObject({ kind: 'unknown' })
    await expect(readFile(f.req.result.path)).rejects.toMatchObject({ code: 'ENOENT' })
  })
}

test('blocked output has a durable honest sibling; attempted owner tool cannot complete', async () => {
  const blocked = await fixture('blocked')
  expect(await blocked.run()).toMatchObject({ kind: 'blocked', on: 'Need source evidence.',
    observation: { usage: { input_tokens: 17, output_tokens: 23 } } })
  expect(JSON.parse(await readFile(blocked.req.result.path, 'utf8')).kind).toBe('blocked')
  for (const mode of ['permission', 'no-permissions']) expect(await (await fixture(mode)).run()).toMatchObject({ kind: 'blocked' })
})

test('unknown usage stays unknown rather than becoming invented zero counters', async () => {
  const f = await fixture('invalid-usage')
  // The attested model is independent of the counts the CLI failed to report.
  expect(await f.run()).toMatchObject({ kind: 'completed', usage: null, model_reported: f.req.model_id })
})

test('provider usage survives rejected results, nonzero exit and observed interruption without authorizing completion', async () => {
  for (const mode of ['exit-error', 'invalid-payload', 'extra', 'usage-then-hang']) {
    const f = await fixture(mode)
    const req = mode === 'usage-then-hang' ? { ...f.req, budget: { wall_ms: 30_000 } } : f.req
    const controller = new AbortController()
    const pending = f.run(req, controller.signal)
    if (mode === 'usage-then-hang') {
      // Interrupt only after the child has emitted its provider receipt. A short
      // startup deadline would test machine load instead of usage preservation.
      while (!(await readFile(join(f.state, 'receipt-ready')).then(() => true, () => false))) {
        if (await Promise.race([pending.then(() => true), Bun.sleep(10).then(() => false)])) throw Error('Worker ended before emitting usage')
      }
      controller.abort()
    }
    const outcome = await pending
    expect(outcome.kind).toBe(mode === 'exit-error' || mode === 'usage-then-hang' ? 'failed' : 'unknown')
    expect(outcome.observation).toMatchObject({ source: 'claude-cli-json', model_reported: req.model_id,
      usage: { input_tokens: 17, output_tokens: 23, cache_read_input_tokens: 11 } })
    expect(outcome.observation!.finished_at_ms).toBeGreaterThanOrEqual(outcome.observation!.started_at_ms)
    await expect(readFile(req.result.path)).rejects.toMatchObject({ code: 'ENOENT' })
    const recovered = await createClaudeHeadlessRunner(f.options).run(req, 'headless', new AbortController().signal)
    expect(recovered.kind).toBe('unknown')
    expect(recovered.observation).toEqual(outcome.observation)
    expect(await readFile(f.counter, 'utf8')).toBe('call\n')
  }
})

test('successful telemetry distinguishes unknown and real zero without vetoing valid results', async () => {
  const missing = await (await fixture('missing-usage')).run()
  expect(missing).toMatchObject({ kind: 'completed', usage: null, observation: { usage: { input_tokens: null, output_tokens: null } } })
  const zero = await (await fixture('zero-usage')).run()
  expect(zero).toMatchObject({ kind: 'completed', observation: { usage: { input_tokens: 0, output_tokens: 0,
    cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } })
})

test('duplicate and restarted step reads the durable receipt without redispatch', async () => {
  const f = await fixture()
  const first = await f.run()
  expect(await f.run()).toEqual(first)
  expect(await createClaudeHeadlessRunner(f.options).run(f.req, 'headless', new AbortController().signal)).toEqual(first)
  expect(await readFile(f.counter, 'utf8')).toBe('call\n')
  await writeFile(f.req.result.path, '{}')
  const mismatched = await f.run()
  expect(mismatched).toMatchObject({ kind: 'unknown' })
  expect(mismatched.observation).toEqual(first.observation)
  expect(await readFile(f.counter, 'utf8')).toBe('call\n')
})

test('gateway death after receipt persistence reconstructs the missing result without dispatch', async () => {
  const f = await fixture()
  const first = await f.run()
  await unlink(f.req.result.path)
  expect(await createClaudeHeadlessRunner(f.options).run(f.req, 'headless', new AbortController().signal)).toEqual(first)
  expect(JSON.parse(await readFile(f.req.result.path, 'utf8')).result).toEqual({ answer: 'verified' })
  expect(await readFile(f.counter, 'utf8')).toBe('call\n')
})

test('receipt recovery refuses a live publishing host and recovers a dead host once', async () => {
  const f = await fixture()
  const first = await f.run()
  if (first.kind !== 'completed' || !first.thread_id) throw Error('Expected retained session')
  const key = createHash('sha256').update(JSON.stringify([f.req.run_id, f.req.step_id])).digest('hex')
  const lock = join(f.state, `claude-headless-thread-${first.thread_id}.json.busy`)
  const token = '11111111-1111-1111-1111-111111111111'
  await unlink(f.req.result.path)
  await writeFile(lock, JSON.stringify({ key, pid: process.pid, token }))
  const locked = await f.run()
  expect(locked).toMatchObject({ kind: 'unknown' })
  expect(locked.observation).toEqual(first.observation)
  expect(await readFile(f.counter, 'utf8')).toBe('call\n')
  // Linux cannot allocate this pid; ESRCH is independently checked before the fixture.
  expect(() => process.kill(2147483647, 0)).toThrow()
  await writeFile(lock, JSON.stringify({ key, pid: 2147483647, token }))
  expect(await f.run()).toEqual(first)
  expect(await readFile(f.counter, 'utf8')).toBe('call\n')
  expect(JSON.parse(await readFile(f.req.result.path, 'utf8')).result).toEqual({ answer: 'verified' })
})

test('resumes exactly the host-bound CLI session with the same isolation controls', async () => {
  const f = await fixture()
  const first = await f.run()
  if (first.kind !== 'completed' || !first.thread_id) throw Error('Expected retained session')
  const request = { ...f.req, step_id: 'review:2', role: 'review' as const, thread: { id: first.thread_id } }
  expect(await f.run(request)).toMatchObject({ kind: 'completed', thread_id: first.thread_id })
  const { args } = JSON.parse(await readFile(f.launched, 'utf8'))
  expect(args[args.indexOf('--resume') + 1]).toBe(first.thread_id)
  expect(args).not.toContain('--session-id')
  expect(args).not.toContain('--no-session-persistence')
  for (const flag of ['--safe-mode', '--restricted', '--strict-mcp-config']) expect(args).toContain(flag)
  for (const changes of [{ run_id: 'other-run' }, { model_id: 'claude-other-model' }, { thread: { id: '00000000-0000-0000-0000-000000000000' } }]) {
    expect(await f.run({ ...request, step_id: 'review:3', ...changes })).toMatchObject({ kind: 'refused' })
  }
  const otherCredential = createClaudeHeadlessRunner({ ...f.options, env: { ...f.options.env, CLAUDE_CODE_OAUTH_TOKEN: 'another-credential' } })
  expect(await otherCredential.run({ ...request, step_id: 'review:3' }, 'headless', new AbortController().signal)).toMatchObject({ kind: 'refused' })
  expect(await readFile(f.counter, 'utf8')).toBe('call\ncall\n')
})

test('an unobserved prior dispatch excludes a second writer to the retained session', async () => {
  const f = await fixture()
  const first = await f.run()
  if (first.kind !== 'completed' || !first.thread_id) throw Error('Expected retained session')
  const thread = (await readdir(f.state)).find(name => name === `claude-headless-thread-${first.thread_id}.json`)!
  await writeFile(join(f.state, `${thread}.busy`), 'unobserved-step')
  expect(await f.run({ ...f.req, step_id: 'synthesis:2', thread: { id: first.thread_id } })).toMatchObject({ kind: 'unknown' })
  expect(await readFile(f.counter, 'utf8')).toBe('call\n')
})

test('lost acknowledgement never replays work and cannot accept stale result text', async () => {
  const f = await fixture('exit-error')
  expect(await f.run()).toMatchObject({ kind: 'failed', class: 'infra' })
  await writeFile(f.req.result.path, JSON.stringify({ kind: 'completed', result: { answer: 'verified' } }))
  expect(await createClaudeHeadlessRunner(f.options).run(f.req, 'headless', new AbortController().signal)).toMatchObject({ kind: 'unknown' })
  expect(await readFile(f.counter, 'utf8')).toBe('call\n')
})

test('brief integrity and canonical path checks refuse before a process can start', async () => {
  const f = await fixture()
  expect(await f.run({ ...f.req, brief: { ...f.req.brief, integrity: 'bad' } })).toMatchObject({ kind: 'blocked' })
  const external = join(f.root, 'outside')
  await writeFile(external, 'out of scope')
  const linked = join(f.state, 'linked')
  await symlink(external, linked)
  expect(await f.run({ ...f.req, brief: { ...f.req.brief, path: linked } })).toMatchObject({ kind: 'refused' })
  expect(await f.run({ ...f.req, result: { ...f.req.result, path: external } })).toMatchObject({ kind: 'refused' })
  expect(await f.run({ ...f.req, cwd: f.root })).toMatchObject({ kind: 'refused' })
  await expect(readFile(f.counter)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await f.run()).toMatchObject({ kind: 'completed' })
})

test('toolless request cannot acquire read tools', async () => {
  const f = await fixture()
  expect(await f.run({ ...f.req, tools: 'none', writable: false, network: false })).toMatchObject({ kind: 'completed' })
  const { args } = JSON.parse(await readFile(f.launched, 'utf8'))
  expect(args[args.indexOf('--tools') + 1]).toBe('')
})

test('pre-abort does not reserve or spawn, timeout kills the process and does not replay', async () => {
  const f = await fixture('hang')
  expect(await f.run(f.req, AbortSignal.abort())).toMatchObject({ kind: 'unknown' })
  await expect(readFile(f.counter)).rejects.toMatchObject({ code: 'ENOENT' })
  // Includes the synchronous contract/authentication probes before process creation.
  const req = { ...f.req, budget: { wall_ms: 1500 } }
  expect(await f.run(req)).toMatchObject({ kind: 'failed', class: 'timeout' })
  expect(await f.run(req)).toMatchObject({ kind: 'unknown' })
  expect(await readFile(f.counter, 'utf8')).toBe('call\n')
})

test('large briefs use stdin and oversized result output fails closed', async () => {
  const f = await fixture()
  const brief = 'Evidence '.repeat(30_000)
  await writeFile(f.req.brief.path, brief)
  expect(await f.run({ ...f.req, brief: { ...f.req.brief, integrity: integrity(brief) } })).toMatchObject({ kind: 'completed' })
  const observed = JSON.parse(await readFile(f.launched, 'utf8'))
  expect(observed.prompt).toContain(brief)
  expect(observed.args.join(' ').length).toBeLessThan(4096)
  expect(await (await fixture('overflow')).run()).toMatchObject({ kind: 'unknown', detail: 'Claude result exceeded the host output limit.' })
})

// --- Project Herdr placement: a visible task view, never the evidence path. ---

// A fresh CLI session id per dispatch is expected; everything else must match.
const comparable = (outcome: { kind: string; observation?: unknown; thread_id?: unknown }) =>
  ({ ...outcome, observation: undefined, thread_id: typeof outcome.thread_id })

test('placed worker: one CLI process, identical outcome, a labelled tab in the project workspace showing its bytes', async () => {
  const baseline = await fixture()
  const expected = await baseline.run()
  const f = await fixture()
  const rig = workerPlacementRig(f.root)
  const runner = createClaudeHeadlessRunner({ ...f.options, placement: rig.placement(), taskName: 'authentication' })
  const outcome = await runner.run(f.req, 'headless', new AbortController().signal)
  expect(comparable(outcome)).toEqual(comparable(expected))
  expect((outcome.observation as { usage: unknown }).usage).toEqual((expected.observation as { usage: unknown }).usage)
  expect(await readFile(f.counter, 'utf8')).toBe('call\n')
  expect(rig.server.callsTo('workspace.create').map(call => call.params['label'])).toEqual(['Project One'])
  const [tab] = rig.server.workerLayouts()
  expect(rig.server.workerLayouts()).toHaveLength(1)
  expect(tab!.params['tab_label']).toBe('Plan · authentication')
  expect(rig.server.workspaces.has(String(tab!.params['workspace_id']))).toBe(true)
  // The tab runs the credential-free follower, never a second provider process.
  const command = (tab!.params['root'] as { command: string[] }).command
  for (const token of command) expect(token).not.toMatch(/(^|\/)claude$/)
  expect(JSON.stringify(tab!.params)).not.toContain('selected-token')
  const view = (await readdir(f.state)).find(name => name.startsWith('claude-headless-view-'))!
  const shown = await readFile(join(f.state, view), 'utf8')
  expect(shown).toContain('"structured_output"')
  expect(shown.endsWith('[host] worker exited\n')).toBe(true)
  // Finished: the view pane is closed and the receipt says so. Cleanup is detached
  // from the outcome, so it is awaited here, never by the runner.
  const receipt = await until(async () => { const [r] = await rig.receipts(f.state); return r?.state === 'closed' ? r : undefined })
  expect(rig.server.closed).toContain(receipt!.pane!)
  expect(rig.server.callsTo('pane.read')).toHaveLength(0)
})

test('screen-independence: a success-shaped screen never rescues a failed worker', async () => {
  const baseline = await fixture('exit-error')
  const expected = await baseline.run()
  expect(expected).toMatchObject({ kind: 'failed', class: 'infra' })
  const f = await fixture('exit-error')
  const rig = workerPlacementRig(f.root)
  const success = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: { schema: 'test-result',
    run_id: f.req.run_id, step_id: f.req.step_id, kind: 'completed', result: { answer: 'verified' } } })
  rig.server.screen = success
  rig.server.malformMethod('pane.read', { read: { text: success } })
  const outcome = await createClaudeHeadlessRunner({ ...f.options, placement: rig.placement() }).run(f.req, 'headless', new AbortController().signal)
  expect(comparable(outcome)).toEqual(comparable(expected))
  expect(rig.server.workerLayouts()).toHaveLength(1)
  await expect(readFile(f.req.result.path)).rejects.toMatchObject({ code: 'ENOENT' })
})

test('placement failure leaves the worker unplaced with its evidence intact and never uses another workspace', async () => {
  const f = await fixture()
  const rig = workerPlacementRig(f.root)
  rig.server.failMethod('layout.apply')
  const outcome = await createClaudeHeadlessRunner({ ...f.options, placement: rig.placement() }).run(f.req, 'headless', new AbortController().signal)
  expect(outcome.kind).toBe('completed')
  expect(JSON.parse(await readFile(f.req.result.path, 'utf8')).result).toEqual({ answer: 'verified' })
  expect((outcome.observation as { usage: { input_tokens: number } }).usage.input_tokens).toBe(17)
  expect(await readFile(f.counter, 'utf8')).toBe('call\n')
  const [receipt] = await rig.receipts(f.state)
  expect(receipt).toMatchObject({ state: 'unplaced' })
  expect(receipt!.reason).toMatch(/^placement-refused: /)
  for (const call of rig.server.callsTo('layout.apply')) expect(rig.server.workspaces.has(String(call.params['workspace_id']))).toBe(true)
})

test('cancelling a placed worker kills its own process group, grandchild included, and closes the view', async () => {
  const f = await fixture('hang-grandchild')
  const rig = workerPlacementRig(f.root)
  const runner = createClaudeHeadlessRunner({ ...f.options, placement: rig.placement() })
  const controller = new AbortController()
  const kill = spyOn(process, 'kill')
  let grandchild = 0
  try {
    const pending = runner.run({ ...f.req, budget: { wall_ms: 60_000 } }, 'headless', controller.signal)
    grandchild = await until(() => readFile(join(f.root, 'grandchild.pid'), 'utf8').then(Number, () => undefined))
    await until(() => readFile(join(f.root, 'heartbeat'), 'utf8').then(() => true, () => undefined))
    await until(async () => (await rig.receipts(f.state))[0]?.state === 'placed' ? true : undefined)
    const worker = Number(await readFile(join(f.state, 'provider.pid'), 'utf8'))
    controller.abort()
    expect(await pending).toMatchObject({ kind: 'failed', class: 'killed' })
    const targets = kill.mock.calls.filter(([, signal]) => signal !== 0).map(([pid]) => pid)
    expect(targets.length).toBeGreaterThan(0)
    expect(new Set(targets)).toEqual(new Set([-worker]))
    expect(targets).not.toContain(-process.pid)
  } finally { kill.mockRestore() }
  await until(() => { try { process.kill(grandchild, 0); return undefined } catch { return true } })
  const receipt = await until(async () => { const [r] = await rig.receipts(f.state); return r?.state === 'closed' ? r : undefined })
  expect(rig.server.closed).toContain(receipt!.pane!)
})

test('restart adopts the durable receipt: no new CLI, no new tab, the stale view pane is closed', async () => {
  const f = await fixture()
  const rig = workerPlacementRig(f.root)
  // The workspace already exists (its setup closes a pane of its own).
  expect((await rig.placement().place({ key: 'earlier', taskLabel: 'Plan · earlier', cwd: f.cwd,
    viewPath: join(f.root, 'earlier.log'), receiptDir: f.root })).kind).toBe('placed')
  // The first host "dies" with its view pane still open: the close never lands.
  rig.server.failMethod('pane.close')
  const closes = rig.server.callsTo('pane.close').length
  const first = await createClaudeHeadlessRunner({ ...f.options, placement: rig.placement() }).run(f.req, 'headless', new AbortController().signal)
  expect(first.kind).toBe('completed')
  // The first host's detached cleanup tried its (verified) close, and it failed.
  await until(() => rig.server.callsTo('pane.close').length > closes ? true : undefined)
  const [stale] = await rig.receipts(f.state)
  // The receipt carries the follower identity the replacement must re-verify.
  expect(stale).toEqual({ state: 'placed', pane: expect.any(String), pid: expect.any(Number),
    viewPath: expect.stringContaining('claude-headless-view-'), taskLabel: expect.stringMatching(/^Plan · /) })
  rig.server.clearFailure('pane.close')
  const tabs = rig.server.workerLayouts().length
  const replacement = createClaudeHeadlessRunner({ ...f.options, placement: rig.placement() })
  const from = rig.server.calls.length
  expect(await replacement.run(f.req, 'headless', new AbortController().signal)).toEqual(first)
  expect(rig.server.calls.slice(from).map(call => call.method).filter(method => method.startsWith('pane.')))
    .toEqual(['pane.get', 'pane.process_info', 'pane.close'])
  expect(await readFile(f.counter, 'utf8')).toBe('call\n')
  expect(rig.server.workerLayouts()).toHaveLength(tabs)
  expect(rig.server.panes.has(stale!.pane!)).toBe(false)
  expect(await rig.receipts(f.state)).toEqual([{ state: 'closed', pane: stale!.pane! }])
})

test('without a placement nothing is placed and no receipt or view file exists', async () => {
  const f = await fixture()
  expect((await f.run()).kind).toBe('completed')
  expect((await readdir(f.state)).filter(name => name.includes('placement') || name.includes('-view-'))).toEqual([])
})

// --- Result first: view cleanup never stands between the worker's exit and its result. ---

/** A rig whose workspace already exists, so a held method catches the WORKER's view. */
async function warmRig(f: Awaited<ReturnType<typeof fixture>>, timeouts: { placeTimeoutMs?: number; closeTimeoutMs?: number } = {}) {
  const rig = workerPlacementRig(f.root, {}, timeouts)
  expect((await rig.placement().place({ key: 'warm', taskLabel: 'Plan · warm', cwd: f.cwd,
    viewPath: join(f.root, 'warm.log'), receiptDir: f.root })).kind).toBe('placed')
  return rig
}

test('a stalled view close cannot expire a within-budget result', async () => {
  const f = await fixture()
  // The close is bounded at 4s; the dispatch budget is 3s. A runner that waited for
  // cleanup before its deadline check would turn this completed result into unknown.
  const rig = await warmRig(f, { closeTimeoutMs: 4_000 })
  const closes = rig.server.callsTo('pane.close').length
  const releaseClose = rig.server.holdMethod('pane.close')
  const runner = createClaudeHeadlessRunner({ ...f.options, placement: rig.placement(), taskName: 'authentication' })
  const outcome = await runner.run({ ...f.req, budget: { wall_ms: 3_000 } }, 'headless', new AbortController().signal)
  expect(outcome.kind).toBe('completed')
  expect(JSON.parse(await readFile(f.req.result.path, 'utf8')).result).toEqual({ answer: 'verified' })
  expect((outcome.observation as { usage: { input_tokens: number } }).usage.input_tokens).toBe(17)
  expect((await readdir(f.state)).some(name => name.startsWith('claude-headless-receipt-'))).toBe(true)
  // The close is still in flight: the pane is on record as placed, not claimed closed.
  await until(() => rig.server.callsTo('pane.close').length > closes ? true : undefined)
  const [held] = await rig.receipts(f.state)
  expect(held).toMatchObject({ state: 'placed' })
  releaseClose()
  await until(async () => (await rig.receipts(f.state))[0]?.state === 'closed' ? true : undefined)
  expect(await readFile(f.counter, 'utf8')).toBe('call\n')
})

test('a stalled placement neither delays nor changes the result, and its late pane is closed', async () => {
  const baseline = await fixture()
  const expected = await baseline.run()
  const f = await fixture()
  const rig = await warmRig(f)
  const layouts = rig.server.workerLayouts().length
  const releaseApply = rig.server.holdMethod('layout.apply')
  const runner = createClaudeHeadlessRunner({ ...f.options, placement: rig.placement() })
  const outcome = await runner.run({ ...f.req, budget: { wall_ms: 3_000 } }, 'headless', new AbortController().signal)
  expect(comparable(outcome)).toEqual(comparable({ ...expected }))
  expect(JSON.parse(await readFile(f.req.result.path, 'utf8')).result).toEqual({ answer: 'verified' })
  // Placement had not answered when the result was published.
  expect((await rig.receipts(f.state))[0]).toEqual({ state: 'pending' })
  releaseApply()
  // Placement lands after the worker exited; the released view closes it through the
  // verified path.
  const receipt = await until(async () => { const [r] = await rig.receipts(f.state); return r?.state === 'closed' ? r : undefined })
  expect(rig.server.closed).toContain(receipt.pane!)
  expect(rig.server.workerLayouts()).toHaveLength(layouts + 1)
  expect(rig.server.callsTo('pane.read')).toHaveLength(0)
  expect(await readFile(f.counter, 'utf8')).toBe('call\n')
})
