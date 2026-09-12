/**
 * `inner-workflow.mjs` — STOP AND ESCALATE instead of iterating on a bad plan.
 *
 * The item: `docs/spec-items/the-review-loop-must-stop-and-re-plan.md`. Run `36b95167`
 * burned ten rounds and ~2.5 h to reach a verdict knowable at round 2, because three
 * constraints compose into a trap: the verdict enum is effectively binary, Forge is a
 * PURE EXECUTOR forbidden to re-plan, and the planner runs ONCE outside the fix loop and
 * never hears a reviewer. The recorded evidence is three findings recurring in ALL NINE
 * review rounds with totals that never converged (9, 8, 13, 9, 8, 12, 9, 10, 11).
 *
 * WHAT THESE TESTS ARE CAREFUL ABOUT, because both failures have been shipped on this
 * repo recently:
 *
 *  1. NOTHING IN THE ARRANGEMENT MAY DO THE ESCALATING. Every function under test is
 *     sliced out of the SHIPPED `inner-workflow.mjs` (`loadEscalationGate`) and
 *     evaluated; no fixture implements a rule, and no expectation is compared against a
 *     value that merely happens to equal it here. Revert the gate and these go red —
 *     which is the only thing that makes them measurements.
 *  2. `false`, `threw` and `succeeded-with-impossible-output` ARE ALL UNKNOWN, and none
 *     may share a branch with a definite answer. A finding with no key is not a NEW
 *     finding; an unreadable finding list is not an EMPTY one; an uncountable round is
 *     not a round with ZERO blockers. Each of those has its own test, because each of
 *     them is a silent way for a gate to stop gating.
 */

import { describe, expect, test } from 'bun:test'
import {
  type GateFinding,
  loadEscalationGate,
  WORKFLOW_SRC,
} from '../testing/load-escalation-gate.ts'

/** A finding in the shape `VERDICT_SCHEMA` asks for. */
const f = (key: string, severity = 'blocker'): GateFinding => ({
  severity,
  title: 'a title that is free text and must never be the identity',
  evidence: 'file.ts:10',
  key,
})

/**
 * THE RECORDED SHAPE OF RUN 36b95167 — three findings that recur in every round.
 * Titles are the item's own words for them.
 */
const RECURRING: GateFinding[] = [
  { severity: 'blocker', title: 'row/rail lockstep test is tautological', evidence: 'a.ts:1', key: 'app/rail.ts:rowRailLockstep:tautological-test' },
  { severity: 'blocker', title: 'inline_active used as an out-of-spec proxy', evidence: 'b.ts:2', key: 'work-board/store.ts:inlineActive:out-of-spec-proxy' },
  { severity: 'major', title: 'the research/dispatch path is untouched', evidence: 'c.ts:3', key: 'agent-dispatch/start.ts:research:untouched-path' },
]

/** The item's recorded blocker+major totals for the nine rounds of `36b95167`. */
const RECORDED_BLOCKING_COUNTS = [4, 2, 6, 4, 2, 4, 4, 4, 5]

describe('finding identity — the prerequisite, and it is a KEY, never a title', () => {
  test('the extraction MATCHED — every assertion below is vacuous otherwise', () => {
    // Asserted first and alone. A `loadEscalationGate` that silently returned an object
    // of undefineds would make every test below pass against nothing.
    const gate = loadEscalationGate()
    for (const name of [
      'findingIdentity',
      'roundIdentity',
      'repeatVerdict',
      'blockingFindingCount',
      'progressVerdict',
      'validateEscalationClaim',
      'decideEscalation',
      'eligibleFixFindings',
    ] as const) {
      expect(typeof gate[name]).toBe('function')
    }
  })

  test('a reviewer-emitted `file:symbol:rule` key IS the identity, normalised', () => {
    const { findingIdentity } = loadEscalationGate()
    expect(findingIdentity(f('Trident/Inner-Loop.ts:parseInnerResult:Tautological-Test'))).toBe(
      'trident/inner-loop.ts:parseinnerresult:tautological-test',
    )
    // A leading './' and surrounding whitespace are spellings, not differences.
    expect(findingIdentity(f('  ./a/b.ts:sym:rule  '))).toBe(findingIdentity(f('a/b.ts:sym:rule')))
  })

  test('LINE NUMBERS are dropped — a fix round moves lines without fixing the defect', () => {
    const { findingIdentity } = loadEscalationGate()
    // This is the concrete way a repeat gate stops detecting repeats: round 1 reports the
    // finding at line 12, the fix round shifts the file, and round 2 reports line 40.
    expect(findingIdentity(f('a/b.ts:12:sym:rule'))).toBe(findingIdentity(f('a/b.ts:40:sym:rule')))
    expect(findingIdentity(f('a/b.ts:12-18:sym:rule'))).toBe(findingIdentity(f('a/b.ts:sym:rule')))
  })

  test('IDENTITY IS NOT THE TITLE — the same words are NOT the same finding', () => {
    const { findingIdentity } = loadEscalationGate()
    // The spec item rules the title out explicitly: "with free-text titles 'same finding'
    // is not machine-decidable, so a repeat-finding gate built on titles does not satisfy
    // this". Two findings with IDENTICAL titles and no keys are UNDECIDABLE, not equal…
    const sameTitleNoKey = { severity: 'blocker', title: 'identical prose', evidence: 'x:1' }
    expect(findingIdentity(sameTitleNoKey)).toBe('')
    // …and two findings with DIFFERENT titles but one key are the SAME finding, which is
    // the half a title matcher gets wrong in the expensive direction.
    expect(findingIdentity({ ...f('a:b:c'), title: 'worded one way' })).toBe(
      findingIdentity({ ...f('a:b:c'), title: 'worded completely differently' }),
    )
  })

  test("an unreadable identity is '' — UNKNOWN, and never a fresh identity", () => {
    const { findingIdentity } = loadEscalationGate()
    // Each of these is a DIFFERENT way of not knowing. If any returned a distinct
    // non-empty string, two unkeyed findings would read as two different findings and the
    // repeat gate would report "no repeat" for a round it never understood.
    for (const bad of [null, undefined, 'a string', 42, [], { key: 42 }, f(''), f('bare'), f('a:b')]) {
      expect(findingIdentity(bad)).toBe('')
    }
  })
})

describe('one round of identities — an unreadable list is not an empty one', () => {
  test('keys are de-duplicated and unkeyed findings are COUNTED, not dropped', () => {
    const { roundIdentity } = loadEscalationGate()
    const r = roundIdentity([f('a:b:c'), f('a:b:c'), { severity: 'blocker', title: 't' }])
    expect(r.readable).toBe(true)
    expect(r.keys).toEqual(['a:b:c'])
    // The unkeyed one is not silently discarded: it is what makes a later "no repeat"
    // answer UNDECIDABLE rather than definite.
    expect(r.unknown).toBe(1)
  })

  test('a NON-ARRAY is `readable: false` — the third answer, distinct from no findings', () => {
    const { roundIdentity } = loadEscalationGate()
    const unreadable = roundIdentity('oops')
    const empty = roundIdentity([])
    expect(unreadable.readable).toBe(false)
    expect(empty.readable).toBe(true)
    // Both have no keys, and that is exactly why `readable` has to exist: without it the
    // two are indistinguishable, and "the synthesis came back garbled" would be recorded
    // as "the panel found nothing".
    expect(unreadable.keys).toEqual([])
    expect(empty.keys).toEqual([])
  })
})

describe('the REPEAT gate — arithmetic, and three-valued', () => {
  test("HEADLINE: on run 36b95167's recorded findings it fires, and names what repeated", () => {
    const { repeatVerdict } = loadEscalationGate()
    const v = repeatVerdict(RECURRING, RECURRING)
    expect(v.outcome).toBe('repeat')
    expect(v.repeated.length).toBe(3)
    // The item's own three findings, by the identity the gate reads.
    expect(v.repeated.sort()).toEqual([
      'agent-dispatch/start.ts:research:untouched-path',
      'app/rail.ts:rowraillockstep:tautological-test',
      'work-board/store.ts:inlineactive:out-of-spec-proxy',
    ])
  })

  test('a round that fixed everything and found different things is a definite NONE', () => {
    const { repeatVerdict } = loadEscalationGate()
    expect(repeatVerdict([f('a:b:c')], [f('x:y:z')]).outcome).toBe('none')
  })

  test('UNDECIDABLE never collapses into NONE — an unkeyed finding is not a new one', () => {
    const { repeatVerdict } = loadEscalationGate()
    // No key in either round: nothing repeated among the keys we could read, and we could
    // read none. Answering 'none' here is what would make the gate silently stop gating.
    const unkeyed = repeatVerdict([{ severity: 'blocker' }], [{ severity: 'blocker' }])
    expect(unkeyed.outcome).toBe('undecidable')
    expect(unkeyed.reason).not.toBe('')
    // One keyed + one unkeyed, no overlap: still undecidable, because the unkeyed one
    // might have been the repeat.
    expect(repeatVerdict([f('a:b:c')], [f('x:y:z'), { severity: 'blocker' }]).outcome).toBe('undecidable')
    // An unreadable list is its own undecidable.
    expect(repeatVerdict('garbled', [f('a:b:c')]).outcome).toBe('undecidable')
    expect(repeatVerdict(null, [f('a:b:c')]).outcome).toBe('undecidable')
  })

  test('a REPEAT still wins over unknowns — one proven survivor is proof', () => {
    const { repeatVerdict } = loadEscalationGate()
    // The unknowns make "no repeat" undecidable; they do not make a PROVEN repeat
    // undecidable. Fixing demonstrably failed on `a:b:c`, whatever the rest were.
    const v = repeatVerdict([f('a:b:c'), { severity: 'blocker' }], [f('a:b:c'), { severity: 'blocker' }])
    expect(v.outcome).toBe('repeat')
    expect(v.repeated).toEqual(['a:b:c'])
  })
})

describe('the NO-PROGRESS gate — identity-free, which is its only virtue', () => {
  test('HEADLINE: on the recorded counts of run 36b95167 it fires at ROUND 3', () => {
    const { progressVerdict } = loadEscalationGate()
    // 4 → 2 is progress; 2 → 6 is not. Walk the recorded series and find the first round
    // whose prefix fires. The item names round 3, so a gate that fired at 2 (or not until
    // 4) is a different gate from the one that was specified.
    let firstFiring = 0
    for (let n = 2; n <= RECORDED_BLOCKING_COUNTS.length; n += 1) {
      if (progressVerdict(RECORDED_BLOCKING_COUNTS.slice(0, n)) === 'no-progress') {
        firstFiring = n
        break
      }
    }
    expect(firstFiring).toBe(3)
  })

  test('strictly decreasing is progress; equal is NOT', () => {
    const { progressVerdict } = loadEscalationGate()
    expect(progressVerdict([4, 3])).toBe('progress')
    // "not strictly decreasing" is the item's wording, and the equal case is the one a
    // `<=` would quietly let through — a run stuck at four blockers forever.
    expect(progressVerdict([4, 4])).toBe('no-progress')
    expect(progressVerdict([2, 6])).toBe('no-progress')
  })

  test('fewer than two readable rounds is UNDECIDABLE, never progress', () => {
    const { progressVerdict } = loadEscalationGate()
    expect(progressVerdict([4])).toBe('undecidable')
    expect(progressVerdict([])).toBe('undecidable')
    expect(progressVerdict('nope')).toBe('undecidable')
    // A round whose findings could not be counted arrives as `null` (see
    // `blockingFindingCount`) and must not be read as a round with zero blockers — which
    // is the BEST possible count and would report perfect convergence.
    expect(progressVerdict([4, null])).toBe('undecidable')
  })

  test('the count is null for an unreadable list — UNKNOWN, never the best answer', () => {
    const { blockingFindingCount } = loadEscalationGate()
    expect(blockingFindingCount('oops')).toBeNull()
    expect(blockingFindingCount(null)).toBeNull()
    expect(blockingFindingCount([])).toBe(0)
    expect(blockingFindingCount([f('a:b:c'), f('d:e:f', 'major'), f('g:h:i', 'nit'), f('j:k:l', 'minor')])).toBe(2)
  })
})

describe('the SELF-DECLARED escalation — it must cost something to pull', () => {
  test('a kind with a concrete `whatIsMissing` is accepted, trimmed and clamped', () => {
    const { validateEscalationClaim } = loadEscalationGate()
    const ok = validateEscalationClaim({ kind: 'missing-dependency', whatIsMissing: '  the dispatch-holds card must land first  ' })
    expect(ok.ok).toBe(true)
    expect(ok.kind).toBe('missing-dependency')
    expect(ok.whatIsMissing).toBe('the dispatch-holds card must land first')
    expect(validateEscalationClaim({ kind: 'design-gap', whatIsMissing: 'x'.repeat(5000) }).whatIsMissing.length).toBe(500)
  })

  test('HEADLINE: an escalation with NO `whatIsMissing` is REFUSED — both kinds', () => {
    const { validateEscalationClaim } = loadEscalationGate()
    // The item requires this of BOTH kinds: "each REQUIRING a `whatIsMissing` field so it
    // cannot be a bare complaint. Assert an escalation without it is refused."
    for (const kind of ['design-gap', 'missing-dependency']) {
      for (const missing of [undefined, null, '', '   ', 42, {}]) {
        const v = validateEscalationClaim({ kind, whatIsMissing: missing })
        expect(v.ok).toBe(false)
        expect(v.kind).toBe('')
        expect(v.refusedBecause).toContain('whatIsMissing')
      }
    }
  })

  test('an unrecognised kind is refused, and the refusal never quotes the model back', () => {
    const { validateEscalationClaim } = loadEscalationGate()
    const v = validateEscalationClaim({ kind: 'not-converging', whatIsMissing: 'the arithmetic kind is not declarable' })
    // 'not-converging' is what the ARITHMETIC reports. A reviewer that could declare it
    // would be asserting the numbers, which is the one claim no agent gets to make.
    expect(v.ok).toBe(false)
    // The claim is attacker-shaped text; the refusal names the RULE, not the value.
    expect(v.refusedBecause).not.toContain('the arithmetic kind is not declarable')
    for (const bad of [null, undefined, 'design-gap', ['design-gap'], { kind: 42, whatIsMissing: 'x' }]) {
      expect(validateEscalationClaim(bad).ok).toBe(false)
    }
  })
})

describe('the DECISION — what the fix loop does with all of it', () => {
  const state = (over: Record<string, unknown>) => ({
    round: 2,
    previousFindings: [f('a:b:c')],
    currentFindings: [f('a:b:c')],
    blockingCounts: [1, 1],
    claim: null,
    replansUsed: 0,
    ...over,
  })

  test('HEADLINE: the arithmetic fires WITH THE SELF-DECLARATION SUPPRESSED', () => {
    const { decideEscalation } = loadEscalationGate()
    // The item's third acceptance criterion, literally: "assert the arithmetic gate fires
    // with the self-declaration suppressed". `claim: null` is that suppression — no agent
    // said anything, and the run stops anyway.
    const d = decideEscalation(state({ claim: null }))
    expect(d.action).toBe('stop')
    expect(d.triggers).toContain('repeat-finding')
    expect(d.kind).toBe('not-converging')
    expect(d.whatIsMissing).not.toBe('')
    expect(d.evidence).toContain('a:b:c')
  })

  test('the ARITHMETIC KIND never borrows a declared name', () => {
    const { decideEscalation } = loadEscalationGate()
    // The numbers prove that fixing is not working and say NOTHING about why. Reporting
    // 'design-gap' off them would assert a cause nobody measured — the failure mode this
    // whole file exists to remove, reintroduced by the fix for it.
    const d = decideEscalation(state({ claim: null }))
    expect(d.kind).not.toBe('design-gap')
    expect(d.kind).not.toBe('missing-dependency')
  })

  test('a REFUSED declaration does not suppress the arithmetic, and is reported', () => {
    const { decideEscalation } = loadEscalationGate()
    const d = decideEscalation(state({ claim: { kind: 'design-gap' } }))
    expect(d.refusedClaim).toContain('whatIsMissing')
    // The bare complaint bought nothing — no re-plan — and the numbers still stopped it.
    expect(d.action).toBe('stop')
    expect(d.kind).toBe('not-converging')
    expect(d.triggers).not.toContain('design-gap')
  })

  test('a refused declaration on a CONVERGING run changes nothing — the loop continues', () => {
    const { decideEscalation } = loadEscalationGate()
    const d = decideEscalation(
      state({ claim: { kind: 'design-gap', whatIsMissing: '' }, previousFindings: [f('a:b:c')], currentFindings: [f('x:y:z')], blockingCounts: [4, 1] }),
    )
    // Refusing a bare complaint must not become a way to stop a healthy run either.
    expect(d.action).toBe('continue')
    expect(d.refusedClaim).not.toBe('')
    expect(d.triggers).toEqual([])
  })

  test('HEADLINE: a design-gap buys exactly ONE bounded re-plan; the second is REFUSED', () => {
    const { decideEscalation } = loadEscalationGate()
    const claim = { kind: 'design-gap', whatIsMissing: 'the execution spec itself asked for the tautological test' }
    const first = decideEscalation(state({ claim, replansUsed: 0, previousFindings: null, currentFindings: [f('a:b:c')], blockingCounts: [3], round: 1 }))
    expect(first.action).toBe('re-plan')
    expect(first.whatIsMissing).toBe(claim.whatIsMissing)
    // …and once it is spent, the SAME declaration stops the run instead of buying
    // another. Unbounded re-planning reproduces the same waste one level up as a
    // plan↔fix oscillation.
    const second = decideEscalation(state({ claim, replansUsed: 1, previousFindings: null, currentFindings: [f('a:b:c')], blockingCounts: [3], round: 3 }))
    expect(second.action).toBe('stop')
    expect(second.kind).toBe('design-gap')
    expect(second.whatIsMissing).toBe(claim.whatIsMissing)
  })

  test('a repeat finding AFTER the bounded re-plan goes to the orchestrator', () => {
    const { decideEscalation } = loadEscalationGate()
    // "The re-plan gets exactly one chance to prove it changed something."
    const d = decideEscalation(state({ claim: null, replansUsed: 1 }))
    expect(d.action).toBe('stop')
    expect(d.triggers).toContain('repeat-finding')
  })

  test('a valid missing-dependency STOPS — it is never a re-plan', () => {
    const { decideEscalation } = loadEscalationGate()
    const d = decideEscalation(
      state({
        claim: { kind: 'missing-dependency', whatIsMissing: 'the dependency-aware dispatch card must land first' },
        previousFindings: null,
        currentFindings: [f('a:b:c')],
        blockingCounts: [1],
        round: 1,
      }),
    )
    // Re-planning cannot conjure work that lives outside this card; only SEQUENCING can,
    // and sequencing is the orchestrator's call.
    expect(d.action).toBe('stop')
    expect(d.kind).toBe('missing-dependency')
    expect(d.whatIsMissing).toContain('dependency-aware dispatch')
  })

  test('a run that is CONVERGING is left alone', () => {
    const { decideEscalation } = loadEscalationGate()
    const d = decideEscalation(state({ previousFindings: [f('a:b:c'), f('d:e:f')], currentFindings: [f('x:y:z')], blockingCounts: [2, 1] }))
    expect(d.action).toBe('continue')
    expect(d.triggers).toEqual([])
    expect(d.kind).toBe('')
  })

  test('UNDECIDABLE alone never stops a run — and it is reported, not swallowed', () => {
    const { decideEscalation } = loadEscalationGate()
    // Round 1: no previous round to compare, one count. Neither gate can decide, and a
    // gate that treated "could not tell" as "stop" would terminate every run at round 1.
    const d = decideEscalation(state({ round: 1, previousFindings: null, currentFindings: [f('a:b:c')], blockingCounts: [1], claim: null }))
    expect(d.action).toBe('continue')
    expect(d.undecidable.length).toBeGreaterThan(0)
    expect(d.evidence).toContain('undecidable')
  })

  test('a totally malformed state decides NOTHING rather than throwing', () => {
    const { decideEscalation } = loadEscalationGate()
    // A decision function that throws inside the fix loop takes the whole run's catch
    // path — reported as an infrastructure death, about a run whose panel was healthy.
    for (const bad of [undefined, null, {}, 'nope', 42]) {
      expect(decideEscalation(bad).action).toBe('continue')
    }
  })
})

describe('what the gate is allowed to look at — the findings the FIX ROUND was asked to fix', () => {
  test('it is `isCodeWorkFinding`, the WHOLE predicate, and not a second copy of it', () => {
    const { eligibleFixFindings } = loadEscalationGate()
    const kept = eligibleFixFindings([
      f('a:b:c'),
      f('d:e:f', 'major'),
      f('g:h:i', 'nit'),
      f('j:k:l', 'minor'),
      { severity: 'blocker', key: 'm:n:o', kind: 'lane' },
      { severity: 'blocker', key: 'p:q:r', kind: 'suite' },
      { severity: 'blocker', key: 's:t:u', advisory: true },
    ])
    // A recurring NIT or MINOR is not a failure to converge — the loop never spent a
    // round on it (`classifyBlock` exits on a round whose findings are all non-blocking).
    // A recurring LANE blocker is a dead review seat, which is an INFRASTRUCTURE story
    // and already exits the loop under its own kind. An ADVISORY is one this file has
    // already declared non-blocking.
    //
    // A SUITE BLOCKER IS KEPT, and deliberately: `isCodeWorkFinding` counts it as code
    // work, because a required suite that is still red after a fix round is exactly
    // "fixing is not working" — the thing this gate measures. This test states which
    // side of the line each kind falls on so that a change to the shared predicate
    // shows up here rather than silently widening or narrowing what can escalate.
    expect((kept ?? []).map((x) => (x as GateFinding).key)).toEqual(['a:b:c', 'd:e:f', 'p:q:r'])
  })

  test('a non-array stays UNREADABLE rather than becoming an empty round', () => {
    const { eligibleFixFindings, repeatVerdict } = loadEscalationGate()
    expect(eligibleFixFindings('oops')).toBeNull()
    expect(eligibleFixFindings(null)).toBeNull()
    // …and that null is what makes the round undecidable downstream instead of looking
    // like a round in which everything was fixed.
    expect(repeatVerdict(eligibleFixFindings('oops'), [f('a:b:c')]).outcome).toBe('undecidable')
  })
})

describe('the WIRING — the shipped loop actually consults the gate', () => {
  // The behavioural tests above prove the gate decides correctly. These prove the loop
  // ASKS it — the half that a unit test of a pure function can never cover, and the half
  // that would leave a perfectly-tested gate switched off in production.

  test('the fix loop records EVERY completed review round and decides after the re-review', () => {
    // Two call sites: round 1 (before the loop) and the end of each fix round (after the
    // re-review, which is the only moment two rounds of findings both exist).
    const calls = WORKFLOW_SRC.match(/recordRoundForEscalation\(round, synthesis\)/g) ?? []
    expect(calls.length).toBe(2)
    // …and the fix-round one comes AFTER the assignment it reads, not before it.
    const decideAt = WORKFLOW_SRC.lastIndexOf('recordRoundForEscalation(round, synthesis)')
    const reviewAt = WORKFLOW_SRC.lastIndexOf('synthesis = withSuiteBlocker(await runReviewRound(diffFile, round, pr, null, fixSuiteFindings)')
    expect(reviewAt).toBeGreaterThan(-1)
    expect(decideAt).toBeGreaterThan(reviewAt)
  })

  test('the ledger only records a round that JUDGED THE CODE', () => {
    // An infra-only or advisory-only round says nothing about whether the PLAN is wrong.
    // Folding one in would let a dead review seat look like a finding that failed to
    // converge, and report a lane outage under a kind that asserts a design defect.
    expect(WORKFLOW_SRC).toContain("if (s === null || typeof s !== 'object' || s.blockKind !== 'code') return")
  })

  test('the RE-PLAN is handed the reviewers’ findings — the input the planner never had', () => {
    // "A `design-gap` buys exactly ONE bounded re-plan per run, WITH THE FINDINGS
    // ATTACHED." A re-plan that cannot see what the reviewers said is the same deaf
    // planner that produced the bad plan, run a second time at full price.
    const at = WORKFLOW_SRC.indexOf('function rePlanPrompt(')
    expect(at).toBeGreaterThan(-1)
    const body = WORKFLOW_SRC.slice(at, at + 4000)
    expect(body).toContain('JSON.stringify(findings)')
    expect(body).toContain('${whatIsMissing}')
    // It runs INSIDE the loop, which is the whole correction to constraint (iii).
    expect(WORKFLOW_SRC).toContain('rePlanPrompt(')
    expect(WORKFLOW_SRC).toContain("withModel({ label: 'plan:fable', phase: 'Build', schema: PLAN_SCHEMA })")
  })

  test('the re-plan may RAISE the executor model but never LOWER it', () => {
    // `modelForTag` routes 'mechanical' to Sonnet/medium and everything else to
    // Opus/high. Adopting the re-plan's tag wholesale let a re-plan DOWNGRADE the model
    // on a run that had just proved hard enough to need re-planning — silently, and on
    // the rounds whose APPROVE ships the change.
    expect(WORKFLOW_SRC).toContain("if (rePlan.complexity === 'reasoning') complexityTag = rePlan.complexity")
    // The bare assignment must be gone: it is the shape that could lower the tag.
    expect(WORKFLOW_SRC).not.toContain('\n      complexityTag = rePlan.complexity')
  })

  test('the re-plan is counted when AUTHORISED, so a second cannot be granted mid-flight', () => {
    expect(WORKFLOW_SRC).toContain('replansUsed += 1')
    expect(WORKFLOW_SRC).toContain('rePlanPending = true')
  })

  test('a re-plan that produced nothing ESCALATES — it is not a successful re-plan', () => {
    // `false`, `threw` and `succeeded-with-impossible-output` are all unknown. A planner
    // seat that returned null, or a plan with no execution spec, has not re-planned; going
    // on would send Forge in with the ORIGINAL plan while the run's one re-plan is
    // recorded as spent.
    expect(WORKFLOW_SRC).toContain("if (!rePlan || typeof rePlan.executionSpec !== 'string' || rePlan.executionSpec.trim() === '')")
  })

  test('the review schema REQUIRES a key on every finding, and offers the escalate channel', () => {
    // The prerequisite: without a reviewer-emitted identity the repeat gate is a matcher
    // over free text, which the item rules out.
    expect(WORKFLOW_SRC).toContain("required: ['severity', 'title', 'evidence', 'key'],")
    expect(WORKFLOW_SRC).toContain("required: ['kind', 'whatIsMissing'],")
    expect(WORKFLOW_SRC).toContain("enum: ['design-gap', 'missing-dependency'],")
  })

  test('the claim is read off the SEAT’s own reply, not off the merged findings', () => {
    // `gated` has this file's own CI advisories, suite blockers and lane findings merged
    // into it. A declaration that the plan is wrong is a REVIEWER's judgement or it is
    // nothing, so it is taken from `synthesisRaw` — the panel's answer before any of that.
    expect(WORKFLOW_SRC).toContain('synthesisRaw.escalate')
    expect(WORKFLOW_SRC).not.toContain('gated.escalate')
  })

  test('the terminal result reports the escalation as its OWN block kind', () => {
    expect(WORKFLOW_SRC).toContain('escalation !== null\n            ? escalation.kind')
    expect(WORKFLOW_SRC).toContain('whatIsMissing: escalation.whatIsMissing,')
    expect(WORKFLOW_SRC).toContain('triggers: escalation.triggers,')
  })
})
