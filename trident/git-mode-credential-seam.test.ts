/**
 * THE PROBE MUST ASK THE SAME CREDENTIAL STORE THE PUBLISHER WILL USE.
 *
 * The bug this file exists to keep dead: `defaultGitModeProbe` used to shell a
 * bare `gh auth status` and report whatever ambient login state the calling
 * process happened to have. The gateway process holds no `GH_TOKEN` — the
 * credential is injected PER SPAWN — so the probe truthfully answered "not
 * authenticated" about an environment that structurally cannot be, and a build
 * on a GitHub-backed repo was refused with "the outer publisher cannot
 * authenticate" while a valid token sat in the secrets store.
 *
 * So these run against a REAL `SecretsStore` on a temp database and build the
 * `PublisherCredentialSource` exactly the way the composition root does
 * (`githubProcessEnv(await readGitHubToken(store, handle))`). The host runner is
 * a stub that authenticates IFF the call carried the token, which is the shape
 * of a box with no ambient login. `process.env` is never mutated: setting
 * `GH_TOKEN` on the test process would exercise the ambient read being removed
 * and would pass for the broken implementation too.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectDb, asOwnerHandle } from '@neutronai/persistence/index.ts'
import { seedMigratedDb } from '../tests/support/migrated-db.ts'
import { SecretsStore } from '@neutronai/auth/secrets-store.ts'
import {
  githubProcessEnv,
  readGitHubToken,
  storeGitHubToken,
} from '@neutronai/github/credential.ts'
import {
  defaultGitModeProbe,
  detectMergeMode,
  type HostCommandResult,
  type PublisherCredentialSource,
} from './git-mode.ts'

/** A placeholder handle — never the owner's real one. */
const OWNER = 'owner-a'
const TOKEN = 'ghp_TEST_SENTINEL_12345'

let workdir: string
let dataDir: string
let dbPath: string

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'neutron-gitmode-cred-'))
  dataDir = join(workdir, 'project')
  mkdirSync(dataDir, { recursive: true })
  dbPath = join(workdir, 'project.db')
  seedMigratedDb(dbPath)
})

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true })
})

function withStore<T>(fn: (store: SecretsStore) => Promise<T>): Promise<T> {
  const db = ProjectDb.open(dbPath)
  const store = new SecretsStore({ data_dir: dataDir, db })
  return fn(store).finally(() => {
    db.close()
  })
}

/** Exactly the composition root's construction, over a real store. */
function credentialFromStore(store: SecretsStore): PublisherCredentialSource {
  return {
    owner_handle: OWNER,
    source: 'the instance secrets store',
    load: async () => githubProcessEnv(await readGitHubToken(store, asOwnerHandle(OWNER))),
  }
}

/**
 * A host with NO ambient login: the capability call succeeds only when the
 * caller injected the token. `seen` records every environment the host was
 * handed, so a passing assertion can be shown to have gone through the token.
 */
function hostWithNoAmbientLogin(seen: { envs: (Record<string, string> | undefined)[] }) {
  return async (
    cmd: string[],
    _cwd?: string,
    extraEnv?: Record<string, string>,
  ): Promise<HostCommandResult> => {
    if (cmd[0] === 'git') {
      return { ok: true, stdout: 'https://github.com/example-org/example-repo.git', stderr: '', exit_code: 0 }
    }
    seen.envs.push(extraEnv)
    const token = extraEnv?.['GH_TOKEN'] ?? ''
    return token.length > 0
      ? { ok: true, stdout: `Logged in to github.com account ${OWNER}`, stderr: '', exit_code: 0 }
      : { ok: false, stdout: '', stderr: 'You are not logged into any GitHub hosts.', exit_code: 1 }
  }
}

test('a token in the store makes the probe available on a host with no ambient login', async () => {
  const seen = { envs: [] as (Record<string, string> | undefined)[] }
  await withStore(async (store) => {
    await storeGitHubToken(store, asOwnerHandle(OWNER), TOKEN)
    const probe = defaultGitModeProbe(credentialFromStore(store), hostWithNoAmbientLogin(seen))

    expect(await probe.publisherAvailable()).toEqual({ authenticated: true })
    // …and therefore a GitHub-origin repo resolves to PR mode rather than being
    // refused. This is the reported symptom, inverted.
    expect(await detectMergeMode('/repo', probe)).toBe('pr')
  })

  // CONTROL that the assertion above measured what it claims: the token really
  // travelled from the store into the capability call. Without this the test
  // would also pass for a probe that ignored the store on a logged-in host.
  expect(seen.envs.length).toBeGreaterThan(0)
  expect(seen.envs.every((e) => e?.['GH_TOKEN'] === TOKEN)).toBe(true)
})

test('CONTROL — the SAME host with an empty store refuses, naming the cause and the handle', async () => {
  const seen = { envs: [] as (Record<string, string> | undefined)[] }
  await withStore(async (store) => {
    const probe = defaultGitModeProbe(credentialFromStore(store), hostWithNoAmbientLogin(seen))

    expect(await probe.publisherAvailable()).toEqual({
      authenticated: false,
      cause: 'no_credential_available',
      detail: 'You are not logged into any GitHub hosts.',
    })
    let msg = ''
    try {
      await detectMergeMode('/repo', probe)
    } catch (err) {
      msg = err instanceof Error ? err.message : String(err)
    }
    // The refusal names WHICH of the causes, and under WHICH handle the lookup
    // was attempted. "cannot authenticate" alone sent a reader hunting.
    expect(msg).toContain('refusing to silently weaken the PR merge gate')
    expect(msg).toContain('no GitHub credential is stored')
    expect(msg).toContain('not an expired token')
    expect(msg).toContain(OWNER)
    expect(msg).toContain('the instance secrets store')
  })
  // The host WAS asked, carrying the empty environment the publisher would
  // carry — the probe is a faithful mirror of the publisher, not a stricter
  // gate in front of it (`git-mode.test.ts` > "the probe is never stricter than
  // the publisher it speaks for"). What makes this `no_credential_available`
  // rather than `credential_rejected` is that there was no token to reject.
  expect(seen.envs.length).toBeGreaterThan(0)
  expect(seen.envs.every((e) => e !== undefined && Object.keys(e).length === 0)).toBe(true)
})

test('a credential connected AFTER the probe was built takes effect with no restart', async () => {
  await withStore(async (store) => {
    const seen = { envs: [] as (Record<string, string> | undefined)[] }
    // Built once, as the composition root builds it — at boot, before the owner
    // has connected anything.
    const probe = defaultGitModeProbe(credentialFromStore(store), hostWithNoAmbientLogin(seen))
    expect(await probe.publisherAvailable()).toEqual({
      authenticated: false,
      cause: 'no_credential_available',
      detail: 'You are not logged into any GitHub hosts.',
    })

    await storeGitHubToken(store, asOwnerHandle(OWNER), TOKEN)

    // Same probe object, no re-composition: the credential is resolved per call.
    expect(await probe.publisherAvailable()).toEqual({ authenticated: true })
  })
})

test('an empty store on a host that IS logged in stays available — the probe never out-strictens the publisher', async () => {
  const seen = { envs: [] as (Record<string, string> | undefined)[] }
  await withStore(async (store) => {
    // Nothing connected in-app, but the host ran `gh auth login` at some point.
    // The publisher inherits that session (an empty extra-env makes `spawnCapture`
    // omit `env` entirely), so publishing WORKS on this box today — and a probe
    // that refused it would break a working install in the name of fixing one.
    const probe = defaultGitModeProbe(
      credentialFromStore(store),
      async (cmd, _cwd, extraEnv): Promise<HostCommandResult> => {
        if (cmd[0] === 'git') {
          return {
            ok: true,
            stdout: 'https://github.com/example-org/example-repo.git',
            stderr: '',
            exit_code: 0,
          }
        }
        seen.envs.push(extraEnv)
        return { ok: true, stdout: 'Logged in to github.com', stderr: '', exit_code: 0 }
      },
    )
    expect(await readGitHubToken(store, asOwnerHandle(OWNER))).toBeNull()
    expect(await probe.publisherAvailable()).toEqual({ authenticated: true })
    expect(await detectMergeMode('/repo', probe)).toBe('pr')
  })
  // CONTROL that this measured the intended path: the store really was empty
  // (asserted above) AND the host really was consulted, with the same empty
  // environment the publisher would carry.
  expect(seen.envs.length).toBeGreaterThan(0)
  expect(seen.envs.every((e) => e !== undefined && Object.keys(e).length === 0)).toBe(true)
})

test('a token the host rejects is reported as rejected, never as missing', async () => {
  await withStore(async (store) => {
    await storeGitHubToken(store, asOwnerHandle(OWNER), TOKEN)
    const probe = defaultGitModeProbe(
      credentialFromStore(store),
      async (cmd): Promise<HostCommandResult> => {
        if (cmd[0] === 'git') {
          return { ok: true, stdout: 'https://github.com/example-org/example-repo.git', stderr: '', exit_code: 0 }
        }
        return { ok: false, stdout: '', stderr: 'HTTP 401: Bad credentials', exit_code: 1 }
      },
    )
    const res = await probe.publisherAvailable()
    expect(res.authenticated).toBe(false)
    expect(res.authenticated === false && res.cause).toBe('credential_rejected')
    // The detail keeps `gh`'s own words AND names which credential was tried, so
    // the owner knows it was the STORED one and not the host's ambient login.
    expect(res.authenticated === false && res.detail).toContain('HTTP 401: Bad credentials')
    expect(res.authenticated === false && res.detail).toContain(
      'the credential resolved from the configured source',
    )
    let msg = ''
    try {
      await detectMergeMode('/repo', probe)
    } catch (err) {
      msg = err instanceof Error ? err.message : String(err)
    }
    expect(msg).toContain('REJECTED')
    expect(msg).not.toContain('no GitHub credential is stored')
  })
})
