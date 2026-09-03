import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import type { HostCommandResult } from './git-mode.ts'
import {
  canonicalPayload,
  changedFilesOnBranch,
  changedFilesWithStatus,
  classifyMutationTarget,
  createMutationProver,
  diffHasNoLegalMutationTarget,
  isDeclaredTestFile,
  isProseOnlyChange,
  legalMutationTargets,
  missingClaimRefusalReason,
  MUTATION_PROOF_SCHEMA,
  MUTATION_PROVER_VERSION,
  parseMutationClaim,
  proofWorktreePath,
  bunConfigCandidates,
  bunConfigHookSlice,
  bunConfigLoadHook,
  bunConfigLoadHooks,
  bunConfigInspected,
  hookValuePaths,
  hookTargetChangedByBranch,
  pythonImportShadow,
  pythonModuleShadow,
  pythonPackageShadow,
  pytestConfigShadow,
  resolveMergeHeadSha,
  runMutationProofGate,
  spawnGuardCommand,
  type MutationClaim,
  type MutationEvidence,
  type MutationGateInput,
  type ProverFs,
} from './mutation-prover.ts'

/**
 * THE POST-APPROVE MUTATION PROVER.
 *
 * The property under test is narrow and load-bearing: an evidence block exists
 * ONLY because a mutation ran, and `proved` is true ONLY because the guard was
 * WATCHED going red and then green. Everything else here is a way of trying to
 * get a `proved:true` past the gate WITHOUT running one — a hand-written block,
 * a placeholder digest, a block from another prover, an edited real block — and
 * asserting that each is refused, with a reason that names what was wrong.
 */

const HEAD = 'a'.repeat(40)
const SRC_BEFORE = 'export const LIMIT = 10\nexport function under(n: number) { return n < LIMIT }\n'

const CLAIM: MutationClaim = {
  file: 'src/limit.ts',
  find: 'n < LIMIT',
  replace: 'true',
  guard: ['bun', 'test', 'src/limit.test.ts'],
  control: ['bun', 'test', 'src/other.test.ts'],
  rationale: 'the PR relies on the bound actually being applied',
}

const RUN = { id: 'run-1', slug: 'add-limit', repo_path: '/repo', branch: 'feat-x' }

/** The prover's reap grace, capped by whatever budget was left (see `observe`). */
const KILL_GRACE_CEILING = 5_000

function res(exit: number, stdout = ''): HostCommandResult {
  return { ok: exit === 0, stdout, stderr: '', exit_code: exit }
}

/**
 * `git diff -z --name-status` output for a NUL-joined path list: every path
 * MODIFIED unless it is named in `deleted`.
 *
 * The reader asks git for STATUS, not just names — partly for the deletions,
 * partly because the leading status letter is what keeps `run_host`'s
 * whole-stdout `.trim()` off the first path. Tests still spell the thing they
 * care about (the paths) and this puts the record shape around them.
 */
function nameStatus(files: string, deleted: readonly string[] = []): string {
  return files
    .split('\0')
    .filter((p) => p.length > 0)
    .map((p) => `${deleted.includes(p) ? 'D' : 'M'}\0${p}\0`)
    .join('')
}

/** The host seam TRIMS (`git-mode.ts:run_host` returns `stdout.trim()`), and
 *  the reader must survive that — so every mocked diff answer goes through it. */
function diffRes(stdout: string): HostCommandResult {
  return res(0, stdout.trim())
}

/** An in-memory worktree: one file, plus a record of every write. */
function memFs(initial: Record<string, string>): ProverFs & { files: Record<string, string>; writes: string[] } {
  const files = { ...initial }
  const writes: string[] = []
  return {
    files,
    writes,
    async read(path) {
      const v = files[path]
      if (v === undefined) throw new Error(`ENOENT ${path}`)
      return v
    },
    async write(path, contents) {
      files[path] = contents
      writes.push(contents)
    },
  }
}

interface HostScript {
  /** guard exit code while the mutation is applied (RED = non-zero). */
  guardMutated?: number
  /** control exit code while the mutation is applied (GREEN = 0). */
  controlMutated?: number
  /** guard exit code after the restore (GREEN = 0). */
  guardRestored?: number
  /** `git worktree add` fails. */
  worktreeAddFails?: boolean
  /** `git rev-parse <branch>` fails. */
  headUnresolvable?: boolean
  /** stdout for the guard runs — identical strings make the two runs
   *  indistinguishable, which the prover treats as impossible. */
  guardMutatedOut?: string
  guardRestoredOut?: string
  /** paths `git ls-tree -r` reports for the pinned head. The prover derives the
   *  TOP LEVEL from these as each path's first segment, so a bare `pytest` here
   *  is a root entry and `tests/conftest.py` is one a directory down. */
  treePaths?: string[]
  /** `git ls-tree` fails — the provenance probe must fail CLOSED. */
  lsTreeFails?: boolean
  /** the merge base `git merge-base <base> <head>` reports; absent → it fails. */
  mergeBase?: string
  /** file text `git show <merge-base>:<path>` reports — what the BASE carried.
   *  A path absent here reads as "the base did not have this file". */
  baseFiles?: Record<string, string>
  /** what `git status --porcelain` reports in the proof worktree once the
   *  nominated commands have run. DEFAULT `''` — a clean tree — which is what
   *  keeps every pre-existing proved-true row in this file green. */
  statusPorcelain?: string
  /** `git status --porcelain` fails — the tracked-edit check must fail CLOSED. */
  statusFails?: boolean
  /** `git reset --hard <head>` fails — the re-provision must fail CLOSED. */
  resetFails?: boolean
  /** `git clean -fdx` fails — the re-provision must fail CLOSED. */
  cleanFails?: boolean
}

function scriptedHost(s: HostScript = {}): {
  run: (cmd: string[], cwd?: string) => Promise<HostCommandResult>
  calls: string[][]
} {
  const calls: string[][] = []
  let guardRuns = 0
  return {
    calls,
    async run(cmd) {
      calls.push(cmd)
      if (cmd.includes('rev-parse')) return s.headUnresolvable === true ? res(1) : res(0, `${HEAD}\n`)
      if (cmd.includes('worktree')) {
        if (cmd.includes('add') && s.worktreeAddFails === true) return res(1)
        return res(0)
      }
      // THE RE-PROVISION SEAM. Answered here, ahead of the guard/control
      // matches, so every pre-existing row in this file runs it: the default
      // porcelain is EMPTY, which is a clean tree, so no row that proved
      // before is refused now.
      if (cmd.includes('status')) return s.statusFails === true ? res(1) : res(0, s.statusPorcelain ?? '')
      if (cmd.includes('reset')) return s.resetFails === true ? res(1) : res(0)
      if (cmd.includes('clean')) return s.cleanFails === true ? res(1) : res(0)
      if (cmd.includes('ls-tree')) return s.lsTreeFails === true ? res(1) : res(0, (s.treePaths ?? []).join('\0'))
      if (cmd.includes('merge-base')) return s.mergeBase === undefined ? res(1) : res(0, `${s.mergeBase}\n`)
      if (cmd.includes('show')) {
        const spec = cmd[cmd.length - 1] ?? ''
        const path = spec.slice(spec.indexOf(':') + 1)
        const text = (s.baseFiles ?? {})[path]
        return text === undefined ? res(128) : res(0, text)
      }
      if (cmd.join(' ') === CLAIM.guard.join(' ')) {
        guardRuns += 1
        return guardRuns === 1
          ? res(s.guardMutated ?? 1, s.guardMutatedOut ?? '1 fail, 3 pass')
          : res(s.guardRestored ?? 0, s.guardRestoredOut ?? '4 pass')
      }
      if (cmd.join(' ') === CLAIM.control.join(' ')) return res(s.controlMutated ?? 0, '9 pass')
      return res(0)
    },
  }
}

function proverOver(script: HostScript = {}, fs = memFs({ [join('/repo/.trident-worktrees/proof-add-limit-run-1', CLAIM.file)]: SRC_BEFORE })) {
  const host = scriptedHost(script)
  return { prover: createMutationProver({ run_host: host.run, fs }), host, fs }
}

describe('the prover RUNS the mutation and reports what it saw', () => {
  test('mutation applied, guard RED, control GREEN, restored, guard GREEN → proved', async () => {
    const { prover, fs, host } = proverOver()
    const evidence = await prover.prove({ run: RUN, claim: CLAIM })

    expect(evidence.proved).toBe(true)
    expect(prover.verify(evidence).ok).toBe(true)
    expect(evidence.schema).toBe(MUTATION_PROOF_SCHEMA)
    expect(evidence.prover_version).toBe(MUTATION_PROVER_VERSION)

    // The observations are what it WATCHED, not what anyone said.
    const o = evidence.observed
    expect(o).not.toBeNull()
    expect(o?.head_sha).toBe(HEAD)
    expect(o?.guard_mutated.exit_code).toBe(1)
    expect(o?.control_mutated.exit_code).toBe(0)
    expect(o?.guard_restored.exit_code).toBe(0)
    expect(o?.file_sha256_before).toBe(createHash('sha256').update(SRC_BEFORE, 'utf8').digest('hex'))
    expect(o?.file_sha256_mutated).not.toBe(o?.file_sha256_before)
    expect(o?.file_sha256_restored).toBe(o?.file_sha256_before)

    // The mutation REALLY hit the file: the first write is the broken source.
    expect(fs.writes[0]).toContain('return true')
    expect(fs.writes[0]).not.toContain('n < LIMIT')
    // …and the file is left exactly as it was found.
    expect(fs.files[join('/repo/.trident-worktrees/proof-add-limit-run-1', CLAIM.file)]).toBe(SRC_BEFORE)

    // It ran in a THROWAWAY worktree detached at the head — never the checkout.
    const joined = host.calls.map((c) => c.join(' '))
    expect(joined.some((c) => c.includes(`worktree add --detach --force ${proofWorktreePath('/repo', RUN)} ${HEAD}`))).toBe(true)
    // TWO removes and ONE add: a stale tree is cleared, the proof tree is
    // provisioned, and the outer `finally` removes it again. The RE-PROVISION
    // between the control and the restored guard is a `reset --hard` plus a
    // `clean -fdx` INSIDE that same tree, not a second add — see the ordering
    // row in "the restored-guard observation is of a tree the nominated
    // commands did not edit".
    expect(joined.filter((c) => c.includes('worktree remove')).length).toBe(2)
    expect(joined.filter((c) => c.includes('worktree add --detach --force')).length).toBe(1)
  })

  test('the guard that stays GREEN under the mutation is not a guard → not proved', async () => {
    const { prover } = proverOver({ guardMutated: 0, guardMutatedOut: '4 pass' })
    const evidence = await prover.prove({ run: RUN, claim: CLAIM })
    expect(evidence.proved).toBe(false)
    expect(evidence.reason).toContain('PASSED under the mutation')
    // Even the prover's OWN block does not verify when it is not proved.
    expect(prover.verify(evidence).ok).toBe(false)
  })

  test('a mutation that reddens the control too broke more than the behaviour → not proved', async () => {
    const { prover } = proverOver({ controlMutated: 1 })
    const evidence = await prover.prove({ run: RUN, claim: CLAIM })
    expect(evidence.proved).toBe(false)
    expect(evidence.reason).toContain('control did not stay GREEN')
  })

  test('a guard that never comes back GREEN after the restore → not proved (no red-then-green)', async () => {
    const { prover } = proverOver({ guardRestored: 2 })
    const evidence = await prover.prove({ run: RUN, claim: CLAIM })
    expect(evidence.proved).toBe(false)
    expect(evidence.reason).toContain('did not return to GREEN')
  })

  test('byte-identical RED and GREEN output cannot be two runs → not proved', async () => {
    const { prover } = proverOver({ guardMutatedOut: 'same', guardRestoredOut: 'same' })
    const evidence = await prover.prove({ run: RUN, claim: CLAIM })
    expect(evidence.proved).toBe(false)
    expect(evidence.reason).toContain('byte-identical')
  })

  test('a guard that hangs past the ceiling is NOT an observation of success', async () => {
    const fs = memFs({ [join(proofWorktreePath('/repo', RUN), CLAIM.file)]: SRC_BEFORE })
    const prover = createMutationProver({
      run_host: async (cmd) => {
        if (cmd.includes('rev-parse')) return res(0, HEAD)
        if (cmd.includes('worktree')) return res(0)
        // The host git ops of the re-provision seam answer normally — this row
        // is about a NOMINATED command that hangs, not about git.
        if (cmd.includes('status') || cmd.includes('reset') || cmd.includes('clean')) return res(0)
        // The guard never resolves.
        return new Promise<HostCommandResult>(() => {})
      },
      fs,
      proof_budget_ms: 5,
      // Fire the timeout immediately rather than waiting on the wall clock.
      set_timer: (fn) => {
        queueMicrotask(fn)
        return 0
      },
      clear_timer: () => {},
    })
    const evidence = await prover.prove({ run: RUN, claim: CLAIM })
    expect(evidence.proved).toBe(false)
    expect(evidence.reason).toContain('timed out')
    expect(evidence.observed?.guard_mutated.timed_out).toBe(true)
  })

  test('a command that outruns the budget is KILLED, and the budget covers the WHOLE proof', async () => {
    // Two bugs in one test. (1) A timed-out command used to be merely abandoned
    // by `Promise.race` — still running, still writing, while the worktree was
    // force-removed underneath it. (2) The ceiling was per-command, so a 15-minute
    // limit was really a 45-minute stall of the single-flight tick loop.
    const fs = memFs({ [join(proofWorktreePath('/repo', RUN), CLAIM.file)]: SRC_BEFORE })
    const aborted: string[][] = []
    const started: string[][] = []
    let clock = 0
    let seq = 0
    const cancelled = new Set<number>()
    const prover = createMutationProver({
      run_host: async (cmd) => (cmd.includes('rev-parse') ? res(0, HEAD) : res(0)),
      run_guard: (argv, _cwd, signal) => {
        started.push(argv)
        return new Promise<HostCommandResult>((resolve) => {
          signal.addEventListener('abort', () => {
            aborted.push(argv)
            resolve({ ok: false, stdout: '', stderr: 'killed', exit_code: -1 })
          })
        })
      },
      fs,
      proof_budget_ms: 1_000,
      now: () => clock,
      // A fake clock: firing a timer advances the clock by exactly its delay, so
      // `clock` at the end is the wall time this proof would have burned.
      set_timer: (fn, ms) => {
        const id = ++seq
        queueMicrotask(() => {
          if (cancelled.has(id)) return
          clock += ms
          fn()
        })
        return id
      },
      clear_timer: (h) => void cancelled.add(h as number),
    })

    const evidence = await prover.prove({ run: RUN, claim: CLAIM })
    expect(evidence.proved).toBe(false)
    expect(evidence.reason).toContain('timed out')
    // IT WAS KILLED, not abandoned.
    expect(aborted).toEqual([CLAIM.guard])
    // And the budget was spent ONCE. Only the guard was ever spawned: with a
    // fresh per-command ceiling the control and the restored guard would each
    // have started and burned another full ceiling (3× the stated limit).
    expect(started).toEqual([CLAIM.guard])
    expect(evidence.observed?.guard_restored.timed_out).toBe(true)
    // Wall clock: the budget, plus at most one bounded reap of the killed process.
    expect(clock).toBeLessThanOrEqual(1_000 + KILL_GRACE_CEILING)
    expect(evidence.observed?.control_mutated.timed_out).toBe(true)
  })

  test('spawnGuardCommand really kills the process it gave up on', async () => {
    // The kill seam against a REAL process, asserted on the DISCRIMINANT rather
    // than on elapsed time: 137 is 128+SIGKILL, which only a killed process
    // reports. A `sleep 30` that was merely abandoned exits 0 — and would blow
    // this test's own timeout long before it got the chance.
    const controller = new AbortController()
    const running = spawnGuardCommand(['sleep', '30'], process.cwd(), controller.signal)
    controller.abort()
    const out = await running
    expect(out.ok).toBe(false)
    expect(out.exit_code).toBe(137)
  })

  test('the file is restored even when the guard did NOT go red', async () => {
    const path = join(proofWorktreePath('/repo', RUN), CLAIM.file)
    const fs = memFs({ [path]: SRC_BEFORE })
    const host = scriptedHost({ guardMutated: 0 })
    const prover = createMutationProver({ run_host: host.run, fs })
    await prover.prove({ run: RUN, claim: CLAIM })
    expect(fs.files[path]).toBe(SRC_BEFORE)
  })
})

describe('the restored-guard observation is of a tree the nominated commands did not edit', () => {
  // THE FOURTEENTH ESCAPE, and the first that needed no argv trick at all. The
  // guard and the control are branch-authored code that RUNS between the
  // guard's RED and its GREEN, and restoring `claim.file` restores one file,
  // not the tree — so a committed unconditionally-red guard plus a control
  // whose module body writeFileSync's it green came back `proved: true` with
  // nothing having tested the target. The seam answers in three steps, each
  // failing CLOSED: refuse a TRACKED edit by name, then re-provision
  // (`reset --hard` to the pinned head plus `clean -fdx`) so untracked plants
  // cannot reach the observation either, and only then observe the restored
  // guard. The end-to-end forgeries live in mutation-prover-realgit.test.ts;
  // these rows pin the mechanism.
  const guardRunsIn = (host: { calls: string[][] }): number =>
    host.calls.filter((c) => c.join(' ') === CLAIM.guard.join(' ')).length

  test('a TRACKED edit is refused BY NAME — before the restored guard is ever spawned', async () => {
    // THE REPRO, at unit scale. Note the default `statusPorcelain` is `''`:
    // every other row in this file runs this same seam against a clean tree
    // and still proves, which is the positive control against an arm that
    // fires on everything. And the shape is RUNNER-AGNOSTIC — a control
    // spelled `make check` reaches this identical porcelain read, so there is
    // nothing a wrapper row would add at unit level.
    const { prover, host } = proverOver({ statusPorcelain: ' M tests/g.test.ts\n' })
    const evidence = await prover.prove({ run: RUN, claim: CLAIM })
    expect(evidence.proved).toBe(false)
    expect(evidence.observed).toBeNull()
    expect(evidence.reason).toContain('edited the proof worktree')
    expect(evidence.reason).toContain('tests/g.test.ts')
    // The refusal PRECEDES the second observation: the guard ran once, under
    // the mutation, and nothing was measured against the dirty tree.
    expect(guardRunsIn(host)).toBe(1)
  })

  test('UNTRACKED runner caches are tolerated, and the re-provision is ordered before the second guard run', async () => {
    // An honest runner drops caches beside its tests. Refusing those would
    // delete the nomination from any repo whose runner writes one, so they are
    // tolerated in step (1) and NEUTRALISED in step (2) — which is why the
    // ordering below is the load-bearing part, not the exit code.
    const { prover, host } = proverOver({ statusPorcelain: '?? .pytest_cache/\n?? node_modules/\n' })
    const evidence = await prover.prove({ run: RUN, claim: CLAIM })
    expect(evidence.proved).toBe(true)
    const joined = host.calls.map((c) => c.join(' '))
    const resetIdx = joined.findIndex((c) => c.includes('reset --hard'))
    const cleanIdx = joined.findIndex((c) => c.includes('clean -fdx'))
    // POSITIVE CONTROL on the extraction: a missing call is -1, which would
    // satisfy every "less than" comparison below by vacuity.
    expect([resetIdx >= 0, cleanIdx >= 0]).toEqual([true, true])
    const secondGuardIdx = joined.lastIndexOf(CLAIM.guard.join(' '))
    expect(secondGuardIdx).toBeGreaterThan(joined.indexOf(CLAIM.guard.join(' ')))
    expect(resetIdx).toBeLessThan(secondGuardIdx)
    expect(cleanIdx).toBeLessThan(secondGuardIdx)
  })

  test('a porcelain read that FAILS refuses — the tree may have been edited and we cannot tell', async () => {
    const { prover } = proverOver({ statusFails: true })
    const evidence = await prover.prove({ run: RUN, claim: CLAIM })
    expect(evidence.proved).toBe(false)
    expect(evidence.observed).toBeNull()
    expect(evidence.reason).toContain('could not inspect the proof worktree')
  })

  test('a `reset --hard` that FAILS refuses', async () => {
    const { prover } = proverOver({ resetFails: true })
    const evidence = await prover.prove({ run: RUN, claim: CLAIM })
    expect(evidence.proved).toBe(false)
    expect(evidence.observed).toBeNull()
    expect(evidence.reason).toContain('could not re-provision the proof worktree')
  })

  test('a `clean -fdx` that FAILS refuses', async () => {
    const { prover } = proverOver({ cleanFails: true })
    const evidence = await prover.prove({ run: RUN, claim: CLAIM })
    expect(evidence.proved).toBe(false)
    expect(evidence.observed).toBeNull()
    expect(evidence.reason).toContain('could not re-provision the proof worktree')
  })

  test('a thousand edited files are named WITHIN the budget, with the elision counted', async () => {
    // The porcelain is bounded only by the tree, and this reason reaches a log
    // line, a status post and a DB row. `namesWithinBudget` caps the names and
    // COUNTS what it dropped.
    const lines = Array.from({ length: 1000 }, (_, i) => ` M tests/support/generated/case-${i}.test.ts`)
    const { prover } = proverOver({ statusPorcelain: `${lines.join('\n')}\n` })
    const evidence = await prover.prove({ run: RUN, claim: CLAIM })
    expect(evidence.proved).toBe(false)
    expect(evidence.reason.length).toBeLessThan(4_100)
    expect(evidence.reason).toContain('tests/support/generated/case-0.test.ts')
    expect(evidence.reason).toContain('more')
  })
})

describe('a worktree that can SHADOW the -m module is not a test runner', () => {
  const PY_GUARD = ['python3', '-m', 'pytest', 'tests/unrelated_test.py']
  const PY_CONTROL = ['python3', '-m', 'unittest', 'tests/other_test.py']

  test('THE REPRO: a committed pytest/ entry means python3 -m pytest is BRANCH-SUPPLIED', async () => {
    const { prover, host } = proverOver({ treePaths: ['pytest', 'src', 'tests'] })
    const evidence = await prover.prove({
      run: RUN,
      claim: { ...CLAIM, guard: PY_GUARD, control: PY_CONTROL },
    })

    expect(evidence.proved).toBe(false)
    expect(evidence.observed).toBeNull()
    expect(evidence.reason).toContain('BRANCH-SUPPLIED')
    expect(evidence.reason).toContain('pytest')
    expect(evidence.reason).toContain('claim.guard')
    // The probe FIRED — a check that silently never runs proves nothing.
    expect(host.calls.some((c) => c.includes('ls-tree'))).toBe(true)
    // …and nothing was executed.
    expect(host.calls.every((c) => c[0] !== 'python3')).toBe(true)
  })

  const SHADOWING = ['pytest', 'pytest.py', 'pytest.pyc', 'pytest.so', 'pytest.cpython-312-x86_64-linux-gnu.so']
  for (const entry of SHADOWING) {
    test(`a top-level ${entry} shadows the module → refused`, async () => {
      const { prover } = proverOver({ treePaths: [entry] })
      const evidence = await prover.prove({ run: RUN, claim: { ...CLAIM, guard: PY_GUARD } })
      expect(evidence.proved).toBe(false)
      expect(evidence.observed).toBeNull()
      expect(evidence.reason).toContain('BRANCH-SUPPLIED')
      expect(evidence.reason).toContain(entry)
    })
  }

  // WHAT IS STILL LEGAL, and it is a SHORTER list than the round that wrote it
  // first claimed. `pytest.ini` and `conftest.py` were rows here asserting the
  // proof RUNS — they are now refused by `pytestConfigShadow` (pytest reads
  // both with nothing on the argv), and `mypytest.py` is refused by
  // `pythonImportShadow` (a top-level module file can shadow a dependency the
  // runner imports). A row that pins a residual as legal is a contract a later
  // round has to delete, so they are deleted here rather than kept.
  //
  // The last two rows are the OVER-REFUSAL GUARD: a python file and a test path
  // A DIRECTORY DOWN must stay legal, or no honest python repo could ever
  // nominate a guard at all.
  const LEGAL = ['pytest.json', 'pytest-fixtures', 'README.md', 'src/limit.py', 'tests/unrelated_test.py']
  for (const entry of LEGAL) {
    test(`a tree containing ${entry} does not supply the runner → the proof RUNS`, async () => {
      const { prover, host } = proverOver({ treePaths: [entry] })
      const evidence = await prover.prove({ run: RUN, claim: { ...CLAIM, guard: PY_GUARD } })
      // Not `proved` — the scripted host exits 0 for an unrecognised argv — but
      // the proof really ran, which is the property this row is defending.
      expect(evidence.observed).not.toBeNull()
      expect(evidence.reason).not.toContain('BRANCH-SUPPLIED')
      // POSITIVE CONTROL against an empty extraction: the probe DID fire here,
      // so "legal" means the check looked and found nothing, not that it slept.
      expect(host.calls.some((c) => c.includes('ls-tree'))).toBe(true)
    })
  }

  test('the CONTROL side is read too — a shadowed unittest is refused', async () => {
    const { prover } = proverOver({ treePaths: ['unittest'] })
    const evidence = await prover.prove({ run: RUN, claim: { ...CLAIM, control: PY_CONTROL } })
    expect(evidence.proved).toBe(false)
    expect(evidence.observed).toBeNull()
    expect(evidence.reason).toContain('claim.control')
    expect(evidence.reason).toContain('unittest')
  })

  // ── THE DEPENDENCY, not the module the argv names ────────────────────────
  //
  // The escape a review seat executed end-to-end against this branch: the
  // nominated module is the REAL runner, and the branch shadows something the
  // runner imports on its way up.
  test('THE REPRO: a committed argparse.py forges a proof through python3 -m unittest', async () => {
    const { prover, host } = proverOver({ treePaths: ['argparse.py', 'src/limit.py', 'tests/unrelated_test.py'] })
    const evidence = await prover.prove({
      run: RUN,
      claim: { ...CLAIM, guard: PY_CONTROL },
    })
    expect(evidence.proved).toBe(false)
    expect(evidence.observed).toBeNull()
    expect(evidence.reason).toContain('BRANCH-SUPPLIED')
    expect(evidence.reason).toContain('argparse.py')
    expect(evidence.reason).toContain('sys.path')
    // Nothing ran: the refusal is decided off the pinned tree alone.
    expect(host.calls.every((c) => c[0] !== 'python3')).toBe(true)
  })

  const DEPENDENCIES = ['argparse.py', 'unittest.pyc', 'socket.so']
  for (const entry of DEPENDENCIES) {
    test(`a top-level ${entry} can shadow a module the runner imports → refused`, async () => {
      const { prover } = proverOver({ treePaths: [entry, 'tests/unrelated_test.py'] })
      const evidence = await prover.prove({ run: RUN, claim: { ...CLAIM, guard: PY_GUARD } })
      expect(evidence.proved).toBe(false)
      expect(evidence.reason).toContain(entry)
    })
  }

  // ── THE PACKAGE: a top-level DIRECTORY the runner can import ─────────────
  //
  // The escape a review seat executed end-to-end against `7cfc3e07`: the module
  // the argv names is the real runner and no top-level *file* shadows anything,
  // but a committed `tests/__init__.py` whose body imports the target runs on
  // import all the same. Refused on the marker the directory CONTAINS.
  test('THE REPRO: a committed tests/__init__.py forges a proof through python3 -m unittest', async () => {
    const { prover, host } = proverOver({
      treePaths: ['src/limit.py', 'tests/__init__.py', 'tests/unrelated_test.py'],
    })
    const evidence = await prover.prove({ run: RUN, claim: { ...CLAIM, guard: PY_CONTROL } })
    expect(evidence.proved).toBe(false)
    expect(evidence.observed).toBeNull()
    expect(evidence.reason).toContain('BRANCH-SUPPLIED')
    expect(evidence.reason).toContain('tests/__init__.py')
    expect(evidence.reason).toContain('importable package')
    // Nothing ran: the refusal is decided off the pinned tree alone.
    expect(host.calls.every((c) => c[0] !== 'python3')).toBe(true)
  })

  const PACKAGES = ['tests/__init__.py', 'argparse/__init__.py', '_pytest/__main__.py', 'argparse/__init__.pyc', 'unittest/__init__.so']
  for (const entry of PACKAGES) {
    test(`a top-level package ${entry} executes on import → refused`, async () => {
      const { prover } = proverOver({ treePaths: ['src/limit.py', entry] })
      const evidence = await prover.prove({ run: RUN, claim: { ...CLAIM, guard: PY_GUARD } })
      expect(evidence.proved).toBe(false)
      expect(evidence.observed).toBeNull()
      expect(evidence.reason).toContain(entry)
    })
  }

  test('pythonPackageShadow — the predicate itself, both directions', () => {
    // THE `.pyc` ROW IS THE ESCAPE ITSELF, not a completeness flourish: a review
    // seat forged a full `proved: true` through this arm by committing
    // `argparse/__init__.pyc` with no `.py` beside it, because python imports a
    // directory holding only bytecode as a regular package all the same. The
    // marker matched source only, so the arm looked straight past it.
    for (const entry of PACKAGES) {
      expect([entry, pythonPackageShadow(PY_GUARD, ['src/limit.py', entry])]).toEqual([entry, entry])
    }
    // THE OVER-REFUSAL GUARD, and the reason this is a CONTENTS rule and not a
    // name rule: a plain `src/` and a plain `tests/` are what every honest
    // python repo has, a package marker A DIRECTORY DOWN is not on the one
    // `sys.path` entry `-m` adds, and `__init__.py` at the repo ROOT names no
    // directory at all.
    for (const entry of [
      'src/limit.py',
      'tests/unrelated_test.py',
      'src/pkg/__init__.py',
      'tests/support/__main__.py',
      '__init__.py',
      'tests/my__init__.py',
      // WINDOWS-ONLY SPELLINGS STAY OUT, matching the sibling arm this shares
      // its suffix list with: no host this prover runs on imports them.
      'tests/__init__.pyw',
      'tests/__init__.pyd',
      // Not a module at all — the marker is the module, not the stem.
      'tests/__init__.txt',
    ]) {
      expect([entry, pythonPackageShadow(PY_GUARD, [entry])]).toEqual([entry, null])
    }
    // Not a python -m argv at all.
    expect(pythonPackageShadow(['bun', 'test', 'x'], ['tests/__init__.py'])).toBeNull()
  })

  test('pythonImportShadow — the predicate itself, both directions', () => {
    for (const entry of DEPENDENCIES) {
      expect([entry, pythonImportShadow(PY_GUARD, [entry, 'src'])]).toEqual([entry, entry])
    }
    // A module file A DIRECTORY DOWN is not on the `-m` path entry, so the
    // top-level names the prover derives never contain it — and must not.
    expect(pythonImportShadow(PY_GUARD, ['src', 'tests', 'README.md'])).toBeNull()
    // Not a python -m argv at all.
    expect(pythonImportShadow(['bun', 'test', 'x'], ['argparse.py'])).toBeNull()
  })

  // ── THE CONFIG WITH NO FLAG ON THE ARGV ──────────────────────────────────
  const PYTEST_CONFIGS = ['conftest.py', 'tests/conftest.py', 'pytest.ini', 'tox.ini', 'setup.cfg', 'pyproject.toml']
  for (const entry of PYTEST_CONFIGS) {
    test(`a committed ${entry} changes what pytest runs with NO flag → refused`, async () => {
      const { prover, host } = proverOver({ treePaths: ['src', entry] })
      const evidence = await prover.prove({ run: RUN, claim: { ...CLAIM, guard: PY_GUARD } })
      expect(evidence.proved).toBe(false)
      expect(evidence.observed).toBeNull()
      expect(evidence.reason).toContain(entry)
      expect(evidence.reason).toContain('nothing on the argv')
      expect(host.calls.every((c) => c[0] !== 'python3')).toBe(true)
    })
  }

  test('unittest reads none of them — a conftest.py does not refuse a unittest nomination', async () => {
    const { prover, host } = proverOver({ treePaths: ['src', 'tests/conftest.py'] })
    const evidence = await prover.prove({ run: RUN, claim: { ...CLAIM, guard: PY_CONTROL } })
    expect(evidence.observed).not.toBeNull()
    expect(evidence.reason).not.toContain('conftest')
    // POSITIVE CONTROL: the probe fired and found the file — it just does not
    // apply to this runner. Without this the row would pass on an empty listing.
    expect(host.calls.some((c) => c.includes('ls-tree'))).toBe(true)
    expect(pytestConfigShadow(PY_CONTROL, ['tests/conftest.py'])).toBeNull()
  })

  test('an ABI-TAGGED __init__ is an __init__ — the tagged extension spellings python imports', () => {
    // `importlib.machinery.EXTENSION_SUFFIXES` carries `.abi3.so` and
    // `.cpython-<ver>-<platform>.so` beside the bare `.so`, so each of these
    // makes its directory a REGULAR package whose body runs on import. The file
    // half of the same question (`pythonModuleShadow`) already matched the
    // tagged spelling; the directory half did not.
    for (const marker of [
      'argparse/__init__.abi3.so',
      'argparse/__init__.cpython-311-x86_64-linux-gnu.so',
      'tests/__main__.abi3.so',
    ]) {
      expect([marker, pythonPackageShadow(PY_GUARD, ['src/limit.py', marker])]).toEqual([marker, marker])
    }
    // THE CONTROL on that table: a plain directory, a tagged object that is not
    // an `__init__`, and a marker a directory further down are all still legal.
    for (const path of ['argparse/helpers.abi3.so', 'src/pkg/__init__.abi3.so', 'tests/support.py']) {
      expect([path, pythonPackageShadow(PY_GUARD, [path])]).toEqual([path, null])
    }
  })

  test('pytestConfigShadow — the predicate itself, both directions', () => {
    for (const entry of PYTEST_CONFIGS) {
      expect([entry, pytestConfigShadow(PY_GUARD, ['src/limit.py', entry])]).toEqual([entry, entry])
    }
    for (const entry of ['tests/conftest_helpers.py', 'docs/pyproject.toml.md', 'setup.py', 'pytest.json']) {
      expect([entry, pytestConfigShadow(PY_GUARD, [entry])]).toEqual([entry, null])
    }
  })

  // ── THE CONFIG BUN READS WITH NOTHING ON THE ARGV ────────────────────────
  //
  // The same escape as the pytest one, one runner over — and the runner this
  // repository actually uses, so the NARROWING matters as much as the refusal:
  // a tree-wide reading would refuse EVERY `bun test` nomination in any repo
  // that ships a `bunfig.toml` (this one does, with a `[test] preload`), which
  // is the "no legal nomination exists" defect this whole card is about.
  const BUN_WT = proofWorktreePath('/repo', RUN)
  const BUNFIG_WITH_PRELOAD = '[test]\npreload = ["./tests/support/scrub.ts"]\n'
  // ONE KEY, AND THE SPELLINGS A TOML PARSER READS AS IDENTICAL. A review seat
  // ran each of these end to end against the bare-key defence that shipped and
  // got `ok: true, proved: true` out of every one but the first.
  const BUNFIG_PRELOAD_SPELLINGS: Record<string, string> = {
    bare: '[test]\npreload = ["./src/limit.ts"]\n',
    quoted: '[test]\n"preload" = ["./src/limit.ts"]\n',
    'single-quoted': "[test]\n'preload' = ['./src/limit.ts']\n",
    dotted: 'test.preload = ["./src/limit.ts"]\n',
    'dotted with a quoted leaf': 'test."preload" = ["./src/limit.ts"]\n',
    'inline table': 'test = { preload = ["./src/limit.ts"] }\n',
    'tab-indented, unspaced': '[test]\n\tpreload=["./src/limit.ts"]\n',
    'unicode-escaped key': '[test]\n"p\\u0072eload" = ["./src/limit.ts"]\n',
  }
  const PACKAGE_JSON_WITH_IMPORTS = '{\n  "imports": { "#lib": "./src/limit.ts" }\n}\n'
  const TSCONFIG_WITH_PATHS = '{\n  "compilerOptions": {\n    "paths": { "@x/*": ["./src/*"] }\n  }\n}\n'

  function bunFs(files: Record<string, string>) {
    return memFs({ [join(BUN_WT, CLAIM.file)]: SRC_BEFORE, ...files })
  }

  test('a bunfig.toml THIS BRANCH writes preloads code into every bun test → refused', async () => {
    // THE REPRO, as two seats ran it: commit a root bunfig whose `[test]
    // preload` names the mutated file (or one that imports it), nominate an
    // unrelated `bun test` as the guard, and the guard reddens under the
    // mutation with nothing having asserted the target.
    const { prover, host } = proverOver({}, bunFs({ [join(BUN_WT, 'bunfig.toml')]: BUNFIG_WITH_PRELOAD }))
    const evidence = await prover.prove({ run: RUN, claim: CLAIM, changed_files: ['src/limit.ts', 'bunfig.toml'] })
    expect(evidence.proved).toBe(false)
    expect(evidence.observed).toBeNull()
    expect(evidence.reason).toContain('bunfig.toml')
    expect(evidence.reason).toContain('BRANCH-SUPPLIED')
    expect(evidence.reason).toContain('preload')
    // Nothing ran: the refusal is decided before a byte is mutated.
    expect(host.calls.every((c) => c[0] !== 'bun')).toBe(true)
  })

  test('EVERY SPELLING of the preload key is the same key — the bare-key rule saw one of eight', () => {
    for (const [spelling, body] of Object.entries(BUNFIG_PRELOAD_SPELLINGS)) {
      expect([spelling, bunConfigLoadHook('bunfig.toml', body)]).toEqual([spelling, 'preload'])
    }
    // THE POSITIVE CONTROL on that table: it must not be passing because the
    // rule refuses every bunfig outright. A key that merely CONTAINS the word
    // is a different key, and `[loader]` is the branch-authored config that
    // decides nothing about which code loads.
    for (const body of ['[loader]\n".png" = "file"\n', '[test]\nmypreload = ["./x.ts"]\n', '[test]\npreloader = 1\n']) {
      expect([body, bunConfigLoadHook('bunfig.toml', body)]).toEqual([body, null])
    }
  })

  test('each preload spelling refuses the bun guard END TO END, not just in the predicate', async () => {
    for (const [spelling, body] of Object.entries(BUNFIG_PRELOAD_SPELLINGS)) {
      const { prover } = proverOver({}, bunFs({ [join(BUN_WT, 'bunfig.toml')]: body }))
      const evidence = await prover.prove({ run: RUN, claim: CLAIM, changed_files: ['src/limit.ts', 'bunfig.toml'] })
      expect([spelling, evidence.proved]).toEqual([spelling, false])
      expect(evidence.reason).toContain('BRANCH-SUPPLIED')
    }
  })

  test('a package.json THIS BRANCH writes can redirect a bare specifier inside MAIN\'s guard file → refused', async () => {
    // THE SECOND SEAT'S REPRO. `imports` is a resolution map like a tsconfig's
    // `paths`, and this basename was excluded from the candidates entirely, so
    // a branch could point `#lib` inside a guard file main already carried
    // straight at the mutated module with nothing on the argv to show for it.
    const { prover, host } = proverOver({}, bunFs({ [join(BUN_WT, 'package.json')]: PACKAGE_JSON_WITH_IMPORTS }))
    const evidence = await prover.prove({ run: RUN, claim: CLAIM, changed_files: ['src/limit.ts', 'package.json'] })
    expect(evidence.proved).toBe(false)
    expect(evidence.reason).toContain('package.json')
    expect(evidence.reason).toContain('imports')
    expect(host.calls.every((c) => c[0] !== 'bun')).toBe(true)
  })

  test('a package.json with no resolution map keeps its bun nomination — the control on that arm', async () => {
    // Without this row the assertion above would pass just as happily on a gate
    // that refused a bun guard for every dependency bump in the diff.
    const { prover } = proverOver(
      {},
      bunFs({ [join(BUN_WT, 'package.json')]: '{\n  "name": "x",\n  "dependencies": { "zod": "^3" }\n}\n' }),
    )
    const evidence = await prover.prove({ run: RUN, claim: CLAIM, changed_files: ['src/limit.ts', 'package.json'] })
    expect(evidence.reason).not.toContain('package.json')
    expect(evidence.proved).toBe(true)
  })

  // ── THE KEY'S VALUE, NOT THE FILE'S PRESENCE IN THE DIFF ─────────────────
  //
  // A review seat drove this repository's OWN workspace manifests through the
  // gate: they carry an `exports` map main wrote, so a PR that bumps a
  // dependency in one of them lost `bun test` — in a bun-only repo, its only
  // nomination. That is the "no legal nomination exists" defect this card
  // exists to fix, re-created by the fix, and the escape hatch the code
  // documented ("land the manifest change on its own commit") does not exist:
  // the diff is read over the whole range `<base>...<ref>`.
  const PKG_BASE_EXPORTS =
    '{\n  "name": "x",\n  "dependencies": { "zod": "^3" },\n  "exports": { ".": "./src/index.ts" }\n}\n'
  const MERGE_BASE = 'b'.repeat(40)

  test('a dependency bump beside a map MAIN wrote keeps its bun nomination — the key is compared, not the file', async () => {
    // THE BLOCKER, reproduced: the manifest IS in the diff and the `exports`
    // key IS present at the head, and the only thing this branch changed inside
    // it is a version range. Reformatted at the head too, so what is compared
    // is the VALUE and not the bytes around it.
    const head =
      '{\n  "name": "x",\n  "dependencies": { "zod": "^4" },\n  "exports": {\n    ".": "./src/index.ts"\n  }\n}\n'
    const { prover } = proverOver(
      { mergeBase: MERGE_BASE, baseFiles: { 'package.json': PKG_BASE_EXPORTS } },
      bunFs({ [join(BUN_WT, 'package.json')]: head }),
    )
    const evidence = await prover.prove({
      run: RUN,
      claim: CLAIM,
      changed_files: ['src/limit.ts', 'package.json'],
      base_ref: 'main',
    })
    expect(evidence.reason).not.toContain('package.json')
    expect(evidence.proved).toBe(true)
  })

  test('…and EDITING that same map is still refused — the load-bearing control on the comparison', async () => {
    // Without this row the row above would pass just as happily on a gate that
    // stopped reading package.json altogether. Same file, same base, same
    // claim: only the map's VALUE differs.
    const head = '{\n  "name": "x",\n  "dependencies": { "zod": "^3" },\n  "exports": { ".": "./src/limit.ts" }\n}\n'
    const { prover, host } = proverOver(
      { mergeBase: MERGE_BASE, baseFiles: { 'package.json': PKG_BASE_EXPORTS } },
      bunFs({ [join(BUN_WT, 'package.json')]: head }),
    )
    const evidence = await prover.prove({
      run: RUN,
      claim: CLAIM,
      changed_files: ['src/limit.ts', 'package.json'],
      base_ref: 'main',
    })
    expect(evidence.proved).toBe(false)
    expect(evidence.reason).toContain('package.json')
    expect(evidence.reason).toContain('exports')
    expect(host.calls.every((c) => c[0] !== 'bun')).toBe(true)
  })

  test('an INHERITED imports map does not shelter a map the branch wrote beside it', async () => {
    // The single-key reading answered `imports` — main's — and never looked at
    // the `exports` map this branch rewrote one line down.
    const base = '{\n  "imports": { "#lib": "./src/index.ts" },\n  "exports": { ".": "./src/index.ts" }\n}\n'
    const head = '{\n  "imports": { "#lib": "./src/index.ts" },\n  "exports": { ".": "./src/limit.ts" }\n}\n'
    const { prover } = proverOver(
      { mergeBase: MERGE_BASE, baseFiles: { 'package.json': base } },
      bunFs({ [join(BUN_WT, 'package.json')]: head }),
    )
    const evidence = await prover.prove({
      run: RUN,
      claim: CLAIM,
      changed_files: ['src/limit.ts', 'package.json'],
      base_ref: 'main',
    })
    expect(evidence.proved).toBe(false)
    expect(evidence.reason).toContain('exports')
  })

  test('the comparison fails CLOSED — no base, no merge base, and no such file THERE all refuse', async () => {
    const head = '{\n  "exports": { ".": "./src/index.ts" }\n}\n'
    const cases: Array<[string, HostScript, string | undefined]> = [
      ['no base_ref at all', { mergeBase: MERGE_BASE, baseFiles: { 'package.json': head } }, undefined],
      ['merge-base fails', { baseFiles: { 'package.json': head } }, 'main'],
      ['the file is new on this branch', { mergeBase: MERGE_BASE, baseFiles: {} }, 'main'],
    ]
    for (const [label, script, baseRef] of cases) {
      const { prover } = proverOver(script, bunFs({ [join(BUN_WT, 'package.json')]: head }))
      const evidence = await prover.prove({
        run: RUN,
        claim: CLAIM,
        changed_files: ['src/limit.ts', 'package.json'],
        ...(baseRef === undefined ? {} : { base_ref: baseRef }),
      })
      expect([label, evidence.proved]).toEqual([label, false])
      expect([label, (evidence.reason ?? '').includes('exports')]).toEqual([label, true])
    }
  })

  test('bunConfigHookSlice — a reformat is not a change, an edit is, and an unterminated value reads null', () => {
    const a = '{ "exports": { ".": "./src/index.ts" } }'
    const b = '{\n  "exports": {\n    ".": "./src/index.ts"\n  }\n}\n'
    expect(bunConfigHookSlice(a, 'exports')).toBe(bunConfigHookSlice(b, 'exports') as string)
    expect(bunConfigHookSlice(a, 'exports')).not.toBe(
      bunConfigHookSlice('{ "exports": { ".": "./src/limit.ts" } }', 'exports') as string,
    )
    // EVERY OCCURRENCE, so a second spelling of the key deeper in the file is
    // not invisible to the comparison.
    expect(bunConfigHookSlice('{ "exports": { "a": 1 }, "x": { "exports": { "b": 2 } } }', 'exports')).toContain('"b"')
    // The TOML side, read through the same escape decoding the key rule uses.
    expect(bunConfigHookSlice('[test]\npreload = ["./a.ts"]\n', 'preload')).toBe('["./a.ts"]')
    expect(bunConfigHookSlice('[test]\n"p\\u0072eload" = ["./a.ts"]\n', 'preload')).toBe('["./a.ts"]')
    // THE DELIMITER IS LOOKED AT, NOT CONSUMED. Under an alternation that eats
    // the character before the key, two occurrences sharing one character
    // cannot both match — and a missed occurrence makes the head and base
    // slices differ, which refuses. A lookbehind finds both.
    expect(bunConfigHookSlice('[test]\npreload=preload=["./b.ts"]\n', 'preload')).toContain(' | ')
    // FAILS CLOSED: unreadable, absent, or a key this seam does not know.
    expect(bunConfigHookSlice('{ "exports": { ".": "./x.ts"', 'exports')).toBeNull()
    expect(bunConfigHookSlice('{ "name": "x" }', 'exports')).toBeNull()
    expect(bunConfigHookSlice('{ "exports": {} }', 'not-a-hook-key')).toBeNull()
  })

  // ── AND NODE RESOLVES THE SAME MAP ───────────────────────────────────────
  //
  // Two seats forged `ok:true, proved:true` under `node --test` with the very
  // package.json `imports` forgery `bun test` was refusing, because this whole
  // arm was gated on `argv[0] === 'bun'`.
  const NODE_CLAIM: MutationClaim = {
    ...CLAIM,
    guard: ['node', '--test', 'tests/limit.test.mjs'],
    control: ['node', '--test', 'tests/other.test.mjs'],
  }

  test('a package.json map THIS BRANCH writes refuses a `node --test` nomination too', async () => {
    const { prover, host } = proverOver({}, bunFs({ [join(BUN_WT, 'package.json')]: PACKAGE_JSON_WITH_IMPORTS }))
    const evidence = await prover.prove({
      run: RUN,
      claim: NODE_CLAIM,
      changed_files: ['src/limit.ts', 'package.json'],
      base_ref: 'main',
    })
    expect(evidence.proved).toBe(false)
    expect(evidence.observed).toBeNull()
    expect(evidence.reason).toContain('package.json')
    expect(evidence.reason).toContain('imports')
    expect(host.calls.every((c) => c[0] !== 'node')).toBe(true)
  })

  test('…and `main` is the third key on the NODE side too — the boundary the contract now states', async () => {
    // THE ENFORCEMENT/CONTRACT GAP a seat found: `MANIFEST_HOOK_KEY` carries
    // three keys and applies to node nominations, while the forge contract said
    // only `imports`/`exports` refuse `node --test`. Both `main` tests were bun
    // guards, so nothing pinned this side and the wording could drift back
    // without a red. It refuses — with no `exports` map present node's CJS
    // resolver falls back to `main`, which is how the key entered this list.
    const { prover, host } = proverOver(
      {},
      bunFs({ [join(BUN_WT, 'package.json')]: '{\n  "main": "./src/limit.ts"\n}\n' }),
    )
    const evidence = await prover.prove({
      run: RUN,
      claim: NODE_CLAIM,
      changed_files: ['src/limit.ts', 'package.json'],
      base_ref: 'main',
    })
    expect(evidence.proved).toBe(false)
    expect(evidence.observed).toBeNull()
    expect(evidence.reason).toContain('the main in package.json')
    expect(host.calls.every((c) => c[0] !== 'node')).toBe(true)

    // POSITIVE CONTROL: a `main` the BASE already carried costs the same node
    // nomination nothing — otherwise this arm would refuse every published
    // manifest and the row above would pass for the wrong reason.
    const inherited = proverOver(
      { mergeBase: 'b'.repeat(40), baseFiles: { 'package.json': '{\n  "main": "./src/limit.ts"\n}\n' } },
      bunFs({ [join(BUN_WT, 'package.json')]: '{\n  "main": "./src/limit.ts",\n  "version": "2.0.0"\n}\n' }),
    )
    const kept = await inherited.prover.prove({
      run: RUN,
      claim: NODE_CLAIM,
      changed_files: ['src/limit.ts', 'package.json'],
      base_ref: 'main',
    })
    // A non-null `observed` is the proof it got PAST this arm and the runner
    // actually ran (the scripted host answers only the bun argv, so the node
    // guard's own exit codes say nothing here — see the bunfig row below).
    expect(kept.reason).not.toContain('the main in package.json')
    expect(kept.observed).not.toBeNull()
  })

  test("…but a bunfig and a tsconfig are BUN's alone — node reads neither, so neither refuses it", async () => {
    // THE POSITIVE CONTROL on the row above: admitting node must not admit the
    // two files node does not read. A non-null `observed` is the proof the
    // claim got past this arm and the runner actually ran.
    const { prover } = proverOver(
      {},
      bunFs({
        [join(BUN_WT, 'bunfig.toml')]: BUNFIG_WITH_PRELOAD,
        [join(BUN_WT, 'tsconfig.json')]: TSCONFIG_WITH_PATHS,
      }),
    )
    const evidence = await prover.prove({
      run: RUN,
      claim: NODE_CLAIM,
      changed_files: ['src/limit.ts', 'bunfig.toml', 'tsconfig.json'],
      base_ref: 'main',
    })
    expect(evidence.reason ?? '').not.toContain('BRANCH-SUPPLIED')
    expect(evidence.observed).not.toBeNull()
  })

  test('a tsconfig.json THIS BRANCH writes can point a bare import at the mutated file → refused', async () => {
    const { prover } = proverOver({}, bunFs({ [join(BUN_WT, 'tsconfig.json')]: TSCONFIG_WITH_PATHS }))
    const evidence = await prover.prove({ run: RUN, claim: CLAIM, changed_files: ['src/limit.ts', 'tsconfig.json'] })
    expect(evidence.proved).toBe(false)
    expect(evidence.reason).toContain('tsconfig.json')
    expect(evidence.reason).toContain('compilerOptions.paths')
  })

  test("THE NARROWING IS REAL: the repo's OWN bunfig, untouched by the diff, still leaves bun nominatable", async () => {
    // THE LOAD-BEARING POSITIVE CONTROL. `bunfig.toml` is on disk in the proof
    // worktree with a `preload` in it — the identical file the refusal above
    // fires on — and the ONLY difference is that this branch did not write it.
    // Refusing it would delete `bun test` from the shapes for a bun-only repo
    // and leave no nominatable guard at all.
    const { prover } = proverOver({}, bunFs({ [join(BUN_WT, 'bunfig.toml')]: BUNFIG_WITH_PRELOAD }))
    const evidence = await prover.prove({ run: RUN, claim: CLAIM, changed_files: ['src/limit.ts'] })
    expect(evidence.reason).not.toContain('bunfig.toml')
    expect(evidence.proved).toBe(true)
  })

  // ── WHERE AN INHERITED PRELOAD POINTS ────────────────────────────────────
  //
  // THE THIRTEENTH ESCAPE. Both of the two arms above ask who wrote the CONFIG,
  // and a seat walked between them: leave main's `bunfig.toml` alone and rewrite
  // THE FILE ITS PRELOAD NAMES. No config in the diff, so no candidate existed;
  // the key byte-identical to main's, so the provenance comparison said "main's".
  // The branch's code ran in every bun test process regardless, and a
  // syntax-breaking mutation with an unrelated guard came back proved:true.
  const BUNFIG_MAIN_HOOK = '[test]\npreload = ["./tests/support/hook.ts"]\n'

  test("a preload MAIN wrote, aimed at a file THIS BRANCH rewrites, is still the branch's code → refused", async () => {
    const { prover, host } = proverOver(
      // The config is inherited in the strongest sense available: identical at
      // the merge base, and not in the diff at all.
      { mergeBase: 'b'.repeat(40), baseFiles: { 'bunfig.toml': BUNFIG_MAIN_HOOK } },
      bunFs({ [join(BUN_WT, 'bunfig.toml')]: BUNFIG_MAIN_HOOK }),
    )
    const evidence = await prover.prove({
      run: RUN,
      claim: CLAIM,
      changed_files: ['src/limit.ts', 'tests/support/hook.ts'],
      base_ref: 'main',
    })
    expect(evidence.proved).toBe(false)
    expect(evidence.observed).toBeNull()
    expect(evidence.reason).toContain('bunfig.toml')
    expect(evidence.reason).toContain('tests/support/hook.ts')
    expect(evidence.reason).toContain('BRANCH-SUPPLIED')
    // Nothing ran: the refusal lands at the claim, before a byte is mutated.
    expect(host.calls.every((c) => c[0] !== 'bun')).toBe(true)
  })

  test('…in every spelling a loader completes — a `.js` name, and no extension at all', async () => {
    // The value is a SPECIFIER, not a path: bun resolves `./tests/support/hook.js`
    // and `./tests/support/hook` to the `.ts` file on disk, and comparing written
    // spellings would have missed both.
    for (const spelling of ['./tests/support/hook.js', './tests/support/hook', 'tests/support/hook.ts']) {
      const body = `[test]\npreload = ["${spelling}"]\n`
      const { prover } = proverOver(
        { mergeBase: 'b'.repeat(40), baseFiles: { 'bunfig.toml': body } },
        bunFs({ [join(BUN_WT, 'bunfig.toml')]: body }),
      )
      const evidence = await prover.prove({
        run: RUN,
        claim: CLAIM,
        changed_files: ['src/limit.ts', 'tests/support/hook.ts'],
        base_ref: 'main',
      })
      expect([spelling, evidence.proved]).toEqual([spelling, false])
      expect([spelling, (evidence.reason ?? '').includes('tests/support/hook.ts')]).toEqual([spelling, true])
    }
  })

  test('…and it refuses the CONTROL side of the pair too — the whole nomination is the over-refusal', async () => {
    // The refusal walks the nominated PAIR, so a bun CONTROL beside a non-bun
    // guard is refused by this same arm. That is half of the aggregate the
    // seam comment on `bunConfigInspected` records: a diff touching a
    // root-bunfig-preloaded support file loses every bun guard AND every bun
    // control, and `node --test` cannot run `bun:test` files, so in a bun-only
    // repo no legal nomination remains on either side. Fails CLOSED; relief is
    // the follow-up card "trident: scope the inherited-preload arm so a diff
    // touching a root-bunfig-preloaded support file keeps a legal bun
    // nomination", not a fix round's side effect.
    const { prover, host } = proverOver(
      { mergeBase: 'b'.repeat(40), baseFiles: { 'bunfig.toml': BUNFIG_MAIN_HOOK } },
      bunFs({ [join(BUN_WT, 'bunfig.toml')]: BUNFIG_MAIN_HOOK }),
    )
    const evidence = await prover.prove({
      run: RUN,
      // The guard is node and reads no bunfig; only the CONTROL is bun.
      claim: { ...CLAIM, guard: ['node', '--test', 'tests/limit.test.mjs'] },
      changed_files: ['src/limit.ts', 'tests/support/hook.ts'],
      base_ref: 'main',
    })
    expect(evidence.proved).toBe(false)
    expect(evidence.observed).toBeNull()
    // Named on the CONTROL: the node guard walked past this arm refusal-free.
    expect(evidence.reason).toContain('claim.control')
    expect(evidence.reason).toContain('tests/support/hook.ts')
    // Nothing ran — neither the node guard nor the bun control.
    expect(host.calls.every((c) => c[0] !== 'bun' && c[0] !== 'node')).toBe(true)
  })

  test('…and the same inherited preload, aimed at a file the branch did NOT touch, still proves', async () => {
    // THE POSITIVE CONTROL on the two rows above, and the whole reason this arm
    // reads WHERE the preload points instead of refusing every repo that ships
    // one. Same config, same claim, same base: only the diff differs.
    const { prover } = proverOver(
      { mergeBase: 'b'.repeat(40), baseFiles: { 'bunfig.toml': BUNFIG_MAIN_HOOK } },
      bunFs({ [join(BUN_WT, 'bunfig.toml')]: BUNFIG_MAIN_HOOK }),
    )
    const evidence = await prover.prove({
      run: RUN,
      claim: CLAIM,
      changed_files: ['src/limit.ts', 'tests/support/other.ts'],
      base_ref: 'main',
    })
    expect(evidence.reason ?? '').not.toContain('BRANCH-SUPPLIED')
    expect(evidence.proved).toBe(true)
  })

  test('node reads no bunfig, so an inherited preload aimed at a changed file does not refuse it', async () => {
    const { prover } = proverOver(
      { mergeBase: 'b'.repeat(40), baseFiles: { 'bunfig.toml': BUNFIG_MAIN_HOOK } },
      bunFs({ [join(BUN_WT, 'bunfig.toml')]: BUNFIG_MAIN_HOOK }),
    )
    const evidence = await prover.prove({
      run: RUN,
      claim: NODE_CLAIM,
      changed_files: ['src/limit.ts', 'tests/support/hook.ts'],
      base_ref: 'main',
    })
    expect(evidence.reason ?? '').not.toContain('BRANCH-SUPPLIED')
    expect(evidence.observed).not.toBeNull()
  })

  test('hookValuePaths / hookTargetChangedByBranch — the predicate itself, both directions', () => {
    expect(hookValuePaths('["./a.ts", \'./b.ts\']')).toEqual(['./a.ts', './b.ts'])
    expect(hookValuePaths('  ./bare.ts  ')).toEqual(['./bare.ts'])
    expect(hookValuePaths('[]')).toEqual([])

    const cfg = '[test]\npreload = ["./tests/support/hook.ts", "./tests/support/other.ts"]\n'
    expect(hookTargetChangedByBranch(cfg, 'preload', ['tests/support/other.ts'])).toBe('tests/support/other.ts')
    expect(hookTargetChangedByBranch(cfg, 'preload', ['src/limit.ts'])).toBeNull()
    // A RESOLUTION MAP IS NOT WIDENED THIS WAY: `exports` names files too, and
    // refusing a nomination because main's map mentions a file this branch
    // edited is the over-refusal this card exists to remove.
    expect(hookTargetChangedByBranch('{ "exports": { ".": "./src/limit.ts" } }', 'exports', ['src/limit.ts'])).toBeNull()
    expect(hookTargetChangedByBranch('{ "name": "x" }', 'preload', ['src/limit.ts'])).toBeNull()

    // The root bunfig is inspected whether or not the branch touched it, once —
    // and node, which does not read it, is not handed it at all.
    expect(bunConfigInspected(CLAIM.guard, ['src/limit.ts'])).toEqual(['bunfig.toml'])
    expect(bunConfigInspected(CLAIM.guard, ['bunfig.toml'])).toEqual(['bunfig.toml'])
    expect(bunConfigInspected(['node', '--test', 'tests/x.test.mjs'], ['src/limit.ts'])).toEqual([])
    expect(bunConfigInspected(['go', 'test', './...'], ['src/limit.ts', 'bunfig.toml'])).toEqual([])
  })

  // ── AND `main` IS A RESOLUTION MAP WITH THE KEY LEFT IMPLICIT ────────────
  //
  // A seat forged a proof on node v22 through the one manifest key this arm did
  // not know: with no `exports` map present the CJS resolver falls back to
  // `main`, so a branch-authored `"main": "./src/limit.cjs"` made `require('..')`
  // inside an otherwise unrelated guard load the mutated file.
  const PKG_MAIN_BASE = '{\n  "name": "x",\n  "main": "./src/index.ts"\n}\n'

  test('a package.json `main` THIS BRANCH writes redirects require(\'..\') at the mutated file → refused', async () => {
    const head = '{\n  "name": "x",\n  "main": "./src/limit.ts"\n}\n'
    const { prover, host } = proverOver(
      { mergeBase: 'b'.repeat(40), baseFiles: { 'package.json': PKG_MAIN_BASE } },
      bunFs({ [join(BUN_WT, 'package.json')]: head }),
    )
    const evidence = await prover.prove({
      run: RUN,
      claim: CLAIM,
      changed_files: ['src/limit.ts', 'package.json'],
      base_ref: 'main',
    })
    expect(evidence.proved).toBe(false)
    expect(evidence.reason).toContain('the main in package.json')
    expect(host.calls.every((c) => c[0] !== 'bun')).toBe(true)
  })

  test('…and a `main` MAIN already carried keeps its nomination — the same comparison, not the basename', async () => {
    // The load-bearing control: nearly every published manifest carries `main`,
    // so refusing on its PRESENCE would cost every such repo its nomination.
    const head = '{\n  "name": "x",\n  "main": "./src/index.ts",\n  "dependencies": { "zod": "^4" }\n}\n'
    const { prover } = proverOver(
      { mergeBase: 'b'.repeat(40), baseFiles: { 'package.json': PKG_MAIN_BASE } },
      bunFs({ [join(BUN_WT, 'package.json')]: head }),
    )
    const evidence = await prover.prove({
      run: RUN,
      claim: CLAIM,
      changed_files: ['src/limit.ts', 'package.json'],
      base_ref: 'main',
    })
    expect(evidence.reason ?? '').not.toContain('package.json')
    expect(evidence.proved).toBe(true)
  })

  test('a manifest this branch ADDS is refused with a remedy that EXISTS — nothing to restore it to', async () => {
    // The refusal used to tell an added file to "restore <key> to what main
    // carries". For a file main does not have, that names nothing, and both
    // remedies it offered were impossible — which is this card's own defect,
    // re-created in a refusal string.
    const { prover } = proverOver(
      { mergeBase: 'b'.repeat(40), baseFiles: {} },
      bunFs({ [join(BUN_WT, 'packages/newpkg/package.json')]: '{\n  "exports": { ".": "./index.ts" }\n}\n' }),
    )
    const evidence = await prover.prove({
      run: RUN,
      claim: CLAIM,
      changed_files: ['src/limit.ts', 'packages/newpkg/package.json'],
      base_ref: 'main',
    })
    expect(evidence.proved).toBe(false)
    expect(evidence.reason).toContain('NEW on this branch')
    expect(evidence.reason).not.toContain('restore exports')
  })

  test('a branch-authored config with NO load hook keeps its nomination — the KEY is what is refused', async () => {
    const { prover } = proverOver(
      {},
      bunFs({
        [join(BUN_WT, 'bunfig.toml')]: '[loader]\n".png" = "file"\n',
        [join(BUN_WT, 'tsconfig.json')]: '{\n  "compilerOptions": { "strict": true }\n}\n',
      }),
    )
    const evidence = await prover.prove({
      run: RUN,
      claim: CLAIM,
      changed_files: ['src/limit.ts', 'bunfig.toml', 'tsconfig.json'],
    })
    expect(evidence.proved).toBe(true)
  })

  test('a config the branch DELETED loads nothing — absent at the pinned head, not refused', async () => {
    const { prover } = proverOver({}, bunFs({}))
    const evidence = await prover.prove({ run: RUN, claim: CLAIM, changed_files: ['src/limit.ts', 'bunfig.toml'] })
    expect(evidence.proved).toBe(true)
  })

  test('bunConfigCandidates / bunConfigLoadHook — the predicates themselves, both directions', () => {
    const changed = [
      'src/limit.ts',
      'bunfig.toml',
      'landing/tsconfig.json',
      'app/jsconfig.json',
      // THE EXTENDED SPELLING: this repo's root tsconfig is a four-line wrapper
      // over the base file that holds the real map, so an exact-basename rule
      // would refuse the wrapper and wave the deciding file through.
      'tsconfig.base.json',
      'README.md',
    ]
    expect(bunConfigCandidates(CLAIM.guard, changed)).toEqual([
      'bunfig.toml',
      'landing/tsconfig.json',
      'app/jsconfig.json',
      'tsconfig.base.json',
    ])
    // Not a bun nomination at all, and not a config name.
    expect(bunConfigCandidates(['go', 'test', './...'], changed)).toEqual([])
    expect(
      bunConfigCandidates(CLAIM.guard, ['docs/tsconfig.json.md', 'src/bunfig.toml.ts', 'tsconfigx.json', 'package-lock.json']),
    ).toEqual([])
    // A RESOLUTION MAP LIVES HERE TOO: package.json's `imports`/`exports` point
    // a bare specifier in an unrelated test at the mutated file, and a seat
    // forged `proved: true` through one while this basename was excluded.
    expect(bunConfigCandidates(CLAIM.guard, ['package.json', 'landing/package.json'])).toEqual([
      'package.json',
      'landing/package.json',
    ])
    expect(bunConfigLoadHook('package.json', '{ "imports": { "#lib": "./src/limit.ts" } }')).toBe('imports')
    expect(bunConfigLoadHook('package.json', '{ "exports": { ".": "./src/limit.ts" } }')).toBe('exports')
    // …and the ordinary manifest edit keeps its nomination — the POSITIVE
    // CONTROL on the arm above, without which refusing every package.json
    // outright would pass it.
    expect(bunConfigLoadHook('package.json', '{ "name": "x", "dependencies": { "zod": "^3" } }')).toBeNull()
    // The KEY, per file kind.
    expect(bunConfigLoadHook('bunfig.toml', BUNFIG_WITH_PRELOAD)).toBe('preload')
    expect(bunConfigLoadHook('bunfig.toml', '[loader]\n".png" = "file"\n')).toBeNull()
    // …and a bunfig is not read for a tsconfig key, nor the other way round.
    expect(bunConfigLoadHook('bunfig.toml', TSCONFIG_WITH_PATHS)).toBeNull()
    expect(bunConfigLoadHook('landing/tsconfig.json', TSCONFIG_WITH_PATHS)).toBe('compilerOptions.paths')
    expect(bunConfigLoadHook('tsconfig.json', '{ "compilerOptions": { "baseUrl": "." } }')).toBe(
      'compilerOptions.baseUrl',
    )
    expect(bunConfigLoadHook('tsconfig.json', '{ "compilerOptions": { "strict": true } }')).toBeNull()
    expect(bunConfigLoadHook('tsconfig.json', BUNFIG_WITH_PRELOAD)).toBeNull()
    // NODE READS THE MANIFEST AND NOTHING ELSE ON THIS LIST: it resolves
    // `imports`/`exports` exactly as bun does, and it reads neither a bunfig
    // nor a tsconfig `paths` map.
    expect(bunConfigCandidates(['node', '--test', 'tests/x.test.mjs'], changed)).toEqual([])
    expect(bunConfigCandidates(['node', '--test', 'tests/x.test.mjs'], ['package.json', 'app/package.json'])).toEqual([
      'package.json',
      'app/package.json',
    ])
    // ALL the keys a file carries, not just the first: an inherited `imports`
    // map must not hide an `exports` map the branch wrote beside it.
    expect(bunConfigLoadHooks('package.json', '{ "imports": {}, "exports": {} }')).toEqual(['imports', 'exports'])
    expect(bunConfigLoadHooks('tsconfig.json', TSCONFIG_WITH_PATHS)).toEqual(['compilerOptions.paths'])
    expect(bunConfigLoadHooks('package.json', '{ "name": "x" }')).toEqual([])
  })

  test('THE LISTING IS RECURSIVE — a conftest.py a directory down is still seen', async () => {
    const { prover, host } = proverOver({ treePaths: ['src', 'tests/conftest.py'] })
    await prover.prove({ run: RUN, claim: { ...CLAIM, guard: PY_GUARD } })
    const ls = host.calls.find((c) => c.includes('ls-tree'))
    expect(ls).toBeDefined()
    expect(ls).toContain('-r')
  })

  test('a top level we could not read FAILS CLOSED', async () => {
    const { prover } = proverOver({ lsTreeFails: true })
    const evidence = await prover.prove({ run: RUN, claim: { ...CLAIM, guard: PY_GUARD } })
    expect(evidence.proved).toBe(false)
    expect(evidence.observed).toBeNull()
    expect(evidence.reason).toContain('runner provenance')
  })

  test('SCOPE: an all-bun claim never asks for the tree listing, and still proves', async () => {
    const { prover, host } = proverOver()
    const evidence = await prover.prove({ run: RUN, claim: CLAIM })
    expect(evidence.observed).not.toBeNull()
    expect(host.calls.every((c) => !c.includes('ls-tree'))).toBe(true)
  })

  test('pythonModuleShadow — the predicate itself, both directions', () => {
    for (const entry of SHADOWING) {
      expect([entry, pythonModuleShadow(PY_GUARD, [entry, 'src'])]).toEqual([entry, entry])
    }
    for (const entry of LEGAL) {
      expect([entry, pythonModuleShadow(PY_GUARD, [entry, 'src'])]).toEqual([entry, null])
    }
    // Not a python -m argv at all.
    expect(pythonModuleShadow(['bun', 'test', 'x'], ['pytest'])).toBeNull()
    // The module asked about is the one that must be shadowed.
    expect(pythonModuleShadow(['python3', '-m', 'unittest'], ['pytest'])).toBeNull()
  })
})

describe('PROVE THE MUTATION APPLIED — a no-op mutation is not a proof', () => {
  test('claim.find that does not occur → refused, with no observations at all', async () => {
    const { prover } = proverOver()
    const evidence = await prover.prove({ run: RUN, claim: { ...CLAIM, find: 'no such text' } })
    expect(evidence.proved).toBe(false)
    expect(evidence.observed).toBeNull()
    expect(evidence.reason).toContain('did not apply')
  })

  test('claim.find that occurs twice is ambiguous → refused (which line did we break?)', async () => {
    const path = join(proofWorktreePath('/repo', RUN), CLAIM.file)
    const { prover } = proverOver({}, memFs({ [path]: `${SRC_BEFORE}${SRC_BEFORE}` }))
    const evidence = await prover.prove({ run: RUN, claim: CLAIM })
    expect(evidence.proved).toBe(false)
    expect(evidence.reason).toContain('ambiguous')
  })

  test('replace === find changes nothing → refused before anything runs', async () => {
    const { prover, host } = proverOver()
    const evidence = await prover.prove({ run: RUN, claim: { ...CLAIM, replace: CLAIM.find } })
    expect(evidence.proved).toBe(false)
    expect(evidence.reason).toContain('changes nothing')
    expect(host.calls).toHaveLength(0)
  })

  test('a file that does not exist at the head → refused', async () => {
    const { prover } = proverOver({}, memFs({}))
    const evidence = await prover.prove({ run: RUN, claim: CLAIM })
    expect(evidence.proved).toBe(false)
    expect(evidence.reason).toContain('does not exist')
  })

  test('a path escaping the worktree, and a program off the allowlist, never run', async () => {
    const { prover, host } = proverOver()
    const escape = await prover.prove({ run: RUN, claim: { ...CLAIM, file: '../../etc/passwd' } })
    expect(escape.reason).toContain('repo-relative')
    const rm = await prover.prove({ run: RUN, claim: { ...CLAIM, guard: ['rm', '-rf', '/'] } })
    expect(rm.reason).toContain('not a test runner')
    expect(host.calls).toHaveLength(0)
  })

  test('a SYMLINK out of the worktree is refused, and the file it points at is never written', async () => {
    // `validateClaim` rejects an absolute path and a `..` segment, but the branch
    // under proof is agent-authored and a COMMITTED SYMLINK is neither: it
    // materialises in the proof worktree as a link, and `readFile`/`writeFile`
    // follow it. This test runs on the REAL filesystem — an in-memory `fs` has no
    // symlinks and so cannot show the escape at all.
    const tmp = await mkdtemp(join(tmpdir(), 'prover-symlink-'))
    try {
      const repo = join(tmp, 'repo')
      const wt = proofWorktreePath(repo, RUN)
      await mkdir(join(wt, 'src'), { recursive: true })
      const outside = join(tmp, 'outside.ts')
      await writeFile(outside, SRC_BEFORE, 'utf8')
      // The link sits at the nominated path; the claim itself is clean.
      await symlink(outside, join(wt, CLAIM.file))

      const host = scriptedHost()
      const prover = createMutationProver({ run_host: host.run, run_guard: async (a, c) => host.run(a, c) })
      const evidence = await prover.prove({ run: { ...RUN, repo_path: repo }, claim: CLAIM })

      expect(evidence.proved).toBe(false)
      expect(evidence.reason).toContain('outside the proof worktree')
      // THE REFUSAL, observed on the filesystem rather than in the reason string:
      // the file the link pointed at still holds its original bytes.
      expect(await readFile(outside, 'utf8')).toBe(SRC_BEFORE)
      // And nothing was executed against it.
      expect(evidence.observed).toBeNull()
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })

  test('an ordinary file under a symlinked worktree PREFIX still proves', async () => {
    // The containment check resolves BOTH sides. Resolving only the target would
    // refuse every honest claim on a box where the worktree root itself sits
    // under a symlinked prefix (the `/tmp` → `/private/tmp` case).
    const tmp = await mkdtemp(join(tmpdir(), 'prover-prefix-'))
    try {
      const real = join(tmp, 'real')
      const repo = join(tmp, 'repo-link')
      const wt = proofWorktreePath(real, RUN)
      await mkdir(join(wt, 'src'), { recursive: true })
      await writeFile(join(wt, CLAIM.file), SRC_BEFORE, 'utf8')
      await symlink(real, repo)

      const host = scriptedHost()
      const prover = createMutationProver({ run_host: host.run, run_guard: async (a, c) => host.run(a, c) })
      const evidence = await prover.prove({ run: { ...RUN, repo_path: repo }, claim: CLAIM })

      expect(evidence.reason).not.toContain('outside the proof worktree')
      expect(evidence.proved).toBe(true)
      // Restored on the real filesystem, not just in the digest.
      expect(await readFile(join(wt, CLAIM.file), 'utf8')).toBe(SRC_BEFORE)
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })

  test('the guard and the control must be TESTS — a shell one-liner is not one', async () => {
    // The bypass this closes: `bash -c 'grep …'` is red under any mutation of the
    // line and `echo` is green by construction, so the pair walks the red→green
    // cycle without a single test process ever starting.
    const { prover, host } = proverOver()
    const shell = await prover.prove({ run: RUN, claim: { ...CLAIM, guard: ['bash', '-c', 'grep -q LIMIT src/limit.ts'] } })
    expect(shell.proved).toBe(false)
    expect(shell.reason).toContain('not a test runner')
    const echo = await prover.prove({ run: RUN, claim: { ...CLAIM, control: ['sh', '-c', 'echo ok'] } })
    expect(echo.reason).toContain('not a test runner')

    // A program that IS on the list, in a shape that is not its test form.
    const notTest = await prover.prove({ run: RUN, claim: { ...CLAIM, guard: ['bun', 'run', 'build'] } })
    expect(notTest.reason).toContain('must be a test invocation')
    const nodeScript = await prover.prove({ run: RUN, claim: { ...CLAIM, control: ['node', 'scripts/echo.mjs'] } })
    expect(nodeScript.reason).toContain('must be a test invocation')

    // …and the real test shapes are accepted: each one gets past validation and
    // is actually RUN (it comes back carrying observations).
    for (const guard of [
      ['bun', 'test', 'x.test.ts'],
      ['node', '--test', 'x.js'],
      ['go', 'test', './...'],
      ['python3', '-m', 'pytest'],
      ['cargo', 'test'],
    ]) {
      const accepted = await prover.prove({ run: RUN, claim: { ...CLAIM, guard } })
      expect(accepted.observed).not.toBeNull()
    }

    // THE WRAPPER SHAPES ARE ON THE ALLOWLIST AND ARE STILL NOT GUARDS. `npm
    // run <script>` and `make <target>` pass the SHAPE check — the allowlist is
    // untouched, and they remain legal CONTROLS — but their command line lives
    // in a `package.json` script or a `Makefile` recipe the branch wrote, so
    // the argv cannot show that it does not preload the mutated file. Refused
    // on opacity, not on shape, and the reason says which.
    for (const guard of [
      ['npm', 'run', 'test:unit'],
      ['make', 'test-unit'],
    ]) {
      const opaque = await prover.prove({ run: RUN, claim: { ...CLAIM, guard } })
      expect([guard.join(' '), opaque.observed]).toEqual([guard.join(' '), null])
      expect(opaque.reason).not.toContain('not a test runner')
      expect(opaque.reason).not.toContain('must be a test invocation')
      expect(opaque.reason).toContain('whose script body the branch wrote')
      // …and the same program as the CONTROL is untouched: the tautology is
      // about what the GUARD loads.
      const asControl = await prover.prove({ run: RUN, claim: { ...CLAIM, control: guard } })
      expect([guard.join(' '), asControl.observed === null]).toEqual([guard.join(' '), false])
    }
    expect(host.calls.length).toBeGreaterThan(0)
  })

  test('one command cannot be both the RED and the GREEN', async () => {
    const { prover } = proverOver()
    const same = await prover.prove({ run: RUN, claim: { ...CLAIM, control: [...CLAIM.guard] } })
    expect(same.proved).toBe(false)
    expect(same.reason).toContain('same command as claim.guard')
  })

  test('a mutation of a TEST file, or of documentation, is not a mutation of behaviour', async () => {
    const { prover, host } = proverOver()
    for (const file of ['src/limit.test.ts', 'src/__tests__/limit.ts', 'app/foo_test.go']) {
      const out = await prover.prove({ run: RUN, claim: { ...CLAIM, file } })
      expect(out.reason).toContain('is a test file')
    }
    const doc = await prover.prove({ run: RUN, claim: { ...CLAIM, file: 'docs/limits.md' } })
    expect(doc.reason).toContain('is documentation')
    expect(host.calls).toHaveLength(0)
  })

  test('a `replace` containing a $-pattern writes the bytes it says it writes', async () => {
    // `String.replace(find, "$`")` expands to the text BEFORE the match. The
    // claim is signed, so the bytes on disk have to be the bytes claimed.
    const path = join(proofWorktreePath('/repo', RUN), CLAIM.file)
    const fs = memFs({ [path]: SRC_BEFORE })
    const { prover } = proverOver({}, fs)
    await prover.prove({ run: RUN, claim: { ...CLAIM, replace: '$`$&' } })
    expect(fs.writes[0]).toBe('export const LIMIT = 10\nexport function under(n: number) { return $`$& }\n')
    // The expansion this rules out: `$\`` is the text BEFORE the match, so the
    // naive `replace` wrote the whole file prefix into the middle of the line.
    expect(fs.writes[0]).not.toContain('export const LIMIT = 10\nexport function under(n: number) { return export')
  })

  test('a restore that did not actually restore is not a proof', async () => {
    // Kills the mutation `restoredSha = sha256(before)` — computing the "restored"
    // digest from the bytes we MEANT to write rather than from the file we re-read.
    const path = join(proofWorktreePath('/repo', RUN), CLAIM.file)
    const fs = memFs({ [path]: SRC_BEFORE })
    const corrupting: ProverFs = {
      read: fs.read,
      write: async (p, c) => {
        // The restore write lands one byte short — a silent disk-level failure.
        await fs.write(p, c === SRC_BEFORE ? `${c}// leftover\n` : c)
      },
    }
    const host = scriptedHost()
    const prover = createMutationProver({ run_host: host.run, fs: corrupting })
    const evidence = await prover.prove({ run: RUN, claim: CLAIM })
    expect(evidence.proved).toBe(false)
    expect(evidence.reason).toContain('not restored to its original bytes')
    expect(evidence.observed?.file_sha256_restored).not.toBe(evidence.observed?.file_sha256_before)
  })

  test('a run with no branch, and an unresolvable head, are refusals not passes', async () => {
    const { prover } = proverOver()
    expect((await prover.prove({ run: { ...RUN, branch: null }, claim: CLAIM })).reason).toContain('no branch')
    const { prover: p2 } = proverOver({ headUnresolvable: true })
    expect((await p2.prove({ run: RUN, claim: CLAIM })).reason).toContain('could not resolve the head')
    const { prover: p3 } = proverOver({ worktreeAddFails: true })
    expect((await p3.prove({ run: RUN, claim: CLAIM })).reason).toContain('proof worktree')
  })

  test('a support LIBRARY under tests/ is a legal target — it declares no test cases', async () => {
    // The old path rule refused every path with a `tests/` segment, which is how
    // a harness library — asserted by a SEPARATE `*.test.ts` — became
    // unmutatable. Classification is by what DECLARES a file a test, so this
    // claim gets past validation and actually RUNS.
    const file = 'tests/support/scrub-instance-env.ts'
    const fs = memFs({ [join(proofWorktreePath('/repo', RUN), file)]: SRC_BEFORE })
    const { prover } = proverOver({}, fs)
    const evidence = await prover.prove({ run: RUN, claim: { ...CLAIM, file } })
    expect(evidence.reason).not.toContain('is a test file')
    // The positive control against a silently-empty run: it OBSERVED something.
    expect(evidence.observed).not.toBeNull()
  })

  test('a guard that runs the MUTATED FILE as its own test argument is the tautology, and is refused', async () => {
    // This is the check the path rule was standing in for, stated directly: it
    // holds for production targets too, which the path rule never did.
    const { prover, host } = proverOver()
    const out = await prover.prove({ run: RUN, claim: { ...CLAIM, guard: ['bun', 'test', CLAIM.file] } })
    expect(out.proved).toBe(false)
    expect(out.observed).toBeNull()
    expect(out.reason).toContain('tautology')
    expect(out.reason).toContain(CLAIM.file)
    // Refused BEFORE anything was executed.
    expect(host.calls).toHaveLength(0)

    // Positive control: the default CLAIM's guard names a DIFFERENT file, so it
    // is permitted and the prover really runs — the assertion above cannot be
    // passing because every claim is refused.
    const { prover: ok } = proverOver()
    expect((await ok.prove({ run: RUN, claim: CLAIM })).observed).not.toBeNull()
  })

  test('two characters of punctuation do not defeat the tautology check', async () => {
    // `./src/limit.ts` and `src/limit.ts` are ONE path. Compared raw, the check
    // is a formality anyone can step around.
    const { prover } = proverOver()
    const out = await prover.prove({ run: RUN, claim: { ...CLAIM, guard: ['bun', 'test', `./${CLAIM.file}`] } })
    expect(out.proved).toBe(false)
    expect(out.reason).toContain('tautology')
  })

  test('a guard argv that LEAVES the worktree is refused — absolute, and ..-and-back', async () => {
    // THE BYPASS THIS CLOSES. The guard runs with the proof worktree as its cwd
    // and that worktree's absolute path is derivable (`proofWorktreePath`), so
    // both of these RUN the mutated file — while comparing equal to nothing,
    // because a repo-relative `claim.file` can never match a path that starts
    // with `/` or climbs out and walks back in. The mutated file was its own
    // guard: red under the mutation, green restored, "proved". Refuse the SHAPE.
    const abs = `${proofWorktreePath('/repo', RUN)}/${CLAIM.file}`
    for (const arg of [abs, `../${basename(proofWorktreePath('/repo', RUN))}/${CLAIM.file}`, '..', `--preload=${abs}`]) {
      const { prover, host } = proverOver()
      const out = await prover.prove({ run: RUN, claim: { ...CLAIM, guard: ['bun', 'test', arg] } })
      // Refused BEFORE anything was executed, and the refusal NAMES the argument.
      expect([arg, out.proved, host.calls.length]).toEqual([arg, false, 0])
      expect(out.reason).toContain('must be a repo-relative path inside the worktree')
      expect(out.reason).toContain(arg)
    }

    // The CONTROL argv is held to the same rule — it is executed too, and a
    // control reaching outside the worktree is green for reasons the diff does
    // not own.
    const { prover: ctl } = proverOver()
    const control = await ctl.prove({ run: RUN, claim: { ...CLAIM, control: ['bun', 'test', `${abs}`] } })
    expect(control.proved).toBe(false)
    expect(control.reason).toContain('claim.control argument')

    // POSITIVE CONTROL — an ordinary repo-relative guard naming a DIFFERENT
    // file is untouched, so the rule above cannot be refusing everything.
    const { prover: ok } = proverOver()
    const fine = await ok.prove({ run: RUN, claim: { ...CLAIM, guard: ['bun', 'test', './src/other.test.ts'] } })
    expect(fine.reason).not.toContain('repo-relative')
    expect(fine.observed).not.toBeNull()
  })

  test('a URL is the THIRD spelling of an absolute path, and a colon in a script name is not one', async () => {
    // THE BYPASS THIS CLOSES. `--preload=file:///<worktree>/src/limit.ts` starts
    // with no `/`, carries no `=/` and has no `..` segment, so every lexical arm
    // of the escape rule passed it — and `carriedValue` normalizes
    // `file:///a/src/limit.ts` to `file:/a/src/limit.ts`, which equals no
    // repo-relative target. The mutated file loaded into the guard process and
    // was its own RED.
    const abs = `${proofWorktreePath('/repo', RUN)}/${CLAIM.file}`
    for (const arg of [
      `file://${abs}`,
      `--preload=file://${abs}`,
      `--preload=file:${abs}`,
      `--preload=FILE://${abs}`,
      // A LETTER-PREFIXED RUN reaching the scheme, and a scheme no name in the
      // list knows: neither is caught by the NAMED alternative, and both had to
      // survive the any-scheme alternative's move inside the shared left
      // boundary (the anchoring that answers CodeQL below). Recorded honestly:
      // the embedded-absolute arm backs both of them up, so these two pin the
      // BEHAVIOUR of the refusal, not one arm of it — the branch-sensitive pin
      // for the anchoring itself is the timing one at the end of this test.
      `x.file://${abs}`,
      `--preload=custom://${abs}`,
    ]) {
      const { prover, host } = proverOver()
      const out = await prover.prove({ run: RUN, claim: { ...CLAIM, guard: ['bun', 'test', arg] } })
      // Refused BEFORE anything was executed, and the refusal NAMES the argument.
      expect([arg, out.proved, host.calls.length]).toEqual([arg, false, 0])
      expect(out.reason).toContain('must be a repo-relative path inside the worktree')
      expect(out.reason).toContain(arg)
    }

    // POSITIVE CONTROL — a scheme is a scheme only when it is followed by a
    // `/`, so an ordinary colon in an option's value is left alone. It really
    // did get as far as RUNNING, so the assertion cannot be passing on a claim
    // refused for some other reason first.
    const { prover: colonOk } = proverOver()
    const colon = await colonOk.prove({
      run: RUN,
      claim: { ...CLAIM, guard: [...CLAIM.guard, '--test-name-pattern=fast:path'] },
    })
    expect(colon.reason).not.toContain('repo-relative')
    expect(colon.observed).not.toBeNull()

    // …AND THE SAME COLON IN A SCRIPT NAME IS STILL NOT A SCHEME. `npm run
    // test:unit` and `make test:all` are refused now — a wrapper's body is
    // branch-authored and cannot be shown not to preload the mutated file — but
    // NOT for the punctuation, which would refuse a whole runner convention for
    // a character. The reason names the opacity, not the worktree.
    for (const guard of [
      ['npm', 'run', 'test:unit'],
      ['make', 'test:all'],
    ]) {
      const { prover } = proverOver()
      const fine = await prover.prove({ run: RUN, claim: { ...CLAIM, guard } })
      expect([guard.join(' '), fine.reason.includes('repo-relative')]).toEqual([guard.join(' '), false])
      expect(fine.reason).toContain('whose script body the branch wrote')
    }

    // AND THE SCHEME TEST IS LINEAR IN THE ELEMENT IT READS. `|` binds across
    // the whole pattern, so the any-scheme alternative used to sit OUTSIDE the
    // leading token boundary and was retried from every offset of a long run of
    // scheme-characters that never reaches a `:/` — quadratic, and CodeQL
    // js/polynomial-redos (HIGH) on argv that arrives from an unbounded,
    // agent-authored nomination. This assertion fails if the boundary is taken
    // back off the second alternative.
    const started = Date.now()
    const { prover: long } = proverOver()
    const scanned = await long.prove({ run: RUN, claim: { ...CLAIM, guard: ['bun', 'test', 'a'.repeat(80_000)] } })
    // WALL-CLOCK-BOUND-OK: catastrophic backtracking has no non-timing
    // signature — the anchored and unanchored regexes return the SAME answer
    // (no match) on this input, so the only observable difference between the
    // fixed pattern and the CodeQL-flagged one is how long the scan takes, and
    // there is no logical clock inside V8's regex engine to read instead.
    // Measured on this box at 80k characters: anchored 1ms, unanchored 8083ms
    // (10k 149ms, 20k 514ms, 40k 2083ms — quadratic, 4x per doubling). The
    // bound sits at 3s: ~3000x headroom over the passing path and a 2.7x margin
    // under the failing one, and a red pin costs CI ~8s rather than the ~64s a
    // 200k input would.
    expect(Date.now() - started).toBeLessThan(3_000)
    // …and a run of letters is no scheme, so it was not refused as one — the
    // measurement above is of the scan, not of an early exit.
    expect(scanned.reason).not.toContain('repo-relative')
  })

  test('a #package-imports alias is a name only package.json resolves, so it is refused', async () => {
    // THE BYPASS THIS CLOSES. `"imports": { "#target": "./src/limit.ts" }` in
    // package.json makes `--import=#target` a preload of the MUTATED file, and
    // no arm could see it: `#` is node's FRAGMENT delimiter to `normalizeArg`,
    // so a specifier that BEGINS with one cuts away to nothing and reduces to
    // `.`, equalling no repo-relative target. Reproduced on node v22 — red
    // mutated, green control, green restored, and not one assertion about the
    // behaviour. The alias names its file inside package.json, where this gate
    // does not read, so the SHAPE is refused.
    for (const guard of [
      ['node', '--test', '--import=#target', 'tests/other.test.mjs'],
      ['node', '--test', '#target', 'tests/other.test.mjs'],
      ['bun', 'test', '-r#target', 'src/other.test.ts'],
    ]) {
      const { prover, host } = proverOver()
      const out = await prover.prove({ run: RUN, claim: { ...CLAIM, guard } })
      expect([guard.join(' '), out.proved, host.calls.length]).toEqual([guard.join(' '), false, 0])
      expect(out.reason).toContain('must be a repo-relative path inside the worktree')
      expect(out.reason).toContain('#package-imports-alias')
    }

    // POSITIVE CONTROL — a `#` that is a real FRAGMENT, mid-specifier, is
    // untouched: it names the file its bare spelling names and the suffix rule
    // already handles it. Anchoring the refusal at a token boundary is what
    // keeps this one legal, so deleting the `(^|=)` reddens this line.
    const { prover } = proverOver()
    const fine = await prover.prove({ run: RUN, claim: { ...CLAIM, guard: ['bun', 'test', './src/other.test.ts#case'] } })
    expect(fine.reason).not.toContain('repo-relative')
    expect(fine.observed).not.toBeNull()
  })

  test('a guard argument that RESOLVES to the mutated file is that file, whatever it is spelled', async () => {
    // THE BYPASS THIS CLOSES. `tests/alias.test.ts` committed as a SYMLINK to
    // `tests/support/lib.ts` is a different STRING and the same FILE, so the
    // static tautology check — which compares spellings — waved it through and
    // the runner ran the mutated library as its own assertion-free guard.
    // `claim.file`'s containment was already resolved; the guard argv was not,
    // and that asymmetry was the whole hole. Here the resolution seam is the
    // injected `fs.realpath`; `mutation-prover-realgit.test.ts` runs the same
    // shape against real git, a real committed symlink and real bun.
    const wt = proofWorktreePath('/repo', RUN)
    const file = 'tests/support/lib.ts'
    const links: Record<string, string> = {
      [join(wt, 'tests/alias.test.ts')]: join(wt, file),
      [join(wt, 'tests/alias-dir')]: join(wt, 'tests/support'),
    }
    // THE CARRIED SPELLING IS `--grep=` AND NOT `--preload=` on purpose: a load
    // hook is now refused LEXICALLY, for its opacity, before any realpath is
    // taken (see `loadHookCarrying`), which would prove nothing about
    // resolution. `guardPathCandidates` reads an option's value whatever the
    // option is called, so `--grep=` exercises the same seam and only the
    // resolved answer can refuse it.
    for (const [arg, why] of [
      ['tests/alias.test.ts', 'resolves to the same file'],
      ['--grep=tests/alias.test.ts', 'resolves to the same file'],
      ['tests/alias-dir', 'resolves to a directory holding it'],
      // …AND A QUERY SUFFIX DOES NOT HIDE THE LINK. Asked of the RAW element, a
      // `?` reads as a GLOB, so this seam SKIPPED the one element it most
      // needed to resolve — the specifier form a runtime actually loads.
      // Normalising first (which cuts the suffix) is what puts it back.
      ['tests/alias.test.ts?proof', 'resolves to the same file'],
    ] as const) {
      const fs = memFs({ [join(wt, file)]: SRC_BEFORE })
      fs.realpath = async (path: string) => links[path] ?? path
      const { prover, host } = proverOver({}, fs)
      const out = await prover.prove({
        run: RUN,
        // The argv ALSO names a separate test, so the whole-suite arm is not
        // what refuses it: this test is about RESOLUTION, and an argv that
        // selected nothing would be refused for naming no path before any
        // realpath was ever taken.
        claim: {
          ...CLAIM,
          file,
          guard: ['bun', 'test', arg, 'tests/separate.test.ts'],
          control: ['bun', 'test', 'tests/other.test.ts'],
        },
      })
      expect([arg, out.proved, out.reason.includes('tautology'), out.reason.includes(why)]).toEqual([
        arg,
        false,
        true,
        true,
      ])
      // Refused BEFORE the mutation was written: nothing was ever broken on disk.
      expect(fs.writes).toEqual([])
      expect(host.calls.every((c) => !c.includes('tests/alias.test.ts'))).toBe(true)
    }

    // POSITIVE CONTROL — a guard that resolves to a DIFFERENT file is untouched,
    // so the rule above cannot be refusing every guard once a realpath exists.
    const fs = memFs({ [join(wt, file)]: SRC_BEFORE })
    fs.realpath = async (path: string) => links[path] ?? path
    const { prover } = proverOver({}, fs)
    const fine = await prover.prove({
      run: RUN,
      claim: { ...CLAIM, file, guard: ['bun', 'test', 'tests/support/lib.test.ts'] },
    })
    expect(fine.reason).not.toContain('tautology')
    expect(fine.observed).not.toBeNull()
  })

  test('a `.js` specifier IS the `.ts` file the loader loads, so it names the mutated file', async () => {
    // THE BYPASS THIS CLOSES. `--preload=./tests/support/clamp.js` loads
    // `tests/support/clamp.ts` — bun rewrites the specifier — so the guard
    // process carries the MUTATED library while the argv equals no
    // repo-relative target: every lexical arm compares exact spellings and saw
    // nothing, and this seam `realpath`ed the literal `.js` name, got ENOENT and
    // dropped the element. Red mutated, green restored, `proved: true`, with
    // nothing having asserted the mutated file's behaviour.
    const wt = proofWorktreePath('/repo', RUN)
    const file = 'tests/support/clamp.ts'
    // `tests/support/clamp.js` exists in NO tree — which is precisely why the
    // loader falls through to the `.ts` file, and why a `realpath` of the
    // literal spelling can never see it. Everything else resolves to itself.
    const absent = new Set([join(wt, 'tests/support/clamp.js')])
    const disk = async (path: string) => {
      if (absent.has(path)) throw new Error(`ENOENT ${path}`)
      return path
    }
    // The two carried spellings are `--grep=`/`-g` rather than `--preload=`/`-r`
    // for the reason above: a load hook is refused for its OPACITY first, and
    // this test is about the REWRITE. An option's value is read by name-agnostic
    // code, so the seam under test is identical.
    for (const arg of ['--grep=./tests/support/clamp.js', '-g./tests/support/clamp.js', 'tests/support/clamp.js']) {
      const fs = memFs({ [join(wt, file)]: SRC_BEFORE })
      fs.realpath = disk
      const { prover, host } = proverOver({}, fs)
      const out = await prover.prove({
        run: RUN,
        claim: {
          ...CLAIM,
          file,
          // The argv ALSO names a separate test, so no whole-suite arm is what
          // refuses this: the refusal has to come from the rewritten spelling.
          guard: ['bun', 'test', arg, 'tests/separate.test.ts'],
          control: ['bun', 'test', 'tests/other-control.test.ts'],
        },
      })
      expect([arg, out.proved, out.reason.includes('tautology')]).toEqual([arg, false, true])
      // The refusal SAYS which file the spelling resolves to, so the next build
      // is not left re-deriving the rewrite.
      expect([arg, out.reason.includes('which a loader resolves to tests/support/clamp.ts')]).toEqual([arg, true])
      expect([arg, out.reason.includes('resolves to the same file')]).toEqual([arg, true])
      // Refused BEFORE the mutation was written, like every other tautology.
      expect([arg, fs.writes.length]).toEqual([arg, 0])
      expect(host.calls.every((c) => !c.includes(arg))).toBe(true)
    }

    // POSITIVE CONTROL — a `.js` argument that resolves to a file of its OWN is
    // untouched. The rewrite is a CANDIDATE, refused only where it really is the
    // mutated file; delete that condition and this line goes red instead.
    const fs = memFs({ [join(wt, file)]: SRC_BEFORE })
    fs.realpath = disk
    const { prover } = proverOver({}, fs)
    const fine = await prover.prove({
      run: RUN,
      claim: {
        ...CLAIM,
        file,
        guard: ['bun', 'test', '--grep=./tests/support/unrelated.js', 'tests/separate.test.ts'],
        control: ['bun', 'test', 'tests/other-control.test.ts'],
      },
    })
    expect(fine.reason).not.toContain('tautology')
    expect(fine.observed).not.toBeNull()
  })

  test('a dotted module RESOLVES too — `unittest tests.alias` where tests/alias.py is the mutated file', async () => {
    // The lexical module rule compares SPELLINGS: `tests.alias` expands to
    // `tests/alias.py`, which is not `src/limit.py`, so it passes — while the
    // import follows a committed symlink straight into the mutated file. Same
    // asymmetry the alias test above closed for path arguments, in the one
    // spelling that carries no separator at all.
    const wt = proofWorktreePath('/repo', RUN)
    const file = 'src/limit.py'
    const fs = memFs({ [join(wt, file)]: SRC_BEFORE })
    fs.realpath = async (path: string) => (path === join(wt, 'tests/alias.py') ? join(wt, file) : path)
    const { prover, host } = proverOver({}, fs)
    const out = await prover.prove({
      run: RUN,
      claim: {
        ...CLAIM,
        file,
        guard: ['python3', '-m', 'unittest', 'tests.alias'],
        control: ['python3', '-m', 'pytest', 'tests/other_test.py'],
      },
    })
    expect([out.proved, out.reason.includes('tautology'), out.reason.includes('resolves to the same file')]).toEqual([
      false,
      true,
      true,
    ])
    expect(fs.writes).toEqual([])
    expect(host.calls.every((c) => !c.includes('tests.alias'))).toBe(true)

    // POSITIVE CONTROL — a module that resolves ELSEWHERE is a separate test and
    // still runs, so the expansion cannot be refusing every dotted selector.
    const clean = memFs({ [join(wt, file)]: SRC_BEFORE })
    clean.realpath = async (path: string) => path
    const { prover: ok } = proverOver({}, clean)
    const fine2 = await ok.prove({
      run: RUN,
      claim: { ...CLAIM, file, guard: ['python3', '-m', 'unittest', 'tests.test_limit'] },
    })
    expect(fine2.reason).not.toContain('tautology')
    expect(fine2.observed).not.toBeNull()
  })

  test('a DISCOVERY argv wearing the shape of a targeted one is still discovery', async () => {
    // `python3 -m unittest discover -p test*.py` NAMES nothing: `discover` is a
    // subcommand and `test*.py` is a search, not a file. Read as path arguments
    // they made the argv look targeted, so the no-path arm never fired and the
    // mutated support library — which that very search collects — served as its
    // own guard.
    const file = 'tests/support/lib.ts'
    for (const guard of [
      ['python3', '-m', 'unittest', 'discover', '-p', 'test*.py'],
      ['python3', '-m', 'unittest', 'discover'],
      ['bun', 'test', 'tests/**/*.test.ts'],
      // …and the same run with a pattern that is not a glob. `test_lib.py` is
      // `-p`'s OPERAND, not a selection, and which options take one is a
      // vocabulary this refuses to keep — so an operand after a value-less
      // option reads as discovery. Deliberate OVER-REFUSAL (`-s other` really
      // does confine the search), and it fails CLOSED.
      ['python3', '-m', 'unittest', 'discover', '-s', 'other', '-p', 'test_lib.py'],
    ]) {
      const fs = memFs({ [join(proofWorktreePath('/repo', RUN), file)]: SRC_BEFORE })
      const { prover } = proverOver({}, fs)
      const out = await prover.prove({
        run: RUN,
        claim: { ...CLAIM, file, guard, control: ['bun', 'test', 'src/other.test.ts'] },
      })
      expect([guard.join(' '), out.proved, out.reason.includes('tautology')]).toEqual([guard.join(' '), false, true])
    }

    // POSITIVE CONTROL — `discover` being read as a runner token must not make
    // an honest guard for the same library disappear: a REAL test path after it
    // is a selection, and the whole set above cannot be passing because every
    // python guard is refused.
    const fs = memFs({ [join(proofWorktreePath('/repo', RUN), file)]: SRC_BEFORE })
    const { prover: ok } = proverOver({}, fs)
    const fine = await ok.prove({
      run: RUN,
      claim: { ...CLAIM, file, guard: ['python3', '-m', 'unittest', 'discover', 'tests/support/lib_test.py'] },
    })
    expect(fine.reason).not.toContain('tautology')
    expect(fine.observed).not.toBeNull()
  })

  test('a guard that names NO path at all discovers the mutated file, and is refused', async () => {
    // `python3 -m unittest` and a bare `bun test` name nothing: the runner
    // discovers from the repo root, which reaches every collectible file —
    // including this one. An argv-element match sees nothing here, and neither
    // does the directory arm, because there is no directory argument to compare.
    const file = 'tests/support/lib.ts'
    const fs = memFs({ [join(proofWorktreePath('/repo', RUN), file)]: SRC_BEFORE })
    const { prover } = proverOver({}, fs)
    const out = await prover.prove({
      run: RUN,
      claim: { ...CLAIM, file, guard: ['python3', '-m', 'unittest'], control: ['bun', 'test', 'src/other.test.ts'] },
    })
    expect(out.proved).toBe(false)
    expect(out.reason).toContain('tautology')

    // …and `bun test test`, whose every token is a runner token, must not slip
    // through the same hole for a library under `test/`.
    const under = 'test/support/lib.ts'
    const fs2 = memFs({ [join(proofWorktreePath('/repo', RUN), under)]: SRC_BEFORE })
    const { prover: p2 } = proverOver({}, fs2)
    const bare = await p2.prove({ run: RUN, claim: { ...CLAIM, file: under, guard: ['bun', 'test', 'test'] } })
    expect(bare.proved).toBe(false)
    expect(bare.reason).toContain('tautology')

    // POSITIVE CONTROL — a PRODUCTION module no runner collects wholesale keeps
    // its right to a bare-runner guard; over-refusing here would block honest
    // proofs, and would make the assertions above vacuous.
    const { prover: p3 } = proverOver()
    const prod = await p3.prove({ run: RUN, claim: { ...CLAIM, guard: ['python3', '-m', 'unittest'] } })
    expect(prod.reason).not.toContain('tautology')
    expect(prod.observed).not.toBeNull()
  })

  test('a name a runner COLLECTS but no convention DECLARES is still refused as its own guard', async () => {
    // `testfoo.py` is not a declared test (`*_test.py` is the convention), so it
    // is a legal mutation TARGET — but `unittest`'s default discovery pattern is
    // `test*.py`, so a bare runner runs it. Same class: node collects
    // `test-*.js`, and bun collects `*_test.ts`, `*-test.ts` and `*_spec.ts`.
    // The refusal lives on the guard side precisely so these names do NOT widen
    // the no-production-file exemption — deleting any alternative from
    // `RUNNER_COLLECTED_BASENAME` reddens one entry of this loop.
    for (const file of [
      'testfoo.py',
      'src/test-foo.js',
      'src/test_probe.py',
      'src/ab-test.ts',
      'src/thing_test.ts',
      'src/helper_spec.ts',
    ]) {
      const fs = memFs({ [join(proofWorktreePath('/repo', RUN), file)]: SRC_BEFORE })
      const { prover } = proverOver({}, fs)
      const out = await prover.prove({
        run: RUN,
        claim: { ...CLAIM, file, guard: ['python3', '-m', 'unittest'], control: ['bun', 'test', 'src/other.test.ts'] },
      })
      expect([file, out.proved, out.reason.includes('tautology')]).toEqual([file, false, true])
    }

    // POSITIVE CONTROL — the same file with a guard naming a SEPARATE test runs.
    const fs = memFs({ [join(proofWorktreePath('/repo', RUN), 'testfoo.py')]: SRC_BEFORE })
    const { prover } = proverOver({}, fs)
    const ok = await prover.prove({
      run: RUN,
      claim: { ...CLAIM, file: 'testfoo.py', guard: ['python3', '-m', 'pytest', 'other_test.py'] },
    })
    expect(ok.reason).not.toContain('tautology')
    expect(ok.observed).not.toBeNull()
  })

  test('a guard argument that names NOTHING on disk is a filter, not a selection', async () => {
    // THE BYPASS THIS CLOSES, reproduced against the real gate. `src/thing_test.ts`
    // is a LEGAL target — a runner COLLECTS that name, but no convention
    // DECLARES it a test — and `bun test thing_test.ts` names a file that does
    // not exist, so bun reads the element as a SUBSTRING FILTER, discovers the
    // whole suite and runs the mutated file as its own guard. Every lexical arm
    // passed it: the element has an extension and a collectible basename, so
    // `pathArgs` counted it as a SELECTION and the no-path arm never fired,
    // while it equals no repo-relative target, so the naming arm never fired
    // either. Existence is not a property of a spelling — only the pinned tree
    // can answer it, so THIS refusal lives at the resolution seam. (The two
    // sibling shapes are lexical and are pinned in the next test: a filter the
    // mutated path CONTAINS, and an option's separated operand.)
    const wt = proofWorktreePath('/repo', RUN)
    const file = 'src/thing_test.ts'
    // A `realpath` that models a real disk: a path resolves only if the tree
    // holds it, or holds something UNDER it (i.e. it is a directory).
    const diskOf = (files: Record<string, string>) => {
      const fs = memFs(files)
      fs.realpath = async (p: string) => {
        const path = p.replace(/\/+$/, '')
        if (fs.files[path] !== undefined) return path
        if (Object.keys(fs.files).some((f) => f.startsWith(`${path}/`))) return path
        throw new Error(`ENOENT ${p}`)
      }
      return fs
    }
    const disk = (extra: Record<string, string> = {}) => diskOf({ [join(wt, file)]: SRC_BEFORE, ...extra })

    for (const guard of [
      ['bun', 'test', 'other_test.ts'],
      ['bun', 'test', 'tests/gone.test.ts'],
    ]) {
      const fs = disk()
      const { prover } = proverOver({}, fs)
      const out = await prover.prove({
        run: RUN,
        claim: { ...CLAIM, file, guard, control: ['bun', 'test', 'src/other.test.ts'] },
      })
      expect([guard.join(' '), out.proved, out.reason.includes('does not exist at')]).toEqual([
        guard.join(' '),
        false,
        true,
      ])
      // The refusal NAMES the phantom argument, and nothing was ever mutated.
      expect(out.reason).toContain(guard[guard.length - 1] as string)
      expect(fs.writes).toEqual([])
    }

    // POSITIVE CONTROL 1 — the SAME target with a guard naming a test the tree
    // actually holds is permitted, and really runs. Without this the assertions
    // above could be passing because every claim on this path is refused.
    const held = disk({ [join(wt, 'tests/thing.test.ts')]: 'assertions\n' })
    const { prover: p1 } = proverOver({}, held)
    const ok = await p1.prove({
      run: RUN,
      claim: { ...CLAIM, file, guard: ['bun', 'test', 'tests/thing.test.ts'] },
    })
    expect(ok.reason).not.toContain('does not exist')
    expect(ok.observed).not.toBeNull()

    // POSITIVE CONTROL 2 — the rule is SCOPED to a target a runner collects.
    // `src/limit.ts` is a production module no discovery run turns into a test,
    // so a whole-suite guard is legal for it (see the directory-arm test above)
    // and a guard argument the tree does not hold costs its proof nothing.
    // Deleting the scope line reddens this.
    const prodFs = diskOf({ [join(wt, CLAIM.file)]: SRC_BEFORE })
    const { prover: p2 } = proverOver({}, prodFs)
    const prod = await p2.prove({ run: RUN, claim: CLAIM })
    expect(prod.reason).not.toContain('does not exist')
    expect(prod.proved).toBe(true)
  })

  test('a positional the runner reads as a FILTER is not a selection, and RESOLVING does not make it one', async () => {
    // THE BYPASS, in the two shapes that survived the resolution seam because
    // that seam answers "does it exist" and the question is "does it select
    // EXCLUSIVELY".
    //
    //  (1) A root `thing_test.ts` really committed, guarding a mutated
    //      `src/thing_test.ts`. The argument resolves, so nothing refuses it —
    //      but bun reads a positional as a SUBSTRING FILTER over the paths it
    //      discovers, so the run includes the mutated file and it is its own
    //      RED. Reproduced against real bun by a reviewer.
    //  (2) `--reporter-outfile out/report.test.ts` with that placeholder
    //      COMMITTED. It resolves too, and `pathArgs` counted it as a selection
    //      — so the no-path arm never fired while the argv was in fact a
    //      whole-suite discovery run that collects the mutated file.
    //
    // Both are matching semantics, not existence, so both are decided
    // lexically: the FILTER arm of `guardRunsTheMutatedFile` and the
    // option-operand rule in `pathArgs`.
    const wt = proofWorktreePath('/repo', RUN)
    const file = 'src/thing_test.ts'
    const diskOf = (files: Record<string, string>) => {
      const fs = memFs(files)
      fs.realpath = async (p: string) => {
        const path = p.replace(/\/+$/, '')
        if (fs.files[path] !== undefined) return path
        if (Object.keys(fs.files).some((f) => f.startsWith(`${path}/`))) return path
        throw new Error(`ENOENT ${p}`)
      }
      return fs
    }
    for (const [label, guard, extra] of [
      ['a filter that resolves', ['bun', 'test', 'thing_test.ts'], { [join(wt, 'thing_test.ts')]: 'assertions\n' }],
      ['a filter that does not', ['bun', 'test', 'thing_test.ts'], {}],
      [
        "an option's resolving operand",
        ['bun', 'test', '--reporter-outfile', 'out/report.test.ts'],
        { [join(wt, 'out/report.test.ts')]: 'placeholder\n' },
      ],
      [
        'the same, with a second option before it',
        ['bun', 'test', '--reporter', 'junit', '--reporter-outfile', '.output/report.test.ts'],
        {},
      ],
    ] as [string, string[], Record<string, string>][]) {
      const fs = diskOf({ [join(wt, file)]: SRC_BEFORE, ...extra })
      const { prover } = proverOver({}, fs)
      const out = await prover.prove({
        run: RUN,
        claim: { ...CLAIM, file, guard, control: ['bun', 'test', 'src/other.test.ts'] },
      })
      expect([label, out.proved, out.reason.includes('tautology')]).toEqual([label, false, true])
      // Nothing was ever mutated: the refusal is made before a byte is written.
      expect(fs.writes).toEqual([])
    }

    // POSITIVE CONTROL 1 — a selector the mutated path does NOT contain, on a
    // tree that holds it, is a real selection and the proof runs. Without this
    // every assertion above could be passing because the target is unprovable.
    const held = diskOf({ [join(wt, file)]: SRC_BEFORE, [join(wt, 'tests/thing.test.ts')]: 'assertions\n' })
    const { prover: p1 } = proverOver({}, held)
    const ok = await p1.prove({ run: RUN, claim: { ...CLAIM, file, guard: ['bun', 'test', 'tests/thing.test.ts'] } })
    expect(ok.reason).not.toContain('tautology')
    expect(ok.observed).not.toBeNull()

    // POSITIVE CONTROL 2 — the operand rule is about ORDER, not about options:
    // an option that carries its OWN value has already taken one, so the path
    // after it is still a selection, and a path BEFORE the options always is.
    for (const guard of [
      ['bun', 'test', '--reporter-outfile=report.xml', 'tests/thing.test.ts'],
      ['bun', 'test', 'tests/thing.test.ts', '--bail'],
    ]) {
      const fs = diskOf({ [join(wt, file)]: SRC_BEFORE, [join(wt, 'tests/thing.test.ts')]: 'assertions\n' })
      const { prover } = proverOver({}, fs)
      const fine = await prover.prove({ run: RUN, claim: { ...CLAIM, file, guard } })
      expect([guard.join(' '), fine.reason.includes('tautology')]).toEqual([guard.join(' '), false])
      expect(fine.observed).not.toBeNull()
    }

    // POSITIVE CONTROL 3 — the filter arm is SCOPED to a collectible target: a
    // production module is not turned into a test by a filter that matches its
    // path, so `bun test limit` stays legal for `src/limit.ts`.
    const prodFs = diskOf({ [join(wt, CLAIM.file)]: SRC_BEFORE })
    const { prover: p3 } = proverOver({}, prodFs)
    const prod = await p3.prove({ run: RUN, claim: { ...CLAIM, guard: ['bun', 'test', 'src/limit.test.ts'] } })
    expect(prod.reason).not.toContain('tautology')
    expect(prod.proved).toBe(true)
  })

  test('a DIRECTORY guard that collects the mutated support library is the same tautology', async () => {
    // THE BYPASS: `tests/support/lib.ts` is a legal target now, and `bun test
    // tests` collects everything under `tests/` — including, if the file were
    // ever named so a runner picked it up, the mutated file itself. An exact
    // argv-element match never sees this; the directory does.
    const file = 'tests/support/lib.ts'
    const fs = memFs({ [join(proofWorktreePath('/repo', RUN), file)]: SRC_BEFORE })
    const { prover } = proverOver({}, fs)
    const out = await prover.prove({ run: RUN, claim: { ...CLAIM, file, guard: ['bun', 'test', 'tests'] } })
    expect(out.proved).toBe(false)
    expect(out.reason).toContain('tautology')
    expect(out.reason).toContain('tests')

    // POSITIVE CONTROL 1 — the same library with a guard naming a SEPARATE test
    // is permitted and actually runs. Without this the assertion above could be
    // passing because every claim on this path is refused.
    const fs2 = memFs({ [join(proofWorktreePath('/repo', RUN), file)]: SRC_BEFORE })
    const { prover: p2 } = proverOver({}, fs2)
    const okOut = await p2.prove({
      run: RUN,
      claim: { ...CLAIM, file, guard: ['bun', 'test', 'tests/support/lib.test.ts'] },
    })
    expect(okOut.reason).not.toContain('tautology')
    expect(okOut.observed).not.toBeNull()

    // POSITIVE CONTROL 2 — a PRODUCTION module keeps its right to a
    // directory-wide guard: no runner turns `src/limit.ts` into a test just
    // because `src/` was named. Over-refusing here would block honest proofs.
    const { prover: p3 } = proverOver()
    const wide = await p3.prove({ run: RUN, claim: { ...CLAIM, guard: ['bun', 'test', 'src'] } })
    expect(wide.reason).not.toContain('tautology')
    expect(wide.observed).not.toBeNull()
  })

  test("the runner's own `test` token is not read as the directory test/", async () => {
    // `bun test …` puts the literal string `test` in argv. Taken as a path it
    // is the directory `test/`, and every honest guard for a library under
    // `test/` would be refused as a tautology.
    const file = 'test/support/lib.ts'
    const fs = memFs({ [join(proofWorktreePath('/repo', RUN), file)]: SRC_BEFORE })
    const { prover } = proverOver({}, fs)
    const out = await prover.prove({
      run: RUN,
      claim: { ...CLAIM, file, guard: ['bun', 'test', 'test/support/lib.test.ts'] },
    })
    expect(out.reason).not.toContain('tautology')
    expect(out.observed).not.toBeNull()
  })

  test('an OPTION that carries the mutated file names it — an `=` is not a disguise', async () => {
    // THE BYPASS: `--preload=./tests/support/lib.ts` is ONE argv element, so a
    // whole-element comparison matches nothing, and it is repo-relative, so the
    // escapes-the-worktree rule matches nothing either — while bun loads the
    // mutated file into the very process that runs the guard.
    for (const [file, arg] of [
      ['tests/support/lib.ts', '--preload=./tests/support/lib.ts'],
      // …and it holds for a PRODUCTION target too, which no path rule ever did.
      ['src/limit.ts', '--preload=src/limit.ts'],
      ['tests/support/lib.ts', '--preload=tests/support/'],
    ] as const) {
      const fs = memFs({ [join(proofWorktreePath('/repo', RUN), file)]: SRC_BEFORE })
      const { prover, host } = proverOver({}, fs)
      const out = await prover.prove({
        run: RUN,
        claim: { ...CLAIM, file, guard: ['bun', 'test', arg, 'tests/other.test.ts'] },
      })
      expect([arg, out.proved, out.reason.includes('tautology'), host.calls.length]).toEqual([arg, false, true, 0])
    }

    // POSITIVE CONTROL — an option carrying a DIFFERENT file is untouched, so
    // the rule above cannot be refusing every `=` it sees. It is `--grep=` and
    // NOT `--preload=`: a hook naming a third file is refused for its opacity
    // now (the test below this one is that boundary), so pinning it as legal
    // here is what let an indirect preload forge a proof.
    const { prover: ok } = proverOver()
    const fine = await ok.prove({
      run: RUN,
      claim: { ...CLAIM, guard: ['bun', 'test', '--grep=./tests/setup.ts', 'src/other.test.ts'] },
    })
    expect(fine.reason).not.toContain('tautology')
    expect(fine.observed).not.toBeNull()
  })

  test('a LOAD HOOK naming a THIRD file is opaque — its body may import the mutated one', async () => {
    // THE BYPASS THIS CLOSES, reproduced end to end against the real prover.
    // The branch commits `tests/setup.ts` whose whole body is `import
    // '../src/limit.ts'` and nominates guard `bun test
    // --preload=./tests/setup.ts tests/other.test.ts`, where `tests/other.test.ts`
    // asserts only `1 + 1`. Every arm above compares the hook's VALUE against
    // the target and sees a different file — so the gate returned `ok: true,
    // exempt: false, proved: true` (guard_mutated 1, control_mutated 0,
    // guard_restored 0) for a syntax-shaped mutation nothing asserted: the guard
    // reddens because bun loads the mutated module into its process, and the
    // control stays green because only the guard carries the hook.
    //
    // The hook's file is branch-authored and this gate reads argv, never file
    // bodies — the same opacity a WRAPPER has, and it is refused the same way:
    // on the shape, whatever file it names.
    for (const [file, guard] of [
      ['src/limit.ts', ['bun', 'test', '--preload=./tests/setup.ts', 'tests/other.test.ts']],
      // …the space-separated spelling of the identical instruction,
      ['src/limit.ts', ['bun', 'test', '--preload', './tests/setup.ts', 'tests/other.test.ts']],
      // …the attached short one,
      ['src/limit.ts', ['bun', 'test', '-r./tests/setup.ts', 'tests/other.test.ts']],
      // …node's two, both AFTER the mode word: `--test` has to lead (see the
      // `node <script> --test` test below), so a hook written in front of it is
      // refused one step earlier, at the shape, and this arm never sees it.
      ['src/limit.mjs', ['node', '--test', '--import=./tests/setup.mjs', 'tests/other.test.mjs']],
      ['src/limit.mjs', ['node', '--test', '--loader=./tests/hook.mjs', 'tests/other.test.mjs']],
      // …and a COLLECTIBLE target, because a preload loads a support library
      // under `tests/` into the guard process exactly as it loads `src/`.
      ['tests/support/lib.ts', ['bun', 'test', '--preload=./tests/setup.ts', 'tests/other.test.ts']],
    ] as const) {
      const fs = memFs({ [join(proofWorktreePath('/repo', RUN), file)]: SRC_BEFORE })
      const { prover, host } = proverOver({}, fs)
      const out = await prover.prove({
        run: RUN,
        claim: { ...CLAIM, file, guard: [...guard], control: ['bun', 'test', 'tests/control.test.ts'] },
      })
      // Refused on the spelling: nothing written, nothing run.
      expect([guard.join(' '), out.proved, out.reason.includes('tautology'), host.calls.length]).toEqual([
        guard.join(' '),
        false,
        true,
        0,
      ])
      // …and the refusal SAYS what is wrong with the shape, so the next build
      // spells the runner out instead of trying another hook.
      expect([guard.join(' '), out.reason.includes('whose body the branch wrote')]).toEqual([guard.join(' '), true])
      expect([guard.join(' '), fs.writes.length]).toEqual([guard.join(' '), 0])
    }

    // POSITIVE CONTROLS, because every assertion above would pass just as well
    // against "refuse any guard carrying an option with a path in it".
    //  (1) an option that CARRIES a third file without loading it — the shape
    //      the rule must not swallow, or the `=` arm's own control has no
    //      spelling left;
    //  (2) go's `-run`, which the attached-short reading turns into `-r` +
    //      `un`: the letter is only a hook when what it carries looks like a
    //      path, and deleting that condition refuses every Go guard there is;
    //  (3) `-race` for the same reason, with no operand of its own;
    //  (4) a plain runner invocation, untouched.
    for (const [file, guard] of [
      ['src/limit.ts', ['bun', 'test', '--grep=./tests/setup.ts', 'tests/other.test.ts']],
      ['src/limit.go', ['go', 'test', '-run', 'TestClamp', './cmd']],
      ['src/limit.go', ['go', 'test', '-race', './cmd']],
      ['src/limit.ts', ['bun', 'test', 'tests/other.test.ts']],
    ] as const) {
      const fs = memFs({ [join(proofWorktreePath('/repo', RUN), file)]: SRC_BEFORE })
      const { prover: ok } = proverOver({}, fs)
      const fine = await ok.prove({
        run: RUN,
        claim: { ...CLAIM, file, guard: [...guard], control: ['bun', 'test', 'tests/control.test.ts'] },
      })
      expect([guard.join(' '), fine.reason.includes('tautology')]).toEqual([guard.join(' '), false])
      // POSITIVE CONTROL ON THE EXTRACTION: the guard really ran, so the line
      // above is reading a real outcome and not an early refusal for some other
      // reason that happens to word itself differently.
      expect([guard.join(' '), fine.observed !== null]).toEqual([guard.join(' '), true])
    }
  })

  test('a REPORTER is a LOAD HOOK too — the runner executes the module it names', async () => {
    // THE BYPASS THIS CLOSES, the fifth escape of one family. Node v22 loads an
    // arbitrary module from `--test-reporter=<path>` and runs it inside the
    // guard's own process; mocha's and vitest's `--reporter` and jest's
    // `--reporters` do the same. So the branch commits `tests/reporter.mjs`
    // whose whole body is `import '../src/limit.mjs'` and nominates `node
    // --test --test-reporter=./tests/reporter.mjs tests/other.test.mjs`: the
    // reporter drags the mutated PRODUCTION file into a process running an
    // unrelated test, a syntax break reddens that guard, restoring it goes
    // green — the same false proof `--preload` already earns a refusal for.
    for (const [file, guard] of [
      ['src/limit.mjs', ['node', '--test', '--test-reporter=./tests/reporter.mjs', 'tests/other.test.mjs']],
      // …the space-separated spelling of the identical instruction,
      ['src/limit.mjs', ['node', '--test', '--test-reporter', './tests/reporter.mjs', 'tests/other.test.mjs']],
      // …mocha's and vitest's spelling,
      ['src/limit.ts', ['bun', 'test', '--reporter=./tests/reporter.ts', 'tests/other.test.ts']],
      // …and jest's plural one,
      ['src/limit.ts', ['bun', 'test', '--reporters', './tests/reporter.js', 'tests/other.test.ts']],
      // …a BUILT-IN name, refused deliberately: telling `spec` from a bare
      // module specifier is a vocabulary bet this gate loses the first time a
      // runner adds a name, and losing it means accepting a forged proof. The
      // shape is refused whatever the VALUE — over-refusing, failing closed, and
      // spellable around by dropping the option, since the prover reads exit
      // codes and never a line of report output.
      ['src/limit.mjs', ['node', '--test', '--test-reporter=spec', 'tests/other.test.mjs']],
      // …and a COLLECTIBLE target, because a reporter loads a support library
      // under `tests/` into the guard process exactly as it loads `src/`.
      ['tests/support/lib.ts', ['bun', 'test', '--test-reporter=./tests/reporter.ts', 'tests/other.test.ts']],
    ] as const) {
      const fs = memFs({ [join(proofWorktreePath('/repo', RUN), file)]: SRC_BEFORE })
      const { prover, host } = proverOver({}, fs)
      const out = await prover.prove({
        run: RUN,
        claim: { ...CLAIM, file, guard: [...guard], control: ['bun', 'test', 'tests/control.test.ts'] },
      })
      // Refused on the spelling: nothing written, nothing run.
      expect([guard.join(' '), out.proved, out.reason.includes('tautology'), host.calls.length]).toEqual([
        guard.join(' '),
        false,
        true,
        0,
      ])
      expect([guard.join(' '), out.reason.includes('whose body the branch wrote')]).toEqual([guard.join(' '), true])
      expect([guard.join(' '), fs.writes.length]).toEqual([guard.join(' '), 0])
    }

    // POSITIVE CONTROL: a DESTINATION is not a load. `--test-reporter-destination`
    // names a file the runner WRITES, and the anchored regex must not swallow the
    // longer option — without the anchor this row goes red and every honest
    // reporting guard with it. (`--reporter-outfile` is pinned legal further up.)
    for (const [file, guard] of [
      ['src/limit.mjs', ['node', '--test', '--test-reporter-destination=./out.txt', 'tests/other.test.mjs']],
    ] as const) {
      const fs = memFs({ [join(proofWorktreePath('/repo', RUN), file)]: SRC_BEFORE })
      const { prover: ok } = proverOver({}, fs)
      const fine = await ok.prove({
        run: RUN,
        claim: { ...CLAIM, file, guard: [...guard], control: ['bun', 'test', 'tests/control.test.ts'] },
      })
      expect([guard.join(' '), fine.reason.includes('tautology')]).toEqual([guard.join(' '), false])
      // POSITIVE CONTROL ON THE EXTRACTION: the guard really ran.
      expect([guard.join(' '), fine.observed !== null]).toEqual([guard.join(' '), true])
    }
  })

  test('a CONFIG and an ENV FILE are LOAD HOOKS too — the runner obeys the file they name', async () => {
    // THE BYPASS THIS CLOSES, the same family one step further out. The argv
    // does not have to carry the hook; it only has to carry the file that
    // DECLARES it. `bun test --config=./tests/bunfig.toml` reads a
    // branch-authored config whose `[test] preload` key is exactly the load
    // `--preload=` is refused for — reproduced through the real gate on bun
    // 1.3.13 as `ok: true, proved: true` with the guard file asserting nothing
    // about the mutated behaviour. `--env-file=./tests/.env` is the third
    // spelling: a committed dotenv carrying `NODE_OPTIONS=--import=<hook>` sets
    // the hook the argv never shows, and node spells the same option
    // `--env-file-if-exists` as well.
    for (const [file, guard] of [
      ['src/limit.ts', ['bun', 'test', '--config=./tests/bunfig.toml', 'tests/other.test.ts']],
      // …the space-separated spelling of the identical instruction,
      ['src/limit.ts', ['bun', 'test', '--config', './tests/bunfig.toml', 'tests/other.test.ts']],
      // …the dotenv route into `NODE_OPTIONS`,
      ['src/limit.mjs', ['node', '--test', '--env-file=./tests/.env', 'tests/other.test.mjs']],
      // …and node's second spelling of that same option, which the anchored
      // regex would otherwise leave open as a free rename of the first.
      ['src/limit.mjs', ['node', '--test', '--env-file-if-exists=./tests/.env', 'tests/other.test.mjs']],
      // …node's own config spellings, which carry an `--import` through the
      // runtime's options exactly as the dotenv does: first the one that NAMES
      // the file, attached and separated,
      ['src/limit.mjs', ['node', '--test', '--experimental-config-file=./tests/node.config.json', 'tests/o.test.mjs']],
      ['src/limit.mjs', ['node', '--test', '--experimental-config-file', './tests/node.config.json', 'tests/o.test.mjs']],
      // …then the VALUELESS one, which reads `node.config.json` from the cwd and
      // so hands a value-shaped rule nothing to look at. Written LAST it carries
      // nothing and is followed by nothing: only the name-only arm can see it,
      // and deleting that arm reddens this row alone.
      ['src/limit.mjs', ['node', '--test', 'tests/other.test.mjs', '--experimental-default-config-file']],
      // …the same option written where a value-shaped rule would have refused
      // for the WRONG reason — reading the test path that follows it as the
      // config — which is a refusal that disappears the moment the argv is
      // re-ordered,
      ['src/limit.mjs', ['node', '--test', '--experimental-default-config-file', 'tests/other.test.mjs']],
      // …and bun's and jest's SHORT `--config`, attached and separated: the
      // whole forgery above in two characters less.
      ['src/limit.ts', ['bun', 'test', '-c./tests/bunfig.toml', 'tests/other.test.ts']],
      ['src/limit.ts', ['bun', 'test', '-c', './tests/bunfig.toml', 'tests/other.test.ts']],
      // …and bun's RESOLUTION MAP, which names a config that does not load the
      // mutated file so much as REDEFINE what an import means. With
      // `compilerOptions.paths` of `{"mylib": ["../../src/limit.ts"]}` a bare
      // `import 'mylib'` inside an unrelated test IS the mutated file:
      // reproduced on bun 1.3.13, where without the flag the guard cannot even
      // resolve the specifier, and with it the guard exits 0 healthy, 1 broken
      // and 0 again on restore. Attached and separated, since the two spellings
      // are one character apart.
      ['src/limit.ts', ['bun', 'test', '--tsconfig-override=./tests/cfg/tsconfig.json', 'tests/other.test.ts']],
      ['src/limit.ts', ['bun', 'test', '--tsconfig-override', './tests/cfg/tsconfig.json', 'tests/other.test.ts']],
      // …asked of a COLLECTIBLE target too, because the config preloads a
      // support library under `tests/` into the guard process exactly as it
      // preloads `src/`.
      ['tests/support/lib.ts', ['bun', 'test', '--config=./tests/bunfig.toml', 'tests/other.test.ts']],
      ['tests/support/lib.ts', ['bun', 'test', '--tsconfig-override=./tests/cfg/tsconfig.json', 'tests/other.test.ts']],
    ] as const) {
      const fs = memFs({ [join(proofWorktreePath('/repo', RUN), file)]: SRC_BEFORE })
      const { prover, host } = proverOver({}, fs)
      const out = await prover.prove({
        run: RUN,
        claim: { ...CLAIM, file, guard: [...guard], control: ['bun', 'test', 'tests/control.test.ts'] },
      })
      // Refused on the spelling: nothing written, nothing run.
      expect([guard.join(' '), out.proved, out.reason.includes('tautology'), host.calls.length]).toEqual([
        guard.join(' '),
        false,
        true,
        0,
      ])
      expect([guard.join(' '), out.reason.includes('whose body the branch wrote')]).toEqual([guard.join(' '), true])
      expect([guard.join(' '), fs.writes.length]).toEqual([guard.join(' '), 0])
    }

    // POSITIVE CONTROL on the ANCHOR: the regex matches WHOLE option names, so a
    // longer option that merely contains one of them stays legal and its guard
    // really runs. Drop the `$` and this row goes red along with every honest
    // coverage-reporting guard in the repo.
    for (const [file, guard] of [
      ['src/limit.ts', ['bun', 'test', '--coverage-reporter=lcov', 'tests/other.test.ts']],
      // …AND ON THE SHORT LETTER, which is refused for what it CARRIES and not
      // on sight. `go test -cover ./cmd/` splits to `-c` + `over`, which is no
      // path, and a trailing `-c` carries nothing at all — the name-only arm is
      // long-only precisely so go's valueless compile flag keeps a legal guard.
      // Widen either and both rows go red.
      ['tests/support/lib.ts', ['go', 'test', '-cover', './cmd/']],
      ['tests/support/lib.ts', ['go', 'test', './cmd/', '-c']],
      // …AND ON THE NARROWNESS OF THE RESOLUTION ENTRY: only the option that
      // really takes a tsconfig PATH is listed. vitest's `--project <name>`
      // selects a workspace project by NAME, and a long hook name is refused on
      // the name alone — so adding it on suspicion would refuse this honest
      // guard outright. Widen the list past what a repro has forged and this
      // row goes red.
      ['src/limit.ts', ['bun', 'test', '--project', 'unit', 'tests/other.test.ts']],
    ] as const) {
      const fs = memFs({ [join(proofWorktreePath('/repo', RUN), file)]: SRC_BEFORE })
      const { prover: ok } = proverOver({}, fs)
      const fine = await ok.prove({
        run: RUN,
        claim: { ...CLAIM, file, guard: [...guard], control: ['bun', 'test', 'tests/control.test.ts'] },
      })
      expect([guard.join(' '), fine.reason.includes('tautology')]).toEqual([guard.join(' '), false])
      // POSITIVE CONTROL ON THE EXTRACTION: the guard really ran, so the line
      // above reads a real outcome and not an early refusal worded differently.
      expect([guard.join(' '), fine.observed !== null]).toEqual([guard.join(' '), true])
    }
  })

  test('a CONDITION is the RESOLUTION MAP with the file left implicit — the flag itself redirects the specifier', async () => {
    // THE BYPASS THIS CLOSES, reproduced end to end on node v22.23.1. A
    // `package.json` `imports` entry may be CONDITION-KEYED: `{"#lib": {"proof":
    // "./src/limit.mjs", "default": "./src/decoy.mjs"}}`. The branch then
    // nominates `node --test --conditions=proof tests/other.test.mjs`, where
    // `tests/other.test.mjs` does nothing but `import '#lib'` and assert `1 + 1`
    // — and the specifier means the MUTATED file only while the flag is there:
    // healthy 0, mutated 1, restored 0 with `--conditions=proof`, and 0 while
    // mutated WITHOUT it. So the FLAG is what reddens the guard, exactly as
    // `--tsconfig-override`'s config is, with the one difference that made this
    // spelling look innocent: the argv names no file at all, only a key into a
    // map the branch committed. Refused beside the option it is a spelling of.
    for (const [file, guard] of [
      ['src/limit.mjs', ['node', '--test', '--conditions=proof', 'tests/other.test.mjs']],
      // …the space-separated spelling of the identical instruction,
      ['src/limit.mjs', ['node', '--test', '--conditions', 'proof', 'tests/other.test.mjs']],
      // …node's SHORT alias, attached — the row the path-filtered short letters
      // would wave straight through, since a condition NAME never looks like a
      // path. Put `-C` beside `-r`/`-c` in `loadHookCarrying` and this row goes
      // green again with the forgery intact.
      ['src/limit.mjs', ['node', '--test', '-Cproof', 'tests/other.test.mjs']],
      // …and separated,
      ['src/limit.mjs', ['node', '--test', '-C', 'proof', 'tests/other.test.mjs']],
      // …bun's spelling of the same option,
      ['src/limit.ts', ['bun', 'test', '--conditions=proof', 'tests/other.test.ts']],
      // …and a COLLECTIBLE target, because a condition redirects a specifier to
      // a support library under `tests/` exactly as it redirects one to `src/`.
      ['tests/support/lib.ts', ['bun', 'test', '--conditions=proof', 'tests/other.test.ts']],
    ] as const) {
      const fs = memFs({ [join(proofWorktreePath('/repo', RUN), file)]: SRC_BEFORE })
      const { prover, host } = proverOver({}, fs)
      const out = await prover.prove({
        run: RUN,
        claim: { ...CLAIM, file, guard: [...guard], control: ['bun', 'test', 'tests/control.test.ts'] },
      })
      // Refused on the spelling: nothing written, nothing run.
      expect([guard.join(' '), out.proved, out.reason.includes('tautology'), host.calls.length]).toEqual([
        guard.join(' '),
        false,
        true,
        0,
      ])
      expect([guard.join(' '), out.reason.includes('whose body the branch wrote')]).toEqual([guard.join(' '), true])
      expect([guard.join(' '), fs.writes.length]).toEqual([guard.join(' '), 0])
    }

    // POSITIVE CONTROLS, because every assertion above would pass just as well
    // against "refuse any argv carrying an option this test happened to name".
    //  (1) the long name is ANCHORED, so a longer option that merely starts with
    //      it stays legal — drop the `$` and this honest guard is refused;
    //  (2) the lower-case letters stay NARROW: `go test -cover ./cmd` splits to
    //      `-c` + `over`, which is no path, and widening the condition arm past
    //      the single letter `-C` reddens every Go guard in the repo.
    for (const [file, guard] of [
      ['src/limit.ts', ['bun', 'test', '--conditions-file=./tests/cond.json', 'tests/other.test.ts']],
      ['src/limit.go', ['go', 'test', '-cover', './cmd']],
    ] as const) {
      const fs = memFs({ [join(proofWorktreePath('/repo', RUN), file)]: SRC_BEFORE })
      const { prover: ok } = proverOver({}, fs)
      const fine = await ok.prove({
        run: RUN,
        claim: { ...CLAIM, file, guard: [...guard], control: ['bun', 'test', 'tests/control.test.ts'] },
      })
      expect([guard.join(' '), fine.reason.includes('tautology')]).toEqual([guard.join(' '), false])
      // POSITIVE CONTROL ON THE EXTRACTION: the guard really ran.
      expect([guard.join(' '), fine.observed !== null]).toEqual([guard.join(' '), true])
    }
  })

  test("`node --run` is a WRAPPER wearing node's name — a `--test` further along does not make it a runner", async () => {
    // THE BYPASS THIS CLOSES, the wrapper family under a sixth spelling. Node
    // v22's `--run <script>` executes a `package.json` script — a command line
    // the BRANCH wrote — and node never enters test-runner mode at all, but the
    // shape check asked only whether `--test` appeared ANYWHERE in the argv, and
    // a trailing `--test` node forwards to the script satisfied it. With
    // `"test-all": "bun test --preload=./src/limit.ts tests/other.test.ts"` in
    // the branch's own `package.json`, that guard loads the mutated PRODUCTION
    // file into a process running an unrelated test: byte for byte the forgery
    // `npm run` is already refused for. Refused at the SHAPE, so no later arm
    // ever sees it.
    for (const guard of [
      ['node', '--run', 'test-all', '--test', 'tests/other.test.mjs'],
      // …the `=` spelling of the same option, one character away from the above,
      ['node', '--run=test-all', '--test', 'tests/other.test.mjs'],
      // …and with the `--test` written FIRST, which is the shape that reads
      // most like an honest node test invocation.
      ['node', '--test', '--run', 'test-all'],
    ]) {
      const fs = memFs({ [join(proofWorktreePath('/repo', RUN), 'src/limit.ts')]: SRC_BEFORE })
      const { prover, host } = proverOver({}, fs)
      const out = await prover.prove({ run: RUN, claim: { ...CLAIM, file: 'src/limit.ts', guard } })
      // Refused before anything was written or run, and the refusal says what a
      // node guard must look like instead.
      expect([guard.join(' '), out.proved, host.calls.length, fs.writes.length]).toEqual([guard.join(' '), false, 0, 0])
      expect([guard.join(' '), out.reason.includes('must be a test invocation')]).toEqual([guard.join(' '), true])
      expect([guard.join(' '), out.reason.includes('never --run')]).toEqual([guard.join(' '), true])
    }

    // The CONTROL is held to the same shape — it is executed too, and a control
    // that runs a branch-written script is green for reasons the diff does not own.
    const { prover: ctl } = proverOver({}, memFs({ [join(proofWorktreePath('/repo', RUN), 'src/limit.ts')]: SRC_BEFORE }))
    const control = await ctl.prove({
      run: RUN,
      claim: { ...CLAIM, file: 'src/limit.ts', control: ['node', '--run', 'test-all', '--test'] },
    })
    expect(control.reason).toContain('claim.control must be a test invocation')

    // POSITIVE CONTROL: the legal spelling is untouched, so this is not "no node
    // guard is legal" — without it every assertion above passes on a shape check
    // that refuses node outright.
    const { prover: ok } = proverOver({}, memFs({ [join(proofWorktreePath('/repo', RUN), 'src/limit.ts')]: SRC_BEFORE }))
    const fine = await ok.prove({
      run: RUN,
      claim: { ...CLAIM, file: 'src/limit.ts', guard: ['node', '--test', 'tests/other.test.mjs'] },
    })
    expect(fine.reason).not.toContain('must be a test invocation')
    expect(fine.observed).not.toBeNull()
  })

  test('`node <script> --test <unrelated>` runs the SCRIPT — only a LEADING `--test` is a test invocation', async () => {
    // THE BYPASS THIS CLOSES, the wrapper family with no option to name it.
    // Node enters test-runner mode only when `--test` is one of ITS OWN
    // options, i.e. before the entry script; written AFTER one it is an
    // ordinary argument node hands straight to the script (verified on v22.23:
    // the script prints `argv=["--test"]`). The shape check asked only whether
    // `--test` appeared ANYWHERE, so `node tests/wrap.mjs --test
    // tests/other.test.mjs` passed it while running a BRANCH-AUTHORED entry
    // script — one line of `import '../src/limit.mjs'` away from reddening
    // under any syntax break with nothing asserting the mutated behaviour, and
    // driven to `proved: true` through the real prover. `runnerPrefixLength`
    // already assumed the leading spelling (`argv[1] === '--test' ? 2 : 1`);
    // the shape now agrees with it.
    for (const guard of [
      ['node', 'tests/wrap.mjs', '--test', 'tests/other.test.mjs'],
      // …the same wrapper with the script named as a relative path, which is how
      // a branch would actually write it,
      ['node', './tests/wrap.mjs', '--test', 'tests/other.test.mjs'],
      // …and with NOTHING after the option, so no later arm could refuse it for
      // the path it names: the shape is the only thing standing here.
      ['node', 'tests/wrap.mjs', '--test'],
    ]) {
      const fs = memFs({ [join(proofWorktreePath('/repo', RUN), 'src/limit.mjs')]: SRC_BEFORE })
      const { prover, host } = proverOver({}, fs)
      const out = await prover.prove({ run: RUN, claim: { ...CLAIM, file: 'src/limit.mjs', guard } })
      // Refused before anything was written or run.
      expect([guard.join(' '), out.proved, host.calls.length, fs.writes.length]).toEqual([guard.join(' '), false, 0, 0])
      expect([guard.join(' '), out.reason.includes('must be a test invocation')]).toEqual([guard.join(' '), true])
      // …and the refusal says WHERE `--test` has to go, so the next nomination
      // is not left guessing at the one shape that works.
      expect([guard.join(' '), out.reason.includes('--test FIRST')]).toEqual([guard.join(' '), true])
    }

    // The CONTROL is held to the same shape — it is executed too.
    const { prover: ctl } = proverOver({}, memFs({ [join(proofWorktreePath('/repo', RUN), 'src/limit.mjs')]: SRC_BEFORE }))
    const control = await ctl.prove({
      run: RUN,
      claim: { ...CLAIM, file: 'src/limit.mjs', control: ['node', 'tests/wrap.mjs', '--test'] },
    })
    expect(control.reason).toContain('claim.control must be a test invocation')

    // POSITIVE CONTROL: the canonical spelling still runs, options and all, so
    // this is not "no node guard is legal" — without it every assertion above
    // passes on a shape check that refuses node outright.
    const { prover: ok } = proverOver({}, memFs({ [join(proofWorktreePath('/repo', RUN), 'src/limit.mjs')]: SRC_BEFORE }))
    const fine = await ok.prove({
      run: RUN,
      claim: {
        ...CLAIM,
        file: 'src/limit.mjs',
        guard: ['node', '--test', '--test-concurrency=1', 'tests/other.test.mjs'],
      },
    })
    expect(fine.reason).not.toContain('must be a test invocation')
    expect(fine.observed).not.toBeNull()
  })

  test('GO CARRIES A BRANCH-WRITTEN BODY ON ONE DASH — `-exec`, `-toolexec` and `-overlay` are load hooks', async () => {
    // THE BYPASS THIS CLOSES, the load-hook family in the spelling the `^--`
    // anchor cannot see. `go test -exec ./tests/wrap.sh ./pkg` runs the compiled
    // test binary THROUGH a program the branch wrote; `-toolexec` runs one for
    // every compile and link step; and `-overlay` hands the toolchain a JSON map
    // that REPLACES a source file's contents — the mutated file's included. Each
    // reddens an unrelated guard under a syntax break and greens it on restore
    // with nothing having asserted the mutated behaviour, and each walked
    // straight through: `SHORT_OPTION_WITH_ATTACHED_VALUE` reads `-exec` as `-e`
    // carrying `xec`, which matches no hook name and is skipped.
    for (const guard of [
      ['go', 'test', '-exec', './tests/wrap.sh', './pkg'],
      ['go', 'test', '-exec=./tests/wrap.sh', './pkg'],
      ['go', 'test', '-toolexec', './tests/tool.sh', './pkg'],
      ['go', 'test', '-toolexec=./tests/tool.sh', './pkg'],
      ['go', 'test', '-overlay', './tests/overlay.json', './pkg'],
      ['go', 'test', '-overlay=./tests/overlay.json', './pkg'],
      // …and NAMING NOTHING is still the hook, exactly as a valueless long
      // option is above: the file it reads is one this argv does not show.
      ['go', 'test', './pkg', '-overlay'],
    ]) {
      const fs = memFs({ [join(proofWorktreePath('/repo', RUN), 'src/limit.go')]: SRC_BEFORE })
      const { prover, host } = proverOver({}, fs)
      const out = await prover.prove({ run: RUN, claim: { ...CLAIM, file: 'src/limit.go', guard } })
      expect([guard.join(' '), out.proved, out.reason.includes('tautology'), host.calls.length]).toEqual([
        guard.join(' '),
        false,
        true,
        0,
      ])
      expect([guard.join(' '), out.reason.includes('whose body the branch wrote')]).toEqual([guard.join(' '), true])
      expect([guard.join(' '), fs.writes.length]).toEqual([guard.join(' '), 0])
    }

    // POSITIVE CONTROLS, because every assertion above would pass just as well
    // against "refuse every one-dash option go accepts":
    //  (1) an ordinary go flag whose value is not a body at all,
    //  (2) a flag whose NAME merely starts with one of the three,
    //  (3) the plain targeted invocation the refusal recommends.
    for (const guard of [
      ['go', 'test', '-count=1', './pkg/other'],
      ['go', 'test', '-execute-nothing=1', './pkg/other'],
      ['go', 'test', './pkg/other'],
    ]) {
      const fs = memFs({ [join(proofWorktreePath('/repo', RUN), 'src/limit.go')]: SRC_BEFORE })
      const { prover: ok } = proverOver({}, fs)
      const fine = await ok.prove({ run: RUN, claim: { ...CLAIM, file: 'src/limit.go', guard } })
      expect([guard.join(' '), fine.reason.includes('tautology')]).toEqual([guard.join(' '), false])
      // POSITIVE CONTROL ON THE EXTRACTION: the guard really ran.
      expect([guard.join(' '), fine.observed !== null]).toEqual([guard.join(' '), true])
    }
  })

  test('the CARRIED-VALUE arm answers in its own words, and the refusal is ONE sentence', async () => {
    // TWO THINGS AT ONCE, both of which a reviewer's mutant battery found open.
    // (1) THE ARM IS LOAD-BEARING. Neutralising `carriedValueReaching` — or
    // `extensionCompletions` inside it — left the whole suite green, because the
    // hook arm below re-refuses the SAME spellings with a vaguer reason and the
    // resolved-path seam catches the rest at proof time. Redundancy nobody has
    // pinned is redundancy that gets deleted, so the two reasons are told apart
    // here by name.
    // (2) THE REASON COMPOSES. Its caller appends "the mutated file <path> as
    // its own test", so a fragment carrying its own object read back as "loads
    // it via -rsrc, which names the directory holding it the mutated file
    // src/limit.ts as its own test" — the same wording-class bug already fixed
    // on the wrapper arm.
    for (const [arg, sentence] of [
      ['--preload=./src/limit', 'loads via --preload=./src/limit the mutated file src/limit.ts as its own test'],
      ['-rsrc', 'loads, via -rsrc naming the directory holding it, the mutated file src/limit.ts as its own test'],
    ] as const) {
      const fs = memFs({ [join(proofWorktreePath('/repo', RUN), 'src/limit.ts')]: SRC_BEFORE })
      const { prover, host } = proverOver({}, fs)
      const out = await prover.prove({
        run: RUN,
        claim: { ...CLAIM, file: 'src/limit.ts', guard: ['bun', 'test', arg, 'tests/other.test.ts'] },
      })
      expect([arg, out.proved, host.calls.length]).toEqual([arg, false, 0])
      // The whole sentence, not a substring of it: this is what the next build reads.
      expect([arg, out.reason.includes(sentence)]).toEqual([arg, true])
      // …and it is NOT the hook arm's wording, which is what the neutralised
      // versions of both helpers fell back to.
      expect([arg, out.reason.includes('whose body the branch wrote')]).toEqual([arg, false])
    }
  })

  test("an OPTION'S VALUE NEED NOT WRITE THE EXTENSION — `--preload=./src/limit` loads `src/limit.ts`", async () => {
    // THE BYPASS, reproduced end to end on bun 1.3.x. A loader completes a bare
    // specifier from its extension list and falls back to a directory's
    // `index`, so FIVE spellings of "preload the mutated file" wrote a path that
    // equalled no repo-relative target and named nothing on disk: the lexical
    // arms compared written spellings and missed every one, `guardPathCandidates`
    // ENOENTed on `src/limit` and dropped it, and the directory arm that WOULD
    // have caught `--preload=./src` was gated behind `aRunnerMayCollect`, which
    // a production module never satisfies. Red mutated, green restored,
    // `proved: true`, with the mutated file supplying both halves itself.
    for (const arg of [
      '--preload=./src/limit',
      '-r./src/limit',
      '--preload=./src',
      '--preload=./src/',
      '--preload=./src/index',
    ]) {
      const fs = memFs({ [join(proofWorktreePath('/repo', RUN), 'src/limit.ts')]: SRC_BEFORE })
      const { prover, host } = proverOver({}, fs)
      const out = await prover.prove({
        run: RUN,
        claim: { ...CLAIM, file: 'src/limit.ts', guard: ['bun', 'test', arg, 'tests/other.test.ts'] },
      })
      // The host must never be reached: a refused nomination runs no command.
      expect([arg, out.proved, out.reason.includes('tautology'), host.calls.length]).toEqual([arg, false, true, 0])
    }

    // POSITIVE CONTROLS, three of them, because every assertion above would pass
    // just as well against "refuse every option that carries a word".
    //  (1) a bare specifier for a DIFFERENT module,
    //  (2) a DIRECTORY that does not hold the mutated file,
    //  (3) an option whose value is not a path at all.
    for (const arg of ['--grep=./tests/setup', '--grep=./tests', '--reporter-outfile=report.xml']) {
      const fs = memFs({ [join(proofWorktreePath('/repo', RUN), 'src/limit.ts')]: SRC_BEFORE })
      const { prover: ok } = proverOver({}, fs)
      const fine = await ok.prove({
        run: RUN,
        claim: { ...CLAIM, file: 'src/limit.ts', guard: ['bun', 'test', arg, 'src/other.test.ts'] },
      })
      expect([arg, fine.reason.includes('tautology')]).toEqual([arg, false])
      expect(fine.observed).not.toBeNull()
    }
  })

  test("a SPACE is a separator too — `--preload ./src` is `--preload=./src`", async () => {
    // THE BYPASS, reproduced against the branch prover with real git and real
    // bun: `--preload=./src` was refused and the IDENTICAL `--preload ./src`
    // came back `ok: true, proved: true`. `carriedValue` reads only the
    // `=`-joined and attached-short spellings, so a value written after a space
    // is one more positional to every arm here — while bun loads the mutated
    // PRODUCTION module into the guard's own process just the same. Each
    // spelling below is the `=` form of the test above with one character
    // changed.
    for (const guard of [
      ['--preload', './src/limit'],
      ['--preload', './src'],
      ['--preload', './src/'],
      ['--preload', './src/index'],
    ]) {
      const fs = memFs({ [join(proofWorktreePath('/repo', RUN), 'src/limit.ts')]: SRC_BEFORE })
      const { prover, host } = proverOver({}, fs)
      const out = await prover.prove({
        run: RUN,
        claim: { ...CLAIM, file: 'src/limit.ts', guard: ['bun', 'test', ...guard, 'tests/other.test.ts'] },
      })
      // Refused before a command ran, and the refusal quotes BOTH elements —
      // an argument nobody wrote (`./src` alone) would send the next build
      // looking for the wrong thing.
      expect([guard.join(' '), out.proved, out.reason.includes('tautology'), host.calls.length]).toEqual([
        guard.join(' '),
        false,
        true,
        0,
      ])
      expect(out.reason).toContain(guard.join(' '))
    }

    // …and the spellings that write the WHOLE path after the space are refused
    // by the arm that compares whole elements, which needs no separator at all.
    // Listed apart because their refusal quotes the FILE, not the two elements.
    for (const guard of [
      ['-r', './src/limit.ts'],
      ['--import', './src/limit.ts'],
    ]) {
      const fs = memFs({ [join(proofWorktreePath('/repo', RUN), 'src/limit.ts')]: SRC_BEFORE })
      const { prover, host } = proverOver({}, fs)
      const out = await prover.prove({
        run: RUN,
        claim: { ...CLAIM, file: 'src/limit.ts', guard: ['bun', 'test', ...guard, 'tests/other.test.ts'] },
      })
      expect([guard.join(' '), out.proved, out.reason.includes('tautology'), host.calls.length]).toEqual([
        guard.join(' '),
        false,
        true,
        0,
      ])
    }

    // POSITIVE CONTROLS, because every assertion above would pass just as well
    // against "refuse any guard carrying two elements".
    //  (1) an option value that is not a path at all — the commonest spelling
    //      of all, and the one that would break every honest nomination;
    //  (2) a space-separated value naming a DIRECTORY that does not hold the
    //      mutated file;
    //  (3) the RUNNER'S OWN option, whose operand is the test file and not a
    //      loaded value: `node --test x.js` must survive, or node repos lose
    //      every guard they can spell.
    for (const guard of [
      ['bun', 'test', '--timeout', '30000', 'src/other.test.ts'],
      ['bun', 'test', '--grep', './tests', 'src/other.test.ts'],
      ['node', '--test', 'src/other.test.js'],
    ]) {
      const fs = memFs({ [join(proofWorktreePath('/repo', RUN), 'src/limit.ts')]: SRC_BEFORE })
      const { prover: ok } = proverOver({}, fs)
      const fine = await ok.prove({ run: RUN, claim: { ...CLAIM, file: 'src/limit.ts', guard } })
      expect([guard.join(' '), fine.reason.includes('tautology')]).toEqual([guard.join(' '), false])
      expect(fine.observed).not.toBeNull()
    }
  })

  test('a WRAPPER hides its command line, so it is no guard for a production target either', async () => {
    // THE BYPASS TWO REVIEWERS REPRODUCED. `npm run test:unit` says nothing
    // about what it runs; with `"test:unit": "bun test --preload=./src/limit.ts
    // tests/other.test.ts"` in the branch's own `package.json` it loads the
    // mutated PRODUCTION file into a process running an unrelated test, and a
    // syntax-shaped mutation reddens it with nothing asserting the mutated
    // behaviour. Every arm above reads argv; the body is not in argv. A
    // COLLECTIBLE target already refused every wrapper — the production half is
    // the one that was open, and it is closed by refusing the shape.
    for (const guard of [
      ['npm', 'run', 'test:unit'],
      ['npm', 'test'],
      ['pnpm', 'run', 'test:unit'],
      ['yarn', 'run', 'test-ci'],
      ['make', 'test-unit'],
      // …and with a real test file named beside it, which is the shape that
      // reads most like an honest targeted guard.
      ['npm', 'run', 'test:unit', 'src/other.test.ts'],
    ]) {
      const fs = memFs({ [join(proofWorktreePath('/repo', RUN), 'src/limit.ts')]: SRC_BEFORE })
      const { prover, host } = proverOver({}, fs)
      const out = await prover.prove({ run: RUN, claim: { ...CLAIM, file: 'src/limit.ts', guard } })
      expect([guard.join(' '), out.proved, out.reason.includes('tautology'), host.calls.length]).toEqual([
        guard.join(' '),
        false,
        true,
        0,
      ])
      expect(out.reason).toContain('whose script body the branch wrote')
    }

    // POSITIVE CONTROLS.
    //  (1) the spelling the refusal recommends — the runner that actually runs
    //      the test — is still a guard, so this is not "no guard is legal";
    //  (2) a wrapper as the CONTROL is untouched: the tautology is about what
    //      the GUARD loads, and the control's job is only to stay green.
    const fs = memFs({ [join(proofWorktreePath('/repo', RUN), 'src/limit.ts')]: SRC_BEFORE })
    const { prover: ok } = proverOver({}, fs)
    const fine = await ok.prove({
      run: RUN,
      claim: { ...CLAIM, file: 'src/limit.ts', guard: ['bun', 'test', 'src/limit.test.ts'] },
    })
    expect(fine.reason).not.toContain('tautology')
    expect(fine.observed).not.toBeNull()
    const { prover: ok2 } = proverOver({}, memFs({ [join(proofWorktreePath('/repo', RUN), 'src/limit.ts')]: SRC_BEFORE }))
    const asControl = await ok2.prove({
      run: RUN,
      claim: { ...CLAIM, file: 'src/limit.ts', control: ['npm', 'run', 'test:unit'] },
    })
    expect(asControl.reason).not.toContain('tautology')
    expect(asControl.observed).not.toBeNull()
  })

  test("a POSITIONAL directory is still legal for a production target — the ungating is the OPTION's alone", async () => {
    // THE CONTROL THAT BOUNDS THE FIX ABOVE. `--preload=./src` is refused
    // because an option's value is LOADED; `bun test src/` is a DISCOVERY root,
    // and discovery never runs `src/limit.ts` — so ungating the directory arm
    // for positionals too would have refused every whole-directory guard a
    // production module is entitled to. This is the assertion that fails if the
    // `candidate.carried` condition is widened to `true`.
    for (const dir of ['src', 'src/']) {
      const fs = memFs({ [join(proofWorktreePath('/repo', RUN), 'src/limit.ts')]: SRC_BEFORE })
      const { prover: ok } = proverOver({}, fs)
      const fine = await ok.prove({
        run: RUN,
        claim: { ...CLAIM, file: 'src/limit.ts', guard: ['bun', 'test', dir] },
      })
      expect([dir, fine.reason.includes('tautology')]).toEqual([dir, false])
      expect(fine.observed).not.toBeNull()
    }
  })

  test('a LOADER-REWRITTEN candidate refuses at the SAME-STEM boundary too — pinned as an over-refusal', async () => {
    // The rewrite `clamp.js -> clamp.ts` is pushed unconditionally, so with BOTH
    // files really on disk the guard that names the real `clamp.js` is refused
    // for a collision the loader would never make. That is an over-refusal, it
    // fails CLOSED, and it is pinned here rather than left to a docblock that
    // used to claim the opposite ("a guard that names a `.js` file which really
    // exists ... is untouched"). If the seam ever grows an existence check, this
    // is the assertion that has to change with it — deliberately, not silently.
    //
    // THE OPTION CARRYING THE VALUE IS DELIBERATELY NOT A LOAD HOOK. Written
    // with `--preload=` this assertion was VACUOUS: `loadHookCarrying` refuses
    // that shape on its spelling alone, so every line below held whether or not
    // the loader-rewrite candidate existed at all. `--grep=` carries a value the
    // same way and is refused by no shape rule, so the refusal can only come
    // from the resolved seam this test claims to pin — delete the `loaderRewrites`
    // push in `guardPathCandidates` and this test goes red, which is the whole
    // point of writing it down.
    const wt = proofWorktreePath('/repo', RUN)
    const fs = memFs({
      [join(wt, 'tests/support/clamp.ts')]: SRC_BEFORE,
      [join(wt, 'tests/support/clamp.js')]: SRC_BEFORE,
    })
    const { prover } = proverOver({}, fs)
    const out = await prover.prove({
      run: RUN,
      claim: {
        ...CLAIM,
        file: 'tests/support/clamp.ts',
        guard: ['bun', 'test', '--grep=./tests/support/clamp.js', 'tests/separate.test.ts'],
      },
    })
    // The refusal comes from the RESOLVED seam, which runs inside the proof
    // worktree — so unlike the lexical arms it has already set one up. What must
    // not happen is the GUARD running, and `observed` stays null when it did not.
    expect([out.proved, out.reason.includes('tautology'), out.observed]).toEqual([false, true, null])

    // POSITIVE CONTROL — a DIFFERENT stem beside the mutated one is untouched,
    // so the assertion above is about the stem and not about `.js` as such.
    const fs2 = memFs({ [join(wt, 'tests/support/clamp.ts')]: SRC_BEFORE })
    const { prover: ok } = proverOver({}, fs2)
    const fine = await ok.prove({
      run: RUN,
      claim: {
        ...CLAIM,
        file: 'tests/support/clamp.ts',
        guard: ['bun', 'test', '--grep=./tests/support/unrelated.js', 'tests/separate.test.ts'],
      },
    })
    expect(fine.reason).not.toContain('tautology')
    expect(fine.observed).not.toBeNull()
  })

  test('a DOTTED SELECTOR still refuses PAST the expansion cap — a 30-deep target is not a bypass', async () => {
    // THE BYPASS THE CAP OPENED. `modulePathsOf` stopped expanding at 24
    // prefixes, and its docblock justified that as fail-closed: "a prefix deeper
    // than the target's own directory nesting can never equal it". That holds
    // only while the TARGET is shallower than 24 — and `claim.file` is written
    // by the same build that writes the diff, so a tree nested 30 directories
    // deep is a thing a branch can simply commit. At that depth the matching
    // prefix sat past the cap, the truncated expansion matched nothing, and the
    // dotted arm fell open on exactly the input that was trying to defeat it.
    // The spelling comparison is linear now (`dottedModuleReaches`) and has no
    // depth at which it stops answering.
    const deepDirs = Array.from({ length: 30 }, (_, i) => `d${i}`)
    const file = `${deepDirs.join('/')}/limit.py`
    const dotted = `${deepDirs.join('.')}.limit`
    for (const selector of [dotted, `${dotted}.LimitTest.test_under`]) {
      const fs = memFs({ [join(proofWorktreePath('/repo', RUN), file)]: SRC_BEFORE })
      const { prover, host } = proverOver({}, fs)
      const out = await prover.prove({
        run: RUN,
        claim: {
          ...CLAIM,
          file,
          guard: ['python3', '-m', 'unittest', selector],
          control: ['python3', '-m', 'pytest', 'tests/other_test.py'],
        },
      })
      expect([out.proved, out.reason.includes('IMPORTS'), host.calls.length]).toEqual([false, true, 0])
    }

    // POSITIVE CONTROL — a SIBLING module at the same absurd depth is a separate
    // test and stays legal, so the rule above is matching the stem rather than
    // refusing every long dotted word. Without this, an implementation that
    // refused all over-depth selectors would pass the assertions above.
    const fs = memFs({ [join(proofWorktreePath('/repo', RUN), file)]: SRC_BEFORE })
    const { prover: ok } = proverOver({}, fs)
    const fine = await ok.prove({
      run: RUN,
      claim: { ...CLAIM, file, guard: ['python3', '-m', 'unittest', `${deepDirs.join('.')}.test_limit`] },
    })
    expect(fine.reason).not.toContain('tautology')
    expect(fine.observed).not.toBeNull()

    // …and the near-miss stays a near-miss: `d0.d1….limits` is a DIFFERENT
    // module and the dot is required, so a prefix match is not a substring match.
    const fs3 = memFs({ [join(proofWorktreePath('/repo', RUN), file)]: SRC_BEFORE })
    const { prover: ok3 } = proverOver({}, fs3)
    const near = await ok3.prove({
      run: RUN,
      claim: { ...CLAIM, file, guard: ['python3', '-m', 'unittest', `${dotted}s`] },
    })
    expect(near.reason).not.toContain('tautology')
  })

  test("an OPTION'S OPERAND is not a path — `bun test --timeout 1000` names no test", async () => {
    // THE BYPASS: read element-wise, `1000` looked like a path argument, so the
    // argv looked TARGETED and the no-path arm never fired — while the runner
    // discovered the whole suite and ran the mutated file as its own guard.
    for (const guard of [
      ['bun', 'test', '--timeout', '1000'],
      ['bun', 'test', '--timeout=1000'],
      // NOT `--reporter junit`, though that is the shape this row was written
      // with: a reporter is now refused on its SPELLING by `loadHookCarrying`,
      // which fires before this arm, so the row would have passed for a reason
      // that has nothing to do with the operand it claims to be about.
      // `--bail 3` carries a non-path operand and no shape rule touches it.
      ['bun', 'test', '--bail', '3'],
    ]) {
      const file = 'src/thing_test.ts'
      const fs = memFs({ [join(proofWorktreePath('/repo', RUN), file)]: SRC_BEFORE })
      const { prover } = proverOver({}, fs)
      const out = await prover.prove({
        run: RUN,
        claim: { ...CLAIM, file, guard, control: ['bun', 'test', 'src/other.test.ts'] },
      })
      expect([guard.join(' '), out.proved, out.reason.includes('tautology')]).toEqual([guard.join(' '), false, true])
    }

    // …and an option's SEPARATED operand is the option's, not a selection.
    // `--bail tests/support/lib.test.ts` is spelled exactly like
    // `--reporter-outfile out/report.test.ts`, which is a file bun WRITES while
    // it discovers everything; arity is a vocabulary, so this fails CLOSED and
    // refuses both.
    const file = 'tests/support/lib.ts'
    const swallowed = memFs({ [join(proofWorktreePath('/repo', RUN), file)]: SRC_BEFORE })
    const { prover: strict } = proverOver({}, swallowed)
    const refused = await strict.prove({
      run: RUN,
      claim: { ...CLAIM, file, guard: ['bun', 'test', '--bail', 'tests/support/lib.test.ts'] },
    })
    expect(refused.reason).toContain('tautology')
    expect(swallowed.writes).toEqual([])

    // POSITIVE CONTROL — the over-refusal is spellable around, so the class
    // this branch adds is not blocked: the SAME guard with the path before the
    // options, or with the option carrying its own value, is a selection again.
    for (const guard of [
      ['bun', 'test', 'tests/support/lib.test.ts', '--bail'],
      ['bun', 'test', '--bail=1', 'tests/support/lib.test.ts'],
    ]) {
      const fs = memFs({ [join(proofWorktreePath('/repo', RUN), file)]: SRC_BEFORE })
      const { prover: ok } = proverOver({}, fs)
      const fine = await ok.prove({ run: RUN, claim: { ...CLAIM, file, guard } })
      expect([guard.join(' '), fine.reason.includes('tautology')]).toEqual([guard.join(' '), false])
      expect(fine.observed).not.toBeNull()
    }
  })

  test("a RUNNER SCRIPT NAME is not a path — `make test-py` and `npm run test-all` name no test", async () => {
    // THE BYPASS: the runner's own leading tokens were dropped by a fixed
    // VOCABULARY, and a script/target name is arbitrary (`test-py`, `test-all`,
    // `test:unit`). So it sat where a path goes, the argv looked targeted, and a
    // whole-suite discovery run served as a guard for a file it collects. Only
    // its POSITION can identify it, which is what `runnerPrefixLength` reads.
    const file = 'tests/support/lib.ts'
    for (const guard of [
      ['make', 'test-py'],
      ['npm', 'run', 'test-all'],
      ['yarn', 'run', 'test-ci'],
      ['pnpm', 'run', 'test:unit'],
      ['npm', 'test'],
    ]) {
      const fs = memFs({ [join(proofWorktreePath('/repo', RUN), file)]: SRC_BEFORE })
      const { prover } = proverOver({}, fs)
      const out = await prover.prove({
        run: RUN,
        claim: { ...CLAIM, file, guard, control: ['bun', 'test', 'src/other.test.ts'] },
      })
      expect([guard.join(' '), out.proved, out.reason.includes('tautology')]).toEqual([guard.join(' '), false, true])
    }

    // …AND THE SAME SCRIPT NAME FOLLOWED BY A REAL PATH IS NOT A TARGETED RUN
    // EITHER. This shape was pinned as LEGAL and it forges a proof: npm
    // forwards the positional to the script's own command line WITHOUT `--`
    // (reproduced on npm 10.9.8), and a branch-authored script ending in a
    // shell comment — `"test-all": "bun test #"` — swallows it, leaving
    // whole-suite discovery that collects the mutated library and runs it as
    // its own guard. The `--` arm already refused the separated spelling for
    // exactly this reason; this is the same forwarding without the separator.
    for (const guard of [
      ['npm', 'run', 'test-all', 'tests/support/lib.test.ts'],
      ['pnpm', 'test', 'tests/support/lib.test.ts'],
      ['yarn', 'run', 'test-ci', 'tests/support/lib.test.ts'],
    ]) {
      const fs = memFs({ [join(proofWorktreePath('/repo', RUN), file)]: SRC_BEFORE })
      const { prover } = proverOver({}, fs)
      const out = await prover.prove({
        run: RUN,
        claim: { ...CLAIM, file, guard, control: ['bun', 'test', 'src/other.test.ts'] },
      })
      expect([guard.join(' '), out.proved, out.reason.includes('tautology')]).toEqual([guard.join(' '), false, true])
      expect(out.reason).toContain('forwards it to whatever command')
    }

    // …AND `make` IS THE FOURTH WRAPPER, left off the first time and reproduced
    // by a reviewer: `make test-all tests/support/lib.test.ts` against a
    // `Makefile` whose `test-all` recipe is `bun test` came back `proved: true`
    // while every OTHER spelling of the same repo was refused. Make does not
    // forward the positional into the recipe — it reads it as a second GOAL, so
    // the recipe's whole-suite command line runs and the named file, which
    // exists on disk, is reported up to date. Different mechanism from npm's
    // forwarding, identical forgery, and the refusal must SAY the mechanism the
    // build wrote rather than blame a package.json it never had.
    for (const guard of [
      ['make', 'test-all', 'tests/support/lib.test.ts'],
      ['make', 'test', 'tests/support/lib.test.ts'],
    ]) {
      const fs = memFs({ [join(proofWorktreePath('/repo', RUN), file)]: SRC_BEFORE })
      const { prover, host } = proverOver({}, fs)
      const out = await prover.prove({
        run: RUN,
        claim: { ...CLAIM, file, guard, control: ['bun', 'test', 'src/other.test.ts'] },
      })
      expect([guard.join(' '), out.proved, out.reason.includes('tautology'), host.calls.length]).toEqual([
        guard.join(' '),
        false,
        true,
        0,
      ])
      expect(out.reason).toContain('second GOAL for make')
      expect(out.reason).toContain(`${guard[1] as string} recipe`)
      // The npm sentence would be a lie here — there is no package.json in this
      // argv, and telling the next build to look in one sends it to the wrong
      // file. This fails if the make arm is deleted and the npm arm inherits it.
      expect(out.reason).not.toContain('package.json')
    }

    // POSITIVE CONTROL — the over-refusal is spellable around, and it is scoped
    // to the forwarding programs: naming the same test file with the runner
    // that actually runs it is a targeted guard and stays legal. Without this
    // the assertions above would also pass if the gate had simply stopped
    // accepting any guard for a collectible target.
    const fs = memFs({ [join(proofWorktreePath('/repo', RUN), file)]: SRC_BEFORE })
    const { prover: ok } = proverOver({}, fs)
    const fine = await ok.prove({
      run: RUN,
      claim: { ...CLAIM, file, guard: ['bun', 'test', 'tests/support/lib.test.ts'] },
    })
    expect(fine.reason).not.toContain('tautology')
    expect(fine.observed).not.toBeNull()
  })

  test('a RECURSIVE SELECTOR is a search, not a path — `go test ./...` names nothing', async () => {
    // THE BYPASS: `./...` is go's whole-module selector. It normalizes to the
    // bare element `...`, which carries no glob character, so it was pushed as
    // a NAMED PATH — the argv looked targeted, the no-path arm never fired, and
    // a run that compiles and tests EVERY package (the mutated support library
    // among them) passed as a guard for that library.
    const file = 'tests/support/lib.ts'
    for (const guard of [
      ['go', 'test', './...'],
      ['go', 'test', '...'],
      ['go', 'test', './tests/...'],
      ['bun', 'test', './...'],
    ]) {
      const fs = memFs({ [join(proofWorktreePath('/repo', RUN), file)]: SRC_BEFORE })
      const { prover } = proverOver({}, fs)
      const out = await prover.prove({
        run: RUN,
        claim: { ...CLAIM, file, guard, control: ['bun', 'test', 'src/other.test.ts'] },
      })
      expect([guard.join(' '), out.proved, out.reason.includes('tautology')]).toEqual([guard.join(' '), false, true])
    }

    // POSITIVE CONTROL — a REAL directory under the same runner is still a
    // targeted guard, so the rule above cannot be refusing every go invocation.
    const fs = memFs({ [join(proofWorktreePath('/repo', RUN), file)]: SRC_BEFORE })
    const { prover: ok } = proverOver({}, fs)
    const fine = await ok.prove({ run: RUN, claim: { ...CLAIM, file, guard: ['go', 'test', './cmd/'] } })
    expect(fine.reason).not.toContain('tautology')
    expect(fine.observed).not.toBeNull()
  })

  test('an EXTENSION is not a selection — a report file and a bare filter name no test', async () => {
    // THE BYPASS: `looksLikeAPath` was the only filter, so anything ending in
    // an extension counted as "a path was named". `--reporter-outfile=report.xml`
    // and `--reporter junit.xml` are OUTPUT files of a WHOLE-SUITE run, and
    // `bun test thing` is a substring FILTER that runs every test whose path
    // contains it — `src/thing_test.ts` included. Each kept the no-path arm
    // from firing while the runner discovered the mutated file and ran it.
    for (const [file, guard] of [
      // SPELLED WITH THE OUTFILE ALONE, not with `--reporter=junit` beside it:
      // a reporter is refused on its spelling by `loadHookCarrying` now, which
      // fires before this arm and would have made both rows pass without ever
      // asking the question they are here to ask. `--reporter-outfile` names a
      // file the runner WRITES and is deliberately legal, so the only thing
      // that can refuse these is the no-selection arm this row pins.
      ['tests/support/lib.ts', ['bun', 'test', '--reporter-outfile=report.xml']],
      ['tests/support/lib.ts', ['bun', 'test', '--reporter-outfile', 'junit.xml']],
      ['src/thing_test.ts', ['bun', 'test', 'thing']],
      ['src/thing_test.ts', ['make', 'test', 'FOO=bar.out']],
    ] as const) {
      const fs = memFs({ [join(proofWorktreePath('/repo', RUN), file)]: SRC_BEFORE })
      const { prover } = proverOver({}, fs)
      const out = await prover.prove({
        run: RUN,
        claim: { ...CLAIM, file, guard: [...guard], control: ['bun', 'test', 'src/other.test.ts'] },
      })
      expect([guard.join(' '), out.proved, out.reason.includes('tautology')]).toEqual([guard.join(' '), false, true])
    }

    // POSITIVE CONTROLS — the same option beside a REAL test path is targeted,
    // and an option's own argument is still not swallowed. Without these the
    // assertions above could be passing because every guard is refused.
    const file = 'tests/support/lib.ts'
    for (const guard of [
      ['bun', 'test', '--reporter-outfile=report.xml', 'tests/support/lib.test.ts'],
      ['bun', 'test', 'tests/support/lib.test.ts', '--bail'],
      ['python3', '-m', 'pytest', 'tests/support/lib_test.py'],
    ]) {
      const fs = memFs({ [join(proofWorktreePath('/repo', RUN), file)]: SRC_BEFORE })
      const { prover: ok } = proverOver({}, fs)
      const fine = await ok.prove({ run: RUN, claim: { ...CLAIM, file, guard } })
      expect([guard.join(' '), fine.reason.includes('tautology')]).toEqual([guard.join(' '), false])
      expect(fine.observed).not.toBeNull()
    }
  })

  test('an ATTACHED SHORT OPTION carries a path too — `-r./lib.ts` is `--preload=./lib.ts`', async () => {
    // THE BYPASS: a short option takes its value with NO separator at all, and
    // bun honours it (`bun test -r./tests/side.ts tests/ok.test.ts` runs the
    // preloaded side effect). Read as a whole element `-r./tests/support/lib.ts`
    // equals no path; read by the `=` rule it carries nothing. So the mutated
    // file was loaded into the very process running the guard, and every
    // defense above looked straight past it.
    const file = 'tests/support/lib.ts'
    for (const arg of ['-r./tests/support/lib.ts', '-rtests/support/lib.ts', '-r=tests/support/lib.ts']) {
      const fs = memFs({ [join(proofWorktreePath('/repo', RUN), file)]: SRC_BEFORE })
      const { prover, host } = proverOver({}, fs)
      const out = await prover.prove({
        run: RUN,
        claim: { ...CLAIM, file, guard: ['bun', 'test', arg, 'tests/other.test.ts'] },
      })
      expect([arg, out.proved, out.reason.includes('tautology'), host.calls.length]).toEqual([arg, false, true, 0])
    }

    // …and the attached form hides an ESCAPING path just as well, behind the
    // option letter, where the leading `/`, the `..` and the URL scheme all
    // stop being the first character of the element.
    const abs = `${proofWorktreePath('/repo', RUN)}/${CLAIM.file}`
    for (const arg of [`-r${abs}`, '-r../elsewhere/lib.ts', `-rfile://${abs}`]) {
      const { prover, host } = proverOver()
      const out = await prover.prove({ run: RUN, claim: { ...CLAIM, guard: ['bun', 'test', arg, 'src/other.test.ts'] } })
      expect([arg, out.proved, host.calls.length]).toEqual([arg, false, 0])
      expect(out.reason).toContain('must be a repo-relative path inside the worktree')
    }

    // POSITIVE CONTROL — an attached short option carrying a DIFFERENT,
    // repo-relative file is untouched, so the rule cannot be refusing every
    // short option it sees.
    const fs = memFs({ [join(proofWorktreePath('/repo', RUN), file)]: SRC_BEFORE })
    const { prover: ok } = proverOver({}, fs)
    const fine = await ok.prove({
      run: RUN,
      claim: { ...CLAIM, file, guard: ['bun', 'test', '-g./tests/setup.ts', 'tests/support/lib.test.ts'] },
    })
    expect(fine.reason).not.toContain('tautology')
    expect(fine.reason).not.toContain('repo-relative')
    expect(fine.observed).not.toBeNull()
  })

  test('a ONE-TOKEN filter is still the mutated file — a bare word, and an operand after a value-less option', async () => {
    // THE BYPASS, and it is the whole gate in one word. The arms that ask "does
    // the run REACH the mutated file?" read `pathArgs` — which DROPS a bare word
    // (no separator, no extension) and DROPS the operand after a value-less
    // option, because as a SELECTOR neither can be recognised safely. So
    // `bun test tests/other-control.test.ts helper_test` presented a real
    // selector (the control test), never fired the no-path arm, and handed bun a
    // substring filter that collects `tests/support/helper_test.ts` — the
    // mutated file — as its own guard. Red mutated, green restored, "proved".
    const file = 'tests/support/helper_test.ts'
    for (const guard of [
      ['bun', 'test', 'tests/other-control.test.ts', 'helper_test'],
      ['bun', 'test', 'tests/other-control.test.ts', '--coverage', 'helper_test.ts'],
      ['bun', 'test', '--coverage', 'helper_test.ts', 'tests/other-control.test.ts'],
      ['bun', 'test', 'tests/other-control.test.ts', 'support/helper_test'],
    ]) {
      const fs = memFs({ [join(proofWorktreePath('/repo', RUN), file)]: SRC_BEFORE })
      const { prover, host } = proverOver({}, fs)
      const out = await prover.prove({
        run: RUN,
        claim: { ...CLAIM, file, guard, control: ['bun', 'test', 'src/other.test.ts'] },
      })
      // Refused on the SPELLING, before a byte was written or a command run.
      expect([guard.join(' '), out.proved, out.reason.includes('tautology'), host.calls.length, fs.writes.length]).toEqual([guard.join(' '), false, true, 0, 0])
    }

    // POSITIVE CONTROLS — a bare word the mutated path does NOT contain is not a
    // filter that reaches it, and the option operand rule is unchanged for one.
    // Without these the assertions above would pass just as well if every extra
    // operand refused, which would close the class this branch exists to open.
    for (const guard of [
      ['bun', 'test', 'tests/other-control.test.ts', 'unrelated'],
      ['bun', 'test', 'tests/other-control.test.ts', '--coverage', 'src/'],
    ]) {
      const fs = memFs({ [join(proofWorktreePath('/repo', RUN), file)]: SRC_BEFORE })
      const { prover: ok } = proverOver({}, fs)
      const fine = await ok.prove({ run: RUN, claim: { ...CLAIM, file, guard } })
      expect([guard.join(' '), fine.reason.includes('tautology')]).toEqual([guard.join(' '), false])
      expect(fine.observed).not.toBeNull()
    }
  })

  test("an option's OPERAND reaches a DIRECTORY too — `--coverage src/` collects the mutated file", async () => {
    // The same drop, read through the directory arm rather than the filter one:
    // `bun test tests/a.test.ts --coverage src/` names `src/` as an operand, and
    // the mutated `src/thing_test.ts` sits under it. Only the resolution seam
    // caught this, and only when the directory happened to exist on disk.
    const file = 'src/thing_test.ts'
    const fs = memFs({ [join(proofWorktreePath('/repo', RUN), file)]: SRC_BEFORE })
    const { prover } = proverOver({}, fs)
    const out = await prover.prove({
      run: RUN,
      claim: { ...CLAIM, file, guard: ['bun', 'test', 'tests/a.test.ts', '--coverage', 'src/'] },
    })
    expect([out.proved, out.reason.includes('tautology'), out.reason.includes('directory')]).toEqual([false, true, true])
  })

  test('a NUMERIC option value is not a filter — `--timeout=1` must not refuse tests/support/v1.ts', async () => {
    // THE OVER-REFUSAL: the filter arm compared every carried value against the
    // target as a substring, and `--timeout=1` carries `1`, which
    // `tests/support/v1.ts` contains. An honest nomination of that library —
    // guarded by its own separate test — was refused for a tautology nobody
    // wrote, and there was no spelling around it. A runner matches a filter
    // against a PATH; an element with no letter in it is an option's argument.
    const file = 'tests/support/v1.ts'
    for (const guard of [
      ['bun', 'test', '--timeout=1', 'tests/support/v1.test.ts'],
      ['bun', 'test', 'tests/support/v1.test.ts', '--timeout=1'],
      ['bun', 'test', '--timeout', '1', 'tests/support/v1.test.ts'],
    ]) {
      const fs = memFs({ [join(proofWorktreePath('/repo', RUN), file)]: SRC_BEFORE })
      const { prover } = proverOver({}, fs)
      const fine = await prover.prove({ run: RUN, claim: { ...CLAIM, file, guard } })
      expect([guard.join(' '), fine.reason.includes('tautology')]).toEqual([guard.join(' '), false])
      expect(fine.observed).not.toBeNull()
    }

    // …and the arm itself still fires: a filter that carries a LETTER and that
    // the mutated path contains is the same tautology it always was.
    const fs = memFs({ [join(proofWorktreePath('/repo', RUN), file)]: SRC_BEFORE })
    const { prover: strict } = proverOver({}, fs)
    const out = await strict.prove({
      run: RUN,
      claim: { ...CLAIM, file, guard: ['bun', 'test', 'tests/other.test.ts', 'v1'] },
    })
    expect([out.proved, out.reason.includes('tautology')]).toEqual([false, true])
  })

  test('a DOTTED MODULE is a path spelled with dots — `python3 -m unittest src.limit` imports the mutated file', async () => {
    // THE BYPASS: `src.limit` is not `src/limit.py` to any string comparison, so
    // the naming arm missed it; `src/limit.py` is PRODUCTION, so the collectible
    // arms never ran; and it names nothing on disk, so the resolved seam dropped
    // it too. Meanwhile unittest IMPORTS the module — a syntax-breaking mutation
    // of the file makes the command red and its restore green, and the mutated
    // file has served as its own guard against an assertion-free "separate"
    // test. Every dotted PREFIX counts, because the selector keeps going after
    // the module name (`src.limit.LimitTest.test_under` imports it just the same).
    for (const [file, guard] of [
      ['src/limit.py', ['python3', '-m', 'unittest', 'src.limit']],
      ['src/limit.py', ['python3', '-m', 'unittest', 'src.limit.LimitTest.test_under']],
      ['src/limit.py', ['python3', '-m', 'pytest', '--pyargs', 'src.limit']],
      ['src/limit/__init__.py', ['python3', '-m', 'unittest', 'src.limit']],
      ['limit.py', ['python3', '-m', 'unittest', 'limit']],
    ] as const) {
      const fs = memFs({ [join(proofWorktreePath('/repo', RUN), file)]: SRC_BEFORE })
      const { prover, host } = proverOver({}, fs)
      const out = await prover.prove({
        run: RUN,
        claim: { ...CLAIM, file, guard: [...guard], control: ['python3', '-m', 'pytest', 'tests/other_test.py'] },
      })
      expect([guard.join(' '), out.proved, out.reason.includes('tautology'), host.calls.length]).toEqual([guard.join(' '), false, true, 0])
      expect(out.reason).toContain('IMPORTS')
    }

    // POSITIVE CONTROL — a DIFFERENT module is a separate test and stays legal,
    // as does the path spelling of one. Without these the rule above would read
    // as "no python guard is ever accepted".
    for (const guard of [
      ['python3', '-m', 'unittest', 'tests.test_limit'],
      ['python3', '-m', 'pytest', 'tests/test_limit.py'],
    ]) {
      const file = 'src/limit.py'
      const fs = memFs({ [join(proofWorktreePath('/repo', RUN), file)]: SRC_BEFORE })
      const { prover: ok } = proverOver({}, fs)
      const fine = await ok.prove({ run: RUN, claim: { ...CLAIM, file, guard } })
      expect([guard.join(' '), fine.reason.includes('tautology')]).toEqual([guard.join(' '), false])
      expect(fine.observed).not.toBeNull()
    }

    // AND THE EXPANSION IS BOUNDED IN THE ELEMENT IT READS. Every dotted prefix
    // is expanded into a fresh string, so expanding ALL of them costs the sum of
    // their lengths — quadratic in an argv element that arrives from an
    // unbounded, agent-authored nomination and is read inside the single-flight
    // tick. Measured on this box: 40 000 segments took 8486ms.
    //
    // The bound is paired with the REFUSAL, in one call, because a cap that
    // fails open is the cheap way to make the timing pass: `src.limit` is the
    // SECOND prefix of this selector, so an implementation that dropped the
    // element on length would be fast AND would stop seeing the import. Both
    // assertions must hold together.
    const buried = ['src', 'limit', ...Array(40_000).fill('a')].join('.')
    const deepFs = memFs({ [join(proofWorktreePath('/repo', RUN), 'src/limit.py')]: SRC_BEFORE })
    const { prover: bounded } = proverOver({}, deepFs)
    const started = Date.now()
    const scanned = await bounded.prove({
      run: RUN,
      claim: {
        ...CLAIM,
        file: 'src/limit.py',
        guard: ['python3', '-m', 'unittest', buried],
        control: ['python3', '-m', 'pytest', 'tests/other_test.py'],
      },
    })
    // WALL-CLOCK-BOUND-OK: an unbounded prefix expansion has no non-timing
    // signature — the capped and uncapped expansions return the SAME answer on
    // this input (both contain `src/limit.py`, asserted directly below), so the
    // only observable difference between them is how long the expansion takes,
    // and there is no logical clock inside a string join to read instead.
    // Measured on this box at 40 000 segments: capped 2ms, uncapped 8486ms
    // (10k 546ms, 20k 2131ms — quadratic, 4x per doubling). The bound sits at
    // 3s: ~1500x headroom over the passing path and a 2.8x margin under the
    // failing one, matching the scheme-scan pin above.
    expect(Date.now() - started).toBeLessThan(3_000)
    // …and the cap is on prefix DEPTH, not on the element, so the real prefix
    // buried in the absurd selector is still expanded and still refuses. This
    // is the assertion that fails if the cap is turned into "drop the element".
    expect([scanned.proved, scanned.reason.includes('IMPORTS')]).toEqual([false, true])
  })

  test('`node --test <path>` is a targeted guard — `--test` is the invocation, not an option', async () => {
    // THE DEAD END: `--test` is what makes node a test runner, but it was read
    // as an ordinary option, so the path AFTER it was dropped as that option's
    // operand. The selector list came back empty, the no-path arm fired, and
    // EVERY node guard for a collectible target was refused — with no other
    // spelling available, since `node <path> --test` is not test-runner mode.
    // That is the no-legal-nomination deadlock this card exists to remove,
    // rebuilt for node repos.
    const file = 'tests/support/lib.ts'
    const fs = memFs({ [join(proofWorktreePath('/repo', RUN), file)]: SRC_BEFORE })
    const { prover: ok } = proverOver({}, fs)
    const fine = await ok.prove({
      run: RUN,
      claim: { ...CLAIM, file, guard: ['node', '--test', 'tests/support/lib.test.ts'] },
    })
    expect(fine.reason).not.toContain('tautology')
    expect(fine.observed).not.toBeNull()

    // …and the arms it feeds are all still armed under the new prefix: a
    // whole-suite node run names no path, and a directory one collects the
    // library. Without these the fix above would read as "node is exempt".
    for (const guard of [
      ['node', '--test'],
      ['node', '--test', 'tests/'],
      ['node', '--test', '--concurrency', '2'],
    ]) {
      const swallowed = memFs({ [join(proofWorktreePath('/repo', RUN), file)]: SRC_BEFORE })
      const { prover } = proverOver({}, swallowed)
      const out = await prover.prove({
        run: RUN,
        claim: { ...CLAIM, file, guard, control: ['bun', 'test', 'src/other.test.ts'] },
      })
      expect([guard.join(' '), out.proved, out.reason.includes('tautology')]).toEqual([guard.join(' '), false, true])
    }
  })

  test('a QUERY, a FRAGMENT and a pytest NODE ID all name the mutated file', async () => {
    // THE BYPASS, in three spellings no path comparison could see. Node
    // EXECUTES a query-suffixed relative import — `node --test
    // --import=./src/limit.mjs?proof tests/other.test.mjs` loads the MUTATED
    // file into the very process that runs the guard (confirmed against node
    // v22) — and pytest IMPORTS the file its node ID selects. Neither spelling
    // equals the repo-relative target, so the naming arm missed both; both
    // targets are production, so the collectible arms never ran; and the `?`
    // was read as a GLOB, so even the on-disk seam skipped the element. A
    // syntax-breaking mutation then supplied its own RED and its restore its
    // own GREEN, and the gate recorded a proof.
    for (const [file, guard] of [
      ['src/limit.mjs', ['node', '--test', '--import=./src/limit.mjs?proof', 'tests/other.test.mjs']],
      ['src/limit.mjs', ['node', '--test', '--import=./src/limit.mjs#v2', 'tests/other.test.mjs']],
      ['src/limit.mjs', ['bun', 'test', '-r./src/limit.mjs?proof', 'tests/other.test.ts']],
      ['src/limit.py', ['python3', '-m', 'pytest', 'src/limit.py::test_probe']],
      ['src/limit.py', ['python3', '-m', 'pytest', 'src/limit.py::TestLimit::test_probe']],
      ['src/limit.py', ['python3', '-m', 'pytest', './src/limit.py::test_probe']],
    ] as const) {
      const fs = memFs({ [join(proofWorktreePath('/repo', RUN), file)]: SRC_BEFORE })
      const { prover, host } = proverOver({}, fs)
      const out = await prover.prove({
        run: RUN,
        claim: { ...CLAIM, file, guard: [...guard], control: ['bun', 'test', 'src/other.test.ts'] },
      })
      // Refused on the spelling, before a byte was written or a command run.
      expect([guard.join(' '), out.proved, out.reason.includes('tautology'), host.calls.length]).toEqual([
        guard.join(' '),
        false,
        true,
        0,
      ])
    }

    // POSITIVE CONTROLS — the same suffixes on a DIFFERENT file are untouched,
    // and a single colon is not a node ID. Without these the cut above would
    // read as "any guard carrying punctuation is refused", which would close
    // the class this branch exists to open.
    for (const [file, guard] of [
      ['src/limit.mjs', ['node', '--test', '--test-name-pattern=./tests/setup.mjs?once', 'tests/limit.test.mjs']],
      ['src/limit.py', ['python3', '-m', 'pytest', 'tests/limit_test.py::test_probe']],
      ['src/limit.ts', ['bun', 'test', 'tests/limit.test.ts', '--test-name-pattern=fast:path']],
    ] as const) {
      const fs = memFs({ [join(proofWorktreePath('/repo', RUN), file)]: SRC_BEFORE })
      const { prover: ok } = proverOver({}, fs)
      const fine = await ok.prove({ run: RUN, claim: { ...CLAIM, file, guard: [...guard] } })
      expect([guard.join(' '), fine.reason.includes('tautology')]).toEqual([guard.join(' '), false])
      expect(fine.observed).not.toBeNull()
    }
  })

  test('a NUMERIC POSITIONAL is a filter too — `bun test other.test.ts 123` reaches src/123_test.ts', async () => {
    // THE BYPASS: the filter arm required a LETTER, and asked it of every
    // element alike. `src/123_test.ts` is a LEGAL nomination — `TEST_BASENAME`
    // deliberately calls `_test.ts` production, so the name buys no exemption —
    // while bun COLLECTS it and reads a bare `123` as a substring filter over
    // the whole discovered suite (its positional filters are a union, verified
    // against the real runner). So the mutated file ran as its own guard with
    // nothing here able to see it.
    const file = 'src/123_test.ts'
    for (const guard of [
      ['bun', 'test', 'tests/other.test.ts', '123'],
      ['bun', 'test', 'tests/other.test.ts', '123_test'],
      ['bun', 'test', 'tests/other.test.ts', '3_te'],
    ]) {
      const fs = memFs({ [join(proofWorktreePath('/repo', RUN), file)]: SRC_BEFORE })
      const { prover, host } = proverOver({}, fs)
      const out = await prover.prove({
        run: RUN,
        claim: { ...CLAIM, file, guard, control: ['bun', 'test', 'src/other.test.ts'] },
      })
      expect([guard.join(' '), out.proved, out.reason.includes('filter'), host.calls.length]).toEqual([
        guard.join(' '),
        false,
        true,
        0,
      ])
    }

    // POSITIVE CONTROL, and it is the whole of the new distinction: the SAME
    // digits after a value-less option are that OPTION'S argument, not a filter
    // — `--timeout 123` is not a nomination of `src/123_test.ts`. Drop the
    // standalone test and this over-refuses every numeric option value, which
    // is the over-refusal the letter rule was introduced to fix.
    for (const guard of [
      ['bun', 'test', '--timeout', '123', 'tests/other.test.ts'],
      ['bun', 'test', '--timeout=123', 'tests/other.test.ts'],
    ]) {
      const fs = memFs({ [join(proofWorktreePath('/repo', RUN), file)]: SRC_BEFORE })
      const { prover: ok } = proverOver({}, fs)
      const fine = await ok.prove({ run: RUN, claim: { ...CLAIM, file, guard } })
      expect([guard.join(' '), fine.reason.includes('tautology')]).toEqual([guard.join(' '), false])
      expect(fine.observed).not.toBeNull()
    }
  })

  test('the no-selection refusal SAYS WHY, and names the element it dropped', async () => {
    // THE CARD'S OWN COMPLAINT, one level down. `bun test --coverage
    // tests/support/lib.test.ts` plainly names a path and was refused with "it
    // names no path" — true, useless, and blaming the build for an omission it
    // had no way to see. The rule that dropped the operand lived only in a
    // docblock, which is not where the next build looks. Every arm now names
    // the element and the spelling that works.
    const file = 'tests/support/lib.ts'
    const cases: Array<[string[], string]> = [
      [['bun', 'test', '--coverage', 'tests/support/lib.test.ts'], 'operand of --coverage'],
      // `--` IS NOT AN OPTION. It landed on the generic operand arm, which
      // advised "attach the option's own value (--=…)" — a spelling no runner
      // accepts, on the arm the canonical npm/yarn/pnpm idiom lands on. Same
      // closed refusal, a remedy that exists.
      [['npm', 'test', '--', 'tests/support/lib.test.ts'], 'sits after the `--` separator'],
      // cargo's whole story: `--test` takes a test TARGET name, so no guard
      // spelling selects for a collectible target under `tests/`. It fails
      // CLOSED and now SAYS so instead of implying an omission.
      [['cargo', 'test', '--test', 'integration'], 'operand of --test'],
      [['go', 'test', './...'], 'names a search'],
      // …and this one also PINS `looksLikeAPath`: without that filter `zz`
      // counts as a selection, the no-path arm never fires, and a whole-suite
      // run that collects the mutated library is accepted as its guard.
      [['bun', 'test', 'zz'], 'neither a directory separator nor an extension'],
      [['bun', 'test', 'report.xml'], 'not a name an allowlisted runner would RUN'],
      [['bun', 'test'], 'it names no path at all'],
    ]
    for (const [guard, why] of cases) {
      const fs = memFs({ [join(proofWorktreePath('/repo', RUN), file)]: SRC_BEFORE })
      const { prover } = proverOver({}, fs)
      const out = await prover.prove({
        run: RUN,
        claim: { ...CLAIM, file, guard, control: ['bun', 'test', 'src/other.test.ts'] },
      })
      expect([guard.join(' '), out.proved, out.reason.includes('tautology'), out.reason.includes(why)]).toEqual([
        guard.join(' '),
        false,
        true,
        true,
      ])
    }

    // …AND THE `--` ARM NO LONGER SPELLS THE IMPOSSIBLE REMEDY. Deleting the
    // arm brings `--=…` back and reddens this, which the substring assertion
    // above cannot do on its own.
    const dashFs = memFs({ [join(proofWorktreePath('/repo', RUN), file)]: SRC_BEFORE })
    const { prover: dashed } = proverOver({}, dashFs)
    const dash = await dashed.prove({
      run: RUN,
      claim: {
        ...CLAIM,
        file,
        guard: ['npm', 'test', '--', 'tests/support/lib.test.ts'],
        control: ['bun', 'test', 'src/other.test.ts'],
      },
    })
    expect(dash.reason).not.toContain('--=')
    // POSITIVE CONTROL — the OTHER operand arm still offers it, so the
    // assertion above is about the separator and not about a message this
    // gate stopped writing at all.
    const optFs = memFs({ [join(proofWorktreePath('/repo', RUN), file)]: SRC_BEFORE })
    const { prover: opted } = proverOver({}, optFs)
    const opt = await opted.prove({
      run: RUN,
      claim: {
        ...CLAIM,
        file,
        guard: ['bun', 'test', '--coverage', 'tests/support/lib.test.ts'],
        control: ['bun', 'test', 'src/other.test.ts'],
      },
    })
    expect(opt.reason).toContain('--coverage=…')

    // AND NO ARM BORROWS A SENTENCE IT CANNOT SAY. A LONE search is dropped by
    // `pathArgs`, so it lands on this arm too — and the "so it reaches" tail
    // used to be glued on at the CALL SITE as "so the runner discovers from the
    // repo root", which told the next build that `bun test app/*.test.ts`
    // discovers from the repo root when it discovers from `app`. Same refusal,
    // an accurate reason. Gluing the tail back on reddens the second assertion.
    const searchFs = memFs({ [join(proofWorktreePath('/repo', RUN), file)]: SRC_BEFORE })
    const { prover: searched } = proverOver({}, searchFs)
    const lone = await searched.prove({
      run: RUN,
      claim: { ...CLAIM, file, guard: ['bun', 'test', 'app/*.test.ts'], control: ['bun', 'test', 'src/other.test.ts'] },
    })
    expect(lone.proved).toBe(false)
    expect(lone.reason).toContain('names a search, which reaches every collectible file under its root')
    expect(lone.reason).not.toContain('discovers from the repo root')

    // POSITIVE CONTROL — the DISCOVERY arms still say it, so the assertion above
    // cannot be passing because the sentence was deleted from the module.
    const bareFs = memFs({ [join(proofWorktreePath('/repo', RUN), file)]: SRC_BEFORE })
    const { prover: bare } = proverOver({}, bareFs)
    const nothing = await bare.prove({
      run: RUN,
      claim: { ...CLAIM, file, guard: ['bun', 'test'], control: ['bun', 'test', 'src/other.test.ts'] },
    })
    expect(nothing.reason).toContain('it names no path at all, so the runner discovers from the repo root')

    // The actionable half: the refusal carries the spelling that IS accepted…
    const fs = memFs({ [join(proofWorktreePath('/repo', RUN), file)]: SRC_BEFORE })
    const { prover } = proverOver({}, fs)
    const dropped = await prover.prove({
      run: RUN,
      claim: { ...CLAIM, file, guard: ['bun', 'test', '--coverage', 'tests/support/lib.test.ts'] },
    })
    expect(dropped.reason).toContain('put the path BEFORE the options')

    // …and that spelling really is accepted. POSITIVE CONTROL: without it the
    // message above would be advice that does not work.
    const ok = memFs({ [join(proofWorktreePath('/repo', RUN), file)]: SRC_BEFORE })
    const { prover: reordered } = proverOver({}, ok)
    const fine = await reordered.prove({
      run: RUN,
      claim: { ...CLAIM, file, guard: ['bun', 'test', 'tests/support/lib.test.ts', '--coverage'] },
    })
    expect(fine.reason).not.toContain('tautology')
    expect(fine.observed).not.toBeNull()
  })

  test('a SEARCH beside a selector still searches — `go test ./cmd/ ./...` reaches the mutated file', async () => {
    // THE BLOCKER. A search was dropped from every comparison that compares a
    // SPELLING (`pathArgs`, `argumentOperands`, `guardPathCandidates`) on the
    // reasoning that the no-selection arm catches it — and that reasoning only
    // holds while the search is the ONLY selector. Put `./cmd/` beside `./...`
    // and `pathArgs` is non-empty, so the arm never fires, while the directory
    // and filter arms compare `cmd` against a target under `tests/` and see
    // nothing. `go test ./...` compiles the mutated package all the same, so
    // the mutated file supplied its own RED and its restore its own GREEN.
    const helper = 'tests/support/helper.go'
    const goFs = memFs({ [join(proofWorktreePath('/repo', RUN), helper)]: SRC_BEFORE })
    const { prover, host } = proverOver({}, goFs)
    const out = await prover.prove({
      run: RUN,
      claim: { ...CLAIM, file: helper, guard: ['go', 'test', './cmd/', './...'] },
    })
    expect(out.proved).toBe(false)
    expect(out.reason).toContain('tautology')
    // …and it says WHICH element reaches, and how far: `./...` is rooted at the
    // repo root, so it reaches every collectible file there is.
    expect(out.reason).toContain('names a search rooted at the repo root')
    expect(out.observed).toBeNull()
    expect(host.calls).toHaveLength(0)

    // A SEARCH CARRIED BY AN OPTION is the same reach with an `=` on it, and it
    // is read out of the option's value rather than off the element.
    const util = 'tests/support/util.ts'
    const carriedFs = memFs({ [join(proofWorktreePath('/repo', RUN), util)]: SRC_BEFORE })
    const { prover: carried, host: carriedHost } = proverOver({}, carriedFs)
    const outCarried = await carried.prove({
      run: RUN,
      claim: { ...CLAIM, file: util, guard: ['bun', 'test', 'app/other.test.ts', '--coverage-dir=tests/**'] },
    })
    expect(outCarried.proved).toBe(false)
    expect(outCarried.reason).toContain('names a search rooted at tests')
    expect(outCarried.observed).toBeNull()
    expect(carriedHost.calls).toHaveLength(0)

    // POSITIVE CONTROL — the fail-open half, and the whole reason a search is
    // read by ROOT rather than refused wholesale. `app/*.test.ts` is a search
    // too, and it reaches nothing under `tests/`, so it stays a legal guard for
    // a support library. Without this the arm above reads as "any glob in the
    // argv is a tautology", which closes the class this branch exists to open.
    const okFs = memFs({ [join(proofWorktreePath('/repo', RUN), util)]: SRC_BEFORE })
    const { prover: ok } = proverOver({}, okFs)
    const fine = await ok.prove({
      run: RUN,
      claim: { ...CLAIM, file: util, guard: ['bun', 'test', 'app/other.test.ts', 'app/*.test.ts'] },
    })
    expect(fine.reason).not.toContain('tautology')
    expect(fine.observed).not.toBeNull()
  })

  test('a percent-encoded spelling is the mutated file — the loader decodes what the comparison must too', async () => {
    // `--preload=./src/limit%2Ets` is `--preload=./src/limit.ts`: node resolves
    // a module specifier as a URL and loads the encoded spelling (reproduced
    // end-to-end on node v22), while it equals no repo-relative target, matches
    // no arm, and ENOENTs out of `guardPathCandidates`. The mutated file was
    // loaded into the very process that ran its own guard and the gate recorded
    // `proved: true`.
    const { prover, host } = proverOver()
    const out = await prover.prove({
      run: RUN,
      claim: { ...CLAIM, guard: ['bun', 'test', '--preload=./src/limit%2Ets', 'src/other.test.ts'] },
    })
    expect(out.proved).toBe(false)
    expect(out.reason).toContain('tautology')
    expect(out.reason).toContain(CLAIM.file)
    expect(out.observed).toBeNull()
    expect(host.calls).toHaveLength(0)

    // POSITIVE CONTROL — a MALFORMED `%` is not an encoding. `100%` throws in
    // `decodeURIComponent`, and a decoder that threw would fail the nomination
    // rather than refuse it; the literal spelling is kept, it matches nothing,
    // and the guard is permitted.
    const { prover: ok } = proverOver()
    const fine = await ok.prove({
      run: RUN,
      claim: { ...CLAIM, guard: ['bun', 'test', 'src/other.test.ts', '--test-name-pattern=100%'] },
    })
    expect(fine.reason).not.toContain('tautology')
    expect(fine.observed).not.toBeNull()
  })

  test('a percent-encoded ESCAPE still leaves the worktree — the ESCAPE rule decodes too', async () => {
    // The decode inside `argvEscapesTheWorktree` is a SECOND decode, and it was
    // unpinned: the one in `normalizeArg` is what the test above exercises, and
    // deleting this one left both suites green while `--import=%2E%2E/x/lib.ts`
    // and `-r%2Fetc%2Fx.js` were accepted and RUN. `%2E%2E` is a `..` and `%2F`
    // a `/` with two characters of punctuation on them, node decodes both (a
    // module specifier is a URL), so each of these climbs OUT of the worktree —
    // where the argv can name the mutated file under a spelling no arm here
    // compares.
    for (const arg of ['--import=%2E%2E/x/lib.ts', '-r%2Fetc%2Fx.js', '%2E%2E/x/lib.ts']) {
      const { prover, host } = proverOver()
      const out = await prover.prove({
        run: RUN,
        claim: { ...CLAIM, guard: ['bun', 'test', arg, 'src/other.test.ts'] },
      })
      expect([arg, out.proved, out.reason.includes('must be a repo-relative path inside the worktree')]).toEqual([
        arg,
        false,
        true,
      ])
      expect(out.observed).toBeNull()
      expect(host.calls).toHaveLength(0)
    }

    // POSITIVE CONTROL — an encoding that decodes to nothing escaping is left
    // alone, so the rule above is not refusing every `%`.
    const { prover: ok } = proverOver()
    const fine = await ok.prove({
      run: RUN,
      claim: { ...CLAIM, guard: ['bun', 'test', 'src/other.test.ts', '--test-name-pattern=a%2Db'] },
    })
    expect(fine.reason).not.toContain('repo-relative')
    expect(fine.observed).not.toBeNull()
  })

  test('a URL inside an option VALUE still leaves the worktree', async () => {
    // The scheme test was anchored at `(^|=)`, so in
    // `--import=data:text/javascript,import("file:///…")` the value at the `=`
    // is `data:` — a colon followed by a letter, which is deliberately allowed
    // for `npm run test:unit` — and the `file:///` that actually loads the
    // mutated file sits mid-element, where no arm looked. A guard runs IN the
    // worktree and never needs a URL to name a file in it.
    for (const escape of [
      '--import=data:text/javascript,import("file:///pw/lib.ts")',
      // …and the same shape with NO scheme on it at all: an absolute path
      // opening a token mid-element is that same absolute path.
      '--outfile=report;/pw/leak.ts',
      // …AND A `data:` URL CARRYING NEITHER. `data` was the SOLE refuser of
      // this element — its own alternative in `LOADABLE_SCHEME` — and nothing
      // pinned it: no `file:` for the any-scheme alternative to catch, and the
      // one `/` in `text/javascript` follows a path character so the
      // embedded-absolute arm never fires. Delete `data` from the pattern and
      // node preloads whatever this source says, inside the worktree, with no
      // arm having looked.
      '--import=data:text/javascript,console.log(1)',
    ]) {
      const { prover, host } = proverOver()
      const out = await prover.prove({
        run: RUN,
        claim: { ...CLAIM, guard: ['bun', 'test', 'src/other.test.ts', escape] },
      })
      expect([escape, out.proved, out.reason.includes('must be a repo-relative path inside the worktree')]).toEqual([
        escape,
        false,
        true,
      ])
      expect(out.observed).toBeNull()
      expect(host.calls).toHaveLength(0)
    }

    // POSITIVE CONTROL — an ordinary colon is not a scheme, and the guard
    // carrying one is RUN.
    const { prover: ok } = proverOver()
    const fine = await ok.prove({
      run: RUN,
      claim: { ...CLAIM, guard: [...CLAIM.guard, '--test-name-pattern=fast:path'] },
    })
    expect(fine.reason).not.toContain('must be a repo-relative path inside the worktree')
    expect(fine.observed).not.toBeNull()
  })

  test('a query-suffixed specifier is one file, not a search — and the refusal says which', async () => {
    // `pathArgs` asked `namesASearch` of the RAW element while
    // `guardPathCandidates` normalised first, and `./report.mjs?probe` has a
    // `?` in it. Read raw it "named a search" and the refusal told the build its
    // guard was a whole-repo discovery run — an argv nobody wrote. It fails
    // CLOSED either way; what it got wrong is WHY, which is what the next build
    // reads. Normalise first, in both places, and the element is what it is: one
    // file's specifier, which no allowlisted runner would RUN.
    const file = 'tests/support/lib.ts'
    const fs = memFs({ [join(proofWorktreePath('/repo', RUN), file)]: SRC_BEFORE })
    const { prover } = proverOver({}, fs)
    const out = await prover.prove({
      run: RUN,
      claim: { ...CLAIM, file, guard: ['bun', 'test', './report.mjs?probe'] },
    })
    expect(out.proved).toBe(false)
    expect(out.reason).toContain('is not a name an allowlisted runner would RUN')
    expect(out.reason).not.toContain('names a search')

    // POSITIVE CONTROL — normalise-then-classify also keeps a query-suffixed
    // REAL selector selectable, so the same fix does not turn every `?` into a
    // dropped element and a no-selection refusal.
    const okFs = memFs({ [join(proofWorktreePath('/repo', RUN), file)]: SRC_BEFORE })
    const { prover: ok } = proverOver({}, okFs)
    const fine = await ok.prove({
      run: RUN,
      claim: { ...CLAIM, file, guard: ['bun', 'test', './src/other.test.ts?probe'] },
    })
    expect(fine.reason).not.toContain('tautology')
    expect(fine.observed).not.toBeNull()
  })
})

describe('a mutation target is classified by what DECLARES it a test', () => {
  const TABLE: Array<[string, 'test' | 'prose' | 'production']> = [
    ['tests/support/scrub-instance-env.ts', 'production'],
    ['tests/support/scrub-instance-env-probe.ts', 'production'],
    ['tests/support/scrub-instance-env.test.ts', 'test'],
    ['tests/integration/pty-e2e-registered.test.ts', 'test'],
    ['gbrain-memory/__tests__/foo.test.ts', 'test'],
    ['gbrain-memory/__tests__/memory-swap-seam.depcruise.test.ts', 'test'],
    ['src/__tests__/limit.ts', 'test'], // DIRECT child of __tests__
    // A NON-TEST HELPER directly under __tests__/ is a DECLARED TEST by the
    // direct-child rule — DELIBERATELY, and this row is the boundary that may
    // not move silently. This repository has 13 such support libraries
    // (app/__tests__/reachability-inventory.ts,
    // gbrain-memory/__tests__/boot-pglite-brain.ts,
    // runtime/__tests__/stub-platform.ts, …), so a diff of ONLY such helpers
    // buys the no-production-file exemption below — pinned at the gate with its
    // load-bearing negative. Reclassifying those 13 is the standing follow-up
    // card's work (see the Deferred paragraph in IMPLEMENTATION_PLAN.md), not a
    // fix round's.
    ['gbrain-memory/__tests__/helper.ts', 'test'],
    ['a/__tests__/support/helper.ts', 'production'], // nested below __tests__/<subdir>: matches neither declaration; the tautology check, not the path, is the defense
    ['src/foo_test.go', 'test'],
    ['app/bar.spec.tsx', 'test'],
    // THE NAMES A RUNNER COLLECTS BUT NO CONVENTION DECLARES. They stay
    // `production` ON PURPOSE, and this is the boundary that may not move
    // silently: this classifier feeds the no-production-file EXEMPTION, and
    // file names are written by the BUILD, so every name admitted here is a
    // name a build could give a production file to buy itself an exemption.
    // `src/ab-test.ts` was exactly that hole. The tautology these names could
    // otherwise buy — mutate one, then let a directory or bare-runner guard run
    // it as its own test — is refused on the GUARD side instead
    // (`RUNNER_COLLECTED_BASENAME`), where a wrong answer only ever costs a
    // nomination its guard.
    ['tests/self_test.ts', 'production'],
    ['tests/support/helper_spec.ts', 'production'],
    ['tests/support/helper-test.ts', 'production'],
    ['scripts/tools_test.mjs', 'production'],
    ['tests/test_probe.py', 'production'],
    ['src/ab-test.ts', 'production'],
    ['src/thing_test.ts', 'production'],
    // AND RUST, WHOSE `_test.rs` SUFFIX NAMES NO CARGO CONVENTION. Cargo
    // collects `tests/*.rs` under any name and `#[cfg(test)]` modules in
    // `src/`; a `_test.rs` arm therefore covered no target `tests/foo.rs` did
    // not already miss, while declaring an ordinary Rust module a test and
    // selling its diff the no-production-file exemption on a suffix the build
    // wrote. Both classify `production` now, which is the strictly narrower
    // answer.
    ['src/pricing_test.rs', 'production'],
    ['tests/integration_test.rs', 'production'],
    // THE HYBRID EXTENSIONS NO RUNNER COLLECTS. `[cm]?[jt]sx?` reads as eight
    // extensions and admits twelve; the four extra (`.cjsx`, `.mjsx`, `.ctsx`,
    // `.mtsx`) are spellings bun ignores — a lone `payments.test.cjsx` gives
    // "Ran 1 test across 1 file", the other one. A name nothing runs must not
    // DECLARE a test, or a build parks behaviour in one and buys the
    // no-production-file exemption for free.
    ['src/payments.test.cjsx', 'production'],
    ['a/b.test.mtsx', 'production'],
    ['testfoo.py', 'production'],
    ['src/test-foo.js', 'production'],
    ['test.ts', 'production'],
    ['tests/test.ts', 'production'],
    ['src/limit.ts', 'production'],
    ['docs/limits.md', 'prose'],
  ]

  test('the table holds, path by path', () => {
    // A FULL-LITERAL comparison, so an extraction that returned nothing at all
    // cannot silently pass.
    expect(TABLE.map(([p]) => [p, classifyMutationTarget(p)])).toEqual(TABLE)
    expect(TABLE.length).toBeGreaterThanOrEqual(17)
    const kinds = TABLE.map(([, k]) => k)
    expect(kinds).toContain('production')
    expect(kinds).toContain('test')
  })

  test('the declaration predicate is the basename or a DIRECT __tests__ parent', () => {
    expect(isDeclaredTestFile('tests/support/scrub-instance-env.test.ts')).toBe(true)
    expect(isDeclaredTestFile('src/__tests__/limit.ts')).toBe(true)
    expect(isDeclaredTestFile('gbrain-memory/__tests__/helper.ts')).toBe(true)
    expect(isDeclaredTestFile('tests/support/scrub-instance-env.ts')).toBe(false)
    expect(isDeclaredTestFile('a/__tests__/support/helper.ts')).toBe(false)
  })

  test('only the CONVENTIONAL declarations count — the looser names a runner collects do not', () => {
    // Deleting any alternative from TEST_BASENAME reddens one of these.
    for (const p of [
      'a/b.test.ts',
      'a/b.spec.tsx',
      'a/b.test.mjs',
      'a/b.test.cjs',
      'a/b.spec.mts',
      'a/b.test.jsx',
      'src/foo_test.go',
      'src/foo_test.py',
    ]) {
      expect([p, isDeclaredTestFile(p)]).toEqual([p, true])
    }
    // …and these are NOT declarations, however freely a runner would collect
    // them. Widening TEST_BASENAME back to `[._-](test|spec)\.` or to
    // `test_*.py` reddens this loop — which is the point: this regex is what
    // the no-production-file exemption is measured with, and the names are the
    // build's own. A support library keeps its right to be mutated for the same
    // reason.
    for (const p of [
      'src/ab-test.ts',
      'src/thing_test.ts',
      // RUST IS NOT A `_test.rs` LANGUAGE. Cargo's test targets are `tests/*.rs`
      // under any name plus `#[cfg(test)]` modules in `src/`, so `_test.rs`
      // declared nothing cargo collects while handing an ordinary Rust module —
      // production logic with a suffix the BUILD chose — the no-production-file
      // exemption. Putting `rs` back into TEST_BASENAME reddens these two.
      'src/pricing_test.rs',
      'tests/integration_test.rs',
      'tests/support/helper_spec.ts',
      'tests/test_probe.py',
      'tests/support/scrub-instance-env.ts',
      'tests/support/env-probe.ts',
      'src/testing.ts',
      // The hybrid extensions again, at the predicate itself: collapsing the
      // two families back to `[cm]?[jt]sx?` reddens these four.
      'src/payments.test.cjsx',
      'a/b.test.mjsx',
      'a/b.spec.ctsx',
      'a/b.test.mtsx',
    ]) {
      expect([p, isDeclaredTestFile(p)]).toEqual([p, false])
    }
  })
})

describe('diffHasNoLegalMutationTarget — the exemption predicate, both its arms', () => {
  test('null and EMPTY are not exempt — a diff we know nothing about fails closed', () => {
    // BOTH ARMS ARE LIVE. `changedFilesOnBranch` returns `[]` for a branch whose
    // diff git read perfectly and found empty, and `null` only when git itself
    // failed. `[].every(…)` is vacuously true, so dropping the emptiness guard
    // would exempt exactly the diff that changed nothing provable — and `null`
    // must fail closed for the opposite reason, that nothing was read at all.
    expect(diffHasNoLegalMutationTarget(null)).toBe(false)
    expect(diffHasNoLegalMutationTarget([])).toBe(false)
  })

  test('all-test/all-prose is exempt; ONE production file is not', () => {
    expect(diffHasNoLegalMutationTarget(['tests/a.test.ts', 'docs/x.md'])).toBe(true)
    expect(diffHasNoLegalMutationTarget(['tests/a.test.ts', 'docs/x.md', 'src/limit.ts'])).toBe(false)
    // The support library IS production for this purpose — that is the whole
    // #489 fix: its diff must still be proved.
    expect(diffHasNoLegalMutationTarget(['tests/support/scrub-instance-env.ts'])).toBe(false)
    // …and so is a name a runner would COLLECT but no convention DECLARES. The
    // exemption is bought with names the build writes, so widening the
    // classifier to cover every collectible name would widen this — which is why
    // that breadth lives on the guard side instead.
    expect(diffHasNoLegalMutationTarget(['testfoo.py', 'src/test-foo.js', 'docs/x.md'])).toBe(false)
    // …and so is a Rust module whose `_test.rs` suffix names no cargo
    // convention. Putting `rs` back into TEST_BASENAME turns this line green
    // for `true`, which is the exemption being bought with a suffix.
    expect(diffHasNoLegalMutationTarget(['src/pricing_test.rs', 'docs/x.md'])).toBe(false)
    // The direct-__tests__/-child helpers: an ALL-HELPER diff is exempt — the
    // deliberate design JOB 3 pins — and one production file beside them ends it.
    expect(diffHasNoLegalMutationTarget(['gbrain-memory/__tests__/helper.ts', 'runtime/__tests__/stub-platform.ts', 'docs/x.md'])).toBe(true)
    expect(diffHasNoLegalMutationTarget(['gbrain-memory/__tests__/helper.ts', 'runtime/__tests__/stub-platform.ts', 'docs/x.md', 'src/limit.ts'])).toBe(false)
  })
})

describe('missingClaimRefusalReason — the refusal names WHY, and never blames the build unfairly', () => {
  test('a path containing a NEWLINE stays on one line — a reason is a record, not a document', () => {
    // Git's `-z` parse preserves every byte of a filename, correctly: a path
    // really may contain a newline. A reason is a ONE-LINE record that reaches a
    // log line, a status post and a DB row, so interpolated raw that one path
    // turns one record into two, and the second half reads as its own event.
    const nasty = 'src/new\nline.ts'
    const reason = missingClaimRefusalReason([nasty])
    expect(reason).not.toContain('\n')
    // ESCAPED, NOT DROPPED — the reader still has to be able to find the file.
    expect(reason).toContain('src/new')
    expect(reason).toContain('line.ts')

    // POSITIVE CONTROL — an ordinary path is spelled EXACTLY as git wrote it, so
    // the escaping above cannot be quoting every name it prints.
    expect(missingClaimRefusalReason(['src/limit.ts'])).toContain('src/limit.ts changed in this diff')
  })

  const UNREADABLE = 'mutation proof required but the branch diff could not be read — a proof cannot be bound to it'

  test('an unreadable diff and an EMPTY one say different things, and neither blames the build', () => {
    expect(missingClaimRefusalReason(null)).toBe(UNREADABLE)
    const empty = missingClaimRefusalReason([])
    expect(empty).not.toBe(UNREADABLE)
    expect(empty).toContain('empty')
    expect(empty).not.toContain('nominated no mutation')
  })

  test('a legal target that existed is NAMED', () => {
    const reason = missingClaimRefusalReason(['tests/a.test.ts', 'src/limit.ts'])
    expect(reason).toContain('nominated no mutation')
    expect(reason).toContain('src/limit.ts')
  })

  test('no legal target at all is a gate defect, and says which file it considered', () => {
    const reason = missingClaimRefusalReason(['tests/a.test.ts', 'docs/x.md'])
    expect(reason).not.toContain('nominated no mutation')
    expect(reason).toContain('tests/a.test.ts')
    expect(reason).toContain('a declared test file')
    expect(reason).toContain('gate defect')
  })

  test('a DELETED production file is never named as the target the build should have nominated', () => {
    // THE DEADLOCK THIS ENDS. The refusal used to read "a legal mutation target
    // existed: src/gone.ts changed in this diff" — and nominating exactly that
    // file was refused by the prover with "does not exist at <sha> — the
    // mutation cannot apply". Two refusals in a closed loop, and a reader left
    // to re-derive why. Both reviewers reproduced it with real git.
    const files = ['src/gone.ts', 'tests/a.test.ts']
    const reason = missingClaimRefusalReason(files, ['src/gone.ts'])
    expect(reason).not.toContain('nominated no mutation')
    expect(reason).toContain('DELETIONS')
    expect(reason).toContain('src/gone.ts')
    expect(reason).toContain('absent at the head being proved')
    // …and it is NOT reported as a gate defect: this branch is reachable and
    // the classifiers agree — a deletion is a production change with no
    // mutatable referent.
    expect(reason).not.toContain('gate defect')

    // POSITIVE CONTROL 1 — the SAME file list with nothing deleted still blames
    // the build, so the assertion above is about the status and nothing else.
    const modified = missingClaimRefusalReason(files)
    expect(modified).toContain('nominated no mutation')
    expect(modified).toContain('src/gone.ts')

    // POSITIVE CONTROL 2 — a diff that deletes one production file and MODIFIES
    // another still names the modifiable one: there is a nomination to make.
    const mixed = missingClaimRefusalReason(['src/gone.ts', 'src/limit.ts'], ['src/gone.ts'])
    expect(mixed).toContain('nominated no mutation')
    expect(mixed).toContain('src/limit.ts')
    expect(mixed).not.toContain('DELETIONS')
  })

  test('the DELETION list is capped by the same budget as the exemption list', () => {
    // The exemption reason was capped and this one was not, so a deletion-only
    // diff of a whole directory reproduced, verbatim, the multi-hundred-KB
    // single log line / status post / DB row the cap was added to bound.
    const gone = Array.from({ length: 1000 }, (_, i) => `src/generated/case-${i}.ts`)
    const reason = missingClaimRefusalReason(gone, gone)
    expect(reason).toContain('DELETIONS')
    expect(reason.length).toBeLessThan(4500)
    const named = (reason.split('(')[1] ?? '').split(')')[0]?.split(', ') ?? []
    expect(named[named.length - 1]).toBe(`… +${1000 - (named.length - 1)} more`)
    // POSITIVE CONTROL against an empty extraction: real names were printed, in
    // order, starting at the first — the cap elides, it does not blank the list.
    expect(named[0]).toBe(gone[0])
    expect(named.length).toBeGreaterThan(10)
  })

  test('a deletion is a changed file and a production change — it just is not a TARGET', () => {
    // The two halves this branch deliberately keeps apart. `claim.file` must
    // appear in the diff, so a deletion stays in the list; and the exemption
    // must NOT fire for it, or `git mv src/limit.ts src/limit.test.ts` (which
    // `--no-renames` reports as a deletion plus a test-shaped addition) would
    // buy the free pass that flag exists to deny.
    expect(legalMutationTargets(['src/gone.ts'], ['src/gone.ts'])).toEqual([])
    expect(diffHasNoLegalMutationTarget(['src/gone.ts'])).toBe(false)
    expect(diffHasNoLegalMutationTarget(['src/limit.ts', 'src/limit.test.ts'])).toBe(false)
    // POSITIVE CONTROL — the exemption still fires when the diff really has no
    // production file at all, so the assertions above are about deletions.
    expect(diffHasNoLegalMutationTarget(['tests/a.test.ts', 'docs/x.md'])).toBe(true)
  })

  test('the target it NAMES is one a runner could actually redden, and it says so when none is', () => {
    // Every legal target is legal by CLASSIFICATION — not prose, not a declared
    // test — and that admits files no allowlisted runner executes. A
    // `.github/workflows` YAML is not prose (`PROSE_DIR_DENYLIST` keeps it out),
    // so a workflow-plus-README diff was told, confidently, that `ci.yml` was
    // the mutation the build should have nominated. It is not a nomination
    // anyone can make; it is a finding for the reviewer, and the message now
    // says which of the two it is.
    const unprovable = missingClaimRefusalReason(['.github/workflows/ci.yml', 'README.md'])
    expect(unprovable).toContain('ci.yml')
    expect(unprovable).toContain('if no allowlisted runner can execute it, that is a finding for the reviewer')

    // …and a SOURCE file in the same diff is preferred over it — `ci.yml` FIRST
    // in the list, so this proves the preference and not the order of the array.
    const provable = missingClaimRefusalReason(['.github/workflows/ci.yml', 'src/limit.ts'])
    expect(provable).toContain('src/limit.ts')
    expect(provable).not.toContain('if no allowlisted runner can execute it, that is a finding for the reviewer')
  })
})

describe('NO AGENT MAY COMPOSE THE EVIDENCE BLOCK', () => {
  /** A hand-written block of exactly the shape an agent would write if it were
   *  narrating a mutation it never ran: plausible, well-formed, complete. */
  function handWritten(over: Record<string, unknown> = {}): unknown {
    const digest = (s: string) => createHash('sha256').update(s).digest('hex')
    return {
      schema: MUTATION_PROOF_SCHEMA,
      prover_version: MUTATION_PROVER_VERSION,
      run_id: RUN.id,
      claimed: CLAIM,
      observed: {
        head_sha: HEAD,
        file: CLAIM.file,
        file_sha256_before: digest('before'),
        file_sha256_mutated: digest('mutated'),
        file_sha256_restored: digest('before'),
        guard_mutated: { argv: CLAIM.guard, exit_code: 1, output_sha256: digest('red'), timed_out: false },
        control_mutated: { argv: CLAIM.control, exit_code: 0, output_sha256: digest('control'), timed_out: false },
        guard_restored: { argv: CLAIM.guard, exit_code: 0, output_sha256: digest('green'), timed_out: false },
      },
      proved: true,
      reason: 'mutation applied: guard RED, control GREEN, restored, guard GREEN',
      proof_token: digest('token'),
      ...over,
    }
  }

  test('a WELL-FORMED hand-written block is rejected — this is the #477 case', async () => {
    const { prover } = proverOver()
    // Sanity: it is well-formed enough that every structural check passes; the
    // ONLY thing wrong with it is that no mutation was ever run.
    const verdict = prover.verify(handWritten())
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toContain('was not emitted by the prover')
  })

  test('PLACEHOLDER values are rejected by name, before the signature is consulted', async () => {
    const { prover } = proverOver()
    const placeholderDigest = prover.verify(handWritten({ observed: { ...(handWritten() as { observed: Record<string, unknown> }).observed, file_sha256_before: '<sha256>' } }))
    expect(placeholderDigest.ok).toBe(false)
    expect(placeholderDigest.reason).toContain('file_sha256_before is not a sha256 digest')

    const placeholderExit = prover.verify(
      handWritten({
        observed: {
          ...(handWritten() as { observed: Record<string, unknown> }).observed,
          guard_mutated: { argv: CLAIM.guard, exit_code: 'FAIL', output_sha256: 'x'.repeat(64), timed_out: false },
        },
      }),
    )
    expect(placeholderExit.ok).toBe(false)
    expect(placeholderExit.reason).toContain('exit_code is not an integer')

    const placeholderToken = prover.verify(handWritten({ proof_token: 'TODO' }))
    expect(placeholderToken.ok).toBe(false)
    expect(placeholderToken.reason).toContain('proof_token is missing or not a sha256')
  })

  test('a block whose own observations contradict `proved:true` is rejected on THEM, not on trust', async () => {
    const { prover } = proverOver()
    const observed = (handWritten() as { observed: Record<string, unknown> }).observed
    const greenGuard = prover.verify(
      handWritten({
        observed: {
          ...observed,
          guard_mutated: { argv: CLAIM.guard, exit_code: 0, output_sha256: 'a'.repeat(64), timed_out: false },
        },
      }),
    )
    expect(greenGuard.ok).toBe(false)
    expect(greenGuard.reason).toContain('its observations do not')
  })

  test('a REAL block edited after the fact stops verifying', async () => {
    const { prover } = proverOver()
    const real = await prover.prove({ run: RUN, claim: CLAIM })
    expect(prover.verify(real).ok).toBe(true)

    const editedReason: MutationEvidence = { ...real, reason: 'mutation verified by inspection' }
    expect(prover.verify(editedReason).ok).toBe(false)

    const editedClaim: MutationEvidence = { ...real, claimed: { ...CLAIM, file: 'some/other/file.ts' } }
    expect(prover.verify(editedClaim).ok).toBe(false)

    const editedObservation: MutationEvidence = {
      ...real,
      observed: { ...real.observed!, guard_mutated: { ...real.observed!.guard_mutated, exit_code: 3 } },
    }
    expect(prover.verify(editedObservation).ok).toBe(false)
  })

  test('the RATIONALE is signed too — the sentence a human reads cannot be rewritten', async () => {
    // `rationale` is the human-facing "why this mutation proves the change".
    // It was the one claim field the payload left out, so a block could be
    // re-narrated after the fact and still verify — the block would say one
    // thing to a reader and another to the token.
    const withReason: MutationClaim = { ...CLAIM, rationale: 'breaks the boundary check' }
    const { prover } = proverOver()
    const real = await prover.prove({ run: RUN, claim: withReason })
    expect(real.proved).toBe(true)
    expect(prover.verify(real).ok).toBe(true)

    const renarrated: MutationEvidence = {
      ...real,
      claimed: { ...real.claimed, rationale: 'proves something else entirely' },
    }
    expect(prover.verify(renarrated).ok).toBe(false)

    // ADDING one where there was none is an edit too — absent must not sign the
    // same bytes as present.
    const plain = await prover.prove({ run: RUN, claim: CLAIM })
    const backfilled: MutationEvidence = {
      ...plain,
      claimed: { ...plain.claimed, rationale: 'added after the fact' },
    }
    expect(prover.verify(backfilled).ok).toBe(false)
  })

  test('a genuine block from ANOTHER prover does not verify here (no cross-process replay)', async () => {
    const { prover: a } = proverOver()
    const { prover: b } = proverOver()
    const fromA = await a.prove({ run: RUN, claim: CLAIM })
    expect(a.verify(fromA).ok).toBe(true)
    expect(b.verify(fromA).ok).toBe(false)
  })

  test('non-objects, wrong schema and wrong version are rejected', async () => {
    const { prover } = proverOver()
    expect(prover.verify(null).ok).toBe(false)
    expect(prover.verify('mutation verified ✅').ok).toBe(false)
    expect(prover.verify(handWritten({ schema: 'trident.mutation-proof/99' })).ok).toBe(false)
    expect(prover.verify(handWritten({ prover_version: 99 })).ok).toBe(false)
    expect(prover.verify(handWritten({ observed: null })).ok).toBe(false)
  })

  test('a block with fields simply MISSING is REJECTED, never a crash', async () => {
    const { prover } = proverOver()
    // A hand-written block that left `claimed` out used to reach
    // `canonicalPayload`, which dereferenced `e.claimed.file` and THREW. A
    // TypeError out of the gate is not the rejection this module promises.
    const noClaim = { ...(handWritten() as Record<string, unknown>) }
    delete noClaim.claimed
    let verdict = prover.verify(noClaim)
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toContain('no `claimed` nomination')

    for (const [field, reason] of [
      ['run_id', 'run_id is missing'],
      ['reason', 'reason is missing'],
    ] as const) {
      const stripped = { ...(handWritten() as Record<string, unknown>) }
      delete stripped[field]
      verdict = prover.verify(stripped)
      expect(verdict.ok).toBe(false)
      expect(verdict.reason).toContain(reason)
    }

    // …and a `claimed` that is present but not a nomination.
    expect(prover.verify(handWritten({ claimed: { file: 'a.ts' } })).reason).toContain('claimed.find is missing')
    expect(prover.verify(handWritten({ claimed: { ...CLAIM, guard: 'bun test' } })).reason).toContain(
      'claimed.guard is not a command',
    )
  })

  test('a PLACEHOLDER head_sha or timed_out is rejected by name', async () => {
    const { prover } = proverOver()
    const observed = (handWritten() as { observed: Record<string, unknown> }).observed
    expect(prover.verify(handWritten({ observed: { ...observed, head_sha: '<commit>' } })).reason).toContain(
      'head_sha is not a commit sha',
    )
    expect(prover.verify(handWritten({ observed: { ...observed, head_sha: 'HEAD' } })).reason).toContain(
      'head_sha is not a commit sha',
    )
    expect(
      prover.verify(
        handWritten({
          observed: {
            ...observed,
            guard_restored: { argv: CLAIM.guard, exit_code: 0, output_sha256: 'c'.repeat(64), timed_out: 'no' },
          },
        }),
      ).reason,
    ).toContain('timed_out is not a boolean')
  })

  test('the proof is BOUND to its run and its commit, and verify enforces both', async () => {
    const { prover } = proverOver()
    const real = await prover.prove({ run: RUN, claim: CLAIM })
    expect(prover.verify(real, { run_id: RUN.id, head_sha: HEAD }).ok).toBe(true)
    expect(prover.verify(real, { run_id: 'run-2' }).reason).toContain('not for this run')
    expect(prover.verify(real, { head_sha: 'b'.repeat(40) }).reason).toContain('is not the commit that was proved')
  })

  test('EVERY signed field is in the canonical payload — a dropped one stops being protected', async () => {
    // Structural, and derived from a real block rather than from a list written
    // here: delete any field from `canonicalPayload` and this goes red, because
    // that field's (distinct) value disappears from the signed bytes. Several of
    // those deletions previously survived the whole suite.
    // The block is TYPED as the real interface, so a new observation field
    // cannot be added without landing here (tsc requires it) — and once it is
    // here, the walk demands the payload cover it too.
    const block: Omit<MutationEvidence, 'proof_token'> = {
      schema: MUTATION_PROOF_SCHEMA,
      prover_version: MUTATION_PROVER_VERSION,
      run_id: 'RUN_ID_MARKER',
      claimed: {
        file: 'CLAIMED_FILE',
        find: 'CLAIMED_FIND',
        replace: 'CLAIMED_REPLACE',
        guard: ['CLAIMED_GUARD_ARGV'],
        control: ['CLAIMED_CONTROL_ARGV'],
        // OPTIONAL, and therefore the one this census used to miss: it was absent
        // from the block below, so the walk never demanded the payload cover it
        // and `rationale` sat unsigned while the suite stayed green.
        rationale: 'CLAIMED_RATIONALE',
      },
      observed: {
        head_sha: 'HEAD_SHA_MARKER',
        file: 'OBSERVED_FILE',
        file_sha256_before: 'DIGEST_BEFORE',
        file_sha256_mutated: 'DIGEST_MUTATED',
        file_sha256_restored: 'DIGEST_RESTORED',
        guard_mutated: {
          argv: ['GUARD_MUTATED_ARGV'],
          exit_code: 41,
          output_sha256: 'OUT_GUARD_MUTATED',
          timed_out: false,
        },
        control_mutated: {
          argv: ['CONTROL_MUTATED_ARGV'],
          exit_code: 42,
          output_sha256: 'OUT_CONTROL_MUTATED',
          timed_out: false,
        },
        guard_restored: {
          argv: ['GUARD_RESTORED_ARGV'],
          exit_code: 43,
          output_sha256: 'OUT_GUARD_RESTORED',
          timed_out: true,
        },
      },
      proved: true,
      reason: 'REASON_MARKER',
    }
    // COUNTED, not merely present: the booleans repeat (`proved`, three
    // `timed_out`s), so a field dropped from the payload has to show up as one
    // fewer `false`, not as a value that some sibling still happens to carry.
    const census = (v: unknown, into: Map<string, number> = new Map()): Map<string, number> => {
      if (v === null || v === undefined) return into
      if (Array.isArray(v)) {
        for (const item of v) census(item, into)
        return into
      }
      if (typeof v === 'object') {
        for (const item of Object.values(v as Record<string, unknown>)) census(item, into)
        return into
      }
      const k = `${typeof v}:${String(v)}`
      into.set(k, (into.get(k) ?? 0) + 1)
      return into
    }
    const want = census(block)
    const got = census(JSON.parse(canonicalPayload(block)))
    for (const [value, count] of want) {
      expect({ value, count: got.get(value) ?? 0 }).toEqual({ value, count })
    }
  })
})

describe('parseMutationClaim — a nomination, shape-checked, never a finding', () => {
  test('a complete nomination round-trips; anything partial is null', () => {
    expect(parseMutationClaim({ ...CLAIM })).toEqual(CLAIM)
    expect(parseMutationClaim({ ...CLAIM, guard: [] })).toBeNull()
    expect(parseMutationClaim({ ...CLAIM, guard: 'bun test' })).toBeNull()
    expect(parseMutationClaim({ file: 'a.ts' })).toBeNull()
    expect(parseMutationClaim('I ran the mutation and the guard failed')).toBeNull()
    expect(parseMutationClaim(null)).toBeNull()
  })
})

describe('the prose-only exemption FAILS CLOSED', () => {
  test('pure documentation is exempt', () => {
    expect(isProseOnlyChange(['README.md', 'docs/testing-runner.md', 'LICENSE'])).toBe(true)
  })

  test('one code file anywhere in the diff means the whole diff needs the proof', () => {
    expect(isProseOnlyChange(['README.md', 'trident/merge.ts'])).toBe(false)
  })

  test('EXECUTABLE prose (a skill / prompt / workflow contract) is NOT documentation', () => {
    // The mistake this guards: `skills/trident/SKILL.md` is a .md file and it is
    // also the agent's operating contract — editing it changes what the harness
    // does at runtime.
    expect(isProseOnlyChange(['skills/trident/SKILL.md'])).toBe(false)
    expect(isProseOnlyChange(['prompts/argus.md'])).toBe(false)
    expect(isProseOnlyChange(['.claude/settings.json'])).toBe(false)
    expect(isProseOnlyChange(['.github/workflows/ci.yml'])).toBe(false)
  })

  test('executable prose NESTED under any directory is caught, not just at the repo root', () => {
    // The denylist was anchored to the repo root, so the same operating contract
    // one level down merged as "documentation".
    expect(isProseOnlyChange(['onboarding/interview/skills/_envelope.md'])).toBe(false)
    expect(isProseOnlyChange(['open/.claude/notes.md'])).toBe(false)
    expect(isProseOnlyChange(['tools/prompts/reviewer.md'])).toBe(false)
  })

  test('the markdown that DRIVES the harness is not documentation either', () => {
    // `SPEC.md` flips the repo into Ralph mode and `IMPLEMENTATION_PLAN.md` is the
    // task list the next run builds from: both change what the harness DOES.
    expect(isProseOnlyChange(['SPEC.md'])).toBe(false)
    expect(isProseOnlyChange(['IMPLEMENTATION_PLAN.md'])).toBe(false)
    expect(isProseOnlyChange(['CLAUDE.md'])).toBe(false)
    expect(isProseOnlyChange(['AGENTS.md'])).toBe(false)
    expect(isProseOnlyChange(['open/SPEC.md'])).toBe(false)
    // …and CODEOWNERS routes review, so it is configuration, not a licence.
    expect(isProseOnlyChange(['CODEOWNERS'])).toBe(false)
  })

  test('.txt is NOT prose — plain text is where this repo keeps load-bearing config', () => {
    // Both of these merged unproved while `.txt` counted as documentation: the
    // first decides which secret-leak findings are suppressed, the second is the
    // schema snapshot the migration gate compares against.
    expect(isProseOnlyChange(['scripts/ci/leak-gate-allowlist.txt'])).toBe(false)
    expect(isProseOnlyChange(['migrations/expected-schema.txt'])).toBe(false)
    expect(isProseOnlyChange(['README.md', 'notes.txt'])).toBe(false)
  })

  test('"I could not tell" is never an exemption', () => {
    expect(isProseOnlyChange(null)).toBe(false)
    expect(isProseOnlyChange(undefined)).toBe(false)
    expect(isProseOnlyChange([])).toBe(false)
    expect(isProseOnlyChange([''])).toBe(false)
    expect(isProseOnlyChange(['config.yaml'])).toBe(false)
    expect(isProseOnlyChange(['Makefile'])).toBe(false)
  })

  test('the file list comes from git, and an unreadable diff reads as null', async () => {
    const payload = nameStatus('README.md\0docs/a.md\0')
    const files = await changedFilesOnBranch(async () => res(0, payload), '/repo', 'main', 'feat-x')
    expect(files).toEqual(['README.md', 'docs/a.md'])
    expect(await changedFilesOnBranch(async () => res(1), '/repo', 'main', 'feat-x')).toBeNull()
    expect(await changedFilesOnBranch(async () => res(0, payload), '/repo', 'main', null)).toBeNull()
    // AN EMPTY DIFF IS AN ANSWER, NOT A FAILURE, and the two must not share a
    // return value: git exiting 0 with nothing to print is `[]`, git FAILING is
    // null. Collapsed together, the gate reported "the branch diff could not be
    // read" about a diff it read perfectly — sending the reader after a git
    // problem that never happened, and leaving the refusal that names the real
    // condition unreachable. Both still fail closed (see the gate tests below).
    expect(await changedFilesOnBranch(async () => res(0, ''), '/repo', 'main', 'feat-x')).toEqual([])
    expect(await changedFilesWithStatus(async () => res(0, ''), '/repo', 'main', 'feat-x')).toEqual([])
    // A MALFORMED ANSWER IS NOT A FILE LIST. A status/path stream that does not
    // pair up, a record not terminated by its NUL, or a status field that is
    // not the single letter `--no-renames` guarantees (`R100` carries TWO
    // paths, and reading it as one would drop the source) all read as null,
    // i.e. REQUIRE THE PROOF — never as a shorter list that quietly exempts.
    for (const bad of ['M\0a.md', 'M\0a.md\0M\0', 'R100\0src/a.ts\0src/b.ts\0', 'M\0\0', 'a.md\0']) {
      expect(await changedFilesOnBranch(async () => res(0, bad), '/repo', 'main', 'feat-x')).toBeNull()
    }
    // …AND A TRUNCATED STREAM, which is the one the pairing check above cannot
    // catch: `M\0a.md\0D` has an even field count once the unterminated tail is
    // sliced off, so without the terminator check it parses as the SHORTER list
    // `['a.md']` and the truncated deletion vanishes. `M` alone — a stream with
    // no NUL at all — slices to nothing and would read as an EMPTY diff. Both
    // must be null: a stream we cannot read whole REQUIRES THE PROOF.
    expect(await changedFilesOnBranch(async () => res(0, 'M\0a.md\0D'), '/repo', 'main', 'feat-x')).toBeNull()
    expect(await changedFilesOnBranch(async () => res(0, 'M'), '/repo', 'main', 'feat-x')).toBeNull()
    // POSITIVE CONTROL: the same stream, well-formed, is read.
    expect(await changedFilesOnBranch(async () => res(0, 'M\0a.md\0'), '/repo', 'main', 'feat-x')).toEqual(['a.md'])
  })

  test('the status comes back with the path, so a DELETION is not mistaken for a mutation target', async () => {
    // A deleted path really did change and stays in the list — `claim.file` must
    // appear there — but it is absent at the pinned head, so the prover refuses
    // any nomination of it. Reading the status is what tells the two apart.
    const entries = await changedFilesWithStatus(
      async () => res(0, nameStatus('src/gone.ts\0src/limit.ts\0', ['src/gone.ts'])),
      '/repo',
      'main',
      'feat-x',
    )
    expect(entries).toEqual([
      { path: 'src/gone.ts', deleted: true },
      { path: 'src/limit.ts', deleted: false },
    ])
    // The deletion is a changed file…
    expect(await changedFilesOnBranch(async () => res(0, nameStatus('src/gone.ts\0', ['src/gone.ts'])), '/repo', 'main', 'x')).toEqual(
      ['src/gone.ts'],
    )
    // …and it is NOT a legal mutation target, while the same path modified is.
    expect(legalMutationTargets(['src/gone.ts', 'src/limit.ts'], ['src/gone.ts'])).toEqual(['src/limit.ts'])
    expect(legalMutationTargets(['src/gone.ts'], ['src/gone.ts'])).toEqual([])
    expect(legalMutationTargets(['src/gone.ts'], [])).toEqual(['src/gone.ts'])
  })

  test("a LEADING SPACE survives the host seam's trim — `--name-status` is what protects the first path", async () => {
    // THE BUG THIS CLOSES. `run_host` returns `stdout.trim()` (git-mode.ts), and
    // that runs before this parser sees a byte. Under `--name-only` the first
    // record WAS the first path, so a branch whose only changed file is
    // ` README.md` (leading space — a legal git path, and NOT README.md)
    // arrived as `README.md`, classified as prose, and bought the prose-only
    // exemption — defeating the byte-exactness this same parser fails closed on.
    const spaced = ' README.md'
    const trimming = async (): Promise<HostCommandResult> => diffRes(nameStatus(`${spaced}\0`))
    expect(await changedFilesOnBranch(trimming, '/repo', 'main', 'feat-x')).toEqual([spaced])
    // The consequence, not just the string: the odd name is not prose, so the
    // exemption cannot fire on it.
    expect(isProseOnlyChange([spaced])).toBe(false)
    // POSITIVE CONTROL — the space is the only difference: the same name
    // without it reads back identically and IS prose.
    expect(await changedFilesOnBranch(async () => diffRes(nameStatus('README.md\0')), '/repo', 'main', 'x')).toEqual([
      'README.md',
    ])
    expect(isProseOnlyChange(['README.md'])).toBe(true)
  })

  test('the diff is asked for with --no-renames, so a rename cannot hide its SOURCE', async () => {
    // Rename detection prints only the DESTINATION. `git mv src/limit.ts
    // src/limit.test.ts` would then show the diff as touching nothing but a
    // declared test — and carry the whole change into the new exemption. The
    // source path is a production file that really did change.
    const argv: string[][] = []
    await changedFilesOnBranch(
      async (cmd) => {
        argv.push([...cmd])
        return diffRes(nameStatus('src/limit.ts\0'))
      },
      '/repo',
      'main',
      'feat-x',
    )
    expect(argv).toHaveLength(1)
    expect(argv[0]).toContain('--no-renames')
    // …and with `-z`, which is the flag that actually keeps the bytes: it turns
    // C-QUOTING off as well as line-splitting, so a path with a byte outside
    // ASCII arrives as itself rather than as `"tests/s\303\274\303\237.test.ts"`
    // — a spelling that matches no test convention, classifies a declared test
    // as production, and can never equal `claim.file` either. (What real git
    // does with it is asserted in the real-git suite.)
    expect(argv[0]).toContain('-z')
    // …and with `--name-status`, which is not cosmetic: the leading status
    // letter is what stops `run_host`'s whole-stdout trim from eating a leading
    // space off the FIRST path, and it is how a deletion is told from an edit.
    expect(argv[0]).toContain('--name-status')
    // `core.quotePath=false` is belt and braces and is INERT under `-z` —
    // pinned as argv shape only, so that a future reader who drops `-z` does
    // not silently reintroduce quoting. It is not the mechanism.
    expect(argv[0]).toContain('core.quotePath=false')
  })

  test('a path is BYTES: NUL-separated and never trimmed, so trailing space cannot forge a test name', async () => {
    // THE BUG THIS CLOSES. The reader used to split on newlines and `.trim()`
    // every line. `src/logic.test.ts ` — trailing space, a legal git path, and
    // a PRODUCTION file — arrived trimmed to `src/logic.test.ts`, which is a
    // DECLARED TEST. That is the very input the no-production-file exemption is
    // decided on, so a diff of one such file bought itself an exemption and
    // merged with no proof at all.
    const spaced = 'src/logic.test.ts '
    const files = await changedFilesOnBranch(
      async () => diffRes(nameStatus(`${spaced}\0src/limit.ts\0`)),
      '/repo',
      'main',
      'feat-x',
    )
    expect(files).toEqual([spaced, 'src/limit.ts'])
    // The consequence, not just the string: it classifies as PRODUCTION, so the
    // exemption cannot fire on it.
    expect(classifyMutationTarget(spaced)).toBe('production')
    expect(diffHasNoLegalMutationTarget([spaced])).toBe(false)
    // POSITIVE CONTROL — the untrimmed name really is the only difference: the
    // same path WITHOUT the space is a declared test and does buy the exemption.
    expect(diffHasNoLegalMutationTarget([spaced.trim()])).toBe(true)

    // A path may also CONTAIN a newline. Splitting on lines tore it into two
    // half-paths, neither of which is any file; NUL keeps it one.
    const newlined = 'src/od\nd.ts'
    expect(
      await changedFilesOnBranch(async () => diffRes(nameStatus(`${newlined}\0`)), '/repo', 'main', 'feat-x'),
    ).toEqual([newlined])
  })

  test('prose is BYTES too — `README.md ` is not README.md, and does not buy the prose exemption', async () => {
    // The same non-preservation, one classifier over: trimming here let a file
    // whose name ends in a space carry a whole diff into the prose-only
    // exemption. Fails CLOSED — an odd name means "require the proof".
    expect(isProseOnlyChange(['README.md '])).toBe(false)
    expect(isProseOnlyChange([' README.md'])).toBe(false)
    // POSITIVE CONTROL: the exact name is still prose, so the rule above is
    // about the whitespace and nothing else.
    expect(isProseOnlyChange(['README.md'])).toBe(true)
  })
})

describe('runMutationProofGate — the phase between APPROVE and merge', () => {
  /**
   * The gate's PRODUCTION guard runner is the real killable spawner, so every
   * test that actually runs a proof injects `run_guard` — the scripted host —
   * rather than letting `bun test src/limit.test.ts` loose on this box.
   */
  function gateDeps(files: string, script: HostScript = {}): Pick<MutationGateInput, 'run_host' | 'run_guard'> {
    const scripted = scriptedHost(script)
    return {
      run_host: async (cmd: string[], cwd?: string): Promise<HostCommandResult> => {
        if (cmd.includes('diff') && cmd.includes('--name-status')) return diffRes(nameStatus(files))
        return scripted.run(cmd, cwd)
      },
      run_guard: async (argv: string[], cwd: string): Promise<HostCommandResult> => scripted.run(argv, cwd),
    }
  }

  test('a proved mutation opens the gate', async () => {
    const fs = memFs({ [join(proofWorktreePath('/repo', RUN), CLAIM.file)]: SRC_BEFORE })
    const out = await runMutationProofGate({
      run: RUN,
      claim: CLAIM,
      base_branch: 'main',
      ...gateDeps('src/limit.ts\0'),
      fs,
    })
    expect(out.ok).toBe(true)
    expect(out.exempt).toBe(false)
    expect(out.evidence?.proved).toBe(true)
    // The line that survives this process names WHICH commands were run.
    expect(out.reason).toContain('bun test src/limit.test.ts')
    expect(out.reason).toContain('bun test src/other.test.ts')
  })

  test('THE GATE HANDS THE PROVER THE DIFF — a bunfig this branch wrote refuses the bun guard end to end', async () => {
    // THE WIRING, pinned from the outside. The config arm can only fire on files
    // the BRANCH wrote, and the only place that list exists is the gate, which
    // already read it from git to bind the proof to this PR. If `prove` stops
    // being handed it, the arm silently sees an empty diff and every forged
    // bunfig passes again — nothing else in this file would notice.
    const fs = memFs({
      [join(proofWorktreePath('/repo', RUN), CLAIM.file)]: SRC_BEFORE,
      [join(proofWorktreePath('/repo', RUN), 'bunfig.toml')]: '[test]\npreload = ["./src/limit.ts"]\n',
    })
    const out = await runMutationProofGate({
      run: RUN,
      claim: CLAIM,
      base_branch: 'main',
      ...gateDeps('src/limit.ts\0bunfig.toml\0'),
      fs,
    })
    expect(out.ok).toBe(false)
    expect(out.exempt).toBe(false)
    expect(out.reason).toContain('bunfig.toml')
    expect(out.reason).toContain('BRANCH-SUPPLIED')
  })

  test('THE QUOTED AND DOTTED SPELLINGS TOO — the seat forged proved:true through the gate with these', async () => {
    // Run through `runMutationProofGate` itself, because that is the surface the
    // repro used: bare was refused, `"preload"`, `'preload'` and `test.preload`
    // all came back ok:true / proved:true.
    for (const body of [
      '[test]\n"preload" = ["./src/limit.ts"]\n',
      "[test]\n'preload' = ['./src/limit.ts']\n",
      'test.preload = ["./src/limit.ts"]\n',
      'test = { preload = ["./src/limit.ts"] }\n',
    ]) {
      const fs = memFs({
        [join(proofWorktreePath('/repo', RUN), CLAIM.file)]: SRC_BEFORE,
        [join(proofWorktreePath('/repo', RUN), 'bunfig.toml')]: body,
      })
      const out = await runMutationProofGate({
        run: RUN,
        claim: CLAIM,
        base_branch: 'main',
        ...gateDeps('src/limit.ts\0bunfig.toml\0'),
        fs,
      })
      expect([body, out.ok]).toEqual([body, false])
      expect(out.reason).toContain('bunfig.toml')
    }
  })

  test('AND THE package.json IMPORTS MAP — the other seat forged proved:true through this one', async () => {
    const fs = memFs({
      [join(proofWorktreePath('/repo', RUN), CLAIM.file)]: SRC_BEFORE,
      [join(proofWorktreePath('/repo', RUN), 'package.json')]: '{ "imports": { "#lib": "./src/limit.ts" } }',
    })
    const out = await runMutationProofGate({
      run: RUN,
      claim: CLAIM,
      base_branch: 'main',
      ...gateDeps('src/limit.ts\0package.json\0'),
      fs,
    })
    expect(out.ok).toBe(false)
    expect(out.exempt).toBe(false)
    expect(out.reason).toContain('package.json')
    expect(out.reason).toContain('imports')
  })

  test('…and the SAME bunfig outside the diff still opens the gate — the positive control on that wiring', async () => {
    // Byte-identical worktree, byte-identical claim: only the git-derived file
    // list differs. Without this row the assertion above would pass just as
    // happily on a gate that refused every bun nomination outright.
    //
    // WHAT IT PRELOADS IS A FILE THIS DIFF DOES NOT TOUCH, which is the shape a
    // repository that merely ships a bunfig actually has. An inherited preload
    // aimed at a file the BRANCH rewrites is a different question with its own
    // rows above — the config being main's does not make the code it runs
    // main's.
    const fs = memFs({
      [join(proofWorktreePath('/repo', RUN), CLAIM.file)]: SRC_BEFORE,
      [join(proofWorktreePath('/repo', RUN), 'bunfig.toml')]: '[test]\npreload = ["./tests/support/noop.ts"]\n',
    })
    const out = await runMutationProofGate({
      run: RUN,
      claim: CLAIM,
      base_branch: 'main',
      ...gateDeps('src/limit.ts\0'),
      fs,
    })
    expect(out.reason).not.toContain('bunfig.toml')
    expect(out.ok).toBe(true)
    expect(out.evidence?.proved).toBe(true)
  })

  test('the nominated file must be one THIS PR changes — otherwise it certifies nothing', async () => {
    // The bypass: nominate a mutation in stable, well-guarded code the diff never
    // touches. It proves red-then-green perfectly, and says nothing about the
    // merge — so one boilerplate nomination would satisfy the phase forever.
    const fs = memFs({ [join(proofWorktreePath('/repo', RUN), CLAIM.file)]: SRC_BEFORE })
    const deps = gateDeps('trident/merge.ts\0')
    const out = await runMutationProofGate({ run: RUN, claim: CLAIM, base_branch: 'main', ...deps, fs })
    expect(out.ok).toBe(false)
    expect(out.reason).toContain('is not in this branch')
    expect(out.evidence).toBeNull()
  })

  test('a guard that is not a test — the grep/echo pair — never opens the gate', async () => {
    // END TO END on the real bypass: `bash -c 'grep …'` reddens under any
    // mutation of the line and `sh -c 'echo ok'` is green by construction, so
    // the pair satisfies red-then-green while proving nothing. It has to be
    // refused at the CLAIM, before either one is executed.
    const fs = memFs({ [join(proofWorktreePath('/repo', RUN), CLAIM.file)]: SRC_BEFORE })
    const ran: string[][] = []
    const deps = gateDeps('src/limit.ts\0')
    const out = await runMutationProofGate({
      run: RUN,
      claim: { ...CLAIM, guard: ['bash', '-c', 'grep -q "n < LIMIT" src/limit.ts'], control: ['sh', '-c', 'echo ok'] },
      base_branch: 'main',
      run_host: deps.run_host,
      run_guard: async (argv, cwd) => {
        ran.push(argv)
        return res(0)
      },
      fs,
    })
    expect(out.ok).toBe(false)
    expect(out.reason).toContain('not a test runner')
    expect(ran).toHaveLength(0)
  })

  test('a branch that moved while the proof ran does not merge the commit it proved', async () => {
    const fs = memFs({ [join(proofWorktreePath('/repo', RUN), CLAIM.file)]: SRC_BEFORE })
    const scripted = scriptedHost()
    let headReads = 0
    const out = await runMutationProofGate({
      run: RUN,
      claim: CLAIM,
      base_branch: 'main',
      run_host: async (cmd, cwd) => {
        if (cmd.includes('diff') && cmd.includes('--name-status')) return diffRes(nameStatus('src/limit.ts\0'))
        if (cmd.includes('rev-parse')) {
          headReads += 1
          // The proof reads the head first; a push lands before the gate re-reads it.
          return res(0, headReads === 1 ? HEAD : 'b'.repeat(40))
        }
        return scripted.run(cmd, cwd)
      },
      run_guard: async (argv, cwd) => scripted.run(argv, cwd),
      fs,
    })
    expect(out.ok).toBe(false)
    expect(out.reason).toContain('is not the commit that was proved')
    // The proof itself was real — it is the BINDING that failed.
    expect(out.evidence?.proved).toBe(true)
  })

  test('the diff that BINDS the proof is read at the same commit the proof runs against', async () => {
    // THE RACE. The gate used to resolve the branch NAME twice — once for
    // `base...branch` (the file list that binds the proof to this PR) and again
    // inside `prove`. A push landing between them meant the binding described
    // commit A while the proof, and the final head check, described commit B: a
    // mutation of a file B never changed could sail through on A's file list.
    //
    // With one pinned commit there is only ever ONE resolution to race, so the
    // diff must be asked for by SHA, not by branch name.
    const fs = memFs({ [join(proofWorktreePath('/repo', RUN), CLAIM.file)]: SRC_BEFORE })
    const diffRanges: string[] = []
    const scripted = scriptedHost()
    const out = await runMutationProofGate({
      run: RUN,
      claim: CLAIM,
      base_branch: 'main',
      run_host: async (cmd, cwd) => {
        if (cmd.includes('--name-status')) {
          diffRanges.push(cmd[cmd.length - 1] ?? '')
          return diffRes(nameStatus('src/limit.ts\0'))
        }
        if (cmd.includes('rev-parse')) return res(0, HEAD)
        return scripted.run(cmd, cwd)
      },
      run_guard: async (argv, cwd) => scripted.run(argv, cwd),
      fs,
    })
    expect(out.ok).toBe(true)
    // The binding was read at the PINNED SHA, never at the mutable branch name.
    expect(diffRanges).toEqual([`main...${HEAD}`])
    expect(out.evidence?.observed?.head_sha).toBe(HEAD)
  })

  test('a branch that moves between the DIFF and the proof is refused', async () => {
    // The same race from the other side: the pin is taken, and by the time the
    // gate re-reads the head the branch has moved. The proof is of the pinned
    // commit, so what would merge is not what was proved.
    const fs = memFs({ [join(proofWorktreePath('/repo', RUN), CLAIM.file)]: SRC_BEFORE })
    const scripted = scriptedHost()
    let heads = 0
    const out = await runMutationProofGate({
      run: RUN,
      claim: CLAIM,
      base_branch: 'main',
      run_host: async (cmd, cwd) => {
        if (cmd.includes('--name-status')) return diffRes(nameStatus('src/limit.ts\0'))
        if (cmd.includes('rev-parse')) {
          heads += 1
          return res(0, heads === 1 ? HEAD : 'c'.repeat(40))
        }
        return scripted.run(cmd, cwd)
      },
      run_guard: async (argv, cwd) => scripted.run(argv, cwd),
      fs,
    })
    expect(out.ok).toBe(false)
    expect(out.reason).toContain('is not the commit that was proved')
  })

  test('an APPROVE with NO nominated mutation is blocked — the gate cannot run nothing', async () => {
    const out = await runMutationProofGate({
      run: RUN,
      claim: null,
      base_branch: 'main',
      ...gateDeps('src/limit.ts\0'),
    })
    expect(out.ok).toBe(false)
    expect(out.reason).toContain('nominated no mutation')
    // The refusal now names the legal target that existed and was not nominated.
    expect(out.reason).toContain('src/limit.ts')
    expect(out.evidence).toBeNull()
  })

  test("the caller's OWN pin wins: a tip that is not the commit the merge takes is refused", async () => {
    // `mergePr` merges `reviewedHead` (#545), this gate pins the branch TIP, and
    // nothing used to compare them — a tip that had moved past the reviewed
    // commit produced a valid proof of a commit that was never going to ship.
    // Refused BEFORE the diff is read: on the prose-only path the stale diff
    // would otherwise have exempted the merge outright.
    const calls: string[][] = []
    const fs = memFs({ [join(proofWorktreePath('/repo', RUN), CLAIM.file)]: SRC_BEFORE })
    const out = await runMutationProofGate({
      run: RUN,
      claim: CLAIM,
      base_branch: 'main',
      expected_head: 'd'.repeat(40),
      run_host: async (cmd) => {
        calls.push(cmd)
        if (cmd.includes('rev-parse')) return res(0, HEAD)
        if (cmd.includes('--name-status')) return diffRes(nameStatus('src/limit.ts\0'))
        return res(0)
      },
      fs,
    })
    expect(out.ok).toBe(false)
    expect(out.reason).toContain(`the merge would take dddddddd but the branch tip is ${HEAD.slice(0, 8)}`)
    expect(out.evidence).toBeNull()
    // Nothing was read and nothing was provisioned for the wrong commit.
    expect(calls.some((c) => c.includes('--name-status'))).toBe(false)
    expect(calls.some((c) => c.includes('worktree'))).toBe(false)
  })

  test("the caller's pin AGREEING with the tip changes nothing — the proof still runs", async () => {
    const fs = memFs({ [join(proofWorktreePath('/repo', RUN), CLAIM.file)]: SRC_BEFORE })
    const out = await runMutationProofGate({
      run: RUN,
      claim: CLAIM,
      base_branch: 'main',
      // Same commit, spelled the way git would NOT: the comparison normalises.
      expected_head: `  ${HEAD.toUpperCase()}  `,
      ...gateDeps('src/limit.ts\0'),
      fs,
    })
    expect(out.ok).toBe(true)
    expect(out.evidence?.observed?.head_sha).toBe(HEAD)
  })

  test('a docs-only diff is exempt WITHOUT running anything', async () => {
    const calls: string[][] = []
    const out = await runMutationProofGate({
      run: RUN,
      claim: null,
      base_branch: 'main',
      run_host: async (cmd) => {
        calls.push(cmd)
        if (cmd.includes('--name-status')) return diffRes(nameStatus('README.md\0docs/a.md\0'))
        // The gate PINS the commit before it reads the diff, and re-reads it to
        // confirm the branch has not moved under the exemption.
        if (cmd.includes('rev-parse')) return res(0, HEAD)
        return res(0)
      },
    })
    expect(out.ok).toBe(true)
    expect(out.exempt).toBe(true)
    expect(calls.some((c) => c.includes('worktree'))).toBe(false)
  })

  test('a docs-only diff whose branch MOVES under the exemption is not exempt', async () => {
    // The exemption is the one path that returns `ok` without running anything,
    // so it needs the same commit binding as the proof path: a branch that was
    // docs-only when the diff was read can pick up code straight afterwards, and
    // exempting THAT would merge unproved code with no proof ever run.
    let heads = 0
    const out = await runMutationProofGate({
      run: RUN,
      claim: null,
      base_branch: 'main',
      run_host: async (cmd) => {
        if (cmd.includes('--name-status')) return diffRes(nameStatus('README.md\0docs/a.md\0'))
        if (cmd.includes('rev-parse')) {
          heads += 1
          return res(0, heads === 1 ? HEAD : 'b'.repeat(40))
        }
        return res(0)
      },
    })
    expect(out.ok).toBe(false)
    expect(out.exempt).toBe(false)
    expect(out.reason).toContain('moved while the prose-only exemption')
  })

  test('a diff of only DECLARED TESTS plus prose is exempt, with its OWN reason', async () => {
    // The #489 class: every changed file is a declared test or documentation, so
    // the set of nominations that could pass is EMPTY. git — not the agent —
    // says no production file changed, so no production behaviour regressed.
    const calls: string[][] = []
    const host = async (cmd: string[]): Promise<HostCommandResult> => {
      calls.push(cmd)
      if (cmd.includes('--name-status')) {
        return diffRes(nameStatus('tests/support/scrub.test.ts\0gbrain-memory/__tests__/seam.depcruise.test.ts\0docs/notes.md\0'))
      }
      if (cmd.includes('rev-parse')) return res(0, HEAD)
      return res(0)
    }
    const out = await runMutationProofGate({ run: RUN, claim: null, base_branch: 'main', run_host: host })
    expect(out.ok).toBe(true)
    expect(out.exempt).toBe(true)
    expect(out.reason).toContain('no production file in this diff — nothing to mutate')
    // NOT the prose-only exemption: the run record must show WHICH one fired.
    expect(out.reason).not.toContain('prose-only')
    // …and WHICH NAMES bought it. The file list comes from git but the names are
    // the build's, so an exemption whose reason is only a count cannot be
    // second-guessed afterwards. Both, so a reason naming just the first file
    // does not pass — and the PROSE file too, because a reason filtered to the
    // declared tests leaves the reader to guess what the other entries were.
    expect(out.reason).toContain('tests/support/scrub.test.ts')
    expect(out.reason).toContain('gbrain-memory/__tests__/seam.depcruise.test.ts')
    expect(out.reason).toContain('docs/notes.md')
    expect(calls.some((c) => c.includes('worktree'))).toBe(false)

    // Claim-independent for the same reason the prose path is: the premise is
    // about the diff, not about the nomination.
    const withClaim = await runMutationProofGate({ run: RUN, claim: CLAIM, base_branch: 'main', run_host: host })
    expect(withClaim.exempt).toBe(true)
    expect(calls.some((c) => c.includes('worktree'))).toBe(false)
  })

  test('a diff of only direct-__tests__/-child HELPERS plus prose is exempt — the pinned deliberate design', async () => {
    // None of these files has a test suffix; the direct-child rule alone
    // declares them tests, so the exemption is bought by directory position.
    // That is today's DELIBERATE boundary (13 real support libraries sit
    // there); reclassifying them is the standing follow-up card's work.
    const calls: string[][] = []
    const host = async (cmd: string[]): Promise<HostCommandResult> => {
      calls.push(cmd)
      if (cmd.includes('--name-status')) {
        return diffRes(nameStatus('gbrain-memory/__tests__/helper.ts\0runtime/__tests__/stub-platform.ts\0docs/notes.md\0'))
      }
      if (cmd.includes('rev-parse')) return res(0, HEAD)
      return res(0)
    }
    const out = await runMutationProofGate({ run: RUN, claim: null, base_branch: 'main', run_host: host })
    expect(out.ok).toBe(true)
    expect(out.exempt).toBe(true)
    expect(out.reason).toContain('no production file in this diff — nothing to mutate')
    // NOT the prose-only exemption — and the two contains-assertions below are
    // the positive control that keeps this not-contains from passing on an
    // empty or generic reason.
    expect(out.reason).not.toContain('prose-only')
    expect(out.reason).toContain('gbrain-memory/__tests__/helper.ts')
    expect(out.reason).toContain('docs/notes.md')
    expect(calls.some((c) => c.includes('worktree'))).toBe(false)
  })

  test('…and ONE production file beside those helpers still REFUSES a claimless run — the exemption does not widen', async () => {
    const out = await runMutationProofGate({
      run: RUN,
      claim: null,
      base_branch: 'main',
      ...gateDeps('gbrain-memory/__tests__/helper.ts\0runtime/__tests__/stub-platform.ts\0src/limit.ts\0'),
    })
    expect(out.ok).toBe(false)
    expect(out.exempt).toBe(false)
    expect(out.reason).toContain('nominated no mutation')
    // The refusal names the legal target that existed and was not nominated.
    expect(out.reason).toContain('src/limit.ts')
    expect(out.evidence).toBeNull()
  })

  test('the exemption reason names EVERY file that bought it — no truncation, no filtering', async () => {
    // The audit trail is the point of the reason string, and a truncated list
    // hides exactly the entry a reviewer is here for: five ordinary names and a
    // sixth that a reader would want to look at twice. A cap of five put that
    // sixth behind a `+1 more`; a filter to the declared TESTS dropped the prose
    // entries out of a mixed diff and left the count unexplained. Every
    // realistic diff — this one included — is named in full; the length cap
    // below exists only for the diff that is not realistic.
    const names = ['a', 'b', 'c', 'd', 'e'].map((n) => `tests/${n}.test.ts`)
    const all = [...names, 'src/z-suspicious.spec.ts', 'docs/notes.md', 'README.md']
    const out = await runMutationProofGate({
      run: RUN,
      claim: null,
      base_branch: 'main',
      run_host: async (cmd) => {
        if (cmd.includes('--name-status')) return diffRes(nameStatus(`${all.join('\0')}\0`))
        if (cmd.includes('rev-parse')) return res(0, HEAD)
        return res(0)
      },
    })
    expect(out.exempt).toBe(true)
    // A FULL-LITERAL comparison of the named set, so a reason that named none of
    // them — or that dropped the last one — cannot pass.
    const named = (out.reason.split('documentation (')[1] ?? '').replace(/\)$/, '').split(', ')
    expect(named).toEqual(all)
    expect(out.reason).not.toContain('more)')
  })

  test('a THOUSAND-file test-only rename is capped, and the cap COUNTS what it elided', async () => {
    // The reason reaches a log line, a status post and a DB row, and nothing
    // downstream truncates it. Bounded by the diff is not bounded: a test-only
    // rename of a whole directory is a legal diff and would interpolate
    // hundreds of KB onto ONE line. The cap is on total length, not on a file
    // count, so the realistic diff above still names everything.
    const all = Array.from({ length: 1000 }, (_, i) => `tests/support/generated/case-${i}.test.ts`)
    const out = await runMutationProofGate({
      run: RUN,
      claim: null,
      base_branch: 'main',
      run_host: async (cmd) => {
        if (cmd.includes('--name-status')) return diffRes(nameStatus(`${all.join('\0')}\0`))
        if (cmd.includes('rev-parse')) return res(0, HEAD)
        return res(0)
      },
    })
    expect(out.exempt).toBe(true)
    expect(out.reason.length).toBeLessThan(4500)
    // The COUNT is the honest total even though the list is not, and the
    // elision says how many are missing rather than trailing off.
    expect(out.reason).toContain('all 1000 changed files')
    const named = (out.reason.split('documentation (')[1] ?? '').replace(/\)$/, '').split(', ')
    const elided = named[named.length - 1] as string
    expect(elided).toBe(`… +${1000 - (named.length - 1)} more`)
    // POSITIVE CONTROL against an empty extraction: real names were printed,
    // in order, starting at the first.
    expect(named[0]).toBe(all[0])
    expect(named.length).toBeGreaterThan(10)
  })

  test('a test-only diff whose branch MOVES under the new exemption is not exempt', async () => {
    let heads = 0
    const out = await runMutationProofGate({
      run: RUN,
      claim: null,
      base_branch: 'main',
      run_host: async (cmd) => {
        if (cmd.includes('--name-status')) {
          return diffRes(nameStatus('tests/support/scrub.test.ts\0gbrain-memory/__tests__/seam.depcruise.test.ts\0docs/notes.md\0'))
        }
        if (cmd.includes('rev-parse')) {
          heads += 1
          return res(0, heads === 1 ? HEAD : 'b'.repeat(40))
        }
        return res(0)
      },
    })
    expect(out.ok).toBe(false)
    expect(out.exempt).toBe(false)
    expect(out.reason).toContain('moved while the no-production-file exemption')
  })

  test('THE LOAD-BEARING NEGATIVE: a diff that still has a production file and no claim is REFUSED', async () => {
    // The new exemption must not widen into "no claim, no problem". One
    // production file in the diff and the proof is still required — and the
    // refusal names the target the build could have nominated.
    const out = await runMutationProofGate({
      run: RUN,
      claim: null,
      base_branch: 'main',
      ...gateDeps('tests/support/scrub.test.ts\0src/limit.ts\0docs/notes.md\0'),
    })
    expect(out.ok).toBe(false)
    expect(out.exempt).toBe(false)
    expect(out.reason).toContain('nominated no mutation')
    expect(out.reason).toContain('src/limit.ts')
  })

  test('a DELETION-ONLY production diff is refused, and the refusal does not send the build after a ghost', async () => {
    // The unreachable-nomination deadlock, at the gate. `src/gone.ts` is a
    // production change (so no exemption) that no mutation can apply to (so no
    // nomination can pass). What this fixes is the MESSAGE: it used to name
    // `src/gone.ts` as "a legal mutation target [that] existed", and the prover
    // then refused that very nomination for being absent at the head.
    const deleting = (files: string, deleted: readonly string[]) => async (cmd: string[]) => {
      if (cmd.includes('--name-status')) return diffRes(nameStatus(files, deleted))
      if (cmd.includes('rev-parse')) return res(0, HEAD)
      return res(0)
    }
    const out = await runMutationProofGate({
      run: RUN,
      claim: null,
      base_branch: 'main',
      run_host: deleting('src/gone.ts\0tests/a.test.ts\0', ['src/gone.ts']),
    })
    // STILL REFUSED — exempting this would be the rename bypass in a new coat.
    expect([out.ok, out.exempt]).toEqual([false, false])
    expect(out.reason).toContain('DELETIONS')
    expect(out.reason).toContain('src/gone.ts')
    expect(out.reason).not.toContain('nominated no mutation')

    // POSITIVE CONTROL 1 — the same paths MODIFIED rather than deleted still
    // blame the build, so the refusal above is about the status git reported.
    const modified = await runMutationProofGate({
      run: RUN,
      claim: null,
      base_branch: 'main',
      run_host: deleting('src/gone.ts\0tests/a.test.ts\0', []),
    })
    expect([modified.ok, modified.exempt]).toEqual([false, false])
    expect(modified.reason).toContain('nominated no mutation')

    // POSITIVE CONTROL 2 — a deletion beside a MODIFIED production file names
    // the one that can actually be nominated.
    const mixed = await runMutationProofGate({
      run: RUN,
      claim: null,
      base_branch: 'main',
      run_host: deleting('src/gone.ts\0src/limit.ts\0', ['src/gone.ts']),
    })
    expect(mixed.reason).toContain('nominated no mutation')
    expect(mixed.reason).toContain('src/limit.ts')
  })

  test('an unreadable diff takes the PROOF path, not the exempt path', async () => {
    const out = await runMutationProofGate({
      run: RUN,
      claim: null,
      base_branch: 'main',
      run_host: async (cmd) => (cmd.includes('check-ref-format') ? res(0) : res(1)),
    })
    expect(out.ok).toBe(false)
    expect(out.exempt).toBe(false)
  })

  test('an EMPTY diff is refused as EMPTY — not as a diff that could not be read', async () => {
    // The two conditions had one return value, so the gate said "the branch diff
    // could not be read" about a diff git read perfectly and reported as empty —
    // a diagnosis that sends the reader after a git failure that never happened,
    // and a refusal string ("the branch diff is empty") that nothing could reach.
    const empty = await runMutationProofGate({ run: RUN, claim: null, base_branch: 'main', ...gateDeps('') })
    expect([empty.ok, empty.exempt]).toEqual([false, false])
    expect(empty.reason).toContain('the branch diff is empty')
    expect(empty.reason).not.toContain('could not be read')

    // THE OTHER SIDE OF THE SPLIT, through the same harness: a diff git could
    // not read at all still says so. Without this the assertion above would hold
    // just as well if "could not be read" had simply stopped being reachable.
    const scripted = scriptedHost()
    const unreadable = await runMutationProofGate({
      run: RUN,
      claim: null,
      base_branch: 'main',
      run_host: async (cmd, cwd) =>
        cmd.includes('diff') && cmd.includes('--name-status') ? res(1) : scripted.run(cmd, cwd),
    })
    expect([unreadable.ok, unreadable.exempt]).toEqual([false, false])
    expect(unreadable.reason).toContain('could not be read')

    // AND IT IS STILL CLOSED. An empty list is not "nothing changed, so nothing
    // to mutate": `[].every(…)` is vacuously true, so the no-production-file
    // exemption would swallow it, and a nomination cannot bind to a diff with no
    // files either.
    expect(diffHasNoLegalMutationTarget([])).toBe(false)
    const fs = memFs({ [join(proofWorktreePath('/repo', RUN), CLAIM.file)]: SRC_BEFORE })
    const claimed = await runMutationProofGate({ run: RUN, claim: CLAIM, base_branch: 'main', ...gateDeps(''), fs })
    expect([claimed.ok, claimed.exempt]).toEqual([false, false])
    expect(claimed.reason).toContain('is not in this branch')
    expect(fs.writes).toEqual([])

    // POSITIVE CONTROL on the same seam: a NON-empty diff through the identical
    // harness reaches the proof, so the refusals above are about emptiness and
    // not about `gateDeps` refusing everything.
    const live = memFs({ [join(proofWorktreePath('/repo', RUN), CLAIM.file)]: SRC_BEFORE })
    const proved = await runMutationProofGate({
      run: RUN,
      claim: CLAIM,
      base_branch: 'main',
      ...gateDeps('src/limit.ts\0'),
      fs: live,
    })
    expect([proved.ok, proved.evidence?.proved ?? null]).toEqual([true, true])
  })

  test('a guard that does not go red blocks the merge, and says why', async () => {
    const fs = memFs({ [join(proofWorktreePath('/repo', RUN), CLAIM.file)]: SRC_BEFORE })
    const out = await runMutationProofGate({
      run: RUN,
      claim: CLAIM,
      base_branch: 'main',
      ...gateDeps('src/limit.ts\0', { guardMutated: 0 }),
      fs,
    })
    expect(out.ok).toBe(false)
    expect(out.reason).toContain('PASSED under the mutation')
  })

  test('the gate takes no evidence as INPUT — only a claim it executes', async () => {
    // TYPE-LEVEL: `MutationGateInput` itself is the subject. If a future refactor
    // adds an `evidence` key to it, `Smuggled` resolves to `never`, the literal
    // below stops being assignable and the TYPECHECK MATRIX goes red. (The
    // previous version of this test enumerated a hand-written object literal, so
    // it would have stayed green through exactly the change it existed to catch.)
    type Smuggled = 'evidence' extends keyof MutationGateInput ? never : MutationGateInput
    const _noEvidenceOnTheType: Smuggled = {
      run: RUN,
      claim: null,
      base_branch: 'main',
      run_host: async () => res(1),
    }
    expect(_noEvidenceOnTheType.claim).toBeNull()

    // BEHAVIOURAL: a caller that smuggles a perfect-looking block in anyway gets
    // it IGNORED — the gate still runs the mutation, and with no claim to run it
    // blocks. Nothing a caller can pass is read as a proof.
    const smuggler = {
      run: RUN,
      claim: null,
      base_branch: 'main',
      run_host: async (cmd: string[]) =>
        cmd.includes('rev-parse') ? res(0, HEAD) : diffRes(nameStatus('src/limit.ts\0')),
      evidence: { schema: MUTATION_PROOF_SCHEMA, proved: true, proof_token: 'a'.repeat(64) },
    } as unknown as MutationGateInput
    const out = await runMutationProofGate(smuggler)
    expect(out.ok).toBe(false)
    expect(out.reason).toContain('nominated no mutation')
  })

  test('a cleaned-up worktree does not strand an APPROVED build: the remote-tracking ref resolves the head', async () => {
    // THE #482 FAILURE. The run's worktree — which held the LOCAL branch — is
    // torn down before this gate runs, so the bare name resolves nowhere. The
    // commit is still in the object store, reachable through origin/<branch>.
    const fs = memFs({ [join(proofWorktreePath('/repo', RUN), CLAIM.file)]: SRC_BEFORE })
    const scripted = scriptedHost()
    const calls: string[][] = []
    const out = await runMutationProofGate({
      run: RUN,
      claim: CLAIM,
      base_branch: 'main',
      run_host: async (cmd, cwd) => {
        calls.push(cmd)
        if (cmd.includes('--name-status')) return diffRes(nameStatus('src/limit.ts\0'))
        if (cmd.includes('fetch')) return res(0) // the tracking ref is read ONLY after a fetch that succeeded
        if (cmd.includes('rev-parse')) {
          return cmd[cmd.length - 1] === 'refs/remotes/origin/feat-x' ? res(0, HEAD) : res(1)
        }
        return scripted.run(cmd, cwd)
      },
      run_guard: async (argv, cwd) => scripted.run(argv, cwd),
      fs,
    })
    expect(out.ok).toBe(true)
    expect(out.exempt).toBe(false)
    expect(out.evidence?.proved).toBe(true)
    expect(out.evidence?.observed?.head_sha).toBe(HEAD)
    expect(calls.some((c) => c[c.length - 1] === 'refs/remotes/origin/feat-x')).toBe(true)
    // The no-ref-written / no-program-run evidence lives in mutation-prover-realgit.test.ts against REAL git repository state — an argv scan here passed while both round-3 defects were live, so it proves nothing.
  })

  test('the tracking ref is refreshed by an EXPLICIT forced refspec, not `git fetch origin <branch>`', async () => {
    // The short form's contract is FETCH_HEAD. On a remote with no matching
    // fetch refspec it leaves `refs/remotes/origin/<b>` exactly where it was,
    // so the resolver would pin a STALE sha and lose the caller-pin comparison.
    const calls: string[][] = []
    const sha = await resolveMergeHeadSha(
      async (cmd) => {
        calls.push(cmd)
        if (cmd.includes('fetch')) return res(0)
        return cmd[cmd.length - 1] === 'refs/remotes/origin/feat-x' ? res(0, HEAD) : res(1)
      },
      '/repo',
      'feat-x',
      null,
    )
    expect(sha).toBe(HEAD)
    const fetch = calls.find((c) => c.includes('fetch'))
    expect(fetch).toEqual([
      'git',
      '-C',
      '/repo',
      'fetch',
      '--no-tags',
      '--end-of-options',
      'origin',
      '+refs/heads/feat-x:refs/remotes/origin/feat-x',
    ])
  })

  test('a FAILED fetch does not license the tracking ref — the stale sha is never read', async () => {
    const STALE = 'b'.repeat(40)
    const calls: string[][] = []
    const sha = await resolveMergeHeadSha(
      async (cmd) => {
        calls.push(cmd)
        if (cmd.includes('fetch')) return res(1)
        if (cmd.includes('cat-file')) return res(0)
        return cmd[cmd.length - 1] === 'refs/remotes/origin/feat-x' ? res(0, STALE) : res(1)
      },
      '/repo',
      'feat-x',
      HEAD,
    )
    expect(sha).toBe(HEAD)
    expect(calls.some((c) => c[c.length - 1] === 'refs/remotes/origin/feat-x')).toBe(false)
    expect(calls.some((c) => c.includes('cat-file') && c.includes(`${HEAD}^{commit}`))).toBe(true)
  })

  test('a rev-parse that FAILED is not a resolution, even when it printed a sha-shaped line', async () => {
    // `git rev-parse <unknown-name>` prints the name back and exits non-zero. A
    // 40-hex-shaped branch name makes that echo look exactly like a resolution,
    // so the exit code is the only thing that can tell them apart.
    const sha = await resolveMergeHeadSha(
      async (cmd) => {
        if (cmd.includes('rev-parse')) {
          return { ok: false, stdout: `${'c'.repeat(40)}\n`, stderr: 'ambiguous argument', exit_code: 128 }
        }
        return res(0)
      },
      '/repo',
      'feat-x',
      HEAD,
    )
    expect(sha).toBe(HEAD)
  })

  test('a rejected branch name resolves NOTHING — no git invocation, no expected_head fallback', async () => {
    for (const hostile of [
      '--upload-pack=touch /scratch/upload-pack-executed',
      'feat-x:refs/heads/injected-by-branch',
      'feat x',
      '../../etc',
      'feat-x.lock',
      '',
    ]) {
      const calls: string[][] = []
      // The host answers SUCCESS to everything: the rejection must be the name's
      // doing, never an artifact of a failing command.
      const sha = await resolveMergeHeadSha(
        async (cmd) => {
          calls.push(cmd)
          return res(0, HEAD)
        },
        '/repo',
        hostile,
        HEAD,
      )
      expect(sha).toBeNull()
      expect(calls.length).toBe(0)
    }
  })

  test('the gate REFUSES a hostile branch name with its own reason — a valid expected_head does not rescue it', async () => {
    for (const hostile of ['--upload-pack=touch /scratch/upload-pack-executed', 'feat-x:refs/heads/injected-by-branch']) {
      const calls: string[][] = []
      const out = await runMutationProofGate({
        run: { ...RUN, branch: hostile },
        claim: CLAIM,
        base_branch: 'main',
        expected_head: HEAD,
        run_host: async (cmd) => {
          calls.push(cmd)
          return res(0, HEAD)
        },
      })
      expect(out.ok).toBe(false)
      expect(out.exempt).toBe(false)
      expect(out.evidence).toBeNull()
      expect(out.reason).toContain('is rejected')
      expect(out.reason).not.toContain('could not be resolved')
      expect(calls.length).toBe(0)
    }
  })

  test('a name only git can judge is delegated to check-ref-format — and its rejection refuses', async () => {
    const calls: string[][] = []
    const out = await runMutationProofGate({
      run: { ...RUN, branch: 'a/.hidden' }, // passes the pure allowlist; a component may not start with '.'
      claim: CLAIM,
      base_branch: 'main',
      expected_head: HEAD,
      run_host: async (cmd) => {
        calls.push(cmd)
        if (cmd.includes('check-ref-format')) {
          return { ok: false, stdout: '', stderr: "fatal: 'a/.hidden' is not a valid branch name", exit_code: 1 }
        }
        return res(0, HEAD)
      },
    })
    expect(out.ok).toBe(false)
    expect(out.reason).toContain('check-ref-format')
    expect(calls).toEqual([['git', '-C', '/repo', 'check-ref-format', '--branch', 'a/.hidden']])
  })

  test('drift is still caught when the head resolves through the REMOTE ref', async () => {
    // The widened resolution must not widen the binding: a branch that moves
    // between the pin and the re-read is still refused when the only ref that
    // resolves is the remote-tracking one.
    const fs = memFs({ [join(proofWorktreePath('/repo', RUN), CLAIM.file)]: SRC_BEFORE })
    const scripted = scriptedHost()
    let remoteReads = 0
    const out = await runMutationProofGate({
      run: RUN,
      claim: CLAIM,
      base_branch: 'main',
      run_host: async (cmd, cwd) => {
        if (cmd.includes('--name-status')) return diffRes(nameStatus('src/limit.ts\0'))
        if (cmd.includes('fetch')) return res(0)
        if (cmd.includes('rev-parse')) {
          if (cmd[cmd.length - 1] !== 'refs/remotes/origin/feat-x') return res(1)
          remoteReads += 1
          return res(0, remoteReads === 1 ? HEAD : 'f'.repeat(40))
        }
        return scripted.run(cmd, cwd)
      },
      run_guard: async (argv, cwd) => scripted.run(argv, cwd),
      fs,
    })
    expect(out.ok).toBe(false)
    expect(out.reason).toContain(`the branch moved from ${HEAD.slice(0, 8)} to ffffffff`)
  })

  test('an unverifiable expected_head is never a resolution — and a name-shaped one is not even tried', async () => {
    // The fallback must not become a way to hand the gate a sha nothing can see.
    const calls: string[][] = []
    const absent = await runMutationProofGate({
      run: RUN,
      claim: CLAIM,
      base_branch: 'main',
      expected_head: 'e'.repeat(40),
      run_host: async (cmd) => {
        calls.push(cmd)
        if (cmd.includes('fetch')) return res(0)
        if (cmd.includes('cat-file')) return res(1) // the object is not in this repo
        if (cmd.includes('rev-parse')) return res(1)
        return res(0)
      },
    })
    expect(absent.ok).toBe(false)
    expect(absent.evidence).toBeNull()
    expect(absent.reason).toContain('could not be resolved')
    expect(calls.some((c) => c.includes('cat-file'))).toBe(true)

    const nameCalls: string[][] = []
    const named = await runMutationProofGate({
      run: RUN,
      claim: CLAIM,
      base_branch: 'main',
      expected_head: 'refs/heads/main',
      run_host: async (cmd) => {
        nameCalls.push(cmd)
        if (cmd.includes('fetch')) return res(0)
        if (cmd.includes('cat-file')) return res(1)
        if (cmd.includes('rev-parse')) return res(1)
        return res(0)
      },
    })
    expect(named.ok).toBe(false)
    expect(named.reason).toContain('could not be resolved')
    // A NAME is never handed to git at all — only a 40-hex sha is ever checked.
    expect(nameCalls.some((c) => c.includes('cat-file'))).toBe(false)
  })

  test('the fallback cannot bypass the caller-pin mismatch', async () => {
    const calls: string[][] = []
    const out = await runMutationProofGate({
      run: RUN,
      claim: CLAIM,
      base_branch: 'main',
      expected_head: 'd'.repeat(40),
      run_host: async (cmd) => {
        calls.push(cmd)
        if (cmd.includes('fetch')) return res(0)
        if (cmd.includes('rev-parse')) {
          return cmd[cmd.length - 1] === 'refs/remotes/origin/feat-x' ? res(0, HEAD) : res(1)
        }
        return res(0)
      },
    })
    expect(out.ok).toBe(false)
    expect(out.reason).toContain(`the merge would take dddddddd but the branch tip is ${HEAD.slice(0, 8)}`)
    expect(out.evidence).toBeNull()
    // Refused BEFORE the diff and before any worktree, like any caller-pin mismatch.
    expect(calls.some((c) => c.includes('--name-status'))).toBe(false)
    expect(calls.some((c) => c.includes('worktree'))).toBe(false)
  })

  test('when no ref exists at all, expected_head binds the proof — after the object is proven present', async () => {
    const fs = memFs({ [join(proofWorktreePath('/repo', RUN), CLAIM.file)]: SRC_BEFORE })
    const scripted = scriptedHost()
    const out = await runMutationProofGate({
      run: RUN,
      claim: CLAIM,
      base_branch: 'main',
      expected_head: HEAD,
      run_host: async (cmd, cwd) => {
        if (cmd.includes('--name-status')) return diffRes(nameStatus('src/limit.ts\0'))
        if (cmd.includes('fetch')) return res(1)
        if (cmd.includes('cat-file')) return res(0) // the commit IS here
        if (cmd.includes('rev-parse')) return res(1)
        return scripted.run(cmd, cwd)
      },
      run_guard: async (argv, cwd) => scripted.run(argv, cwd),
      fs,
    })
    expect(out.ok).toBe(true)
    expect(out.evidence?.proved).toBe(true)
    expect(out.evidence?.observed?.head_sha).toBe(HEAD)
  })

  test('a docs-only diff is still exempt when only the remote-tracking ref resolves', async () => {
    // The prose-only path re-reads the head through `headStillAt`; a local-only
    // resolution there would refuse "the branch moved" on a live, unmoved branch.
    const out = await runMutationProofGate({
      run: RUN,
      claim: null,
      base_branch: 'main',
      run_host: async (cmd) => {
        if (cmd.includes('--name-status')) return diffRes(nameStatus('README.md\0docs/a.md\0'))
        if (cmd.includes('fetch')) return res(0)
        if (cmd.includes('rev-parse')) {
          return cmd[cmd.length - 1] === 'refs/remotes/origin/feat-x' ? res(0, HEAD) : res(1)
        }
        return res(0)
      },
    })
    expect(out.ok).toBe(true)
    expect(out.exempt).toBe(true)
  })
})
