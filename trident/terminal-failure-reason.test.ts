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
 * WHY NOTHING HERE ASSERTS A SPECIFIC CAUSE. Two Codex review rounds killed two attempts to
 * deduce one from `(round, checkpoint)`. The checkpoint records the PHASE reached, not the
 * TERMINAL CAUSE: `argus-request-changes` is written for genuine exhaustion, a round-lost
 * fix, a fix that left no diff, AND an infra-only synthesis stop. No terminal cause is
 * emitted anywhere in the pipeline. Until one is (SPEC), the honest message is the generic
 * one — which is exactly what the owner asked for.
 */
import { describe, expect, test } from 'bun:test'
import { innerTerminalFailureReason } from './orchestrator.ts'
import { interpretFailure } from './delivery.ts'
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
    // and no terminal cause is emitted anywhere. So the message states what was measured and
    // stops. This is the owner's rule applied literally: a generic catch-all gets a generic
    // message.
    const reason = innerTerminalFailureReason(run({ round: 10 }), { round: 10, checkpoint: 'argus-request-changes' })
    expect(reason).not.toContain('exhausted')
    expect(reason).toContain('round 10 of 10')
  })

  test('the four causes that once shared one sentence now share only TRUE words', () => {
    // The regression this file exists for, stated as a property rather than four cases: no
    // terminal reason may contain a number that was never measured. `max_rounds` appearing
    // as a COUNT is the specific lie — it is the ceiling, and it was printed as the tally.
    const cases = [
      { round: 1, checkpoint: 'inner-error' },        // CODEX_HOME / brief / push credential
      { round: 10, checkpoint: 'argus-request-changes' }, // ten real rounds
      { round: 2, checkpoint: 'argus-request-changes' },  // a lost fix round
      { round: 10, checkpoint: 'inner-error' },        // a throw DURING the last round
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
  })

  test('the round comes from the WORKFLOW, not the row a crash left behind', () => {
    // `run.round` is the row's copy and a crash can strand it at the launch value; the
    // inner workflow's own count is what actually happened. They are DELIBERATELY different
    // here — with the row's value the message would claim exhaustion.
    const reason = innerTerminalFailureReason(run({ round: 10, inner_checkpoint: null }), {
      round: 2,
      checkpoint: 'inner-error',
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
    const reason = innerTerminalFailureReason(run({ round: 11 }), { round: 11, checkpoint: 'inner-error' })
    expect(reason).not.toContain('exhausted')
  })

  test('no checkpoint at all → still true, just less specific', () => {
    // Nothing is invented to fill the gap. This is the "generic" half of the owner's rule.
    const reason = innerTerminalFailureReason(run({ inner_checkpoint: null }), { round: 3, checkpoint: null })
    expect(reason).toContain('round 3 of 10')
    expect(reason).not.toContain('checkpoint')
    expect(reason).not.toContain('exhausted')
  })

  test('a nonsense round from the workflow falls back to the row rather than printing it', () => {
    const reason = innerTerminalFailureReason(run({ round: 4 }), { round: 0, checkpoint: 'inner-error' })
    expect(reason).toContain('round 4 of 10')
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
