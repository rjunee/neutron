## Issue 564 — deploy refusals reach the requesting agent

### What changed

The host-deploy service now defines a durable `last_deploy` vocabulary with `accepted`, `refused`, `errored`, and `timed_out` outcomes plus the ref, full sha, attempt time, and scrubbed control-plane detail (`open/host-deploy.ts:328-347`). The outcome is written into the already-persisted approval row after the authenticated call settles (`open/host-deploy.ts:1691-1703`), and `status()` reads the newest valid record while treating no record as `null` (`open/host-deploy.ts:824-835`).

The agent-facing tool contract and JSON schema now require the nullable `last_deploy` block (`gateway/wiring/host-deploy-tool.ts:46-58`, `gateway/wiring/host-deploy-tool.ts:152-178`). An unwired service returns `last_deploy:null`, preserving the distinction between no known attempt and any terminal outcome (`gateway/wiring/host-deploy-tool.ts:360-370`).

The chat response remains bounded by `HOST_DEPLOY_DETAIL_CAP`, while the durable status record receives the complete secret-scrubbed detail so a late blocking-path entry is not truncated (`open/host-deploy.ts:1799-1818`).

### Decisions

The outcome joins the service's existing dispatch taxonomy at `performDeploy`: accepted and refused retain their names, transport errors become `errored`, and loss of an answer becomes `timed_out` rather than success or refusal (`open/host-deploy.ts:780-785`, `open/host-deploy.ts:1724-1733`). Unknown or malformed persisted values default to `null`, not to a successful attempt (`open/host-deploy.ts:761-777`).

The existing approval row maintains the record continuously; no new store or process-local cache was added. A failed audit write is logged after the deploy outcome is already known and does not repeat or reverse the external action (`open/host-deploy.ts:1699-1703`).

### Tests and mutation proof

The real service test begins with `last_deploy:null`, drives a refused authenticated call, and proves that a blocking path beyond the chat cap remains in agent-readable status (`open/__tests__/host-deploy.test.ts:1674-1696`). The gateway test proves the handler forwards that refusal (`gateway/wiring/__tests__/host-deploy-tool.test.ts:152-169`), and the registration test pins the advertised schema (`gateway/wiring/__tests__/host-deploy-tool.test.ts:109-115`). The composition fixture was updated for the required nullable field (`gateway/composition/build-core-modules-host-deploy-wiring.test.ts:63-71`).

| Guard | Mutation | RED | Restored GREEN |
|---|---|---|---|
| durable outcome write | replaced `approvals.mergeArgs` at `open/host-deploy.ts:1700` with a no-op promise | `durable status preserves a refused guard reason beyond the chat detail cap` received `null` | same focused test: 1 pass, 0 fail |
| agent schema advertises the block | changed `last_deploy.type` at `gateway/wiring/host-deploy-tool.ts:162` from object-or-null to null-only | `both tools register, are agent-visible, and gate on the right capability` failed its schema match | same focused test: 1 pass, 0 fail |

Focused verification: the three touched test files passed 110 tests and 425 assertions; ESLint passed on all five changed TypeScript files. The root package has no `typecheck` script. `bunx tsc --noEmit` reports three pre-existing errors in `gateway/transcription/__tests__/whisper-install.test.ts:186`, `logger/__tests__/fire-and-forget.test.ts:301`, and `onboarding/history-import/__tests__/zip-writer.ts:10`; none is in issue territory.

### Deliberately not changed

This change does not alter deploy authorization, add a second dispatch site, retry an unknown outcome, or truncate the durable refusal detail. It does not implement the later optional preview `dirty_paths` health signal described in the preserved plan; this issue is the terminal-outcome visibility step.
