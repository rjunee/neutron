## 2026-09-12 — a rate-limited cross-model provider is reportable as itself, without a fourth status

`trident/kimi-review.ts` folded HTTP 429 into `deferred`, and the cross-model
verdict schemas (`trident/inner-workflow.mjs:908/926/1034` before this change)
have no other word. That was not merely imprecise, because of where a deferred
seat's words end up: `deferredCrossModelPeers` writes a LANE finding,
`infraTerminalCause` takes that finding's **TITLE** as the run's entire
`terminal_cause`, the orchestrator quotes it into `failure_reason`, and
`delivery.ts` renders it to the operator. Over a 429 the operator therefore read
`Kimi K3 cross-model review DEFERRED — refusing to silently APPROVE` above
evidence offering "the review call failed, timed out, or returned no answer text
(the thinking-budget case)".

Every clause of that is false. Nothing failed, nothing timed out, and no answer
was ever asked for — the account had no allowance left to spend. So the panel ran
in full, paid for itself, correctly refused the merge, and then sent the operator
to look at the network instead of at the balance. #542.

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

- `trident/kimi-review.ts` — `QUOTA_EXHAUSTED_HTTP`, `KIMI_QUOTA_TOKEN`, and
  `KimiReviewResult.quotaExhausted?: boolean`. The 429 arm sets the field and
  says, in the reason, that the code covers **both** a per-minute rate limit and
  an exhausted balance and that the provider did not say which. It does not
  inspect the body to guess: "wait" and "top up" are different actions, and a
  confident sentence about an unmeasured cause is the failure this row exists to
  remove. Every other non-ok status, every transport throw and the answerless-200
  trap stay exactly as they were, unflagged.
- `trident/kimi-review-cli.ts` — writes `KIMI_REVIEW_QUOTA_EXHAUSTED` to stderr
  **from the fact field**, never from the wording of `reason`, so rewording the
  human sentence cannot unhook the bridge's grep. The exit code is unchanged:
  the vocabulary is shared with `codex-review.sh` by design, and the panel's
  question is answered `no` either way.
- `trident/inner-workflow.mjs` — `KIMI_VERDICT_SCHEMA` gains
  `kimiQuotaExhausted` (in `properties`, deliberately **not** in `required`: the
  flag refines a row that already blocks, so an absent one costs only detail,
  whereas requiring it risks rejecting an ordinary verdict wholesale and
  converting working reviews into deferrals). The bridge command greps the CLI's
  stderr and echoes `KIMI_QUOTA=1/0` for the model to copy verbatim — the same
  mechanism, and the same honesty, as the existing `CODEX_REVIEW_DIFF_TRUNCATED`
  grep, because a fact only the model reads is a fact the workflow cannot act on.
  `quotaExhaustedPeer` is the honest row; `crossModelQuotaExhausted` reads the
  flag; `seatQuotaKey` derives which field to read from the seat's **route**.
- `trident/delivery.ts` — one arm added to the existing bounded cause→advice
  mapping inside `infra-blocked`. The class is untouched, as that mapping's
  docblock requires; only the advice changes, because "retry once the
  infrastructure is healthy" is not vague here but **wrong** — nothing is
  unhealthy and a retry reaches the same refusal until someone waits or pays.

### It routes through the machinery that already exists

Quota exhaustion is an infrastructure cause, not a review opinion, so nothing
parallel was added beside `classifyInnerFailure`. The quota row is still a LANE
finding, still forces REQUEST_CHANGES through `enforceCrossModelGate`, still
comes out of `classifyBlock` as `infra-only`, and `infra-only` plus a non-empty
cause is what `classifyInnerFailure` already reads as `infrastructure` — a
bounded `infra_retries` unit against `INFRA_RETRY_BACKOFF_MS` (1m/5m/15m, three
attempts).

That destination is right for **both** halves of what a 429 can mean, and the
reason the code cannot tell them apart is the reason it should not choose: a
per-minute rate limit clears inside that window and costs nothing to wait out,
while an empty balance burns three bounded retries and then terminates carrying a
cause that names quota — which is the operator's signal. Refusing to retry would
make every transient rate limit a terminal failure, a strictly worse trade on the
one case the provider does not let us distinguish.

The row is recorded as `REVIEW_NOT_RUN` (`recordedTerminalVerdict`), reaches the
operator as `infra-blocked` — 🚧, not ❌, and the words "Nothing about the code
was rejected — it was never reviewed." — and the merge stays held.

### The title is the terminal cause, so every word in it is load-bearing

`Kimi K3 cross-model review QUOTA EXHAUSTED (HTTP 429) — no review was
performed`. It names the fact; it says no review happened rather than anything
resembling a verdict, so it cannot contradict the `REVIEW_NOT_RUN` column; and it
does **not** contain the word "deferred", because a deferral is a review that
declined to be given and this is a reviewer that was never reachable.

**One ordering is the whole safety, and it is pinned rather than trusted.**
`interpretFailure` narrates a terminal reason containing the token `exhausted` as
*"the reviewer still had blocking findings"* — the exact lie this change removes.
It is unreachable here only because `deriveInfraBlock` derives the infra block
**structurally** from the harvested columns and is checked first. That is an
ordering, orderings get edited, and a test asserts the real title does not reach
the `review-unresolved` class.

### Both seats, one path

`deferredCrossModelPeers` takes `exhausted` as `{ codex, kimi }` and both arms
delegate to the one `quotaExhaustedPeer` row. `codex-review.sh` does not emit a
quota token today — its own 429 lands on the generic exit 5 (see its precheck
note) — so a codex-family seat reports `false` on every live run. That is
deliberate: the codex lane starts reporting honestly the moment its wrapper
learns to set the flag, with no second code path to add, and inventing a producer
for a wrapper that measures nothing would have been the fabrication this row
exists to remove.

**The quota field is keyed by the seat's ROUTE, never by the slot's name.** The
seats are `review_cross_1`/`review_cross_2` and either can hold either family, so
`codexSlot` carrying a kimi tier is ordinary configuration; its verdict fills
`KIMI_VERDICT_SCHEMA` and carries `kimiQuotaExhausted`. A hard-coded
`'codexQuotaExhausted'` for slot one would read a field that verdict never
carries and restore the bug on that route — the same mistake this file already
documents for positional indexing, closed the same way.

### Unknown authorises nothing, and no guard was kept that a mutation cannot fail

The flag travels through a bridge agent copying a grepped line into a schema
field, so only a literal `true` counts. A missing field, a stringified `'true'`,
a null, a dead seat that produced no verdict: every one is a flag that did not
arrive, and the fallback is the generic deferral row, which blocks identically
and claims less.

`crossModelQuotaExhausted` first shipped with two early-return guards mirroring
`crossModelPeerStatus`. Both were **unfalsifiable** — deleting either left every
test green, because JS indexing already answers both cases — so they were removed
rather than kept as reassurance, per this file's own rule that a guard a reverting
mutation cannot fail is not a guard. What remains is total over every input the
call site can produce, and every line of it reds under mutation.

### Tests

`trident/__tests__/cross-model-quota-exhausted.test.ts`, 27 tests, against the
REAL functions extracted from the `.mjs` (the workflow body cannot be imported).
Both directions, because the second is what stops this from becoming a
merge-anything hole: a 429 produces the honest row AND a genuine
findings-carrying REQUEST_CHANGES is still `code`, still `genuine`, still
recorded as a rejection, and still blocks — including when a quota-exhausted seat
sits beside a real finding, where the code work still buys the round. Nothing a
quota row does can reach APPROVE.

**22 mutations applied, reverted one at a time, all 22 red.** Including the two
fail-open shapes (`crossModelQuotaExhausted` loosened from `=== true` to truthy;
a quota-exhausted seat writing no peer row at all), the drift shapes (the `.mjs`
token diverging from the exported one; the title losing its quota words; the call
site hard-coding the keys), and four against the half that had to be
**preserved** (`classifyBlock` reading code findings as infra-only,
`classifyInnerFailure` calling a code rejection infrastructure,
`recordedTerminalVerdict` accepting an infra-only block as a rejection,
`enforceCrossModelGate` no longer forcing REQUEST_CHANGES).

### About commit `37240b79`

It reads like it closes this and is **not an ancestor of `main`**
(`git merge-base --is-ancestor 37240b79 origin/main` → 1). It is a 39-file,
3813-insertion change covering four unrelated defects, it edits
`trident/inner-loop.ts` and `docs/AS_BUILT.md` (now frozen), and its quota
handling resolves 429 by parsing the response BODY — a contract this session
could not verify against a live provider. Nothing was cherry-picked from it. Its
own note that "quota does not clear on its own" is true of one half of what a 429
means and false of the other, which is why this change waits the bounded backoff
out rather than refusing to retry.
