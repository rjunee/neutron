import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, unlink } from 'node:fs/promises'
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
  // Keep capability probes in a tiny shell shim to avoid repeated Node startup
  // inside the five-second probe deadline under CI shard load.
  await writeFile(join(dir, 'codex'), `#!/bin/sh
IFS= read -r mode < "$FIXTURE_DIR/mode"
case "$1:$2:$3" in
  --version::)
    [ "$#" -eq 1 ] || exit 64
    printf '%s\\n' '["--version"]' >> "$FIXTURE_DIR/invocations"
    exit 0 ;;
  login:status:)
    [ "$#" -eq 2 ] || exit 64
    printf '%s\\n' '["login","status"]' >> "$FIXTURE_DIR/invocations"
    exit 0 ;;
  exec:--help:)
    [ "$#" -eq 2 ] || exit 64
    printf '%s\\n' '["exec","--help"]' >> "$FIXTURE_DIR/invocations" ;;
  exec:resume:--help)
    [ "$#" -eq 3 ] || exit 64
    printf '%s\\n' '["exec","resume","--help"]' >> "$FIXTURE_DIR/invocations"
    [ "$mode" != missing-resume ] || exit 2 ;;
  exec:--strict-config:--ignore-user-config)
    [ "$#" -eq 7 ] && [ "$4" = -c ] && [ "$5" = 'sandbox_mode="read-only"' ] &&
      [ "$6" = -c ] && [ "$7" = neutron_codex_contract_probe_sentinel=true ] || exit 64
    printf '%s\\n' '["exec","--strict-config","--ignore-user-config","-c","sandbox_mode=\\"read-only\\"","-c","neutron_codex_contract_probe_sentinel=true"]' >> "$FIXTURE_DIR/invocations"
    printf '%s\\n' '["exec","--strict-config","--ignore-user-config","-c","sandbox_mode=\\"read-only\\"","-c","neutron_codex_contract_probe_sentinel=true"]' >> "$FIXTURE_DIR/probes"
    key=neutron_codex_contract_probe_sentinel
    [ "$mode" != bad-sandbox ] || key=sandbox_mode
    [ "$mode" != missing-sentinel ] || key=another_key
    printf '%s' "unknown configuration field $key in -c/--config override" >&2
    [ "$mode" = sentinel-zero ] && exit 0
    exit 1 ;;
  *) exec node "$FIXTURE_DIR/codex-turn.js" "$@" ;;
esac
[ "$mode" != bad-cli ] || { printf '%s' '--json'; exit 0; }
printf '%s' '--output-schema --json --output-last-message --ignore-rules'
`, { mode: 0o755 })
  await writeFile(join(dir, 'codex-turn.js'), `
const { readFileSync, writeFileSync, appendFileSync } = require('node:fs');
(async () => {
const args = process.argv.slice(2);
appendFileSync(process.env.FIXTURE_DIR + '/invocations', JSON.stringify(args)+'\\n');
const mode = readFileSync(process.env.FIXTURE_DIR + '/mode', 'utf8');
const prompt = readFileSync(0, 'utf8');
writeFileSync(process.env.FIXTURE_DIR + '/provider.pid',String(process.pid));
const req = JSON.parse(prompt.split('\\n')[0].slice('Request (data): '.length));
appendFileSync(process.env.FIXTURE_DIR + '/calls', JSON.stringify({args, prompt, env:process.env, cwd:process.cwd()})+'\\n');
if (mode === 'hang') { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); await new Promise(() => {}); }
const envelope = {run_id:req.run_id, step_id:req.step_id, schema:req.result.schema, kind:'completed', result:{verdict:'APPROVE',findings:[]}};
if (['run_id','step_id','schema'].includes(mode)) envelope[mode] = 'wrong';
if (mode === 'payload') envelope.result = {verdict:'APPROVE'};
if (mode === 'extra') envelope.extra = 'forged';
if (mode === 'worker-usage') envelope.usage = {input_tokens:999,output_tokens:999};
if (mode === 'blocked') { envelope.kind='blocked'; delete envelope.result; envelope.on='cannot inspect revision'; }
if (mode !== 'missing') writeFileSync(args[args.indexOf('-o')+1], mode === 'malformed' ? '{' : JSON.stringify({envelope}));
writeFileSync(1, JSON.stringify({type:'thread.started',thread_id:args[1] === 'resume' ? args[2] : 'recorded-thread'})+'\\n');
if (mode !== 'no-completion') writeFileSync(1, JSON.stringify({type:mode==='turn-failed'?'turn.failed':'turn.completed',
  usage:['missing-usage','worker-usage'].includes(mode)?undefined:mode==='zero-usage'?{input_tokens:0,output_tokens:0,cached_input_tokens:0}:{input_tokens:17,output_tokens:3,cached_input_tokens:11}})+(mode==='no-newline'?'':'\\n'));
if (mode==='duplicate-completion') writeFileSync(1, JSON.stringify({type:'turn.completed',usage:{input_tokens:17,output_tokens:3,cached_input_tokens:11}})+'\\n');
writeFileSync(process.env.FIXTURE_DIR + '/receipt-ready','ready');
if (mode==='usage-then-hang') { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); await new Promise(() => {}); }
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

for (const role of ['review', 'synthesis'] as const) {
  test(`Codex ${role} recovery never invokes CLI or creates missing dispatch authority`, async () => {
    const f = await fixture()
    const req = { ...f.req, role }
    const runner = f.runner(), signal = new AbortController().signal
    const snapshot = async () => Object.fromEntries(await Promise.all((await readdir(f.dir)).filter(name => name !== 'account').sort()
      .map(async name => [name, await readFile(join(f.dir, name), 'utf8')])))
    await writeFile(req.result.path, 'unowned previous result')
    const initial = await snapshot()
    expect((await runner.recover!(req, 'headless', signal)).kind).toBe('unknown')
    expect(await snapshot()).toEqual(initial)
    const first = await runner.run(req, 'headless', signal)
    expect(first.kind).toBe('completed')
    expect(await f.calls()).toHaveLength(1)
    const replacement = f.runner()
    const retained = await snapshot()
    expect(await replacement.recover!(req, 'headless', signal)).toEqual(first)
    for (const request of [{ ...req, model_id: 'changed-model' }, { ...req, brief: { ...req.brief, integrity: 'changed-task' } }]) {
      expect((await replacement.recover!(request, 'headless', signal)).kind).toBe('unknown')
      expect(await snapshot()).toEqual(retained)
    }
    const reservation = join(f.dir, (await readdir(f.dir)).find(name => /^codex-headless-step-.*\.json$/.test(name))!)
    const receiptBytes = await readFile(`${reservation}.receipt`, 'utf8')
    await unlink(`${reservation}.receipt`)
    const uncommitted = await snapshot()
    expect((await replacement.recover!(req, 'headless', signal)).kind).toBe('unknown')
    expect(await snapshot()).toEqual(uncommitted)
    await writeFile(`${reservation}.receipt`, receiptBytes)
    for (const bytes of [JSON.stringify([req, f.home]), 'corrupt', JSON.stringify([{ ...req, model_id: 'foreign' }, f.home]) + '\n#dispatch-armed\n']) {
      await writeFile(reservation, bytes)
      const before = await snapshot()
      expect((await replacement.recover!(req, 'headless', signal)).kind).toBe('unknown')
      expect(await snapshot()).toEqual(before)
    }
    // Losing both files also removes the ordinary dispatch path's schema-file
    // collision. Only the recovery reservation guard prevents another CLI turn.
    await unlink(reservation)
    await unlink(`${reservation}.schema`)
    const lost = await snapshot()
    expect((await replacement.recover!(req, 'headless', signal)).kind).toBe('unknown')
    expect(await snapshot()).toEqual(lost)
    expect(await f.calls()).toHaveLength(1)
  })
}

test('Codex review host death after provider usage recovers spend without child completion or replay', async () => {
  const f = await fixture('usage-then-hang')
  const req = { ...f.req, budget: { wall_ms: 30_000 } }
  const hostPath = join(f.dir, 'observation-host.ts')
  await writeFile(hostPath, `import {createCodexHeadlessRunner} from ${JSON.stringify(import.meta.dir + '/codex-headless.ts')};\n` +
    `import {VERDICT_SCHEMA,validateTrailer} from ${JSON.stringify(import.meta.dir + '/../../trident/gates/result-contract.ts')};\n` +
    `import {briefIntegrity} from ${JSON.stringify(import.meta.dir + '/../../trident/gates/brief-integrity.ts')};\n` +
    `await createCodexHeadlessRunner({env:${JSON.stringify(f.env)},probe:{ok:true},reviewBriefIntegrity:briefIntegrity,reviewContracts:new Map([['verdict',{jsonSchema:VERDICT_SCHEMA,validate:(value)=>validateTrailer('verdict',value).ok}]])}).run(${JSON.stringify(req)},'headless',new AbortController().signal);\n`)
  const host = Bun.spawn([process.execPath, hostPath], { stdout: 'ignore', stderr: 'ignore' })
  const runner = f.runner()
  try {
    let observed
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      observed = await runner.observe!(req)
      if (observed?.usage.input_tokens === 6) break
      await Bun.sleep(10)
    }
    expect(observed?.usage.input_tokens).toBe(6)
    expect(host.exitCode).toBeNull()
    host.kill('SIGKILL'); await host.exited
    expect(await f.runner().observe!(req)).toEqual(observed)
    expect((await runner.run(req, 'headless', new AbortController().signal)).kind).toBe('unknown')
    expect(await f.calls()).toHaveLength(1)
  } finally {
    host.kill('SIGKILL'); await host.exited
    try { process.kill(-Number(await readFile(join(f.dir, 'provider.pid'), 'utf8')), 'SIGKILL') } catch { /* Gone or not started. */ }
  }
}, 10_000)

for (const mode of ['nonzero', 'zero-usage'] as const) {
  test(`Codex read-only usage recovery retains ${mode} without dispatch`, async () => {
    const f = await fixture(mode)
    const runner = f.runner()
    expect(await runner.observe!(f.req)).toBeUndefined()
    const first = await f.run()
    const calls = await f.calls()
    expect(await runner.observe!(f.req)).toEqual(first.observation)
    expect((await runner.observe!(f.req))?.usage.input_tokens).toBe(mode === 'zero-usage' ? 0 : 6)
    expect(await runner.observe!({ ...f.req, model_id: 'other' })).toBeUndefined()
    expect(await runner.observe!({ ...f.req, step_id: 'other' })).toBeUndefined()
    const other = createCodexHeadlessRunner({ env: { ...f.env, CODEX_HOME: join(f.dir, 'other-home') }, probe: { ok: true } })
    expect(await other.observe!(f.req)).toBeUndefined()
    expect(await f.calls()).toEqual(calls)
  })
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
  const first = await f.run()
  expect(first).toMatchObject({ kind: 'blocked', on: 'cannot inspect revision', observation: { usage: { input_tokens: 6, output_tokens: 3 } } })
  expect(await f.run()).toEqual(first)
  expect(await f.calls()).toHaveLength(1)
})

test('failed, interrupted and malformed reviews retain provider spend, never result authority', async () => {
  for (const mode of ['nonzero', 'payload', 'malformed', 'turn-failed', 'usage-then-hang', 'duplicate-completion', 'no-newline']) {
    const f = await fixture(mode)
    const req = mode === 'usage-then-hang' ? { ...f.req, budget: { wall_ms: 30_000 } } : f.req
    const controller = new AbortController()
    const pending = f.run(req, controller.signal)
    if (mode === 'usage-then-hang') {
      while (!(await readFile(join(f.dir, 'receipt-ready')).then(() => true, () => false))) {
        if (await Promise.race([pending.then(() => true), Bun.sleep(10).then(() => false)])) throw Error('Worker ended before emitting usage')
      }
      controller.abort()
    }
    const first = await pending
    expect(first.kind).toBe(mode === 'nonzero' || mode === 'usage-then-hang' ? 'failed' : 'unknown')
    expect(first.observation).toMatchObject({ source: 'codex-cli-jsonl', thread_id: 'recorded-thread',
      model_reported: null, usage: { input_tokens: 6, output_tokens: 3, cache_read_input_tokens: 11 } })
    await expect(readFile(req.result.path)).rejects.toMatchObject({ code: 'ENOENT' })
    const recovered = await f.run(req)
    expect(recovered.kind).toBe('unknown')
    expect(recovered.observation).toEqual(first.observation)
    expect(await f.calls()).toHaveLength(1)
  }
})

test('missing Codex usage is unknown without a completion veto; explicit zero stays measured', async () => {
  expect(await (await fixture('missing-usage')).run()).toMatchObject({ kind: 'completed', usage: null,
    observation: { usage: { input_tokens: null, output_tokens: null, cache_read_input_tokens: null } } })
  expect(await (await fixture('zero-usage')).run()).toMatchObject({ kind: 'completed',
    observation: { usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 } } })
})

test('worker-authored usage cannot supply missing provider observations', async () => {
  expect(await (await fixture('worker-usage')).run()).toMatchObject({ kind: 'unknown', observation: {
    usage: { input_tokens: null, output_tokens: null, cache_read_input_tokens: null },
  } })
})

test('a refused recovered receipt keeps prior spend and cannot redispatch', async () => {
  const f = await fixture()
  const first = await f.run()
  const receiptPath = join(f.dir, (await readdir(f.dir)).find(path => path.endsWith('.receipt'))!)
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'))
  await writeFile(receiptPath, JSON.stringify({ ...receipt, identity: 'mismatched' }))
  const recovered = await f.run()
  expect(recovered).toMatchObject({ kind: 'unknown', detail: 'Codex review receipt identity mismatched' })
  expect(recovered.observation).toEqual(first.observation)
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
