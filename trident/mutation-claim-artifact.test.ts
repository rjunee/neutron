import { describe, expect, test } from 'bun:test'

import type { HostCommandResult } from './git-mode.ts'
import type { RunHostCommand } from './merge.ts'
import { parseMutationClaim, runMutationProofGate } from './mutation-prover.ts'
import {
  MUTATION_CLAIM_ARTIFACT_MAX_BYTES,
  MUTATION_CLAIM_ARTIFACT_PATH,
  readCommittedMutationClaim,
} from './mutation-claim-artifact.ts'

/**
 * THE COMMITTED NOMINATION READER.
 *
 * Two properties carry this file. First, the revision operand is sanitized
 * BEFORE it may touch git — every unsafe ref must leave the recorded argv log
 * EMPTY, not merely fail. Second, the reader is exactly as permissive as the
 * agent route's decode and no more: it adds no validation of its own, so a
 * claim that the gate would refuse still SURVIVES the read.
 *
 * Every case below is paired with a control that goes the other way (1 against
 * 2, the two halves of the oversize case, the decode parity in 4), so a reader
 * stubbed to a constant — null or claim — fails one side of each pair.
 */

const REPO = '/repo'
const OID = 'a'.repeat(40)

const BODY = JSON.stringify({
  file: 'trident/limit.ts',
  find: 'n < LIMIT',
  replace: 'true',
  guard: ['bun', 'test', 'trident/limit.test.ts'],
  control: ['bun', 'test', 'trident/other.test.ts'],
  rationale: 'r',
})

function ok(stdout: string): HostCommandResult {
  return { ok: true, stdout, stderr: '', exit_code: 0 }
}

function fail(exit_code: number): HostCommandResult {
  return { ok: false, stdout: '', stderr: 'fatal: path does not exist', exit_code }
}

/** A scripted host that RECORDS every argv it was handed. */
function makeHost(answers: HostCommandResult[] | (() => never)): {
  run: RunHostCommand
  calls: string[][]
} {
  const calls: string[][] = []
  const queue = Array.isArray(answers) ? [...answers] : null
  const run: RunHostCommand = async (cmd) => {
    calls.push([...cmd])
    if (queue === null) return (answers as () => never)()
    return queue.shift() ?? fail(1)
  }
  return { run, calls }
}

describe('readCommittedMutationClaim', () => {
  test('reads the artifact at a 40-hex OID and pins the exact argv', async () => {
    const host = makeHost([ok(BODY)])

    const claim = await readCommittedMutationClaim(host.run, REPO, { expected_head: OID, branch: 'feat-x' })

    expect(claim).toEqual(parseMutationClaim(JSON.parse(BODY)))
    expect(claim).not.toBeNull()
    // The whole array, because this is the injection surface.
    expect(host.calls).toEqual([['git', '-C', REPO, 'show', `${OID}:.trident/mutation-claim.json`]])
  })

  test('a missing artifact at that same revision is null', async () => {
    // Identical to the case above but for the host's ANSWER: the pair is what
    // makes a constant-null and a constant-claim reader both fail.
    const host = makeHost([fail(128)])

    const claim = await readCommittedMutationClaim(host.run, REPO, { expected_head: OID, branch: 'feat-x' })

    expect(claim).toBeNull()
    expect(host.calls).toEqual([['git', '-C', REPO, 'show', `${OID}:.trident/mutation-claim.json`]])
  })

  test('a malformed JSON body is null', async () => {
    const host = makeHost([ok('{nope')])

    expect(await readCommittedMutationClaim(host.run, REPO, { expected_head: OID })).toBeNull()
    expect(host.calls).toHaveLength(1)
  })

  test('valid JSON of the wrong shape is null — and the decode is what rejects it', async () => {
    const wrong = JSON.parse(BODY) as Record<string, unknown>
    wrong.guard = 'bun test trident/limit.test.ts' // a shell string, never an argv
    const host = makeHost([ok(JSON.stringify(wrong))])

    expect(await readCommittedMutationClaim(host.run, REPO, { expected_head: OID })).toBeNull()
    // Parity control: the same value decodes to null on the agent route too.
    expect(parseMutationClaim(wrong)).toBeNull()
    // ...and the decode really is discriminating, not constant-null.
    expect(parseMutationClaim(JSON.parse(BODY))).not.toBeNull()
  })

  test('a body over the byte cap is null; the same body under it resolves', async () => {
    const big = JSON.parse(BODY) as Record<string, unknown>
    big.rationale = 'x'.repeat(MUTATION_CLAIM_ARTIFACT_MAX_BYTES)
    const oversize = JSON.stringify(big)
    expect(Buffer.byteLength(oversize, 'utf8')).toBeGreaterThan(MUTATION_CLAIM_ARTIFACT_MAX_BYTES)
    // Syntactically VALID JSON: only the cap can be doing the rejecting.
    expect(() => JSON.parse(oversize)).not.toThrow()

    const tooBig = makeHost([ok(oversize)])
    expect(await readCommittedMutationClaim(tooBig.run, REPO, { expected_head: OID })).toBeNull()

    const small = JSON.parse(BODY) as Record<string, unknown>
    small.rationale = 'r'
    const trimmed = JSON.stringify(small)
    expect(Buffer.byteLength(trimmed, 'utf8')).toBeLessThanOrEqual(MUTATION_CLAIM_ARTIFACT_MAX_BYTES)

    const fits = makeHost([ok(trimmed)])
    expect(await readCommittedMutationClaim(fits.run, REPO, { expected_head: OID })).not.toBeNull()
  })

  test('falls back to refs/heads/<branch> when there is no OID', async () => {
    const host = makeHost([ok(BODY)])

    const claim = await readCommittedMutationClaim(host.run, REPO, {
      expected_head: null,
      branch: 'trident/some-fix',
    })

    expect(claim).toEqual(parseMutationClaim(JSON.parse(BODY)))
    expect(host.calls).toHaveLength(1)
    expect(host.calls[0]?.at(-1)).toBe(`refs/heads/trident/some-fix:${MUTATION_CLAIM_ARTIFACT_PATH}`)
  })

  test('an unsafe revision never reaches git', async () => {
    const cases: Array<{ what: string; source: { expected_head?: string | null; branch?: string | null } }> = [
      { what: 'a short hex head with no branch', source: { expected_head: 'abc', branch: null } },
      { what: 'a branch that is an option', source: { expected_head: null, branch: '--upload-pack=/tmp/x' } },
      { what: 'a branch that is a refspec', source: { expected_head: null, branch: 'feat:refs/heads/x' } },
      { what: 'an empty branch', source: { expected_head: null, branch: '' } },
      { what: 'a null branch', source: { expected_head: null, branch: null } },
      { what: 'nothing at all', source: {} },
    ]

    for (const c of cases) {
      const host = makeHost([ok(BODY)])
      expect(await readCommittedMutationClaim(host.run, REPO, c.source)).toBeNull()
      // The point of the case: refused WITHOUT a command, not by a failed one.
      expect({ what: c.what, calls: host.calls.length }).toEqual({ what: c.what, calls: 0 })
    }
  })

  test('an uppercase, padded expected_head is trimmed and lowercased before use', async () => {
    const host = makeHost([ok(BODY)])

    const claim = await readCommittedMutationClaim(host.run, REPO, {
      expected_head: `  ${'A'.repeat(40)}  `,
    })

    expect(claim).not.toBeNull()
    expect(host.calls).toEqual([['git', '-C', REPO, 'show', `${'a'.repeat(40)}:${MUTATION_CLAIM_ARTIFACT_PATH}`]])
  })

  test('a host that throws resolves null rather than rejecting', async () => {
    const host = makeHost(() => {
      throw new Error('spawn failed')
    })

    await expect(readCommittedMutationClaim(host.run, REPO, { expected_head: OID })).resolves.toBeNull()
    expect(host.calls).toHaveLength(1)
  })

  test('an absolute-path file SURVIVES the read — the gate does that rejecting', async () => {
    const escaping = JSON.parse(BODY) as Record<string, unknown>
    escaping.file = '/etc/passwd'
    const host = makeHost([ok(JSON.stringify(escaping))])

    const claim = await readCommittedMutationClaim(host.run, REPO, { expected_head: OID })

    // Deliberate: the reader is exactly the agent route's decode, so this
    // nomination reaches `validateClaim` on identical terms and is refused
    // there, not here.
    expect(claim).not.toBeNull()
    expect(claim?.file).toBe('/etc/passwd')
    expect(claim).toEqual(parseMutationClaim(escaping))
  })

  test('the artifact path constant is the one the contract names', () => {
    expect(MUTATION_CLAIM_ARTIFACT_PATH).toBe('.trident/mutation-claim.json')
    expect(MUTATION_CLAIM_ARTIFACT_MAX_BYTES).toBe(32 * 1024)
  })
})

describe('agent-route parity at the REAL gate — the fallback adds no trust', () => {
  test('an absolute-path nomination survives the read, and runMutationProofGate refuses it before any guard runs', async () => {
    const absolute = {
      file: '/repo/src/limit.ts',
      find: 'n < LIMIT',
      replace: 'true',
      guard: ['bun', 'test', 'src/limit.test.ts'],
      control: ['bun', 'test', 'src/other.test.ts'],
    }
    // The reader hands it over UNVALIDATED — decode parity with the agent route.
    const host = makeHost([ok(JSON.stringify(absolute))])
    const claim = await readCommittedMutationClaim(host.run, REPO, { expected_head: OID, branch: 'feat-x' })
    expect(claim).not.toBeNull() // positive control: the extraction really happened
    expect(claim).toEqual(absolute)
    // The REAL gate refuses that same object repo-relatively — even against a
    // COLLUDING diff that lists the absolute path verbatim — with zero guard runs.
    const ran: string[][] = []
    const out = await runMutationProofGate({
      run: { id: 'run-1', slug: 'x', repo_path: REPO, branch: 'feat-x' },
      claim,
      base_branch: 'main',
      expected_head: OID,
      run_host: async (cmd) => {
        if (cmd.includes('rev-parse')) return ok(`${OID}\n`)
        if (cmd.includes('diff') && cmd.includes('--name-only')) return ok('/repo/src/limit.ts\n')
        return ok('')
      },
      run_guard: async (argv) => {
        ran.push([...argv])
        return ok('')
      },
    })
    expect(out.ok).toBe(false)
    expect(out.reason).toContain('repo-relative')
    expect(ran).toHaveLength(0)
  })
})
