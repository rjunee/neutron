import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { observeNativeFileAuth } from '../native-file-auth.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'native-file-auth-')); roots.push(root)
  const config = join(root, 'config'), cwd = join(root, 'project'), policy = join(root, 'policy'), explicit = join(root, 'launch.json')
  await Promise.all([config, cwd, policy].map(path => mkdir(path)))
  await writeFile(explicit, JSON.stringify({ hooks: {} }))
  const input = { cwd, argv: ['claude', '--settings', explicit], env: { HOME: root, CLAUDE_CONFIG_DIR: config } as Record<string, string | undefined> }
  return { root, config, cwd, policy, explicit, input, observe: () => observeNativeFileAuth(input, policy) }
}

test('fresh clean file-auth source observation is credential-free and settings changes revoke it', async () => {
  const f = await fixture(), observed = f.observe()
  expect(observed?.current()).toBe(true)
  expect(observed?.evidence).toEqual({ configDir: f.config, settingsDigest: expect.stringMatching(/^[a-f0-9]{64}$/) })
  await writeFile(f.explicit, JSON.stringify({ hooks: {}, env: { ANTHROPIC_API_KEY: 'test-only' } }))
  expect(observed?.current()).toBe(false)
  expect(f.observe()).toBeUndefined()
})

test.each(['ANTHROPIC_UNIX_SOCKET', 'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR', 'ANTHROPIC_PROFILE', 'CLAUDE_CODE_HOST_AUTH_ENV_VAR'])('inherited %s is not file authentication', async key => {
  const f = await fixture(); f.input.env[key] = 'fixture'
  expect(f.observe()).toBeUndefined()
})

test.each(['user-helper', 'project-env', 'policy-helper', 'drop-in-env', 'legacy-key', 'profile'])('alternate auth source %s refuses', async mode => {
  const f = await fixture()
  let path = join(f.config, 'settings.json'), value: object = { apiKeyHelper: 'never-execute' }
  if (mode === 'project-env') { path = join(f.cwd, '.claude', 'settings.local.json'); value = { env: { ANTHROPIC_AUTH_TOKEN: 'test-only' } } }
  if (mode === 'policy-helper') path = join(f.policy, 'managed-settings.json')
  if (mode === 'drop-in-env') { path = join(f.policy, 'managed-settings.d', 'auth.json'); value = { env: {} } }
  if (mode === 'legacy-key') { path = join(f.config, '.claude.json'); value = { primaryApiKey: 'test-only' } }
  if (mode === 'profile') path = join(f.root, '.config', 'anthropic', 'config.json')
  await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, JSON.stringify(value))
  expect(f.observe()).toBeUndefined()
})

test('added policy source and changed launch environment revoke a clean observation', async () => {
  const f = await fixture(), first = f.observe()!
  await writeFile(join(f.policy, 'managed-settings.json'), '{}')
  expect(first.current()).toBe(false)
  const next = f.observe()!
  f.input.env.ANTHROPIC_UNIX_SOCKET = '/fixture.sock'
  expect(next.current()).toBe(false)
})
