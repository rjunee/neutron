## 2026-09-29 — Verify sequence and publication repairs through an unattended live merge

This record completes the existing static-plus-live acceptance for #1219 and
#1217 and the original source-side trailer-removal scope of #1133. It does not
change their criteria or claim general restart recovery. The corresponding
spec-item statuses and generated index now agree with the closed issue state.

### Merged implementation and served identity

The task-sequence repair shipped through green PR #1224, merge
`1e0648c2b7b370a0ce54ac6b55b2ab63e597c4d3`; its original static controls remain in
[the implementation record](same-run-task-sequence-crash-handoff.md).
The salvage receipt repair shipped through green PR #1218, merge
`8c24fc54c4c0ba35a9881be2199568d597ed86db`, recorded in
[salvage publication provenance](salvage-publication-provenance.md).
The additional interrupted-publication static controls shipped through green
PR #1343, merge `ea6d44286e86d5b8c3bf55549968385184369da4`, recorded in
[the interrupted-publication record](interrupted-project-publication-receipt.md).
The original trailer removal shipped through green PR #1152, merge
`84a38afec2c0f728d6fd624ee4ea0de234ca3366`, recorded in
[the source-side removal record](drop-claude-session-trailer.md).

The orchestrator independently fetched each PR's merge and required-check
receipts, including the successful `test` aggregate, and checked each merge's
ancestry into served revision `edd31322e6e72855c54df9e976d6dd38f3eb8827`.
The committed deployment pin, served checkout and complete served-tree
comparison agree on that revision. This is delivery evidence for the already
merged implementations, not a claim that the present efficiency batch is served.

### Fresh adopted-chat witness

A fresh Work Board card dispatched through its adopted project chat produced run
`8083aef9-507c-47fb-bab0-361381c53f0e`, strategy `task_sequence`, three tasks.
Its canonical terminal state is DONE/APPROVE with no failure reason. It reused
eligible completed-task evidence without replaying planning or building, then
obtained fresh head-bound suite proof and reviews after Trident's own in-run
fix worker corrected the fixture. Its original task-2 fix attempt completed
between 05:44:53 and 05:49:19 UTC; no human or external orchestrator edited the
build branch to supply that fix.
Trident itself merged PR #1408 unattended at **2026-09-29 06:15:42 UTC**, from
reviewed head `6454883ebfe919237eaee9ad1e23272a0fc307ba` to merge
`48f84e7264870534090058a4c956a541c0cf2fa6`. The orchestrator independently read
the canonical run, linked Work Board card and GitHub merge receipt. The run
reached merge without human intervention; no manual merge satisfied this test.

### Served-source and absence controls

Actual served `trident/publication.ts`,
`runtime/adapters/claude-code/persistent/build-settings.ts` and
`trident/commit-with-resolved-head.sh` were byte-compared with the served Git
objects. The publisher corroborates the successful create-response PR number
against independent inspection, rejects timed-out responses and records the
receipt before optional annotation. The exact old receipt-dropping discovery
block is absent from served source; the same detector finds it in the salvage
implementation's parent revision, and finds the new callback in served source.

The served Claude settings unconditionally disable session-link attribution;
the served commit wrapper strips anchored session carrier lines. The
orchestrator fetched all six actual #1408 commit messages, including the reviewed
tip, and found no anchored carrier. The same detector finds a synthetic carrier,
and the fetched messages contain known coauthor trailers: neither an empty
history nor a nonmatching detector explains that absence. This control covers
those six messages, not every possible encoding or historical public history.

### Boundaries

The original consuming E2E and bidirectional mutation tests establish the
recovery and salvage seams. The live dispatch establishes the specified served
end-to-end witness; ordinary fresh publication is not represented as a live
salvage interruption. An actual machine restart, interrupted native child,
pending-review checkout recovery and the crash-before-durable-response gap are
not proven here. Their separate work remains open. The independent premerge
trailer scanner retains its own #1222 scope. Parallel-build acceptance and the
remaining efficiency and daily-work cutover criteria are not closed by this
sequence witness.
