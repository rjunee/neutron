## 2026-09-23 — Deterministic consuming-path efficiency benchmark

Implements the offline benchmark portion of
`docs/spec-items/trident-build-efficiency.md:203-208` for issue #1196. This does
not establish the deployed/live acceptance or close that issue.

The benchmark in `open/__tests__/project-build-e2e.test.ts` runs fresh build,
code-fix, unchanged-head recovery, moved-head recovery, transient merge failure,
and lost review acknowledgement through the real project composition, driver, gates, SQLite,
temporary Git origin, dependency preparation, and Claude session lock. Only
the existing harness boundaries supply scripted model responses, GitHub API
responses and a silent leak scanner. Each schedule uses the same fixed task,
provider/model scope and findings. Real gate results are recorded without
replacing their decisions.

The before fixture is a controlled reconstruction of the serial paid-review
constraint documented at `docs/spec-items/trident-build-efficiency.md:54-67`,
pinned there to revision `7d5ca4bd`; it also removes the preparation receipt
before each preparation to reproduce pre-receipt installation. It does not
pretend to replay the historical live run, invent its token consumption, or
attribute all recovery work to waste. The candidate uses a three-producer
barrier crossing the real consumer lock. Its deadline only releases deadlocked
children and fails the test; success requires all producers to enter before
any is released.

Results: fresh has one plan, one build, three independent reviews and one
synthesis; the code-fix scenario adds one fix and another complete review set.
Unchanged-head recovery retains one plan/build pair; moved-head recovery
requires two. The moved-head scenario interrupts after the first head's proof
and approval, then requires fresh build, review and proof for the new head.
A merge API refusal resumes the approved head and merges without
new paid work. A completed review whose acknowledgement is lost must recover its
original request, clear the pending identity and merge without buying another
review. An unresolved outcome is not benchmark success.
The benchmark requires one proof per scenario, or two for code-fix and moved-head.
Its same-head control exposed an additional proof caused by an in-memory suite
receipt, while moved-head recovery exposed standalone review reuse across heads
(five review calls instead of six). The integrated durable suite and measured-head
review identities make both controls green: one proof for unchanged-head recovery,
six independent review calls and two proofs for the moved-head scenario.
For the passing scenarios, before/after gate-decision sequences and terminal
outcomes match. The stable second preparation saves
exactly one install; revision changes still install and all preparations verify.

`TRIDENT_EFFICIENCY_REPORT=1 bun test open/__tests__/project-build-e2e.test.ts
--test-name-pattern 'deterministic efficiency benchmark'` emits JSON records
with dispatch/setup/proof counts, decisions and stage intervals. The intervals
use explicit deterministic workload units, not observed milliseconds; their
purpose is to expose sequencing and overlap without flaky speed thresholds.
Nested/overlapping intervals are not summed as elapsed time. Token and cost
fields stay null. Actual host times, token observations, deployed symbols and
a fresh unattended live merge remain the separate live-evidence requirement.

The earlier five-scenario implementation passed 163 consuming/oracle tests and
both TypeScript projects. Strengthening the infrastructure and moved-head cases
then exposed the two regressions above; the integrated nonpending scenarios now
pass all five controls. Production semantic
mutations were killed: awaiting standalone before starting panel observation
fails the fresh barrier; disabling same-head build reuse while assigning new
worker identities fails the unchanged-head dispatch count; dropping approved
checkpoint reuse while advancing its round fails the interruption review count.
Those mutations are restored.
The oracle also tests both extra and skipped required work, serial/missing review
and changed outcomes. Final combined verification, leak comparison, independent
review and deployment proof remain required before publication/merge.
