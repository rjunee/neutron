/**
 * Unit G8 (Part B) — depcruise ratchet-GROWTH guard self-test.
 *
 * G4's depcruise gate trusts every entry in the committed
 * `.dependency-cruiser-known-violations.json`, so a PR could grandfather a NEW
 * cross-band edge simply by ADDING it to that baseline and CI would stay green —
 * the "baseline only ever shrinks" invariant was unenforced (Codex flagged this
 * on G4's review). G8 adds a CI-enforced ratchet-growth guard. This test pins
 * the boundary Codex flagged: baseline-equal → pass, baseline-shrunk → pass,
 * baseline-GROWN → FAIL.
 *
 * The pure comparator (compareBaselines / violationKey) carries the whole
 * decision, so it is tested directly with fixtures (no git, no dependency-cruiser
 * run). Two thin wrappers are exercised too: the comparator's CLI entrypoint
 * (file-in, exit-code-out) and the real guard shell script against a throwaway
 * git repo (proving the `git show <ref>:baseline` plumbing + the push-to-main
 * skip).
 */
import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  compareBaselines,
  violationKey,
  type DepcruiseViolation,
} from './depcruise-ratchet-compare.ts'

const COMPARE_TS = fileURLToPath(new URL('./depcruise-ratchet-compare.ts', import.meta.url))
const GUARD_SH = fileURLToPath(new URL('./depcruise-ratchet-guard.sh', import.meta.url))

/** A couple of representative baseline entries (shape mirrors the real file). */
const V_A: DepcruiseViolation = {
  type: 'dependency',
  from: 'migrations/runner.ts',
  to: 'open/owner-identity.ts',
  rule: { severity: 'error', name: 'contracts-are-leaves' },
}
const V_B: DepcruiseViolation = {
  type: 'dependency',
  from: 'reminders/dispatcher.ts',
  to: 'gateway/wiring/build-llm-call-substrate.ts',
  rule: { severity: 'error', name: 'services-below-product' },
}
// Same edge as V_A but a DIFFERENT rule — must be a distinct key (both really
// coexist in the live baseline), so keys are (rule|from|to), not (from|to).
const V_A_OTHER_RULE: DepcruiseViolation = {
  ...V_A,
  rule: { severity: 'error', name: 'nobody-imports-composition' },
}
const V_NEW: DepcruiseViolation = {
  type: 'dependency',
  from: 'brand/new/edge.ts',
  to: 'some/forbidden/target.ts',
  rule: { severity: 'error', name: 'cores-use-sdk-only' },
}

describe('G8 depcruise ratchet comparator (pure)', () => {
  test('baseline EQUAL → ok', () => {
    const r = compareBaselines([V_A, V_B], [V_A, V_B])
    expect(r.ok).toBe(true)
    expect(r.added).toEqual([])
  })

  test('baseline SHRUNK (an entry removed) → ok', () => {
    const r = compareBaselines([V_A, V_B], [V_A])
    expect(r.ok).toBe(true)
    expect(r.added).toEqual([])
    expect(r.removed).toEqual([violationKey(V_B)])
  })

  test('baseline GROWN (a new entry added) → FAIL, names the added key', () => {
    const r = compareBaselines([V_A, V_B], [V_A, V_B, V_NEW])
    expect(r.ok).toBe(false)
    expect(r.added).toEqual([violationKey(V_NEW)])
  })

  test('same edge under a DIFFERENT rule is a NEW key → FAIL', () => {
    // Growing the baseline with the same from/to but a new rule name must trip.
    const r = compareBaselines([V_A], [V_A, V_A_OTHER_RULE])
    expect(r.ok).toBe(false)
    expect(r.added).toEqual([violationKey(V_A_OTHER_RULE)])
  })

  test('reordering the same set is NOT growth → ok', () => {
    const r = compareBaselines([V_A, V_B], [V_B, V_A])
    expect(r.ok).toBe(true)
    expect(r.added).toEqual([])
  })

  test('violationKey is rule|from|to and distinguishes rules on the same edge', () => {
    expect(violationKey(V_A)).toBe('contracts-are-leaves|migrations/runner.ts|open/owner-identity.ts')
    expect(violationKey(V_A)).not.toBe(violationKey(V_A_OTHER_RULE))
  })
})

/** Run the comparator CLI on two fixture files; return { code, out }. */
function runCompareCli(mainPath: string, committedPath: string): { code: number; out: string } {
  try {
    const out = execFileSync('bun', [COMPARE_TS, mainPath, committedPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { code: 0, out }
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { code: err.status ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

describe('G8 depcruise ratchet comparator CLI', () => {
  test('equal → exit 0; grown → exit 1 naming the edge', () => {
    const dir = mkdtempSync(join(tmpdir(), 'depcruise-ratchet-cli-'))
    try {
      const mainF = join(dir, 'main.json')
      const equalF = join(dir, 'equal.json')
      const grownF = join(dir, 'grown.json')
      writeFileSync(mainF, JSON.stringify([V_A, V_B]))
      writeFileSync(equalF, JSON.stringify([V_A, V_B]))
      writeFileSync(grownF, JSON.stringify([V_A, V_B, V_NEW]))

      const eq = runCompareCli(mainF, equalF)
      expect(eq.code).toBe(0)
      expect(eq.out).toContain('DEPCRUISE RATCHET: OK')

      const grown = runCompareCli(mainF, grownF)
      expect(grown.code).toBe(1)
      expect(grown.out).toContain('DEPCRUISE RATCHET: FAIL')
      expect(grown.out).toContain(violationKey(V_NEW))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/** Minimal helper: run a git command in `cwd`, throwing on failure. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

/** Run the guard shell script rooted at `repo`; return { code, out }. */
function runGuard(repo: string, mainRef = 'main'): { code: number; out: string } {
  try {
    const out = execFileSync('bash', [GUARD_SH], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        DEPCRUISE_RATCHET_ROOT: repo,
        DEPCRUISE_RATCHET_MAIN_REF: mainRef,
        NEUTRON_BUN_BIN: process.env.NEUTRON_BUN_BIN ?? 'bun',
      },
    })
    return { code: 0, out }
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { code: err.status ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

/** A bare origin with three main commits and the real baseline shape. */
function originWithBaseline(): { root: string; origin: string } {
  const root = mkdtempSync(join(tmpdir(), 'depcruise-ratchet-origin-'))
  const origin = join(root, 'origin.git')
  const seed = join(root, 'seed')
  git(root, 'init', '--bare', '-q', origin)
  mkdirSync(seed)
  git(seed, 'init', '-q', '-b', 'main')
  git(seed, 'config', 'user.email', 'g8@test.local')
  git(seed, 'config', 'user.name', 'G8 Test')
  writeFileSync(join(seed, BASELINE_NAME), JSON.stringify([V_A, V_B], null, 2))
  git(seed, 'add', BASELINE_NAME)
  git(seed, 'commit', '-q', '-m', 'baseline')
  for (const n of [2, 3]) {
    const history = `history-${n}.txt`
    writeFileSync(join(seed, history), `commit ${n}\n`)
    git(seed, 'add', history)
    git(seed, 'commit', '-q', '-m', `history ${n}`)
  }
  git(seed, 'remote', 'add', 'origin', `file://${origin}`)
  git(seed, 'push', '-q', '-u', 'origin', 'main')
  git(origin, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  return { root, origin }
}

const BASELINE_NAME = '.dependency-cruiser-known-violations.json'

/** A throwaway git repo whose `main` branch commits a 2-entry baseline. */
function repoOnMainWithBaseline(): string {
  const repo = mkdtempSync(join(tmpdir(), 'depcruise-ratchet-git-'))
  git(repo, 'init', '-q')
  git(repo, 'config', 'user.email', 'g8@test.local')
  git(repo, 'config', 'user.name', 'G8 Test')
  git(repo, 'checkout', '-q', '-b', 'main')
  writeFileSync(join(repo, BASELINE_NAME), JSON.stringify([V_A, V_B], null, 2))
  git(repo, 'add', BASELINE_NAME)
  git(repo, 'commit', '-q', '-m', 'baseline')
  return repo
}

/** Commit `baseline` (array) onto a fresh `feature` branch so HEAD advances past main. */
function featureBranchWithBaseline(repo: string, baseline: DepcruiseViolation[] | null): void {
  git(repo, 'checkout', '-q', '-b', 'feature')
  if (baseline !== null) {
    writeFileSync(join(repo, BASELINE_NAME), JSON.stringify(baseline, null, 2))
    git(repo, 'add', BASELINE_NAME)
  } else {
    // No baseline change — still advance HEAD so this isn't a push-to-main run.
    writeFileSync(join(repo, 'README'), 'feature work\n')
    git(repo, 'add', 'README')
  }
  git(repo, 'commit', '-q', '-m', 'feature change')
}

describe('G8 depcruise ratchet guard (git integration)', () => {
  test('the freshen never shallows a full clone', () => {
    const { root, origin } = originWithBaseline()
    const work = join(root, 'work')
    try {
      git(root, 'clone', '-q', `file://${origin}`, work)
      const shallowFile = join(work, '.git', 'shallow')
      expect(existsSync(shallowFile)).toBe(false)
      expect(git(work, 'rev-parse', '--is-shallow-repository')).toBe('false')
      const mainCommitCount = Number(git(work, 'rev-list', '--count', 'origin/main'))
      expect(mainCommitCount).toBeGreaterThanOrEqual(3)

      git(work, 'config', 'user.email', 'g8@test.local')
      git(work, 'config', 'user.name', 'G8 Test')
      git(work, 'checkout', '-q', '-b', 'pr')
      writeFileSync(join(work, 'unrelated.txt'), 'feature work\n')
      git(work, 'add', 'unrelated.txt')
      git(work, 'commit', '-q', '-m', 'unrelated feature work')

      const result = runGuard(work, 'origin/main')
      expect(result.code).toBe(0)
      // Before the fix, `fetch --depth=1` into this full clone wrote
      // `.git/shallow` and truncated origin/main to 1 (measured 2026-08-19).
      expect({
        shallowFilePresent: existsSync(shallowFile),
        shallowRepository: git(work, 'rev-parse', '--is-shallow-repository'),
        originMainCommitCount: Number(git(work, 'rev-list', '--count', 'origin/main')),
      }).toEqual({
        shallowFilePresent: false,
        shallowRepository: 'false',
        originMainCommitCount: mainCommitCount,
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)

  test('an already-shallow checkout still gets origin/main', () => {
    const { root, origin } = originWithBaseline()
    const work = join(root, 'shallow-work')
    try {
      git(root, 'clone', '-q', '--depth=1', `file://${origin}`, work)
      const shallowFile = join(work, '.git', 'shallow')
      // Anti-fake: a transport that ignored --depth must fail this test loudly.
      expect(existsSync(shallowFile)).toBe(true)
      git(work, 'update-ref', '-d', 'refs/remotes/origin/main')
      git(work, 'config', 'user.email', 'g8@test.local')
      git(work, 'config', 'user.name', 'G8 Test')
      git(work, 'checkout', '-q', '-b', 'pr')
      writeFileSync(join(work, 'unrelated.txt'), 'feature work\n')
      git(work, 'add', 'unrelated.txt')
      git(work, 'commit', '-q', '-m', 'unrelated feature work')

      const result = runGuard(work, 'origin/main')
      expect(result.code).toBe(0)
      expect(git(work, 'rev-parse', '--verify', 'origin/main')).not.toBe('')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)

  test('a feature branch that GROWS the baseline → guard FAILS', () => {
    const repo = repoOnMainWithBaseline()
    try {
      featureBranchWithBaseline(repo, [V_A, V_B, V_NEW])
      const { code, out } = runGuard(repo)
      expect(out).toContain('DEPCRUISE RATCHET: FAIL')
      expect(out).toContain(violationKey(V_NEW))
      expect(code).toBe(1)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('a feature branch with an EQUAL baseline → guard passes', () => {
    const repo = repoOnMainWithBaseline()
    try {
      featureBranchWithBaseline(repo, null) // baseline unchanged, HEAD advanced
      const { code, out } = runGuard(repo)
      expect(out).toContain('DEPCRUISE RATCHET: OK')
      expect(code).toBe(0)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('a feature branch that SHRINKS the baseline → guard passes', () => {
    const repo = repoOnMainWithBaseline()
    try {
      featureBranchWithBaseline(repo, [V_A])
      const { code, out } = runGuard(repo)
      expect(out).toContain('DEPCRUISE RATCHET: OK')
      expect(code).toBe(0)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('push-to-main (HEAD == main) → guard SKIPS even with a grown working tree', () => {
    const repo = repoOnMainWithBaseline()
    try {
      // Still on main; a dirty working tree must NOT fail a push-to-main run.
      writeFileSync(join(repo, BASELINE_NAME), JSON.stringify([V_A, V_B, V_NEW], null, 2))
      const { code, out } = runGuard(repo)
      expect(out).toContain('skipping')
      expect(code).toBe(0)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('bootstrap: main has no baseline → guard SKIPS', () => {
    const repo = mkdtempSync(join(tmpdir(), 'depcruise-ratchet-bootstrap-'))
    try {
      git(repo, 'init', '-q')
      git(repo, 'config', 'user.email', 'g8@test.local')
      git(repo, 'config', 'user.name', 'G8 Test')
      git(repo, 'checkout', '-q', '-b', 'main')
      writeFileSync(join(repo, 'README'), 'no baseline yet\n')
      git(repo, 'add', 'README')
      git(repo, 'commit', '-q', '-m', 'init')
      git(repo, 'checkout', '-q', '-b', 'feature')
      // A committed baseline appears for the FIRST time on the feature branch,
      // committed so HEAD advances past main (else the push-to-main skip fires).
      writeFileSync(join(repo, BASELINE_NAME), JSON.stringify([V_A, V_NEW], null, 2))
      git(repo, 'add', BASELINE_NAME)
      git(repo, 'commit', '-q', '-m', 'introduce baseline')
      const { code, out } = runGuard(repo)
      // main has no baseline → nothing to ratchet against → skip (not a failure).
      expect(out).toContain('bootstrap')
      expect(out).toContain('skipping')
      expect(code).toBe(0)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})

/**
 * T4 (card 01M0CJ0TT0RA7YZ2ZJ0DQK2CDF) — THE SHALLOW CASE IS THE DEFECT, so it is
 * asserted directly. A test on a full clone proves nothing: that is the state in
 * which the bug cannot occur.
 *
 * Two things are pinned. First, the guard must not SHALLOW a full clone — the
 * unconditional `git fetch --depth=1` this branch removed truncated the shared
 * checkout and produced three unrelated-looking failures in one night. Second, on
 * a checkout that IS shallow, the guard must NAME that rather than reporting an
 * unreachable ref; all three of those failures were true statements that pointed
 * nowhere.
 */
describe('G8 depcruise ratchet guard — shallow checkouts', () => {
  test('a FULL clone stays full after the guard runs (it used to be truncated)', () => {
    const repo = repoOnMainWithBaseline()
    try {
      expect(existsSync(join(repo, '.git', 'shallow'))).toBe(false)
      runGuard(repo)
      // The regression: --depth=1 against a full clone writes .git/shallow.
      expect(existsSync(join(repo, '.git', 'shallow'))).toBe(false)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

})
