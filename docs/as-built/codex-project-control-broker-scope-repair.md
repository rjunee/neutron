## 2026-09-19 — Reject nested Codex environment scope bypasses and close failed broker startups

The initial unintegrated broker checked top-level cwd and workspace roots but
missed `turn/start.environments[]`. In installed Codex 0.154.0, those entries
replace sticky turn environments. A local-provider consuming reproduction
against the frozen implementation completed a turn in a foreign disposable
directory: `thread/read.environments` changed even though the top-level
`thread.cwd` still named the project. The native TUI displayed the foreign
directory. A separate regression showed constructor rejection for an existing
socket never closed the supplied upstream transport.

`runtime/adapters/codex-cli/persistent/project-control-broker-scope.ts:7` pins
known mutation fields to the inspected generated protocol schema. Its recursive
scope traversal checks every environment entry, allows only the local
environment with the bound cwd and roots, and rejects unknown or malformed
environment fields. It also checks the nested explicit
`sandboxPolicy.workspaceWrite.writableRoots` surface (`:45`). Unknown mutation
and sandbox fields fail closed. Traversal follows protocol nodes; opaque input,
metadata, tool output, additional context and output schemas are not interpreted
as environment configuration (`:25`). Existing resume history/path and config
override refusals remain in force.

`project-control-broker.ts:56` now owns closing the supplied upstream from the
start of construction, including binding validation, existing-socket rejection,
listener setup and initialization failures. Closing remains idempotent.

Validation: 13 broker tests and 78 assertions passed. The new admission test
(`project-control-broker.test.ts:211`) checks foreign nested cwd/roots, every
array entry, remote environment IDs, malformed shapes, unknown scope fields,
explicit sandbox roots and refusal before forwarding or epoch advancement.
The positive control (`:232`) accepts valid local scope and opaque user JSON
containing scope-like keys. Constructor and listener/initialization failure
controls check exactly one upstream close (`:247`, `:259`).

Both semantic mutation controls failed as intended: bypassing environment
traversal broke the negative regression; replacing traversal with refusal of
every environment broke the positive control. Restoring the implementation
returned the suite to green. The native smoke
(`project-control-broker.smoke.ts:103`) now refuses the real foreign-environment
reproduction before forwarding, accepts a valid local environment, verifies
native environment readback, and retains native-TUI/gateway same-thread history
and rendering controls. It used a fresh disposable configuration, PTY and local
model fixture. Root and Trident TypeScript checks passed.

Limits remain explicit: this validates supplied structured scope overrides,
not the existing persisted environment at broker startup, named native
permission-profile resolution, or filesystem access through tools and user
attachments. Broad sandbox modes retain their native meaning; the broker is
not a filesystem sandbox. Protocol schema changes require review of the pinned
field maps. The original integration gaps remain: durable generation fences,
restart recovery, attach during another client's active turn, approval-owner
transfer, canonical model reconciliation and atomic `/model` transactions.
This repair does not wire or deploy the broker.
