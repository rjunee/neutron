## Issue #532 — publish-only recovery after a credential interruption

### What changed

A publish failure classified as `publish-credential` now joins the existing durable infrastructure-retry vocabulary instead of immediately terminalizing the run (`trident/orchestrator.ts:5079`). The vocabulary provides three attempts with 1, 5, and 15 minute spacing (`trident/orchestrator.ts:777`). Rejected refs and unknown publish failures retain the terminal default (`trident/orchestrator.ts:5112`).

The new atomic claim increments the existing durable `infra_retries` counter but deliberately preserves the completed dispatch and its `inner_result` (`trident/store.ts:1563`). The harvest-first path waits for the retry deadline and passes that same result back to `applyResult` (`trident/orchestrator.ts:5565`), so execution re-enters the outer publisher and does not launch Forge. Production composition wires the claim to the store (`gateway/composition/build-core-modules.ts:823`).

After the bounded budget is exhausted, the stored failure names the Integrations screen as the GitHub reconnect surface and preserves the built branch (`trident/orchestrator.ts:5085`). The spec item is marked complete and its stale line citation is corrected (`docs/spec-items/publish-only-resume-without-re-running-forge.md:4`).

### Decisions

The publish recovery uses the established infrastructure retry schedule and durable counter rather than adding a second retry taxonomy. The store claim maintains the central invariant continuously and atomically: only an active row with a completed dispatch and a stored result can spend a publish retry (`trident/store.ts:1568`). This mechanism does not depend on the failed publisher process continuing to work; the row retains the result and budget in SQLite.

The new class defaults conservatively. Only exact equality with `PUBLISH_CREDENTIAL_CLASS` enters retry (`trident/orchestrator.ts:5081`); `publish-ref-rejected` and `publish-unknown` fall through to the existing terminal failure path (`trident/orchestrator.ts:5113`).

### Tests and mutation evidence

The same-sha regression preserves `inner_result`, holds Forge to one input through the retry, checks the fourth push after the credential returns, and verifies the review-resume checkpoint contains the same commit (`trident/orchestrator.test.ts:2060`). A table-driven negative test covers both non-retry publish classes (`trident/orchestrator.test.ts:2122`). Exhaustion advice is covered separately (`trident/orchestrator.test.ts:2148`). The existing redaction suite includes a positive control that exposes a raw token before asserting the stored reason removed it (`trident/terminal-failure-reason.test.ts:1209`).

| Guard | Mutation | RED | Restored GREEN |
|---|---|---|---|
| credential-only retry at `trident/orchestrator.ts:5083` | `=== PUBLISH_CREDENTIAL_CLASS` → `!== PUBLISH_CREDENTIAL_CLASS` | 3/3 targeted tests failed: credential terminalized; rejected-ref and unknown retried | 4 focused tests passed, 19 assertions |
| completed-result claim at `trident/store.ts:1576` | `subagent_status = 'completed'` → `subagent_status IS NOT 'completed'` | 2/2 store tests failed: completed result was refused and a running dispatch was claimed | 2 focused tests passed, 5 assertions |

Validation: `bun test trident/orchestrator.test.ts trident/store.test.ts trident/terminal-failure-reason.test.ts` passed 540 tests; `bash scripts/ci/lint.sh` passed every repository lint guard; `git diff --check` passed. The local leak gate reported zero findings from the rules it could run, but remained incomplete because its external PII denylist was unavailable. `bunx tsc -p gateway/tsconfig.json --noEmit` reported two pre-existing errors in untouched files: `gateway/transcription/__tests__/whisper-install.test.ts:186` and `onboarding/history-import/__tests__/zip-writer.ts:10`.

### Deliberately not changed

No retry was added for rejected refs or unknown publisher failures, no second retry counter or feature flag was introduced, and the credential fetch path was not changed because the filed item explicitly does not establish whether expiry, revocation, or refresh failure caused the interruption (`docs/spec-items/publish-only-resume-without-re-running-forge.md:28`).
