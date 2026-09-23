## 2026-09-23 — Compare equivalent efficiency benchmark scopes

The existing six consuming benchmark scenarios recorded counts, scripted stage
intervals and gate decisions, but their reports could not identify unequal task,
gate or model scope. Issue #1196 requires those cases to remain unmatched
(`docs/spec-items/trident-build-efficiency.md:203-217`).

`open/__tests__/project-build-e2e.test.ts` now includes the fixed fixture contract,
task text, observed gate names, full/intermediate suite strategies, round limit
and merge mode in each report. Provider, requested/resolved model, worker role,
review seat and placement come from the durable attempt ledger. Repeated calls
retain their dispatch counts while scope comparison uses distinct assignments.

`compareEfficiency` in the existing benchmark fixture reports `unmatched` with
specific reasons for missing or unequal scope. Matched workloads must retain
identical gate decisions and terminal outcomes. The machine-readable report
includes the comparison result. Scheduling, observation order and duplicate
model assignments do not by themselves change scope. The existing serial-review,
redispatch and required-fresh-work checks remain intact across all six scenarios.

The 29 oracle tests pass. Semantic mutations were exercised and restored:
accepting unequal scopes failed all 17 mismatch controls; rejecting an equivalent
scope failed its positive control; accepting changed gate decisions or outcomes
failed both refusal controls. These were assertion failures, not parser errors.
Both root and Trident TypeScript projects passed.
The explicit `open/__tests__/project-build-e2e.test.ts` run passed all 209 tests
with local broker socket access enabled; the restricted run had nine socket
permission failures. All six emitted benchmark comparisons were matched. The
tree leak gate was not green: an archive of the base revision reported 455
findings, while the worktree reported those counts plus its local Git pointer.

This is offline comparison evidence using scripted workload units. The fixture
identity scopes its scripted provider outcomes and boundaries; it is not a
general comparator for arbitrary live runs. Token and cost measurements remain
unknown. No live deployment, direct-orchestration saving or unattended Work Board
merge is established by this change; #1196 retains those acceptance obligations.
