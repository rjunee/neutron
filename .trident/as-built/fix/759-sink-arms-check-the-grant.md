## Issue 759 — require bridge attachment at the two write arms

### Change and evidence

The sink now refuses an authenticated session without its spawn-time bridge attachment before tool dispatch or todo reconciliation: `runtime/adapters/claude-code/persistent/pool-state.ts:570` and `runtime/adapters/claude-code/persistent/pool-state.ts:668`. Both refusals are HTTP 403. The credential lookup still precedes these arms (`runtime/adapters/claude-code/persistent/pool-state.ts:522`); unknown credentials receive HTTP 401 at line 530.

The original issue's line references moved: credential lookup is now line 522, tool-call line 567, and todo-sync line 665 after this patch (660 before it). The reported missing check is real, but the claim about other arms already checking the bridge is not supported by this checkout. Before editing, `rg -n 'toolBridgeActive|enableToolBridge|unauthorized'` over pool-state.ts and repl-session.ts found the positive controls `runtime/adapters/claude-code/persistent/repl-session.ts:145` and `runtime/adapters/claude-code/persistent/pool-state.ts:530`, with no bridge check in pool-state.ts.

### Authority and effects

This is an authorization gap for a live child holding its own credential, not anonymous HTTP access. The default-off security contract is `runtime/adapters/claude-code/persistent/types.ts:387`. Spawn computes attachment from explicit opt-in, a wired bridge, and a nonempty schema list (`runtime/adapters/claude-code/persistent/spawn.ts:196`), then stamps the session at line 293. Hook installation also depends on opt-in (`runtime/adapters/claude-code/persistent/spawn.ts:239`). Omitting a hook or MCP entry cannot enforce access against a child posting directly, so the receiving sink must enforce it.

Before the fix, such a child could reach the wired tool dispatch with supplied tool name and arguments and its credential-derived project scope. This is actual handler access, subject to the registry lookup and capability check in `mcp/server.ts:119`, `mcp/server.ts:130`, and `mcp/server.ts:151`; it is not a claim that every named tool succeeds. The todo callback resolves the board scope and reconciles in `gateway/composition/build-core-modules.ts:397`; reconciliation can create rows or change existing statuses (`work-board/todo-reconcile.ts:140`, `work-board/todo-reconcile.ts:145`). This impact is established by code reading; the restricted environment prevented an HTTP demonstration.

The authority is the existing attachment bit, default false (`runtime/adapters/claude-code/persistent/repl-session.ts:145`). The sink checks it on every request, before either callback, independently of the calling child's cooperation. Warm reuse compares attachment at `runtime/adapters/claude-code/persistent/spawn.ts:1418`; adoption restores it at `runtime/adapters/claude-code/persistent/boot-adoption.ts:2430`. No new authority cache or feature flag is introduced.

An opted-in session with no actual attachment remains ungranted, including an empty-schema boot. This deliberately uses attachment rather than treating mere possession of the dev-channel credential as sufficient. The hook installation condition is broader than attachment (`runtime/adapters/claude-code/persistent/spawn.ts:239` versus line 198): on such a boot its todo POST now receives 403. Normal attached sessions are covered by the granted cases, but their runtime proof is pending below.

### Refusal vocabulary and consumers

Tool-call joins the existing `{ ok: false, error: string }` response vocabulary used for dispatch errors (`runtime/adapters/claude-code/persistent/pool-state.ts:604`). The new error is `tool bridge not granted`; HTTP status is 403 rather than the normal handler-error 200. The bridge reads the response body regardless of HTTP status (`runtime/adapters/claude-code/persistent/tools-bridge-impl.ts:168`) and converts either `ok: false` or an error field into MCP `isError: true` (`runtime/adapters/claude-code/persistent/tools-bridge-impl.ts:130`). Its POST has one attempt (line 169), with no automatic retry.

Todo-sync joins the sink's status-object responses with `status: forbidden` and the same error text (`runtime/adapters/claude-code/persistent/pool-state.ts:669`). Its hook awaits fetch without inspecting status or body and exits successfully (`runtime/adapters/claude-code/persistent/hooks/todo-sync.ts:68`). Thus this refusal suppresses the board mutation without failing the agent turn. These are the two production route consumers enumerated by repository-wide `rg -n 'tool-call|todo-sync' --glob '*.ts'`, inspecting the request call sites; the sink declarations provide the search's positive controls. There is no new substrate Event or capability-verdict enum value: refusal occurs before registry dispatch and uses the HTTP response vocabulary above.

### Tests and discovery

Four new cases enumerate both routes and both grant states at `runtime/adapters/claude-code/persistent/__tests__/tool-bridge.test.ts:276`. They create the production persistent substrate, obtain credentials from spawn configuration, and POST through the production HTTP sink. The PTY host and effect callbacks are test doubles; the sink and authorization are not. Both callbacks are wired, the todo payload is nonempty, and the granted branch asserts exact output and project-scoped effects (line 300); the ungranted branch asserts 403 and zero effects (line 306).

Existing manually registered credential fixtures now explicitly set the bridge attachment instead of inheriting the default false: `runtime/adapters/claude-code/persistent/__tests__/tool-bridge.test.ts:232` and eight sites enumerated by `rg -n 'toolBridgeActive = true' runtime/adapters/claude-code/persistent/__tests__/sink-restart-survival.test.ts`, beginning at line 1353. All original assertions remain intact.

Both touched test files were returned by `neutron_discover_test_files` from `scripts/lib/discover-test-files.sh:20`. The runner consumes that list at `scripts/run-tests.sh:235`; CI runs it at `.github/workflows/ci.yml:437`.

### Mutation table and verification limits

Each mutation was applied independently, its exact landed line printed, and restored in a finally block. The route-specific test filter was `-t '/tool-call bridge grant:'` or `-t '/todo-sync bridge grant:'`.

| Guard | Mutation printed | Mutated result | Restored result |
| --- | --- | --- | --- |
| pool-state.ts:570 | `if (false)` | Socket startup failure; guard unreachable | Socket startup failure |
| pool-state.ts:570 | `if (session.toolBridgeActive)` | Socket startup failure; guard unreachable | Socket startup failure |
| pool-state.ts:668 | `if (false)` | Socket startup failure; guard unreachable | Socket startup failure |
| pool-state.ts:668 | `if (session.toolBridgeActive)` | Socket startup failure; guard unreachable | Socket startup failure |

These are **not successful RED/GREEN proofs**. A standalone Bun port-zero server also failed; an independent Python socket probe returned EPERM. Tests were neither skipped nor relaxed. The restored touched-file run (`bun test runtime/adapters/claude-code/persistent/__tests__/tool-bridge.test.ts runtime/adapters/claude-code/persistent/__tests__/sink-restart-survival.test.ts`) finished with 35 passing and 31 failing tests; socket setup prevented the HTTP cases from running. Local socket permission is needed to complete the required runtime verification.

`bash scripts/ci/lint.sh` passed. `bash scripts/ci/typecheck-all.sh` passed all 51 discovered tsconfig files (the CI equivalent of the requested typecheck). `git diff --check` passed.

### Deliberate boundaries

No parent/child identity distinction, process authentication redesign, tools-discovery restriction, or activity-tap restriction. The two requested write arms are the production scope. No SPEC decision was revised. No network access, push, PR creation, merge, or full test-suite run. The record lives under the task-required `.trident/as-built/` branch path rather than the standard docs path, following the explicit lane instruction. This commit is reviewable implementation with runtime verification outstanding, not a claim of merge readiness.
