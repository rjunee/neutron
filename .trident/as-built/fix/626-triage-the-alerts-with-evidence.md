## Issue 626 — reconcile the remaining CodeQL alerts with recorded evidence

### Result and enumeration boundary

No runtime or workflow change was needed on this branch. The supplied alert export contains 46 historical rows. I enumerated it without sorting or filtering using `jq -r '.[] | [.number,.rule,.severity,.path,.start_line] | @tsv' ../briefs/codeql-alerts-table.json`; it is the only alert list available in this no-network lane.

Merged work classified every one of those 46 rows as 36 false positives, eight real deferred findings, and two real fixed findings (`.trident/as-built/fix/646-codeql-triage-second-pass.md:3-58`). The two original fixes are alerts 9 and 47 (`.trident/as-built/fix/646-codeql-triage-second-pass.md:23`, `.trident/as-built/fix/646-codeql-triage-second-pass.md:55`). The eight deferred findings were subsequently bounded before their flagged expressions: alerts 26, 29, 34, 35, 40, 42, 43, and 44 (`.trident/as-built/fix/712-bound-redos-inputs.md:5-15`). Subtracting those ten alert numbers from the 46-row export leaves exactly these 36:

`1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 27, 28, 30, 31, 32, 33, 36, 37, 38, 41, 45, 46`.

That set contains 34 high-severity rows and the two medium stack-trace rows, 23 and 24. The disposition evidence is already recorded per alert: content-transform findings at `.trident/as-built/fix/646-codeql-triage-second-pass.md:13-22`, randomness and hashing findings at `.trident/as-built/fix/646-codeql-triage-second-pass.md:24-33`, ReDoS findings at `.trident/as-built/fix/646-codeql-triage-second-pass.md:34-54`, and stack-trace/XSS findings at `.trident/as-built/fix/646-codeql-triage-second-pass.md:56-58`. The shared absence claims include their positive controls at `.trident/as-built/fix/646-codeql-triage-second-pass.md:60-62`.

The current live alert payload was not available, so this record does not claim to have independently observed the remote 36-row set or changed any alert state. It reconciles the task brief's measured count against the complete supplied export and the merged per-alert decisions. If a current alert is not one of the 36 IDs above, the local materials are insufficient to adjudicate it and it must stay open.

### Decisions and scope

The workflow statement remains untouched: it says `test` is the sole required status check (`.github/workflows/ci.yml:167-172`), matching the re-scoped task. No alert was dismissed merely to lower the count, and no duplicate suppression or alternate code path was added.

There is no new guard to mutation-check and no source test to add: the security fixes and their bidirectional mutation evidence shipped with the changes that earned them (`.trident/as-built/fix/646-codeql-triage-second-pass.md:64-76`, `.trident/as-built/fix/712-bound-redos-inputs.md:17-33`). This branch adds only the missing reconciliation between the measured 36-open count and those existing dispositions.

| Guard | Mutation | Red | Restored green |
|---|---|---|---|
| None added on this branch | Not applicable | Not applicable | Not applicable |

The arithmetic check over the supplied table returned 46 total rows and, after excluding the ten fixed IDs, 36 rows: 34 high and 2 medium, with the exact ID set recorded above. `bun test scripts/ci/ci-workflow.test.ts` passed 79 tests. `bash scripts/ci/typecheck-all.sh` checked 51 TypeScript configurations: 50 passed, while untouched `app/tsconfig.json` failed because its local dependency tree lacks the implicit `@types` entry. `bash scripts/ci/lint.sh` passed every reported gate with zero findings; `git diff --check` passed. No test file was touched, so there is no new branch guard to mutation-check. `SPEC.md` is unchanged because no product decision changed.
