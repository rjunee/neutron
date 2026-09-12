---
title: Emit a terminal cause on every terminal path, and report it
group: trident
status: open
priority: P0
cutover: true
legacy_ref: "SPEC.md § Phases → Steps (2026-09-12 split)"
---

> **NARROWED 2026-09-12, at the split — the remaining gap is smaller and exactly
> located.** `terminalCause` is emitted on **only two paths**: an `infra-only`
> review stop (`trident/inner-workflow.mjs:7470`, guarded `...(isInfraOnlyStop ? {
> terminalCause } : {})`) and a THROWN workflow (`trident/inner-workflow.mjs:7524`,
> `terminalCause: infraCause(thrownMessage)`). **The review-verdict paths —
> `'code'`, `'round-lost'`, `'none'` — emit nothing.** And `trident/delivery.ts` has
> **zero reads** of `terminalCause`/`terminal_cause`, so even the two causes that
> are emitted never reach the owner's summary.
>
> So the work is: (1) emit a cause on the three review-verdict paths, and (2) give
> `delivery.ts` a specific summary per cause instead of one summary for all of them.
> The history below is kept because it is the argument for why a cause must be
> MEASURED and not inferred from `(round, checkpoint)`.

**A terminal `failure_reason` must name what actually happened — today it always says "exhausted 10
rounds"** (owner-asked 2026-08-13: *"why does the failure reason keep saying the old 10 rounds
exhausted thing?"*). `trident/orchestrator.ts` ~711 is a CATCH-ALL: every path that is not `APPROVE`
and not the provenance reject falls into one branch that writes
`` `inner loop exhausted ${run.max_rounds} round(s) without Argus APPROVE` ``. It interpolates
`run.max_rounds` — the CONFIGURED CEILING, never the rounds actually run — and the comment above it
states the false case as fact (*"the inner loop exhausted maxRounds"*). MEASURED on four runs
(`03242fe5`, `000cedc8`, `1daded20`, plus `36b95167`): three terminated at `round: 1` with
`checkpoint: "inner-error"` and ~10 minutes elapsed; all four reported "exhausted 10 round(s)". Three
genuinely different causes — ten real review rounds, `CODEX_HOME` unresolved, brief corruption, and
now a missing push credential — produced one identical sentence, and each time it sent a human to look
at review quality when the build had never started. THE TRUTH IS ALREADY IN HAND at that line:
`result.round` (1) and `result.checkpoint` (`inner-error`) are both in scope, and the wrapper's real
reason is on disk at `/tmp/trident-codex-build-<runId>-r<N>.err`. Acceptance: a run that never reached
a review round must NOT say it exhausted rounds; the reason names the phase that failed and the actual
round count, and a test asserts an `inner-error` at round 1 produces neither the word "exhausted" nor
the number `max_rounds`. NOTE the delivery layer (`trident/delivery.ts` ~177) already pattern-matches
this exact string to soften it for chat — so fixing the reason without updating that matcher would
silently change what the owner is told. Both move together.
RESOLVED IN PART, 2026-08-14 (PR #240): the message no longer LIES. It now reports only
what was measured — `inner workflow ended at round <N> of <M> at checkpoint '<C>'` — and
asserts no cause at all. WHAT REMAINS IS THE MISSING SIGNAL, and it is the real item:
**the inner workflow emits no TERMINAL CAUSE.** Two Codex review rounds killed two
attempts to deduce one, and the second is the instructive failure: `checkpoint` records
the PHASE reached, not why the loop stopped, and `argus-request-changes` is written for
genuine exhaustion, a round-lost fix (`inner-workflow.mjs` ~3174), a fix that left no
diff (~3197) AND an `infra-only` synthesis stop (~3134). Any specific message built on
`(round, checkpoint)` is an inference, which is how this line came to be wrong for four
different failures in one night. Acceptance for the REMAINDER: the inner workflow emits
an explicit terminal cause on every terminal path; the orchestrator reports THAT; and
`delivery.ts` regains a specific summary per cause. Until then the generic message is
correct and MUST NOT be re-specialised.
PROGRESS 2026-08-14/15, two of the terminal paths now emit one, and BOTH ship with the
measurement rather than before it. (1) An `infra-only` review stop carries the probe's
own words (PR #240). (2) A THROWN workflow carries the sentence it threw — the catch
used to persist `{checkpoint: 'inner-error'}` with no cause, so run `3d2696c3`
(a finished, committed build whose OID was not relayed) was reported to the owner as
"…without Argus APPROVE" on a path Argus never reached. It carries NO block kind,
because a throw is not a review verdict, and `innerTerminalFailureReason` reports it as
*"inner workflow failed at round N of M: `<cause>`"* — saying nothing about the review
panel, which only `infra-only` is licensed to do. STILL OPEN: the review-verdict paths
('code' / 'round-lost' / 'none') emit no cause — a finding title describes the DIFF, not
why the loop stopped — and `delivery.ts` still has one summary for all of them.
OWNER'S RULE (2026-08-13, verbatim): *"If it's a generic catchall make the error message generic."*
This is the governing principle and it is broader than this line: **a message must not assert a cause
it did not measure.** A branch that catches N causes says something true of all N, and the specific
cause is added only where it is actually known. Prefer naming the real cause (`result.checkpoint`,
`result.round`, the wrapper's `.err` file are all in scope here) — but where the code genuinely cannot
tell, generic-and-true beats specific-and-wrong. A confidently-worded default is the failure mode: it
reads as diagnosis, so nobody looks further.
HOW IT GOT THIS WAY (checked, not assumed — `git log -L 711,713`): the line dates from the initial
commit `63236c6`, when reaching it genuinely meant the rounds ran out; it was true when written. Every
early-exit added since — `inner-error`, codex deferred, brief corrupt, no push credential — landed in
it without anyone adding a terminal branch. Not randomness: drift, one plausible commit at a time. The
test suite should therefore pin the SHAPE (a non-round-exhaustion exit must not claim exhaustion), so
the next early-exit path cannot silently inherit the same wrong sentence.

## Acceptance

- [ ] The inner workflow emits an explicit terminal cause on EVERY terminal path. The three
      review-verdict paths (`'code'`, `'round-lost'`, `'none'`) emit one today's code does
      not — assert each separately, since the two shipped paths (`trident/inner-workflow.mjs:7470`,
      `:7524`) already pass any test written against them.
- [ ] The orchestrator reports THAT cause, not an inference from `(round, checkpoint)`.
- [ ] `trident/delivery.ts` regains a specific summary per cause. It has zero reads of
      `terminalCause` today, so a search finding none means this is not built.
      verify: `rg -n "terminal_cause|terminalCause" trident/delivery.ts`
- [ ] A run that never reached a review round does NOT say it exhausted rounds. A test
      asserts an `inner-error` at round 1 produces neither the word "exhausted" nor the
      number `max_rounds`.
- [ ] The test pins the SHAPE, not the sentence: a non-round-exhaustion exit must not claim
      exhaustion, so the NEXT early-exit path added cannot silently inherit a wrong message.
- [ ] `delivery.ts`'s matcher moves WITH the reason. Assert what the owner is told does not
      silently change — the two have to land together.
