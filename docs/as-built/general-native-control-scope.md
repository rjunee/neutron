## 2026-09-24 — General Codex native controls preserve null owner scope

Fixes #1293. General chat uses the route sentinel `~general`, while the native
owner HTTP surface returns `projectId: null`. The client compared that response
with the route string and rejected it before the shared app could expose native
approval and interruption controls on iOS or web.

The native-control client now translates General at its read boundary, preserves
null in observed state and action bodies, and uses the existing HTTP scope
encoder for both reads and actions. A project literally named `general` retains
its string identity. The shared model selector also mounts native controls when
General arrives in the existing empty client-scope spelling. Server authorization,
native turn identity and one-time action handling are unchanged.

This implements the General controls boundary already specified in
`docs/spec-items/project-herdr-workspaces.md:108-118`; workspace placement and
sleep/retirement remain separate.

The consuming native/model-control suites pass 58 tests, including rendered iOS
and web approval and interruption for both General spellings and real projects,
exact request paths and null action bodies, and rejection of General/project
scope substitution. Before the fix, four General cases failed while twelve
project and rejection controls passed. The rendered harness uses React Native
Web; this is not physical-device or deployed native-provider proof.
The separate `landing/chat-react` web selector is outside this change; this
record does not claim that every deployed web surface exposes native controls.

Root and app TypeScript checks and changed-file lint pass. Two semantic mutants
were applied and restored: refusing every null owner made four General positive
cases fail with twelve controls passing; removing the scope equality check made
all eight foreign-scope cases fail with eight positive controls passing.

Independent Astra review approved the scoped app boundary with the separate
web-selector limitation above. The changed-file leak preflight, including the
local PII denylist, reported zero findings. The required full local validation is pending
the coordinated shared-host slot. No deployment or live owner session changed.

### Fresh-main integration

The single functional delta from `d15de34fe` was integrated onto public main
`b046589034de0569208da4c6b9a69e571fbdedaf` with browser owner controls and
model acknowledgement; the patch-identical `8769ffe11` was not imported again.
The app native/model-control suites plus the already-published voice-note
oracle passed 72 tests / 531 assertions. The mixed app controls and browser
native-controls suites passed 73 tests / 581 assertions after the browser
fixture's DOM ownership fix.

Both semantic mutation directions were measured on this integration: refusing
null identity killed four General cases while 36 controls passed; removing
scope equality killed ten foreign-scope cases while 30 controls passed. The
mutations were restored and the mixed consuming suites passed again. Root,
Trident, app, landing chat, landing and Open TypeScript checks exited zero.
The canonical full suite, final workspace-lifecycle composition, independent
review, exact-head CI and live acceptance remain outstanding. No deployment
or physical-device acceptance is claimed.
