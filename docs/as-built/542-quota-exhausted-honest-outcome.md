## 2026-09-12 — a rate-limited cross-model provider is reportable as itself, without a fourth status

`trident/kimi-review.ts` folded HTTP 429 into `deferred`, and the cross-model
verdict schemas have no other word. That was not merely imprecise, because of
where a deferred seat's words end up: `deferredCrossModelPeers` writes a LANE
finding, `infraTerminalCause` takes that finding's **TITLE** as the run's entire
`terminal_cause`, the orchestrator quotes it into `failure_reason`, and
`delivery.ts` renders it to the operator. Over a 429 the operator therefore read
`Kimi K3 cross-model review DEFERRED — refusing to silently APPROVE` above
evidence offering "the review call failed, timed out, or returned no answer text
(the thinking-budget case)".

Every clause of that is false. Nothing failed, nothing timed out, and no answer
was ever asked for — the provider declined to serve the request. So the panel ran
in full, paid for itself, correctly refused the merge, and then sent the operator
to look at the network. #542.

### The fix is a FACT FIELD, not a fourth status member

`deferred` already carries the only thing the panel gate asks of a cross-model
result — *a configured reviewer produced no review* — and that is exactly as true
of a 429 as of a timeout. An `exhausted` member of `CrossModelStatus` would have
had to be threaded through every `=== 'deferred'` comparison in the workflow
(`crossModelPeerStatus`, `retryDeferredPeers`, `deferredCrossModelPeers`,
`codexPanelLine`), and each one missed is a gate that silently stops blocking:
the fail-OPEN direction, the one that ships unreviewed code.

So the STATUS BLOCKS and a FIELD NAMES — the division of labour `codexTruncated`
already uses to carry a scope the verdict enum cannot express. No union member
was added or changed anywhere, and no consumer of `CrossModelStatus` needed
updating.

### It names the OBSERVATION, because the repo had already settled the inference

The first version of this change was wrong in a way worth recording. It called
the field `quotaExhausted`, titled the row `QUOTA EXHAUSTED`, and said "the
account has no allowance left to spend" — **asserting depletion from a status
code that does not carry it.** `trident/kimi-usage-probe.ts` had already decided
how trident reads a Kimi 429, and decided it the other way: 429 is excluded from
`isPermanentRejection` with the reason written out — *"a timeout and a rate limit
are the two 4xx codes that mean 'ask again later' rather than 'this request is
wrong'"*. One part of trident would have treated the code as transient while
another asserted an empty account from the identical observation.

The ambiguity had even been identified in the change's own reasoning ("true of
one half of what a 429 means and false of the other") and then written into code
as one half. The doctrine already prescribes the encoding: where a producer
looked and could not tell, the fact is unknown, and unknown authorises nothing.

So everything is named after what was measured — `RATE_LIMIT_HTTP`,
`KIMI_RATE_LIMIT_TOKEN`, `rateLimited`, `kimiRateLimited`,
`crossModelRateLimited`, `seatRateLimitKey`, `rateLimitedPeer` — the title says
`RATE LIMITED (HTTP 429) — no review was performed`, and every surface that
offers a remedy offers **both** and concludes neither, pointing at
`kimi-usage-probe.ts` so the next reader finds the doctrine rather than
re-deciding it. The bounded retry is kept, because the transient half is real.

- `trident/kimi-review.ts` — `RATE_LIMIT_HTTP`, `KIMI_RATE_LIMIT_TOKEN`, and
  `KimiReviewResult.rateLimited?: boolean`. Every other non-ok status, every
  transport throw and the answerless-200 trap stay exactly as they were,
  unflagged.
- `trident/kimi-review-cli.ts` — writes `KIMI_REVIEW_RATE_LIMITED` to stderr
  **from the fact field**, never from the wording of `reason`. The exit code is
  unchanged: the vocabulary is shared with `codex-review.sh` by design, and the
  panel's question is answered `no` either way.
- `trident/inner-workflow.mjs` — `kimiRateLimited` on `KIMI_VERDICT_SCHEMA` (in
  `properties`, deliberately **not** in `required`); a bridge command that greps
  the CLI's stderr and echoes `KIMI_RATE_LIMITED=1/0` for the model to copy
  verbatim — the same mechanism, and the same honesty, as the existing
  `CODEX_REVIEW_DIFF_TRUNCATED` grep, because a fact only the model reads is a
  fact the workflow cannot act on. Plus `rateLimitedPeer` (the honest row),
  `crossModelRateLimited`, `seatRateLimitKey`, and the lane-retry exception below.
- `trident/delivery.ts` — one arm in the existing bounded cause→advice mapping
  inside `infra-blocked`. The class is untouched, as that mapping's docblock
  requires; only the advice changes, because "retry once the infrastructure is
  healthy" is not vague here but **wrong**. It is keyed on `http 429` — the
  status code rather than any English, because the code is the part that cannot
  be reworded.

### It routes through the machinery that already exists

A provider refusing the call is an infrastructure cause, not a review opinion, so
nothing parallel was added beside `classifyInnerFailure`. The row is still a LANE
finding, still forces REQUEST_CHANGES through `enforceCrossModelGate`, still
comes out of `classifyBlock` as `infra-only`, and `infra-only` plus a non-empty
cause is what `classifyInnerFailure` already reads as `infrastructure` — a
bounded `infra_retries` unit against `INFRA_RETRY_BACKOFF_MS` (1m/5m/15m, three
attempts).

That destination is right for **both** things a 429 can mean, and the reason the
code cannot tell them apart is the reason it should not choose: a rate limit
clears inside that window and costs nothing to wait out, while an exhausted
allowance burns three bounded retries and then terminates carrying a cause that
names the refusal. Refusing to retry would make every transient rate limit a
terminal failure — the trade `kimi-usage-probe.ts` had already declined.

**But the LANE retry is a different question, and it was answering it wrongly.**
`retryDeferredPeers` re-calls a deferred seat IMMEDIATELY with no backoff, which
is right for the failures it was written for (a dead agent, a dropped socket) and
guaranteed waste for a 429: the provider has just said it is serving too many
requests, and on a per-minute limiter the extra call can extend the window. A
seat that reported the flag is therefore no longer re-called in-round; only the
run-level backoff waits, which is the one that can actually help. The original
refusal is kept, so the gate still blocks and the row still names the 429.

### The title is the terminal cause, so every word is load-bearing

`Kimi K3 cross-model review RATE LIMITED (HTTP 429) — no review was performed`.
It names the measurement; it says no review happened rather than anything
resembling a verdict, so it cannot contradict the `REVIEW_NOT_RUN` column
(`recordedTerminalVerdict`); and it does not contain the word "deferred", because
a deferral is a review that declined to be given and this is a reviewer that was
refused.

**It also no longer stutters.** The row first composed its title as
`${name} cross-model review …`, which is right for a bare vendor name and wrong
for the off-family seats whose names already end in "review": slot one holding a
kimi tier — the exact configuration `seatRateLimitKey` exists for, reachable
today — produced "Cross-model review 1 (Kimi K3) cross-model review RATE LIMITED
…". That string is the terminal cause and reaches the operator verbatim, so the
duplication was not cosmetic. The label is passed in from the same place the
sibling generic row computes its own, and a test walks all six live routes.

### TWO layers keep it off the review arm, and they are pinned SEPARATELY

`interpretFailure` narrates a terminal reason containing the token `exhausted` as
*"the reviewer still had blocking findings"*. Two independent things keep this row
away from that arm:

1. **Structural** — `deriveInfraBlock` derives the block from the harvested
   columns and `interpretFailure` checks it FIRST, answering `infra-blocked`.
2. **By reason string** — for a row whose disposition the columns cannot judge
   (`not-terminal`), the `review never ran (infra-only)` branch intercepts, and
   it sits above the bare-token arm.

**The first attempt to pin this could not fail, and that is the part worth
recording.** The test asserted `not.toBe('review-unresolved')` on a terminal
infra-only fixture. Measured: replacing `deriveInfraBlock(run)` with `null` — the
maximal reversal of the very ordering the test named in its title — left it
**green**, because such a row's disposition is never `reviewed-rejected` or
`not-terminal`, so that arm is unreachable there under *every* ordering. The
assertion was unsatisfiable. It had been cited as a guarantee in four places (two
source comments, the PR body, and this record), and it is the same rule the change
invoked to justify DELETING two unfalsifiable guards — applied in one direction
only.

Both layers are now pinned by assertions that do fail: layer 1 by asserting
`infra-blocked` **positively** (neuter the derivation and the row falls to
`infra`), layer 2 on a `not-terminal` fixture where the dangerous arm is genuinely
reachable — and that test also proves the arm is live on that fixture, so it is
measuring the interception rather than a fixture that happens to miss. Worth
noting for whoever reads the review thread: making the fixture
`reviewed-rejected` would **not** have fixed the negative assertion either, because
layer 2 intercepts before the review arm regardless of disposition. Measured.

### Both seats, one path — but the codex side is a three-step follow-up, not zero

The earlier note claimed "no second code path to add". False, and the failure mode
of believing it is bad. `CODEX_VERDICT_SCHEMA` is `additionalProperties: false`
with no such property, so a bridge that sets `codexRateLimited` **before** the
schema is widened has its WHOLE verdict rejected — the seat degrades from "429,
honest row" to "dead seat, generic row", strictly worse than today. What is
missing, in order: (1) `codex-review.sh` measuring a 429 and emitting a token
(today its own 429 lands on the generic exit 5), (2) the schema property, (3) the
prompt instruction. `seatRateLimitKey('codex')` names a field nothing can carry
today; it reads as absent, which is the safe fallback. A test pins all three gaps
so widening the schema reds and tells whoever does it to correct the note.

### Unknown authorises nothing, and no guard was kept that a mutation cannot fail

Only a literal `true` counts. A missing field, a stringified `'true'`, a null, a
dead seat: every one is a flag that did not arrive, and the fallback is the
generic deferral row, which blocks identically and claims less.

`crossModelRateLimited` first shipped with two early-return guards mirroring
`crossModelPeerStatus`. Both were **unfalsifiable** — deleting either left every
test green, because JS indexing already answers both cases — so they were removed
rather than kept as reassurance.

### The advice branch reintroduced the exact defect, and it was a regression against main

Worth the most space of anything here, because the fix for a false sentence was
itself a false sentence, and CI was green for it.

The advice arm matched `c.includes('http 429')` under an absence claim — *"the
matched token is authored by `rateLimitedPeer` and nowhere else"* — written into a
source comment, a test, and this record. **It was false.** `infraTerminalCause`
takes the first LANE finding's TITLE, and `reviewPreconditionDeferred` composes its
title as `REVIEW DEFERRED — PR readiness could not be read: <probeCause(raw)>`,
where `probeCause` quotes the first two lines of `gh pr view` stdout+stderr
verbatim and `raw` is **agent-transcribed** ("Put the FULL stdout+stderr in `raw`
VERBATIM"). GitHub's secondary rate limit answers 403 **or** 429 — which this repo
already knew, since `trident/git-mode.ts` matches `/\bhttp 429\b/` on `gh` output
for exactly that reason.

Measured end to end:

```
cause:  REVIEW DEFERRED — PR readiness could not be read: HTTP 429: You have
        exceeded a secondary rate limit … (https://api.github.com/graphql)
advice: … check the provider account's rate limits AND its balance …
```

No model provider was involved at any point, and the operator was sent to look at a
Kimi or Codex balance. `main` handled that same cause **better**, with the generic
"retry once the infrastructure is healthy". Two more vectors reach it the same way:
the readiness probe's `mode === 'unknown'` arm, and a thrown workflow message quoted
through `infraCause`.

It also contradicted the docblock directly above it, which says in words that *a
keyword classifier cannot safely be handed the MEASURED cause: that text is model/CI
prose*. The branch was a keyword classifier handed the measured cause.

**The shape is anchored at both ends** — `CROSS_MODEL_RATE_LIMIT_CAUSE` — the way
`PRE_LAUNCH_PREFIX` and `isPublishedUnreviewedReason` already are in that file. Only
the seat label varies, and the label vocabulary is letters, digits, spaces, hyphens
and parens: no colon, no em dash. Every probe-quoted shape introduces one of those
before the phrase, so a quotation cannot satisfy the anchor **even when it embeds the
authored sentence verbatim** — the echo case, where `gh pr view` output contains a
prior run's title. A label that ever grows a colon stops matching and falls back to
the generic line, which is the safe direction by construction.

Structural would be better and is not available to this lane: `deriveInfraBlock`
carries only `{ cause }`, and adding a field to the harvested result means editing
`parseInnerResult` in `trident/inner-loop.ts`. Carrying the flag as a column is the
follow-up; the anchor is what makes the string channel safe meanwhile.

### ...and the anchors alone were still not enough: the label had to be a CLOSED SET

The anchored version let the label be `[a-z0-9 ()-]+` — any label of that shape, not only
the six a seat can emit. `infraCause` passes a **thrown workflow message** through
verbatim as a terminal cause, so an exact-shape impostor matched:

```
GitHub cross-model review RATE LIMITED (HTTP 429) — no review was performed
The registry RATE LIMITED (HTTP 429) — no review was performed
```

Both measured; both sent the operator to check a model provider's balance for a sentence
no seat authored. The anchors had closed the two *wrapping* vectors (a prefix, because
every probe-quoted shape puts a colon or em dash in front; a suffix, because `probeCause`
joins two lines with a space). They did nothing about **substitution**.

`CROSS_MODEL_SEAT_LABELS` is now the complete set of six, and the matcher's alternation is
built from it with every metacharacter escaped. Anything unrecognised falls back to the
generic line — what `main` said before any of this, never wrong and only vague.

**The two halves cannot drift, and that is a test rather than a promise.** The emitter is a
Workflow body with no module resolution, so the list is necessarily restated in
`delivery.ts`; a drift guard enumerates the labels by RUNNING the real emitter across every
route (including groups it does not recognise), reads the shipped list out of
`delivery.ts`'s own source, and requires the two sets to be identical and both of size six.
The size assertion is not decoration: the first version of that guard sliced the
declaration to the first `]` — which the type annotation `readonly string[]` contains — and
compared two empty sets. A guard that cannot fail, one more time, caught by mutation.

Replacing the string channel with a decoded column is filed as **#631** rather than left as
a comment: `parseInnerResult` lives in `trident/inner-loop.ts`, which this lane does not
own, and inventing a second decoder beside the one true one would be worse than the string
it replaced.

### The false sentence also survived where the MODEL reads it

The flag was read on the operator surface only. Over a 429 the synthesis was still
handed `DEFERRED — configured but the review failed or returned no usable verdict`,
and the bridge prompt still hard-coded `title:'Kimi review deferred'` — both of them
sentences this change had already removed from the operator's row for being false in
every clause. The direction was safe (`enforceCrossModelGate` blocks
deterministically, never on this prose), so this bought accuracy rather than safety —
but a reviewer told a transport fault happened is how a wrong remedy gets composed
into the findings. `peerPanelLine` now takes the flag and the bridge is told to title
its finding from the measured `KIMI_RATE_LIMITED` line, asserting no cause either way.

### `bunx tsc --noEmit` DOES NOT TYPECHECK `trident/`, and this branch proved it

Worth recording because it cost a red CI run here and hit a sibling lane the same
day. The root `tsconfig.json`'s `include` list names ~30 directories and
**`trident/` is not among them**, so `bunx tsc --noEmit` silently typechecks none
of this change. It reported clean while `trident/__tests__/` carried seven real
errors.

`scripts/ci/typecheck-all.sh` is the command that matches CI — its own header
already documents this trap ("`tsc --noEmit`, whose include list never reached
`trident/`, `app/`") — and it runs `tsc -p` over every tsconfig in the repo,
**51** of them, so a directory cannot silently escape the gate. Expect
`TYPECHECK MATRIX: ALL PASS`.

The seven errors, none of them environmental:

- **`rateLimitedPeer` declared with one parameter, called with two** (×3). The
  stutter fix added the `label` argument and the test's own type declaration was
  left behind — the fix and the type drifted apart in the same commit.
- **`phase: 'running'` is not a `TridentPhase`** (×2). The vocabulary is
  `forge-init / ralph-plan / ralph-task / argus / forge-fix / done / failed /
  stopped` (`trident/store.ts:33`), and the table's CHECK constraint is built from
  exactly that list — so the fixture was describing a state the schema forbids, and
  the type error was the schema saying so. Now `'argus'`, which is legal,
  non-terminal (the property the fixture needs) and the honest choice: the review
  phase is when a cross-model seat actually gets refused.
- **`innerTerminalFailureReason`'s `Pick<InnerResult, …>` needs `ok` and
  `findings_present`.** Supplying them is also the truthful shape — an infra-only
  stop is not `ok` and carries no findings of its own.
- **`verdicts: Verdict[]` in `lane-retry.test.ts`** rejected the `null` a DEAD SEAT
  really is — the type lying about the function rather than the fixture being
  wrong. Widened to `Array<Verdict | null>`. Neither CI nor the review reported
  this one; the matrix found it.
- **`server.port` is `number | undefined`.** Narrowed with a throw, so a bound port
  that cannot be read fails loudly instead of interpolating `undefined` into a URL
  and timing out mysteriously.

### A third test that passed for the wrong reason

The subprocess harness built the child's environment by spreading `process.env` and
then **not adding** `KIMI_API_KEY` when the case wanted none. On a box where the
parent has one, the child inherits it, reaches the local server and exits 3 — so
the asserted exit-10 not_connected boundary was a property of this machine, not of
the code. `childEnv` now **deletes** the key rather than declining to set it, and a
test sets a value in the parent's own environment first to prove the difference.

Measured, because "it passes now" was exactly the problem: with the omission
restored, the suite reds **1 test on a box with no `KIMI_API_KEY` and 2 with one**.
The pre-existing assertion only failed in the second case; the new one fails in
both, which is what makes it a guard rather than a coincidence.

This is the third instance in this one change of a single shape — a test that
passes for the wrong reason — after the unfalsifiable ordering assertion and the
two source-substring CLI tests. The common cause is worth naming: each one was
written to describe an intention rather than to discriminate between the world
where the code is right and the world where it is not.

### Tests

`trident/__tests__/cross-model-rate-limited.test.ts` (40) plus two in
`trident/lane-retry.test.ts`, against the REAL functions extracted from the `.mjs`.
Both directions, because the second is what stops this becoming a merge-anything
hole: a genuine findings-carrying REQUEST_CHANGES is still `code`, still
`genuine`, still recorded as a rejection and still blocks — including when a
rate-limited seat sits beside a real finding, where the code work still buys the
round.

**The CLI is RUN, not read.** Two tests used to assert a substring existed in the
source and executed nothing, which left a real mutation alive: an unconditional
`process.stderr.write(TOKEN)` anywhere in `main` keeps such a test green while
making every rejected key and every dropped socket report as a rate limit,
because the workflow greps the whole stderr stream. The CLI now runs as a
subprocess against a local server (`KIMI_BASE_URL` is environment-driven, so
nothing is stubbed) and the marker is asserted present for 429 and **absent** for
401, 403, 500, 502, an answerless 200, a refused connection and a missing
credential.

### The root cause of every proxy-test finding on this branch

Five review rounds found five defects, and four of them were the same defect:

1. the ordering assertion that could not fail;
2. two CLI tests that asserted a substring existed in a source file and executed nothing;
3. the child environment built by omission, so the boundary held only on a box with no
   `KIMI_API_KEY`;
4. the absence claim "authored here and nowhere else", which was false in three ways;
5. the drift guard that compared two empty sets.

Stated once, because it is the same mistake each time: **the intended invariant was written
into prose before the code was proven to discriminate.** Every one of those passed, and
every one of them would have kept passing through the change it existed to prevent. The
fix in each case was not a broader assertion but a *discriminating fixture* — the input on
which a right implementation and a wrong one diverge. An absence claim in particular is
worth nothing until the thing it says cannot happen is a red test.

**25 mutations applied and reverted one at a time; 24 red.** The one survivor is
recorded rather than papered over: keying the CLI's marker on
`reason.includes('429')` instead of on the fact field is **behaviourally identical
today**, because every other reason is built from a status code that is not 429
and no reason quotes a response body — so no behavioural test can separate them.
The field-keyed form is kept because it is the one that stays correct if that ever
changes, and the invariant it silently depends on is now itself a test: no other
failure's reason may contain "429".
