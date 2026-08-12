import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

import type { HostCommandResult } from './git-mode.ts'
import {
  canonicalPayload,
  changedFilesOnBranch,
  createMutationProver,
  isProseOnlyChange,
  MUTATION_PROOF_SCHEMA,
  MUTATION_PROVER_VERSION,
  parseMutationClaim,
  proofWorktreePath,
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
        if (cmd.includes('add')) return s.worktreeAddFails === true ? res(1) : res(0)
        return res(0)
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
    expect(joined.filter((c) => c.includes('worktree remove')).length).toBe(2)
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
      ['npm', 'run', 'test:unit'],
      ['cargo', 'test'],
      ['make', 'test-unit'],
    ]) {
      const accepted = await prover.prove({ run: RUN, claim: { ...CLAIM, guard } })
      expect(accepted.observed).not.toBeNull()
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
    const files = await changedFilesOnBranch(async () => res(0, 'README.md\ndocs/a.md\n'), '/repo', 'main', 'feat-x')
    expect(files).toEqual(['README.md', 'docs/a.md'])
    expect(await changedFilesOnBranch(async () => res(1), '/repo', 'main', 'feat-x')).toBeNull()
    expect(await changedFilesOnBranch(async () => res(0, ''), '/repo', 'main', 'feat-x')).toBeNull()
    expect(await changedFilesOnBranch(async () => res(0, 'a.md'), '/repo', 'main', null)).toBeNull()
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
        if (cmd.includes('diff') && cmd.includes('--name-only')) return res(0, files)
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
      ...gateDeps('src/limit.ts\n'),
      fs,
    })
    expect(out.ok).toBe(true)
    expect(out.exempt).toBe(false)
    expect(out.evidence?.proved).toBe(true)
    // The line that survives this process names WHICH commands were run.
    expect(out.reason).toContain('bun test src/limit.test.ts')
    expect(out.reason).toContain('bun test src/other.test.ts')
  })

  test('the nominated file must be one THIS PR changes — otherwise it certifies nothing', async () => {
    // The bypass: nominate a mutation in stable, well-guarded code the diff never
    // touches. It proves red-then-green perfectly, and says nothing about the
    // merge — so one boilerplate nomination would satisfy the phase forever.
    const fs = memFs({ [join(proofWorktreePath('/repo', RUN), CLAIM.file)]: SRC_BEFORE })
    const deps = gateDeps('trident/merge.ts\n')
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
    const deps = gateDeps('src/limit.ts\n')
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
        if (cmd.includes('diff') && cmd.includes('--name-only')) return res(0, 'src/limit.ts\n')
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

  test('an APPROVE with NO nominated mutation is blocked — the gate cannot run nothing', async () => {
    const out = await runMutationProofGate({
      run: RUN,
      claim: null,
      base_branch: 'main',
      ...gateDeps('src/limit.ts\n'),
    })
    expect(out.ok).toBe(false)
    expect(out.reason).toContain('nominated no mutation')
    expect(out.evidence).toBeNull()
  })

  test('a docs-only diff is exempt WITHOUT running anything', async () => {
    const calls: string[][] = []
    const out = await runMutationProofGate({
      run: RUN,
      claim: null,
      base_branch: 'main',
      run_host: async (cmd) => {
        calls.push(cmd)
        return cmd.includes('--name-only') ? res(0, 'README.md\ndocs/a.md\n') : res(0)
      },
    })
    expect(out.ok).toBe(true)
    expect(out.exempt).toBe(true)
    expect(calls.some((c) => c.includes('worktree'))).toBe(false)
  })

  test('an unreadable diff takes the PROOF path, not the exempt path', async () => {
    const out = await runMutationProofGate({
      run: RUN,
      claim: null,
      base_branch: 'main',
      run_host: async () => res(1),
    })
    expect(out.ok).toBe(false)
    expect(out.exempt).toBe(false)
  })

  test('a guard that does not go red blocks the merge, and says why', async () => {
    const fs = memFs({ [join(proofWorktreePath('/repo', RUN), CLAIM.file)]: SRC_BEFORE })
    const out = await runMutationProofGate({
      run: RUN,
      claim: CLAIM,
      base_branch: 'main',
      ...gateDeps('src/limit.ts\n', { guardMutated: 0 }),
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
      run_host: async () => res(0, 'src/limit.ts\n'),
      evidence: { schema: MUTATION_PROOF_SCHEMA, proved: true, proof_token: 'a'.repeat(64) },
    } as unknown as MutationGateInput
    const out = await runMutationProofGate(smuggler)
    expect(out.ok).toBe(false)
    expect(out.reason).toContain('nominated no mutation')
  })
})
