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
 * Every `.ts` in the repository, minus the vendored and build trees named in
 * {@link SKIP_DIRS}.
 *
 * THE DOMAIN IS THE RULE'S DOMAIN, NOT A DIRECTORY WHITELIST. This was
 * `*.test.ts` plus anything under a `__tests__/` directory, with a docblock claiming it
 * "has to cover the files tests IMPORT, or the next hand-rolled copy simply moves into a
 * helper and the guard reports clean". That sentence described a bypass the
 * implementation left open: `__tests__/` is ONE PLACE helpers live, not the definition
 * of a helper, and `tests/support/*.ts` — imported by the test preload — was invisible.
 * A guard whose recogniser is narrower than the claim in its own comment; the third of
 * that shape across three branches.
 *
 * So the domain is everything, and the exclusions are NAMED rather than implied. The
 * cost is reading ~2,500 files instead of ~1,400, which is under a second. Scanning
 * production too is deliberate and not collateral: production has no business assigning
 * the live-proof switches or `process.stderr.write` either, so a hit there is a finding
 * rather than a false positive.
 */
function allSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) allSourceFiles(full, out)
    else if (entry.endsWith('.ts')) out.push(full)
  }
  return out
}

/**
 * MATCH THE OPERATION, NOT ONE SPELLING OF IT.
 *
 * These were inline regexes matching `process.env['KEY'] =` and nothing else, so
 * `process.env.KEY = …` and `process.env["KEY"] = …` walked straight past. Extracted so
 * each admitted form can be asserted on its own — a single mutation that reds every
 * control would mean the controls test the collector rather than the matcher.
 *
 * The `(?!=)` stays: it is why `===` in a gated suite reading its own flag is not a
 * write, which was a real defect. What it did not do was widen beyond the one spelling
 * it was written against.
 */
const envRef = (key: string): string =>
  String.raw`process\.env(?:\.${key}|\[\s*['"\`]${key}['"\`]\s*\])`
/** An ASSIGNMENT to `key`, in any admitted spelling. `=` only, never `==`/`===`. */
export function matchesEnvWrite(key: string, src: string): boolean {
  return new RegExp(String.raw`${envRef(key)}\s*=(?!=)`).test(src)
}
/** A `delete` of `key`, in any admitted spelling — the restore side of the same rule,
 *  which has to admit exactly what the writer side does or one passes for a spelling
 *  the other catches. */
export function matchesEnvDelete(key: string, src: string): boolean {
  return new RegExp(String.raw`delete\s+${envRef(key)}`).test(src)
}
/** A bulk copy INTO the environment object (the static-method form of `assign`, applied
 *  to `process.env`) — key-blind by construction, so
 *  any such call is treated as touching every switch. Zero occurrences in the tree today;
 *  admitted because it is the named form a literal-key matcher cannot see. */
export function matchesEnvBulkAssign(src: string): boolean {
  return /Object\s*\.\s*assign\s*\(\s*process(?:\.env|\[\s*['"`]env['"`]\s*\])/.test(src)
}

/**
 * FIXTURE TEXT IS ASSEMBLED, NEVER SPELLED. Every positive fixture in this file is an
 * exact instance of what the guards here hunt, and they scan every `.ts` in the tree —
 * including this one. Written literally, this file becomes its own top offender. It did,
 * twice: once when the per-form matcher cases were added, and again when the switch
 * guard's own fixture was written out longhand. Both times the guard caught it, which is
 * the instrument working rather than a nuisance.
 *
 * The alternative — exempting the file that DEFINES the rule — is the one fix that must
 * not be used: it puts the hole in the place nobody would look. Joined at runtime, the
 * string the matcher sees is byte-identical to the literal form.
 */
const asm = (...parts: string[]): string => parts.join('')
const PROC = 'process'
const KEY = 'HERDR_SOCKET_PATH'
// Split out for the same reason: a fixture line that contains the keyword AND the
// specifier is itself a match for the re-export patterns, so the keyword never appears
// literally on a line that also names the module.
const EXP = 'export'
const HH_SPEC = "'../herdr-host.ts'"


/**
 * The switches this guard polices, and the ONE module permitted to write them.
 *
 * THE LIST LIVES HERE, with the rule, rather than being imported from the helper. The
 * helper takes the key as a parameter and needs no list of its own, and importing one
 * across a workspace boundary is exactly what the L5 lint gate refuses — so the policer
 * owns the policy and names the exempt path as a string.
 */
const ENV_SWITCHES = ['HERDR_SOCKET_PATH', 'NEUTRON_PTY_E2E'] as const
export const ENV_SWITCH_HELPER = 'runtime/adapters/__tests__/env-switch.ts'

/**
 * Files that mutate a live-proof switch OUTSIDE the sanctioned helper.
 *
 * TAKES ITS INPUTS, so it can be driven against a fixture as well as against the tree.
 * The previous version was inline over `readFileSync`, which left it with exactly one
 * observable — an empty list — and no way to show it could ever produce a non-empty one
 * from real file content. An instrument that cannot be made to fire is not a gate.
 */
export function findSwitchOffenders(
  files: readonly string[],
  read: (f: string) => string,
  switches: readonly string[],
): string[] {
  const offenders: string[] = []
  for (const rel of files) {
    if (rel === ENV_SWITCH_HELPER) continue
    let src: string
    try {
      src = read(rel)
    } catch {
      continue
    }
    if (matchesEnvBulkAssign(src)) offenders.push(`${rel} bulk-assigns into process.env`)
    for (const k of switches) {
      if (matchesEnvWrite(k, src)) offenders.push(`${rel} writes ${k} outside the helper`)
      if (matchesEnvDelete(k, src)) offenders.push(`${rel} deletes ${k} outside the helper`)
    }
  }
  return offenders
}

/**
 * Does this source REACH the module that defines the herdr pane constructor?
 *
 * STRUCTURAL, NOT A SPELLING MATCHER — and that is the whole point. The guard this
 * replaces searched for `new HerdrHost(`, so `herdrHost.spawn(...)` (there is an exported
 * singleton), `new (HerdrHost)(...)`, and a factory returning one each opened a real pane
 * while the offender list stayed empty. Widening cannot terminate: after the factory comes
 * a computed member, an aliased binding, a re-export. Every round of widening buys one
 * spelling and leaves the set infinite.
 *
 * Reachability inverts it. A module's exports cannot be used by a file that never names
 * the module, whatever syntax it would have used — so the question becomes "is the path in
 * a string literal here", which has a small and closed set of forms: a static import, a
 * dynamic `import()`, and `require()`. All three carry the specifier as a quoted string.
 *
 * The residual is a module that RE-EXPORTS the constructor, which would let a file reach it
 * without naming this path. That is not left as prose — it is closed by its own assertion
 * that no such re-exporter exists, which is what makes this argument complete rather than
 * merely narrower.
 */
export function reachesHerdrHostModule(src: string): boolean {
  return /['"`][^'"`]*herdr-host(?:\.ts)?['"`]/.test(src)
}

/** The module that owns the pane constructor. */
export const HERDR_HOST_OWNER = 'runtime/adapters/claude-code/persistent/herdr-host.ts'

/**
 * Does this source RE-EXPORT the pane constructor or its singleton?
 *
 * THE ONE ASSUMPTION {@link reachesHerdrHostModule} RESTS ON. Reachability is an argument
 * only if naming that module is the ONLY route to the constructor; a barrel that
 * re-exported it would let a live proof reach it while naming something else entirely.
 * Rather than leave that as a caveat in prose, it is a predicate with its own assertion,
 * so the day someone adds such a barrel the reachability claim reds instead of quietly
 * becoming false.
 *
 * Described rather than spelled in the patterns below: these scan every `.ts` including
 * the file they live in, and writing the forms out longhand makes this file its own top
 * offender — which it did, on the first run, for the third time on this branch.
 */
export function reexportsHerdrHost(src: string): boolean {
  return (
    /export\s[^\n]*\sfrom\s*['"`][^'"`]*herdr-host/.test(src) ||
    /export\s*\{[^}]*\bHerdrHost\b[^}]*\}/.test(src) ||
    /export\s*\{[^}]*\bherdrHost\b[^}]*\}/.test(src)
  )
}

/** An assignment to the process's stderr writer, in any admitted spelling. */
export function matchesStderrWrite(src: string): boolean {
  return /process(?:\.stderr|\[\s*['"`]stderr['"`]\s*\])\.write\s*=(?!=)/.test(src)
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
  // hermetic — three did, and they were right to — disables the only tests in this repo
  // that can see a real herdr server if it never puts the value back. That is a
  // coverage hole no coverage measurement can show: the instrument reports "skipped",
  // which reads as a decision rather than as damage. It is also not hypothetical — the
  // transport defect this branch fixed was exactly the class only a live proof could
  // have caught.
  //
  // NOW STRUCTURAL, BECAUSE THE PAIRING CHECK WAS UNSOUND. This accepted any file that
  // contained a teardown hook AND a matching `delete` anywhere in it. The obligation is
  // ASSIGNMENT-scoped and that test is FILE-scoped, so a file with two writes and one
  // unrelated restore passed, and so would a second, unscoped write added later to a
  // file that already had a correct one. There is now one sanctioned writer
  // (`tests/support/env-switch.ts`) and every other write is an offender outright —
  // no pairing to verify, because there is only one writer and it is written once.
  test('no suite writes a live-proof switch DIRECTLY or by bulk copy — the helper is the only writer', () => {
    const rels = allSourceFiles(REPO_ROOT).map((f) => relative(REPO_ROOT, f))
    const offenders = findSwitchOffenders(
      rels,
      (rel) => readFileSync(join(REPO_ROOT, rel), 'utf8'),
      ENV_SWITCHES,
    )
    expect(offenders).toEqual([])
  })

  // THE BOUNDARY OF THAT TITLE, PINNED AS BEHAVIOUR. It says DIRECTLY or BY BULK COPY,
  // and it means it: a reflective write, a write through an aliased binding, and a
  // defined property all reach `process.env` without any of them appearing as an
  // assignment to a literal key. These assert that the guard does NOT see them — not
  // because that is desirable, but because a limit nobody can execute is a limit nobody
  // believes. Widening the matcher to chase them cannot terminate: after reflection comes
  // a computed key, a re-aliased alias, a proxy. The honest move is a claim narrow enough
  // to be true and a boundary written as a test.
  //
  // WHY NOT STRUCTURAL, THE WAY THE PANE GUARD IS. Reachability works there because the
  // constructor lives behind a module specifier a file must name. `process.env` is a
  // global: every file in the repo can already reach it, so there is no import to
  // withhold and nothing to make unreachable. The form-blind answer would be a RUNTIME
  // check — snapshot the switches in the preload, compare at process exit, which sees
  // every spelling because it observes the value rather than the text — and it is NOT
  // AVAILABLE here, measured rather than assumed: under `bun test` 1.3.13 the preload is
  // imported but neither `exit` nor `beforeExit` ever fires, and an `exitCode` set from
  // such a hook never reaches the runner. A deliberately leaking fixture exits 0 with
  // nothing printed. An instrument that cannot fire is not a gate.
  describe('the switch guard does not claim what it cannot see', () => {
    const REFLECT = asm('Reflect.', 'set(', PROC, ".env, '", KEY, "', '/dead')")
    const ALIASED = asm('const e = ', PROC, '.env; e.', KEY, " = '/dead'")
    const DEFINED = asm('Object.', 'defineProperty(', PROC, '.env, ', `'${'HERDR_SOCKET_PATH'}'`, ', { value: 1 })')

    test('a reflective write is OUTSIDE this guard', () => {
      expect(matchesEnvWrite(KEY, REFLECT)).toBe(false)
      expect(matchesEnvBulkAssign(REFLECT)).toBe(false)
    })
    test('a write through an aliased binding is OUTSIDE this guard', () => {
      expect(matchesEnvWrite(KEY, ALIASED)).toBe(false)
      expect(matchesEnvBulkAssign(ALIASED)).toBe(false)
    })
    test('a defined property is OUTSIDE this guard', () => {
      expect(matchesEnvWrite(KEY, DEFINED)).toBe(false)
      expect(matchesEnvBulkAssign(DEFINED)).toBe(false)
    })
    // AND THE TREE HAS NONE OF THEM, which is what makes the stated boundary a boundary
    // rather than a hole being walked through today. Measured, not assumed — and it reds
    // the day one appears, which is the point at which the limit has to be revisited.
    test('...and no source in the tree uses one of those forms on a switch', () => {
      const found = allSourceFiles(REPO_ROOT)
        .map((f) => relative(REPO_ROOT, f))
        .filter((rel) => {
          let src: string
          try {
            src = readFileSync(join(REPO_ROOT, rel), 'utf8')
          } catch {
            return false
          }
          if (!ENV_SWITCHES.some((k) => src.includes(k))) return false
          return /Reflect\s*\.\s*set\s*\(|Object\s*\.\s*defineProperty\s*\(/.test(src)
        })
      expect(found).toEqual([])
    })
  })

  // AND THE GUARD ABOVE CAN ACTUALLY FIRE. Its only observable against the tree is an
  // empty list, and after the conversion there is no real literal write left anywhere to
  // prove the recogniser still works — the old `writers.length >= 3` control died with
  // the thing it was counting. Driving the same function over a FIXTURE restores a
  // failing direction, which is the half an absence claim cannot supply for itself.
  test('the switch guard FIRES on a real write, and exempts exactly one path', () => {
    const fixture: Record<string, string> = {
      'some/suite.test.ts': asm(PROC, ".env['", KEY, "'] = '/dead'"),
      'some/other.test.ts': asm('delete ', PROC, '.env.NEUTRON_PTY_E2E'),
      'some/bulk.test.ts': asm('Object.', 'assign(', PROC, '.env, { X: 1 })'),
      // A READ is not a write, and the refinement has to survive being driven here too.
      'some/innocent.test.ts': `if (process.env.NEUTRON_PTY_E2E === '1') run()`,
      // THE CASE THE OLD PAIRING CHECK ACCEPTED, and the reason this is structural now.
      // A teardown hook and a matching delete EXIST in this file, so "any afterAll plus
      // any delete" called it restored — while the second, unscoped write at the top is
      // never put back by anything. The obligation is assignment-scoped; the old test
      // was file-scoped, and a file only has to satisfy a file-scoped test once.
      'some/two-writes.test.ts': asm(
        PROC, ".env['", KEY, "'] = '/dead'\n",
        'afterAll(() => { delete ', PROC, ".env['", KEY, "'] })\n",
        PROC, ".env['", KEY, "'] = '/also-dead'\n",
      ),
      // The helper does the same thing and is the ONE path allowed to.
      [ENV_SWITCH_HELPER]: asm(PROC, ".env['", KEY, "'] = v; delete ", PROC, '.env.NEUTRON_PTY_E2E'),
    }
    const offenders = findSwitchOffenders(Object.keys(fixture), (f) => fixture[f]!, ENV_SWITCHES)
    expect(offenders).toEqual([
      'some/suite.test.ts writes HERDR_SOCKET_PATH outside the helper',
      'some/other.test.ts deletes NEUTRON_PTY_E2E outside the helper',
      'some/bulk.test.ts bulk-assigns into process.env',
      'some/two-writes.test.ts writes HERDR_SOCKET_PATH outside the helper',
      'some/two-writes.test.ts deletes HERDR_SOCKET_PATH outside the helper',
    ])
  })

  // THE HELPER REALLY IS WHAT THE SUITES USE, so the exemption above is not simply an
  // unused escape hatch that lets the guard report clean over a tree nobody pins.
  test('the sanctioned helper is imported by every suite that needs a switch', () => {
    const users = allSourceFiles(REPO_ROOT)
      .map((f) => relative(REPO_ROOT, f))
      .filter((rel) => rel !== ENV_SWITCH_HELPER)
      .filter((rel) => {
        try {
          return readFileSync(join(REPO_ROOT, rel), 'utf8').includes('pinEnvSwitch(')
        } catch {
          return false
        }
      })
    expect(users.length).toBeGreaterThanOrEqual(3)
  })

  // NO LIVE PROOF MAY SPAWN A HERDR PANE OUTSIDE THE SCOPED HELPER — and this is the
  // guard with a user-visible blast radius. The others protect the test run; this one
  // protects the OWNER'S SCREEN. These suites leaked four orphaned `claude` processes
  // into his herdr workspace, each a real REPL container parented straight to the
  // server, ages spanning the hours this lane had been running its proofs. He found
  // them by looking at his own session and asking whether they were us.
  //
  // NOTHING AUTOMATED COULD HAVE SEEN IT. The panes are created THROUGH A SOCKET by a
  // process the test does not own, so the test's own process shows no leak — no fd, no
  // child, no handle. And CI never runs these at all, because they are opt-in and
  // skipped there. That is the same property that let the one-request-per-connection
  // transport defect survive eight green rounds: this lane's live surface has no
  // automated observer, so a rule about it has to be enforced statically, here, in a
  // test that DOES run in CI.
  //
  // A SPELLING-BOUND VERSION OF THIS GUARD WAS DELETED RATHER THAN WIDENED. It searched
  // `new HerdrHost\s*\(`, which is one spelling of one way to get a pane: `herdrHost` is
  // an exported SINGLETON whose `.spawn(...)` never says `new`, `new (HerdrHost)(...)`
  // parenthesises past the pattern, and a factory hides it a call away. Each opens a real
  // pane in the owner's workspace while the offender list stays empty. Widening cannot
  // terminate — after the factory comes a computed member, an aliased binding, a
  // re-export — and a guard whose title promises more than its matcher delivers is worse
  // than no guard, because the title is what the next reader believes. The reachability
  // test below subsumes it completely: nothing can construct what it cannot reach.

  // AND THE REAL GUARANTEE IS REACHABILITY, NOT RECOGNITION. Everything above hunts for a
  // construction; this makes the construction UNREACHABLE from a live proof, which is the
  // only form of this rule that does not need keeping current.
  //
  // The matcher it replaces searched `new HerdrHost\s*\(`. That is one spelling of one
  // way to get a pane: `herdrHost.spawn(...)` uses the exported SINGLETON and never says
  // `new`; `new (HerdrHost)(...)` parenthesises past the pattern; a factory hides it a
  // call away. Each opened a real pane in the owner's workspace while the offender list
  // stayed empty — and this is the guard with the user-visible blast radius, the one whose
  // absence left four orphaned `claude` panes on his screen.
  //
  // WIDENING CANNOT TERMINATE. After the factory comes a computed member, an aliased
  // binding, a re-export; every round buys one spelling out of an infinite set. So the
  // claim changes shape instead: a file that never NAMES the module cannot use anything
  // the module exports, in any syntax that exists or will exist. The forms of naming are
  // closed — static import, dynamic `import()`, `require()` — and all three carry the
  // specifier as a quoted string.
  test('a live proof cannot REACH the pane constructor — unreachable, not merely unused', () => {
    const rels = allSourceFiles(REPO_ROOT).map((f) => relative(REPO_ROOT, f))
    const live = rels
      .filter((rel) => rel.endsWith('.e2e.test.ts'))
      .filter((rel) => /herdr/i.test(readFileSync(join(REPO_ROOT, rel), 'utf8')))
    expect(live.length).toBeGreaterThanOrEqual(3)
    const reaching = live.filter((rel) =>
      reachesHerdrHostModule(readFileSync(join(REPO_ROOT, rel), 'utf8')),
    )
    expect(reaching).toEqual([])

    // THE RESIDUAL, CLOSED RATHER THAN NAMED. Reachability is only an argument if this
    // path is the ONLY way to the constructor — a module that re-exported it would let a
    // live proof reach it while naming something else entirely. Nothing does, and that is
    // asserted here so the argument above stays complete as the tree changes.
    const reexporters = rels.filter((rel) => {
      if (rel === HERDR_HOST_OWNER) return false
      try {
        return reexportsHerdrHost(readFileSync(join(REPO_ROOT, rel), 'utf8'))
      } catch {
        return false
      }
    })
    expect(reexporters).toEqual([])

    // ...AND THE HELPER IS WHAT THEY ACTUALLY USE, so "cannot reach the constructor" is
    // not "does not spawn panes at all". Unreachability without this would be satisfied by
    // a live proof that had quietly stopped being live.
    const usingHelper = live.filter((rel) =>
      readFileSync(join(REPO_ROOT, rel), 'utf8').includes('withLiveHerdrChild'),
    )
    expect(usingHelper.length).toBe(live.length)

    // POSITIVE CONTROL: the one sanctioned path DOES reach it, so "nothing reaches it" is
    // not "the detector cannot see a reach".
    expect(
      reachesHerdrHostModule(
        readFileSync(
          join(REPO_ROOT, 'runtime/adapters/claude-code/persistent/__tests__/live-herdr-child.ts'),
          'utf8',
        ),
      ),
    ).toBe(true)
  })

  // EVERY FORM OF REACHING, ON ITS OWN — and the boundary, pinned as behaviour.
  describe('reachability admits every way of naming the module', () => {
    for (const [form, src] of [
      ['a static import', `import { HerdrHost } from '../herdr-host.ts'`],
      ['a type-only import', `import type { HerdrHostDeps } from '../herdr-host.ts'`],
      ['an aliased import', `import { HerdrHost as H } from '../herdr-host.ts'`],
      ['the exported singleton', `import { herdrHost } from '../herdr-host.ts'`],
      ['a namespace import', `import * as hh from '../herdr-host.ts'`],
      ['a dynamic import', `const m = await import('../herdr-host.ts')`],
      ['require', `const m = require('../herdr-host.ts')`],
      ['a deeper relative path', `import { HerdrHost } from '../../persistent/herdr-host.ts'`],
      ['an extensionless specifier', `import { HerdrHost } from '../herdr-host'`],
      ['a double-quoted specifier', `import { HerdrHost } from "../herdr-host.ts"`],
    ] as const) {
      test(`${form} counts as reaching the module`, () => {
        expect(reachesHerdrHostModule(src)).toBe(true)
      })
    }

    // THE BOUNDARY, EXECUTABLE RATHER THAN PROSE. Naming the class in a COMMENT is not
    // reaching it — two of the live proofs do exactly that, and a guard that failed them
    // would be demanding they stop explaining themselves.
    test('naming the class in prose is NOT reaching it', () => {
      expect(reachesHerdrHostModule(' * a real herdr PANE (`HerdrHost`, below), not a pty')).toBe(
        false,
      )
    })

    // AND THE STATED NON-GOAL, pinned as CURRENT behaviour so the limit is executable. A
    // barrel that re-exported the constructor would let a file reach it without naming
    // this path — this recogniser says false, and the assertion above is what makes that
    // safe: no such barrel exists, and if one is ever added that assertion reds first.
    test('a re-exporting barrel is NOT seen here — the re-exporter assertion is what closes it', () => {
      expect(reachesHerdrHostModule(`import { HerdrHost } from './index.ts'`)).toBe(false)
    })

    // ...AND THAT ASSERTION CAN FIRE, which is the half an absence claim cannot supply
    // for itself. The tree contains no re-exporter, so against the tree this predicate
    // has exactly one observable — false — and a mistyped pattern would report a clean
    // tree forever. Each admitted form is its own case, so narrowing to any one of them
    // reds exactly one.
    for (const [form, src] of [
      ['a star re-export naming the module', asm(EXP, ' * from ', HH_SPEC)],
      ['a named re-export naming the module', asm(EXP, ' { H } from ', HH_SPEC)],
      ['a named re-export of the class', asm(EXP, ' { HerdrHost }')],
      ['a named re-export of the singleton', asm(EXP, ' { herdrHost }')],
    ] as const) {
      test(`${form} is a re-exporter`, () => {
        expect(reexportsHerdrHost(src)).toBe(true)
      })
    }

    test('an ordinary export of something else is not a re-exporter', () => {
      expect(reexportsHerdrHost(asm(EXP, ' { withLiveHerdrChild }'))).toBe(false)
      expect(reexportsHerdrHost(asm(EXP, ' function spawnPane() {}'))).toBe(false)
    })
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
    const HELPER = 'runtime/adapters/claude-code/persistent/__tests__/capture-stderr.ts'
    const offenders = allSourceFiles(REPO_ROOT)
      .filter((f) => {
        try {
          return matchesStderrWrite(readFileSync(f, 'utf8'))
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
    expect(matchesStderrWrite(readFileSync(join(REPO_ROOT, HELPER), 'utf8'))).toBe(true)
    const reached = allSourceFiles(REPO_ROOT).map((f) => relative(REPO_ROOT, f))
    expect(reached).toContain(HELPER)
    // ...AND THE WALK REACHES A HELPER OUTSIDE `__tests__/`, which is the bypass the old
    // domain left open. `tests/support/scrub-instance-env.ts` is imported by the test
    // preload and is neither a `*.test.ts` nor under a `__tests__/` directory, so it was
    // invisible to every version of this guard before now.
    expect(reached).toContain('tests/support/scrub-instance-env.ts')
    // And production is in scope too, deliberately: a hit there is a finding, not a
    // false positive.
    expect(reached).toContain('runtime/adapters/claude-code/persistent/herdr-host.ts')
  })

  // EACH ADMITTED FORM, ON ITS OWN. The three guards above scan the tree and report an
  // empty offender list; that is an ABSENCE, and an absence is only evidence if the
  // recogniser admits everything the rule names. These assert the matchers directly, one
  // spelling per case, so narrowing any of them back to a single form reds exactly one —
  // a mutation that reds them all would mean they test the collector, not the matcher.
  //
  // Not hypothetical hygiene: extracting these matchers introduced a bug in the same
  // breath — a plain template literal instead of `String.raw`, so `\s` was eaten and the
  // pattern matched a literal `s` and nothing else. The `writers` positive control caught
  // it on the first run.
  //
  describe('the env-switch matcher admits the OPERATION, not one spelling', () => {
    for (const [form, src] of [
      ['single-quoted brackets', asm(PROC, ".env['", KEY, "'] = '/x'")],
      ['double-quoted brackets', asm(PROC, '.env["', KEY, '"] = "/x"')],
      ['dot access', asm(PROC, '.env.', KEY, " = '/x'")],
      ['whitespace inside the brackets', asm(PROC, ".env[ '", KEY, "' ] = '/x'")],
      ['no space around the equals', asm(PROC, ".env['", KEY, "']='/x'")],
    ] as const) {
      test(`a write via ${form} is a write`, () => {
        expect(matchesEnvWrite(KEY, src)).toBe(true)
      })
    }

    for (const [form, src] of [
      ['single-quoted brackets', asm('delete ', PROC, ".env['", KEY, "']")],
      ['double-quoted brackets', asm('delete ', PROC, '.env["', KEY, '"]')],
      ['dot access', asm('delete ', PROC, '.env.', KEY)],
    ] as const) {
      test(`a delete via ${form} is a restore`, () => {
        expect(matchesEnvDelete(KEY, src)).toBe(true)
      })
    }

    // THE REFINEMENT THAT HAS TO SURVIVE THE WIDENING. Every gated suite READS its own
    // flag with `===`. Admitting more spellings must not start admitting comparisons, or
    // all three e2e suites become offenders against a rule they do not break.
    test('a comparison is not a write', () => {
      expect(matchesEnvWrite('NEUTRON_PTY_E2E', "process.env['NEUTRON_PTY_E2E'] === '1'")).toBe(
        false,
      )
    })
    test('a dot-access comparison is not a write either', () => {
      expect(matchesEnvWrite('NEUTRON_PTY_E2E', 'process.env.NEUTRON_PTY_E2E === "1"')).toBe(false)
    })
    test('an inequality is not a write', () => {
      expect(matchesEnvWrite('NEUTRON_PTY_E2E', 'process.env.NEUTRON_PTY_E2E !== "1"')).toBe(false)
    })
    // THE KEY IS LOAD-BEARING. Without this, widening to `process\.env\S* =` would pass
    // every case above while reporting every env write in the repo as a switch offender.
    test('a write to a different key is not a match', () => {
      expect(matchesEnvWrite(KEY, asm(PROC, '.env.SOMETHING_ELSE', ' = "/x"'))).toBe(false)
    })
  })

  describe('the stderr matcher admits the OPERATION, not one spelling', () => {
    for (const [form, src] of [
      ['dot access', asm(PROC, '.stderr', '.write = fake')],
      ['single-quoted member', asm(PROC, "['stderr']", '.write = fake')],
      ['double-quoted member', asm(PROC, '["stderr"]', '.write = fake')],
      ['no space around the equals', asm(PROC, '.stderr', '.write=fake')],
    ] as const) {
      test(`an assignment via ${form} is an assignment`, () => {
        expect(matchesStderrWrite(src)).toBe(true)
      })
    }

    // A CALL IS NOT AN ASSIGNMENT. The logger writes to stderr constantly; only REPLACING
    // the writer is the rule, and a matcher that lost the `=` would name every logging
    // site in the repo.
    test('a call to stderr.write is not an assignment', () => {
      expect(matchesStderrWrite("process.stderr.write('hello')")).toBe(false)
    })
    test('a comparison against stderr.write is not an assignment', () => {
      expect(matchesStderrWrite('if (process.stderr.write === original) {}')).toBe(false)
    })
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
