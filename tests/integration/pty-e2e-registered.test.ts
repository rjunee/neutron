/**
 * A credential-gated E2E must have a RUNNER, or the gate is a deletion that still
 * looks like coverage.
 *
 * ISSUES #509. Three suites are gated behind `NEUTRON_PTY_E2E=1` because they
 * spawn a real `claude` under a real PTY and need working credentials, which CI
 * does not have. The gate is correct. What was wrong is that the variable was set
 * in ZERO places — not CI, not a script, not a documented command — so none of the
 * three had ever run anywhere, while each reported `0 pass, N skip, 0 fail`, which
 * reads as a passing file in any summary that counts failures.
 *
 * That mattered concretely. One of them is the T7 acceptance for the shipped
 * ritual templates, and its existence is what someone would cite to claim that
 * criterion is covered. Run for the first time on 2026-08-07, two cases passed and
 * the third COULD NOT pass: its reply poll gave up at 60s while its own test budget
 * was 180s, so the heaviest ritual reported "produced nothing" when the truth was
 * "our wait was shorter than the work".
 *
 * This test is the thing that keeps that from recurring: it runs in CI, it does
 * NOT need credentials, and it fails if a gated suite is not registered in
 * `scripts/run-pty-e2e.sh`. It cannot prove anyone RAN the suites — nothing in CI
 * can — but it does guarantee that "how do I run this" always has an answer, and
 * that adding a new gated suite forces you to answer it.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const RUNNER = join(REPO_ROOT, 'scripts', 'run-pty-e2e.sh')

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.claude'])

/** Every `*.test.ts` under the repo, excluding vendored / build trees. */
function walkTests(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) walkTests(full, out)
    else if (entry.endsWith('.test.ts')) out.push(full)
  }
  return out
}

/**
 * Every `.ts` a test run can load: every `*.test.ts`, plus every module under a
 * `__tests__/` directory (fakes, fixtures, capture helpers).
 *
 * WIDER THAN `walkTests` ON PURPOSE. A rule about what tests may do to process state
 * has to cover the files tests IMPORT, or the next hand-rolled copy simply moves into a
 * helper and the guard reports clean.
 */
function allTestSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) allTestSources(full, out)
    else if (entry.endsWith('.test.ts')) out.push(full)
    else if (entry.endsWith('.ts') && full.includes(`${sep}__tests__${sep}`)) out.push(full)
  }
  return out
}

/** The suites that gate themselves on the PTY opt-in. */
function gatedSuites(): string[] {
  return walkTests(REPO_ROOT)
    .filter((f) => {
      let src: string
      try {
        src = readFileSync(f, 'utf8')
      } catch {
        return false
      }
      // Only a suite that GATES on the flag, not one that merely mentions it —
      // this very file names it, and the config inventory documents it.
      return src.includes('NEUTRON_PTY_E2E') && /skipIf\(/.test(src)
    })
    .map((f) => relative(REPO_ROOT, f))
    .sort()
}

describe('every NEUTRON_PTY_E2E-gated suite is registered in a runner', () => {
  test('the runner script exists and is the documented entry point', () => {
    const src = readFileSync(RUNNER, 'utf8')
    expect(src).toContain('NEUTRON_PTY_E2E=1')
    expect(src).toContain('PTY_E2E_SUITES')
  })

  test('there is at least one gated suite to discover (the detector works)', () => {
    // Guards the detector itself: if the regex stopped matching, this file would
    // pass vacuously while every gated suite went unregistered — the exact
    // class of defect it exists to prevent.
    expect(gatedSuites().length).toBeGreaterThan(0)
  })

  test('every gated suite appears in the runner registry', () => {
    const runner = readFileSync(RUNNER, 'utf8')
    const missing = gatedSuites().filter((s) => !runner.includes(s))
    expect(missing).toEqual([])
  })

  test('the bun test preload does not scrub the opt-in flag', () => {
    // The gate only works if the flag REACHES the suite. tests/support/
    // scrub-instance-env.ts deletes NEUTRON_* to keep the run hermetic; once it
    // took NEUTRON_PTY_E2E with it and `bash scripts/run-pty-e2e.sh` reported
    // "0 failed" while all three suites skipped — this file's own incident,
    // re-opened from a different direction. The preload keeps an explicit
    // allow-list; this pins that the flag is on it.
    const preload = readFileSync(join(REPO_ROOT, 'tests', 'support', 'scrub-instance-env.ts'), 'utf8')
    expect(preload).toContain('NEUTRON_PTY_E2E')
  })

  // THE SAME INCIDENT FROM A THIRD DIRECTION. The two above are about the flag not
  // ARRIVING; this one is about a switch being turned OFF by an unrelated suite in the
  // same process. A test that sets `HERDR_SOCKET_PATH` to a dead path to keep itself
  // hermetic — three do, and they are right to — disables the only tests in this repo
  // that can see a real herdr server if it never puts the value back. That is a
  // coverage hole no coverage measurement can show: the instrument reports "skipped",
  // which reads as a decision rather than as damage. It is also not hypothetical — the
  // transport defect this branch fixed was exactly the class only a live proof could
  // have caught.
  test('no suite can silently switch a live proof off — every writer restores', () => {
    const SWITCHES = ['HERDR_SOCKET_PATH', 'NEUTRON_PTY_E2E']
    const writers: string[] = []
    const offenders: string[] = []
    // `allTestSources`, not `walkTests`: same domain lesson as the stderr guard below —
    // a helper module under `__tests__/` is exactly where the next copy would hide.
    for (const f of allTestSources(REPO_ROOT)) {
      let src: string
      try {
        src = readFileSync(f, 'utf8')
      } catch {
        continue
      }
      for (const k of SWITCHES) {
        // ASSIGNMENT ONLY. `\s*=` alone also matches the `=` of `===`, which every
        // gated suite uses to READ its own flag — the first version of this guard
        // reported all three e2e suites as offenders for testing the variable they
        // exist to be gated by.
        if (!new RegExp(String.raw`process\.env\['${k}'\]\s*=(?!=)`).test(src)) continue
        writers.push(`${relative(REPO_ROOT, f)}:${k}`)
        // Restoring means BOTH halves: a teardown hook, and the branch that puts an
        // absent value back by deleting rather than by writing 'undefined'.
        const restores =
          /\b(afterAll|afterEach)\(/.test(src) &&
          new RegExp(String.raw`delete process\.env\['${k}'\]`).test(src)
        if (!restores) offenders.push(`${relative(REPO_ROOT, f)} writes ${k} and never restores it`)
      }
    }
    // POSITIVE CONTROL. An empty `offenders` means nothing only if the detector can
    // see a real write at all — a mistyped pattern would report a clean tree forever.
    expect(writers.length).toBeGreaterThanOrEqual(3)
    expect(offenders).toEqual([])
  })

  // NO TEST MAY MONKEY-PATCH PROCESS STATE BY HAND — not just the live ones. The
  // hand-rolled shape is install, do the interesting thing, restore, and it goes wrong
  // two ways that both leave the process changed for everything after it: the restore
  // sits after an `await` that can reject (a spawn that fails on a protocol mismatch,
  // an unreachable socket, a pid that never arrives), and the "restore" installs
  // `original.bind(process.stderr)` — a DIFFERENT function object from the one it
  // replaced, so nested or repeated captures stack binds forever.
  //
  // THIS GUARD WAS FIRST SCOPED TO `*.e2e.test.ts`, WHICH IS WHERE I FOUND THE
  // PROBLEM — and that is the whole lesson. Five suites had the bind bug and none of
  // them was an e2e file, so the guard could not see any of them. A guard scoped to the
  // file type where the defect was noticed is a guard scoped to the sample; the domain
  // has to be the domain of the RULE. It is now every test in the repo, plus every
  // module under a `__tests__/` directory, because a helper is exactly where the next
  // hand-rolled copy would hide.
  test('no test monkey-patches stderr by hand — the helper is the only assignment', () => {
    const PATCH = /process\.stderr\.write\s*=(?!=)/
    const HELPER = 'runtime/adapters/claude-code/persistent/__tests__/capture-stderr.ts'
    const offenders = allTestSources(REPO_ROOT)
      .filter((f) => {
        try {
          return PATCH.test(readFileSync(f, 'utf8'))
        } catch {
          return false
        }
      })
      .map((f) => relative(REPO_ROOT, f))
      .filter((rel) => rel !== HELPER)
    expect(offenders).toEqual([])
    // POSITIVE CONTROL, in two parts: the pattern finds the assignment where it
    // legitimately lives, and the WALK reaches that file at all. An empty offender list
    // proves nothing if either the pattern or the domain is wrong, and both have been
    // wrong on this branch already.
    expect(PATCH.test(readFileSync(join(REPO_ROOT, HELPER), 'utf8'))).toBe(true)
    expect(allTestSources(REPO_ROOT).map((f) => relative(REPO_ROOT, f))).toContain(HELPER)
  })

  test('the registry lists no suite that no longer exists', () => {
    // A stale entry makes the runner report a MISSING suite at run time, which is
    // the one moment nobody is watching CI.
    const runner = readFileSync(RUNNER, 'utf8')
    const listed = [...runner.matchAll(/^\s*"([^"]+\.e2e\.test\.ts)"$/gm)].map((m) => m[1]!)
    expect(listed.length).toBeGreaterThan(0)
    const all = new Set(walkTests(REPO_ROOT).map((f) => relative(REPO_ROOT, f)))
    expect(listed.filter((s) => !all.has(s))).toEqual([])
  })
})
