/**
 * THE TERMINAL REASON MUST NAME WHAT HAPPENED.
 *
 * WHY THIS FILE EXISTS. On 2026-08-13 four trident runs failed for four different reasons
 * and every one of them reported `inner loop exhausted 10 round(s) without Argus APPROVE`:
 *
 *   36b95167  ten genuine review rounds        round 10   ← the only true one
 *   03242fe5  CODEX_HOME unresolved            round 1
 *   000cedc8  build brief truncated in transit round 1
 *   1daded20  no GitHub push credential        round 1
 *
 * The sentence was a hardcoded template in a catch-all branch, interpolating
 * `run.max_rounds` — the CONFIGURED CEILING, never a measurement. Three of those runs never
 * ran a reviewer at all. Each time the message read as a diagnosis, so it sent a human to
 * look at review quality while the build had not started.
 *
 * The rule these tests enforce (owner, verbatim): *"If it's a generic catchall make the
 * error message generic."* — i.e. A MESSAGE MUST NOT ASSERT A CAUSE IT DID NOT MEASURE.
 *
 * These assert the SHAPE, not one wording, so the next early-exit path added upstream
 * cannot silently inherit the wrong sentence the way `inner-error` did.
 *
 * WHY ALMOST NOTHING HERE ASSERTS A SPECIFIC CAUSE. Two Codex review rounds killed two
 * attempts to DEDUCE one from `(round, checkpoint)`. The checkpoint records the PHASE
 * reached, not the TERMINAL CAUSE: `argus-request-changes` is written for genuine
 * exhaustion, a round-lost fix, a fix that left no diff, AND an infra-only synthesis stop.
 *
 * 2026-08-14 — THE MISSING SIGNAL NOW EXISTS, on exactly ONE path, and the paragraph that
 * used to stand here ("No terminal cause is emitted anywhere in the pipeline") is no longer
 * true. Run `8417b277` stopped because an unauthenticated `gh` made the readiness probe
 * answer `gh auth login`; no review seat ever ran, and this function reported ten rounds of
 * review that never happened. The inner workflow now MEASURES that cause where it is known
 * and emits it as `terminalCause` beside `blockKind: 'infra-only'`. So there is now one
 * specific message — and it is gated on BOTH of those arriving. Everything else, including
 * an infra-only stop that measured nothing, still gets the generic sentence. The rule is
 * unchanged; only the supply of measurements changed.
 */
import { describe, expect, test } from 'bun:test'
import {
  classifyPublishFailure,
  innerTerminalFailureReason,
  isInfraDeath,
  publishFailureReason,
  redactPushError,
} from './orchestrator.ts'
import { infraDeathSentence, interpretFailure } from './delivery.ts'
import { parseInnerResult } from './inner-loop.ts'
import { composeWrongBaseRefusal, type TreeOccupancy } from './wrong-base-remedy.ts'
import type { HostCommandResult } from './git-mode.ts'
import type { TridentRun } from './store.ts'

const run = (over: Partial<TridentRun> = {}): TridentRun =>
  ({
    id: 'r1',
    slug: 'a-card',
    project_slug: 'neutron-open',
    phase: 'failed',
    round: 1,
    max_rounds: 10,
    ralph: 1,
    ralph_round: 0,
    max_ralph_rounds: 20,
    branch: 'trident/a-card',
    pr: 217,
    merge_mode: 'pr',
    repo_path: '/repo',
    task: 'a task',
    chat_id: 'app:owner:neutron-open',
    started_at: '2026-08-13T23:23:41.882Z',
    last_advanced_at: '2026-08-13T23:33:26.076Z',
    inner_checkpoint: null,
    failure_reason: null,
    ...over,
  }) as unknown as TridentRun

describe('innerTerminalFailureReason — it reports what was measured and infers no cause', () => {
  test('an inner-error at round 1 does NOT claim the rounds ran out', () => {
    // THE EXACT SHAPE OF RUN 1daded20. This is the assertion the old code could not pass.
    const reason = innerTerminalFailureReason(run({ inner_checkpoint: 'inner-error' }), {
      round: 1,
      checkpoint: 'inner-error',
      block_kind: null,
      terminal_cause: null,
      ok: false,
      verdict: 'REQUEST_CHANGES' as const,
      findings_present: true,
    })
    expect(reason).not.toContain('exhausted')
    // …and it must not smuggle the ceiling in as if it were the count.
    expect(reason).not.toMatch(/\b10 round\(s\)/)
    // What it DOES say is only what was measured: where it got to, and where it stopped.
    expect(reason).toContain('round 1 of 10')
    expect(reason).toContain('inner-error')
  })

  test('a REAL round-budget exhaustion also claims nothing — no cause is inferred at all', () => {
    // CODEX REVIEW, ROUND 2 — BLOCKER. An earlier cut kept a special case that said
    // "exhausted" when `round >= max_rounds` and the checkpoint was not `inner-error`. That
    // is still an INFERENCE, and it is wrong: `argus-request-changes` is written for several
    // distinct exits — genuine exhaustion, a round-lost fix, a fix that left no diff, an
    // infra-only synthesis stop. The checkpoint records the PHASE, not the TERMINAL CAUSE,
    // and this result carries no measured cause of its own (see the infra-only describe
    // below for the one path that does). So the message states what was measured and stops.
    // This is the owner's rule applied literally: a generic catch-all gets a generic message.
    const reason = innerTerminalFailureReason(run({ round: 10 }), {
      round: 10,
      checkpoint: 'argus-request-changes',
      block_kind: null,
      terminal_cause: null,
      ok: false,
      verdict: 'REQUEST_CHANGES' as const,
      findings_present: true,
    })
    expect(reason).not.toContain('exhausted')
    expect(reason).toContain('round 10 of 10')
  })

  test('the four causes that once shared one sentence now share only TRUE words', () => {
    // The regression this file exists for, stated as a property rather than four cases: no
    // terminal reason may contain a number that was never measured. `max_rounds` appearing
    // as a COUNT is the specific lie — it is the ceiling, and it was printed as the tally.
    // T4: the two `inner-error` rows carried NO findings, which is what they always were —
    // a build that threw before any reviewer saw it. They now say so (see the T4 describe).
    const base = { block_kind: null, terminal_cause: null, verdict: 'REQUEST_CHANGES' as const }
    const cases = [
      { ...base, round: 1, checkpoint: 'inner-error', ok: false, findings_present: false },        // CODEX_HOME / brief / push credential
      { ...base, round: 10, checkpoint: 'argus-request-changes', ok: false, findings_present: true }, // ten real rounds
      { ...base, round: 2, checkpoint: 'argus-request-changes', ok: false, findings_present: true },  // a lost fix round
      { ...base, round: 10, checkpoint: 'inner-error', ok: false, findings_present: false },        // a throw DURING the last round
    ]
    for (const c of cases) {
      const reason = innerTerminalFailureReason(run({ round: c.round }), c)
      expect(reason).not.toContain('exhausted')
      expect(reason).toContain(`round ${c.round} of 10`)
    }
    // …and the four are no longer indistinguishable, which was the actual harm: ONE sentence
    // for four causes is what sent a human to the wrong place, four times in a night.
    const distinct = new Set(cases.map((c) => innerTerminalFailureReason(run({ round: c.round }), c)))
    expect(distinct.size).toBe(cases.length)
    expect(innerTerminalFailureReason(run({ round: 1 }), cases[0]!)).toBe(infraDeathSentence(1, 10))
    expect(innerTerminalFailureReason(run({ round: 10 }), cases[3]!)).toBe(infraDeathSentence(10, 10))
  })

  test('the round comes from the WORKFLOW, not the row a crash left behind', () => {
    // `run.round` is the row's copy and a crash can strand it at the launch value; the
    // inner workflow's own count is what actually happened. They are DELIBERATELY different
    // here — with the row's value the message would claim exhaustion.
    const reason = innerTerminalFailureReason(run({ round: 10, inner_checkpoint: null }), {
      round: 2,
      checkpoint: 'inner-error',
      block_kind: null,
      terminal_cause: null,
      ok: false,
      verdict: 'REQUEST_CHANGES' as const,
      findings_present: true,
    })
    expect(reason).toContain('round 2 of 10')
    expect(reason).not.toContain('exhausted')
  })

  test('an inner-error AT the ceiling reads no differently — the decisive boundary', () => {
    // CODEX REVIEW, ROUND 1 — BLOCKER. The first cut read `reported >= ceiling` as proof the
    // budget ran out. The inner workflow's catch path writes the round it was ON together
    // with `checkpoint: 'inner-error'`, so a THROW during round 10 arrives as
    // `{ round: 10, checkpoint: 'inner-error' }` — indistinguishable from real exhaustion by
    // round number alone, and it would have re-created the original defect at the single
    // boundary the other tests straddle without touching. The round says how far it got;
    // only the checkpoint says how it ended.
    const reason = innerTerminalFailureReason(run({ round: 10, inner_checkpoint: 'inner-error' }), {
      round: 10,
      checkpoint: 'inner-error',
      block_kind: null,
      terminal_cause: null,
      ok: false,
      verdict: 'REQUEST_CHANGES' as const,
      findings_present: true,
    })
    expect(reason).not.toContain('exhausted')
    expect(reason).toContain('round 10 of 10')
    expect(reason).toContain('inner-error')
    // …and it must NOT reach the operator as a review outcome — the misclassification this
    // whole change exists to prevent.
    expect(interpretFailure(run({ failure_reason: reason })).klass).not.toBe('review-unresolved')
  })

  test('past the ceiling claims nothing either', () => {
    // Guards against a future "well, BEYOND the ceiling must mean exhausted" shortcut.
    const reason = innerTerminalFailureReason(run({ round: 11 }), {
      round: 11,
      checkpoint: 'inner-error',
      block_kind: null,
      terminal_cause: null,
      ok: false,
      verdict: 'REQUEST_CHANGES' as const,
      findings_present: true,
    })
    expect(reason).not.toContain('exhausted')
  })

  test('no checkpoint at all → still true, just less specific', () => {
    // Nothing is invented to fill the gap. This is the "generic" half of the owner's rule.
    const reason = innerTerminalFailureReason(run({ inner_checkpoint: null }), {
      round: 3,
      checkpoint: null,
      block_kind: null,
      terminal_cause: null,
      ok: false,
      verdict: 'REQUEST_CHANGES' as const,
      findings_present: true,
    })
    expect(reason).toContain('round 3 of 10')
    expect(reason).not.toContain('checkpoint')
    expect(reason).not.toContain('exhausted')
  })

  test('a nonsense round from the workflow falls back to the row rather than printing it', () => {
    const reason = innerTerminalFailureReason(run({ round: 4 }), {
      round: 0,
      checkpoint: 'inner-error',
      block_kind: null,
      terminal_cause: null,
      ok: false,
      verdict: 'REQUEST_CHANGES' as const,
      findings_present: true,
    })
    expect(reason).toContain('round 4 of 10')
  })
})

/**
 * THE ONE SPECIFIC MESSAGE — and what it is gated on.
 *
 * MEASURED, run `8417b277` (2026-08-14). The inner loop's `gh` had no credential, so the
 * PR-readiness probe answered `To get started with GitHub CLI, please run: gh auth login`,
 * `reviewPreconditionDeferred` turned that into `{verdict:'REQUEST_CHANGES',
 * blockKind:'infra-only'}`, and the row read *"inner workflow ended at round 1 of 10 …
 * without Argus APPROVE"* — a review verdict for a build no reviewer ever saw. The run
 * KNEW both facts and threw them away.
 *
 * So: a specific message, shipping WITH the measurement and only with it. `block_kind`
 * alone is not enough (a stop can be infra-only and have measured nothing), and a cause
 * alone is not enough (a code rejection's finding title is not a lane failure). Both, or
 * the generic sentence.
 */
describe('innerTerminalFailureReason — an infra-only stop names the cause it measured', () => {
  const infraOnly = (cause: string | null) => ({
    round: 1,
    checkpoint: 'argus-request-changes',
    block_kind: 'infra-only' as const,
    terminal_cause: cause,
    ok: false,
    verdict: 'REQUEST_CHANGES' as const,
    findings_present: false,
  })
  const GENERIC = "inner workflow ended at round 1 of 10 at checkpoint 'argus-request-changes' without Argus APPROVE"

  test('HEADLINE: run 8417b277 stores the probe\'s own words, not the round sentence', () => {
    const reason = innerTerminalFailureReason(
      run({ round: 1, inner_checkpoint: 'argus-request-changes' }),
      infraOnly('REVIEW DEFERRED — PR readiness could not be read: To get started with GitHub CLI, please run: gh auth login'),
    )
    expect(reason.startsWith('review never ran (infra-only) at round 1 of 10')).toBe(true)
    // The repair is IN the stored reason — this is the whole of acceptance (d).
    expect(reason).toContain('gh auth login')
    // …and it no longer blames the review rounds for a review that never happened.
    expect(reason).not.toContain('without Argus APPROVE')
    expect(reason).not.toContain('exhausted')
  })

  test('infra-only with NO measured cause is the INFRASTRUCTURE sentence, not the review one', () => {
    const reason = innerTerminalFailureReason(run({ round: 1 }), infraOnly(null))
    expect(reason).toBe(infraDeathSentence(1, 10))
    expect(reason).not.toBe(GENERIC)
    expect(reason).not.toContain('without Argus APPROVE')
  })

  test('a cause that is empty (or redacts away to nothing) is NOT a measurement — no dangling colon', () => {
    // '' is not null, so the specific branch used to fire and emit
    // "review never ran (infra-only) at round 1 of 10: " — a sentence that promises a
    // cause and then names none. Reachable whenever the redactor eats the whole string.
    for (const cause of ['', '   ', '\n']) {
      const reason = innerTerminalFailureReason(run({ round: 1 }), infraOnly(cause))
      expect(reason).toBe(infraDeathSentence(1, 10))
      expect(reason.endsWith(': ')).toBe(false)
    }
  })

  test('a cause on a REVIEW verdict is still the generic sentence — a finding title is not a terminal cause', () => {
    // A code rejection carries findings too. Their titles describe the DIFF, and quoting
    // one as the terminal cause would re-invent the inference this function refuses to make.
    for (const kind of ['code', 'round-lost', 'none'] as const) {
      expect(
        innerTerminalFailureReason(run({ round: 1 }), {
          round: 1,
          checkpoint: 'argus-request-changes',
          block_kind: kind,
          terminal_cause: 'CI FAILING: test',
          ok: false,
          verdict: 'REQUEST_CHANGES' as const,
          findings_present: true,
        }),
      ).toBe(GENERIC)
    }
  })

  test('the ROUND is still the measured one, and the ceiling is still the ceiling', () => {
    const reason = innerTerminalFailureReason(run({ round: 10, max_rounds: 4 }), {
      ...infraOnly('REVIEW DEFERRED — gh auth login'),
      round: 3,
    })
    expect(reason).toContain('at round 3 of 4')
  })

  test('a credential in the measured cause never reaches the persisted reason', () => {
    // Belt-and-braces: the workflow redacts at the source, and this redacts again, because
    // this string is what gets WRITTEN TO THE DATABASE and shown in a chat row.
    const cause = "REVIEW DEFERRED — could not read Password for 'https://x-access-token:ghp_abc123@github.com/o/r'"
    expect(cause).toContain('ghp_abc123') // positive control
    const reason = innerTerminalFailureReason(run({ round: 1 }), infraOnly(cause))
    expect(reason).not.toContain('ghp_abc123')
    expect(reason).toContain('***@')
    expect(reason).toContain('could not read Password')
  })

  test('a bounded resume STOP names the branch and the recorded OID, never the round sentence', () => {
    // Part 2b: an unreadable head stops the run instead of rebuilding committed work.
    // What lands in the row must be the two facts that make it re-runnable.
    const OID = 'a'.repeat(40)
    const reason = innerTerminalFailureReason(
      run({ max_rounds: 10, round: 1, inner_checkpoint: 'forge-done' }),
      {
        ok: false,
        verdict: null,
        round: 3,
        checkpoint: 'forge-done',
        block_kind: 'infra-only',
        terminal_cause: `could not read the head of trident/x; the recorded work is at ${OID}; re-run when the read succeeds`,
        findings_present: false,
      },
    )
    expect(reason).toContain('could not read the head of trident/x')
    expect(reason).toContain(OID)
    // Argus was never reached, so the round sentence would be a lie.
    expect(reason).not.toContain('without Argus APPROVE')
  })

  test('it does not read as a review outcome to the owner', () => {
    // The misclassification the whole card is about: nobody rejected this work.
    const reason = innerTerminalFailureReason(run({ round: 1 }), infraOnly('REVIEW DEFERRED — gh auth login'))
    expect(interpretFailure(run({ failure_reason: reason })).klass).not.toBe('review-unresolved')
  })
})

/**
 * A THROWN WORKFLOW MEASURED A CAUSE TOO — and it used to be dropped on the floor.
 *
 * MEASURED, run `3d2696c3` (2026-08-14): the build was written, staged and committed, the
 * inner loop threw "forge:build completed without a full local commit OID for the outer
 * publisher", and the card was filed REQUEST_CHANGES reading *"…at checkpoint 'inner-error'
 * without Argus APPROVE"*. Argus never ran. The workflow's catch path now carries the
 * sentence it composed where the fact was known (`terminalCause`), with NO `blockKind`,
 * because a throw is not a review verdict — and this function stops throwing it away.
 */
describe('innerTerminalFailureReason — a THROW reports what it threw, not the review panel', () => {
  const thrown = (cause: string | null) => ({
    ok: false,
    verdict: 'REQUEST_CHANGES' as const,
    round: 1,
    checkpoint: 'inner-error' as string | null,
    block_kind: null,
    terminal_cause: cause,
    findings_present: false,
  })

  test('HEADLINE: run 3d2696c3 reads as the build failure it was', () => {
    const reason = innerTerminalFailureReason(
      run({ round: 1, inner_checkpoint: 'inner-error' }),
      thrown('forge:build completed but produced no commit on trident/x — nothing was built'),
    )
    expect(reason).toContain('nothing was built')
    expect(reason).toContain('at round 1 of 10')
    expect(reason).not.toContain('without Argus APPROVE')
    // …and it does not claim the review panel refused to run either — that is a fact this
    // path did not measure. Only the infra-only stop is licensed to say that.
    expect(reason).not.toContain('review never ran')
  })

  test('the "not measured" clause survives the trip to the row', () => {
    // The clause the empty-build throw adds when the head read FAILED. It exists to stop
    // the sentence asserting a missing commit nobody looked for — useless if it is dropped
    // between the workflow and the operator.
    const reason = innerTerminalFailureReason(
      run({ round: 1 }),
      thrown(
        'forge:build completed but produced no diffFile (the head read failed, so whether a commit exists was not measured) — nothing was built',
      ),
    )
    expect(reason).toContain('whether a commit exists was not measured')
  })

  test('a throw that measured NOTHING is the infrastructure sentence', () => {
    expect(innerTerminalFailureReason(run({ round: 1 }), thrown(null))).toBe(infraDeathSentence(1, 10))
  })

  test('a credential in a thrown message never reaches the persisted reason', () => {
    const reason = innerTerminalFailureReason(
      run({ round: 1 }),
      thrown("push failed: https://x-access-token:ghp_abc123@github.com/o/r"),
    )
    expect(reason).not.toContain('ghp_abc123')
    expect(reason).toContain('***@')
  })

  test('it does not read as a review outcome to the owner either', () => {
    const reason = innerTerminalFailureReason(
      run({ round: 1 }),
      thrown('plan:fable returned null (planner terminal error)'),
    )
    expect(interpretFailure(run({ failure_reason: reason })).klass).not.toBe('review-unresolved')
  })

  /**
   * `null` IS NOT ONLY THE CATCH PATH (Argus r4). `parseInnerResult` decodes `block_kind`
   * FAIL-CLOSED — the four strings the workflow writes decode and ANY other value becomes
   * `null` — so a garbled/truncated/future kind enters the SAME widened branch as a throw.
   * The comment above the branch used to claim only the catch path could produce it. The
   * behaviour is safe, and this pins WHY: the sentence `null` selects quotes the measured
   * cause and says nothing about the review panel, which only 'infra-only' licenses.
   */
  test('a GARBLED block kind decodes to null and gets the honest sentence, never "review never ran"', () => {
    const raw = JSON.stringify({
      verdict: 'REQUEST_CHANGES',
      round: 2,
      checkpoint: 'forge-done',
      blockKind: 'INFRA-ONLY-ish',
      terminalCause: 'could not read the head of refs/heads/trident/x after forge:build (3 attempts)',
    })
    const decoded = parseInnerResult(raw)
    expect(decoded?.block_kind).toBeNull() // the fail-closed decode, not an assumption
    const reason = innerTerminalFailureReason(run({ round: 2 }), {
      ok: decoded?.ok ?? false,
      verdict: decoded?.verdict ?? null,
      round: decoded?.round ?? 0,
      checkpoint: decoded?.checkpoint ?? null,
      block_kind: decoded?.block_kind ?? null,
      terminal_cause: decoded?.terminal_cause ?? null,
      findings_present: decoded?.findings_present ?? false,
    })
    expect(reason).toContain('could not read the head of refs/heads/trident/x')
    expect(reason).not.toContain('review never ran')
    expect(reason).not.toContain('without Argus APPROVE')
  })
})

describe('interpretFailure — an early stop must not be told as a review outcome', () => {
  test('the early-stop reason is NOT classified as review-unresolved', () => {
    // THE ORDERING BUG THIS PINS. The review branch matches on "without argus approve",
    // which the new reason also contains — so without an earlier branch it is swallowed and
    // the owner is told "the reviewer still had blocking findings" about a build that never
    // reached a reviewer.
    const out = interpretFailure(
      run({
        failure_reason: "inner workflow ended at round 1 of 10 at checkpoint 'inner-error' without Argus APPROVE",
      }),
    )
    expect(out.klass).not.toBe('review-unresolved')
    expect(out.summary).not.toContain('blocking findings')
    // CODEX ROUND 2 — it must ALSO not claim the opposite. A below-ceiling exit can follow
    // a round that DID produce findings (a lost round-2 fix), so "there is no review
    // outcome" and "a problem with the build pipeline" are both unsupported.
    expect(out.summary).not.toContain('no review outcome')
    expect(out.summary).not.toContain('pipeline')
  })

  test('a REAL review exhaustion is still told as a review outcome', () => {
    // The positive control. Without it, a branch that caught everything would look correct.
    const out = interpretFailure(
      run({ failure_reason: 'inner loop exhausted 10 round(s) without Argus APPROVE' }),
    )
    expect(out.klass).toBe('review-unresolved')
    expect(out.summary).toContain('blocking findings')
  })

  test("the wrong-base refusal is delivered as a stand-down, never as \"reply to retry\"", () => {
    // MEASURED on the composed reason: it carries no `git ` command in the live-holder arm,
    // so every keyword branch missed it and the FALLBACK answered — and the fallback drops any
    // reason over 200 characters and then invites a retry. The delivered message therefore
    // said "Reply to retry the build" about a refusal whose entire content is "another lane
    // owns this branch; do not re-dispatch".
    const reason =
      "branch trident/x already carries 3 commit(s) not on origin/main — it was not cut from " +
      "origin/main; refusing to build on another lane's work. The wrong-base launch guard found " +
      'the branch checked out in worktree /repo/.claude/worktrees/wf_a, whose lock names pid 4242, ' +
      'and that process is ALIVE — another lane owns this branch. Stand down: do not delete the ' +
      'branch, and do not re-dispatch this card until that worktree releases it.'
    const out = interpretFailure(run({ failure_reason: reason }))
    expect(out.klass).toBe('branch-held')
    expect(out.summary).toContain('not cut from the base')
    // ...and it does NOT re-assert the attribution the composer deliberately RETRACTED. The
    // guard's args carry the refusing run's id but not its own worktree path, and this card's
    // second measured instance was held by its OWN relocked tree, so "another lane's commits"
    // was a claim the evidence beneath this summary withdrew — two layers of one message
    // disagreeing about what was established. The refusal's own premise is what is stated.
    expect(out.summary).not.toContain("another lane's commits")
    // ...and the delivered text never pastes the raw evidence at the owner.
    expect(out.summary).not.toContain('/repo/.claude')
    expect(out.summary).not.toContain('4242')

    // The DEAD-holder arm carries `git ` commands, so it would otherwise be told as a merge
    // step that failed while landing the branch — about a build that never started.
    const dead = interpretFailure(
      run({
        failure_reason:
          "branch trident/x already carries 3 commit(s) not on origin/main — it was not cut from " +
          "origin/main; refusing to build on another lane's work. The wrong-base launch guard found " +
          'the branch checked out in worktree /repo/wt, whose lock names pid 4242; that process is ' +
          'DEAD. Release the stale worktree first — git -C /repo worktree unlock /repo/wt.',
      }),
    )
    expect(dead.klass).toBe('branch-held')
    expect(dead.summary).not.toContain('git step failed')

    // POSITIVE CONTROL: an ordinary git-mechanics failure is still told as one.
    expect(interpretFailure(run({ failure_reason: 'merge failed: git push rejected' })).klass).toBe(
      'merge-mechanics',
    )
  })

  test('a BRANCH NAME cannot buy back the retry advice this class forbids', () => {
    // THE BLOCKER. The refusal EMBEDS the branch name, and `git check-ref-format --branch
    // stalled` exits 0 — so a branch legally named `stalled` matched the hang arm, which used
    // to be checked FIRST, and the refusal came back as "Reply to retry the build". Retrying
    // is the one action this class must not suggest: the guard refused precisely because
    // re-dispatching now would put a second lane on another lane's branch.
    //
    // Every token below belongs to a class that sits ahead of `branch-held` in reading order,
    // and every one of them is a legal ref name (hyphens and underscores are legal; the
    // multi-word ones are reachable through the quoted LOCK REASON, which git prints verbatim
    // and this refusal quotes back).
    const heldBy = (branch: string): string =>
      `branch ${branch} already carries 3 commit(s) not on origin/main — it was not cut from ` +
      `origin/main; refusing to build on another lane's work. The wrong-base launch guard found ` +
      `the branch checked out in worktree /repo/.claude/worktrees/wf_a, whose lock names pid ` +
      `4242, and that process is ALIVE — another lane owns this branch. Stand down: do not ` +
      `delete the branch, and do not re-dispatch this card until that worktree releases it.`
    for (const branch of [
      'stalled',
      'trident/fix-the-stalled-watchdog',
      'trident/rounds-exhausted-early',
      'trident/rebase-onto-main',
      'trident/checkout-the-base-first',
      'trident/unmerged-index-recovery',
      'trident/missing-credential-probe',
      'trident/request_changes-plumbing',
    ]) {
      const out = interpretFailure(run({ failure_reason: heldBy(branch) }))
      expect(out.klass).toBe('branch-held')
      expect(out.input_needed).not.toContain('Reply to retry')
      expect(out.input_needed).not.toContain('retry')
    }

    // A LOCK REASON is quoted verbatim into the refusal and may contain SPACES, so the
    // multi-word tokens of the classes above are forgeable through it too.
    const lockSaid = (reason: string): string =>
      `branch trident/x already carries 3 commit(s) not on origin/main — it was not cut from ` +
      `origin/main; refusing to build on another lane's work. The wrong-base launch guard found ` +
      `the branch checked out in worktree /repo/wt, whose lock ("${reason}") names no pid, so ` +
      `the holder's liveness is UNKNOWN — treat it as live. Stand down: do not delete the branch.`
    for (const reason of [
      'no progress for 90 min',
      'suspected agent hang',
      're-run with the other seat',
      'crash-recovery budget note',
      'inner workflow ended at round 3',
    ]) {
      const out = interpretFailure(run({ failure_reason: lockSaid(reason) }))
      expect(out.klass).toBe('branch-held')
      expect(out.input_needed).not.toContain('Reply to retry')
    }

    // POSITIVE CONTROLS: the classes those tokens belong to still own their own reasons, so
    // this is ordering, not a `branch-held` branch that swallows everything.
    expect(interpretFailure(run({ failure_reason: 'stalled: no progress for 90 min' })).klass).toBe('hang')
    expect(interpretFailure(run({ failure_reason: 'suspected agent hang' })).klass).toBe('hang')
    expect(
      interpretFailure(run({ failure_reason: 'inner loop exhausted 10 round(s) without Argus APPROVE' })).klass,
    ).toBe('review-unresolved')
    expect(interpretFailure(run({ failure_reason: 'build infrastructure failed: stalled probe' })).klass).toBe(
      'infra',
    )
  })

  test('the branch-held delivery does not claim a write it makes', () => {
    // "Nothing was changed or deleted" was false in the UNHELD arm: establishing publication
    // fetches `+refs/heads/<b>:refs/remotes/origin/<b>`, a FORCED refspec that moves the
    // remote-tracking ref. The reassurance the owner actually needs is that no branch,
    // worktree, commit or file moved — so say that, and name the one write.
    const out = interpretFailure(
      run({
        failure_reason:
          "branch trident/x already carries 3 commit(s) not on origin/main — it was not cut from " +
          "origin/main; refusing to build on another lane's work. The wrong-base launch guard found " +
          'no worktree holding the branch, and origin/trident/x is at the identical commit.',
      }),
    )
    expect(out.klass).toBe('branch-held')
    expect(out.input_needed).not.toContain('Nothing was changed or deleted')
    expect(out.input_needed).toContain('No branch, worktree, commit or file in the tree was changed or deleted')
    expect(out.input_needed).toContain('tracking ref')
    // ...and it counts that write correctly. "The single write it makes is refreshing this
    // branch's own origin tracking ref" was itself an undercount: the fetch has no
    // `--no-write-fetch-head`, so it rewrites FETCH_HEAD too and writes whatever objects it
    // downloads (verified on a scratch repo: FETCH_HEAD recreated by that exact command).
    // A delivery that undercounts its writes is the overclaiming this refusal exists to stop.
    expect(out.input_needed).not.toContain('the single write')
    expect(out.input_needed).toContain('FETCH_HEAD')
    expect(out.input_needed).toContain('objects it downloads')
  })

  test('the fetch it names is the one the arm that fired actually made', () => {
    // OVERCOUNTING IS THE SAME DEFECT AS UNDERCOUNTING. The sentence above was attached to
    // EVERY branch-held delivery, and the HELD arms make no network call at all — the composer
    // says so in as many words ("HELD: no network call in this arm"). So live, dead, prunable
    // and shared-checkout refusals reported a write that never happened, in the one message
    // whose subject is not claiming things nobody established.
    const held =
      "branch trident/x already carries 3 commit(s) not on origin/main — it was not cut from " +
      "origin/main; refusing to build on another lane's work. The wrong-base launch guard found " +
      'the branch checked out in worktree /repo/wt, whose lock names pid 4242, and that process ' +
      'is ALIVE — a live holder owns this branch.'
    const out = interpretFailure(run({ failure_reason: held }))
    expect(out.klass).toBe('branch-held')
    expect(out.input_needed).toContain('No branch, worktree, commit or file in the tree was changed or deleted')
    expect(out.input_needed).toContain('no network call at all')
    expect(out.input_needed).not.toContain('FETCH_HEAD')

    // POSITIVE CONTROL: the arm that DOES fetch still names the fetch and everything it writes.
    const unheld =
      "branch trident/x already carries 3 commit(s) not on origin/main — it was not cut from " +
      "origin/main; refusing to build on another lane's work. The wrong-base launch guard found " +
      'no worktree holding the branch, and origin/trident/x is at the identical commit.'
    const fetched = interpretFailure(run({ failure_reason: unheld }))
    expect(fetched.input_needed).toContain('FETCH_HEAD')
    expect(fetched.input_needed).not.toContain('no network call at all')

    // ...and an arm that refused BEFORE establishing the holder claims neither.
    const early =
      "branch trident/x already carries 3 commit(s) not on origin/main — it was not cut from " +
      "origin/main; refusing to build on another lane's work. The wrong-base launch guard could " +
      'not enumerate worktrees to find the branch\'s holder (git died) — the holder is UNKNOWN.'
    const before = interpretFailure(run({ failure_reason: early }))
    expect(before.klass).toBe('branch-held')
    expect(before.input_needed).toContain('refused before it could establish the holder')

    // AND THE ARM IS READ FROM THE EVIDENCE SENTENCE, not from anywhere in the reason. A lock
    // reason is quoted verbatim into a HELD refusal and can spell the unheld arm's opening; the
    // held arm's sentence comes first, so the forgery loses.
    const forged =
      "branch trident/x already carries 3 commit(s) not on origin/main — it was not cut from " +
      "origin/main; refusing to build on another lane's work. The wrong-base launch guard found " +
      'the branch checked out in worktree /repo/wt, whose lock ("The wrong-base launch guard ' +
      'found no worktree holding the branch") names no pid.'
    expect(interpretFailure(run({ failure_reason: forged })).input_needed).toContain('no network call at all')

    // AND THE REBASE/BISECT-HOLDER ARM IS A HELD ARM WEARING THE UNHELD ARM'S OPENING. Its
    // sentence begins "found no worktree WITH <branch> CHECKED OUT, but worktree ... has a
    // REBASE in progress", so a prefix test for "found no worktree" matched it and reported a
    // fetch — which that arm returns BEFORE making. The overcounting this conditional exists
    // to prevent, in the arm nobody checked.
    const rebasing =
      "branch trident/x already carries 3 commit(s) not on origin/main — it was not cut from " +
      "origin/main; refusing to build on another lane's work. The wrong-base launch guard found " +
      'no worktree with trident/x CHECKED OUT, but worktree /repo/wt has a REBASE in progress ' +
      'whose head-name is trident/x — git omits the branch attribute for a worktree in that state.'
    const held2 = interpretFailure(run({ failure_reason: rebasing }))
    expect(held2.klass).toBe('branch-held')
    expect(held2.input_needed).toContain('no network call at all')
    expect(held2.input_needed).not.toContain('FETCH_HEAD')
    expect(held2.input_needed).not.toContain('tracking ref')
  })

  test('the read-only reassurance is not asserted over the arm that fetches', () => {
    // "No branch, worktree, commit or file was changed or deleted — THE GUARD ONLY READ STATE"
    // was a constant, printed on every arm, and the very next sentence on the fetching arm
    // described three writes (a tracking ref, FETCH_HEAD, downloaded objects). The pair
    // asserted read-only and then contradicted itself, in the one message whose subject is not
    // claiming things nobody established. The reassurance that is OWED — nothing destructive
    // moved — is unconditional; "only read" is not, so it moved to the per-arm sentence.
    const wrongBase = (evidence: string): string =>
      "branch trident/x already carries 3 commit(s) not on origin/main — it was not cut from " +
      `origin/main; refusing to build on another lane's work. ${evidence}`
    const fetched = interpretFailure(
      run({
        failure_reason: wrongBase(
          'The wrong-base launch guard found no worktree holding the branch, and origin/trident/x ' +
            'is at the identical commit.',
        ),
      }),
    )
    expect(fetched.input_needed).toContain('No branch, worktree, commit or file in the tree was changed or deleted')
    expect(fetched.input_needed).not.toContain('only READ state')
    expect(fetched.input_needed).toContain('FETCH_HEAD')

    // POSITIVE CONTROL: an arm that really did only read still says so.
    const held = interpretFailure(
      run({
        failure_reason: wrongBase(
          'The wrong-base launch guard found the branch checked out in worktree /repo/wt, whose ' +
            'lock names pid 4242, and that process is ALIVE — a live holder owns this branch.',
        ),
      }),
    )
    expect(held.input_needed).toContain('only READ state')
  })

  test('a legal branch name carrying Unicode whitespace cannot shed the stand-down', () => {
    // THE ANCHOR'S PREMISE WAS NOT GIT'S. The classifier spelled the name fields `\S+`, on the
    // stated ground that "branch and base names cannot contain spaces". What git forbids is the
    // ASCII space; `git check-ref-format --branch $'trident/x\u00a0stalled'` exits 0. JavaScript's
    // `\s` INCLUDES U+00A0, so `\S` refused to match that legal name, the anchored prefix missed,
    // and the refusal fell through to the classifiers that key on substrings like 'stalled' —
    // and was answered with "Reply to retry the build", the one advice this class forbids,
    // restored by nothing more than somebody's choice of branch name.
    for (const branch of ['trident/x\u00a0stalled', 'trident/x\u2003exhausted', 'trident/x\u3000rebase']) {
      const reason =
        `branch ${branch} already carries 3 commit(s) not on origin/main — it was not cut from ` +
        "origin/main; refusing to build on another lane's work. The wrong-base launch guard found " +
        'the branch checked out in worktree /repo/wt, whose lock names pid 4242, and that process ' +
        'is ALIVE — a live holder owns this branch.'
      const out = interpretFailure(run({ failure_reason: reason }))
      expect(out.klass).toBe('branch-held')
      expect(out.input_needed).not.toContain('Reply to retry')
      expect(out.input_needed).toContain('no network call at all')
    }

    // NEGATIVE CONTROL: the field still cannot swallow the prose around it. A reason whose
    // "branch name" contains the ASCII space git actually forbids is not this refusal, and
    // must not be classified as one — that is the property the anchor was bought for.
    const spaced =
      'branch trident/x stalled already carries 3 commit(s) not on origin/main — it was not cut ' +
      "from origin/main; refusing to build on another lane's work. Something else entirely."
    expect(interpretFailure(run({ failure_reason: spaced })).klass).not.toBe('branch-held')
  })

  test('a reason that merely QUOTES the refusal is not classified as one', () => {
    // THE DISCRIMINATOR WAS AN UNANCHORED includes() OVER A FREE-FORM REASON. `orchestrator.ts`
    // interpolates workflow error text straight into failure reasons, so an error that echoes a
    // previous refusal — or any prose containing the phrase — was delivered as a launch refusal
    // and lost the retry advice a real launch failure is owed. The refusal is now matched by
    // the composer's WHOLE prefix, anchored at position 0.
    const echoed = interpretFailure(
      run({
        failure_reason:
          'build infrastructure failed: workflow error: the previous run said "refusing to ' +
          'build on another lane\'s work" and exited 1',
      }),
    )
    expect(echoed.klass).not.toBe('branch-held')

    // AND THE ANCHOR ITSELF, pinned (Argus finding). The test above embeds only a FRAGMENT of
    // the prefix, so deleting the `^` from WRONG_BASE_PREFIX left the whole suite green. This
    // reason embeds the prefix WHOLE and INTACT, mid-string — the shape `orchestrator.ts`
    // produces whenever workflow error text quotes a previous refusal. Unanchored, it matches,
    // and delivery.ts then slices by `m[0].length` rather than `m.index`, so the arm is chosen
    // from a GARBLED evidence sentence: the wrong class AND the wrong write attribution, from
    // one deleted character.
    const embedded =
      'build infrastructure failed: workflow error: the previous run said "branch trident/x ' +
      'already carries 3 commit(s) not on origin/main — it was not cut from origin/main; ' +
      "refusing to build on another lane's work. The wrong-base launch guard found the branch " +
      'checked out in worktree /repo/wt, whose lock names pid 4242, and that process is ALIVE." ' +
      'and exited 1'
    expect(interpretFailure(run({ failure_reason: embedded })).klass).not.toBe('branch-held')

    // POSITIVE CONTROL: the real refusal still classifies, `?` count included — the launch
    // guard renders that when `rev-list --count` could not be read.
    for (const count of ['3', '?']) {
      const real =
        `branch trident/x already carries ${count} commit(s) not on origin/main — it was not cut ` +
        "from origin/main; refusing to build on another lane's work. The wrong-base launch guard " +
        'found the branch checked out in worktree /repo/wt, whose lock names pid 4242, and that ' +
        'process is ALIVE — a live holder owns this branch.'
      expect(interpretFailure(run({ failure_reason: real })).klass).toBe('branch-held')
    }
  })

  test('neither summary ever pastes the raw reason at the owner', () => {
    for (const reason of [
      "inner workflow ended at round 1 of 10 at checkpoint 'inner-error' without Argus APPROVE",
      'inner loop exhausted 10 round(s) without Argus APPROVE',
    ]) {
      const out = interpretFailure(run({ failure_reason: reason }))
      expect(out.summary).not.toContain('Argus')
      expect(out.summary).not.toContain('checkpoint')
    }
  })
})

/**
 * A PUBLISH FAILURE MUST CARRY GIT'S WORDS — AND MUST NOT BECOME A DISCLOSURE SURFACE.
 *
 * Run `2aacf419` stored `outer publisher could not push branch <b>` and nothing else, while git's
 * stderr had already said `! [rejected] … (non-fast-forward)`. Carrying that text is the fix; the
 * risk it introduces is that a push error is EXACTLY where a credential surfaces, because git
 * echoes the remote URL back verbatim. So the observability fix and the redaction are one change:
 * shipping the first without the second trades a silent defect for a leaking one.
 */
describe('redactPushError — git may speak, the credential may not', () => {
  test("a credential embedded in the remote URL never survives", () => {
    const out = redactPushError(
      "remote: Invalid username or password\nfatal: Authentication failed for 'https://x-access-token:ghp_AAAABBBBCCCCDDDDEEEEFFFF@github.test/o/r.git/'",
    )
    expect(out).not.toContain('ghp_AAAABBBBCCCCDDDDEEEEFFFF')
    expect(out).toContain('***@')
    // …and the DIAGNOSIS still survives, or the redaction has eaten the reason for carrying it.
    expect(out).toContain('Authentication failed')
  })

  test('a credential that is NOT token-shaped is still redacted — the URL rule earns its place', () => {
    // MUTATION-FOUND HOLE (2026-08-14). The first version of this block only used a `ghp_`
    // fixture, so deleting the URL rule entirely left the suite GREEN — the token-shape rule
    // happened to catch the same string, and even `toContain('***@')` still passed because the
    // redacted token kept the `@`. The rule was untested while appearing tested.
    // A basic-auth secret matches NO token shape, so only the URL rule can catch it.
    const raw = "fatal: Authentication failed for 'https://neutron:hunter2-not-a-token@git.test/o/r.git/'"
    const out = redactPushError(raw)
    expect(raw).toContain('hunter2-not-a-token') // positive control: it IS in the input
    expect(out).not.toContain('hunter2-not-a-token')
    expect(out).toContain('***@')
    expect(out).toContain('Authentication failed')
  })

  test('USERNAME-ONLY userinfo is redacted — a token needs no password half', () => {
    // CODEX REVIEW [P1 Security], found by the reviewer running the exported function rather than
    // reading the regex. `https://<token>@host` is the single most common way a credential ends
    // up in a remote URL, and the first cut required a colon, so it reached a PERSISTED reason.
    const raw = "fatal: Authentication failed for 'https://super-secret-value@git.test/o/r.git/'"
    expect(raw).toContain('super-secret-value') // positive control
    const out = redactPushError(raw)
    expect(out).not.toContain('super-secret-value')
    expect(out).toContain('***@')
    expect(out).toContain('Authentication failed')
  })

  test('a bare token shape is redacted even without a URL around it', () => {
    for (const shape of ['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_', 'github_pat_']) {
      const out = redactPushError(`error: token ${shape}ZZZZZZZZZZZZZZZZZZZZ rejected`)
      expect(out).not.toContain(`${shape}ZZZZZZZZZZZZZZZZZZZZ`)
      expect(out).toContain('***')
    }
  })

  test('POSITIVE CONTROL — the assertion above can actually fail', () => {
    // Without this, a redactor that returned '' would pass every test in this block while
    // destroying the diagnosis. The secret must be findable in the INPUT.
    const raw = 'fatal: could not read Password for https://x-access-token:ghp_SECRETSECRETSECRET@github.test'
    expect(raw).toContain('ghp_SECRETSECRETSECRET')
    expect(redactPushError(raw)).not.toContain('ghp_SECRETSECRETSECRET')
  })

  test('an ordinary rejection passes through intact — redaction is not censorship', () => {
    const out = redactPushError('! [rejected]  feat-x -> feat-x (non-fast-forward)')
    expect(out).toContain('non-fast-forward')
  })

  test('an unbounded paste is bounded — a reason is read in a chat row', () => {
    expect(redactPushError('x'.repeat(5000)).length).toBeLessThanOrEqual(600)
  })
})

describe('publishFailureReason — names the step, quotes the cause, invents nothing', () => {
  test("git's own words reach the stored reason", () => {
    const r = publishFailureReason('push', 'feat-x', '! [rejected] (non-fast-forward)')
    expect(r).toContain('could not push branch feat-x')
    expect(r).toContain('non-fast-forward')
  })

  test("'open a PR for' carries gh's words", () => {
    const r = publishFailureReason(
      'open a PR for',
      'feat-x',
      'GraphQL: No commits between main and feat-x (createPullRequest)',
    )
    expect(r).toContain('could not open a PR for branch feat-x')
    expect(r).toContain('No commits between')
  })

  test("'open a PR for' keeps the previous wording when stderr is empty", () => {
    expect(publishFailureReason('open a PR for', 'feat-x', '')).toBe(
      'outer publisher could not open a PR for branch feat-x',
    )
  })

  test("'open a PR for' redacts credentials before carrying gh's words", () => {
    const raw = 'fatal: could not create PR: https://x-access-token:ghp_SECRET789@github.test/o/r rejected'
    const reason = publishFailureReason('open a PR for', 'feat-x', raw)
    expect(raw).toContain('ghp_SECRET789')
    expect(reason).not.toContain('ghp_SECRET789')
    expect(reason).toContain('***')
  })

  test('silence stays silent rather than being filled in', () => {
    // The #240 rule applied to this path: with nothing measured, assert nothing.
    const r = publishFailureReason('push', 'feat-x', '   ')
    expect(r).toBe('outer publisher could not push branch feat-x')
    expect(r).not.toContain(':')
  })

  test('the step is named, so two publish failures are not one message', () => {
    const a = publishFailureReason('push', 'feat-x', '')
    const b = publishFailureReason('read the remote state of', 'feat-x', '')
    expect(a).not.toBe(b)
  })
})

/**
 * T4 — AN INFRASTRUCTURE DEATH IS NOT A VERDICT (run `f384460d`, 2026-08-15).
 *
 * The inner workflow threw after the build succeeded. Its catch path writes
 * `{ ok:false, verdict:'REQUEST_CHANGES', checkpoint:'inner-error', findings: [] }` — the
 * verdict is the wrapper's, self-asserted on a throw, not a reviewer's. The checkpoint and
 * `block_kind:'infra-only'` are measured signals that no review verdict happened.
 */
describe('T4 — an inner-error with no findings is INFRASTRUCTURE, not a review outcome', () => {
  const innerError = (over: Record<string, unknown> = {}) => ({
    ok: false,
    verdict: 'REQUEST_CHANGES' as const,
    round: 4,
    checkpoint: 'inner-error',
    block_kind: null,
    terminal_cause: null,
    findings_present: false,
    ...over,
  })

  test('HEADLINE: the f384460d shape stores the infrastructure sentence exactly', () => {
    const reason = innerTerminalFailureReason(run({ round: 4, max_rounds: 10 }), innerError())
    expect(reason).toBe('build infrastructure failed at round 4 of 10 before any review verdict')
    expect(reason).not.toContain('without Argus APPROVE')
    expect(reason).not.toContain('exhausted')
  })

  test('an inner-error that DOES carry findings keeps the generic sentence, unchanged', () => {
    const reason = innerTerminalFailureReason(
      run({ round: 4, max_rounds: 10 }),
      innerError({ findings_present: true }),
    )
    expect(reason).toBe(
      "inner workflow ended at round 4 of 10 at checkpoint 'inner-error' without Argus APPROVE",
    )
  })

  test('an infra-only stop WITH a measured cause still quotes the cause unchanged', () => {
    const reason = innerTerminalFailureReason(
      run({ round: 1, max_rounds: 10 }),
      innerError({
        round: 1,
        checkpoint: 'argus-request-changes',
        block_kind: 'infra-only',
        terminal_cause: 'REVIEW DEFERRED — gh auth login',
      }),
    )
    expect(reason).toBe(
      'review never ran (infra-only) at round 1 of 10: REVIEW DEFERRED — gh auth login',
    )
  })

  test('an infra-only stop with NO cause falls to the infrastructure sentence', () => {
    const reason = innerTerminalFailureReason(
      run({ round: 1, max_rounds: 10 }),
      innerError({ round: 1, checkpoint: 'argus-request-changes', block_kind: 'infra-only' }),
    )
    expect(reason).toBe(infraDeathSentence(1, 10))
  })

  test('both authored infra reasons reach the owner as the infra class', () => {
    for (const reason of [
      infraDeathSentence(4, 10),
      'review never ran (infra-only) at round 1 of 10: REVIEW DEFERRED — gh auth login',
    ]) {
      const out = interpretFailure(run({ failure_reason: reason }))
      expect(out.klass).toBe('infra')
      expect(out.summary).not.toContain('blocking findings')
    }
  })
})

describe('isInfraDeath — which terminal results are infrastructure, and which are not', () => {
  const r = (over: Partial<Parameters<typeof isInfraDeath>[0]>) => ({
    ok: false,
    verdict: 'REQUEST_CHANGES' as const,
    checkpoint: 'inner-error',
    block_kind: null,
    findings_present: false,
    ...over,
  })

  test('infra-only is infrastructure regardless of findings — no seat ever judged the code', () => {
    expect(isInfraDeath(r({ block_kind: 'infra-only', checkpoint: 'argus-request-changes' }))).toBe(true)
    expect(
      isInfraDeath(
        r({ block_kind: 'infra-only', checkpoint: 'argus-request-changes', findings_present: true }),
      ),
    ).toBe(true)
  })

  test('the f384460d shape — ok:false + inner-error + no findings — is infrastructure', () => {
    expect(isInfraDeath(r({}))).toBe(true)
  })

  test('an inner-error WITH findings is not — a real review is behind it', () => {
    expect(isInfraDeath(r({ findings_present: true }))).toBe(false)
  })

  test('a genuine review rejection is not infrastructure', () => {
    expect(
      isInfraDeath(
        r({ checkpoint: 'argus-request-changes', block_kind: 'code', findings_present: true }),
      ),
    ).toBe(false)
  })

  test('an APPROVE is never infrastructure — reclassifying one would drop a successful run', () => {
    expect(isInfraDeath(r({ verdict: 'APPROVE', block_kind: 'infra-only' }))).toBe(false)
  })

  test('ok:true with an inner-error checkpoint is not — the catch path writes ok:false', () => {
    expect(isInfraDeath(r({ ok: true }))).toBe(false)
  })
})

describe('classifyPublishFailure — credential vs ref rejection, from the stored reason alone', () => {
  test('classifies a measured credential failure from the stored reason', () => {
    const reason = publishFailureReason(
      'push',
      'trident/work-board-row-state-a-card-must-no',
      "fatal: could not read Username for 'https://github.com': No such device or address",
    )
    expect(classifyPublishFailure(reason)).toBe('publish-credential')
  })

  test('classifies a measured ref rejection from the stored reason', () => {
    const reason = publishFailureReason(
      'push',
      'trident/x',
      '! [rejected]        trident/x -> trident/x (non-fast-forward)\nerror: failed to push some refs',
    )
    expect(classifyPublishFailure(reason)).toBe('publish-ref-rejected')
  })

  test('rejection evidence wins over credential evidence', () => {
    const reason = publishFailureReason('push', 'b', 'Authentication failed; non-fast-forward')
    // A retry must never fire on a rejection.
    expect(classifyPublishFailure(reason)).toBe('publish-ref-rejected')
  })

  test('unrecognised evidence stays unknown', () => {
    expect(classifyPublishFailure('')).toBe('publish-unknown')
    expect(
      classifyPublishFailure(publishFailureReason('push', 'b', 'error: remote hung up unexpectedly')),
    ).toBe('publish-unknown')
  })

  test('bare numbers in object ids are not credential evidence', () => {
    const reason = publishFailureReason(
      'push',
      'b',
      'error: object 9bb31a2e401ffffffffffffffffffffffffffff0 broken',
    )
    expect(classifyPublishFailure(reason)).toBe('publish-unknown')
  })

  test('redaction removes a basic-auth token without removing credential evidence', () => {
    const raw =
      "fatal: Authentication failed for 'https://x-access-token:ghp_SECRET123@github.com/o/r/'"
    expect(raw.includes('ghp_SECRET123')).toBe(true)
    const stored = publishFailureReason('push', 'b', raw)
    expect(stored).not.toContain('ghp_SECRET123')
    expect(classifyPublishFailure(stored)).toBe('publish-credential')
  })

  test('redacts single-value userinfo without removing credential evidence', () => {
    const raw = "fatal: could not read Password for 'https://ghp_SECRET456@github.com'"
    const stored = publishFailureReason('push', 'b', raw)
    expect(stored).not.toContain('ghp_SECRET456')
    expect(classifyPublishFailure(stored)).toBe('publish-credential')
  })
})

/**
 * THE COMPOSER→CLASSIFIER SEAM, EXERCISED END TO END (Argus finding).
 *
 * `delivery.ts` recognises this refusal by a frozen copy of `composeWrongBaseRefusal`'s prefix
 * (`WRONG_BASE_PREFIX`) and picks its write-attribution sentence from frozen copies of each
 * arm's OPENING (`wrongBaseWrites`). Every test either side of that seam used HAND-WRITTEN
 * reason strings — the composer's tests assert on the composer's output, the classifier's tests
 * assert over literals typed into this file — so the two halves were pinned only to each
 * other's TRANSCRIPTION. A wording change in the composer silently reroutes the classifier (a
 * `branch-held` refusal falling through to "Reply to retry the build", the one advice this
 * class exists to forbid) while both suites stay green. That is what the comments in
 * `delivery.ts` mean when they say the two halves must move together — a rule nothing enforced.
 *
 * So this block runs the REAL composer, arm by arm, and feeds its ACTUAL output through
 * `interpretFailure`. The assertions are per-arm and load-bearing — the class, and the write
 * attribution that arm is entitled to — never whole-message equality, so wording stays free to
 * change and the seam stays pinned.
 */
describe('composeWrongBaseRefusal → interpretFailure — the two halves of the seam, actually joined', () => {
  const okRes = (stdout = ''): HostCommandResult => ({ ok: true, stdout, stderr: '', exit_code: 0 })
  const TIP = 'c'.repeat(40)
  const DIVERGED = 'd'.repeat(40)
  const WT = '/repo/.claude/worktrees/wf_a'
  const ARGS = { repo: '/repo', branch: 'feat-x', base: 'main', branch_tip: TIP, ahead_count: '3', run_id: 'run-77' }
  const FETCH = 'fetch --no-tags origin +refs/heads/feat-x:refs/remotes/origin/feat-x'
  const RESOLVE = 'rev-parse --verify --quiet refs/remotes/origin/feat-x'
  const clear = (): TreeOccupancy => ({ kind: 'clear' })

  /** git's real `-z` shape: every attribute NUL-terminated, an empty attribute closing a record. */
  const zPorcelain = (...records: string[][]): string =>
    records.map((fields) => fields.map((f) => `${f}\0`).join('') + '\0').join('')
  const MAIN_FIELDS = ['worktree /repo', 'HEAD ' + 'a'.repeat(40), 'branch refs/heads/main']
  const HELD_FIELDS = [
    `worktree ${WT}`,
    'HEAD ' + TIP,
    'branch refs/heads/feat-x',
    'locked claude agent wf_a (pid 4242 start 99)',
  ]
  const DETACHED_FIELDS = [`worktree ${WT}`, 'HEAD ' + TIP, 'detached']

  const host =
    (answers: Record<string, HostCommandResult>) =>
    async (cmd: string[]): Promise<HostCommandResult> => {
      const joined = cmd.join(' ')
      for (const [key, res] of Object.entries(answers)) if (joined.includes(key)) return res
      return okRes('')
    }
  const listing = (porcelain: string, extra: Record<string, HostCommandResult> = {}) =>
    host({ 'worktree list --porcelain': okRes(porcelain), ...extra })
  const held = listing(zPorcelain(MAIN_FIELDS, HELD_FIELDS))
  const unheld = (originAt: HostCommandResult) =>
    listing(zPorcelain(MAIN_FIELDS), { [FETCH]: okRes(), [RESOLVE]: originAt })
  /** Answers the enumeration and the fetch, then throws — the catch-all arm, POST-fetch. */
  const throwsAfterFetch = async (cmd: string[]): Promise<HostCommandResult> => {
    const joined = cmd.join(' ')
    if (joined.includes('worktree list --porcelain')) return okRes(zPorcelain(MAIN_FIELDS))
    if (joined.includes(FETCH)) return okRes()
    throw new Error('the runner exploded')
  }
  const rebaseDeps = {
    run_host: listing(zPorcelain(MAIN_FIELDS, DETACHED_FIELDS)),
    probe_tree: clear,
    rebase_head: () => ({ kind: 'branch' as const, ref: 'refs/heads/feat-x' }),
  }

  const deliver = async (deps: Parameters<typeof composeWrongBaseRefusal>[1]) => {
    const reason = await composeWrongBaseRefusal(ARGS, deps)
    return { reason, out: interpretFailure(run({ failure_reason: reason })) }
  }

  test('every arm the composer can emit is classified branch-held, never as a retryable failure', async () => {
    const arms: [string, Parameters<typeof composeWrongBaseRefusal>[1]][] = [
      ['live holder', { run_host: held, probe_pid: () => 'alive', probe_tree: clear }],
      ['dead holder', { run_host: held, probe_pid: () => 'dead', probe_tree: clear }],
      ['holder whose liveness is unknown', { run_host: held, probe_pid: () => 'unknown', probe_tree: clear }],
      [
        'lock naming no pid',
        {
          run_host: listing(zPorcelain(MAIN_FIELDS, [...HELD_FIELDS.slice(0, 3), 'locked no pid here'])),
          probe_tree: clear,
        },
      ],
      [
        'prunable holder',
        {
          run_host: listing(zPorcelain(MAIN_FIELDS, [...HELD_FIELDS, 'prunable gitdir file is gone'])),
          probe_tree: clear,
        },
      ],
      [
        "the repo's own shared checkout",
        {
          run_host: listing(zPorcelain(['worktree /repo', 'HEAD ' + TIP, 'branch refs/heads/feat-x'])),
          probe_tree: clear,
        },
      ],
      ['a rebase standing on the branch', rebaseDeps],
      ['unheld, origin carries the tip', { run_host: unheld(okRes(`${TIP}\n`)), probe_tree: clear }],
      ['unheld, origin has diverged', { run_host: unheld(okRes(`${DIVERGED}\n`)), probe_tree: clear }],
      [
        'unheld, origin has no such branch',
        { run_host: unheld({ ok: false, stdout: '', stderr: '', exit_code: 1 }), probe_tree: clear },
      ],
      [
        'the worktree listing failed',
        {
          run_host: host({
            'worktree list --porcelain': { ok: false, stdout: '', stderr: 'git died', exit_code: 128 },
          }),
          probe_tree: clear,
        },
      ],
      ['resolution threw', { run_host: throwsAfterFetch, probe_tree: clear }],
    ]

    for (const [name, deps] of arms) {
      const { reason, out } = await deliver(deps)
      // The composer really did produce a refusal, and the classifier read it as one.
      expect(reason).toContain("refusing to build on another lane's work")
      expect(`${name}: ${out.klass}`).toBe(`${name}: branch-held`)
      expect(`${name}: ${out.input_needed}`).toContain('No branch, worktree, commit or file in the tree was changed or deleted')
      // The advice this class exists to forbid — a launch that never happened is not retried
      // by replying, and the branch is not this run's to take until it is free.
      expect(`${name}: ${out.input_needed}`).not.toContain('Reply to retry')
      expect(`${name}: ${out.summary}`).toContain('not cut from the base')
    }
  })

  test('a legal name carrying a foldable separator keeps the anchor — the fold cannot restore the retry advice', async () => {
    // THE CLASSIFIER'S ANCHOR AND THE COMPOSER'S FOLD DISAGREED, and the disagreement was
    // invisible to both suites because each pinned its own half. `WRONG_BASE_PREFIX` spells the
    // branch and base fields `[^ \n]+` — the ASCII space, deliberately, because that is the one
    // character git's ref rules forbid (git 2.43: `check-ref-format --branch` exits 0 on a name
    // holding U+2028, 128 on one holding a space). The composer then folded exactly those legal
    // codepoints TO an ASCII space, so the composed prefix carried a space inside a field the
    // classifier promised could not hold one: the anchor missed, and the refusal fell through to
    // the substring classifiers, where a live-holder stand-down was answered with "Reply to
    // retry the build" — the one advice this class exists to forbid, restored by nothing more
    // than somebody's choice of branch name.
    //
    // Every case below is a name git accepts, driven through the REAL composer and the REAL
    // classifier, so neither half can drift back on its own.
    const NBSP = '\u00a0'
    const hostile: [string, { branch: string; base: string }][] = [
      ['U+2028 in the branch', { branch: `feat-x\u2028FORGED:${NBSP}run${NBSP}git${NBSP}branch${NBSP}-D${NBSP}--${NBSP}victim`, base: 'main' }],
      ['U+202E in the branch', { branch: 'feat-\u202ex', base: 'main' }],
      ['U+00A0 in the branch', { branch: 'feat-x\u00a0stalled', base: 'main' }],
      // THE BASE IS A NAME FIELD TOO, and the anchor reads it with the same class.
      ['U+2028 in the base', { branch: 'feat-x', base: 'main\u2028FORGED:\u00a0rebase\u00a0now' }],
    ]
    for (const [name, args] of hostile) {
      const porcelain = zPorcelain(MAIN_FIELDS, [
        `worktree ${WT}`,
        'HEAD ' + TIP,
        `branch refs/heads/${args.branch}`,
        'locked claude agent wf_a (pid 4242 start 99)',
      ])
      const reason = await composeWrongBaseRefusal(
        { ...ARGS, ...args },
        { run_host: listing(porcelain), probe_pid: () => 'alive', probe_tree: clear },
      )
      const out = interpretFailure(run({ failure_reason: reason }))
      expect(`${name}: ${out.klass}`).toBe(`${name}: branch-held`)
      expect(`${name}: ${out.input_needed}`).not.toContain('Reply to retry')
      expect(`${name}: ${out.input_needed}`).toContain('No branch, worktree, commit or file in the tree was changed or deleted')
      // The arm is still the live-holder one, so it still names its evidence and still refuses
      // to print the delete.
      expect(`${name}: ${reason}`).toContain('ALIVE')
      expect(`${name}: ${reason}`).not.toContain('branch -D')
    }

    // POSITIVE CONTROL: an ordinary name reaches the same classification, so the assertions
    // above are not passing because every reason on earth classifies branch-held.
    const plain = await deliver({ run_host: held, probe_pid: () => 'alive', probe_tree: clear })
    expect(plain.out.klass).toBe('branch-held')
  })

  test('the write each arm is credited with is the one that arm actually made', async () => {
    // HELD: settled locally, so no network call at all — crediting it with a fetch reports a
    // write that never happened.
    const live = await deliver({ run_host: held, probe_pid: () => 'alive', probe_tree: clear })
    expect(live.reason).toContain('ALIVE')
    expect(live.reason).not.toContain('branch -D')
    expect(live.out.input_needed).toContain('no network call at all')
    expect(live.out.input_needed).not.toContain('FETCH_HEAD')

    // The rebase holder is a HELD arm wearing the unheld arm's OPENING; it must not be credited
    // with the fetch it returns before making.
    const rebasing = await deliver(rebaseDeps)
    expect(rebasing.reason).toContain('REBASE in progress')
    expect(rebasing.out.input_needed).toContain('no network call at all')
    expect(rebasing.out.input_needed).not.toContain('FETCH_HEAD')

    // UNHELD — POSITIVE CONTROL for all of the above: this arm DID fetch, so it is credited
    // with the fetch, and the enumeration of what that fetch wrote is complete: the tracking
    // ref, ITS REFLOG (which the enumeration used to omit while claiming "and nothing else"),
    // FETCH_HEAD, the objects.
    const safe = await deliver({ run_host: unheld(okRes(`${TIP}\n`)), probe_tree: clear })
    expect(safe.reason).toContain('branch -D')
    expect(safe.out.input_needed).toContain('tracking ref')
    expect(safe.out.input_needed).toContain('reflog')
    expect(safe.out.input_needed).toContain('FETCH_HEAD')
    expect(safe.out.input_needed).not.toContain('no network call at all')

    // REFUSED UPSTREAM OF THE FETCH: neither claim.
    const blind = await deliver({
      run_host: host({ 'worktree list --porcelain': { ok: false, stdout: '', stderr: 'git died', exit_code: 128 } }),
      probe_tree: clear,
    })
    expect(blind.reason).toContain('UNKNOWN')
    expect(blind.out.input_needed).toContain('refused before it could establish the holder')
    expect(blind.out.input_needed).not.toContain('FETCH_HEAD')

    // THE THROW ARM SITS ON BOTH SIDES OF THE FETCH. The composer's outer catch wraps the
    // composition AFTER the fetch too, so the fall-through's "refused before it could establish
    // the holder" asserted a fetch did NOT happen when this fixture proves one already had.
    // Which side it threw on is exactly what is not established, so the delivery says that.
    const threw = await deliver({ run_host: throwsAfterFetch, probe_tree: clear })
    expect(threw.reason).toContain('remedy resolution threw')
    expect(threw.out.input_needed).not.toContain('refused before it could establish the holder')
    expect(threw.out.input_needed).toContain('either side of that fetch')
  })

  test('the write accounting is scoped to the guard, and the launcher\'s own base fetch is not hidden by it', async () => {
    // THE GUARD IS NOT THE ONLY THING THAT RAN ON THIS PATH (Argus blocker). The held arms say
    // the guard "made no network call at all" — true of the guard, and read by the owner as
    // true of the refusal. It is not: a fresh PR launch fetches origin's BASE ref in
    // `orchestrator.ts` before the composer is ever called, which moves origin's base pointer
    // and rewrites git's own bookkeeping. A refusal whose whole subject is not claiming things
    // nobody established cannot also say a path that made a network call made none.
    for (const [name, deps] of [
      ['live holder', { run_host: held, probe_pid: () => 'alive' as const, probe_tree: clear }],
      ['rebase holder', rebaseDeps],
      ['unheld, origin carries the tip', { run_host: unheld(okRes(`${TIP}\n`)), probe_tree: clear }],
      [
        'the worktree listing failed',
        {
          run_host: host({
            'worktree list --porcelain': { ok: false, stdout: '', stderr: 'git died', exit_code: 128 },
          }),
          probe_tree: clear,
        },
      ],
    ] as [string, Parameters<typeof composeWrongBaseRefusal>[1]][]) {
      const { out } = await deliver(deps)
      // The claim is SCOPED — "the guard itself" — and the launcher's own write is named and
      // attributed to the launcher rather than folded into the guard's accounting or dropped.
      expect(`${name}: ${out.input_needed}`).toContain('That accounts for the guard itself.')
      expect(`${name}: ${out.input_needed}`).toContain("a fresh PR launch refreshes origin's base ref before this guard runs")
      expect(`${name}: ${out.input_needed}`).toContain('that write belongs to the launcher')
      // ...and it does not become licence to retry: the branch is still not this run's to take.
      expect(`${name}: ${out.input_needed}`).not.toContain('Reply to retry')
    }

    // The held arms are still credited with NO fetch of their own — the disclosure above is
    // about a different step, and it must not have smuggled the guard's fetch back in.
    const live = await deliver({ run_host: held, probe_pid: () => 'alive', probe_tree: clear })
    expect(live.out.input_needed).toContain('The guard itself only READ state')
    expect(live.out.input_needed).not.toContain('FETCH_HEAD')
    expect(live.out.input_needed).not.toContain('tracking ref')

    // AND THE REASSURANCE IS SCOPED TO THE TREE. Unqualified, "no file was changed" sat one
    // clause before the fetching arm naming FETCH_HEAD — a file — as one of its writes.
    const safe = await deliver({ run_host: unheld(okRes(`${TIP}\n`)), probe_tree: clear })
    expect(safe.out.input_needed).toContain('file in the tree was changed or deleted')
    expect(safe.out.input_needed).toContain('FETCH_HEAD')
    // ...and the fetching arm's enumeration no longer closes itself with a claim a config can
    // falsify: `fetch.writeCommitGraph` writes under `.git`, outside the four items named.
    expect(safe.out.input_needed).not.toContain('objects it downloads, and nothing else')
    expect(safe.out.input_needed).toContain('and nothing outside .git')
  })
})

/**
 * THE OTHER PRE-LAUNCH REFUSALS — the ones the wrong-base composer never sees.
 *
 * `orchestrator.ts`'s launch path refuses in four places BEFORE any build starts, and every one
 * of those reasons QUOTES git: the probe's exit code, its stderr, the repo path. Every keyword
 * branch in `interpretFailure` below the launch-guard arm is a bare `includes()` over that
 * quotation, so `git merge-base --is-ancestor exited 128` matched the merge-mechanics token
 * `git ` and the refusal was delivered as "The build finished but a git step failed while
 * landing the branch" — a completed build and a merge attempt, both asserted about a run whose
 * own text says the build was NOT started (Argus blocker). The watchdog variant carries no
 * `git ` token and fell to the bare `unknown` fallback: same defect, vaguer sentence.
 *
 * `orchestrator.test.ts` pins the seam against the REAL composed reasons. This table pins the
 * classifier's own boundary — what it must catch, and just as importantly what it must not.
 */
describe('interpretFailure — a pre-launch refusal is never delivered as a completed build', () => {
  const REPO = '/repo'
  const TIP = 'c'.repeat(40)
  const BASE = 'b'.repeat(40)

  const caught: [string, string][] = [
    [
      'ancestry UNKNOWN, quoting git and its exit code',
      `trident infra: could not establish whether branch feat-x at ${TIP} is contained in origin/main at ${BASE} in ${REPO} (git merge-base --is-ancestor exited 128: fatal: bad object) — ancestry is UNKNOWN, and UNKNOWN authorises nothing; the build was NOT started, and no branch, worktree, commit or file in the tree was changed or deleted.`,
    ],
    [
      'ancestry UNKNOWN because a watchdog killed the probe — no `git ` token at all',
      `trident infra: could not establish whether branch feat-x at ${TIP} is contained in origin/main at ${BASE} in ${REPO} (the ancestry probe was killed by its watchdog) — ancestry is UNKNOWN, and UNKNOWN authorises nothing; the build was NOT started, and no branch, worktree, commit or file in the tree was changed or deleted.`,
    ],
    [
      "the prior-base probe UNKNOWN",
      `trident infra: branch feat-x at ${TIP} is not contained in origin/main at ${BASE}, but whether it descends from this run's own prior base ${BASE} — the shape its own crash leaves behind — could NOT be established in ${REPO} (git merge-base --is-ancestor exited 128: fatal: bad object); that is UNKNOWN, and UNKNOWN authorises nothing; the build was NOT started, and no branch, worktree, commit or file in the tree was changed or deleted.`,
    ],
    [
      'the base fetch failed',
      `trident infra: could not fetch origin/main in ${REPO} before cutting the build branch — refusing to branch from the stale local ref; the build was NOT started: fatal: unable to access`,
    ],
    [
      'the base tip could not be resolved',
      `trident infra: fetched origin/main but could not resolve its tip in ${REPO}; the build was NOT started: fatal: bad object`,
    ],
  ]

  test('every pre-launch refusal is classified as a launch that never happened', () => {
    for (const [name, reason] of caught) {
      const out = interpretFailure(run({ failure_reason: reason }))
      expect(`${name}: ${out.klass}`).toBe(`${name}: infra`)
      expect(`${name}: ${out.summary}`).toContain('did not start this build')
      // The two sentences this class exists to forbid: neither the build nor the merge happened.
      expect(`${name}: ${out.summary}`).not.toContain('The build finished')
      expect(`${name}: ${out.summary}`).not.toContain('landing the branch')
      // Nothing was established, so nothing irreversible is proposed.
      expect(`${name}: ${out.input_needed}`).not.toContain('branch -D')
    }
  })

  test('the arm is ANCHORED, so a real post-launch failure keeps the advice it is owed', () => {
    // POSITIVE CONTROLS. An over-broad rule — one that keyed on `the build was NOT started`
    // wherever it appeared, or on a bare `trident infra` token — would swallow these, and a
    // genuine merge failure would lose the retry that is the correct answer to it.
    const mechanics = interpretFailure(
      run({ failure_reason: 'merge failed: git rebase --onto main exited 1' }),
    )
    expect(mechanics.klass).toBe('merge-mechanics')

    // The clause QUOTED inside a post-launch failure — a workflow error echoing an earlier
    // refusal — is not itself a pre-launch refusal, because the prefix is anchored at 0.
    const quoted = interpretFailure(
      run({
        failure_reason:
          'merge failed: git push exited 1: the previous run said "trident infra: ... the build was NOT started"',
      }),
    )
    expect(quoted.klass).toBe('merge-mechanics')
  })
})
