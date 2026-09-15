## Issue 616 — review panel reads code-scanning alerts

### What changed

The workflow now fetches every page of open code-scanning alerts for the pull request through the existing authenticated GitHub read path (`trident/inner-workflow.mjs:4449-4459`). A successful empty response alone becomes `clean`; failed, malformed, or non-object responses become `unknown` (`trident/inner-workflow.mjs:4160-4183`).

Open alerts become blocker findings with stable file, rule, and line coordinates (`trident/inner-workflow.mjs:4186-4201`). They are shown to synthesis (`trident/inner-workflow.mjs:5403-5408`) and deterministically force `REQUEST_CHANGES` (`trident/inner-workflow.mjs:5569-5575`). An unreadable fetch remains `unknown`: it supplies neither alert findings nor an alert-derived refusal (`trident/inner-workflow.mjs:5362-5364`, `trident/inner-workflow.mjs:5403-5408`, `trident/inner-workflow.mjs:5580-5583`).

### Decisions

The change joins the existing verdict vocabulary rather than creating a new error state: open alerts are code work, while an unreadable alert source is unknown and has no verdict default. This preserves the existing ordering where genuine code findings take precedence over deferred peers (`trident/inner-workflow.mjs:2563-2578`) without converting missing alert data into either an approval or a refusal. The API call uses `--paginate --slurp`, and the parser requires an array of page arrays, so a partial or unexpected response cannot masquerade as a complete empty result (`trident/inner-workflow.mjs:4160-4183`, `trident/inner-workflow.mjs:4449-4459`).

The guard is maintained on every review round by the workflow itself, independently of synthesis: the probe runs after the CI probe and only a classified non-empty alert set forces the verdict in code (`trident/inner-workflow.mjs:5360-5364`, `trident/inner-workflow.mjs:5569-5575`).

The probe also joins the existing model-phase vocabulary as bookkeeping. The owner-facing inventory declares its dynamic label beside the CI probe (`trident/phase-models.ts:288-291`), while the standalone workflow's sibling router assigns that label the same low-cost mechanical route (`trident/inner-workflow.mjs:657-662`). The phase inventory continuously enumerates workflow label literals and rejects either an undeclared spawn or a missing runtime declaration (`trident/__tests__/phase-model-coverage.test.ts:43-72`, `trident/__tests__/phase-model-coverage.test.ts:139-144`).

### Tests and mutation evidence

The discovered workflow-assembly test executes the real `inner-workflow.mjs` body and proves both outcomes (`trident/inner-workflow-assembly.test.ts:835-867`).

| Guard | Mutation and landing line | Red result | Restored result |
|---|---|---|---|
| Open alerts force a code refusal | Replaced `codeScanningAlerts.length > 0` with `false`; the restored guard is at `trident/inner-workflow.mjs:5569` | Focused test received `APPROVE` instead of `REQUEST_CHANGES` | Full file: 72 pass, 0 fail |
| Unavailable alert data stays unknown and neutral | Reintroduced unknown as a deferred peer; printed `trident/inner-workflow.mjs:5583` | Complement received `REQUEST_CHANGES` instead of `APPROVE` | Restored focused test: 1 pass, 0 fail |
| Probe label belongs to bookkeeping | Deleted the phase-table row; printed the gap at `trident/phase-models.ts:288-291` | Inventory and direct classification failed: 43 pass, 2 fail | Restored inventory: 45 pass, 0 fail |
| Standalone workflow uses the declared route | Changed the runtime prefix; printed `trident/inner-workflow.mjs:661` | Sibling-routing assertion failed: 44 pass, 1 fail | Restored inventory: 45 pass, 0 fail |
| Failed CI seat still blocks | Existing failed-seat assertion at `trident/__tests__/dying-reviewer-e2e.test.ts:337-342` | The original guard mutation remains recorded by that change's test history | Paired suite: 2 pass, 0 fail |
| Healthy CI seat still permits merge | Existing complement assertion at `trident/__tests__/dying-reviewer-e2e.test.ts:344-348` | Before this correction it received `REQUEST_CHANGES` instead of `APPROVE` | Paired suite: 2 pass, 0 fail |

The restored original and inventory files passed together with 117 tests. The failed/healthy CI-seat pair passed 2 tests in `trident/__tests__/dying-reviewer-e2e.test.ts`. The surrounding `bun test trident` run enumerated 5,134 tests across 157 files: 5,113 passed, 5 skipped, 16 failed, and 2 errored; both subject files and the dying-reviewer file passed. The surrounding failures are outside this change, including settle-budget timing, external CLI subprocess fixtures, and pre-existing synthesis-unavailable cases. The pre-fix inventory run had 44 tests while the restored file has 45, proving the added marker increased coverage instead of silently dropping a generated case.

`bash scripts/ci/lint.sh` passed. This repository's scripts table has no `typecheck` entry (`package.json:57-61`), so the repository entrypoint `bash scripts/ci/typecheck-all.sh` checked 51 projects and passed 50, including trident and root, but ended nonzero because `app/tsconfig.json` could not find the `@types` definition library. A paired `git diff --name-only origin/main -- app trident` check returned no `app/` entries and returned all four changed trident files as the positive control. The leak gate found zero findings among rules that ran but reported incomplete because the local owner-data denylist was unavailable.

### Deliberately not changed

This change is limited to alert ingestion, synthesis context, and deterministic verdict classification. It does not change the product decisions in `SPEC.md`; the scanner remains the non-model mechanism that identifies unsafe input-handling patterns.
