## 2026-10-10 — Recover a stopped, expired native planner through prepared parent termination

An old native parent can lack the launch-time TaskStop grant while retaining a
stopped planner's lease. The existing physical recovery verifier accepted only
read-only review requests. Treating the stopped row or prior planner tool calls
as proof of native exit would release ownership without evidence.

The existing prepared parent-termination transaction now accepts the explicit
`expired-stopped-planner-v1` policy. It requires one original signed writable
`plan` request with `edit` tools and `project-plan-v2` result schema
(`runtime/workers/native-parent-termination.ts:65`). The canonical run must be
stopped at preparation and consumption, alongside the existing deadline,
attempt and original-receipt checks (`open/wiring/native-parent-termination.ts:23`).
The complete scope, permanent quarantine, retained-descriptor physical exit and
atomic lease-consumption rules are unchanged. Original review receipts retain
their earlier policy. The independent host operator must consume this new policy
and recheck stopped state from its pinned database before signalling.

The consuming fixture (`open/wiring/__tests__/native-parent-termination.test.ts:120`)
keeps stopped history, original signed bytes and sibling leases across restart;
it denies old-work replay and permits fresh work only after observed exit. The
real process/workspace fixture also runs for the planner policy and verifies a
fresh terminal while preserving the old pane and registry. Authentic wrong
request contracts, multiple distinct signed planners, non-stopped runs and run
changes after preparation refuse.

Focused validation: 47 tests, 220 assertions, zero failures. Removing the
canonical stopped-state guard or the single-planner guard separately fails its
opposing test; both guards were restored before the passing suite. The complete local gate passed with Bun 1.4.2 on clean revision `21c95a26708e513b39146bda185ac8564e4c06b2`:
`bash scripts/check-shared-host.sh` passed lint, all 51 typecheck projects and
all 1,814 discovered test files (28,608 passed, 24 skipped,
zero failed). The gate confirmed an unchanged suite-input identity. Its receipt
ran from 2026-10-10T13:46:54.532671+00:00 to 2026-10-10T14:23:29.658765+00:00.
Only this validation receipt changed after the tested revision. Fixtures
do not establish deployment, successful live recovery or unattended acceptance.

Related state: #1196 and #545. Normative acceptance lives in
`docs/spec-items/a-gateway-restart-keeps-the-project-repls.md`, under prepared
termination of an authenticated native parent. The 2026-10-10 stopped-planner
recovery decision adds this policy without rewriting prior decisions or records.
