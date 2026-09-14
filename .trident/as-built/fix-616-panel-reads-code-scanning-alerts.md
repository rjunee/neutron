## Issue 616 — review panel reads code-scanning alerts

### What changed

The workflow now fetches every page of open code-scanning alerts for the pull request through the existing authenticated GitHub read path (`trident/inner-workflow.mjs:4455-4467`). A successful empty response alone becomes `clean`; failed, malformed, or non-object responses become `unknown` (`trident/inner-workflow.mjs:4156-4179`).

Open alerts become blocker findings with stable file, rule, and line coordinates (`trident/inner-workflow.mjs:4182-4197`). They are shown to synthesis (`trident/inner-workflow.mjs:5409-5415`) and deterministically force `REQUEST_CHANGES` (`trident/inner-workflow.mjs:5576-5582`). An unreadable fetch is shown as a fetch failure and enters the existing deferred-peer gate (`trident/inner-workflow.mjs:4201-4207`, `trident/inner-workflow.mjs:5587-5591`), whose default is an `infra-only` refusal rather than an empty alert list.

### Decisions

The change joins the existing verdict vocabulary rather than creating a new error state: open alerts are code work, while an unreadable alert source is infrastructure. This preserves the existing ordering where code findings take precedence over deferred peers (`trident/inner-workflow.mjs:2559-2574`). The API call uses `--paginate --slurp`, and the parser requires an array of page arrays, so a partial or unexpected response cannot masquerade as a complete empty result (`trident/inner-workflow.mjs:4159-4179`, `trident/inner-workflow.mjs:4455-4466`).

The guard is maintained on every review round by the workflow itself, independently of synthesis: the probe runs beside the CI probe, alert findings force the verdict in code, and fetch failures are injected into the deterministic peer gate (`trident/inner-workflow.mjs:5366-5370`, `trident/inner-workflow.mjs:5576-5591`).

### Tests and mutation evidence

The discovered workflow-assembly test executes the real `inner-workflow.mjs` body and proves both outcomes (`trident/inner-workflow-assembly.test.ts:835-867`).

| Guard | Mutation and landing line | Red result | Restored result |
|---|---|---|---|
| Open alerts force a code refusal | Replaced `codeScanningAlerts.length > 0` with `false`; printed `trident/inner-workflow.mjs:5576` | Focused test received `APPROVE` instead of `REQUEST_CHANGES` | Full file: 72 pass, 0 fail |
| Failed fetch enters deferred peers | Replaced the unknown-status condition with `false`; printed `trident/inner-workflow.mjs:5590` | Focused test received `APPROVE` instead of `REQUEST_CHANGES` | Full file: 72 pass, 0 fail |

`bun test trident/inner-workflow-assembly.test.ts` passed with 72 tests. `bash scripts/ci/lint.sh` passed. The trident and root typecheck legs passed, but `bash scripts/ci/typecheck-all.sh` ended nonzero because `app/tsconfig.json` could not find the `@types` definition library. A paired `git diff --name-only origin/main` check returned no `app/` entries and returned both changed trident files as the positive control. The leak gate found zero findings among rules that ran but reported incomplete because the local owner-data denylist was unavailable.

### Deliberately not changed

This change is limited to alert ingestion, synthesis context, and deterministic verdict classification. It does not change the product decisions in `SPEC.md`; the scanner remains the non-model mechanism that identifies unsafe input-handling patterns.
