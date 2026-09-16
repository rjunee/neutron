## 2026-09-16 — Register verdict gate regex matches

### Change and decision

Fixed registry metadata in tests/integration/identity-env-readers-registry.test.ts:242.
The verdict script masks comment characters with a broad regex at
scripts/ci/trident-verdict.ts:130 and checks bypass reasons with another at
scripts/ci/trident-verdict.ts:688. Both expressions match identity-name candidates.
This is a test-data omission, not an incorrect production predicate: the existing
broad-regex category at tests/integration/identity-env-readers-registry.test.ts:241
explicitly records conservative membership without claiming an environment read.
The note names both expressions and their purposes. Matching expressions were
enumerated by visiting every regex literal in the script with the TypeScript
parser and testing the detector's four identity names.

The existing membership comparison continuously rejects unregistered and stale
entries (tests/integration/identity-env-readers-registry.test.ts:875), independently
of executing the verdict gate. The second failure was the precondition that
unregistered candidates must start undetected
(tests/integration/identity-env-readers-registry.test.ts:957). No new outcome,
guard, runtime path, or product decision was introduced.

### Mutation evidence

| Check | Mutation and applied line | Red result | Restored result |
| --- | --- | --- | --- |
| Exact registry membership and probe precondition | Renamed the new key to scripts/ci/trident-verdict-MUTATED.ts at tests/integration/identity-env-readers-registry.test.ts:242; printed the applied line before execution | Targeted file compiled and ran: 19 pass, 2 fail; original script reported unregistered, mutated key reported stale, original script violated probe precondition | 21 pass, 0 fail, 90 assertions |

The original checkout also reproduced the same two reported failures: 19 pass,
2 fail. Assertions were preserved. The verdict suite passed 137 tests with
570 assertions using bun test scripts/ci/trident-verdict.test.ts.

Repository checks: bash scripts/ci/typecheck-all.sh passed all 51 configurations;
bash scripts/ci/lint.sh exited 0; git diff --check passed. The root package has
no typecheck script, so validation used the repository's CI matrix command.

### Citation corrections and limits

The staged issue had only a direction to the task brief, with no filed citations
to correct. Adding the registry row moved the two observed failing assertion
locations from :880 to :882 and :962 to :964 in
tests/integration/identity-env-readers-registry.test.ts.

The supplied local origin/main ref was inspected with git grep for identity names,
using the registry test as the positive control. That comparison does not verify
current remote main. Remote CI and the live verdict service were not verified;
network operations were prohibited. The full test suite was deliberately not run.
Production behavior, spec decisions, and pre-existing branch history were left
unchanged. This record uses the staging location explicitly required by the lane.
