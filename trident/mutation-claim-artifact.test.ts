import { describe, expect, test } from 'bun:test'

import type { HostCommandResult } from './git-mode.ts'
import type { RunHostCommand } from './merge.ts'
import { isProseOnlyChange, parseMutationClaim, runMutationProofGate } from './mutation-prover.ts'
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

/** The OID a mutable ref is pinned to before the read's three legs run. */
const REF_OID = 'b'.repeat(40)

/**
 * The OID the BASE name pins to — DISTINCT from the branch's, and from the
 * reviewed head, so an argv that still carries the bare base name (or the wrong
 * pin) is visible in the recorded calls rather than passing by coincidence.
 */
const BASE_OID = 'c'.repeat(40)

/** The two refs the base is resolved from, in the order the resolver reads them. */
const BASE_PINS = [
  ['git', '-C', REPO, 'rev-parse', '--verify', '--quiet', '--end-of-options', `refs/heads/${BASE}^{commit}`],
  ['git', '-C', REPO, 'rev-parse', '--verify', '--quiet', '--end-of-options', `refs/remotes/origin/${BASE}^{commit}`],
]

/**
 * A scripted host that RECORDS every argv, and answers the commands the reader
 * issues: the ref pin (only for a ref operand), the BASE pin, the branch diff,
 * the object size, the blob body.
 *
 * `diff` defaults to a listing that INCLUDES the artifact and `size` to the real
 * byte length of `body`, so each test overrides exactly the leg it is about.
 */
function makeHost(opts: {
  body?: string | HostCommandResult
  diff?: string | HostCommandResult
  size?: string | HostCommandResult
  pin?: string | HostCommandResult
  basePin?: string | HostCommandResult
  throws?: boolean
}): { run: RunHostCommand; calls: string[][] } {
  const calls: string[][] = []
  const body = opts.body ?? BODY
  const answer = (v: string | HostCommandResult | undefined, fallback: string): HostCommandResult =>
    v === undefined ? ok(fallback) : typeof v === 'string' ? ok(v) : v
  const run: RunHostCommand = async (cmd) => {
    calls.push([...cmd])
    if (opts.throws === true) throw new Error('spawn failed')
    // The BASE is pinned too, and to its OWN oid: the branch side and the base
    // side are separate operands and a test that answered both from one stub
    // could not tell a correct diff from one taken against the wrong revision.
    if (cmd.includes('rev-parse') && (cmd.at(-1) ?? '').endsWith(`/${BASE}^{commit}`)) {
      return answer(opts.basePin, `${BASE_OID}\n`)
    }
    if (cmd.includes('rev-parse')) return answer(opts.pin, `${REF_OID}\n`)
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
      ...BASE_PINS,
      ['git', '-C', REPO, 'diff', '--name-only', `${BASE_OID}...${OID}`],
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
    expect(host.calls).toEqual([...BASE_PINS, ['git', '-C', REPO, 'diff', '--name-only', `${BASE_OID}...${OID}`]])
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
    expect(host.calls[0]).toEqual([
      'git',
      '-C',
      REPO,
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/heads/${BRANCH}^{commit}`,
    ])

    // The local ref is routinely gone by the time the gate runs (the worktree
    // holding it is cleaned), which is why `resolveMergeHeadSha` carries the same
    // remote-tracking fallback.
    const noLocal: string[][] = []
    const remoteOnly: RunHostCommand = async (cmd) => {
      noLocal.push([...cmd])
      const j = cmd.join(' ')
      if (j.includes('refs/heads/')) return fail(128)
      if (cmd.includes('rev-parse')) return ok(`${REF_OID}\n`)
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

  test('A MUTABLE REF IS PINNED TO AN OID BEFORE ANY LEG RUNS — no ref reaches diff, cat-file or show', async () => {
    // THE TOCTOU THIS CLOSES: with the ref itself as the operand, git resolves it
    // independently for the diff, for `cat-file -s` and for `git show`. A ref that
    // moves between the SIZE and the SHOW means the cap sized one object and the
    // reader read another — the byte bound describing a blob it did not fetch.
    const host = makeHost({})

    const read = await readCommittedMutationClaim(host.run, REPO, {
      expected_head: null,
      branch: BRANCH,
      base_branch: BASE,
    })

    expect(read.claim).not.toBeNull() // positive control: the read really happened
    expect(host.calls).toEqual([
      ['git', '-C', REPO, 'rev-parse', '--verify', '--quiet', `refs/heads/${BRANCH}^{commit}`],
      ...BASE_PINS,
      ['git', '-C', REPO, 'diff', '--name-only', `${BASE_OID}...${REF_OID}`],
      ['git', '-C', REPO, 'cat-file', '-s', `${REF_OID}:${PATH}`],
      ['git', '-C', REPO, 'show', `${REF_OID}:${PATH}`],
    ])
    // Said the other way, because the argv equality above would survive a rename:
    // NOTHING but a pin names a ref — the three legs that read the blob carry
    // OIDs only.
    expect(host.calls.filter((c) => !c.includes('rev-parse')).some((c) => c.some((a) => a.includes('refs/')))).toBe(
      false,
    )
  })

  test('A STALE LOCAL BASE CANNOT RESURRECT AN INHERITED NOMINATION', async () => {
    // THE HOLE THIS CLOSES, reproduced in this repo: local `main` trailed
    // `origin/main` by 19 merges, so `git diff main...<branch>` listed 170 files
    // where the branch changed 13 — including files merged in the meantime. A
    // branch NAME reused after its predecessor merged would then find the OLD
    // nomination "in its own diff" and prove the OLD mutation, while the change
    // that actually shipped went unproved. That is invariant (a) defeated by the
    // one operand that was never pinned.
    const STALE = 'd'.repeat(40)
    const FRESH = 'e'.repeat(40)
    const calls: string[][] = []
    const drifted: RunHostCommand = async (cmd) => {
      calls.push([...cmd])
      if (cmd.includes('rev-parse')) {
        return ok(`${(cmd.at(-1) ?? '').startsWith('refs/remotes/') ? FRESH : STALE}\n`)
      }
      if (cmd.includes('merge-base')) return cmd.at(-2) === STALE && cmd.at(-1) === FRESH ? ok('') : fail(1)
      if (cmd.includes('diff')) {
        // The STALE base's over-wide diff carries the predecessor's nomination;
        // the true one carries only what this branch changed.
        return ok(cmd.at(-1) === `${STALE}...${OID}` ? `${PATH}\ntrident/limit.ts\n` : 'trident/limit.ts\n')
      }
      if (cmd.includes('cat-file')) return ok(String(Buffer.byteLength(BODY, 'utf8')))
      return ok(BODY)
    }

    const read = await readCommittedMutationClaim(drifted, REPO, SOURCE)

    expect(read.claim).toBeNull()
    expect(read.note).toContain('is not in the diff')
    // Proved by the argv, not only by the outcome: the diff was taken from
    // origin's tip, and the stale name never reached it.
    expect(calls.some((c) => c.at(-1) === `${FRESH}...${OID}`)).toBe(true)
    expect(calls.some((c) => c.at(-1) === `${STALE}...${OID}` || c.at(-1) === `${BASE}...${OID}`)).toBe(false)
    // No body was fetched at all — the refusal happened on the diff leg.
    expect(calls.some((c) => c.includes('show'))).toBe(false)

    // POSITIVE CONTROL, same host shape: a nomination THIS branch really wrote
    // is in origin's diff too, and reads back. Without this the assertion above
    // would pass on a reader that returns null unconditionally.
    const own: RunHostCommand = async (cmd) =>
      cmd.includes('diff') ? ok(`${PATH}\ntrident/limit.ts\n`) : await drifted(cmd, REPO)
    expect((await readCommittedMutationClaim(own, REPO, SOURCE)).claim).not.toBeNull()
  })

  test('a ref that resolves to nothing is null, and the OID path issues no pin at all', async () => {
    const unresolvable = makeHost({ pin: fail(128) })
    const read = await readCommittedMutationClaim(unresolvable.run, REPO, {
      expected_head: null,
      branch: BRANCH,
      base_branch: BASE,
    })
    expect(read.claim).toBeNull()
    expect(read.note).toContain('does not resolve to a commit')
    // Both refs were tried and neither leaked into a body read.
    expect(unresolvable.calls.every((c) => c.includes('rev-parse'))).toBe(true)
    expect(unresolvable.calls).toHaveLength(2)

    // CONTROL: a pinned `expected_head` is already an OID, so it costs no pin —
    // the three-command read is unchanged.
    const pinned = makeHost({})
    expect((await readCommittedMutationClaim(pinned.run, REPO, SOURCE)).claim).not.toBeNull()
    // No pin OF THE BRANCH: `expected_head` is already an OID. The two base pins
    // are the base side's own business and name the base, never the branch.
    expect(pinned.calls.filter((c) => c.includes('rev-parse'))).toEqual(BASE_PINS)
  })

  test('a pin that answers with something that is not an OID is refused, not passed through', async () => {
    // git printing a warning, an abbreviated sha, or the ref name back at us is
    // not a commit — substituting it would put an unpinned operand back on the
    // three legs by another door.
    for (const nonsense of ['not-a-sha', 'a'.repeat(39), `refs/heads/${BRANCH}`, '']) {
      const host = makeHost({ pin: nonsense })
      const read = await readCommittedMutationClaim(host.run, REPO, {
        expected_head: null,
        branch: BRANCH,
        base_branch: BASE,
      })
      expect({ nonsense, claim: read.claim }).toEqual({ nonsense, claim: null })
      expect({ nonsense, legs: host.calls.length }).toEqual({ nonsense, legs: 2 })
    }
    // Positive control: a real OID from the same seam DOES resolve.
    const good = makeHost({ pin: REF_OID })
    expect(
      (await readCommittedMutationClaim(good.run, REPO, { expected_head: null, branch: BRANCH, base_branch: BASE }))
        .claim,
    ).not.toBeNull()
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
    expect(host.calls[0]?.at(-1)).toBe(`refs/heads/${BRANCH}^{commit}`)
    expect(host.calls.at(-3)?.at(-1)).toBe(`${BASE_OID}...${REF_OID}`)
  })

  test('an uppercase, padded expected_head is trimmed and lowercased before use', async () => {
    const host = makeHost({})

    const read = await readCommittedMutationClaim(host.run, REPO, {
      ...SOURCE,
      expected_head: `  ${'A'.repeat(40)}  `,
    })

    expect(read.claim).not.toBeNull()
    expect(host.calls[2]).toEqual(['git', '-C', REPO, 'diff', '--name-only', `${BASE_OID}...${'a'.repeat(40)}`])
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

describe('the nomination file itself is neither a target nor a behaviour change', () => {
  /**
   * A gate host whose diff COLLUDES: it lists every spelling of the nomination
   * file alongside a production file. That is not far-fetched — the nomination
   * really is in the branch diff on every branch that writes one — and it is
   * what makes the diff-binding check useless here and this rejection necessary.
   */
  const SELF_NOMINATIONS = [PATH, `./${PATH}`, `${MUTATION_CLAIM_ARTIFACT_DIR}/other-branch.json`]
  const collusiveHost: RunHostCommand = async (cmd) => {
    if (cmd.includes('rev-parse')) return ok(`${OID}\n`)
    if (cmd.includes('diff') && cmd.includes('--name-only')) {
      // Two harness-driving markdown paths ride along so the contract's "these
      // are legal targets" promise can be tested where it holds and where it
      // does not — the diff-binding check must not be what refuses either.
      return ok(`${SELF_NOMINATIONS.join('\n')}\ntrident/limit.ts\nskills/tests/SKILL.md\nskills/trident/SKILL.md\n`)
    }
    return ok('')
  }

  /**
   * The REAL gate and the REAL prover, with only the filesystem and the guard
   * runner stubbed. `validateClaim` lives INSIDE `prove`, so a stubbed prover
   * would stub out the very rejection under test; what says the nomination was
   * refused before anything executed is that NO guard argv ever ran.
   */
  async function gate(file: string): Promise<{ reason: string; ok: boolean; ran: string[][] }> {
    const ran: string[][] = []
    const out = await runMutationProofGate({
      run: { id: 'run-1', slug: 'x', repo_path: REPO, branch: BRANCH },
      claim: {
        file,
        find: '"file"',
        replace: '"FILE"',
        guard: ['bun', 'test', 'trident/limit.test.ts'],
        control: ['bun', 'test', 'trident/other.test.ts'],
      },
      base_branch: BASE,
      expected_head: OID,
      run_host: collusiveHost,
      fs: { read: async () => '{"file": 1}', write: async () => {} },
      run_guard: async (argv) => {
        ran.push([...argv])
        return ok('')
      },
    })
    return { reason: out.reason, ok: out.ok, ran }
  }

  test('A NOMINATION CANNOT NOMINATE ITSELF — refused before the prover, even on a colluding diff', async () => {
    // THE BYPASS THIS CLOSES: the committed nomination is in the branch diff BY
    // CONSTRUCTION on every branch that nominates, so the gate's diff-binding
    // check cannot catch it. One boilerplate self-nomination plus a test that
    // reads that JSON proves red-then-green while the production change it was
    // supposed to guard ships unproved.
    for (const file of SELF_NOMINATIONS) {
      const out = await gate(file)
      expect({ file, ok: out.ok, ran: out.ran.length }).toEqual({ file, ok: false, ran: 0 })
      expect(out.reason).toContain('cannot nominate itself')
    }
  })

  test('POSITIVE CONTROL: a production file in that same diff is validated through and RUN', async () => {
    // Without this the case above would pass on a gate that refuses everything.
    const out = await gate('trident/limit.ts')
    expect(out.ran.length).toBeGreaterThan(0)
    expect(out.reason).not.toContain('cannot nominate itself')
  })

  test('a documentation-only diff KEEPS its exemption when the build also wrote a nomination', () => {
    // `.json` is not a prose suffix, so before this the nomination file made a
    // docs-only branch proof-REQUIRED — and such a branch has no legal target to
    // nominate, i.e. it was permanently unmergeable. The file is the gate's own
    // bookkeeping, not code the harness runs.
    expect(isProseOnlyChange(['docs/a.md'])).toBe(true) // control: the exemption exists
    expect(isProseOnlyChange(['docs/a.md', PATH])).toBe(true)
    expect(isProseOnlyChange([PATH])).toBe(true)
    // ...and it is still ONLY documentation that is exempt (control).
    expect(isProseOnlyChange(['docs/a.md', PATH, 'trident/limit.ts'])).toBe(false)
    // ...and only the nomination ITSELF gets the dispensation. A branch that
    // parks source in that directory is not writing bookkeeping.
    expect(isProseOnlyChange([`${MUTATION_CLAIM_ARTIFACT_DIR}/sneaky.ts`])).toBe(false)
  })

  test('the brief tells the truth about the ONE place a harness-driving path is NOT nominable', async () => {
    // The contract says harness-driving markdown gets no exemption AND is itself
    // a legal target. At `skills/tests/SKILL.md` both halves are true and the
    // path is still refused — it carries a `tests/` segment, which the gate reads
    // as a test file. A build sent at that target would be refused; the brief now
    // names the exception instead of promising it.
    const deadlocked = 'skills/tests/SKILL.md'
    expect(isProseOnlyChange([deadlocked])).toBe(false) // no exemption…
    const out = await gate(deadlocked)
    expect({ ok: out.ok, ran: out.ran.length }).toEqual({ ok: false, ran: 0 }) // …and no proof either
    expect(out.reason).toContain('test file')
    // CONTROL: the same basename OUTSIDE a tests/ segment is exactly what the
    // brief promises — proof-required and nominable.
    expect(isProseOnlyChange(['skills/trident/SKILL.md'])).toBe(false)
    expect((await gate('skills/trident/SKILL.md')).ran.length).toBeGreaterThan(0)
  })

  test('the dispensation is NOT reachable by climbing out of the directory', () => {
    // `.` segments are dropped so `./x` and `x` are one path; `..` is REFUSED
    // rather than dropped, because dropping it is the same spelling trick from
    // the other side — `.trident/mutation-claims/../../src/a.json` would read as
    // the gate's own bookkeeping and go inert.
    expect(isProseOnlyChange([`./${PATH}`])).toBe(true) // control: `.` still normalises
    expect(isProseOnlyChange([`${MUTATION_CLAIM_ARTIFACT_DIR}/../../src/a.json`])).toBe(false)
    expect(isProseOnlyChange([`${MUTATION_CLAIM_ARTIFACT_DIR}/..`])).toBe(false)
  })

  test('the dispensation runs LAST, after the two refusals that police every path', () => {
    // A denylisted segment or an executable-prose basename must not be skippable
    // by an escape hatch that ran before it — so a segment added to either list
    // later polices this directory too. The cost, accepted: a branch NAME
    // carrying one of those segments forfeits the dispensation, and trident
    // slugs are `[a-z0-9-]`.
    expect(isProseOnlyChange([`${MUTATION_CLAIM_ARTIFACT_DIR}/trident/x.json`])).toBe(true) // control
    expect(isProseOnlyChange([`${MUTATION_CLAIM_ARTIFACT_DIR}/skills/x.json`])).toBe(false)
  })
})
