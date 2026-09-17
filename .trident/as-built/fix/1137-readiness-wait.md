## 2026-09-17 — Preserve approval when post-review readiness expires

### Change and evidence

The driver now records a schema-valid worker APPROVE after checking its revision against the host observation (`trident/build-run.ts:401-408`). This awaited write precedes the post-review CI observation and its terminal unknown return (`trident/build-run.ts:552-556`). The required host effect is carried by `trident/build-host.ts:33,87`, supplied by the project composition at `trident/project-build-host.ts:95`, and writes the run column at `trident/production-host-effects.ts:443-448`.

The existing verdict vocabulary is APPROVE, REQUEST_CHANGES and REVIEW_NOT_RUN (`trident/store.ts:68`). This change records the existing APPROVE value; it adds no outcome. The existing failure path preserves stored APPROVE while keeping the failed phase and readiness reason (`trident/orchestrator.ts:1475-1485,2975-2981`). The merge-eligible approved checkpoint still follows panel, suite and CI decisions (`trident/build-run.ts:558-581`). Persisting worker evidence does not grant that checkpoint.

### Design and maintenance

Chose durable recording before the readiness wait over carrying approval in the unknown result serialization. The latter currently emits only projectBuild (`trident/project-launcher.ts:75`), and its harvest reads the existing row directly (`trident/orchestrator.ts:2975-2978`); enriching that envelope alone would not repair the row. The awaited database write makes evidence independent of the failing CI observer and the completed review worker (`trident/build-run.ts:408,554`; `trident/production-host-effects.ts:447`). When a step supplies the workflow columns it read, the tick forwards them to the existing conditional save; other steps save normally (`trident/tick.ts:844-854`; `trident/store.ts:2030-2038`).

This closes the requested APPROVE exhaustion gap. It does not change the interpretation of COMMENT or rejection findings: the storage vocabulary has no COMMENT (`trident/store.ts:68`), and this guard accepts only validated APPROVE (`trident/build-run.ts:408`). No product decision or readiness budget changed. The existing bounded wait remains in `trident/gates/review-readiness.ts:75-108`.

### Reproduction and verification

The integration fixture uses a real migrated database, production persistence effect, readiness classifier and injected elapsed clock, then projectBuildResult, orchestrator.step and saveIfActive. Mergeability remains UNKNOWN throughout the budget. The stored terminal row is failed with a budget-exhaustion reason and APPROVE (`trident/build-run.test.ts:1515-1558`). Before the fix it failed with expected APPROVE, received REVIEW_NOT_RUN. The malformed and COMMENT controls ensure the new writer cannot invent an approval (`trident/build-run.test.ts:1563-1577`).

A Bun toMatchObject matcher modified the outcome detail during initial fixture diagnosis. The assertion operates on a structured clone so the real serialized result retains its string (`trident/build-run.test.ts:1541,1546`); the assertion itself was retained.

| Guard | Mutation and printed landing line | RED result | Restored GREEN |
|---|---|---|---|
| Driver records validated approval | Omit callback at `trident/build-run.ts:408` | APPROVE expected, REVIEW_NOT_RUN received | Integration test passes |
| Approval requires valid schema and verdict | Replace predicate with true at `trident/build-run.ts:408` | Both negative controls receive an incorrect APPROVE | Both controls pass |
| Approval reaches durable storage | Omit update at `trident/production-host-effects.ts:447` | APPROVE expected, REVIEW_NOT_RUN received | Integration test passes, including persisted terminal row |

Mutation commands used `bun test trident/build-run.test.ts -t` with the integration test title or `review evidence does not record`; all mutated lines were printed with rg. Restored targeted run: 3 passed, 17 assertions.

Scoped regression command: `bun test trident/gates/review-readiness.test.ts trident/build-run.test.ts trident/project-build-host.test.ts trident/build-host.test.ts trident/gates/local-merge.test.ts` — 277 passed. This includes the requested 213 existing tests and three added tests. `bun test trident/production-host-effects.test.ts` — 64 passed. `bun test runtime/workers/codex-headless.test.ts` — 24 passed. Repository lint (`bash scripts/ci/lint.sh`) passed; the subsequently updated runtime fixture also passed scoped ESLint. Dependencies were installed with real `bun install`; workspace-package resolution was verified inside the build worktree.

The repository typecheck matrix enumerated 51 configurations. It exposed the required-effect fixture omission in the runtime and root configurations; after updating `runtime/workers/codex-headless.test.ts:137`, both `bunx tsc --noEmit -p runtime/tsconfig.json` and `bunx tsc --noEmit -p tsconfig.json` passed. The other 49 configurations passed in the matrix, including trident. `git diff --check` passed.

### Scope and limits

The requested change preserves approval evidence; it does not rebuild the reviewed readiness fix, change failedRun, alter merge gates, introduce a feature flag, or redesign rejection storage. External services were simulated; no live remote run was attempted. The whole test suite was not run. Work is committed locally for orchestrator review, without publishing or merging.

Leak gate: zero findings from available rules, but INCOMPLETE because the private PII denylist rules could not run. This is not claimed as a clean leak-gate result.
