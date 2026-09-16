## 2026-09-16 — Repair state-reaper CI test contracts

### Change and evidence

Both fixes correct tests. The reaper accumulates ids in directory iteration order (`open/wiring/project-build-state-reaper.ts:24`, `open/wiring/project-build-state-reaper.ts:31`, `open/wiring/project-build-state-reaper.ts:41`). Its test now sorts the returned ids before exact equality (`open/__tests__/project-build-state-reaper.test.ts:36-39`); deletion and retention assertions remain at lines 43-49. This preserves exact membership, including multiplicity, without imposing a filesystem ordering contract. Reversing iteration reproduced the original mismatch locally, despite the unmodified test initially passing.

The existing branch deliberately registers and starts the new supervised loop (`open/composer.ts:4343-4355`, original commit e1d57c22). The boot inventory test now expects it at `open/__tests__/loop-inventory-boot-shell.test.ts:63`. Both the exact registry assertion at line 165 and emitted count/name assertions at lines 199-200 use that list. This follows the already-updated composer inventory at `open/__tests__/loop-inventory-open-composer.test.ts:64-67`. Stale header counts were replaced with a reference to the expected list (`open/__tests__/loop-inventory-boot-shell.test.ts:5-7`).

### Decisions

No production behavior, outcome vocabulary, retention policy, or product decision changed. No new runtime guard was added. The existing continuous cleanup mechanism remains the immediate/hourly supervised loop and shutdown cleanup at `open/composer.ts:4343-4355`. The expected boot inventory was inspected through its explicit list and the existing branch diff; runtime boot enumeration could not complete locally.

### Mutation evidence

All mutations were temporary, their actual modified source lines were printed, and each executed under Bun before restoration.

| Property | Mutation | Result | Restored result |
|---|---|---|---|
| Enumeration order is not membership | Reverse-sort entries before iteration at `open/wiring/project-build-state-reaper.ts:31` | Original test: 1 fail, received failed-old before done-old; repaired test: 2 pass | Reaper tests: 2 pass |
| Exact terminal membership remains enforced | Invert terminal classifier at `open/wiring/project-build-state-reaper.ts:37` | 1 fail, received live-old instead of done-old and failed-old | Reaper tests: 2 pass |
| Composer inventory detects missing registration | Comment out registration at `open/composer.ts:4353` | Composer test file: 3 fail, 3 pass | Composer test file: 6 pass |

Final restored targeted run: `bun test open/__tests__/project-build-state-reaper.test.ts open/__tests__/loop-inventory-open-composer.test.ts` — 8 pass, 0 fail, 112 assertions.

### Citation corrections and search evidence

The staged brief contains only “No filed issue — the task is stated in this brief.” at line 1. It supplied no code citations to correct. The previous branch record cites the composer inventory at lines 63-66; in this checkout its reaper comments are at lines 64-66 and the expected name is at line 67. The task's test titles resolve to reaper test line 16 and boot test lines 163 and 180 after this edit (formerly 164 and 181).

A whole-tree `rg` for `starts 7 loops|adds the 8th` over TypeScript and Markdown returned no remaining hits. Positive control: the same alternatives extended with `EXPECTED_RUNNING_LOOPS` matched the edited boot test at lines 6, 43, 165, 199 and 200. Only the stale header's assertion was corrected; the expected list remains the single literal used by the two boot checks.

### Not verified and deliberately not done

- The boot test file was run before and after the repair: both runs failed all three tests at socket binding (`gateway/index.ts:906`) with port-zero EADDRINUSE, before inventory assertions. A minimal `Bun.serve` listener on loopback and port zero failed identically. Boot green and boot-specific mutation results are unknown, not successful. The composer mutation above does not substitute for boot verification.
- The CI-reported reaper failure was not reproduced with native local enumeration; it was reproduced by explicitly reversing the iteration order.
- No full suite, network operation, push, PR creation, merge, production-data cleanup, or history rewrite was performed.
- The as-built location follows the explicit lane instruction overriding the general docs/as-built convention. No spec update is warranted by these test-contract corrections.

### Static validation

- `bash scripts/ci/lint.sh`: exit 0, all reported static gates green.
- `git diff --check`: exit 0.
- `bash scripts/ci/leak-gate.sh --tree .`: incomplete; zero findings from executed rules, external PII denylist checks could not run.
- `bash scripts/ci/typecheck-all.sh`: exit 0, all 51 configurations passed.
