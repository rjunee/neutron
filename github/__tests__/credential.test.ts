/**
 * @neutronai/github — token storage + the git credential handoff.
 *
 * The storage half is thin. The env half carries a real security decision and
 * that is what most of these assert: the token must be offered to github.com and
 * NOWHERE ELSE, must never be written to a config file, and must never end up
 * embedded in a URL or duplicated into a second variable. An agent loop clones
 * dependencies from arbitrary origins; a globally-scoped credential helper would
 * present the owner's GitHub token to every one of them.
 */

import { describe, expect, it } from 'bun:test'

import type { OwnerHandle } from '@neutronai/persistence/index.ts'

import {
  GITHUB_SECRET_KIND,
  GITHUB_SECRET_LABEL,
  githubProcessEnv,
  readGitHubToken,
  storeGitHubToken,
} from '../credential.ts'

const OWNER = 'owner-1' as OwnerHandle
const TOKEN = 'gho_averysecrettokenvalue'

function fakeStore(seed: string | null = null): {
  put: (i: { owner_handle: OwnerHandle; kind: string; label: string; plaintext: string }) => Promise<{ id: string }>
  get: (i: { owner_handle: OwnerHandle; kind: string; label: string }) => Promise<string | null>
  puts: Array<{ kind: string; label: string; plaintext: string }>
  gets: Array<{ kind: string; label: string }>
} {
  const puts: Array<{ kind: string; label: string; plaintext: string }> = []
  const gets: Array<{ kind: string; label: string }> = []
  let stored = seed
  return {
    puts,
    gets,
    put: async (i) => {
      puts.push({ kind: i.kind, label: i.label, plaintext: i.plaintext })
      stored = i.plaintext
      return { id: 'sec-1' }
    },
    get: async (i) => {
      gets.push({ kind: i.kind, label: i.label })
      return stored
    },
  }
}

describe('storage', () => {
  it('reuses the existing oauth_token kind rather than inventing one', async () => {
    // A new secret kind would mean a second credential path to rotate, audit and
    // eventually forget about.
    const s = fakeStore()
    await storeGitHubToken(s as never, OWNER, TOKEN)
    expect(s.puts[0]).toMatchObject({ kind: 'oauth_token', label: 'github', plaintext: TOKEN })
    expect(GITHUB_SECRET_KIND).toBe('oauth_token')
    expect(GITHUB_SECRET_LABEL).toBe('github')
  })

  it('refuses to store an empty token', async () => {
    // Storing '' turns a clean "not connected" into a helper that authenticates
    // as nobody and a confusing 403 at push time.
    const s = fakeStore()
    await expect(storeGitHubToken(s as never, OWNER, '')).rejects.toThrow()
    expect(s.puts.length).toBe(0)
  })

  it('reads back what was stored, from the same coordinates', async () => {
    const s = fakeStore()
    await storeGitHubToken(s as never, OWNER, TOKEN)
    expect(await readGitHubToken(s as never, OWNER)).toBe(TOKEN)
    expect(s.gets[0]).toMatchObject({ kind: 'oauth_token', label: 'github' })
  })

  it('normalises an empty stored value to null, so callers have ONE check', async () => {
    expect(await readGitHubToken(fakeStore('') as never, OWNER)).toBeNull()
  })

  it('returns null when GitHub was never connected', async () => {
    expect(await readGitHubToken(fakeStore(null) as never, OWNER)).toBeNull()
  })
})

describe('githubProcessEnv — the credential handoff', () => {
  it('scopes the helper to github.com and NOWHERE else', async () => {
    // The whole point. A bare `credential.helper` would offer the owner's token
    // to any origin a build happens to contact.
    const env = githubProcessEnv(TOKEN)
    expect(env['GIT_CONFIG_KEY_0']).toBe('credential.https://github.com.helper')
    expect(env['GIT_CONFIG_KEY_0']).not.toBe('credential.helper')
    expect(env['GIT_CONFIG_KEY_0']).toContain('github.com')
  })

  it('puts the token in GH_TOKEN only — never duplicated into the config value', () => {
    // GIT_CONFIG_VALUE_0 is what a `ps` listing or an echoed command line is
    // most likely to expose, so the secret must not be interpolated into it.
    const env = githubProcessEnv(TOKEN)
    expect(env['GH_TOKEN']).toBe(TOKEN)
    expect(env['GIT_CONFIG_VALUE_0']).not.toContain(TOKEN)
    expect(env['GIT_CONFIG_VALUE_0']).toContain('$GH_TOKEN')
  })

  it('never embeds the token in a URL', () => {
    // `https://x-access-token:TOKEN@github.com` lands in .git/config and in
    // `git remote -v` — a credential in a log by another route.
    const serialised = JSON.stringify(githubProcessEnv(TOKEN))
    expect(serialised).not.toContain(`:${TOKEN}@`)
    expect(serialised).not.toContain('https://x-access-token:')
  })

  it('writes nothing to disk — everything rides in the environment', () => {
    // Asserted structurally: git only reads these three from the env, so a
    // config FILE path appearing here would mean something is being persisted.
    const env = githubProcessEnv(TOKEN)
    expect(Object.keys(env).sort()).toEqual([
      'GH_TOKEN',
      'GIT_CONFIG_COUNT',
      'GIT_CONFIG_KEY_0',
      'GIT_CONFIG_VALUE_0',
    ])
    expect(env['GIT_CONFIG_COUNT']).toBe('1')
  })

  it('returns an EMPTY env when unconnected, so callers can spread unconditionally', () => {
    // An unconnected instance must behave exactly as it does today: public
    // clones fine, pushes failing with git's own message rather than a
    // half-configured helper's.
    expect(githubProcessEnv(null)).toEqual({})
    expect(githubProcessEnv('')).toEqual({})
  })

  it('uses the username GitHub documents for token auth', () => {
    expect(githubProcessEnv(TOKEN)['GIT_CONFIG_VALUE_0']).toContain('username=x-access-token')
  })
})
