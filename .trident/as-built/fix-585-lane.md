## 2026-09-14 — Bound subprocess and tree-scan gate tests

### What changed

Seven comparator/guard cases now carry the existing 60-second subprocess budget at scripts/ci/depcruise-ratchet-guard.test.ts:135, scripts/ci/depcruise-ratchet-guard.test.ts:289, scripts/ci/depcruise-ratchet-guard.test.ts:301, scripts/ci/depcruise-ratchet-guard.test.ts:313, scripts/ci/depcruise-ratchet-guard.test.ts:326, scripts/ci/depcruise-ratchet-guard.test.ts:352, and scripts/ci/depcruise-ratchet-guard.test.ts:378. Seven dependency-cruiser/TypeScript-program cases now carry the existing 120-second tree-scan budget at gbrain-memory/__tests__/memory-swap-seam.depcruise.test.ts:133, gbrain-memory/__tests__/memory-swap-seam.depcruise.test.ts:148, gbrain-memory/__tests__/memory-swap-seam.depcruise.test.ts:388, gbrain-memory/__tests__/memory-swap-seam.depcruise.test.ts:398, gbrain-memory/__tests__/memory-swap-seam.depcruise.test.ts:411, gbrain-memory/__tests__/memory-swap-seam.depcruise.test.ts:423, and gbrain-memory/__tests__/memory-swap-seam.depcruise.test.ts:456.

### Decisions

The budgets copy the measured-work conventions already present beside these cases: git/guard subprocess work uses 60 seconds at scripts/ci/depcruise-ratchet-guard.test.ts:252, while full TypeScript-program work uses 120 seconds at gbrain-memory/__tests__/memory-swap-seam.depcruise.test.ts:373. The existing `bun:test` timeout outcome is the vocabulary these changes join; Bun reports the case name and timeout duration by default, so no new error taxonomy or permissive fallback was introduced.

The test runner continuously maintains the bound whenever these files execute. CI directly arms the production depcruise guard at .github/workflows/ci.yml:347; these tests remain ordinary discovered Bun tests and were neither skipped nor retried.

### Mutation evidence

Each budget was mutated alone from its restored value to 1 ms. Before each run, the landed `}, 1)` line and file diff were printed. Every named test went red with `this test timed out after 1ms`; restoration to 60 seconds or 120 seconds returned the timeout line to the locations listed above.

| Guard | Mutation | Red result | Restored result |
|---|---|---|---|
| Comparator CLI at scripts/ci/depcruise-ratchet-guard.test.ts:135 | 60,000 → 1 ms | named timeout | included in 15/15 passing file |
| Growth, equal, and shrink guards at scripts/ci/depcruise-ratchet-guard.test.ts:289, scripts/ci/depcruise-ratchet-guard.test.ts:301, scripts/ci/depcruise-ratchet-guard.test.ts:313 | each 60,000 → 1 ms separately | each named timeout | included in 15/15 passing file |
| Main, bootstrap, and full-clone guards at scripts/ci/depcruise-ratchet-guard.test.ts:326, scripts/ci/depcruise-ratchet-guard.test.ts:352, scripts/ci/depcruise-ratchet-guard.test.ts:378 | each 60,000 → 1 ms separately | each named timeout | included in 15/15 passing file |
| Reject and pass dependency scans at gbrain-memory/__tests__/memory-swap-seam.depcruise.test.ts:133 and gbrain-memory/__tests__/memory-swap-seam.depcruise.test.ts:148 | each 120,000 → 1 ms separately | each named timeout | restored; independent dependency-cruiser output defect described below |
| Alias, re-export, and return scans at gbrain-memory/__tests__/memory-swap-seam.depcruise.test.ts:388, gbrain-memory/__tests__/memory-swap-seam.depcruise.test.ts:398, gbrain-memory/__tests__/memory-swap-seam.depcruise.test.ts:411 | each 120,000 → 1 ms separately | each named timeout | restored scans pass |
| Sink and residual scans at gbrain-memory/__tests__/memory-swap-seam.depcruise.test.ts:423 and gbrain-memory/__tests__/memory-swap-seam.depcruise.test.ts:456 | each 120,000 → 1 ms separately | each named timeout | restored scans pass |

### Validation

`bun test scripts/ci/depcruise-ratchet-guard.test.ts` passed all 15 cases. In `bun test gbrain-memory/__tests__/memory-swap-seam.depcruise.test.ts`, all six TypeScript-program scans passed; the first two pre-existing dependency-cruiser cases failed before assertions because the parser received truncated JSON at gbrain-memory/__tests__/memory-swap-seam.depcruise.test.ts:106. This was not timeout-shaped and the assertions were not weakened.

`bash scripts/ci/lint.sh` passed every reported gate. `bash scripts/ci/typecheck-all.sh` found an environment dependency failure in app/tsconfig.json before completing: TypeScript could not find the `@types` type-definition library. The changed files contain only `bun:test` timeout arguments.

### Deliberately not changed

No retry, skip, global timeout, product code, spec decision, or dependency-cruiser parsing behavior changed. The truncated-output failure is outside issue #585's two-file timeout territory and remains visible rather than being hidden by a loosened assertion.
