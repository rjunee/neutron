## 2026-09-15 — Driver review cap follows the host run row

### Change and decisions

- The host reads `max_rounds` from its existing run row and checks run identity (`trident/build-host.ts:74`). The driver observes it once before dispatch, defaults an omitted field on a known row to ten, and rejects invalid numbers (`trident/build-run.ts:170`). This matches the stored default (`trident/store.ts:842`) and retained launcher (`trident/inner-loop.ts:612`). The optional observation seam fails closed when missing, rather than granting standalone callers an implicit budget.
- The host continuously owns the limit and loop counter: resumed fixes require remaining budget (`trident/build-run.ts:317`), the next review cannot exceed it (`trident/build-run.ts:328`), and both re-plans and ordinary fixes require remaining budget (`trident/build-run.ts:336`, `trident/build-run.ts:351`). Enforcement runs in the driver before dispatch and does not depend on a worker acknowledging exhaustion. Both counters still increment by exactly one (`trident/build-run.ts:325`, `trident/build-run.ts:327`). Approval on the last allowed review remains valid (`trident/build-run.ts:334`; test `trident/build-run.test.ts:697`).
- Repeat-finding escalation remains a separate round-three condition in both resume and ordinary review (`trident/build-run.ts:319`, `trident/build-run.ts:351`). The cap does not change that policy.
- Existing outcome vocabulary applies: unreadable or invalid observations return the nonterminal `unknown` outcome; exhausted budget returns `blocked` to the orchestrator (`trident/build-run.ts:113`, `trident/build-run.ts:148`, `trident/build-run.ts:149`). Exceptions also preserve uncertainty (`trident/build-run.ts:407`). No new outcome or fallback classification was added.
- Positive cases enumerate caps 1, 2, 7 and 12 and compare every review and fix step, with workers claiming round zero and a larger cap (`trident/build-run.test.ts:677`). Host integration exercises the omitted default and explicit caps 2 and 7 (`trident/build-host.test.ts:582`). Resume tests prove the sixth rejected review buys exactly review seven, while rejection at seven buys no fix (`trident/build-run.test.ts:722`).

### Mutation evidence

Each row was applied independently, its actual landing line printed, and executed with `bun test trident/build-run.test.ts trident/build-host.test.ts -t '<named test>'`. Bun compiled and executed the mutated TypeScript; every RED was an assertion failure, not a parse failure. Each mutation was then restored and the same test returned exit zero. Rows enumerate the 13 executed mutations, not exhaustive branch coverage.

| Guard / landing line | Compiling mutation | Red test (name prefix) | Mutated / restored |
| --- | --- | --- | --- |
| Missing source, `trident/build-run.ts:170` | Return blocked instead of unknown | G076 unreadable cap | RED / GREEN |
| Missing row, `trident/build-host.ts:76` | Remove `!row` clause | G076 host refuses | RED / GREEN |
| Ordinary ceiling, `trident/build-run.ts:351` | `round >= 5` | G076 configured cap 7 | RED / GREEN |
| Resumed ceiling, `trident/build-run.ts:317` | `firstRound >= 5` | G076 resumed rejection | RED / GREEN |
| Host counter authority, `trident/build-run.ts:351` | Compare against `maxRounds + round - Number((result.payload as { round?: number }).round ?? round)`; a reported zero raises the effective ceiling | G076 configured cap 2 | RED / GREEN |
| Ordinary increment, `trident/build-run.ts:327` | `round += 2` | G076 configured cap 7 | RED / GREEN |
| Resumed increment, `trident/build-run.ts:325` | `firstRound += 2` | G076 resumed rejection | RED / GREEN |
| Review entry, `trident/build-run.ts:328` | `if (false)` | G076 over-budget resume | RED / GREEN |
| Re-plan budget, `trident/build-run.ts:336` | `if (false)` | G076 re-plan | RED / GREEN |
| Numeric validation, `trident/build-run.ts:174` | `if (false)` | G076 malformed cap | RED / GREEN |
| Unreadable observation, `trident/build-run.ts:172` | Return blocked instead of unknown | G076 unreadable cap | RED / GREEN |
| Run identity, `trident/build-host.ts:76` | Remove identity mismatch clause | G076 host refuses | RED / GREEN |
| Host threading, `trident/build-host.ts:77` | Return known without the configured field | G076 host threads run row cap 7 | RED / GREEN |

The worker-round mutation reaches the ordinary ceiling with a valid, corroborated snapshot and nonempty, distinct findings; its extra fix is observed by the exact fix-step assertion (`trident/build-run.test.ts:687`, `trident/build-run.test.ts:691`). The review-entry guard still stops the subsequent review, so the test measures the unauthorized fix itself.

### Validation

- `bash scripts/ci/lint.sh`: passed.
- `bash scripts/ci/typecheck-all.sh` checked 51 configurations. Its Trident optional-property errors were fixed and the Trident check rerun successfully. The remaining matrix failure is `app/tsconfig.json`: TS2688, missing implicit type library `@types`, reproduced with `bunx --no-install tsc --noEmit -p app/tsconfig.json`. The matrix is therefore not fully green; no app configuration or dependency files were changed. The changed-file list was enumerated with `git diff --name-only`.
- `bunx --no-install tsc --noEmit -p trident/tsconfig.json`: passed after correcting exact optional-property types; no assertions were relaxed.
- `bun test trident/build-run.test.ts trident/build-host.test.ts trident/review-round-cap.test.ts`: 165 passed, zero failed, 549 assertions after restoration. Existing G076 certifications remain included (`trident/review-round-cap.test.ts:93`, `trident/review-round-cap.test.ts:109`).

### Scope and historical prose

Implemented the existing G076 target (`docs/trident-gates-inventory.md:155`); no product decision changed. Deliberately left the retained loop, workflow script, provider selection, and out-of-scope modules untouched. Did not run a suite sweep or perform network operations.

Searched Markdown throughout the tree, including hidden as-built records, with `rg -n 'hard ceiling stops at five|configured cap' --glob '*.md' . .trident`. Positive control: the configured-cap inventory sentence at `docs/trident-gates-inventory.md:155`. The old five-round assertion at `.trident/as-built/rebuild/driver.md:15` remains as immutable history; this record supersedes its driver behavior. The separate Ralph planner refresh interval is unrelated (`trident/build-run.ts:227`).
