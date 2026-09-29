import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nativeModelPin, NATIVE_CONTINUATION_PROFILE, protectedNativeExecutable, prepareNativeModelLaunch } from '../native-model-launch.ts'
import type { NativeModelResolution } from '../native-model-resolution.ts'
import { observeNativeFileAuth } from '../native-file-auth.ts'

const resolved = (): Extract<NativeModelResolution, { status: 'resolved' }> => ({ status: 'resolved', source: 'native-local-model-command', selector: 'fable',
  modelId: 'claude-fable-5-1', profileId: 'fresh-profile', sessionId: 'diagnostic', observedAtMs: Date.now(),
  executableSha256: NATIVE_CONTINUATION_PROFILE.sha256,
  authEvidence: { status: 'unknown', reason: 'native-init-incomplete', apiKeySource: 'none' } })

test('checked native family pins BOTH parent and Agent family without supplying auth authority', () => {
  expect(nativeModelPin(resolved())).toMatchObject({ pin: { parentModel: 'claude-fable-5-1',
    environmentKey: 'ANTHROPIC_DEFAULT_FABLE_MODEL', value: 'claude-fable-5-1' }, authEvidence: { status: 'unknown' } })
  expect(nativeModelPin({ ...resolved(), modelId: 'claude-fable-5-2' })?.modelId).toBe('claude-fable-5-2')
})

test.each(['source', 'missing-source', 'profile', 'family', 'selector', 'unknown'])('unproven %s cannot pin a native child family', mode => {
  const result = resolved()
  if (mode === 'source') result.authEvidence.apiKeySource = 'apiKeyHelper'
  if (mode === 'missing-source') delete result.authEvidence.apiKeySource
  if (mode === 'profile') result.executableSha256 = '0'.repeat(64)
  if (mode === 'family') result.modelId = 'claude-opus-4-6'
  if (mode === 'selector') result.selector = 'opus'
  expect(nativeModelPin(mode === 'unknown' ? { status: 'unknown', reason: 'protocol' } : result)).toBeUndefined()
})

test('writable ancestry and nonexistent launchers cannot authorize metadata execution', () => {
  expect(protectedNativeExecutable('/tmp/no-native-authority')).toBe(false)
  expect(protectedNativeExecutable('/usr/bin/env')).toBe(true)
})

test.each(['clean', 'environment-drift', 'settings-drift', 'unprotected', 'resume', 'wrong-source'])('fresh launch preserves profile parity: %s', async mode => {
  const root = await mkdtemp(join(tmpdir(), 'native-model-pin-'))
  try {
    const config = join(root, 'config'), settings = join(root, 'launch.json')
    await mkdir(config); await writeFile(settings, '{"hooks":{}}')
    const input = { argv: ['claude', '--model', 'fable', '--settings', settings, ...(mode === 'resume' ? ['--resume', 'old'] : [])],
      cwd: root, env: { HOME: root, CLAUDE_CONFIG_DIR: config, PATH: '/usr/bin' },
      executable: { realPath: '/opt/claude', ...NATIVE_CONTINUATION_PROFILE } }
    const auth = observeNativeFileAuth(input)!
    let calls = 0
    const output = await prepareNativeModelLaunch({ ...input, auth }, { protectedExecutable: () => mode !== 'unprotected',
      resolve: async probe => {
        calls++
        expect(probe.env).toEqual(input.env)
        expect(probe.cwd).toBe(root)
        expect(probe.settingsJson).toBe('{"hooks":{}}')
        expect(probe.settingSources).toEqual(['user', 'project', 'local'])
        if (mode === 'environment-drift') input.env.PATH = '/changed'
        if (mode === 'settings-drift') await writeFile(settings, '{}')
        return { ...resolved(), profileId: probe.profileId,
          ...(mode === 'wrong-source' ? { authEvidence: { status: 'unknown', reason: 'native-init-incomplete', apiKeySource: 'apiKeyHelper' } } : {}) }
      } })
    expect(calls).toBe(mode === 'unprotected' || mode === 'resume' ? 0 : 1)
    if (mode !== 'clean') { expect(output).toBeUndefined(); return }
    expect(output!.argv.slice(1, 3)).toEqual(['--model', 'claude-fable-5-1'])
    expect(output!.env.ANTHROPIC_DEFAULT_FABLE_MODEL).toBe('claude-fable-5-1')
    expect(output!.evidence.authEvidence.status).toBe('unknown')
    expect(output!.current()).toBe(true)
    output!.env.ANTHROPIC_DEFAULT_FABLE_MODEL = 'claude-fable-5'
    expect(output!.current()).toBe(false)
  } finally { await rm(root, { recursive: true, force: true }) }
})
