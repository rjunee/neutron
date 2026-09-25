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
