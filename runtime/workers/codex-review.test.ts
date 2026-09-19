import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createCodexHeadlessRunner } from './codex-headless.ts'
import type { BoundedWorkRequest } from '../bounded-work.ts'
import { VERDICT_SCHEMA, validateTrailer } from '@neutronai/trident/gates/result-contract.ts'
import { CODEX_CLI_AUTH_ENV_VARS } from '../adapters/codex-cli/auth.ts'
import { briefIntegrity } from '@neutronai/trident/gates/brief-integrity.ts'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

async function fixture(mode = 'valid') {
  const dir = await mkdtemp(join(tmpdir(), 'codex-review-')); dirs.push(dir)
  const home = join(dir, 'account'); await mkdir(home)
  await writeFile(join(home, 'auth.json'), JSON.stringify({ tokens: { access_token: 'fixture-access', refresh_token: 'fixture-refresh' } }))
  await writeFile(join(dir, 'mode'), mode)
  await writeFile(join(dir, 'invocations'), '')
  await writeFile(join(dir, 'brief'), 'Review the bounded diff. A long prompt stays on stdin.')
  await writeFile(join(dir, 'codex'), `#!/usr/bin/env node
const { readFileSync, writeFileSync, appendFileSync } = require('node:fs');
(async () => {
const args = process.argv.slice(2);
appendFileSync(process.env.FIXTURE_DIR + '/invocations', JSON.stringify(args)+'\\n');
if (args.includes('--version') || args[0] === 'login') process.exit(0);
const mode = readFileSync(process.env.FIXTURE_DIR + '/mode', 'utf8');
if (args.includes('--help')) {
  if (mode === 'missing-resume' && args[1] === 'resume') process.exit(2);
  writeFileSync(1, mode === 'bad-cli' ? '--json' : '--output-schema --json --output-last-message --ignore-rules'); process.exit(0);
}
if (args.includes('--strict-config')) {
  appendFileSync(process.env.FIXTURE_DIR + '/probes', JSON.stringify(args)+'\\n');
  const key = mode === 'bad-sandbox' ? 'sandbox_mode' : mode === 'missing-sentinel' ? 'another_key' : 'neutron_codex_contract_probe_sentinel';
  writeFileSync(2, 'unknown configuration field ' + key + ' in -c/--config override');
  process.exit(mode === 'sentinel-zero' ? 0 : 1);
}
const prompt = readFileSync(0, 'utf8');
const req = JSON.parse(prompt.split('\\n')[0].slice('Request (data): '.length));
appendFileSync(process.env.FIXTURE_DIR + '/calls', JSON.stringify({args, prompt, env:process.env, cwd:process.cwd()})+'\\n');
if (mode === 'hang') { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); await new Promise(() => {}); }
const envelope = {run_id:req.run_id, step_id:req.step_id, schema:req.result.schema, kind:'completed', result:{verdict:'APPROVE',findings:[]}};
if (['run_id','step_id','schema'].includes(mode)) envelope[mode] = 'wrong';
if (mode === 'payload') envelope.result = {verdict:'APPROVE'};
if (mode === 'extra') envelope.extra = 'forged';
if (mode === 'blocked') { envelope.kind='blocked'; delete envelope.result; envelope.on='cannot inspect revision'; }
if (mode !== 'missing') writeFileSync(args[args.indexOf('-o')+1], mode === 'malformed' ? '{' : JSON.stringify({envelope}));
writeFileSync(1, JSON.stringify({type:'thread.started',thread_id:args[1] === 'resume' ? args[2] : 'recorded-thread'})+'\\n');
if (mode !== 'no-completion') writeFileSync(1, JSON.stringify({type:'turn.completed',usage:{input_tokens:17,output_tokens:3,cached_input_tokens:11}})+'\\n');
process.exit(mode === 'nonzero' ? 2 : 0);
})();
`, { mode: 0o755 })
  const env = { PATH: `${dir}:${process.env.PATH}`, CODEX_HOME: home, FIXTURE_DIR: dir, CONTROL: 'visible',
    GH_TOKEN: 'secret', GH_ENTERPRISE_TOKEN: 'secret', GITHUB_TOKEN: 'secret',
    ...Object.fromEntries(CODEX_CLI_AUTH_ENV_VARS.map(key => [key, 'secret'])) }
  const contracts = new Map([['verdict', { jsonSchema: VERDICT_SCHEMA, validate: (value: unknown) => validateTrailer('verdict', value).ok }]])
  const runner = () => createCodexHeadlessRunner({ env, reviewContracts: contracts, reviewBriefIntegrity: briefIntegrity, probe: { ok: true } })
  const productionRunner = () => createCodexHeadlessRunner({ env, reviewContracts: contracts, reviewBriefIntegrity: briefIntegrity })
  const req: BoundedWorkRequest = { run_id: 'run', step_id: 'review-1', role: 'review', model_id: 'requested-model', effort: 'xhigh',
    cwd: dir, writable: false, network: true, tools: 'read-only', brief: { path: join(dir, 'brief'), integrity: briefIntegrity('Review the bounded diff. A long prompt stays on stdin.') },
    result: { path: join(dir, 'result'), schema: 'verdict' }, thread: null, budget: { wall_ms: 2000 }, needs_approval_decision: false }
  const run = (request = req, signal = new AbortController().signal) => runner().run(request, 'headless', signal)
  const calls = async () => (await readFile(join(dir, 'calls'), 'utf8')).trim().split('\n').map(row => JSON.parse(row))
  const invocations = async () => (await readFile(join(dir, 'invocations'), 'utf8')).trim().split('\n').filter(Boolean).map(row => JSON.parse(row))
  return { dir, home, env, req, runner, productionRunner, run, calls, invocations }
}

test('review and synthesis use read-only Codex exec with stdin, host schema, selected home and observed usage', async () => {
  for (const role of ['review', 'synthesis'] as const) {
    const f = await fixture()
    const outcome = await f.run({ ...f.req, role })
    expect(outcome).toMatchObject({ kind: 'completed', result: { verdict: 'APPROVE', findings: [] },
      thread_id: 'recorded-thread', model_reported: null, usage: { input_tokens: 17, output_tokens: 3, cache_read_input_tokens: 11 } })
    const [call] = await f.calls()
    expect(call.args.slice(0, 2)).toEqual(['exec', '--json'])
    expect(call.args).toEqual(['exec', '--json', '--ignore-user-config', '--ignore-rules', '-m', 'requested-model',
      '-c', 'sandbox_mode="read-only"',
      '--output-schema', expect.any(String), '-o', expect.any(String), '-'])
    expect(call.cwd).toBe(f.req.cwd)
    expect(call.prompt).toContain('Review the bounded diff.')
    expect(call.env.CODEX_HOME).toBe(f.home)
    expect(call.env.CONTROL).toBe('visible')
    expect(call.args.join(' ')).not.toMatch(/approval_policy|approvals_reviewer|approve-for-me|model_reasoning_effort/)
    for (const key of [...CODEX_CLI_AUTH_ENV_VARS, 'GH_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_TOKEN']) expect(call.env[key]).toBeUndefined()
    expect(call.args[call.args.indexOf('-o') + 1]).not.toBe(f.req.result.path)
    const schema = JSON.parse(await readFile(call.args[call.args.indexOf('--output-schema') + 1], 'utf8'))
    expect(schema.type).toBe('object')
    expect(schema.required).toEqual(['envelope'])
    expect(schema.properties.envelope.anyOf[0].properties.run_id.enum).toEqual(['run'])
    expect(JSON.parse(await readFile(f.req.result.path, 'utf8')).kind).toBe('completed')
  }
})

test('successful receipt survives runner replacement; a later turn resumes the recorded thread explicitly', async () => {
  const f = await fixture()
  const first = await f.run()
  expect(first.kind).toBe('completed')
  await writeFile(join(f.dir, 'mode'), 'nonzero')
  expect(await f.run()).toEqual(first)
  expect(await f.calls()).toHaveLength(1)
  await writeFile(join(f.dir, 'mode'), 'valid')
  expect(await f.run({ ...f.req, step_id: 'review-2', thread: { id: 'recorded-thread' } })).toMatchObject({ kind: 'completed', thread_id: 'recorded-thread' })
  expect((await f.calls())[1].args.slice(0, 3)).toEqual(['exec', 'resume', 'recorded-thread'])
  expect((await f.calls())[1].args).not.toContain('--last')
})

for (const mode of ['run_id', 'step_id', 'schema', 'payload', 'extra', 'missing', 'malformed', 'no-completion', 'nonzero']) {
  test(`review ${mode} cannot approve now or after runner replacement`, async () => {
    const f = await fixture(mode)
    expect((await f.run()).kind).not.toBe('completed')
    await writeFile(join(f.dir, 'mode'), 'valid')
    expect((await f.run()).kind).toBe('unknown')
    expect(await f.calls()).toHaveLength(1)
  })
}

test('a blocked result remains blocked on resume', async () => {
  const f = await fixture('blocked')
  expect(await f.run()).toEqual({ kind: 'blocked', on: 'cannot inspect revision' })
  expect(await f.run()).toEqual({ kind: 'blocked', on: 'cannot inspect revision' })
  expect(await f.calls()).toHaveLength(1)
})

test('changed request cannot reuse a reserved receipt', async () => {
  const f = await fixture(); expect((await f.run()).kind).toBe('completed')
  expect((await f.run({ ...f.req, model_id: 'other' })).kind).toBe('unknown')
  expect(await f.calls()).toHaveLength(1)
})

test('read-only support cannot be over-applied to other roles, placements, grants or schemas', async () => {
  const f = await fixture()
  expect(f.runner().supports('arbitrate', 'headless').ok).toBe(false)
  expect(f.runner().supports('review', 'in-repl').ok).toBe(false)
  for (const change of [{ writable: true }, { tools: 'none' as const }, { tools: 'edit-and-run' as const },
    { result: { ...f.req.result, schema: 'project-build' } }, { needs_approval_decision: true }]) {
    expect(await f.run({ ...f.req, ...change } as BoundedWorkRequest)).toEqual({ kind: 'refused', reason: 'capability-unsupported' })
  }
  expect((await f.run()).kind).toBe('completed')
  expect(await f.calls()).toHaveLength(1)
})

test('missing CLI contract and non-subscription account refuse before dispatch', async () => {
  const f = await fixture('bad-cli')
  expect(await f.run()).toEqual({ kind: 'refused', reason: 'cli-contract' })
  await writeFile(join(f.dir, 'mode'), 'valid')
  await writeFile(join(f.home, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'metered' }))
  expect(await f.run()).toEqual({ kind: 'refused', reason: 'provider-not-connected' })
})

test('startup validates sandbox before a final sentinel and ignores user config', async () => {
  const f = await fixture()
  await writeFile(join(f.home, 'config.toml'), 'unknown_user_field = true\n')
  expect(f.runner().supports('review', 'headless')).toEqual({ ok: true })
  const probes = (await readFile(join(f.dir, 'probes'), 'utf8')).trim().split('\n').map(row => JSON.parse(row))
  expect(probes).toEqual([['exec', '--strict-config', '--ignore-user-config', '-c', 'sandbox_mode="read-only"',
    '-c', 'neutron_codex_contract_probe_sentinel=true']])
  expect(probes[0].at(-1)).toBe('neutron_codex_contract_probe_sentinel=true')
  expect(probes[0]).not.toContain('--help')
  await expect(f.calls()).rejects.toThrow()
})

for (const mode of ['missing-resume', 'bad-sandbox', 'missing-sentinel', 'sentinel-zero']) {
  test(`startup ${mode} refuses admission without any model turn`, async () => {
    const f = await fixture(mode); const runner = f.runner()
    expect(runner.supports('review', 'headless')).toMatchObject({ ok: false, reason: 'cli-contract' })
    expect(await runner.run(f.req, 'headless', new AbortController().signal)).toEqual({ kind: 'refused', reason: 'cli-contract' })
    await expect(f.calls()).rejects.toThrow()
  })
}

const invalidAccounts = [
  ['bare key', 'sk-fixture'],
  ['key only', JSON.stringify({ OPENAI_API_KEY: 'metered' })],
  ['mixed key and OAuth', JSON.stringify({ OPENAI_API_KEY: 'metered', tokens: { access_token: 'fixture', refresh_token: 'fixture' } })],
  ['API-key mode with OAuth', JSON.stringify({ auth_mode: 'apikey', tokens: { access_token: 'fixture', refresh_token: 'fixture' } })],
  ['malformed', '{'], ['missing tokens', '{}'],
  ['missing refresh token', JSON.stringify({ tokens: { access_token: 'fixture' } })],
  ['invalid token types', JSON.stringify({ tokens: { access_token: 42, refresh_token: 'fixture' } })],
] as const
for (const [label, bytes] of invalidAccounts) {
  test(`${label} refuses both startup admission and a previously admitted runner`, async () => {
    const f = await fixture(); const admitted = f.runner()
    expect(admitted.supports('review', 'headless')).toEqual({ ok: true })
    await writeFile(join(f.home, 'auth.json'), bytes)
    await writeFile(join(f.dir, 'invocations'), '')
    expect(f.productionRunner().supports('review', 'headless')).toMatchObject({ ok: false, reason: 'provider-not-connected' })
    expect(await admitted.run(f.req, 'headless', new AbortController().signal)).toEqual({ kind: 'refused', reason: 'provider-not-connected' })
    await expect(f.calls()).rejects.toThrow()
    expect(await f.invocations()).toEqual([])
  })
}

test('clean subscription production admission launches version, login and contract probes before its model turn', async () => {
  const f = await fixture(); const runner = f.productionRunner()
  expect(runner.supports('review', 'headless')).toEqual({ ok: true })
  const startup = await f.invocations()
  expect(startup).toHaveLength(5)
  expect(startup).toContainEqual(['--version'])
  expect(startup).toContainEqual(['login', 'status'])
  expect(startup).toContainEqual(['exec', 'resume', '--help'])
  expect(startup.some(args => args.includes('--strict-config'))).toBe(true)
  expect((await runner.run(f.req, 'headless', new AbortController().signal)).kind).toBe('completed')
  expect(await f.invocations()).toHaveLength(6)
})

test('pre-cancelled review does not consume the step reservation', async () => {
  const f = await fixture(); const ac = new AbortController(); ac.abort()
  expect(await f.run(f.req, ac.signal)).toMatchObject({ kind: 'failed', class: 'killed' })
  expect((await f.run()).kind).toBe('completed')
  expect(await f.calls()).toHaveLength(1)
})

test('tampered brief fails closed before a model call', async () => {
  const f = await fixture()
  await writeFile(f.req.brief.path, 'a different task')
  expect(await f.run()).toMatchObject({ kind: 'unknown', detail: 'Codex review brief integrity mismatched' })
  await expect(f.calls()).rejects.toThrow()
})

test('cancellation stops a live review and liveness returns to nothing', async () => {
  const f = await fixture('hang'); const runner = f.runner(); const ac = new AbortController()
  const pending = runner.run(f.req, 'headless', ac.signal)
  for (let tries = 0; tries < 100; tries++) {
    if (await f.calls().then(() => true, () => false)) break
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  expect(await runner.liveness({ run_id: f.req.run_id, step_id: f.req.step_id })).toBe('activity')
  ac.abort()
  expect(await pending).toMatchObject({ kind: 'failed', class: 'killed' })
  expect(await runner.liveness({ run_id: f.req.run_id, step_id: f.req.step_id })).toBe('nothing')
})

test('wall budget kills a process ignoring TERM and never commits its output', async () => {
  const f = await fixture('hang'); const start = Date.now()
  expect(await f.run({ ...f.req, budget: { wall_ms: 80 } })).toMatchObject({ kind: 'failed', class: 'timeout' })
  // WALL-CLOCK-BOUND-OK: process-group termination within the configured budget is the
  // property; 1.5s is 18.75x the 80ms budget and 6x the 250ms TERM-to-KILL allowance.
  expect(Date.now() - start).toBeLessThan(1500)
})
