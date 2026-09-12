/**
 * THE TERMINAL CAUSE, END TO END (#520) — the vocabulary, the orchestrator's sentence,
 * and the owner's announce, joined by the tests that keep them joined.
 *
 * THE HISTORY THIS CLOSES is in `terminal-failure-reason.test.ts`'s header: four runs,
 * four different causes, one sentence, and a human sent to look at review quality three
 * times out of four for builds that had never started. #240 made the sentence stop
 * LYING; it left it saying nothing. What remained — and what this file covers — is the
 * missing signal itself: the workflow now MEASURES which exit it took, and the two
 * readers report that instead of deducing one.
 *
 * WHAT MAKES THIS A MEASUREMENT AND NOT THE INFERENCE TWO REVIEW ROUNDS KILLED. The
 * killed attempts read `(round, checkpoint)` — values equally consistent with four
 * endings. The kind is read off the loop's own exit guards at the exit
 * (`reviewLoopTerminalCause`, exercised in `inner-workflow-terminal-cause.test.ts`),
 * travels as its own field, and decodes fail-closed. Nothing downstream deduces
 * anything; the tests below pin that every consumer either uses the measured kind or
 * says exactly what it said before this card.
 */
import { describe, expect, test } from 'bun:test'
import {
  TERMINAL_CAUSES,
  parseTerminalCause,
  terminalCauseReason,
  type TerminalCause,
} from './terminal-cause.ts'
import { interpretFailure } from './delivery.ts'
import { innerTerminalFailureReason } from './orchestrator.ts'
import { deriveTerminalCause } from './infra-block.ts'
import type { TridentRun } from './store.ts'

const run = (over: Record<string, unknown> = {}): TridentRun =>
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
    harvested_at: null,
    inner_result: null,
    inner_verdict: null,
    inner_checkpoint_findings: null,
    ...over,
  }) as unknown as TridentRun

/** A harvested, terminally-failed row carrying the terminal result a workflow wrote. */
const harvested = (result: Record<string, unknown>, over: Record<string, unknown> = {}): TridentRun =>
  run({ phase: 'failed', harvested_at: 1_760_000_000_000, inner_result: JSON.stringify(result), ...over })

describe('the vocabulary decodes fail-closed, and never invents an assertion', () => {
  test('exactly the members decode', () => {
    for (const c of TERMINAL_CAUSES) expect(parseTerminalCause(c)).toBe(c)
    expect(TERMINAL_CAUSES.length).toBeGreaterThan(1)
  })

  test('everything else decodes null — INCLUDING things that look like members', () => {
    for (const bogus of [
      '',
      '   ',
      'Unknown',
      'ROUND-LOST-WORK',
      'round-lost',
      'round_lost_work',
      42,
      true,
      null,
      undefined,
      {},
      [],
      ['unknown'],
    ]) {
      expect(parseTerminalCause(bogus)).toBeNull()
    }
    // ...with one deliberate exception, because the writer may pad: surrounding
    // whitespace is trimmed, the way `terminal_cause` already is.
    expect(parseTerminalCause('  workflow-threw  ')).toBe('workflow-threw')
  })

  /**
   * FALSE AND UNKNOWN MUST NOT SHARE A BRANCH, and this is the assertion of it.
   *
   * `null` means the field did not arrive — a legacy row, a truncated result, a value
   * from a writer this build has never heard of. `'unknown'` means the workflow looked
   * at its own exit conditions and could not name one. Those are different facts with
   * different provenance: one is a hole in the data, the other is a measurement whose
   * answer is "cannot tell". A decoder that returned `'unknown'` for garbage would be
   * manufacturing an assertion nobody made, and every reader downstream would then be
   * unable to tell a run that answered from a run that was never asked.
   */
  test("a value nobody recognises decodes null, NOT 'unknown'", () => {
    expect(parseTerminalCause('a-cause-from-the-future')).toBeNull()
    expect(parseTerminalCause('a-cause-from-the-future')).not.toBe('unknown')
    expect(parseTerminalCause('unknown')).toBe('unknown')
  })
})

describe("the orchestrator's sentence — specific only where the vocabulary licenses it", () => {
  const speaks: TerminalCause[] = [
    'round-budget-exhausted',
    'review-advisory-only',
    'round-lost-work',
    'round-lost-no-diff',
  ]

  test('every member is handled — the switch is total over the vocabulary', () => {
    // Exhaustiveness is a TYPE property at the switch; this is the RUNTIME half, so a
    // member added to the array without a case cannot reach a caller as `undefined`.
    for (const c of TERMINAL_CAUSES) {
      const out = terminalCauseReason(c, 3, 10)
      expect(out === null || typeof out === 'string').toBe(true)
    }
  })

  test('the four exits that emitted nothing before this card now each say something DIFFERENT', () => {
    // The whole point, stated as the property the old code failed: four distinct exits,
    // four distinct sentences. Not four wordings of one sentence — a set, sized.
    const said = speaks.map((c) => terminalCauseReason(c, 10, 10))
    expect(said.every((x) => typeof x === 'string' && x.length > 0)).toBe(true)
    expect(new Set(said).size).toBe(speaks.length)
  })

  test('the other eleven members say nothing, so the caller keeps its generic sentence', () => {
    const silent = TERMINAL_CAUSES.filter((c) => !speaks.includes(c))
    expect(silent.length).toBe(11)
    for (const c of silent) expect(terminalCauseReason(c, 3, 10)).toBeNull()
  })

  test('the round and the ceiling are the ones passed, never a template', () => {
    expect(terminalCauseReason('round-budget-exhausted', 4, 7)).toContain('round 4 of 7')
    expect(terminalCauseReason('round-lost-work', 2, 10)).toContain('round 2 of 10')
  })

  /**
   * WORD CHOICE IS THE FEATURE, and this is the test that makes it one.
   *
   * A row can carry one of these sentences and still be unreadable STRUCTURALLY — an
   * unharvested row, a force-terminated one, a row whose result did not parse. Such a
   * row reaches `interpretFailure`'s keyword branches with the sentence and nothing
   * else, and those branches are bare `includes()` over tokens like `exhausted`,
   * `stalled`, `git `, `conflict` and `provenance`. So the property is not "the sentence
   * reads well"; it is "the sentence cannot be mistaken for a different failure".
   *
   * The honest destination for an unclassifiable authored reason is the verbatim
   * fallback, which also enforces the 200-character clamp — so this one assertion covers
   * length and vocabulary at once.
   */
  test('with NO structured cause, every sentence degrades to honest verbatim — never a wrong class', () => {
    // ACROSS EVERY ROW STATE WHERE THE SENTENCE IS WHAT DECIDES, which is the part a
    // single fixture misses. `interpretFailure` gives the recorded verdict precedence
    // over prose, so on a `reviewed-rejected` row the sentence is not consulted at all
    // and testing there would prove nothing about the words. The three states below are
    // the ones where it IS consulted — and `not-terminal` in particular is the shape a
    // crashed or force-terminated build leaves behind, where the reason is all a reader
    // has and where the `exhausted` token is live.
    const states: Array<[string, Record<string, unknown>]> = [
      ['not-terminal', { phase: 'running' }],
      ['died-before-build', { phase: 'failed', inner_verdict: 'REVIEW_NOT_RUN', inner_checkpoint: null }],
      ['built-never-reviewed', { phase: 'failed', inner_verdict: 'REVIEW_NOT_RUN', inner_checkpoint: 'forge-done' }],
    ]
    for (const c of speaks) {
      const reason = terminalCauseReason(c, 10, 10)!
      for (const [state, over] of states) {
        const out = interpretFailure(run({ failure_reason: reason, ...over }))
        expect({ c, state, klass: out.klass, summary: out.summary }).toEqual({
          c,
          state,
          klass: 'unknown',
          summary: reason,
        })
      }
    }
  })

  test('POSITIVE CONTROL — the same check catches a sentence that DOES carry a routing token', () => {
    // Proof the assertion above can fail. Each of these is a plausible rewording of one
    // of the four sentences, and each one is delivered as a failure that did not happen.
    const misroutes = [
      ['a fix round left the git tree unchanged, so there was nothing to re-judge', 'merge-mechanics'],
      ['the review panel stalled and raised nothing actionable', 'hang'],
      ['a fix round is missing from the branch, so the code was not re-judged', 'infra'],
    ] as const
    for (const [sentence, klass] of misroutes) {
      expect({ sentence, klass: interpretFailure(run({ failure_reason: sentence })).klass }).toEqual({
        sentence,
        klass,
      })
    }
    // AND THE 'exhausted' TOKEN, which is the one this card's history is about. It only
    // misroutes on a row the disposition classifier cannot judge (`not-terminal` — no
    // terminal phase recorded), which is precisely the row a crashed or force-terminated
    // build leaves behind, and precisely the row whose reason is all a reader has.
    expect(
      interpretFailure(run({ phase: 'running', failure_reason: 'the fix loop exhausted its rounds' })).klass,
    ).toBe('review-unresolved')
  })
})

describe('deriveTerminalCause — the same staleness gate as the infra block', () => {
  test('a harvested, terminally-failed row answers with the measured kind', () => {
    expect(deriveTerminalCause(harvested({ terminalCauseKind: 'round-lost-work' }))).toBe('round-lost-work')
  })

  test('an UNHARVESTED row answers nothing, however parseable its result', () => {
    // THE STALE-RESULT HAZARD, verbatim from `deriveInfraBlock`: a force-terminated or
    // cancelled row keeps an `inner_result` from an EARLIER iteration, and `harvested_at`
    // is the only proof the outer loop decided on this one. A cause read off a stale
    // result would name an ending that is not this run's.
    expect(
      deriveTerminalCause(harvested({ terminalCauseKind: 'round-lost-work' }, { harvested_at: null })),
    ).toBeNull()
  })

  test('a row that is not terminally failed answers nothing', () => {
    for (const phase of ['running', 'done', 'stopped']) {
      expect(deriveTerminalCause(harvested({ terminalCauseKind: 'round-lost-work' }, { phase }))).toBeNull()
    }
  })

  test('a garbled or absent kind answers null, and is never read as a determinate cause', () => {
    expect(deriveTerminalCause(harvested({ terminalCauseKind: 'made-up' }))).toBeNull()
    expect(deriveTerminalCause(harvested({ verdict: 'REQUEST_CHANGES' }))).toBeNull()
    expect(deriveTerminalCause(run({ inner_result: '{bad json', harvested_at: 1 }))).toBeNull()
  })

  test("…but 'unknown' is returned as itself — it is an answer, not a silence", () => {
    expect(deriveTerminalCause(harvested({ terminalCauseKind: 'unknown' }))).toBe('unknown')
  })
})

describe("innerTerminalFailureReason — it reports the MEASURED kind, and the generic sentence otherwise", () => {
  const result = (over: Record<string, unknown> = {}) => ({
    ok: true,
    verdict: 'REQUEST_CHANGES' as const,
    round: 10,
    checkpoint: 'argus-request-changes',
    block_kind: 'code' as const,
    terminal_cause: null,
    findings_present: true,
    ...over,
  })

  /**
   * THE ACCEPTANCE CRITERION, ASSERTED PER PATH. The card names the three review-verdict
   * block kinds specifically — `'code'`, `'round-lost'`, `'none'` — because the two
   * paths that ALREADY shipped a cause pass any test written against them, so a sweep
   * over "some terminal result" proves nothing about the three that did not.
   */
  test("'code' — the round-budget exit now names itself", () => {
    const reason = innerTerminalFailureReason(run({ round: 10 }), {
      ...result(),
      terminal_cause_kind: 'round-budget-exhausted',
    })
    expect(reason).toContain('round budget')
    expect(reason).toContain('round 10 of 10')
    expect(reason).not.toContain('without Argus APPROVE')
  })

  test("'round-lost' — BOTH kinds name themselves, and differently", () => {
    const lostWork = innerTerminalFailureReason(run({ round: 2 }), {
      ...result({ round: 2, block_kind: 'round-lost' }),
      terminal_cause_kind: 'round-lost-work',
    })
    const lostDiff = innerTerminalFailureReason(run({ round: 2 }), {
      ...result({ round: 2, block_kind: 'round-lost' }),
      terminal_cause_kind: 'round-lost-no-diff',
    })
    expect(lostWork).toContain('never reached the branch')
    expect(lostDiff).toContain('unchanged')
    expect(lostWork).not.toBe(lostDiff)
    for (const r of [lostWork, lostDiff]) expect(r).not.toContain('without Argus APPROVE')
  })

  test("'none' — an APPROVE exit reaching a FAILURE reason still claims nothing", () => {
    // A row that approved and then failed downstream (at the merge, at the publish) did
    // not fail BECAUSE it approved. Naming the exit as the failure would be the
    // inference this whole module refuses, so `'review-approved'` licenses no sentence
    // and the caller keeps the one it had.
    const reason = innerTerminalFailureReason(run({ round: 3 }), {
      ...result({ round: 3, verdict: 'APPROVE', block_kind: 'none' }),
      terminal_cause_kind: 'review-approved',
    })
    expect(reason).toBe("inner workflow ended at round 3 of 10 at checkpoint 'argus-request-changes' without Argus APPROVE")
  })

  test('the advisory-only exit names itself too', () => {
    const reason = innerTerminalFailureReason(run({ round: 1 }), {
      ...result({ round: 1, block_kind: 'advisory-only' }),
      terminal_cause_kind: 'review-advisory-only',
    })
    expect(reason).toContain('nothing actionable')
  })

  test('the four now-speaking exits produce four DISTINCT sentences', () => {
    const kinds: TerminalCause[] = [
      'round-budget-exhausted',
      'review-advisory-only',
      'round-lost-work',
      'round-lost-no-diff',
    ]
    const said = kinds.map((k) => innerTerminalFailureReason(run({ round: 10 }), { ...result(), terminal_cause_kind: k }))
    expect(new Set(said).size).toBe(kinds.length)
    // …and NONE of them claims the review panel refused the work.
    for (const s of said) expect(s).not.toContain('without Argus APPROVE')
  })

  /**
   * THE ACCEPTANCE CRITERION THE CARD SPELLS OUT: a run that never reached a review
   * round must not say it exhausted rounds. Asserted WITH a measured kind present, since
   * that is the new input — the pre-#520 shapes are pinned in
   * `terminal-failure-reason.test.ts` and must not move.
   */
  test('an inner-error at round 1 says nothing about rounds running out', () => {
    const reason = innerTerminalFailureReason(run({ round: 1, inner_checkpoint: 'inner-error' }), {
      ok: false,
      verdict: null,
      round: 1,
      checkpoint: 'inner-error',
      block_kind: null,
      terminal_cause: 'CODEX_HOME could not be resolved',
      terminal_cause_kind: 'workflow-threw',
      findings_present: false,
    })
    expect(reason).not.toContain('exhausted')
    expect(reason).not.toContain('round budget')
    expect(reason).not.toMatch(/\b10 round/)
    expect(reason).toContain('round 1 of 10')
    expect(reason).toContain('CODEX_HOME could not be resolved')
  })

  test('MUTATION — with the kind removed, all four collapse back to ONE sentence', () => {
    // The defect, reproduced by deleting exactly the input this card adds. Four exits,
    // one sentence: the shape the spec item measured on four runs in one night.
    const kinds: TerminalCause[] = [
      'round-budget-exhausted',
      'review-advisory-only',
      'round-lost-work',
      'round-lost-no-diff',
    ]
    const withKind = kinds.map((k) => innerTerminalFailureReason(run({ round: 10 }), { ...result(), terminal_cause_kind: k }))
    const without = kinds.map(() => innerTerminalFailureReason(run({ round: 10 }), result()))
    expect(new Set(withKind).size).toBe(4)
    expect(new Set(without).size).toBe(1)
  })

  test('a legacy row — no kind at all — is byte-identical to what it said before', () => {
    // The fail-closed promise, spelled as an equality rather than a hope: the field's
    // absence must buy NOTHING. `undefined` (a caller that predates the field) and
    // `null` (a row that carried no recognisable one) are the same silence here.
    const generic = innerTerminalFailureReason(run({ round: 10 }), result())
    expect(innerTerminalFailureReason(run({ round: 10 }), { ...result(), terminal_cause_kind: null })).toBe(generic)
    expect(generic).toBe("inner workflow ended at round 10 of 10 at checkpoint 'argus-request-changes' without Argus APPROVE")
  })

  test("a kind of 'unknown' also keeps the generic sentence — it buys silence, by design", () => {
    const generic = innerTerminalFailureReason(run({ round: 10 }), result())
    expect(innerTerminalFailureReason(run({ round: 10 }), { ...result(), terminal_cause_kind: 'unknown' })).toBe(generic)
  })

  test('a MEASURED PROSE cause still outranks the kind — the branch above keeps precedence', () => {
    // The infra-only and thrown sentences are already specific and already tested; a
    // second sentence for the same exit would be a second owner for one fact.
    const reason = innerTerminalFailureReason(run({ round: 2 }), {
      ...result({ round: 2, block_kind: 'infra-only', terminal_cause: 'gh auth login' }),
      terminal_cause_kind: 'review-infra-only',
    })
    expect(reason).toBe('review never ran (infra-only) at round 2 of 10: gh auth login')
  })
})

/**
 * THE OWNER'S ANNOUNCE — the half the card says is "not built", and the verification it
 * names: `rg -n "terminal_cause|terminalCause" trident/delivery.ts` found nothing.
 *
 * WHAT WAS WRONG. One sentence — "The build ended without an approved review, so I did
 * not merge it." — served a fix round whose work vanished, a fix round that changed
 * nothing, a panel that ran and raised only advisory findings, and a genuine round-budget
 * exhaustion. Four different next actions behind one line of copy, which is the same
 * defect as the orchestrator's, one layer out.
 *
 * WHAT IS ASSERTED. Not the wording — that a reviewer may rewrite. The PROPERTIES: the
 * four are distinguishable; each says the thing its own class must never get wrong; the
 * structured route and the string route it duplicates return the SAME object; and every
 * silence this change introduces leaves the previous behaviour byte-identical.
 */
describe('interpretFailure — a specific summary per measured cause (#520)', () => {
  /** A row whose inner result is harvested and whose verdict was NOT a real rejection. */
  const row = (kind: string, over: Record<string, unknown> = {}) =>
    harvested(
      { verdict: 'REQUEST_CHANGES', blockKind: 'code', terminalCauseKind: kind },
      { inner_verdict: 'REVIEW_NOT_RUN', failure_reason: 'inner workflow ended at round 10 of 10', ...over },
    )

  test('the four exits that shared ONE sentence now have four', () => {
    const kinds = ['round-lost-work', 'round-lost-no-diff', 'review-advisory-only', 'round-budget-exhausted']
    const summaries = kinds.map((k) => interpretFailure(row(k)).summary)
    expect(new Set(summaries).size).toBe(kinds.length)
  })

  test('MUTATION — with the measured cause taken away, all four collapse back to one', () => {
    // The identical rows with the one new field removed. This is the assertion that the
    // branch is load-bearing: not that four summaries exist, but that they exist BECAUSE
    // of the cause and cannot be produced without it.
    const kinds = ['round-lost-work', 'round-lost-no-diff', 'review-advisory-only', 'round-budget-exhausted']
    const without = kinds.map(
      () =>
        interpretFailure(
          harvested(
            { verdict: 'REQUEST_CHANGES', blockKind: 'code' },
            { inner_verdict: 'REVIEW_NOT_RUN', failure_reason: 'inner workflow ended at round 10 of 10' },
          ),
        ).summary,
    )
    expect(new Set(without).size).toBe(1)
    expect(without[0]).toBe('The build ended without an approved review, so I did not merge it.')
  })

  test("a lost round is told as a lost round — and never as a rejection of the work", () => {
    const work = interpretFailure(row('round-lost-work'))
    const diff = interpretFailure(row('round-lost-no-diff'))
    for (const out of [work, diff]) {
      expect(out.klass).toBe('round-lost')
      // The ONE thing this class must never say: that something was rejected.
      expect(out.summary.toLowerCase()).not.toContain('reviewer')
      expect(out.summary.toLowerCase()).toContain('nothing about')
    }
    expect(work.summary).not.toBe(diff.summary)
    // The two recoveries differ, so the ADVICE differs — which is the whole reason the
    // workflow keeps them apart rather than calling both 'round-lost'.
    expect(work.input_needed).not.toBe(diff.input_needed)
    expect(work.input_needed).toContain('rebuilt')
  })

  /**
   * THE OVER-STRICT DIRECTION, which a sweep would not exercise. `advisory-only` means a
   * panel RAN and found nothing blocking, and `recordedTerminalVerdict` records that as a
   * real `REQUEST_CHANGES` — so the row reaches the review branch and is told the
   * reviewer "still had blocking findings", which is the single thing an advisory-only
   * exit establishes did not happen. A measured cause outranks prose when it CONTRADICTS
   * it; this is that case, and the assertion is on the false half, not the true one.
   */
  test('an advisory-only exit is never told as blocking findings, even on a recorded rejection', () => {
    const rejected = row('review-advisory-only', { inner_verdict: 'REQUEST_CHANGES' })
    const out = interpretFailure(rejected)
    // The FALSE CLAIM, named exactly: the review branch's sentence, which this row would
    // otherwise receive. Asserted against that sentence rather than the bare word
    // 'blocking', which this arm uses correctly in a negation of its own.
    expect(out.summary).not.toContain('still had blocking findings')
    expect(out.summary).toContain('advisory rather than blocking')
    expect(out.klass).toBe('review-unresolved')
    // …and the row really does take the review branch without the cause, which is what
    // makes this a contradiction rather than a preference.
    expect(
      interpretFailure(
        harvested(
          { verdict: 'REQUEST_CHANGES', blockKind: 'advisory-only' },
          { inner_verdict: 'REQUEST_CHANGES', failure_reason: 'inner workflow ended at round 10 of 10' },
        ),
      ).summary,
    ).toContain('still had blocking findings')
  })

  /**
   * AND THE PERMISSIVE DIRECTION, which is the same rule pointing the other way. A
   * budget that ran out does NOT contradict a recorded rejection — both are true of a
   * genuine ten-round exhaustion — so here the recorded verdict keeps precedence and the
   * richer story survives. A cause branch that won unconditionally would have deleted it.
   */
  test('a round-budget exit stands aside when a reviewer really did speak', () => {
    const rejected = row('round-budget-exhausted', { inner_verdict: 'REQUEST_CHANGES' })
    const out = interpretFailure(rejected)
    expect(out.klass).toBe('review-unresolved')
    expect(out.summary).toContain('blocking findings')
  })

  test('…and speaks on the same exit when no reviewer is on record', () => {
    const out = interpretFailure(row('round-budget-exhausted'))
    expect(out.klass).toBe('unknown')
    expect(out.summary).toContain('used up its rounds')
  })

  /**
   * THE TWO HALVES MOVE TOGETHER, ASSERTED AS AN EQUALITY RATHER THAN A COMMENT.
   *
   * The `reached max_rounds` branch and the structured `round-budget-exhausted` arm
   * describe the SAME run reached by two routes — a string the state machine happens to
   * write, and a kind the workflow measured. If they can say different things, the owner
   * is told a different story depending on which route fired, which is the class of
   * defect this file exists to close. So they are compared, not maintained in parallel.
   */
  test('the structured budget route says exactly what the string budget route says', () => {
    const byString = interpretFailure(run({ failure_reason: 'reached max_rounds (10) without Argus APPROVE' }))
    const byCause = interpretFailure(row('round-budget-exhausted'))
    // The WHOLE object, advice included — a summary that matches beside advice that does
    // not is still two stories, and the advice is the half the owner acts on.
    expect(byCause).toEqual(byString)
  })

  test('the structured infra-death route IS the string infra-death route, object for object', () => {
    const byString = interpretFailure(run({ failure_reason: 'inner workflow failed at round 1 of 10: boom' }))
    const byCause = interpretFailure(row('workflow-threw', { failure_reason: 'something nobody classified' }))
    expect(byCause).toEqual(byString)
  })

  test("'unknown' buys silence — the row reads exactly as it did before this card", () => {
    const before = interpretFailure(
      harvested(
        { verdict: 'REQUEST_CHANGES', blockKind: 'code' },
        { inner_verdict: 'REVIEW_NOT_RUN', failure_reason: 'inner workflow ended at round 10 of 10' },
      ),
    )
    expect(interpretFailure(row('unknown'))).toEqual(before)
  })

  test('a success or handoff exit on a failed row defers to the reason that death wrote', () => {
    // These are not failures. The row failed DOWNSTREAM of the exit — at the merge, at
    // the publish — of something this cause did not measure, and the branches that read
    // the reason are the ones that know. Naming the exit as the failure would be a
    // confident sentence about an unmeasured cause.
    for (const kind of ['review-approved', 'pr-already-merged', 'resume-approved-unchanged', 'wave-member-built', 'handoff-publish', 'ralph-task-built']) {
      const out = interpretFailure(row(kind, { failure_reason: 'merge failed: git push rejected' }))
      expect({ kind, klass: out.klass }).toEqual({ kind, klass: 'merge-mechanics' })
    }
  })

  /**
   * THE ORDERING, ASSERTED — a death from OUTSIDE the workflow outranks the workflow's
   * own account of how it meant to end.
   *
   * A build whose launcher a deploy killed mid-flight never wrote a terminal result for
   * that ending, so the `inner_result` such a row carries belongs to an EARLIER iteration
   * — the exact stale-result hazard `deriveInfraBlock`'s gate is written against, and one
   * `harvested_at` cannot always catch because a re-fired run harvests each iteration.
   * The deploy marker (#642) is evidence about the death itself; the cause is evidence
   * about an exit that was not this one. The marker wins.
   */
  test('a deploy that killed the build outranks a harvested cause from an earlier iteration', () => {
    const killed = row('round-lost-work', {
      failure_reason:
        'inner workflow killed by a gateway restart or deploy of this instance, not by a fault: pooled child exited (launcher generation abcd1234; observed by the child-crash-sink at 2026-09-12T00:00:00.000Z)',
    })
    const out = interpretFailure(killed)
    expect(out.klass).toBe('deploy-restart')
    expect(out.summary).toContain('killed by a deploy')
  })

  test('…and so does a launcher death nobody established', () => {
    const gone = row('round-lost-work', {
      failure_reason:
        'inner workflow launcher is gone, cause NOT established: pid 4242 is not running (generation abcd1234, at 2026-09-12T00:00:00.000Z)',
    })
    expect(interpretFailure(gone).klass).toBe('unknown')
    expect(interpretFailure(gone).summary).toContain('could not establish why')
  })

  test('an UNHARVESTED row reads exactly as it did before, however good its cause looks', () => {
    // Same stale-result gate as `deriveInfraBlock`. A cause read off a result the outer
    // loop never decided on names an ending that is not this run's.
    const stale = row('round-lost-work', { harvested_at: null })
    expect(interpretFailure(stale).summary).toBe('The build ended without an approved review, so I did not merge it.')
  })
})
