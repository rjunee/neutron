import { afterAll, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveNativeModel, type NativeModelResolutionInput } from '../native-model-resolution.ts'

const directories: string[] = []
afterAll(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }) })

/** A real disposable subprocess exercises pipes, argv, env and exit handling;
 * it never opens an account or contacts a provider. */
async function fixture(mode = 'success'): Promise<NativeModelResolutionInput> {
  const cwd = await mkdtemp(join(tmpdir(), 'native-model-resolution-'))
  directories.push(cwd)
  const executable = join(cwd, 'resolver.cjs')
  const source = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2), value = name => args[args.indexOf(name) + 1];
const mode = ${JSON.stringify(mode)};
const session_id = value('--session-id');
const settings = JSON.parse(value('--settings'));
if (value('--tools') !== '' || !args.includes('--strict-mcp-config') || !args.includes('--no-session-persistence')
 || value('--mcp-config') !== '{"mcpServers":{}}' || value('--setting-sources') !== 'user,project'
 || settings.disableAllHooks !== true || settings.modelOverrides?.example !== 'preserved'
 || process.env.PROFILE_SENTINEL !== 'private-fixture-value' || !session_id) process.exit(41);
(() => {
 if (args.at(-1) !== '/model ' + value('--model')) process.exit(42);
 const init = {type:'system',subtype:'init',session_id,model:process.env.RESOLVER_MODEL || 'claude-fable-5-1',apiKeySource:'none'};
 const result = {type:'result',subtype:'success',session_id,is_error:false,duration_api_ms:0,num_turns:0,total_cost_usd:0};
 const display = {type:'assistant',session_id,message:{role:'assistant',model:'<synthetic>',content:[{type:'text',text:'local display is not identity'}]}};
 const send = row => fs.writeSync(1, JSON.stringify(row) + '\\n');
 if (mode === 'hang') { setInterval(() => {}, 1000); return; }
 if (mode === 'malformed') { fs.writeSync(1, 'not json\\n'); return; }
 if (mode === 'oversize') { fs.writeSync(1, 'x'.repeat(1048577)); return; }
 if (mode === 'stderr-oversize') { fs.writeSync(2, 'x'.repeat(1048577)); return; }
 if (mode === 'foreign-init') init.session_id = 'foreign';
 if (mode === 'alias') init.model = 'fable';
 if (mode === 'unversioned') init.model = 'claude-fable';
 if (mode === 'api-source-invalid') init.apiKeySource = 'invalid source content';
 if (mode !== 'no-init') send(init);
 if (mode === 'duplicate-init') send(init);
 if (mode === 'provider-message') display.message.model = init.model;
 if (mode === 'tool-use') display.message.content = [{type:'tool_use',name:'Bash'}];
 send(display);
 if (mode === 'foreign-result') result.session_id = 'foreign';
 if (mode === 'api-time') result.duration_api_ms = 1;
 if (mode === 'turns') result.num_turns = 1;
 if (mode === 'cost') result.total_cost_usd = 0.01;
 if (mode === 'error') result.is_error = true;
 if (mode === 'wrong-result') result.subtype = 'error_max_turns';
 if (mode === 'unterminated') fs.writeSync(1, JSON.stringify(result)); else send(result);
 if (mode === 'trailing') send(init);
 if (mode === 'drift') fs.appendFileSync(process.argv[1], '\\n// changed');
 if (mode === 'exit-failure') process.exitCode = 1;
})();
`
  await writeFile(executable, source)
  await chmod(executable, 0o700)
  return { executable: { path: executable, sha256: createHash('sha256').update(source).digest('hex') },
    selector: 'fable', cwd, env: { PATH: process.env.PATH, PROFILE_SENTINEL: 'private-fixture-value' },
    settingsJson: JSON.stringify({ modelOverrides: { example: 'preserved' }, disableAllHooks: false }),
    settingSources: ['user', 'project'], profileId: 'profile-generation', timeoutMs: 3000 }
}

test('host local command returns concrete model with auth explicitly unknown and no private inputs', async () => {
  const input = await fixture()
  const result = await resolveNativeModel(input)
  expect(result).toMatchObject({ status: 'resolved', source: 'native-local-model-command', selector: 'fable',
    modelId: 'claude-fable-5-1', profileId: 'profile-generation', executableSha256: input.executable.sha256,
    authEvidence: { status: 'unknown', reason: 'native-init-incomplete', apiKeySource: 'none' } })
  expect(JSON.stringify(result)).not.toContain('private-fixture-value')
  expect(JSON.stringify(result)).not.toContain('preserved')
  expect(JSON.stringify(result)).not.toContain(input.cwd)
})

test('a different native resolution is retained rather than hardcoding the current family default', async () => {
  const input = await fixture()
  input.selector = 'opus'
  input.env.RESOLVER_MODEL = 'claude-opus-5-5'
  expect(await resolveNativeModel(input)).toMatchObject({ status: 'resolved', selector: 'opus', modelId: 'claude-opus-5-5' })
})

test.each(['foreign-init', 'foreign-result', 'alias', 'unversioned', 'no-init', 'duplicate-init',
  'provider-message', 'tool-use', 'api-time', 'turns', 'cost', 'error', 'wrong-result', 'unterminated',
  'trailing', 'malformed', 'oversize', 'stderr-oversize', 'api-source-invalid'])('%s cannot become resolution evidence', async mode => {
  expect(await resolveNativeModel(await fixture(mode))).toEqual({ status: 'unknown', reason: 'protocol' })
})

test('a failing child exit cannot certify otherwise successful metadata', async () => {
  expect(await resolveNativeModel(await fixture('exit-failure'))).toEqual({ status: 'unknown', reason: 'process' })
})

test.each(['initial', 'during'])('executable pin rejects %s mismatch', async mode => {
  const input = await fixture(mode === 'during' ? 'drift' : 'success')
  if (mode === 'initial') input.executable.sha256 = '0'.repeat(64)
  expect(await resolveNativeModel(input)).toEqual({ status: 'unknown', reason: 'executable-mismatch' })
})

test('timeout and cancellation stop only the disposable child', async () => {
  const input = await fixture('hang')
  input.timeoutMs = 150
  expect(await resolveNativeModel(input)).toEqual({ status: 'unknown', reason: 'cancelled' })
  input.signal = AbortSignal.abort()
  expect(await resolveNativeModel(input)).toEqual({ status: 'unknown', reason: 'cancelled' })
})

test.each(['selector', 'profile', 'settings', 'sources', 'timeout'])('invalid %s refuses before launch', async mode => {
  const input = await fixture()
  if (mode === 'selector') input.selector = 'fable\nDo a task'
  if (mode === 'profile') input.profileId = ''
  if (mode === 'settings') input.settingsJson = '[]'
  if (mode === 'sources') input.settingSources = ['user', 'user']
  if (mode === 'timeout') input.timeoutMs = NaN
  expect(await resolveNativeModel(input)).toEqual({ status: 'unknown', reason: 'invalid-profile' })
})

test('caller mutation cannot relabel or replace an in-flight snapshot', async () => {
  const input = await fixture()
  const pending = resolveNativeModel(input)
  input.profileId = 'different-profile'
  input.env.PROFILE_SENTINEL = 'changed'
  input.executable.sha256 = '0'.repeat(64)
  expect(await pending).toMatchObject({ status: 'resolved', profileId: 'profile-generation' })
})
