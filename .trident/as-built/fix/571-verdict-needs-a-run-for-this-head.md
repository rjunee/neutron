## 2026-09-14 — lane review requires CI for the exact head

### What changed

The review tool now resolves the subject commit and asks GitHub for the pull-request `ci.yml` run filtered to that SHA (`tools/lane_review.sh:78-82`). It validates that a row exists and that the returned row names the resolved SHA before interpreting status or conclusion (`tools/lane_review.sh:86-99`). A successful completed run proceeds to the existing delivery analysis (`tools/lane_review.sh:103-105`); a completed non-success run exits through the finding outcome (`tools/lane_review.sh:99-101`).

The test harness supplies a local `gh` executable whose response is controlled per invocation (`tools/lane_review.test.ts:87-102`). Direct tests cover an unreadable query, no row, a row for another head, completed success and failure, and an incomplete exact-head run (`tools/lane_review.test.ts:451-489`).

### Decisions

The query targets `actions/workflows/ci.yml/runs`, not the repository-wide runs endpoint, because only the aggregate CI workflow completion establishes that the workflow finished (`tools/lane_review.sh:80-82`). The SHA returned in the selected row is still compared with the locally resolved branch commit before status or conclusion is read (`tools/lane_review.sh:90-99`), so filtering is not treated as proof of provenance.

No new public exit value was introduced. The existing vocabulary is documented at `tools/lane_review.sh:15-21`: exit 0 is a positive result, exit 1 is a finding, and exit 2 means the check could not establish an answer. Missing, unreadable, incomplete, and wrong-head runs default to exit 2 (`tools/lane_review.sh:80-97`); completed non-success runs use exit 1 (`tools/lane_review.sh:99-101`). The invariant is maintained on every invocation by the live workflow-run query and local SHA comparison, independent of the process that launched CI (`tools/lane_review.sh:78-99`).

### Mutation table

| Guard | Mutation | Red result | Restored result |
|---|---|---|---|
| Query failure at `tools/lane_review.sh:80` | Removed `!` from the command-status condition; printed the landed line and diff | `an unreadable workflow-run query is unknown` failed because the query failure was mislabeled as no row | Focused file: 41 pass, 0 fail |
| Missing row at `tools/lane_review.sh:86` | Inverted `-z` to `-n`; printed the landed line and diff | `no workflow run for this head is unknown, never passed or failed` failed because execution reached the wrong-head refusal | Focused file: 41 pass, 0 fail |
| Head provenance at `tools/lane_review.sh:91` | Inverted `!=` to `=`; printed the landed line and diff | `a workflow run returned for another head is unknown before its success is read` received exit 0 instead of 2 | Focused file: 41 pass, 0 fail |
| Completion at `tools/lane_review.sh:95` | Inverted `!=` to `=`; printed the landed line and diff | `an exact-head run that has not completed is unknown` received exit 1 instead of 2 | Focused file: 41 pass, 0 fail |
| Conclusion at `tools/lane_review.sh:99` | Inverted `!=` to `=`; printed the landed line and diff | `exact-head success passes and exact-head failure remains a finding` received exit 1 for success | Focused file: 41 pass, 0 fail |

### Verification

`bun test tools/lane_review.test.ts`: 41 pass, 0 fail, 132 assertions. `bash -n tools/lane_review.sh`: green. `bash scripts/ci/lint.sh`: all gates green. `tools/tsconfig.json` passed inside `bash scripts/ci/typecheck-all.sh`; the complete matrix reported unrelated existing errors in `app/tsconfig.json`, `gateway/tsconfig.json`, `logger/tsconfig.json`, `onboarding/tsconfig.json`, and the root `tsconfig.json`. The root package's script block is at `package.json:57-63`; the positive-control search `rg -n '"(typecheck|test|migrate)"' package.json` found `test` at line 60 and `migrate` at line 62 but no `typecheck`, and `bun run typecheck` correspondingly reported that the script is absent.

### Deliberately not changed

The protected workflow implementation and its assembly test were not edited. `SPEC.md` was not changed because the work adds the filed fail-closed precondition without changing a product decision. No alternate CI path or feature switch was added. The full test suite was not run, as directed; only the owned focused test and repository static checks were run.
