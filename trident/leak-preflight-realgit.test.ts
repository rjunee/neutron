/**
 * @neutronai/trident — the REAL-gate guard for the purity preflight.
 *
 * WHY A REALGIT FILE EXISTS AT ALL. Two suites already sit either side of this
 * one and neither covers what it covers: `scripts/ci/leak-gate-selftest.test.ts`
 * proves the GATE (real script, throwaway trees, no preflight), and
 * `trident/leak-preflight.test.ts` proves the LOOP (real preflight, scripted
 * host runner, no gate). Between them lies the seam that actually shipped the
 * defect this card fixes: the preflight invoking the real gate binary over a
 * real detached worktree of a real branch. Everything in that seam is exactly
 * the kind of thing a double cannot be wrong about — exit codes, verdict
 * sentinels, the `report_hits` line shape, the worktree lifecycle, the
 * compare-and-swap that moves the branch ref. So this file drives
 * `runLeakGatePreflight` end to end against `scripts/ci/leak-gate.sh` itself and
 * asserts REAL verdicts in both directions: a seeded doc is DETECTED, a clean
 * doc whose PII tiers could not run reads INCOMPLETE with those tiers NAMED —
 * never passing — a clean doc with a denylist reads clean, and a real fixer
 * round terminates, commits and moves the ref.
 *
 * WORD DISCIPLINE. The gate's two vocabulary rules match a six-letter retired
 * multi-org root anywhere in a committed file — including this one, and
 * including the RULE IDS, which contain it. It is never written literally here:
 * it is assembled from fragments at runtime (`T2`) and every rule id is a
 * template string over `T2`, the discipline `leak-gate-selftest.test.ts`
 * established. Absolute host filesystem paths are banned the same way; the
 * `mkdtempSync` paths below exist only at runtime and are never committed.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { EnvCapableHostRunner } from './git-mode.ts'
import { runLeakGatePreflight } from './leak-preflight.ts'

/** Retired multi-org vocab root, fragment-assembled (see file header). */
const T2 = 'ten' + 'ant'

const LEAK_GATE = fileURLToPath(new URL('../scripts/ci/leak-gate.sh', import.meta.url))
const PROSE_AWK = fileURLToPath(new URL('../scripts/ci/extract-comment-prose.awk', import.meta.url))
const REPO_LICENSE = fileURLToPath(new URL('../LICENSE', import.meta.url))

const PLAN_DOC = '.trident/plans/trident/test-branch.md'
const SEEDED_DOC = `# plan\n\nNever put ${T2} filesystem paths in files or commit messages.\n`
const CLEAN_DOC = '# plan\n\nNever put absolute host filesystem paths in files or commit messages.\n'

const created: string[] = []

afterAll(() => {
  for (const p of created) rmSync(p, { recursive: true, force: true })
})

/**
 * The fixture allowlist. The gate is COMMITTED into the fixture tree, so the
 * gate (and this file) self-match the very vocabulary patterns they define —
 * exactly as they do in this repo, which is why this repo ships an allowlist at
 * all. The repo's real allowlist must NOT be copied: its entries name files that
 * do not exist in the fixture, and the audit at `leak-gate.sh:244-307` fails a
 * stale entry with exit 2. These 14 entries each match at least one and at most
 * three fixture files, which is what the audit demands.
 */
const FIXTURE_ALLOWLIST = [
  `scripts/ci/leak-gate.sh:${T2}-code`,
  `scripts/ci/leak-gate.sh:${T2}-routing-camel`,
  `scripts/ci/leak-gate.sh:${T2}-purged`,
  'scripts/ci/leak-gate.sh:workspace-retired',
  `scripts/ci/leak-gate.sh:cross-${T2}-code`,
  'scripts/ci/leak-gate.sh:provision-code',
  `scripts/ci/leak-gate.sh:${T2}-word`,
  `scripts/ci/leak-gate.sh:${T2}-docs`,
  'scripts/ci/leak-gate.sh:neutron-computer',
  `scripts/ci/leak-gate-allowlist.txt:${T2}-code`,
  `scripts/ci/leak-gate-allowlist.txt:${T2}-purged`,
  'scripts/ci/leak-gate-allowlist.txt:workspace-retired',
  `scripts/ci/leak-gate-allowlist.txt:${T2}-word`,
  `scripts/ci/leak-gate-allowlist.txt:cross-${T2}-code`,
].join('\n')

interface Fixture {
  dir: string
  base: string
  dirty: string
  clean: string
  sabotaged: string
}

let fixture: Fixture | undefined

/**
 * One real git repo carrying the real gate, its prose extractor (a missing awk
 * is gate exit 2), a real Apache LICENSE, the fixture allowlist and a plan doc
 * that goes seeded → reworded across two commits. Built once and shared: cases
 * A/B/C move no refs, and D owns its own branch.
 */
function fixtureRepo(): Fixture {
  if (fixture !== undefined) return fixture
  const dir = mkdtempSync(join(tmpdir(), 'leak-preflight-realgit-'))
  created.push(dir)

  mkdirSync(join(dir, 'scripts', 'ci'), { recursive: true })
  mkdirSync(join(dir, 'src'), { recursive: true })
  mkdirSync(join(dir, '.trident', 'plans', 'trident'), { recursive: true })
  copyFileSync(REPO_LICENSE, join(dir, 'LICENSE'))
  copyFileSync(LEAK_GATE, join(dir, 'scripts', 'ci', 'leak-gate.sh'))
  copyFileSync(PROSE_AWK, join(dir, 'scripts', 'ci', 'extract-comment-prose.awk'))
  writeFileSync(join(dir, 'scripts', 'ci', 'leak-gate-allowlist.txt'), `${FIXTURE_ALLOWLIST}\n`)
  writeFileSync(join(dir, 'src', 'clean.ts'), 'export const ok = true\n')

  const g = (...a: string[]): string =>
    execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

  g('init', '-q')
  g('config', 'user.email', 't@example.invalid')
  g('config', 'user.name', 't')
  // The preflight's own fix commit runs in a worktree that SHARES this local
  // config; without pinning gpgsign off, a signing-configured machine breaks (D).
  g('config', 'commit.gpgsign', 'false')
  g('add', '-A')
  // Commit SUBJECTS are scanned too (the preflight pins `LEAK_GATE_BASE_SHA`),
  // so every subject here stays free of the root.
  g('commit', '-q', '-m', 'base: gate scaffolding')
  const base = g('rev-parse', 'HEAD')

  writeFileSync(join(dir, PLAN_DOC), SEEDED_DOC)
  g('add', '-A')
  g('commit', '-q', '-m', 'add plan doc')
  const dirty = g('rev-parse', 'HEAD')

  writeFileSync(join(dir, PLAN_DOC), CLEAN_DOC)
  g('add', '-A')
  g('commit', '-q', '-m', 'reword plan doc')
  const clean = g('rev-parse', 'HEAD')

  g('branch', '-f', 'case-a', dirty)
  g('branch', '-f', 'case-b', clean)
  g('branch', '-f', 'case-d', dirty)
  g('branch', '-f', 'case-e', dirty)

  // case-f: a branch that SABOTAGES its own committed copy of the gate. If the preflight ever
  // executed the scanned checkout's script again, this one would report SILENT and leave a marker
  // file behind — the exfil shape the round-1 review reproduced, minus the credential.
  writeFileSync(
    join(dir, 'scripts', 'ci', 'leak-gate.sh'),
    ['#!/usr/bin/env bash', `: > ${JSON.stringify(join(dir, 'CHECKOUT-GATE-RAN'))}`, 'echo "LEAK GATE: SILENT"', 'exit 0', ''].join(
      '\n',
    ),
  )
  // …and it carries the SEEDED doc, so "no finding" can only mean the sabotaged gate ran.
  writeFileSync(join(dir, PLAN_DOC), SEEDED_DOC)
  g('add', '-A')
  g('commit', '-q', '-m', 'a branch that rewrites the scanner')
  const sabotaged = g('rev-parse', 'HEAD')
  g('branch', '-f', 'case-f', sabotaged)
  // Leave the shared working tree back on the real gate; the branches carry the difference.
  g('checkout', '-q', clean, '--', 'scripts/ci/leak-gate.sh', PLAN_DOC)

  fixture = { dir, base, dirty, clean, sabotaged }
  return fixture
}

/**
 * The test's OWN host runner, with an env it REPLACES rather than merges.
 * `spawnCapture` layers `extraEnv` over `process.env` and so can never DROP
 * `GITHUB_ACTIONS`; inside CI that would flip the gate to its canonical
 * secret-access context, where a missing denylist is a hard exit 2 on every
 * case here. `LEAK_GATE_*` goes too, and the denylist file is pinned to a path
 * that cannot exist so the gate's `$XDG_CONFIG_HOME`/`$HOME` fallback — which
 * DOES exist on a maintainer's machine — cannot quietly arm the PII tiers.
 */
function makeRunner(overrides: Record<string, string> = {}): EnvCapableHostRunner {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('GITHUB_') || k.startsWith('LEAK_GATE_') || v === undefined) continue
    env[k] = v
  }
  env['LEAK_GATE_PII_DENYLIST_FILE'] = '/nonexistent/leak-gate/denylist-absent'
  Object.assign(env, overrides)
  return async (cmd, cwd, extraEnv, _timeoutMs) => {
    const proc = Bun.spawn(cmd, {
      ...(cwd !== undefined ? { cwd } : {}),
      env: { ...env, ...extraEnv },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, exit_code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { ok: exit_code === 0, stdout, stderr, exit_code }
  }
}

/**
 * A scan path that does NOT yet exist and is never reused — `git worktree add`
 * refuses a non-empty existing directory, so every case gets its own.
 */
function scanDir(): string {
  const parent = mkdtempSync(join(tmpdir(), 'leak-scan-'))
  created.push(parent)
  return join(parent, 'scan')
}

function sortFindings<T extends { rule: string }>(f: T[]): T[] {
  return [...f].sort((a, b) => a.rule.localeCompare(b.rule))
}

describe('purity preflight against the REAL leak gate', () => {
  test('a seeded plan doc is DETECTED and reported, never silently passed', async () => {
    const f = fixtureRepo()
    const scratch = scanDir()
    const outcome = await runLeakGatePreflight({
      run_host: makeRunner(),
      repo_path: f.dir,
      branch: 'case-a',
      head: f.dirty,
      base_sha: f.base,
      scratch_dir: scratch,
    })

    expect(outcome.status).toBe('findings-unresolved')
    expect(outcome.attempts).toBe(0)
    expect(outcome.head).toBe(f.dirty)
    expect(sortFindings(outcome.findings)).toEqual([
      { rule: `${T2}-purged`, file: PLAN_DOC, line: 3 },
      { rule: `${T2}-word`, file: PLAN_DOC, line: 3 },
    ])
    // The throwaway worktree is gone even on the findings path.
    expect(existsSync(scratch)).toBe(false)
  }, 30_000)

  test('positive control: a clean doc passes the rules that ran, and a tier that could not run is REPORTED as skipped', async () => {
    const f = fixtureRepo()
    const scratch = scanDir()
    const outcome = await runLeakGatePreflight({
      run_host: makeRunner(),
      repo_path: f.dir,
      branch: 'case-b',
      head: f.clean,
      base_sha: f.base,
      scratch_dir: scratch,
    })

    // "Looked at nothing" must never read as "found nothing".
    expect(outcome.status).toBe('incomplete')
    expect(outcome.findings.length).toBe(0)
    expect(outcome.skipped_rules).toEqual(['pii-denylist', 'pii-denylist-msg'])
  }, 30_000)

  test('with a denylist supplied the same clean tree is fully CLEAN', async () => {
    const f = fixtureRepo()
    const denyDir = mkdtempSync(join(tmpdir(), 'leak-denylist-'))
    created.push(denyDir)
    const denylist = join(denyDir, 'denylist.txt')
    // A synthetic token that matches nothing: the tier RUNS and finds nothing.
    writeFileSync(denylist, 'qqzzsyntheticpiitoken\n')

    const outcome = await runLeakGatePreflight({
      run_host: makeRunner({ LEAK_GATE_PII_DENYLIST_FILE: denylist }),
      repo_path: f.dir,
      branch: 'case-b',
      head: f.clean,
      base_sha: f.base,
      scratch_dir: scanDir(),
    })

    expect(outcome.status).toBe('clean')
    expect(outcome.skipped_rules).toEqual([])
    expect(outcome.findings.length).toBe(0)
  }, 30_000)

  test('a real fixer round terminates, commits and moves the branch ref', async () => {
    const f = fixtureRepo()
    const scratch = scanDir()
    const denyDir = mkdtempSync(join(tmpdir(), 'leak-denylist-'))
    created.push(denyDir)
    const denylist = join(denyDir, 'denylist.txt')
    writeFileSync(denylist, 'qqzzsyntheticpiitoken\n')
    const outcome = await runLeakGatePreflight({
      // A denylist is supplied ON PURPOSE: `fixed` is a passing word, and it is only honest when
      // every tier actually ran. The no-denylist variant is the next case.
      run_host: makeRunner({ LEAK_GATE_PII_DENYLIST_FILE: denylist }),
      repo_path: f.dir,
      branch: 'case-d',
      head: f.dirty,
      base_sha: f.base,
      scratch_dir: scratch,
      fixer: async ({ worktree }) => {
        writeFileSync(join(worktree, PLAN_DOC), CLEAN_DOC)
        execFileSync('git', ['-C', worktree, 'add', PLAN_DOC], { stdio: ['ignore', 'pipe', 'pipe'] })
        return { fixed: true }
      },
    })

    const g = (...a: string[]): string =>
      execFileSync('git', ['-C', f.dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

    expect(outcome.status).toBe('fixed')
    expect(outcome.attempts).toBe(1)
    expect(outcome.head).not.toBe(f.dirty)
    // The compare-and-swap actually moved the branch, and it moved it FORWARD:
    // the new head is a child of the old, not a rewrite of it.
    expect(g('rev-parse', 'refs/heads/case-d')).toBe(outcome.head)
    expect(g('rev-parse', `${outcome.head}~1`)).toBe(f.dirty)
    const committedDoc = g('show', `${outcome.head}:${PLAN_DOC}`)
    expect(committedDoc).toContain('absolute host filesystem paths')
    expect(committedDoc).not.toContain(T2)
    expect(existsSync(scratch)).toBe(false)
  }, 30_000)

  /**
   * A SUCCESSFUL REWORD DOES NOT MAKE AN UNRUN TIER RUN. The first cut reported `status: 'fixed'`
   * whenever an attempt had landed, so a run whose PII tiers never executed carried a passing
   * word — the same "looked at nothing reads as found nothing" this module exists to refuse.
   */
  test('a fix that lands while a tier could NOT run is incomplete, and still names the tiers', async () => {
    const f = fixtureRepo()
    const outcome = await runLeakGatePreflight({
      run_host: makeRunner(),
      repo_path: f.dir,
      branch: 'case-e',
      head: f.dirty,
      base_sha: f.base,
      scratch_dir: scanDir(),
      fixer: async ({ worktree }) => {
        writeFileSync(join(worktree, PLAN_DOC), CLEAN_DOC)
        execFileSync('git', ['-C', worktree, 'add', PLAN_DOC], { stdio: ['ignore', 'pipe', 'pipe'] })
        return { fixed: true }
      },
    })

    expect(outcome.status).toBe('incomplete')
    expect(outcome.attempts).toBe(1)
    expect(outcome.skipped_rules).toEqual(['pii-denylist', 'pii-denylist-msg'])
    // The fix still landed — the verdict word is the only thing that changed.
    expect(outcome.head).not.toBe(f.dirty)
  }, 30_000)

  /**
   * THE SCANNED CHECKOUT DOES NOT SUPPLY THE SCANNER. `case-f` commits a `scripts/ci/leak-gate.sh`
   * that would report SILENT and touch a marker file if it were ever executed. Under the
   * production runner that process also inherits the owner's GitHub credential, which is what made
   * this a blocker rather than a curiosity. The seeded doc must still be DETECTED, by OUR gate.
   */
  test('a branch that rewrites the gate does not get its gate run — findings are still reported', async () => {
    const f = fixtureRepo()
    const marker = join(f.dir, 'CHECKOUT-GATE-RAN')
    rmSync(marker, { force: true })
    const outcome = await runLeakGatePreflight({
      run_host: makeRunner(),
      repo_path: f.dir,
      branch: 'case-f',
      head: f.sabotaged,
      base_sha: f.base,
      scratch_dir: scanDir(),
    })

    expect(existsSync(marker)).toBe(false)
    expect(outcome.status).toBe('findings-unresolved')
    expect(outcome.findings.some((x) => x.file === PLAN_DOC)).toBe(true)
  }, 30_000)
})
