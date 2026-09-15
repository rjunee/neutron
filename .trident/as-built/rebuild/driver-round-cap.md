## 2026-09-15 — Driver review cap follows the host run row

### Change and decisions

- The host reads `max_rounds` from its existing run row and checks run identity (`trident/build-host.ts:74`). The driver observes it once before dispatch, defaults an omitted field on a known row to ten, and rejects invalid numbers (`trident/build-run.ts:170`). This matches the stored default (`trident/store.ts:842`) and retained launcher (`trident/inner-loop.ts:612`). The host observation seam is required in the type (`trident/build-run.ts:93`); the runtime missing-source refusal remains for untyped callers (`trident/build-run.ts:170`).
- The host continuously owns the limit and loop counter: resumed fixes require remaining budget (`trident/build-run.ts:317`), the next review cannot exceed it (`trident/build-run.ts:328`), and both re-plans and ordinary fixes require remaining budget (`trident/build-run.ts:336`, `trident/build-run.ts:351`). Enforcement runs in the driver before dispatch and does not depend on a worker acknowledging exhaustion. Both counters still increment by exactly one (`trident/build-run.ts:325`, `trident/build-run.ts:327`). Approval on the last allowed review remains valid (`trident/build-run.ts:334`; test `trident/build-run.test.ts:697`).
- Repeat-finding escalation remains a separate round-three condition in both resume and ordinary review (`trident/build-run.ts:319`, `trident/build-run.ts:351`). The cap does not change that policy.
- Existing outcome vocabulary applies: unreadable or invalid observations return the nonterminal `unknown` outcome; exhausted budget returns `blocked` to the orchestrator (`trident/build-run.ts:113`, `trident/build-run.ts:148`, `trident/build-run.ts:149`). Exceptions also preserve uncertainty (`trident/build-run.ts:407`). No new outcome or fallback classification was added.
- Positive cases enumerate caps 1, 2, 7 and 12 and compare every review and fix step, with workers claiming round zero and a larger cap (`trident/build-run.test.ts:677`). Host integration exercises the omitted default and explicit caps 2 and 7 (`trident/build-host.test.ts:582`). Resume tests prove the sixth rejected review buys exactly review seven, while rejection at seven buys no fix (`trident/build-run.test.ts:727`).

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


### Follow-up: required dependency contract

Chose required, not optional-and-defaulting: `BuildRunDeps.readReviewCap` is now a required member (`trident/build-run.ts:93`). A known row without a configured field still uses ten; missing, unreadable, thrown, and malformed observations retain the existing nonterminal `unknown` vocabulary (`trident/build-run.ts:170`, `trident/build-run.ts:172`, `trident/build-run.ts:173`, `trident/build-run.ts:174`, `trident/build-run.ts:407`). No new outcome was introduced. The runtime refusal remains for untyped callers; TypeScript continuously enforces the construction contract independently of worker behavior.

Construction sites were enumerated using repository-wide `rg -n 'BuildRunDeps|readReviewCap' --glob '*.ts'` and the root and Trident compiler checks. The four typed dependency objects are the production host (`trident/build-host.ts:72`), shared driver fixture (`trident/build-run.test.ts:28`), Codex corroboration fixture (`runtime/workers/codex-headless.test.ts:103`), and local-merge fixture (`trident/gates/local-merge.test.ts:49`). The latter two now supply known-row readers at lines 104 and 50 respectively. This follows the contract decision; the corroboration assertions retain their independent host measurements (`runtime/workers/codex-headless.test.ts:106`, `runtime/workers/codex-headless.test.ts:131`).

The compiler initially rejected the local-merge construction with TS2741 and the missing-provider deletion with TS2790. The existing unreadable-cap test still exercises missing, unknown and throwing readers with unchanged unknown/no-dispatch assertions (`trident/build-run.test.ts:705`, `trident/build-run.test.ts:714`). Its deliberate deletion now carries `@ts-expect-error` (`trident/build-run.test.ts:711`), making an optional-contract regression fail compilation instead of silently permitting incomplete dependencies.

### Follow-up mutation and validation

| Guard / printed landing line | Mutation | RED evidence | Restored GREEN |
| --- | --- | --- | --- |
| Required reader, `trident/build-run.ts:93` | Restore `readReviewCap?` | `bunx --no-install tsc --noEmit -p trident/tsconfig.json`: exit 2, TS2578 at `trident/build-run.test.ts:711` (unused expected-error directive) | Same compiler command: exit 0 with required member restored |

- Requested command plus the additional touched fixture: `bun test trident/build-run.test.ts trident/build-host.test.ts runtime/workers/ trident/review-round-cap.test.ts trident/gates/local-merge.test.ts`: 247 passed, zero failed, 745 assertions across seven files, repeated after restoring the mutation. This includes the three reported Codex corroboration regressions and G076 certification.
- `bash scripts/ci/lint.sh`: exit 0.
- `bunx --no-install tsc --noEmit -p tsconfig.json` and `bunx --no-install tsc --noEmit -p trident/tsconfig.json`: exit 0.

- `bash scripts/ci/typecheck-all.sh`: 51 configurations checked, 50 passed. The sole failure remains `app/tsconfig.json`, TS2688 for missing implicit type library `@types`, matching the earlier validation above. Root, runtime, and Trident configurations passed in the final matrix. No configuration or dependency files were changed.
- `bash scripts/ci/leak-gate.sh --tree .`: exit 3, incomplete. Zero findings from executed rules; `pii-denylist` and `pii-denylist-msg` could not run because the private denylist input is unavailable. This is not full leak certification.
- `git diff --check` and the exactly-one-level-two-heading check passed.

### Follow-up scope and prose sweep

The G076 product target remains unchanged (`docs/trident-gates-inventory.md:155`), so this follow-up does not revise the spec. Deliberately did not default an absent provider, remove runtime defensive checks, relax assertions, change cap arithmetic, or run the whole test suite.

Searched the whole tree including hidden Markdown with `rg -n --hidden 'optional observation seam|readReviewCap' --glob '*.md' --glob '!node_modules/**' --glob '!.git/**' .`. The old optional-seam sentence in this record was the matching positive control and was corrected in place. This record remains in the task-directed staging location with one level-two heading.
