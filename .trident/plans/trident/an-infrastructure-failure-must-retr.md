# IMPLEMENTATION_PLAN.md — "An infrastructure failure must retry itself"

Card scope: run `76bb4eca` class of failures — an EXECUTOR that did not answer (codexStatus=deferred), executor timeouts, transport 5xx — must auto-retry bounded, with backoff, visibly, on a budget separate from fix rounds; a GENUINE failure (REQUEST_CHANGES, failing tests, compile error) must never auto-retry. Sequencing prerequisites have all landed (verified against the tree at 93ee20d1).

## Prerequisites — verified SHIPPED in this tree

- [x] Truthful terminal reason (acceptance e): `innerTerminalFailureReason` + measured `terminal_cause` travels out of `inner-workflow.mjs` (`infraCause`/`infraTerminalCause`, `blockKind:'infra-only'`); the "without Argus APPROVE" lie is dead (`trident/terminal-failure-reason.test.ts`). The retry gate can now key off measurement, not fiction.
- [x] Readiness-gate slice (the b122ce3d instance): pending required checks WAIT with a duration-derived budget (`BUDGET_MS`/`RETRY_MS`, attempts DERIVED), shipped PR #279.
- [x] Launcher-crash class of acceptance (a): "a gateway restart must not kill an in-flight build" landed — durable `crash_recoveries` budget (migration 0123), atomic `TridentRunStore.beginCrashRecovery`, §1a-crash recover-don't-reap in `trident/orchestrator.ts` (~line 2475), wired at `gateway/composition/build-core-modules.ts:658`. This is the shared-classifier card the sequencing note said to build on; it is the exact template for this card's mechanics.
- [x] prNumber:0 defect (card 01M01HGAWHA1KBK7CXXHC4R6RH) landed (commit 639399d6) — the largest fake source of `inner-error` is gone, so the remaining inner-error sample is clean enough to classify.
- [x] Per-lane reviewer-deferral retry within a round (`trident/lane-retry.test.ts`, `retryDeferredPeers`) — a single lane timeout no longer becomes a blocker finding.
- [x] Publish-failure classes readable from the stored reason alone (`classifyPublishFailure`: credential vs ref-rejected vs unknown).

## Remaining — this card's unshipped half

- [x] **Run-level infrastructure auto-retry engine** (acceptance a, b, c, and the reason half of e): classify a harvested no-APPROVE terminal result as infrastructure vs genuine from the MEASURED fields (`block_kind:'infra-only'` + `terminal_cause`; `inner-error` only on a closed executor/transport word list); on infrastructure, atomically claim a durable `infra_retries` budget unit (new column, migration 0125, single-writer `beginInfraRetry` mirroring `beginCrashRecovery`), clear the slot and re-fire as a continuation with backoff; past the budget, fail with a reason naming the budget AND the measured cause (never the token "exhausted" — `delivery.ts` pattern-matches it into the review-unresolved class). A genuine REQUEST_CHANGES/compile/test failure stays terminal, pinned by a mutant-killing test.
- [ ] **Visibility** (acceptance d): expose `infra_retry_attempt` on `RunProgress` (`trident/run-progress.ts`) so the board reads retrying-with-attempt-count rather than a run that silently re-runs; render it in the Work Board clients (`landing/chat-react/WorkBoardTab.tsx`, `app/lib/work-board-helpers.ts`); wire the orchestrator's `on_infra_retry` hook (invoked ONLY on attempt 1 — the durable counter is the dedup) through the composition so the owner is told ONCE per run, not once per attempt.

Cross-card note (do NOT build here): `publish-credential` joining the auto-retry class list is acceptance (c) of the publish-credential card 01KZZQ2J9MJFG0PXC8AA6D6EV4 and depends on its deferred-publish state; the classifier built here is the extension point it will join.
