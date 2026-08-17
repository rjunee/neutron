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

import { createIsolatedHome, type IsolatedHome } from '../support/test-isolation.ts'

import { ProjectDb, asOwnerHandle } from '@neutronai/persistence/index.ts'
import { buildOpenGraphComposer } from '@neutronai/open/composer.ts'
import { SecretsStore } from '@neutronai/auth/secrets-store.ts'
import { storeGitHubToken } from '@neutronai/github/credential.ts'
import { openMigratedDbAt } from '../support/migrated-db.ts'

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
  const db = openMigratedDbAt(process.env['NEUTRON_DB_PATH']!)
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
    const res = await run_host(['sh', '-c', 'echo "${GH_TOKEN:-unset}"'])
    expect(res.ok).toBe(true)
    // Unchanged behaviour for the un-connected instance is the compatibility
    // property: `githubProcessEnv(null)` is `{}`.
    expect(res.stdout).toBe('unset')
  })

  test('a token connected AFTER boot reaches the child process — no restart', async () => {
    const { run_host, db } = await composeOpen()

    // Before: nothing.
    expect((await run_host(['sh', '-c', 'echo "${GH_TOKEN:-unset}"'])).stdout).toBe('unset')

    // The owner connects from chat, long after the composition was built. This is
    // the same store + owner handle the composer resolves through.
    const store = new SecretsStore({ data_dir: process.env['NEUTRON_HOME']!, db })
    await storeGitHubToken(store, asOwnerHandle(SLUG), TOKEN)

    // After: the SAME runner, never re-composed, now carries it.
    const res = await run_host(['printenv', 'GH_TOKEN'])
    expect(res.ok).toBe(true)
    expect(res.stdout).toBe(TOKEN)
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
    expect(res.stdout).toContain('username=x-access-token')
    // The helper reads $GH_TOKEN at invocation; the secret itself is never a
    // config value, so it cannot leak into a committed or dumped config.
    expect(res.stdout).not.toContain(TOKEN)
  })
})
