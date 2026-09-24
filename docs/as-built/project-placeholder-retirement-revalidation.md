## 2026-09-24 — Revalidate Chat placeholders immediately before retirement

Project Chat placement verified its inert placeholder before creating and moving
the replacement tab, then closed the saved pane without checking what changed
during those server calls. The manager now rechecks the exact pane response,
workspace and tab association, workspace ownership marker, and foreground argv
immediately before its existing pane-only close. Both initial Chat checks also
require the returned pane and process-info identities to match the requested
pane. Failed-worker cleanup shares the same final verification.

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

Validation: direct manager tests passed (30 tests, 167 assertions), including
post-ordering process/placement/ownership changes, wrong response identities,
unknown observation, and verified retirement beside a late foreign split.
Consuming host and Claude spawn placement tests passed with local socket binding
permitted (10 tests, 40 assertions). Root and Trident typechecks passed. Removing
final revalidation caused seven direct tests to fail; refusing verified retirement
caused six failures. Restored tests passed. The full suite awaits its scheduled
exclusive slot; no live pane was mutated.
