## Issue 616 — review panel reads code-scanning alerts

### What changed

The workflow now fetches every page of open code-scanning alerts for the pull request through the existing authenticated GitHub read path (`trident/inner-workflow.mjs:6155-6167`). A successful empty response alone becomes `clean`; failed, malformed, or non-object responses become `unknown` (`trident/inner-workflow.mjs:5788-5811`).

Open alerts become blocker findings with stable file, rule, and line coordinates (`trident/inner-workflow.mjs:5814-5830`). They are shown to synthesis (`trident/inner-workflow.mjs:7444-7450`) and deterministically force `REQUEST_CHANGES` (`trident/inner-workflow.mjs:7630-7636`). An unreadable fetch is shown as a fetch failure and enters the existing deferred-peer gate (`trident/inner-workflow.mjs:5833-5839`, `trident/inner-workflow.mjs:7641-7645`), whose default is an `infra-only` refusal rather than an empty alert list.

### Decisions

The change joins the existing verdict vocabulary rather than creating a new error state: open alerts are code work, while an unreadable alert source is infrastructure. This preserves the existing ordering where code findings take precedence over deferred peers (`trident/inner-workflow.mjs:3444-3447`). The API call uses `--paginate --slurp`, and the parser requires an array of page arrays, so a partial or unexpected response cannot masquerade as a complete empty result (`trident/inner-workflow.mjs:5795-5811`, `trident/inner-workflow.mjs:6155-6166`).

The guard is maintained on every review round by the workflow itself, independently of synthesis: alert findings force the verdict in code and fetch failures are injected into the deterministic peer gate (`trident/inner-workflow.mjs:7630-7645`).

### Tests and mutation evidence

The discovered workflow-assembly test executes the real `inner-workflow.mjs` body and proves both outcomes (`trident/inner-workflow-assembly.test.ts:835-868`).

| Guard | Mutation and landing line | Red result | Restored result |
|---|---|---|---|
| Open alerts force a code refusal | Replaced `codeScanningAlerts.length > 0` with `false`; printed `trident/inner-workflow.mjs:7630` | Focused test received `APPROVE` instead of `REQUEST_CHANGES` | Full file: 72 pass, 0 fail |
| Failed fetch enters deferred peers | Replaced the unknown-status condition with `false`; printed `trident/inner-workflow.mjs:7644` | Focused test received `APPROVE` instead of `REQUEST_CHANGES` | Full file: 72 pass, 0 fail |

`bun test trident/inner-workflow-assembly.test.ts` passed with 72 tests. `bash scripts/ci/lint.sh` passed. The trident typecheck leg passed, but `bash scripts/ci/typecheck-all.sh` ended nonzero on existing errors in app, gateway, logger, onboarding, and the root config. A paired `git diff --name-only origin/main` check returned no entries for those failing paths and returned both changed trident files as the positive control. The leak gate found zero findings among rules that ran but reported incomplete because the local owner-data denylist was unavailable.

### Deliberately not changed

The untrusted-input boundary half of issue 616 is outside this lane and was not implemented. No feature flag, alternate review path, specification decision, push, pull request, or merge was added.
