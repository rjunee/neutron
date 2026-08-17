/**
 * The deploy precondition is about the relationship between an index, a
 * worktree and another ref, so these tests prove it against real temporary git
 * repositories rather than approximating git with mocks.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { evaluateDeployPreconditions } from '../host-deploy-preconditions.ts'

const REPAIRS = 'migrations/repairs.json'
const SECOND = 'migrations/second.json'
const MAIN_ONLY = 'migrations/main-only.json'
const CONTENT_A = '{"content":"A"}\n'
const CONTENT_B = '{"content":"B"}\n'
const CONTENT_C = '{"content":"C"}\n'

let repo: string

/** Deterministic identity + no ambient config, matching the other real-git tests. */
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

function write(path: string, content: string): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true })
  writeFileSync(join(repo, path), content)
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'neutron-host-deploy-preconditions-'))
  git('init', '--initial-branch=main', '.')
  write(REPAIRS, CONTENT_A)
  write(SECOND, CONTENT_A)
  git('add', REPAIRS, SECOND)
  git('commit', '-m', 'main content A')

  git('switch', '-c', 'target')
  write(REPAIRS, CONTENT_B)
  write(SECOND, CONTENT_B)
  git('add', REPAIRS, SECOND)
  git('commit', '-m', 'target content B')

  git('switch', 'main')
  write(MAIN_ONLY, CONTENT_A)
  git('add', MAIN_ONLY)
  git('commit', '-m', 'main-only path')
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe('evaluateDeployPreconditions', () => {
  test('a tracked modification already byte-identical to the target does not block', async () => {
    write(REPAIRS, CONTENT_B)

    const verdict = await evaluateDeployPreconditions({ checkout: repo, target_ref: 'target' })

    expect(verdict).toEqual({
      ok: true,
      entries: [{ path: REPAIRS, status: ' M', kind: 'redundant' }],
      blockers: [],
      refusal: null,
    })
  })

  test('a tracked modification that differs from the target blocks', async () => {
    write(REPAIRS, CONTENT_C)

    const verdict = await evaluateDeployPreconditions({ checkout: repo, target_ref: 'target' })

    expect(verdict.ok).toBe(false)
    expect(verdict.blockers).toEqual([{ path: REPAIRS, status: ' M', kind: 'divergent' }])
    expect(verdict.refusal).toContain(REPAIRS)
    expect(verdict.refusal).toContain('DIVERGES')
  })

  test('an untracked path always blocks and is named in the refusal', async () => {
    write('scratch.txt', 'untracked\n')

    const verdict = await evaluateDeployPreconditions({ checkout: repo, target_ref: 'target' })

    expect(verdict.ok).toBe(false)
    expect(verdict.blockers).toEqual([{ path: 'scratch.txt', status: '??', kind: 'untracked' }])
    expect(verdict.refusal).toContain('scratch.txt — untracked (in no ref)')
  })

  test('a mixed refusal names the blocker and the redundant safe-to-discard path', async () => {
    write(REPAIRS, CONTENT_C)
    write(SECOND, CONTENT_B)

    const verdict = await evaluateDeployPreconditions({ checkout: repo, target_ref: 'target' })

    expect(verdict.ok).toBe(false)
    expect(verdict.blockers.map((entry) => entry.path)).toEqual([REPAIRS])
    expect(verdict.entries).toContainEqual({ path: SECOND, status: ' M', kind: 'redundant' })
    expect(verdict.refusal).toContain(`${REPAIRS} — modified, and its content DIVERGES`)
    expect(verdict.refusal).toContain('Also dirty but NOT blocking:')
    expect(verdict.refusal).toContain(`${SECOND} — modified, but its working-tree content is already in target`)
    expect(verdict.refusal).toContain('discarding it loses nothing')
  })

  test('deleting a path that the target still carries is divergent and blocks', async () => {
    rmSync(join(repo, REPAIRS))

    const verdict = await evaluateDeployPreconditions({ checkout: repo, target_ref: 'target' })

    expect(verdict.ok).toBe(false)
    expect(verdict.blockers).toEqual([{ path: REPAIRS, status: ' D', kind: 'divergent' }])
  })

  test('deleting a path that the target also lacks is redundant and does not block', async () => {
    rmSync(join(repo, MAIN_ONLY))

    const verdict = await evaluateDeployPreconditions({ checkout: repo, target_ref: 'target' })

    expect(verdict).toEqual({
      ok: true,
      entries: [{ path: MAIN_ONLY, status: ' D', kind: 'redundant' }],
      blockers: [],
      refusal: null,
    })
  })

  test('an unresolvable target ref fails closed', async () => {
    await expect(
      evaluateDeployPreconditions({ checkout: repo, target_ref: 'no-such-ref' }),
    ).rejects.toThrow(/no-such-ref/)
  })

  test('an invalid target ref is rejected by the guard before git is spawned', async () => {
    await expect(
      evaluateDeployPreconditions({
        checkout: join(repo, 'checkout-that-does-not-exist'),
        target_ref: '--parseopt',
      }),
    ).rejects.toThrow(/Invalid deploy target ref "--parseopt"/)
  })

  test('a staged edit whose bytes equal the target is redundant', async () => {
    write(REPAIRS, CONTENT_B)
    git('add', REPAIRS)

    const verdict = await evaluateDeployPreconditions({ checkout: repo, target_ref: 'target' })

    expect(verdict).toEqual({
      ok: true,
      entries: [{ path: REPAIRS, status: 'M ', kind: 'redundant' }],
      blockers: [],
      refusal: null,
    })
  })
})
