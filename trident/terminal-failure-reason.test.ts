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
import { innerTerminalFailureReason, publishFailureReason, redactPushError } from './orchestrator.ts'
import { interpretFailure } from './delivery.ts'
import { parseInnerResult } from './inner-loop.ts'
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
    })
    expect(reason).not.toContain('exhausted')
    expect(reason).toContain('round 10 of 10')
  })

  test('the four causes that once shared one sentence now share only TRUE words', () => {
    // The regression this file exists for, stated as a property rather than four cases: no
    // terminal reason may contain a number that was never measured. `max_rounds` appearing
    // as a COUNT is the specific lie — it is the ceiling, and it was printed as the tally.
    const cases = [
      { round: 1, checkpoint: 'inner-error', block_kind: null, terminal_cause: null },        // CODEX_HOME / brief / push credential
      { round: 10, checkpoint: 'argus-request-changes', block_kind: null, terminal_cause: null }, // ten real rounds
      { round: 2, checkpoint: 'argus-request-changes', block_kind: null, terminal_cause: null },  // a lost fix round
      { round: 10, checkpoint: 'inner-error', block_kind: null, terminal_cause: null },        // a throw DURING the last round
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
      block_kind: null,
      terminal_cause: null,
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

  test('infra-only with NO measured cause is still the generic sentence, verbatim', () => {
    // A legacy row, or a stop whose synthesis carried no titled finding. Nothing was
    // measured, so nothing is asserted — the rule this file exists for, unchanged.
    expect(innerTerminalFailureReason(run({ round: 1 }), infraOnly(null))).toBe(GENERIC)
  })

  test('a cause that is empty (or redacts away to nothing) is NOT a measurement — no dangling colon', () => {
    // '' is not null, so the specific branch used to fire and emit
    // "review never ran (infra-only) at round 1 of 10: " — a sentence that promises a
    // cause and then names none. Reachable whenever the redactor eats the whole string.
    for (const cause of ['', '   ', '\n']) {
      const reason = innerTerminalFailureReason(run({ round: 1 }), infraOnly(cause))
      expect(reason).toBe(GENERIC)
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
        round: 3,
        checkpoint: 'forge-done',
        block_kind: 'infra-only',
        terminal_cause: `could not read the head of trident/x; the recorded work is at ${OID}; re-run when the read succeeds`,
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
    round: 1,
    checkpoint: 'inner-error' as string | null,
    block_kind: null,
    terminal_cause: cause,
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

  test('a throw that measured NOTHING is still the generic sentence, verbatim', () => {
    expect(innerTerminalFailureReason(run({ round: 1 }), thrown(null))).toBe(
      "inner workflow ended at round 1 of 10 at checkpoint 'inner-error' without Argus APPROVE",
    )
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
      round: decoded?.round ?? 0,
      checkpoint: decoded?.checkpoint ?? null,
      block_kind: decoded?.block_kind ?? null,
      terminal_cause: decoded?.terminal_cause ?? null,
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
