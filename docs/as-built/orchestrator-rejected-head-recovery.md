## 2026-09-29 — One authenticated re-plan from a published rejected checkpoint

Ordinary retry deliberately rejects terminal arithmetic STOP checkpoints. A later
headless preparation failure could also obscure the card's last completed work;
loosening retry's whitelist or restoring a database pointer would erase that
boundary. Issue #1415 instead introduces `work_board_replan_build`, a distinct
project-chat decision with an exact source event, published head, base, PR and
planning direction.

The native Codex owner route supplies a runtime-opaque, invocation-bound authority
which rechecks the active parent turn immediately before admission. A durable
one-use source claim, successor row and compare-and-swap card binding commit in
one transaction. The store rechecks latest source evidence and card history;
later substantive work vetoes selecting an earlier attempt. Source events and
spend are never cleared. The shared Claude stdio bridge cannot establish native
parent provenance and remains fail-closed; this is not full Claude recovery or a
claim that the feature was live-verified.

Admission verifies the open same-repository PR and exact remote branch head.
Launch repeats that check, preserves the original base ancestry, and may recreate
only an absent local branch from the verified published commit. A second legacy
head probe cannot discard the recovery seed or repin its base. Worker preparation
rechecks publication after launch setup awaits. A launch refusal retains the
successor/source link and durably blocks the card; both phone and web render the
reason even when admission created no run.

The startup failed-run sweep excludes a predecessor as soon as its one-use
recovery claim is consumed: the successor owns that published branch. A
recovery-specific launch refusal is also excluded at the central salvage entry
point, before any Git or publisher call. An invalid imported canonical checkpoint
records that refusal instead of falling into the ordinary failed-build salvage
path. The real-Git consumer first demonstrated an unsafe force-with-lease push
of the predecessor's rejected head after remote movement, then observed zero
publisher calls with these guards while an unrelated failed build still salvaged.

The driver imports the review baseline and counters, spends the sole re-plan
allowance before the planner, and performs a full plan/build/fresh-review cycle.
The accepted strategy and task queue remain host-owned. Repeated or worsening
findings still stop, and no approval, provider receipt or mutation proof crosses
the source boundary. G105/G106 continue to require proof for the newly reviewed
head.

Local evidence includes focused admission race/replay/authentication controls,
driver tests for fresh review, repeated/worse findings, second re-plan refusal
and planner-acknowledgment recovery; existing retry, driver, production-host and
tool tests remain green. On the integrated candidate source tree, the complete
`open/__tests__/project-build-e2e.test.ts` consumer passed 511 tests and 7,214
assertions with no failures, and the orchestrator/recovery focused suites passed
345 tests. Both root and Trident TypeScript checks passed. These tests establish
local semantics, not served-code or unattended-merge acceptance; publication CI
and a fresh deployed live recovery remain outstanding. Migrations add the one-use
decision ledger and protected card refusal;
the schema snapshot is regenerated in the same change.

The review-progress guard was mutated in both semantic directions: bypassing it
after the re-plan made repeated and nondecreasing findings merge in two focused
tests; forcing it to block every post-re-plan review rejected a legitimate
decreasing-findings merge. Restored controls passed 3/3. The source-salvage
mutation was the pre-fix production path: the consuming real-Git restart test
went red with actual push/PR calls, and its ordinary-salvage positive control
remained green before and after the fix.
