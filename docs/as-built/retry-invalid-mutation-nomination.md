## 2026-09-18 — Repair deterministic mutation nominations without discarding retry checkpoints

An unchanged-tip retry correctly retained its completed build, but a saved
filename-only guard/control nomination stopped at the mutation gate before the
new worker brief could help. The consuming reproduction on the parent revision
paired this failure with a valid executable-argv nomination that merged without
another build. The original worker artifact remained unchanged in both cases.

The authority is checkpoint continuity in
`docs/spec-items/a-retry-must-resume-from-the-checkpoint.md:13–18`, together with
“Keep the gates, replace the loop” in
`docs/plans/harness-orchestrator-pivot-2026-09-11.md:265–268` and unattended merge
at `:285–288`. G143 remains a refusal to execute invalid nomination paths or argv
(`docs/trident-gates-inventory.md:242`). No runner is inferred from a filename.

`trident/mutation-prover.ts:4753` adds typed repair information only when the
unchanged-head gate has a deterministic `validateClaim` error and the fresh
prover refusal agrees on run, claim, reason and absent observation. The outcome
remains `ok: false`. Missing/null nominations, infrastructure failures,
observed behavioural failures and moving heads remain terminal refusals; this
does not classify every mutation-gate failure as repairable.

`trident/build-host.ts:223` routes that typed refusal to the driver.
`trident/build-run.ts:514` records an actionable rejected checkpoint before
checking the existing round and progress gates, then requests the ordinary fix
worker. The existing fix-head movement, lineage, usage accounting and subsequent
review still apply. Local publication can discover the nomination error after
approval; `trident/build-run.ts:657` returns the repaired revision to review
instead of reusing approval for the old head.

`open/wiring/project-build.ts:401` reads artifacts in their original run
directories through validated retry-source links. A forge envelope must match
its original run and step, schema, completed kind, exact head, and adjacent host
reservation/completion checkpoints. `:487` selects a valid exact-head fix
nomination before the build nomination and also checks its payload commit.
A copied same-head fix without the original completed fix reservation is not
evidence. No receipt or worker envelope is copied or relabelled into the retry.

Verification uses the real project preparation, worker decoder, SQLite store,
dispatch, launcher, driver and prover with temporary Git repositories and a fake
remote PR API (`open/__tests__/project-build-e2e.test.ts:1169`). The saved invalid
claim receives exactly one fix, a newly proved nomination and a new review;
the valid saved claim still merges without plan/build/fix work. Complements
cover repeated invalid fixes, exhausted rounds, forged/wrong-head fixes,
wrong-run/wrong-step artifacts, and local approval followed by repair and a
fresh review (`:1266`). Direct prover controls distinguish invalid argv from
infrastructure, behavioural, missing-claim and moving-head refusals
(`trident/mutation-prover.test.ts:5168`). These are local integration results,
not a claim that a deployed card has merged.

Both TypeScript projects, changed-file lint, and the focused driver/host/prover
plus complete consuming project-build E2E suite were checked. Semantic mutations
were rejected in both directions: suppressing repair fails the invalid-claim
control; granting repair to every prover failure fails the infrastructure
control; restoring build-only artifact selection fails the successful retry;
removing original artifact identity checks fails forged-fix and wrong-run/step
controls. All mutations were restored before the final verification.
