## 2026-09-19 — Project Codex controls in web and mobile chat

The existing model selector now refreshes while its conversation is focused,
so an owner started by the first message and later terminal model changes become
visible (`app/components/ReplModelControl.tsx:50`). Codex projects mount the native
owner control beneath that selector (`app/components/ReplModelControl.tsx:149`).
This implements the app projection of the locked project REPL design in
`docs/plans/harness-orchestrator-pivot-2026-09-11.md:174`.

The app reads the existing authenticated project `repl-control` surface and sends
only the observed project, thread, turn, binding revision, generation and epoch
with an action (`app/lib/native-owner-control-client.ts:37`). It validates project
and question identity before rendering controls. Native command/file questions
offer the harness's available one-time decisions, and native user-input questions
return answers under their original IDs (`app/components/NativeOwnerControl.tsx:85`).
Unsupported questions remain visible with a terminal handoff. Focused reads discover
new questions; writes are serialized and never automatically retried after an
uncertain response (`app/components/NativeOwnerControl.tsx:46`).

The API and original native writer remain authoritative:
`gateway/http/app-native-owner-control-surface.ts:36` authenticates project access,
and `open/wiring/codex-owner-controls.ts:166` checks the complete identity before
using the active writer. This change adds no owner/session creation path.

Validation: root and app TypeScript checks pass. App model/native-control tests
pass (42 tests), covering rendered web/iOS actions, exact identity, stale and foreign
state, concurrent clicks, navigation races, user input, later questions, cold-owner
discovery, and a background model read racing a switch. Existing native server
model/control tests pass (9 tests, 165 assertions), including valid/stale/foreign
approvals and interruptions, one-time consumption and refused session-wide grants.
App reachability passes (3 tests). The app harness renders native primitives through
React Native Web; physical-device layout and a live Codex approval were not measured
by these tests.
