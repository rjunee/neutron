import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { innerTerminalFailureReason } from './orchestrator.ts'
import { TERMINAL_CAUSE_MAX } from './inner-loop.ts'

const SRC = readFileSync(fileURLToPath(new URL('./inner-workflow.mjs', import.meta.url)), 'utf8')
const H = 'c'.repeat(40)
const FIX = 'f'.repeat(40)
/** The workflow's own `BUILT_HEAD_READ_ATTEMPTS`, read out of the source rather than
 *  restated here — the point of the constant is that ONE number governs the budget. */
const ATTEMPTS = Number(/const BUILT_HEAD_READ_ATTEMPTS = (\d+)/.exec(SRC)?.[1] ?? '0')
/** A head read that never succeeds: one '' per attempt the workflow will spend. */
const UNREADABLE = Array.from({ length: ATTEMPTS }, () => '')

interface Options {
  mode?: 'pr' | 'local'
  claim?: string
  probes?: string[]
  verdicts?: Array<'APPROVE' | 'REQUEST_CHANGES'>
  fixClaim?: string
  buildDiff?: string
  /** The diff path the FIX round reports — '' is a round that produced nothing. */
  fixDiff?: string
  /** Drive a mid-loop RESUME (the only way a pr-mode run reaches a fix round). */
  resumeCheckpoint?: string
  resumeLiveHead?: string
  /** The branch the run builds on — the length of this name is load-bearing for the
   *  cap tests (a real one is 43 characters). */
  branch?: string
}

async function runBuiltHead(opts: Options = {}) {
  const branch = opts.branch ?? 'trident/built-head'
  const labels: string[] = []
  const logs: string[] = []
  const prompts: Array<{ label: string; prompt: string }> = []
  const probes = [...(opts.probes ?? [H])]
  const verdicts = [...(opts.verdicts ?? ['APPROVE'])]
  let round = 1
  const agent = async (prompt: string, o?: { label?: string }): Promise<unknown> => {
    const label = String(o?.label ?? '')
    labels.push(label)
    prompts.push({ label, prompt })
    if (label.startsWith('head-probe-round-built-')) return { head: probes.shift() ?? FIX }
    if (label.startsWith('head-probe-round-')) return { head: FIX }
    if (label === 'forge:build') return { prNumber: null, branch, diffFile: opts.buildDiff ?? '/tmp/built.diff', worktreePath: '/wt', commitSha: opts.claim ?? '', testsPassed: true }
    if (label.startsWith('forge:fix-round-')) {
      round = Number(label.slice('forge:fix-round-'.length))
      return { prNumber: null, branch, diffFile: opts.fixDiff ?? '/tmp/fix.diff', worktreePath: '/wt', commitSha: opts.fixClaim ?? FIX, testsPassed: true }
    }
    if (label === 'argus:claude' || label === 'argus:adversarial') return { verdict: 'APPROVE', findings: [] }
    if (label === 'argus:synthesis') {
      const verdict = verdicts.shift() ?? 'APPROVE'
      return verdict === 'APPROVE' ? { verdict, findings: [] } : { verdict, findings: [{ severity: 'blocker', title: 'fix it', evidence: 'x:1' }] }
    }
    return ''
  }
  const parallel = async (fns: Array<() => Promise<unknown>>) => Promise.all(fns.map((f) => f()))
  const args = {
    repoPath: '/repo', task: 'Ship it', baseBranch: 'main', slug: 'built-head', maxRounds: 3,
    ralph: false, mergeMode: opts.mode ?? 'local', prNumber: null, branch,
    dbPath: '/tmp/no.db', runId: 'built-head-run', codexHome: null,
    resumeCheckpoint: opts.resumeCheckpoint ?? null,
    ...(opts.resumeLiveHead !== undefined ? { resumeLiveHead: opts.resumeLiveHead } : {}),
    checkpointScript: '/repo/trident/checkpoint.sh', worktreeCleanupScript: '/repo/trident/worktree-cleanup.sh',
    models: { fable: 'fable', opus: 'opus', sonnet: 'sonnet', fast: 'haiku' }, reflectionGuidance: '',
  }
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  const result = await AsyncFunction('agent', 'parallel', 'phase', 'log', 'budget', 'args', SRC.replace('export const meta', 'const meta'))(
    agent, parallel, () => {}, (...v: unknown[]) => { logs.push(v.map(String).join(' ')) }, { total: 0, spent: () => 0 }, args,
  )
  return { labels, prompts, logs, result, round }
}

const checkpoint = (out: Awaited<ReturnType<typeof runBuiltHead>>, name: string) =>
  out.prompts.find((p) => p.label === `checkpoint:${name}`)?.prompt ?? ''

describe('build-completion heads come from git', () => {
  test('PR no claim publishes with null claim and checkpoints the git OID', async () => {
    const out = await runBuiltHead({ mode: 'pr' })
    expect(out.result.publishRequested).toBe(true)
    expect(out.result.publishHead).toBeNull()
    expect(checkpoint(out, 'forge-done')).toContain(`inner_checkpoint_head '${H}'`)
  })

  test('PR abbreviated claim is cross-checked but full git OID is checkpointed', async () => {
    const out = await runBuiltHead({ mode: 'pr', claim: H.slice(0, 7) })
    expect(out.result.publishHead).toBe(H.slice(0, 7))
    expect(checkpoint(out, 'forge-done')).toContain(`inner_checkpoint_head '${H}'`)
  })

  test('mismatch stops infra-only, names both values, and never dispatches review', async () => {
    const claim = 'd'.repeat(40)
    const out = await runBuiltHead({ claim })
    expect(out.result.blockKind).toBe('infra-only')
    expect(out.result.terminalCause).toContain(claim)
    expect(out.result.terminalCause).toContain(H)
    expect(out.result.publishRequested).toBeUndefined()
    expect(out.labels.some((l) => l.startsWith('argus:'))).toBe(false)
    const reason = innerTerminalFailureReason(
      { max_rounds: 3, round: 1, inner_checkpoint: null },
      {
        ok: false,
        verdict: null,
        round: 1,
        checkpoint: 'forge-done',
        block_kind: 'infra-only',
        terminal_cause: out.result.terminalCause,
        findings_present: false,
      },
    )
    expect(reason).toContain(claim)
    expect(reason).toContain(H)
    expect(reason).not.toContain('without Argus APPROVE')
  })

  /**
   * TWO OIDs THAT DISAGREE IS ALL THE RUN MEASURED. The cause used to end "— wrong branch
   * or wrong worktree", which is a deduction and not even the likeliest one: an amending
   * commit hook, or a second commit landing between the builder's own `rev-parse` and this
   * probe, produce exactly the same signal. The shipped Part-1 twin (`publishBuiltCommit`)
   * names both OIDs and stops there.
   */
  test('the mismatch cause names both OIDs and deduces no cause for them', async () => {
    const out = await runBuiltHead({ claim: 'd'.repeat(40) })
    expect(out.result.terminalCause).not.toContain('wrong branch')
    expect(out.result.terminalCause).not.toContain('wrong worktree')
    expect(out.result.terminalCause).toContain('refusing to publish or review either')
  })

  /**
   * …AND IN `pr` MODE THE CHECK DOES NOT RUN AT ALL, the same `!isPr` carve-out the
   * unreadable-head stop has. `publishBuiltCommit` (trident/orchestrator.ts) makes the
   * identical comparison in REAL CODE against a `rev-parse` the host ran itself, moments
   * later; here BOTH sides arrive through a model seat, so a garbled relay could veto a
   * build the publisher would have validated. Delete `!isPr &&` and this test fails.
   */
  test('a pr-mode mismatch defers to the publisher instead of vetoing the build', async () => {
    const claim = 'd'.repeat(40)
    const out = await runBuiltHead({ mode: 'pr', claim })
    expect(out.result.publishRequested).toBe(true)
    // The claim travels out UNCHANGED, so the publisher makes the same comparison with the
    // real OID and refuses loudly if it still disagrees (acceptance criterion 3).
    expect(out.result.publishHead).toBe(claim)
    expect(out.result.blockKind).toBeUndefined()
  })

  test('a transient failure is retried and proceeds — the budget is not spent on success', async () => {
    const out = await runBuiltHead({ mode: 'pr', probes: ['', H] })
    expect(out.labels.filter((l) => l === 'head-probe-round-built-r1')).toHaveLength(2)
    expect(out.result.publishRequested).toBe(true)
  })

  /**
   * THE SAME BUDGET THE LAUNCHER SPENDS ON THE SAME QUESTION. `resolveResumeLiveHead`
   * (trident/orchestrator.ts) tries three times; this probe used to try twice, so a
   * transient seat death — the class `seatAttempt` exists for — got one fewer chance
   * here than at the resume boundary for no stated reason.
   */
  test('the attempt budget is 3, matching resolveResumeLiveHead', async () => {
    expect(ATTEMPTS).toBe(3)
    const out = await runBuiltHead({ probes: UNREADABLE, claim: H.slice(0, 7) })
    expect(out.labels.filter((l) => l === 'head-probe-round-built-r1')).toHaveLength(ATTEMPTS)
    // …and the transcript says how many were spent, so a one-attempt blip and a
    // three-attempt outage are not the same line in the log.
    expect(out.logs.filter((l) => l.includes('head-probe-round-built-r1: attempt'))).toHaveLength(ATTEMPTS)
  })

  test('permanent local unreadability stops boundedly before plan or review', async () => {
    const out = await runBuiltHead({ probes: UNREADABLE, claim: H.slice(0, 7) })
    expect(out.result.blockKind).toBe('infra-only')
    expect(out.result.terminalCause).toContain('refs/heads/trident/built-head')
    expect(out.result.terminalCause).toContain(H.slice(0, 7))
    expect(out.result.terminalCause).toContain('re-run when the read succeeds')
    expect(out.labels.some((l) => l.startsWith('argus:') || l === 'plan:fable')).toBe(false)
    // A READ THAT FAILED OBSERVED NOTHING — including whether the checkout still
    // exists. The stop says what this run DID; it does not promise a branch it could
    // not see is still there (in a directory that is not a repo the probe prints
    // nothing and lands here identically).
    expect(out.result.terminalCause).not.toContain('preserved')
    expect(out.result.terminalCause).toContain('rebuilt, published and reviewed nothing')
  })

  test('local build with no claim reviews and returns the git-read OID', async () => {
    const out = await runBuiltHead()
    expect(out.result.reviewedHead).toBe(H)
  })

  test('fix mismatch stops and names the fix claim and git head', async () => {
    const claim = 'e'.repeat(40)
    const out = await runBuiltHead({ probes: [H, FIX], verdicts: ['REQUEST_CHANGES'], fixClaim: claim })
    expect(out.result.blockKind).toBe('infra-only')
    expect(out.result.terminalCause).toContain(claim)
    expect(out.result.terminalCause).toContain(FIX)
  })

  test('fix checkpoint records the OID probed at that round completion', async () => {
    const out = await runBuiltHead({ probes: [H, FIX], verdicts: ['REQUEST_CHANGES'], fixClaim: FIX })
    expect(checkpoint(out, 'fix-round-2')).toContain(`inner_checkpoint_head '${FIX}'`)
  })
})

/**
 * "NOTHING WAS BUILT" AND "COULD NOT READ THE HEAD" ARE DIFFERENT OUTCOMES with
 * different recoveries, and collapsing them emits re-run advice that can never
 * succeed: re-running a build that produced nothing produces nothing again. The
 * probe is tri-state for exactly this — `'absent'` is git ANSWERING that the branch
 * was never created, `''` is a failed read.
 */
describe('an empty build is never reported as an unreadable head', () => {
  test('a branch git says does NOT exist throws "nothing was built", with no re-run advice', async () => {
    const out = await runBuiltHead({ probes: ['absent'] })
    expect(out.result.ok).toBe(false)
    expect(out.logs.some((l) => l.includes('inner THREW') && l.includes('nothing was built'))).toBe(true)
    expect(out.logs.some((l) => l.includes('re-run when the read succeeds'))).toBe(false)
    expect(out.logs.some((l) => l.includes(`no commit on trident/built-head`))).toBe(true)
    expect(out.labels.some((l) => l.startsWith('argus:'))).toBe(false)
  })

  test('an unreadable head with NO diff is "nothing was built" too — the read is not what failed', async () => {
    const out = await runBuiltHead({ probes: UNREADABLE, buildDiff: '' })
    expect(out.result.ok).toBe(false)
    expect(out.logs.some((l) => l.includes('inner THREW') && l.includes('nothing was built'))).toBe(true)
    expect(out.result.terminalCause ?? '').not.toContain('re-run when the read succeeds')
    // …and it says which facts it MEASURED. The empty diff was observed; the missing
    // commit was not. Outcome unchanged — no diff is no change either way — but the
    // sentence no longer asserts a fact the run never established.
    expect(out.logs.some((l) => l.includes('whether a commit exists was not measured'))).toBe(true)
  })

  test('a branch git says is ABSENT keeps the plain sentence — that fact WAS measured', async () => {
    const out = await runBuiltHead({ probes: ['absent'], buildDiff: '' })
    expect(out.logs.some((l) => l.includes('nothing was built'))).toBe(true)
    expect(out.logs.some((l) => l.includes('whether a commit exists was not measured'))).toBe(false)
  })

  test('the CONTROL: an unreadable head WITH a diff is the infra-only stop, not a throw', async () => {
    const out = await runBuiltHead({ probes: UNREADABLE })
    expect(out.result.blockKind).toBe('infra-only')
    expect(out.result.terminalCause).toContain('re-run when the read succeeds')
    expect(out.logs.some((l) => l.includes('inner THREW'))).toBe(false)
  })

  /**
   * …AND THE SENTENCE REACHES THE OPERATOR. Every one of these exits is a THROW, and the
   * catch path used to persist `{checkpoint: 'inner-error'}` with no cause at all — so the
   * measured sentence died in the log and the row read "without Argus APPROVE" for a build
   * Argus never saw. That is acceptance criterion 5's other half, and it was the exact
   * shape of run 3d2696c3.
   */
  test('the thrown sentence travels out as the terminal cause, not just to the log', async () => {
    const out = await runBuiltHead({ probes: ['absent'] })
    expect(out.result.terminalCause).toContain('nothing was built')
    expect(out.result.terminalCause).toContain('no commit on trident/built-head')
    // A throw is not a review verdict, so no block kind is asserted beside it.
    expect(out.result.blockKind).toBeUndefined()
    const reason = innerTerminalFailureReason(
      { max_rounds: 3, round: 1, inner_checkpoint: null },
      {
        ok: false,
        verdict: null,
        round: 1,
        checkpoint: 'inner-error',
        block_kind: null,
        terminal_cause: out.result.terminalCause,
        findings_present: false,
      },
    )
    expect(reason).toContain('nothing was built')
    expect(reason).not.toContain('without Argus APPROVE')
    // …and it does not claim the review panel refused to run, either — an unmeasured fact.
    expect(reason).not.toContain('review never ran')
  })

  test('the "not measured" clause is what reaches the row when the read failed', async () => {
    const out = await runBuiltHead({ probes: UNREADABLE, buildDiff: '' })
    expect(out.result.terminalCause).toContain('whether a commit exists was not measured')
  })
})

describe('a fix round stops on an unreadable head, exactly as round 1 does', () => {
  test('permanent unreadability at a fix round: no APPROVE, no empty reviewedHead, no empty checkpoint head', async () => {
    const out = await runBuiltHead({ probes: [H, ...UNREADABLE], verdicts: ['REQUEST_CHANGES'] })
    expect(out.result.blockKind).toBe('infra-only')
    expect(out.result.terminalCause).toContain('refs/heads/trident/built-head')
    expect(out.result.terminalCause).toContain('re-run when the read succeeds')
    expect(out.result.verdict).not.toBe('APPROVE')
    expect(out.result.terminalCause).not.toContain('preserved')
    // The checkpoint that used to be written with head '' — which classifyResume maps
    // to REBUILD (no recorded head), the rebuild-of-committed-work path Part 2 removes.
    expect(checkpoint(out, 'fix-round-2')).toBe('')
  })

  /**
   * …AND ONLY WHEN THE ROUND WROTE SOMETHING (Argus r4). Round 1 gates its identical stop on
   * `forgeDiff !== ''`, because "re-run when the read succeeds" is advice that can only pay
   * off if there is work the read is hiding. This twin was UNGATED: a fix round that
   * produced nothing — its edits already dead with its throwaway worktree — was told to
   * re-run a read that recovers nothing. With the gate it falls through to the round's own
   * honest reporting instead.
   */
  test('a fix round that produced NO diff is not an unreadable-head stop — the read is not what failed', async () => {
    const out = await runBuiltHead({ probes: [H, ...UNREADABLE], verdicts: ['REQUEST_CHANGES'], fixDiff: '' })
    expect(out.result.terminalCause ?? '').not.toContain('re-run when the read succeeds')
    expect(out.result.verdict).not.toBe('APPROVE')
    // The honest report for a round that left no trace: it is told as a lost round, not as
    // an infra read failure, and the operator is pointed at the round rather than the probe.
    expect(out.logs.some((l) => l.includes('round=2') && (l.includes('LEFT NO DIFF') || l.includes('DID NOT LAND')))).toBe(true)
    // …and the CONTROL: the same failing probes WITH a diff are still the bounded stop.
    const withDiff = await runBuiltHead({ probes: [H, ...UNREADABLE], verdicts: ['REQUEST_CHANGES'] })
    expect(withDiff.result.blockKind).toBe('infra-only')
  })

  test('PR mode does NOT stop on a PERMANENTLY unreadable head — the publisher rev-parses it (the `!isPr` carve-out)', async () => {
    // The case the carve-out exists for, and the one the suite did not cover: EVERY
    // read failed, so this is not the transient path. In `pr` mode the workflow hands
    // the BRANCH NAME to the outer publisher, which resolves the OID itself at the
    // credentialed boundary — so an unread head here is not the run's problem. Delete
    // `&& !isPr` and this test fails while every other one still passes.
    const r1 = await runBuiltHead({ mode: 'pr', probes: UNREADABLE })
    expect(r1.result.publishRequested).toBe(true)
    expect(r1.result.publishHead).toBeNull()
    expect(r1.result.blockKind).toBeUndefined()
    expect(r1.labels.filter((l) => l === 'head-probe-round-built-r1')).toHaveLength(ATTEMPTS)
    // …and the SAME probes in local mode DO stop, so the difference is the carve-out.
    const local = await runBuiltHead({ probes: UNREADABLE })
    expect(local.result.blockKind).toBe('infra-only')
  })
})

/**
 * THE CARVE-OUT MUST NOT DISCARD THE ONE PIECE OF EVIDENCE THE RUN HAS. A `pr`-mode run
 * whose head read failed keeps going (the publisher reads the head in real code), but it
 * used to CHECKPOINT `head: ''` — which `classifyResume` reads as `no-recorded-head` →
 * REBUILD. So one failed probe plus one failed publish still rebuilt already-committed
 * work: the exact defect this card exists to remove, one run deeper than before.
 *
 * Recording the builder's claim is safe BECAUSE IT STAYS A CLAIM: no fast path opens
 * unless the recorded OID equals the live head the LAUNCHER reads from git, so a wrong
 * claim degrades to `head-moved` → rebuild — precisely what '' did — while a right one
 * preserves the work.
 */
describe('a pr-mode run with an unreadable head still records what it built', () => {
  test('a FULL claimed OID is checkpointed instead of an empty head', async () => {
    const out = await runBuiltHead({ mode: 'pr', probes: UNREADABLE, claim: H })
    expect(out.result.publishRequested).toBe(true)
    expect(checkpoint(out, 'forge-done')).toContain(`inner_checkpoint_head '${H}'`)
  })

  test('no claim at all still records an empty head — there is nothing to record', async () => {
    const out = await runBuiltHead({ mode: 'pr', probes: UNREADABLE })
    expect(checkpoint(out, 'forge-done')).toContain(`inner_checkpoint_head ''`)
  })

  test('an ABBREVIATED claim records an empty head — it cannot be compared for equality', async () => {
    const out = await runBuiltHead({ mode: 'pr', probes: UNREADABLE, claim: H.slice(0, 7) })
    expect(checkpoint(out, 'forge-done')).toContain(`inner_checkpoint_head ''`)
  })

  test('a branch git says is ABSENT records an empty head — a claim about no branch is not evidence', async () => {
    const out = await runBuiltHead({ mode: 'pr', probes: ['absent'], claim: H })
    expect(checkpoint(out, 'forge-done')).toContain(`inner_checkpoint_head ''`)
  })

  // A pr-mode run hands back to the publisher after round 1, so the fix round is only
  // ever reached on a RESUME. Drive one: the outer loop published H, the launcher read
  // H back, so `classifyResume` opens the review path and the panel's REQUEST_CHANGES
  // sends it into `forge:fix-round-2` — whose head read then fails.
  test('the fix round does the same', async () => {
    const out = await runBuiltHead({
      mode: 'pr',
      resumeCheckpoint: `outer-published:${H}:0:1`,
      resumeLiveHead: H,
      probes: UNREADABLE,
      verdicts: ['REQUEST_CHANGES'],
      fixClaim: FIX,
    })
    expect(out.result.checkpoint).toBe('fix-round-2')
    expect(out.result.publishRequested).toBe(true)
    expect(checkpoint(out, 'fix-round-2')).toContain(`inner_checkpoint_head '${FIX}'`)
  })

  test('…and records nothing when the fix round claimed nothing', async () => {
    const out = await runBuiltHead({
      mode: 'pr',
      resumeCheckpoint: `outer-published:${H}:0:1`,
      resumeLiveHead: H,
      probes: UNREADABLE,
      verdicts: ['REQUEST_CHANGES'],
      fixClaim: '',
    })
    expect(checkpoint(out, 'fix-round-2')).toContain(`inner_checkpoint_head ''`)
  })
})

/**
 * A STOP REPORTS ONLY THE CHECKPOINT IT WROTE. `writeTerminalResult` does not touch
 * `inner_checkpoint`; the outer loop copies `result.checkpoint` into the row and leaves
 * `inner_checkpoint_head` alone. Naming a phase here that `checkpoint()` never recorded
 * lands the NEW name beside the PREVIOUS phase's OID — the drift the checkpoint
 * invariant forbids, and a resume would then judge this phase against an earlier commit.
 */
describe('a bounded built-head stop claims no checkpoint it did not write', () => {
  test('the unreadable-head stop reports checkpoint null and names the phase in its cause', async () => {
    const out = await runBuiltHead({ probes: UNREADABLE })
    expect(out.result.checkpoint).toBeNull()
    expect(out.result.terminalCause).toContain('forge:build')
    expect(checkpoint(out, 'forge-done')).toBe('')
  })

  test('the fix-round stop reports checkpoint null and names ITS phase', async () => {
    const out = await runBuiltHead({ probes: [H, ...UNREADABLE], verdicts: ['REQUEST_CHANGES'] })
    expect(out.result.checkpoint).toBeNull()
    expect(out.result.terminalCause).toContain('forge:fix-round-2')
    expect(checkpoint(out, 'fix-round-2')).toBe('')
  })

  test('the mismatch stop reports checkpoint null too — neither value was believed', async () => {
    const out = await runBuiltHead({ claim: 'd'.repeat(40) })
    expect(out.result.checkpoint).toBeNull()
    expect(checkpoint(out, 'forge-done')).toBe('')
  })
})

describe('the two bounded stops agree on `ok` — one failure class, one shape', () => {
  test('a built-head stop reports ok:false, like the resume stop', async () => {
    const out = await runBuiltHead({ probes: UNREADABLE })
    expect(out.result.ok).toBe(false)
    expect(out.result.blockKind).toBe('infra-only')
    expect(out.result.verdict).toBe('REQUEST_CHANGES')
  })

  /**
   * …AND ON HOW THEIR TEXT IS PERSISTED. The resume stop used to pass its cause through
   * raw while this one redacted + capped — two instances of what the code calls "ONE
   * failure class … one shape" disagreeing about the shape.
   */
  test('every cause goes through the same redact + cap helper', async () => {
    // Three: the resume bounded stop, the build-completion bounded stop, and the catch
    // path's thrown message. One failure class each, ONE shape for all of them.
    const uses = SRC.match(/terminalCause: infraCause\(/g) ?? []
    expect(uses).toHaveLength(3)
    expect(SRC).not.toContain('terminalCause: stopCause')
  })
})

/**
 * A CAUSE THAT LOSES ITS TAIL MUST LOSE DETAIL, NEVER THE INSTRUCTION.
 *
 * MEASURED (Argus r3): the round-1 unreadable-head cause composes to 331 characters with a
 * REAL 43-char branch name (`trident/` + the 35 chars `slugify-task` caps a slug at) — and
 * the cap it was written through was 300, so the trailing "re-run when the read succeeds"
 * never reached the operator. The guard test above passed only because its fixture branch
 * was short, which is exactly how a length bug hides. Two defences are asserted here: the
 * cap is wide enough for the sentence, and the advice sits near the front so a
 * model-supplied diff path (unbounded) can only ever cost detail.
 */
describe('the stop advice survives a realistic branch name', () => {
  const LONG = `trident/${'x'.repeat(35)}`

  test('a 43-character branch keeps the re-run advice and the branch name', async () => {
    const out = await runBuiltHead({
      branch: LONG,
      probes: UNREADABLE,
      claim: H,
      buildDiff: `/tmp/${LONG.replace('/', '-')}.diff`,
    })
    const cause = String(out.result.terminalCause)
    expect(cause).toContain('re-run when the read succeeds')
    expect(cause).toContain(`refs/heads/${LONG}`)
    // The positive control for the bug: at the old cap this cause was over the line.
    expect(cause.length).toBeGreaterThan(300)
  })

  test('the advice comes before the model-supplied diff path, which has no length bound', async () => {
    const out = await runBuiltHead({
      branch: LONG,
      probes: UNREADABLE,
      claim: H,
      buildDiff: `/tmp/${'d'.repeat(400)}.diff`,
    })
    const cause = String(out.result.terminalCause)
    expect(cause).toContain('re-run when the read succeeds')
    // …and the cap still holds, so an unbounded path cannot flood the row. The number is
    // READ from the TS constant, not restated: the .mjs mirrors it by hand and the smaller
    // of the two decides (guarded in `inner-loop.test.ts`).
    expect(cause.length).toBeLessThanOrEqual(TERMINAL_CAUSE_MAX)
  })
})
