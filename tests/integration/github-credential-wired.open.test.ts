/**
 * GITHUB CREDENTIAL — the DONE-MEANS-WIRED test.
 *
 * `github/device-flow.ts`, `github/credential.ts` and `trident/git-mode.ts`'s
 * credentialed runner were built across three PRs, each with its own passing unit
 * tests, and NONE of that proves a build can push. The composer is what decides:
 * `gateway/composition/build-core-modules.ts:512` reads
 * `tridentWiring.run_host ?? spawnCapture`, so if `open/composer.ts` omits
 * `run_host` the fallback is a bare uncredentialed spawn and every unit test in
 * the chain still passes. That is precisely the "both halves exist and nothing
 * joins them" shape this repo keeps finding.
 *
 * So this asserts against THE PRODUCTION COMPOSER'S OUTPUT (Decisions Log
 * 2026-08-01) rather than a hand-built wiring literal, and then runs a REAL
 * subprocess through the runner the composer actually produced. The full chain
 * under test is: composer → lazy runner → SecretsStore → process env → child.
 *
 * The ordering of the two assertions matters as much as the assertions. The token
 * is stored AFTER the composition is built, because that is what happens in life:
 * the gateway boots, and the owner connects GitHub from chat minutes or days
 * later. A runner that read the token eagerly at boot would pass a test that
 * stored the token first and fail this one.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { createIsolatedHome, type IsolatedHome } from '../support/test-isolation.ts'

import { seedMigratedDb } from '../support/migrated-db.ts'
import { ProjectDb, asOwnerHandle } from '@neutronai/persistence/index.ts'
import { buildOpenGraphComposer } from '@neutronai/open/composer.ts'
import { SecretsStore } from '@neutronai/auth/secrets-store.ts'
import { storeGitHubToken } from '@neutronai/github/credential.ts'

const SLUG = 'owner'
const TOKEN = 'gho_synthetic_wiring_probe_token'

let home: IsolatedHome

beforeEach(() => {
  home = createIsolatedHome({
    extraEnvKeys: [
      'ANTHROPIC_API_KEY',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'NOTIFY_SOCKET',
      'NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET',
    ],
    env: {
      NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET: 'open-test-secret-0123456789',
      // A non-null LLM pool is what makes the composer emit the `trident` wiring
      // at all (`open/composer.ts:961` — LLM-less boxes never advance a run).
      ANTHROPIC_API_KEY: 'sk-ant-synthetic-github-wired',
      CLAUDE_CODE_OAUTH_TOKEN: undefined,
      NOTIFY_SOCKET: undefined,
    },
  })
})

afterEach(() => {
  home.restore()
})

async function composeOpen(): Promise<{
  run_host: (cmd: string[], cwd?: string) => Promise<{ ok: boolean; stdout: string }>
  db: ProjectDb
}> {
  seedMigratedDb(process.env['NEUTRON_DB_PATH']!)
  const db = ProjectDb.open(process.env['NEUTRON_DB_PATH']!)
  const composition = await buildOpenGraphComposer({ env: process.env })({
    db,
    project_slug: SLUG,
  })
  const wiring = (composition as { trident?: { run_host?: unknown } }).trident
  // If this throws, the composer stopped supplying the wiring and the whole
  // credential chain silently reverted to an uncredentialed spawn.
  if (wiring === undefined || typeof wiring.run_host !== 'function') {
    throw new Error('composer did not supply trident.run_host — the credential is NOT wired')
  }
  return {
    run_host: wiring.run_host as (
      cmd: string[],
      cwd?: string,
    ) => Promise<{ ok: boolean; stdout: string }>,
    db,
  }
}

describe('the GitHub credential reaches a build, through the production composer', () => {
  test('the composer supplies trident.run_host at all', async () => {
    const { run_host } = await composeOpen()
    expect(typeof run_host).toBe('function')
  })

  test('an instance that never connected runs commands with NO GH_TOKEN', async () => {
    const { run_host } = await composeOpen()
    const res = await run_host(['sh', '-c', 'if [ "${GH_TOKEN+x}" = x ]; then printf present; else printf absent; fi'])
    expect(res.ok).toBe(true)
    // Unchanged behaviour for the un-connected instance is the compatibility
    // property: `githubProcessEnv(null)` is `{}`.
    expect(res.stdout).toBe('absent')
  })

  test('a token connected AFTER boot reaches the child process — no restart', async () => {
    const { run_host, db } = await composeOpen()

    // Before: nothing.
    expect((await run_host(['sh', '-c', 'if [ "${GH_TOKEN+x}" = x ]; then printf present; else printf absent; fi'])).stdout).toBe('absent')

    // The owner connects from chat, long after the composition was built. This is
    // the same store + owner handle the composer resolves through.
    const store = new SecretsStore({ data_dir: process.env['NEUTRON_HOME']!, db })
    await storeGitHubToken(store, asOwnerHandle(SLUG), TOKEN)

    // After: the SAME runner, never re-composed, now carries it.
    const res = await run_host(['sh', '-c', 'if [ "$GH_TOKEN" = "$1" ]; then printf match; else printf mismatch; fi', 'probe', TOKEN])
    expect(res.ok).toBe(true)
    expect(res.stdout).toBe('match')
  })

  test('git is configured to use the token for github.com, and nothing is written to disk', async () => {
    const { run_host, db } = await composeOpen()
    const store = new SecretsStore({ data_dir: process.env['NEUTRON_HOME']!, db })
    await storeGitHubToken(store, asOwnerHandle(SLUG), TOKEN)

    // The credential helper arrives via GIT_CONFIG_COUNT/KEY_0/VALUE_0, which is
    // what makes `git push` over HTTPS work without a global config edit. Ask git
    // itself what it resolved rather than asserting on our own env vars.
    const res = await run_host(['git', 'config', '--get', 'credential.https://github.com.helper'])
    expect(res.ok).toBe(true)
    expect(res.stdout.includes('username=x-access-token')).toBe(true)
    // The helper reads $GH_TOKEN at invocation; the secret itself is never a
    // config value, so it cannot leak into a committed or dumped config.
    expect(res.stdout.includes(TOKEN)).toBe(false)
  })
})

test('full-suite runner excludes ambient credentials from every lane and failed assertion output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'github-suite-boundary-'))
  const canary = 'synthetic-ambient-github-credential-canary'
  const credentialKeys = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN',
    'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_KEY_9', 'GIT_CONFIG_VALUE_9']
  try {
    const source = `import { expect, test } from 'bun:test'
const keys = ${JSON.stringify(credentialKeys)}
// Discovery loads this module too. Report only a boolean even if it fails.
if (keys.some(key => process.env[key] !== undefined)) throw new Error('credential inherited during discovery')
// Bun versions differ in the no-match summary; keep a real discovery control.
test('__neutron_runtests_no_match__ discovery control', () => {
  expect(keys.some(key => process.env[key] !== undefined)).toBe(false)
})
test('credential isolation and retained CI metadata', () => {
  for (const key of keys) expect(process.env[key]).toBeUndefined()
  expect(process.env.GITHUB_ACTIONS).toBe('fixture-ci-metadata')
  expect(Boolean(process.env.PATH)).toBe(true)
})
test('intentional assertion failure still reaches the host', () => {
  expect(process.env.NEUTRON_TEST_INTENTIONAL_FAILURE === '1').toBe(false)
})
`
    for (const [name, marker] of [['general', ''], ['database', 'pglite'],
      ['device', 'installNativeHarness'], ['http', 'Bun.serve(']]) {
      await writeFile(join(root, `${name}.test.ts`), `// ${marker}\n${source}`)
    }
    for (const failure of ['0', '1']) {
      const log = join(root, `suite-${failure}.log`)
      const child = Bun.spawn(['bash', resolve(import.meta.dir, '../../scripts/run-tests.sh')], {
        env: {
          ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('NEUTRON_TEST_'))),
          ...Object.fromEntries(credentialKeys.map(key => [key, canary])),
          GITHUB_ACTIONS: 'fixture-ci-metadata',
          NEUTRON_TEST_ROOT: root,
          NEUTRON_BUN_BIN: process.execPath,
          NEUTRON_TEST_CONCURRENCY: '1',
          NEUTRON_TEST_PGLITE_RETRIES: '0',
          NEUTRON_TEST_INTENTIONAL_FAILURE: failure,
        },
        stdout: 'pipe', stderr: 'pipe',
      })
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ])
      await writeFile(log, stdout + stderr)
      const output = await readFile(log, 'utf8')
      // Assert booleans so even a regression never echoes the captured log.
      expect(output.includes(canary)).toBe(false)
      expect(output.includes('credential inherited during discovery')).toBe(false)
      expect(output.includes('4 test files (bun-discovered: 4)')).toBe(true)
      expect(output.includes('1-file PGLite lane + 1-file device lane + 1-file real-HTTP lane')).toBe(true)
      expect(exitCode).toBe(Number(failure))
      expect(output.includes('intentional assertion failure still reaches the host')).toBe(true)
      if (failure === '1') expect(output.includes('Expected: false')).toBe(true)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

test('credential assertions fail safely when a focused test inherits a credential', async () => {
  const canary = 'synthetic-focused-credential-canary'
  for (const [file, name] of [
    [import.meta.path, 'an instance that never connected runs commands with NO GH_TOKEN'],
    [resolve(import.meta.dir, '../../open/__tests__/project-build-wiring.test.ts'), 'suite child excludes the stored GitHub credential'],
  ]) {
    // Bun's implicit child environment retains its startup environment even after
    // delete process.env.GH_TOKEN. Inject at process birth to reproduce that case.
    const child = Bun.spawn([process.execPath, 'test', file!, '-t', name!], {
      env: { ...process.env, GH_TOKEN: canary }, stdout: 'pipe', stderr: 'pipe',
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ])
    const output = stdout + stderr
    expect(exitCode).toBe(1)
    expect(output.includes('expect(received).toBe(expected)') || output.includes('expect(received).toEqual(expected)')).toBe(true)
    expect(output.includes(canary)).toBe(false)
    expect(output.toLowerCase().includes('present')).toBe(true)
  }
}, 30_000)
