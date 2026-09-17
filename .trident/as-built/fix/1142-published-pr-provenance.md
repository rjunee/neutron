## 2026-09-17 — Repair migration expectations for publication provenance

### Change and evidence

This CI repair preserves the existing implementation in commit 51fceffa. Its deliberate new migration adds `published_pr` at `migrations/0153_trident_published_pr_provenance.sql:1`. The three reported failures were test defects: their exact expected migration sequences still ended at 152. Added 153 at `migrations/runner.test.ts:220` and `migrations/__tests__/live-ledger-125-repair.test.ts:93,177`.

Kept exhaustive equality rather than deriving expected values from the loader: the explicit-list rationale is recorded at `migrations/runner.test.ts:204-208`. Ledger equality remains checked at `migrations/runner.test.ts:224-229`. No new production outcome or guard was introduced by this repair.

The two test files were enumerated by searching the three supplied test titles. Before editing, `git grep` against cached `origin/main` found the same lists ending at 152 (`migrations/runner.test.ts:219`, `migrations/__tests__/live-ledger-125-repair.test.ts:93,177`); the branch diff identifies migration 153 as this branch's addition. The comparison does not establish remote freshness.

### Mutation table

These are expectation rollback mutations, not changes to production guards. Each executed successfully and returned the wrong expected sequence; all three mutated sites were printed before running the tests.

| Check | Mutation | RED | Restored GREEN |
| --- | --- | --- | --- |
| Fresh migration sequence, `migrations/runner.test.ts:220` | Remove 153; printed previous terminal entry at :219 | First-apply test failed on received extra 153 | First-apply test passed |
| Repaired live ledger, `migrations/__tests__/live-ledger-125-repair.test.ts:93` | Remove 153 from exact list; printed :93 | Live incident test failed on received extra 153 | Live incident test passed |
| Live ledger without repair entry, `migrations/__tests__/live-ledger-125-repair.test.ts:177` | Remove 153 from exact list; printed :177 | Missing-entry test failed on received extra 153 | Missing-entry test passed |

Initial isolated reproduction: runner file 21 pass / 1 fail; live-ledger file 2 pass / 2 fail. Combined mutation run: 23 pass / 3 fail. Restored `bun test migrations/runner.test.ts migrations/__tests__/live-ledger-125-repair.test.ts`: 26 pass / 0 fail, 276 assertions.

### Local gates

`bash scripts/ci/typecheck-all.sh` exited 0: all 51 configurations passed. `bash scripts/ci/lint.sh` exited 0. `git diff --check` passed. `bash scripts/ci/leak-gate.sh --tree .` exited 3: zero findings from executed rules, but the external PII denylist was unavailable for files and messages. That gate is incomplete, not clean.

### Citation corrections

The filed issue's fresh-build refusal citation moves from `trident/build-run.ts:247` to `trident/build-run.ts:269-270` on this checkout; cached main has it at :265. The filed discovery citation remains `trident/launch-preparation.ts:201`, with the resulting observed PR assignment at :203-204. Earlier implementation records describe their own revision, not this repair's current line positions.

### Decisions and limits

Used the lane-requested `.trident/as-built/` location. No product decision changed; no spec update was needed. Deliberately did not rebuild or alter the provenance implementation, migration runner, historical ledger behavior, or existing assertions beyond the three expected ordinals. Did not run the full suite, fetch, push, open a PR, or merge.

Could not verify hosted CI, the historical hosted run, or freshness of cached main in this offline lane. The prior implementation's ownership mutations were not rerun for this test-only repair.

The repair file list was enumerated with `git diff --name-only` and `git ls-files --others --exclude-standard`: the two cited test files and this record.
