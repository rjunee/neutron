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

Quota exhaustion is an infrastructure cause, not a review opinion, so nothing
parallel was added beside `classifyInnerFailure`. The row is still a LANE
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

### Tests

`trident/__tests__/cross-model-rate-limited.test.ts` (34) plus two in
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

**25 mutations applied and reverted one at a time; 24 red.** The one survivor is
recorded rather than papered over: keying the CLI's marker on
`reason.includes('429')` instead of on the fact field is **behaviourally identical
today**, because every other reason is built from a status code that is not 429
and no reason quotes a response body — so no behavioural test can separate them.
The field-keyed form is kept because it is the one that stays correct if that ever
changes, and the invariant it silently depends on is now itself a test: no other
failure's reason may contain "429".
