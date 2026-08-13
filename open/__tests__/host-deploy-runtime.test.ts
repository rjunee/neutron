/**
 * The PRODUCTION halves of the host-deploy seams, against a REAL git repo and a
 * REAL Request object.
 *
 * The service suite (`host-deploy.test.ts`) proves every guard against injected
 * seams. That leaves the two things which can only ever be wrong in production
 * asserted by nothing: whether `createHostDeployGit` looks in the right place
 * and reports the right shas, and whether `createHostDeployDispatch` puts the
 * credential where it claims to. Both are exercised here through the default
 * wiring, with no deps passed except the ones a caller must supply.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createHostDeployDispatch, createHostDeployGit } from '../host-deploy-runtime.ts'
import { HOST_DEPLOY_DETAIL_CAP } from '../host-deploy.ts'

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

describe('createHostDeployGit — the read-only view of the host checkout', () => {
  test('resolves HEAD and a named ref, and lists the commits between them', async () => {
    const base = commit('a.txt', 'base: the sha the host runs')
    git('branch', 'deployed')
    const one = commit('b.txt', 'fix(deploy): name the sha in the refusal')
    const two = commit('c.txt', 'feat(usage): one screen for every account')

    const g = createHostDeployGit({ repo_dir: repo })

    expect(await g.revParse('HEAD')).toBe(two)
    expect(await g.revParse('deployed')).toBe(base)
    expect(await g.revParse('main')).toBe(two)

    const range = await g.commitsBetween(base, two, 40)
    expect(range.total).toBe(2)
    expect(range.commits.map((c) => c.sha)).toEqual([two, one])
    expect(range.commits.map((c) => c.subject)).toEqual([
      'feat(usage): one screen for every account',
      'fix(deploy): name the sha in the refusal',
    ])
  })

  test('an unknown ref is null, not a throw and not a bogus sha', async () => {
    commit('a.txt', 'base')
    const g = createHostDeployGit({ repo_dir: repo })
    expect(await g.revParse('origin/never-existed')).toBeNull()
    // POSITIVE control on the same instance: the tool CAN return a sha, so the
    // null above is a real answer rather than a resolver that always fails.
    expect(await g.revParse('HEAD')).toMatch(/^[0-9a-f]{40}$/)
  })

  test('an annotated tag resolves to the COMMIT it points at', async () => {
    const sha = commit('a.txt', 'base')
    git('tag', '-a', 'v1.0.0', '-m', 'release')
    const g = createHostDeployGit({ repo_dir: repo })
    expect(await g.revParse('v1.0.0')).toBe(sha)
  })

  test('the TOTAL is the true count even when the rendered list is capped', async () => {
    const base = commit('a.txt', 'base')
    for (let i = 0; i < 5; i += 1) commit(`f${i}.txt`, `chore: step ${i}`)
    const head = git('rev-parse', 'HEAD')

    const g = createHostDeployGit({ repo_dir: repo })
    const range = await g.commitsBetween(base, head, 2)
    expect(range.commits).toHaveLength(2)
    // "2 commits would land" when 5 would is a lie the owner cannot detect.
    expect(range.total).toBe(5)
  })

  test('an empty range reports zero rather than throwing', async () => {
    const sha = commit('a.txt', 'base')
    const g = createHostDeployGit({ repo_dir: repo })
    expect(await g.commitsBetween(sha, sha, 40)).toEqual({ commits: [], total: 0 })
  })

  test('a BROKEN checkout throws — it is never reported as "no commits" or "unknown ref"', async () => {
    // Argus r1 major, reproduced: `allowNonZero` routes through `isExecChildError`,
    // which is `err instanceof Error` (`gateway/git/git-exec.ts:135`), so a
    // missing git binary, a timeout and a maxBuffer overrun all collapsed into
    // the SAME empty stdout an unknown ref produces. `commitsBetween` then
    // returned `{commits:[],total:0}` with no throw, the refusal in
    // `open/host-deploy.ts` never fired, and the owner was shown the
    // "SIDEWAYS or BACKWARD" warning above an empty fence instead of being told
    // the checkout could not be read.
    const sha = commit('a.txt', 'base')
    const broken = createHostDeployGit({ repo_dir: repo, git_binary: '/nonexistent/git' })

    expect(broken.commitsBetween(sha, sha, 40)).rejects.toThrow()
    expect(broken.revParse('HEAD')).rejects.toThrow()

    // POSITIVE CONTROL: the same two calls against a working binary answer
    // normally, so the rejections above are about the broken binary and not about
    // a helper that always throws.
    const ok = createHostDeployGit({ repo_dir: repo })
    expect(await ok.revParse('HEAD')).toBe(sha)
    expect(await ok.commitsBetween(sha, sha, 40)).toEqual({ commits: [], total: 0 })
  })

  test('a range naming a sha this checkout does not have throws rather than reporting zero', async () => {
    const sha = commit('a.txt', 'base')
    const g = createHostDeployGit({ repo_dir: repo })
    const absent = 'ff00112233445566778899aabbccddeeff001122'
    // "0 commits would land" for a range git cannot even parse is the same lie in
    // a different costume.
    expect(g.commitsBetween(sha, absent, 40)).rejects.toThrow()
  })

  test('an unknown ref is still just null — the one failure that IS an answer', async () => {
    // The precise boundary of the change above: exit 1 with no stdout, which is
    // what `--verify --quiet` documents, stays a null. Everything else throws.
    commit('a.txt', 'base')
    const g = createHostDeployGit({ repo_dir: repo })
    expect(await g.revParse('origin/never-existed')).toBeNull()
    expect(await g.revParse('HEAD')).toMatch(/^[0-9a-f]{40}$/)
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
