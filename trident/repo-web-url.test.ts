/**
 * The run's own GitHub web url — the source of the board's clickable `#NNN`.
 * The point of these tests is that NOTHING here may be hardcoded to one repo,
 * and that a repo we cannot resolve degrades to null (plain text) rather than a
 * wrong link.
 */

import { describe, expect, test } from 'bun:test'
import type { HostCommandResult } from './git-mode.ts'
import { githubWebUrlFromRemote, makeRepoWebUrlResolver } from './repo-web-url.ts'

const ok = (stdout: string): HostCommandResult => ({ ok: true, stdout, stderr: '', exit_code: 0 })
const fail = (): HostCommandResult => ({ ok: false, stdout: '', stderr: 'no origin', exit_code: 1 })

describe('githubWebUrlFromRemote', () => {
  const WEB = 'https://github.com/acme/widget'
  const github: [string, string][] = [
    ['https://github.com/acme/widget', WEB],
    ['https://github.com/acme/widget.git', WEB],
    ['https://github.com/acme/widget/', WEB],
    ['https://github.com/acme/widget.git\n', WEB],
    ['  https://github.com/acme/widget.git  ', WEB],
    ['https://x-access-token:ghp_secret@github.com/acme/widget.git', WEB],
    ['git@github.com:acme/widget.git', WEB],
    ['git@github.com:acme/widget', WEB],
    ['ssh://git@github.com/acme/widget.git', WEB],
    ['ssh://git@github.com/acme/widget', WEB],
    ['https://GitHub.com/acme/widget.git', WEB],
    // A dotted repo name keeps its dot; only a trailing `.git` is stripped.
    ['https://github.com/acme/widget.js.git', 'https://github.com/acme/widget.js'],
  ]
  for (const [remote, expected] of github) {
    test(`parses ${remote.trim()}`, () => {
      expect(githubWebUrlFromRemote(remote)).toBe(expected)
    })
  }

  const notGithub = [
    '',
    '   ',
    'https://gitlab.com/acme/widget.git',
    'git@gitlab.com:acme/widget.git',
    'https://github.example.com/acme/widget.git',
    'https://github.com/acme',
    '/srv/repos/widget',
    'not a url at all',
  ]
  for (const remote of notGithub) {
    test(`rejects ${JSON.stringify(remote)}`, () => {
      expect(githubWebUrlFromRemote(remote)).toBeNull()
    })
  }
})

describe('makeRepoWebUrlResolver', () => {
  test('shells `git remote get-url origin` in the run\'s OWN repo and parses it', async () => {
    const calls: string[][] = []
    const resolve = makeRepoWebUrlResolver(async (cmd) => {
      calls.push(cmd)
      return ok('git@github.com:acme/widget.git')
    })
    expect(await resolve('/srv/repos/widget')).toBe('https://github.com/acme/widget')
    expect(calls).toEqual([['git', '-C', '/srv/repos/widget', 'remote', 'get-url', 'origin']])
  })

  test('memoizes per repo_path — one shell per repo, per process', async () => {
    let shells = 0
    const resolve = makeRepoWebUrlResolver(async () => {
      shells++
      return ok('https://github.com/acme/widget.git')
    })
    const [a, b] = await Promise.all([resolve('/repo'), resolve('/repo')])
    const c = await resolve('/repo')
    expect([a, b, c]).toEqual([
      'https://github.com/acme/widget',
      'https://github.com/acme/widget',
      'https://github.com/acme/widget',
    ])
    expect(shells).toBe(1)
    // A DIFFERENT repo is a different cache entry (never one repo's answer).
    await resolve('/other')
    expect(shells).toBe(2)
  })

  test('a failed shell resolves null (no link, never a guessed one)', async () => {
    const resolve = makeRepoWebUrlResolver(async () => fail())
    expect(await resolve('/repo')).toBeNull()
  })

  test('a non-GitHub origin resolves null', async () => {
    const resolve = makeRepoWebUrlResolver(async () => ok('https://gitlab.com/acme/widget.git'))
    expect(await resolve('/repo')).toBeNull()
  })
})
