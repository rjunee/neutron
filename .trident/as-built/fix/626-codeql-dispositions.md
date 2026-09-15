## Issue 626 — keep the required-check description consistent

### What changed

The workflow already names `test` as the sole required status check and says the up-to-date policy is off (`.github/workflows/ci.yml:167-176`). Its focused test file still described that policy as strict (`scripts/ci/ci-workflow.test.ts:194-205`). I corrected the stale test commentary so both repository descriptions now state that the policy is off.

The existing executable guard continues to require the sole-context sentence and reject a claim that CodeQL is required (`scripts/ci/ci-workflow.test.ts:216-219`). This change adds no outcome, error, or refusal value, so there is no outcome vocabulary to extend.

### Evidence and decisions

The filed location moved only in surrounding context: the operative workflow statement remains at `.github/workflows/ci.yml:167-173`. A whole-tree search for `strict up-to-date`, `strict_required_status_checks_policy`, and `up-to-date policy` found the corrected workflow statement, the stale focused-test statement, the frozen historical record, and explanatory merge-code comments. The historical record stays unchanged because it already says the setting is off (`docs/AS_BUILT.md:26566`); the merge comments also describe the setting as off or explain the setting generically (`trident/merge.ts:843`, `trident/merge.ts:942`, `trident/merge.ts:1918`).

The supplied alert export contains 46 open historical rows: 44 high and 2 medium. The current tree already contains the complete historical classification (`.trident/as-built/fix/646-codeql-triage-second-pass.md:3-58`), later repairs and corrected classifications (`.trident/as-built/fix/626-fix.md:11-55`), and the explicit warning that current scanner closure is unverified (`.trident/as-built/fix/626-fix.md:81-89`). I did not convert missing remote evidence into a claim that alert state changed.

### Mutation table

| Guard | Mutation | Red | Restored green |
|---|---|---|---|
| None added in this change | Not applicable | Not applicable | Not applicable |

The executable required-context guard predates this change; its existing mutation evidence is recorded at `.trident/as-built/fix/646-codeql-alert-triage.md:66-75`. The changed line is explanatory commentary, so reverting it cannot make a runtime test fail and is not presented as a guard.

### Validation

`bun test scripts/ci/ci-workflow.test.ts` passed 80 tests. The required `bun test tests/integration/identity-env-readers-registry.test.ts` passed 21 tests. `bash scripts/ci/typecheck-all.sh` checked all 51 TypeScript configurations and passed; `bash scripts/ci/lint.sh` reported zero findings. `git diff --check` passed, and the as-built heading count is exactly one. The leak gate found zero issues in the rules it could run, but its external identity denylist was unavailable; that result is incomplete, not green.

### Deliberately not done

No repository rule, workflow behavior, alert state, suppression, source path, or test assertion changed. Remote alert state and authorized disposition writes are unavailable in this build lane, so the acceptance condition concerning machine-readable dispositions remains externally blocked. `SPEC.md` is unchanged because the existing decision remains: CodeQL is informative rather than a required merge context (`.trident/as-built/fix/646-codeql-alert-triage.md:5-9`).
