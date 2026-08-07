/**
 * trident — the credentialed host runner.
 *
 * This is the seam that decides whether a build can push. It runs REAL
 * subprocesses (`printenv`, `sh -c`) rather than mocking `Bun.spawn`, because the
 * thing worth proving is that the environment actually arrives in the child — a
 * mock would prove only that we passed an object to a function we also wrote.
 *
 * The failure this most guards against is subtle and total: replacing the
 * inherited environment instead of merging over it. `git` would stop resolving on
 * PATH, `HOME` would vanish, and every host command in a run would fail at once
 * with an error that looks nothing like "missing credential".
 */

import { describe, expect, it } from 'bun:test'

import { makeCredentialedHostRunner, spawnCapture } from '../git-mode.ts'

describe('spawnCapture — extra environment', () => {
  it('delivers the extra env to the CHILD process', async () => {
    const res = await spawnCapture(['printenv', 'NEUTRON_TEST_MARKER'], undefined, {
      NEUTRON_TEST_MARKER: 'delivered',
    })
    expect(res.ok).toBe(true)
    expect(res.stdout).toBe('delivered')
  })

  it('MERGES over the inherited env rather than replacing it', async () => {
    // The catastrophic mistake: replacing the env drops PATH, HOME and the
    // Claude credential dir, so `git` stops resolving and every host command in
    // a run fails at once with an error that looks nothing like a credential
    // problem.
    //
    // ASSERT ON A PARENT-ONLY MARKER, NOT ON $PATH. The first version of this
    // test checked `test -n "$PATH"` and PASSED even when the env was replaced —
    // POSIX `sh` sets a default PATH when none is inherited, so that assertion
    // could never fail. Caught by mutation-testing this very file. A variable
    // only the parent could have set is the only thing that distinguishes merge
    // from replace.
    process.env['NEUTRON_PARENT_ONLY'] = 'inherited'
    try {
      const res = await spawnCapture(
        ['sh', '-c', 'echo "${NEUTRON_PARENT_ONLY:-MISSING}:${NEUTRON_TEST_MARKER:-MISSING}"'],
        undefined,
        { NEUTRON_TEST_MARKER: 'added' },
      )
      // Both halves matter: the inherited value survived AND the extra arrived.
      expect(res.stdout).toBe('inherited:added')
    } finally {
      delete process.env['NEUTRON_PARENT_ONLY']
    }
  })

  it('is unchanged when no extra env is given', async () => {
    const res = await spawnCapture(['sh', '-c', 'echo plain'])
    expect(res.ok).toBe(true)
    expect(res.stdout).toBe('plain')
  })

  it('treats an EMPTY extra env as no env at all', async () => {
    // The unconnected path: an instance with no GitHub token must behave exactly
    // as it did before this change existed.
    //
    // Asserts on HOME, which is present at PROCESS START, rather than a variable
    // set at runtime. Learned the hard way in this file: `Bun.spawn` with no
    // explicit `env` inherits the environment captured when the process started,
    // so a runtime `process.env.X = …` never reaches such a child — the merge
    // test above works precisely because it passes an explicit env. HOME has
    // teeth: verified that `sh -c` with a replaced env reports MISSING.
    const res = await spawnCapture(['sh', '-c', 'echo "${HOME:-MISSING}"'], undefined, {})
    expect(res.stdout.length).toBeGreaterThan(0)
    expect(res.stdout).not.toBe('MISSING')
  })

  it('still resolves a spawn failure instead of throwing', async () => {
    const res = await spawnCapture(['definitely-not-a-real-binary-xyz'], undefined, { A: 'b' })
    expect(res.ok).toBe(false)
    expect(res.exit_code).toBe(-1)
  })
})

describe('makeCredentialedHostRunner', () => {
  it('carries the env into EVERY command, without the caller passing it', async () => {
    // The point of the factory: a run's host commands are credentialed by
    // construction, so no individual call site can forget.
    const run = makeCredentialedHostRunner({ NEUTRON_TEST_MARKER: 'baked-in' })
    expect((await run(['printenv', 'NEUTRON_TEST_MARKER'])).stdout).toBe('baked-in')
    // Second call, same runner — not a one-shot.
    expect((await run(['printenv', 'NEUTRON_TEST_MARKER'])).stdout).toBe('baked-in')
  })

  it('honours cwd as well as env', async () => {
    // `RunHostCommand`'s existing contract must survive the wrapping — trident
    // passes `-C <repo>` for git but relies on cwd for other commands.
    const run = makeCredentialedHostRunner({ NEUTRON_TEST_MARKER: 'x' })
    const res = await run(['sh', '-c', 'pwd'], '/tmp')
    expect(res.ok).toBe(true)
    // macOS reports /tmp as a symlink to /private/tmp; accept either.
    expect(res.stdout.endsWith('/tmp')).toBe(true)
  })

  it('with an EMPTY env behaves exactly like plain spawnCapture', async () => {
    // Same HOME reasoning as above — the unconnected instance still inherits a
    // real environment.
    const run = makeCredentialedHostRunner({})
    const res = await run(['sh', '-c', 'echo "${HOME:-MISSING}"'])
    expect(res.stdout).not.toBe('MISSING')
  })
})
