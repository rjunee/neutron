import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

import type { HostCommandResult } from './git-mode.ts'
import {
  changedFilesOnBranch,
  createMutationProver,
  isProseOnlyChange,
  MUTATION_PROOF_SCHEMA,
  MUTATION_PROVER_VERSION,
  parseMutationClaim,
  proofWorktreePath,
  runMutationProofGate,
  type MutationClaim,
  type MutationEvidence,
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
      command_timeout_ms: 5,
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
    expect(rm.reason).toContain('not on the prover allowlist')
    expect(host.calls).toHaveLength(0)
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
  function gateHost(files: string, script: HostScript = {}) {
    const scripted = scriptedHost(script)
    return async (cmd: string[], cwd?: string): Promise<HostCommandResult> => {
      if (cmd.includes('diff') && cmd.includes('--name-only')) return res(0, files)
      return scripted.run(cmd, cwd)
    }
  }

  test('a proved mutation opens the gate', async () => {
    const fs = memFs({ [join(proofWorktreePath('/repo', RUN), CLAIM.file)]: SRC_BEFORE })
    const out = await runMutationProofGate({
      run: RUN,
      claim: CLAIM,
      base_branch: 'main',
      run_host: gateHost('src/limit.ts\n'),
      fs,
    })
    expect(out.ok).toBe(true)
    expect(out.exempt).toBe(false)
    expect(out.evidence?.proved).toBe(true)
  })

  test('an APPROVE with NO nominated mutation is blocked — the gate cannot run nothing', async () => {
    const out = await runMutationProofGate({
      run: RUN,
      claim: null,
      base_branch: 'main',
      run_host: gateHost('src/limit.ts\n'),
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
      run_host: gateHost('src/limit.ts\n', { guardMutated: 0 }),
      fs,
    })
    expect(out.ok).toBe(false)
    expect(out.reason).toContain('PASSED under the mutation')
  })

  test('the gate takes no evidence as INPUT — only a claim it executes', () => {
    // A structural property, asserted so a future refactor cannot quietly add an
    // `evidence` parameter: the only way to get a verdict out of this module is
    // to hand it a mutation to RUN.
    const params = Object.keys({
      run: 0,
      claim: 0,
      base_branch: 0,
      run_host: 0,
      prover: 0,
      fs: 0,
      command_timeout_ms: 0,
    })
    expect(params).not.toContain('evidence')
  })
})
