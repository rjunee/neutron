## 2026-10-03 — Recover recorded tool grants across project profile additions

Startup recovery compared the retained tool-name list with the current project
list, so adding a project tool prevented an otherwise authorized recorded
conversation from recovering. `startup-recovery.ts:91` now reconstructs the
recorded order from currently recognized definitions, including the empty
default-deny surface. Unknown, duplicate or malformed names still refuse.
The recorded model, session, scope, credential, transcript, cap, row comparison
and ownership reservation continue to govern the resume.

`spawn.ts:245` consumes the existing compare-and-set-bound recovery record for
the planner grant. A missing `planner_profile` means no recorded grant; it does
not establish what an old process's argv contained. Recovery adds neither the
planner schema nor `--agents` nor a planner role in that case. A recognized
recorded planner profile is reproduced; an unknown or inconsistent profile is
refused. The concurrent recovery reuse guard consumes the same recorded grant.
An ordinary next turn retains the current profile and existing replacement
path, including refusal while native-child ownership remains unresolved.

Review of that consuming replacement path exposed a second ownership defect:
`terminateChild` resolves after its force deadline even when the child is alive.
The warm replacement now retains its exact pool entry and child handle until
positive exit evidence. A terminating marker refuses reuse even for a matching
old profile, and remains set after timeout until the child actually exits.
Timeout cannot license a second owner or a false death notification.
The marker and child exit are checked again after asynchronous MCP resolution,
so a matching-profile request already waiting there cannot reuse an owner that
another request began terminating while it was suspended.

This implements the recorded-profile recovery requirement in
`docs/spec-items/a-gateway-restart-keeps-the-project-repls.md:24` and the
2026-09-26 SPEC decision. It replaces the exact-current-tool-list behavior
described in the immutable `operator-cap-rearm-native-tool-profile-integration`
record. Cap rearm still changes only its cap episode; it does not grant tools.
The project maintenance replacement requires a live pooled parent
(`generation-replacement.ts:146`), so it is not used as dead-session migration.

Author validation on base `118e287ff` plus this diff:
`bun test runtime/adapters/claude-code/persistent/__tests__/startup-recovery.test.ts runtime/adapters/claude-code/persistent/__tests__/operator-cap-rearm.test.ts`
passed 42 tests and 288 assertions. The contained fake-host test verifies native
argv, manifest and persisted planner grants; concurrent startup creates one
child and submits zero turns. Its ordinary `getOrSpawnSession` consumer first
refuses an unresolved native child, then awaits the recovered child's exit and
resumes the same session with the current tools and planner grant. Retained
transcript bytes survive both spawns. Restoring the old exact-list guard failed
both subset/empty acceptance controls; unconditionally granting the planner
failed the missing-recorded-grant control. Both mutations were restored.
The stubborn-child control ignores both termination signals through the real
four-second deadline, retains unchanged registry bytes and pool ownership,
then proves that a late exit permits a same-session retry. Bypassing positive
exit proof fails that control while both promptly exiting controls pass.
The held-resolver control uses a recorded planner grant so its old profile
actually matches: it refuses when termination starts during the lookup, while
the same held lookup reuses a healthy unchanged owner.
Root and Trident checks passed with
`bunx --no-install tsc --noEmit -p tsconfig.json` and
`bunx --no-install tsc --noEmit -p trident/tsconfig.json`.

The broader suite exposed a deterministic contention-fixture defect:
`evict-deletes-only-its-own-entry.test.ts:459` published a new chain link on
every liveness read. The added post-resolution and post-termination checks
consumed several links during one stale decision, so four publications no
longer meant four re-entries. Each link now publishes once. The untouched
`118e287ff` baseline passed both bound controls; candidate `6d9d954d4` passed
the three-contender case and failed the four-contender refusal. With the
fixture correction, the eviction file passes 10 tests and 43 assertions.
Disabling the existing bound makes the four-contender refusal fail while
the three-contender acceptance stays green; restoring it passes both.
The production bound and ownership checks are unchanged by this correction.

Consolidated verification must include
`open/__tests__/boot-live-agent-adoption.test.ts` and
`open/__tests__/project-build-e2e.test.ts`, the root and Trident typechecks,
and the required full shared-host gate. These author fixtures do not establish
a live provider resume, served deployment, or unattended workflow continuation.
