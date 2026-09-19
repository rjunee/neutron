import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile, mkdir, symlink, unlink, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BoundedWorkRequest } from '../bounded-work.ts'
import { createHash } from 'node:crypto'
import { createClaudeHeadlessRunner } from './claude-headless.ts'

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
writeFileSync(${JSON.stringify(launched)},JSON.stringify({args,prompt,env:process.env}));
appendFileSync(${JSON.stringify(counter)},'call\\n');
if(${JSON.stringify(mode)}==='hang') { setInterval(()=>{},1000); await new Promise(()=>{}); }
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
writeFileSync(1,JSON.stringify(receipt));
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

test('successful headless completion uses exact model, measured usage, isolated argv, stdin and host trailer', async () => {
  const f = await fixture()
  expect(await f.run()).toEqual({ kind: 'completed', result: { answer: 'verified' },
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
  expect(await blocked.run()).toEqual({ kind: 'blocked', on: 'Need source evidence.' })
  expect(JSON.parse(await readFile(blocked.req.result.path, 'utf8')).kind).toBe('blocked')
  for (const mode of ['permission', 'no-permissions']) expect(await (await fixture(mode)).run()).toMatchObject({ kind: 'blocked' })
})

test('unknown usage stays unknown rather than becoming invented zero counters', async () => {
  const f = await fixture('invalid-usage')
  expect(await f.run()).toMatchObject({ kind: 'completed', usage: null })
})

test('duplicate and restarted step reads the durable receipt without redispatch', async () => {
  const f = await fixture()
  const first = await f.run()
  expect(await f.run()).toEqual(first)
  expect(await createClaudeHeadlessRunner(f.options).run(f.req, 'headless', new AbortController().signal)).toEqual(first)
  expect(await readFile(f.counter, 'utf8')).toBe('call\n')
  await writeFile(f.req.result.path, '{}')
  expect(await f.run()).toMatchObject({ kind: 'unknown' })
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
  expect(await f.run()).toMatchObject({ kind: 'unknown' })
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
  const req = { ...f.req, budget: { wall_ms: 150 } }
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
