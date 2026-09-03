import { describe, expect, test } from 'bun:test'

import type { HostCommandResult } from './git-mode.ts'
import type { RunHostCommand } from './merge.ts'
import { parseMutationClaim, runMutationProofGate } from './mutation-prover.ts'
import {
  MUTATION_CLAIM_ARTIFACT_DIR,
  MUTATION_CLAIM_ARTIFACT_MAX_BYTES,
  mutationClaimArtifactPath,
  readCommittedMutationClaim,
} from './mutation-claim-artifact.ts'

/**
 * THE COMMITTED NOMINATION READER.
 *
 * Four properties carry this file. The path is PER-BRANCH and the blob must be
 * in THIS branch's diff, so a nomination can never be inherited from a merged
 * branch. The revision operand is sanitized BEFORE it may touch git — every
 * unsafe ref must leave the recorded argv log EMPTY, not merely fail. The byte
 * cap is applied to the OBJECT (git's own size record) before any body is read.
 * And the reader is exactly as permissive as the agent route's decode and no
 * more: it adds no validation of its own, so a claim that the gate would refuse
 * still SURVIVES the read.
 *
 * Every case below is paired with a control that goes the other way, so a reader
 * stubbed to a constant — null or claim — fails one side of each pair.
 */

const REPO = '/repo'
const OID = 'a'.repeat(40)
const BRANCH = 'trident/some-fix'
const BASE = 'main'
const PATH = `${MUTATION_CLAIM_ARTIFACT_DIR}/${BRANCH}.json`

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

/**
 * A scripted host that RECORDS every argv, and answers the three commands the
 * reader issues: the branch diff, the object size, the blob body.
 *
 * `diff` defaults to a listing that INCLUDES the artifact and `size` to the real
 * byte length of `body`, so each test overrides exactly the leg it is about.
 */
function makeHost(opts: {
  body?: string | HostCommandResult
  diff?: string | HostCommandResult
  size?: string | HostCommandResult
  throws?: boolean
}): { run: RunHostCommand; calls: string[][] } {
  const calls: string[][] = []
  const body = opts.body ?? BODY
  const answer = (v: string | HostCommandResult | undefined, fallback: string): HostCommandResult =>
    v === undefined ? ok(fallback) : typeof v === 'string' ? ok(v) : v
  const run: RunHostCommand = async (cmd) => {
    calls.push([...cmd])
    if (opts.throws === true) throw new Error('spawn failed')
    if (cmd.includes('diff')) return answer(opts.diff, `${PATH}\ntrident/limit.ts\n`)
    if (cmd.includes('cat-file')) {
      return answer(opts.size, String(Buffer.byteLength(typeof body === 'string' ? body : '', 'utf8')))
    }
    if (cmd.includes('show')) return answer(body, BODY)
    return fail(1)
  }
  return { run, calls }
}

const SOURCE = { expected_head: OID, branch: BRANCH, base_branch: BASE }

describe('mutationClaimArtifactPath', () => {
  test('is per-branch, mirroring .trident/plans/<branch>.md', () => {
    expect(mutationClaimArtifactPath('trident/some-fix')).toBe('.trident/mutation-claims/trident/some-fix.json')
    expect(mutationClaimArtifactPath('feat-x')).toBe('.trident/mutation-claims/feat-x.json')
    // Two branches NEVER share a file — the whole point of the per-branch path.
    expect(mutationClaimArtifactPath('trident/a')).not.toBe(mutationClaimArtifactPath('trident/b'))
  })

  test('a name this module would not hand to git has no path at all', () => {
    for (const bad of ['', '   ', '--upload-pack=x', 'feat:refs/heads/x', 'a/../b', null, undefined]) {
      expect(mutationClaimArtifactPath(bad)).toBeNull()
    }
    // Positive control against a constant-null implementation.
    expect(mutationClaimArtifactPath('ok/name')).not.toBeNull()
  })
})

describe('readCommittedMutationClaim', () => {
  test('reads the artifact at a 40-hex OID and pins the exact argv of every leg', async () => {
    const host = makeHost({})

    const read = await readCommittedMutationClaim(host.run, REPO, SOURCE)

    expect(read.claim).toEqual(parseMutationClaim(JSON.parse(BODY)))
    expect(read.claim).not.toBeNull()
    // The whole array, because this is the injection surface. The SIZE is taken
    // from git's object record BEFORE the body is ever asked for — the ordering
    // is what makes the cap bound the read rather than describe it afterwards.
    expect(host.calls).toEqual([
      ['git', '-C', REPO, 'diff', '--name-only', `${BASE}...${OID}`],
      ['git', '-C', REPO, 'cat-file', '-s', `${OID}:${PATH}`],
      ['git', '-C', REPO, 'show', `${OID}:${PATH}`],
    ])
  })

  test('a missing artifact at that same revision is null, and the note says so', async () => {
    // Identical to the case above but for the host's ANSWER: the pair is what
    // makes a constant-null and a constant-claim reader both fail.
    const host = makeHost({ diff: 'trident/limit.ts\n' })

    const read = await readCommittedMutationClaim(host.run, REPO, SOURCE)

    expect(read.claim).toBeNull()
    expect(read.note).toContain('is not in the diff')
    // Refused on the DIFF leg — no body was ever fetched.
    expect(host.calls).toEqual([['git', '-C', REPO, 'diff', '--name-only', `${BASE}...${OID}`]])
  })

  test('AN INHERITED, UNTOUCHED ARTIFACT IS NOT A NOMINATION', async () => {
    // The regression this file exists for: the path is tracked, so a branch cut
    // after a predecessor merged starts life already holding a nomination it
    // never wrote. `git diff --name-only base...rev` does not list it, and the
    // read must be null — "nominated nothing" must not become "reuse the
    // previous PR's claim".
    const inherited = makeHost({ diff: 'trident/unrelated.ts\n' })
    const read = await readCommittedMutationClaim(inherited.run, REPO, SOURCE)
    expect(read.claim).toBeNull()
    expect(read.note).toContain(PATH)

    // POSITIVE CONTROL: the SAME host, the SAME blob, the only difference being
    // that this branch's diff touches the artifact.
    const wrote = makeHost({ diff: `trident/unrelated.ts\n${PATH}\n` })
    expect((await readCommittedMutationClaim(wrote.run, REPO, SOURCE)).claim).not.toBeNull()
  })

  test('an unreadable diff is null — the fallback fails CLOSED', async () => {
    const host = makeHost({ diff: fail(128) })
    const read = await readCommittedMutationClaim(host.run, REPO, SOURCE)
    expect(read.claim).toBeNull()
    expect(read.note).toContain('could not read the diff')
  })

  test('a malformed JSON body is null', async () => {
    const host = makeHost({ body: '{nope', size: '5' })

    expect((await readCommittedMutationClaim(host.run, REPO, SOURCE)).claim).toBeNull()
  })

  test('valid JSON of the wrong shape is null — and the decode is what rejects it', async () => {
    const wrong = JSON.parse(BODY) as Record<string, unknown>
    wrong.guard = 'bun test trident/limit.test.ts' // a shell string, never an argv
    const host = makeHost({ body: JSON.stringify(wrong) })

    const read = await readCommittedMutationClaim(host.run, REPO, SOURCE)
    expect(read.claim).toBeNull()
    expect(read.note).toContain('not a well-formed nomination')
    // Parity control: the same value decodes to null on the agent route too.
    expect(parseMutationClaim(wrong)).toBeNull()
    // ...and the decode really is discriminating, not constant-null.
    expect(parseMutationClaim(JSON.parse(BODY))).not.toBeNull()
  })

  test('THE CAP IS TAKEN FROM THE OBJECT, not from an already-captured body', async () => {
    // The bug this pins: `Buffer.byteLength(stdout)` measures a body the host has
    // ALREADY buffered — and trimmed. A whitespace-padded blob over the cap trims
    // down to a small string and sails through a stdout-length check. Here the
    // host reports the REAL object size, so the read is refused with no `show`.
    const padded = `${' '.repeat(MUTATION_CLAIM_ARTIFACT_MAX_BYTES * 4)}${BODY}`
    const host = makeHost({ body: padded, size: String(Buffer.byteLength(padded, 'utf8')) })

    const read = await readCommittedMutationClaim(host.run, REPO, SOURCE)

    expect(read.claim).toBeNull()
    expect(read.note).toContain('over the')
    // The trimmed body WOULD have parsed — only the object-size preflight refused it.
    expect(parseMutationClaim(JSON.parse(padded.trim()))).not.toBeNull()
    expect(host.calls.some((c) => c.includes('show'))).toBe(false)
  })

  test('the cap boundary is INCLUSIVE: exactly at the cap resolves, one byte over is null', async () => {
    // Pins `>` against `>=` — without both halves the comparison is unobservable.
    const atCap = makeHost({ size: String(MUTATION_CLAIM_ARTIFACT_MAX_BYTES) })
    expect((await readCommittedMutationClaim(atCap.run, REPO, SOURCE)).claim).not.toBeNull()

    const overCap = makeHost({ size: String(MUTATION_CLAIM_ARTIFACT_MAX_BYTES + 1) })
    expect((await readCommittedMutationClaim(overCap.run, REPO, SOURCE)).claim).toBeNull()
  })

  test('an unreadable object size is null rather than an unbounded read', async () => {
    const host = makeHost({ size: 'not-a-number' })
    const read = await readCommittedMutationClaim(host.run, REPO, SOURCE)
    expect(read.claim).toBeNull()
    expect(read.note).toContain('unreadable object size')
    expect(host.calls.some((c) => c.includes('show'))).toBe(false)
  })

  test('falls back to refs/heads/<branch>, then to origin, when there is no OID', async () => {
    const host = makeHost({})

    const read = await readCommittedMutationClaim(host.run, REPO, {
      expected_head: null,
      branch: BRANCH,
      base_branch: BASE,
    })

    expect(read.claim).toEqual(parseMutationClaim(JSON.parse(BODY)))
    expect(host.calls[0]).toEqual(['git', '-C', REPO, 'diff', '--name-only', `${BASE}...refs/heads/${BRANCH}`])

    // The local ref is routinely gone by the time the gate runs (the worktree
    // holding it is cleaned), which is why `resolveMergeHeadSha` carries the same
    // remote-tracking fallback.
    const noLocal: string[][] = []
    const remoteOnly: RunHostCommand = async (cmd) => {
      noLocal.push([...cmd])
      const j = cmd.join(' ')
      if (j.includes('refs/heads/')) return fail(128)
      if (cmd.includes('diff')) return ok(`${PATH}\n`)
      if (cmd.includes('cat-file')) return ok(String(Buffer.byteLength(BODY, 'utf8')))
      return ok(BODY)
    }
    const viaOrigin = await readCommittedMutationClaim(remoteOnly, REPO, {
      expected_head: null,
      branch: BRANCH,
      base_branch: BASE,
    })
    expect(viaOrigin.claim).not.toBeNull()
    expect(noLocal.some((c) => c.join(' ').includes(`refs/remotes/origin/${BRANCH}`))).toBe(true)
  })

  test('an unsafe branch or base never reaches git', async () => {
    const cases: Array<{ what: string; source: Parameters<typeof readCommittedMutationClaim>[2] }> = [
      { what: 'a branch that is an option', source: { expected_head: OID, branch: '--upload-pack=x', base_branch: BASE } },
      { what: 'a branch that is a refspec', source: { expected_head: OID, branch: 'feat:refs/heads/x', base_branch: BASE } },
      { what: 'an empty branch', source: { expected_head: OID, branch: '', base_branch: BASE } },
      { what: 'a null branch', source: { expected_head: OID, branch: null, base_branch: BASE } },
      { what: 'a base that is an option', source: { expected_head: OID, branch: BRANCH, base_branch: '--output=/x' } },
      { what: 'a missing base', source: { expected_head: OID, branch: BRANCH } },
      { what: 'nothing at all', source: {} },
    ]

    for (const c of cases) {
      const host = makeHost({})
      expect(await readCommittedMutationClaim(host.run, REPO, c.source)).toEqual({
        claim: null,
        note: expect.any(String),
      })
      // The point of the case: refused WITHOUT a command, not by a failed one.
      expect({ what: c.what, calls: host.calls.length }).toEqual({ what: c.what, calls: 0 })
    }
    // Positive control: the same shape WITH safe operands does run git.
    const control = makeHost({})
    expect((await readCommittedMutationClaim(control.run, REPO, SOURCE)).claim).not.toBeNull()
  })

  test('a short expected_head falls back to the branch refs rather than to a bare operand', async () => {
    const host = makeHost({})
    const read = await readCommittedMutationClaim(host.run, REPO, { ...SOURCE, expected_head: 'abc' })
    expect(read.claim).not.toBeNull()
    expect(host.calls.every((c) => !c.some((a) => a.includes('abc:')))).toBe(true)
    expect(host.calls[0]?.at(-1)).toBe(`${BASE}...refs/heads/${BRANCH}`)
  })

  test('an uppercase, padded expected_head is trimmed and lowercased before use', async () => {
    const host = makeHost({})

    const read = await readCommittedMutationClaim(host.run, REPO, {
      ...SOURCE,
      expected_head: `  ${'A'.repeat(40)}  `,
    })

    expect(read.claim).not.toBeNull()
    expect(host.calls[0]).toEqual(['git', '-C', REPO, 'diff', '--name-only', `${BASE}...${'a'.repeat(40)}`])
  })

  test('a host that throws resolves null rather than rejecting', async () => {
    const host = makeHost({ throws: true })

    await expect(readCommittedMutationClaim(host.run, REPO, SOURCE)).resolves.toEqual({
      claim: null,
      note: expect.any(String),
    })
    expect(host.calls).toHaveLength(1)
  })

  test('an absolute-path file SURVIVES the read — the gate does that rejecting', async () => {
    const escaping = JSON.parse(BODY) as Record<string, unknown>
    escaping.file = '/etc/passwd'
    const host = makeHost({ body: JSON.stringify(escaping) })

    const read = await readCommittedMutationClaim(host.run, REPO, SOURCE)

    // Deliberate: the reader is exactly the agent route's decode, so this
    // nomination reaches `validateClaim` on identical terms and is refused
    // there, not here.
    expect(read.claim).not.toBeNull()
    expect(read.claim?.file).toBe('/etc/passwd')
    expect(read.claim).toEqual(parseMutationClaim(escaping))
  })

  test('the artifact path constants are the ones the contract names', () => {
    expect(MUTATION_CLAIM_ARTIFACT_DIR).toBe('.trident/mutation-claims')
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
    const host = makeHost({ body: JSON.stringify(absolute) })
    const read = await readCommittedMutationClaim(host.run, REPO, SOURCE)
    expect(read.claim).not.toBeNull() // positive control: the extraction really happened
    expect(read.claim).toEqual(absolute)
    // The REAL gate refuses that same object repo-relatively — even against a
    // COLLUDING diff that lists the absolute path verbatim — with zero guard runs.
    const ran: string[][] = []
    const out = await runMutationProofGate({
      run: { id: 'run-1', slug: 'x', repo_path: REPO, branch: BRANCH },
      claim: read.claim,
      base_branch: BASE,
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
