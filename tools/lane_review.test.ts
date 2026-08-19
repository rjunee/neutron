// tools/lane_review.test.ts — pins the FAIL-CLOSED contract of lane_review.sh.
//
// THE DEFECT THIS PINS (measured 2026-08-18T08:13Z): handed a ref it could not
// resolve, the guard printed `lane_review: unknown ref <ref>` and exited 0.
// Empty output from a guard reads exactly like a clean verdict — three PRs
// (#424 #420 #411) were nearly merged on that silence. "Nothing to check" and
// "checked, all wired" must never look identical, so this suite asserts the
// unknown-ref path DIRECTLY: deleting the fail-closed exit in lane_review.sh
// turns the first test red. A suite that only exercised resolvable refs would
// pass with the hole present and prove nothing.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPT = new URL('./lane_review.sh', import.meta.url).pathname

let repo: string

// Isolate every git invocation from host config (gpg signing, hook paths).
const env = () => ({
  ...process.env,
  HOME: repo,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'lane-review-test',
  GIT_AUTHOR_EMAIL: 'lane-review-test@invalid',
  GIT_COMMITTER_NAME: 'lane-review-test',
  GIT_COMMITTER_EMAIL: 'lane-review-test@invalid',
})

function git(...args: string[]): string {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: env() })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed:\n${r.stderr}`)
  return r.stdout.trim()
}

function review(...args: string[]): { code: number | null; out: string } {
  const r = spawnSync('bash', [SCRIPT, ...args], { cwd: repo, encoding: 'utf8', env: env() })
  return { code: r.status, out: `${r.stdout}${r.stderr}` }
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'lane-review-'))
  git('init', '-q', '-b', 'main')
  mkdirSync(join(repo, 'src'), { recursive: true })
  writeFileSync(
    join(repo, 'src', 'app.ts'),
    'export function used(): number {\n  return 1\n}\nconsole.log(used())\n',
  )
  git('add', '-A')
  git('commit', '-q', '-m', 'base')
  // The script's default base is origin/main; model it without a network remote.
  git('update-ref', 'refs/remotes/origin/main', 'HEAD')

  // Known-good branch: edits an existing production code path, adds no exports.
  git('checkout', '-q', '-b', 'feature')
  writeFileSync(
    join(repo, 'src', 'app.ts'),
    'export function used(): number {\n  return 2 // behaviour change\n}\nconsole.log(used())\n',
  )
  git('add', '-A')
  git('commit', '-q', '-m', 'edit an existing production path')
  git('checkout', '-q', 'main')

  // Unwired branch: adds an exported symbol with ZERO production callers —
  // the class this tool exists to catch (#400).
  git('checkout', '-q', '-b', 'unwired')
  writeFileSync(
    join(repo, 'src', 'orphan.ts'),
    'export function orphanNeverCalled(): number {\n  return 3\n}\n',
  )
  git('add', '-A')
  git('commit', '-q', '-m', 'add an export nothing calls')
  git('checkout', '-q', 'main')

  // The ref shape callers actually hold: a branch that exists ONLY as a
  // remote-tracking ref, with no local branch of that name (#424 #420 #411).
  git('update-ref', 'refs/remotes/origin/trident/only-remote', git('rev-parse', 'feature'))
})

afterAll(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe('lane_review.sh fail-closed contract', () => {
  test('T1: an unresolvable ref exits NON-ZERO and names the ref — silence is never approval', () => {
    const { code, out } = review('no-such-branch')
    // The defect: this exited 0. Deleting the fail-closed exit turns this red.
    expect(code).not.toBe(0)
    expect(code).toBe(2) // documented contract: 2 = the check itself could not run
    expect(out).toContain('no-such-branch')
    expect(out).toContain('could not be resolved')
    expect(out).not.toContain('delivers behaviour: yes')
  })

  test('T1: an unresolvable BASE also exits non-zero', () => {
    const { code, out } = review('feature', 'no-such-base')
    expect(code).toBe(2)
    expect(out).toContain('no-such-base')
    expect(out).toContain('could not be resolved')
  })

  test('T4 positive control: a behaviour-changing branch exits 0 with its verdict line', () => {
    const { code, out } = review('feature')
    expect(code).toBe(0)
    expect(out).toContain('=== delivers behaviour: yes')
  })

  test('T3: an empty new-symbol set is STATED in words, not implied by empty output', () => {
    const { out } = review('feature')
    expect(out).toContain('no new exported symbols — nothing to verify')
  })

  test('T2: a bare lane ref resolves against origin/ and the output names the resolution', () => {
    const { code, out } = review('trident/only-remote')
    expect(code).toBe(0)
    expect(out).toContain("resolved 'trident/only-remote' -> 'origin/trident/only-remote'")
    expect(out).toContain('=== delivers behaviour: yes')
  })

  test('positive control: the unwired class still fires — a caller-less export exits 1, named', () => {
    const { code, out } = review('unwired')
    expect(code).toBe(1)
    expect(out).toContain('orphanNeverCalled')
    expect(out).toContain('NO non-test production caller')
  })
})
