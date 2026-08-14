/**
 * The PRODUCTION halves of the host-deploy seams, against a REAL git repo and a
 * REAL Request object.
 *
 * The service suite (`host-deploy.test.ts`) proves every guard against injected
 * seams. That leaves the two things which can only ever be wrong in production
 * asserted by nothing: whether `createHostDeployRemoteGit` asks the CONTROL
 * PLANE the right question and reads its answer correctly, and whether
 * `createHostDeployDispatch` puts the credential where it claims to.
 *
 * The git view is no longer local, so these tests drive a recording `fetch`
 * rather than a temp repo: what can be wrong in production now is the URL it
 * derives, where the credential lands, and whether a refusal is read as the
 * owner's typo or as the machinery breaking.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createHostDeployDispatch,
  createHostDeployRemoteGit,
  type HostDeployFetch,
} from '../host-deploy-runtime.ts'
import { HOST_DEPLOY_DETAIL_CAP, type HostDeployConfigState } from '../host-deploy.ts'

let repo: string

/** Deterministic identity + dates so the fixture never depends on ~/.gitconfig. */
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.test',
  GIT_COMMITTER_NAME: 'fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.test',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
}

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, env: GIT_ENV, encoding: 'utf8' }).trim()
}

function commit(file: string, subject: string): string {
  writeFileSync(join(repo, file), `${subject}\n`)
  git('add', file)
  git('commit', '-m', subject)
  return git('rev-parse', 'HEAD')
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'neutron-host-deploy-git-'))
  git('init', '--initial-branch=main', '.')
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe('createHostDeployRemoteGit — the control plane answers, not local git', () => {
  const URL_ = 'https://control.example.com/v1/deploy'
  const TOKEN = 'tok-secret-value'
  const SHA_A = 'a'.repeat(40)
  const SHA_B = 'b'.repeat(40)

  const configured = (): HostDeployConfigState => ({
    configured: true,
    endpoint: { url: URL_, token: TOKEN },
  })

  /** Records every request so a test can assert the URL, headers and body. */
  function recorder(reply: (body: Record<string, unknown>) => { status: number; json: unknown }) {
    const seen: { url: string; init: RequestInit }[] = []
    const fetchImpl: HostDeployFetch = async (url, init) => {
      seen.push({ url, init })
      const parsed = JSON.parse(String(init.body)) as Record<string, unknown>
      const { status, json } = reply(parsed)
      return new Response(JSON.stringify(json), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    }
    return { seen, fetchImpl }
  }

  const happy = () =>
    recorder((body) => {
      if (typeof body['from'] === 'string' && typeof body['to'] === 'string') {
        return { status: 200, json: { commits: [{ sha: 'c'.repeat(40), subject: 'one' }], total: 7 } }
      }
      return {
        status: 200,
        json: { target_sha: SHA_B, current_sha: SHA_A, commits: [], total: 0 },
      }
    })

  test('resolves a ref against the CONTROL PLANE, with the credential in the header only', async () => {
    const { seen, fetchImpl } = happy()
    const g = createHostDeployRemoteGit({ resolveConfig: configured, fetchImpl })

    expect(await g.resolveTarget('origin/main')).toBe(SHA_B)
    expect(seen).toHaveLength(1)
    // The preview hangs off the ONE configured deploy url — a second configured
    // value could be half-set, and one value cannot disagree with itself.
    expect(seen[0]?.url).toBe('https://control.example.com/v1/deploy/preview')
    expect((seen[0]?.init.headers as Record<string, string>)['authorization']).toBe(`Bearer ${TOKEN}`)
    // The credential appears in the header and NOWHERE else.
    expect(String(seen[0]?.init.body)).not.toContain(TOKEN)
    expect(seen[0]?.url).not.toContain(TOKEN)
  })

  test('a trailing slash on the configured url does not produce a //preview that 404s', async () => {
    const { seen, fetchImpl } = happy()
    const g = createHostDeployRemoteGit({
      resolveConfig: () => ({ configured: true, endpoint: { url: `${URL_}/`, token: TOKEN } }),
      fetchImpl,
    })
    await g.resolveTarget('origin/main')
    expect(seen[0]?.url).toBe('https://control.example.com/v1/deploy/preview')
  })

  test('HEAD reports the pin the host is ON, not the ref that was asked about', async () => {
    const { fetchImpl } = happy()
    const g = createHostDeployRemoteGit({ resolveConfig: configured, fetchImpl })
    expect(await g.revParse('HEAD')).toBe(SHA_A)
  })

  test('an UNKNOWN ref is null — the interface says so, and the service renders it as the owner\'s typo', async () => {
    const { fetchImpl } = recorder(() => ({ status: 404, json: { error: 'does not know the ref' } }))
    const g = createHostDeployRemoteGit({ resolveConfig: configured, fetchImpl })
    expect(await g.resolveTarget('v9.9.9')).toBeNull()
  })

  test('the control plane FAILING throws — it is never reported as an unknown ref', async () => {
    // Collapsing these sends the owner hunting for a typo that is not there.
    const { fetchImpl } = recorder(() => ({ status: 500, json: { error: 'git exploded' } }))
    const g = createHostDeployRemoteGit({ resolveConfig: configured, fetchImpl })
    await expect(g.resolveTarget('origin/main')).rejects.toThrow(/git exploded/)
  })

  test('a 401 throws rather than reading as an unknown ref', async () => {
    const { fetchImpl } = recorder(() => ({ status: 401, json: { error: 'bearer token required' } }))
    const g = createHostDeployRemoteGit({ resolveConfig: configured, fetchImpl })
    await expect(g.resolveTarget('origin/main')).rejects.toThrow()
  })

  test('a range sends BOTH ends, so the reversed one is a real answer and not a cached slice', async () => {
    const { seen, fetchImpl } = happy()
    const g = createHostDeployRemoteGit({ resolveConfig: configured, fetchImpl })

    const range = await g.commitsBetween(SHA_B, SHA_A, 5)
    expect(range.total).toBe(7)
    expect(range.commits).toEqual([{ sha: 'c'.repeat(40), subject: 'one' }])
    const body = JSON.parse(String(seen[0]?.init.body)) as Record<string, unknown>
    expect(body).toEqual({ from: SHA_B, to: SHA_A, limit: 5 })
  })

  test('a failed range THROWS — an empty list would render as "nothing would change"', async () => {
    const { fetchImpl } = recorder(() => ({ status: 500, json: { error: 'bad revision' } }))
    const g = createHostDeployRemoteGit({ resolveConfig: configured, fetchImpl })
    await expect(g.commitsBetween(SHA_A, SHA_B, 5)).rejects.toThrow(/bad revision/)
  })

  test('total is never reported below the number of commits actually returned', async () => {
    const { fetchImpl } = recorder(() => ({
      status: 200,
      json: { commits: [{ sha: 'c'.repeat(40), subject: 'one' }, { sha: 'd'.repeat(40), subject: 'two' }], total: 1 },
    }))
    const g = createHostDeployRemoteGit({ resolveConfig: configured, fetchImpl })
    expect((await g.commitsBetween(SHA_A, SHA_B, 5)).total).toBe(2)
  })

  test('a malformed commit entry is dropped rather than rendered', async () => {
    const { fetchImpl } = recorder(() => ({
      status: 200,
      json: { commits: [{ sha: 'nope' }, { sha: 'e'.repeat(40), subject: 'real' }], total: 2 },
    }))
    const g = createHostDeployRemoteGit({ resolveConfig: configured, fetchImpl })
    expect((await g.commitsBetween(SHA_A, SHA_B, 5)).commits).toEqual([
      { sha: 'e'.repeat(40), subject: 'real' },
    ])
  })

  test('an UNCONFIGURED instance throws rather than answering null', async () => {
    // null would read as "this checkout does not know that ref" — a lie about the
    // owner's input rather than the truth about our own configuration.
    const { fetchImpl } = happy()
    const g = createHostDeployRemoteGit({
      resolveConfig: () => ({ configured: false, reason: 'no control plane url is set' }),
      fetchImpl,
    })
    await expect(g.resolveTarget('origin/main')).rejects.toThrow(/not configured/)
  })

  test('config is resolved on EVERY call, never captured at construction', async () => {
    let calls = 0
    const { fetchImpl } = happy()
    const g = createHostDeployRemoteGit({
      resolveConfig: () => {
        calls += 1
        return configured()
      },
      fetchImpl,
    })
    await g.resolveTarget('origin/main')
    await g.revParse('HEAD')
    expect(calls).toBe(2)
  })
})

describe('createHostDeployDispatch — where the credential goes', () => {
  test('the token is in the Authorization header and NOWHERE else', async () => {
    const seen: Array<{ url: string; headers: Record<string, string>; body: string }> = []
    const dispatch = createHostDeployDispatch({
      fetchImpl: async (input, init) => {
        const url = String(input)
        const headers: Record<string, string> = {}
        for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
          headers[k.toLowerCase()] = v
        }
        seen.push({ url, headers, body: String(init?.body ?? '') })
        return new Response('queued as run 4821', { status: 202 })
      },
    })

    const result = await dispatch({
      url: 'https://control.example.test/v1/deploy',
      token: 'hdp-secret-token-9f3a2b1c8d7e6f5a4b3c2d1e',
      ref: 'origin/main',
      sha: 'ff00112233445566778899aabbccddeeff001122',
    })

    expect(result).toEqual({ ok: true, detail: 'queued as run 4821' })
    expect(seen).toHaveLength(1)
    const call = seen[0]!
    expect(call.headers['authorization']).toBe('Bearer hdp-secret-token-9f3a2b1c8d7e6f5a4b3c2d1e')
    // POSITIVE control: the payload DOES carry what it is supposed to…
    expect(call.body).toContain('ff00112233445566778899aabbccddeeff001122')
    expect(call.body).toContain('origin/main')
    // …and NOT the credential.
    expect(call.body).not.toContain('hdp-secret-token')
    expect(call.url).not.toContain('hdp-secret-token')
  })

  test('an HTTP refusal is DATA, not an exception', async () => {
    const dispatch = createHostDeployDispatch({
      fetchImpl: async () => new Response('the deploy window is closed until 06:00', { status: 409 }),
    })
    const result = await dispatch({
      url: 'https://control.example.test/v1/deploy',
      token: 't'.repeat(32),
      ref: 'origin/main',
      sha: 'ff00112233445566778899aabbccddeeff001122',
    })
    expect(result.ok).toBe(false)
    expect(result.detail).toBe('HTTP 409 — the deploy window is closed until 06:00')
  })

  test('a credential straddling the detail cap cannot leak a PREFIX of itself', async () => {
    // Argus r1 major, confirmed by two reviewers independently. The body used to
    // be SLICED to HOST_DEPLOY_DETAIL_CAP and only then handed to the service's
    // scrubber — and the scrubber is a split/join on the FULL secret, so a token
    // cut by the slice is not a match and its surviving prefix rode into the
    // owner's chat and the "host-deploy call refused" log line intact.
    const token = 'hdp-secret-token-9f3a2b1c8d7e6f5a4b3c2d1e'
    const url = 'https://control.example.test/v1/deploy'
    // Place the token so it STRADDLES the cap: 24 of its 41 characters fall
    // inside, 17 outside. Reviewer A's exact repro.
    const prefixLen = HOST_DEPLOY_DETAIL_CAP - 24
    const body = `${'e'.repeat(prefixLen)}${token} trailing`

    const dispatch = createHostDeployDispatch({
      fetchImpl: async () => new Response(body, { status: 401 }),
    })
    const result = await dispatch({ url, token, ref: 'origin/main', sha: 'f'.repeat(40) })

    expect(result.ok).toBe(false)
    // Not the whole token…
    expect(result.detail).not.toContain(token)
    // …and not any real prefix of it either. This is the assertion the old test
    // could not make, because its body was short enough that the slice never cut
    // anything.
    for (let n = 6; n <= token.length; n += 1) {
      expect(result.detail).not.toContain(token.slice(0, n))
    }
    // POSITIVE half: the owner is still told what the control plane said, and the
    // detail is still capped.
    expect(result.detail).toContain('HTTP 401')
    expect(result.detail).toContain('[redacted]')
    expect(result.detail.length).toBeLessThanOrEqual(HOST_DEPLOY_DETAIL_CAP + 'HTTP 401 — '.length)
  })

  test('the endpoint URL echoed back at any offset is redacted too', async () => {
    const token = 't'.repeat(32)
    const url = 'https://control.example.test/v1/deploy'
    const dispatch = createHostDeployDispatch({
      fetchImpl: async () =>
        new Response(`${'x'.repeat(HOST_DEPLOY_DETAIL_CAP - 10)}${url} nope`, { status: 500 }),
    })
    const result = await dispatch({ url, token, ref: 'origin/main', sha: 'f'.repeat(40) })
    expect(result.detail).not.toContain('control.example.test')
    expect(result.detail).toContain('HTTP 500')
  })

  test('an empty success body still says something useful', async () => {
    const dispatch = createHostDeployDispatch({
      fetchImpl: async () => new Response('', { status: 204 }),
    })
    const result = await dispatch({
      url: 'https://control.example.test/v1/deploy',
      token: 't'.repeat(32),
      ref: 'origin/main',
      sha: 'ff00112233445566778899aabbccddeeff001122',
    })
    expect(result).toEqual({ ok: true, detail: 'accepted (HTTP 204)' })
  })
})
