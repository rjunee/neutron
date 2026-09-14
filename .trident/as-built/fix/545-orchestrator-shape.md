## 2026-09-14 — Give terminal escalation wakes a decision contract (#545 first slice)

### Scope and result

This is a preparatory handoff slice of #545, **not completion of the orchestrator
rebuild**. The terminal acting turn previously selected recovery advice from only
the failure reason. It now uses the same validated escalation classification as
the board and delivery, passes decoded evidence, and selects sequencing or plan
investigation instead of generic retry advice
(`gateway/proactive/terminal-build-wake.ts:30`, :40, :81).

The project-session replacement remains unbuilt. The current wake is composed
through the separate background substrate (`open/composer.ts:4338`), while the
target calls for the project conversation to own orchestration
(`docs/plans/harness-orchestrator-pivot-2026-09-11.md:81`). The runtime already keys
sessions by project (`runtime/adapters/claude-code/persistent/pool.ts:292`) and
exposes scoped board tools (`work-board/agent-tool.ts:227`). Replacing launch,
workflow control, checkpoint/result transport, recovery and terminal ownership is
larger than this slice. This change replaces one consumer's escalation policy in
place; it does not install another live loop or a selectable implementation.

The issue staged for this lane is an umbrella summary. Its referenced design
file was unavailable: enumerating `rg --files docs` and filtering with
`(trident-autonomy-implementation-plan|harness-orchestrator-pivot-2026-09-11)` found
only `docs/plans/harness-orchestrator-pivot-2026-09-11.md` (positive control).
The written pre-code scope and gate inventory are in the lane's external progress
log. No unavailable plan was reconstructed as a product decision.

### Authority and vocabulary

The existing escalation vocabulary is exported at `trident/inner-loop.ts:200`.
The shared deriver requires a failed, harvested, matching escalation and returns
null otherwise (`trident/escalation-block.ts:94`). Null keeps ordinary failure
recovery; missing-dependency selects sequencing; the other recognized escalation
kinds select plan investigation (`gateway/proactive/terminal-build-wake.ts:81`).
No error, status, or routing kind was added.

The instruction requires independently identifying existing cards from the board
and specs, then making and reporting the sequencing decision. Unknown identities
require clarification; absent cards require spec-first intake. It asks for a
board read after reordering and an honest unresolved report after refusal
(`gateway/proactive/terminal-build-wake.ts:84`, :86). A prompt is not a machine
security boundary and does not prove the model performs those actions.

The machine boundary is unchanged: the run reconciler receives only detachRun
(`trident/board-reconcile.ts:49`, :116), and blocked dispatch returns card_blocked
before dispatch (`trident/board-dispatch.ts:623`). These host checks do not depend
on the failed worker following the new advice. The acting agent still has the
existing board tools and authority to resolve a block; this slice adds no new
board capability to the run.

### Gates retained

Enumerated from the six-item keep-list at
`docs/plans/harness-orchestrator-pivot-2026-09-11.md:261`; each implementation was
read and found with positive grep matches for its named symbol or refusal:

- Leak preflight: `trident/orchestrator.ts:2789`.
- Pinned merge refusal: `trident/merge.ts:1767`.
- Cross-model deferral: `trident/inner-workflow.mjs:7079`.
- Seat rotation persistence: `trident/codex-rotation-store.ts:142`.
- Mutation prover invocation/refusal: `trident/orchestrator.ts:5285`, :5327.
- Arbiter forbidden options: `trident/arbiter.ts:78`, :99.

Approval provenance also remains at `trident/orchestrator.ts:5216`. These modules
have no final diff in this slice; this is preservation by scope, not a claim that
all gate suites were rerun. Host responsibilities also extend to cleanup and
as-built promotion (`trident/orchestrator.ts:5356`, :5366); a later loop replacement
must keep those responsibilities too.

### Mutation evidence

Every mutation was printed at its landed line, executed, and restored before the
next mutation. Wake tests refer to
`gateway/proactive/__tests__/terminal-build-wake.test.ts`.

| Boundary | Mutation and landed line | Red | Restored green |
| --- | --- | --- | --- |
| Evidence reaches acting turn | Replace evidence condition with false, `gateway/proactive/terminal-build-wake.ts:40` | 1 wake test failed | 16 passed |
| Dependency selects sequencing | Invert kind comparison, `gateway/proactive/terminal-build-wake.ts:83` | 2 wake tests failed | 16 passed |
| Escalation replaces retry | Replace instruction operand with null, `gateway/proactive/terminal-build-wake.ts:88` | 3 wake tests failed | 16 passed |
| Stale result cannot select escalation | Remove harvested refusal, `trident/escalation-block.ts:100` | 1 wake test failed | 16 passed |
| Run cannot reorder | Insert payload-driven board.reorder at `trident/board-reconcile.ts:117` | 2 existing boundary tests failed; real sort order changed | 2 passed |

The existing hostile reorder fixture is
`trident/escalation-block.test.ts:537`; the capability fixture is :579. The new
observer test at `gateway/proactive/__tests__/terminal-build-wake.test.ts:51`
checks the actual composed AgentSpec and posting path, including removal of
unrecognized payload fields. The negative classifier cases at :81 include a
positive control so a consumer that never recognizes escalations fails too.

### Acceptance and deliberate limits

The final unchecked box in
`docs/spec-items/the-review-loop-must-stop-and-re-plan.md:116` stays unchecked.
No test in this change proves an actual project orchestrator decides, executes
and reports a reorder. The tests prove the evidence and instruction delivered
to the current acting turn and the retained run authority boundary. Do not close
#545 on this commit.

No project-session migration, durable wake retry, workflow replacement, new
board operation, change to model splitting, spec decision change, push, PR or
merge is included. The guard-preserving loop replacement remains the umbrella's
main outstanding work.

### Validation

- `bun test gateway/proactive/__tests__/terminal-build-wake.test.ts trident/escalation-block.test.ts`: 45 passed, zero failed. All temporary mutations restored and each affected test file rerun green.
- `bash scripts/ci/typecheck-all.sh`: all 51 configurations passed. This is the repository's typecheck command; the root package has no typecheck script.
- `bash scripts/ci/lint.sh`: passed.
- `git diff --check`: passed. Exactly one top-level record heading; the staging directory's existing .gitkeep is retained.
- `bash scripts/ci/leak-gate.sh --tree .`: exit 3, INCOMPLETE. Zero findings from available rules; the private PII file/message rules could not run because the out-of-band denylist is unavailable. This is not a clean purity result.

Only targeted test files ran; no full test suite or live model invocation ran.
