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

  test('a reviewer-emitted `file:symbol:rule` key IS the identity, verbatim', () => {
    const { findingIdentity } = loadEscalationGate()
    // CASE IS CONTENT, so the key comes back exactly as written. This used to assert the
    // lower-cased form, which is what made the collision below possible.
    expect(findingIdentity(f('Trident/Inner-Loop.ts:parseInnerResult:Tautological-Test'))).toBe(
      'Trident/Inner-Loop.ts:parseInnerResult:Tautological-Test',
    )
    // A leading './' and surrounding whitespace ARE spellings, not differences: `./a/b.ts`
    // and `a/b.ts` name the same file, and whitespace around a token is transport noise.
    expect(findingIdentity(f('  ./a/b.ts:sym:rule  '))).toBe(findingIdentity(f('a/b.ts:sym:rule')))
  })

  test('HEADLINE: CASE tells two findings apart — different files, different symbols', () => {
    const { findingIdentity, repeatVerdict } = loadEscalationGate()
    // On a case-sensitive filesystem these are genuinely different FILES, and `Handler`
    // and `handler` are genuinely different SYMBOLS. Lower-casing the key collapsed both,
    // so two different defects read as one finding surviving a fix round and the run
    // escalated while it was CONVERGING — the over-fire direction, which is the one way
    // this gate is worse than the round cap it replaced.
    //
    // It is the numeric strip's mistake in another dimension: normalisation that discards
    // CONTENT to make matching easier. Every normalisation is a claim that the discarded
    // difference could not have been meaningful, and for an identity derived from free
    // text that claim is almost never safe.
    const upperFile = f('src/Foo.ts:handler:missing-auth')
    const lowerFile = f('src/foo.ts:handler:missing-auth')
    expect(findingIdentity(upperFile)).not.toBe(findingIdentity(lowerFile))
    expect(repeatVerdict([upperFile], [lowerFile]).outcome).not.toBe('repeat')

    const upperSym = f('src/a.ts:Handler:missing-auth')
    const lowerSym = f('src/a.ts:handler:missing-auth')
    expect(findingIdentity(upperSym)).not.toBe(findingIdentity(lowerSym))
    expect(repeatVerdict([upperSym], [lowerSym]).outcome).not.toBe('repeat')

    // Internal whitespace went the same way: a filename may legitimately contain two
    // consecutive spaces, so collapsing runs was also a content change.
    expect(findingIdentity(f('src/my  file.ts:sym:rule'))).not.toBe(
      findingIdentity(f('src/my file.ts:sym:rule')),
    )
  })

  test('HEADLINE: a NUMBER THAT IS NOT A LINE tells two findings apart', () => {
    const { findingIdentity, repeatVerdict } = loadEscalationGate()
    // THE COLLISION THAT MADE THIS GATE WORSE THAN THE CAP IT REPLACED. Identity used to
    // DROP every purely-numeric segment anywhere in the key, on the theory that a numeric
    // segment is a line number. It is not — it is whatever the reviewer put there. These
    // two are DIFFERENT defects and both normalised to `api.ts:handler:missing-auth`, so
    // the gate read them as one finding surviving a fix round and escalated a run that
    // was CONVERGING.
    const a = f('api.ts:handler:401:missing-auth')
    const b = f('api.ts:handler:403:missing-auth')
    expect(findingIdentity(a)).not.toBe(findingIdentity(b))

    // …and the consequence, at the gate rather than at the helper: two rounds reporting
    // these two must NOT read as a repeat.
    expect(repeatVerdict([a], [b]).outcome).not.toBe('repeat')

    // Every shape of number-as-content, since the old filter took all of them: a status
    // code, an error number, a CWE id, a port, a version segment.
    for (const [x, y] of [
      ['svc.ts:fetch:500:retry-storm', 'svc.ts:fetch:502:retry-storm'],
      ['a.ts:s:cwe-79', 'a.ts:s:cwe-89'],
      ['net.ts:bind:8080:in-use', 'net.ts:bind:9090:in-use'],
      ['api.ts:v1:deprecated-call', 'api.ts:v2:deprecated-call'],
      ['a.ts:sym:12', 'a.ts:sym:40'],
    ] as const) {
      expect(findingIdentity(f(x))).not.toBe(findingIdentity(f(y)))
    }
  })

  test('CONTROL: the SAME key is still the same finding, and spelling still normalises', () => {
    const { findingIdentity, repeatVerdict } = loadEscalationGate()
    // Without this, a version that returned a fresh identity for every call — never
    // matching anything — would pass the test above.
    const same = f('api.ts:handler:401:missing-auth')
    expect(findingIdentity(same)).toBe(findingIdentity(f('api.ts:handler:401:missing-auth')))
    expect(findingIdentity(f('  ./api.ts:handler:401:missing-auth '))).toBe(findingIdentity(same))
    // …and two rounds reporting it DO read as a repeat, which is the gate still working.
    expect(repeatVerdict([same], [same]).outcome).toBe('repeat')
  })

  test('a line number in a key fails SAFE — it under-fires, it does not escalate', () => {
    // The format forbids a line number in a key (`VERDICT_SCHEMA` and all three prompts
    // say so, and say the line belongs in `evidence`), but a model can disobey. This pins
    // which way that breaks, because the two directions are not equally bad:
    //
    //   OVER-FIRING stops a run that was CONVERGING and reports `not-converging` about
    //   it — the one way this gate is worse than the round cap it replaced, and
    //   indistinguishable to an operator reading the escalation.
    //   UNDER-FIRING merely fails to prove a repeat: the run continues, the no-progress
    //   arithmetic still watches it, and the cap is still behind that.
    //
    // So a moved line now reads as two findings rather than one, and NOTHING escalates.
    const { findingIdentity, repeatVerdict } = loadEscalationGate()
    const r1 = f('a/b.ts:12:sym:rule')
    const r2 = f('a/b.ts:40:sym:rule')
    expect(findingIdentity(r1)).not.toBe(findingIdentity(r2))
    const verdict = repeatVerdict([r1], [r2])
    expect(verdict.outcome).not.toBe('repeat')
    // Specifically NOT the undecidable answer either — both keys were perfectly readable,
    // they just describe two things. Saying "I could not tell" would be a second lie, and
    // `undecidable` is the answer that keeps a finding out of BOTH definite buckets.
    expect(verdict.outcome).toBe('none')
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
      'app/rail.ts:rowRailLockstep:tautological-test',
      'work-board/store.ts:inlineActive:out-of-spec-proxy',
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

describe('what is asserted from the SOURCE, and why only these two things are', () => {
  // THE REST OF THIS SUITE'S WIRING TESTS ARE GONE, deleted rather than repaired, and
  // the reason arrived on its own: one of them required the literal
  // `if (!rePlan || typeof rePlan.executionSpec !== 'string' …)`. Production replaced
  // that string comparison with a computed failure classification — an unambiguous
  // improvement, and the only thing that noticed was a test asserting the old string.
  //
  // So a source-text assertion does not merely fail to prove behaviour: it BREAKS when
  // the behaviour is correctly improved, and the version of that defect which does not
  // cost a round is the one where the string happens to survive a change that broke the
  // behaviour. Everything those tests stood in for — the gate being consulted after each
  // re-review, the findings reaching the planner, exactly one re-plan per run, a planner
  // that produced nothing escalating, the terminal result carrying the escalation, and
  // the executor tag never being lowered — is asserted BY EXECUTION in
  // `escalation-e2e.test.ts`, which is strictly stronger. Keeping both would leave the
  // weaker one to fail again the next time the stronger one is satisfied by better code.
  //
  // TWO THINGS SURVIVE, because neither has any behaviour to execute:

  test('the review SCHEMA requires a finding key and offers the escalate channel', () => {
    // A schema is DATA handed to the model, not code this process runs: nothing in a
    // test can execute it, and the run under test never validates against it (the
    // harness supplies replies directly). The literal IS the deliverable here — without
    // a reviewer-emitted identity the repeat gate is a matcher over free text, which the
    // spec item rules out — so a literal is the honest thing to assert.
    expect(WORKFLOW_SRC).toContain("required: ['severity', 'title', 'evidence', 'key'],")
    expect(WORKFLOW_SRC).toContain("required: ['kind', 'whatIsMissing'],")
    expect(WORKFLOW_SRC).toContain("enum: ['design-gap', 'missing-dependency'],")
    // AND THE KEY'S GRAMMAR, which became load-bearing when identity stopped subtracting.
    // Nothing in the code removes a line number from a key any more — deliberately, since
    // doing so collided two different defects and escalated a converging run — so the ONLY
    // thing keeping line numbers out of keys is this instruction and the matching ones in
    // the three prompts. A schema is data handed to the model and is never validated in
    // process, so the literal IS the mechanism here.
    expect(WORKFLOW_SRC).toContain('NEVER put a line number in a key')
    // Case became content when the lower-casing was removed, so the model has to be told
    // to keep the key byte-identical between rounds — otherwise a reworded capitalisation
    // silently stops matching. Same grammar move as the line number: make the stable
    // thing explicit rather than subtract the volatile thing afterwards.
    expect(WORKFLOW_SRC).toContain('including CASE')
    // …said to the two panel seats and the synthesis seat as well, not only in the schema:
    // a panelist's key is carried through UNCHANGED, so a line number admitted there
    // reaches the gate no matter what the synthesis schema says.
    expect(WORKFLOW_SRC.match(/NEVER put a line number in a key/g) ?? []).toHaveLength(3)
    expect(WORKFLOW_SRC).toContain('Do NOT put a line number in a key')
  })

  test('the claim is read off the SEAT’s own reply, not off the merged findings', () => {
    // `gated` has this file's own CI advisories, suite blockers and lane findings merged
    // into it, and it SPREADS the seat's reply — so a run that read the claim from
    // `gated` behaves identically on every input a test can construct without also
    // driving the CI seam into injecting findings. The distinction is therefore not
    // reachable by execution here, and it is worth keeping because it is the laundering
    // guard: a declaration that the plan is wrong is a REVIEWER's judgement or it is
    // nothing. Stated as two short identifiers rather than a whole expression, so an
    // ordinary refactor of the surrounding code does not break it.
    expect(WORKFLOW_SRC).toContain('synthesisRaw.escalate')
    expect(WORKFLOW_SRC).not.toContain('gated.escalate')
  })
})
