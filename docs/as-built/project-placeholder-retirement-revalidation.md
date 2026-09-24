## 2026-09-24 — Revalidate Chat placeholders immediately before retirement

Project Chat placement verified its inert placeholder before creating and moving
the replacement tab, then closed the saved pane without checking what changed
during those server calls. The manager now rechecks the exact pane response,
workspace and tab association, workspace ownership marker, and foreground argv
immediately before its existing pane-only close. Both initial Chat checks also
require the returned pane and process-info identities to match the requested
pane. Worker operations retain main's durable per-operation reservations:
typed errors and ambiguous replies do not retire the placeholder or release the
operation for retry. This integration removes the obsolete failed-worker cleanup
helper while retaining the final verification for Chat replacement.

Changed or unreadable identity refuses placeholder retirement. Existing failure
cleanup removes the unreturned replacement pane and retains the pending journal,
so a restarted manager cannot publish a duplicate into an unresolved operation.
A verified placeholder beside a newly arrived foreign split can still retire;
the split and worker panes remain. Placement keeps focus disabled and creates a
fresh Chat tab instead of replacing the placeholder's whole tab. No transcript
or conversation storage is changed.

This is bounded hardening of existing placeholder cleanup, not project sleep,
native-child quiescence, credential handoff, or deployment authorization. A final
identity sample is not an atomic server-side compare-and-close. The installed
Herdr protocol-20 schema exposes only `workspace_id` for `workspace.close`, not
the atomic ownership/contents guard required by the workspace specification.
This change issues no whole-workspace or whole-tab close. Issue #1226 and its
sleep/continuity acceptance remain open.

Validation includes post-ordering process/placement/ownership changes, wrong
response identities, unknown observation, and verified retirement beside a late
foreign split, together with durable worker-operation refusal and recovery.
The combined manager and host-placement tests passed (51 tests, 311 assertions).
The actual workspace host, Claude spawn, and complete consuming Open project
build E2E passed (317 tests, 3,637 assertions). Root and Trident typechecks and
the repository lint gate passed. Removing final revalidation made the changed
occupant refusal test fail; substituting whole-tab closure made the late-sibling
survival test fail. Restoring the implementation returned all 51 manager and
host-placement tests to green. Both Chat refusal and successful retirement
assert that existing worker reservation records survive unchanged.

The local leak gate reported 455 findings, and the same scan against the fetched
main tree at `9c421a27` reported the same 455 findings. This is a failing gate, not a
clean local purity receipt. The full repository suite and hosted CI were not
run for this local integration. No live pane was mutated.
