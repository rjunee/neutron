## 2026-09-19 — Host-mediated native Codex result publication

This is a bounded integration slice, not a served cutover or a completed unattended
Codex build. It implements the one-project-REPL/native-child direction in
`docs/plans/harness-orchestrator-pivot-2026-09-11.md:87-111` without weakening the
gates retained at `:265-268` or the unattended-merge acceptance in
`docs/spec-items/the-orchestrator-owns-the-build-loop.md:56-66`.

### Cause and implementation

Production build artifacts live under the owner's `.trident/project-builds`,
outside the native project writable root. The broker only admits that exact
project root (`runtime/adapters/codex-cli/persistent/project-control-broker-scope.ts:33-46`).
A disposable native child reproduced an allowed project write and an unsuccessful
outside result write. Expanding the owner-home grant would be the wrong authority.

`open/wiring/codex-build-result.ts:42` stages only the child-facing result beneath
the project. The canonical brief, context reference, request identity and result
reservation remain unchanged. A typed hook through `project-runners.ts` and
`codex-in-repl.ts` supplies the staged path; Open does not parse or rewrite prompts.
The same registered domain schema is supplied by `open/wiring/project-build.ts:260`
to the normal decoder and the transport. Publication captures bytes once, requires
valid UTF-8, validates original run/step/schema, and copies that captured buffer
into a new exclusive host-owned inode before atomic canonical installation.
It never renames the child inode, rereads mutable source after validation, or
takes a canonical destination from child output.

Directories are opened component-by-component with no-follow and pinned file
descriptors. A host manifest binds request, stage path and directory inode.
Preparation precedes reservation arming and also runs nondestructively on resume.
The optional `trailer-slot.ts` before-arm hook runs only for the exclusive winner:
it clears the child slot after the original canonical clear and before arming.
Concurrent losers and resumes never clear a valid receipt; failed clearing leaves
the reservation unarmed and dispatch unknown. Existing Claude/Pi/headless callers
do not supply this hook.

Publication polls for asynchronous child output, including on an armed resume;
parent completion alone does not mean the result exists. Raw transport recovery
can finish installation without native redispatch. This does not reconcile an
owner fence: guarded build admission checks in-memory refusal and durable work
markers before any worker path, including result-only resume. A cold surviving
launch must first be attested by boot/chat attachment. A known live host chat is
busy, not interrupted; concurrent build admission does not permanently fence it.
Failed publication retains the existing owner marker and refuses chat and guarded
same-step retry until host reconciliation.

### Evidence and limits

Focused tests cover real registered-schema A/B swaps, invalid run/step/schema,
ancestor/final symlinks, invalid UTF-8, FIFO refusal, retained writable descriptors,
foreign destinations, transfer failure, before/after-install host replacement,
stale same-step output, exclusive clear/concurrent losers, and guarded restart
refusal. Consuming Open binding tests pair successful publication and next chat
with durable refusal after failed publication. The project-build E2E suite retains
existing admission/review/publication behavior and adds prepared Codex build/fix
artifacts in a production sibling-home layout. Both root and runtime TypeScript
checks and focused lint are part of this slice's verification.

The final focused run passed 155 tests with 1,108 assertions across the transport,
owner binding, durable owner, Codex in-REPL, project runners and trailer-slot suites.
Root and runtime `tsc --noEmit` and focused lint passed. The added-content privacy
scan passed with zero findings; this is a scoped result, not a full-tree claim.
The complete `open/__tests__/project-build-e2e.test.ts` run passed 89 tests and
819 assertions, including the new prepared Codex build/fix control.

Semantic mutations exercise both acceptance and refusal: schema bypass, source
reread after validation, child-inode transfer, rejection of valid output,
ancestor following, replacement UTF-8 decoding, skipped resume publication,
rewritten canonical reservation identity, and unsupported read-only dispatch.
Additional reservation/owner admission mutations verify stale-stage clearing,
preservation on resume, sticky uncertain publication and non-fencing live-chat
admission. All fifteen mutations were killed and restored after their failing controls.

A real native child read the original canonical brief and its context reference,
wrote the staged result through its native file tool, and the host published the
validated canonical result. No brief staging was necessary: native workspace-write
permits that read. The immediate next owner chat exposed a separately owned late
child-status observer race. This record does not claim that continuation smoke
passes before the observer fix is integrated and rerun. Host-replacement transport
tests inject failure boundaries; they are not a new native gateway-SIGKILL proof.

Same-provider native review/synthesis admission deliberately refuses: the inspected
native child inherits project write permissions, and prompt-only read-only language
does not attest repository isolation. A genuinely isolated result-output permission
profile and Claude cross-provider plan/synthesis routing remain separate work.
This slice does not claim full-Codex admission, unattended merge, deployment, or
completion of the governing spec item. Staging manifests/results remain available
for reconciliation; this slice adds no artifact reaper. The disposable native
diagnostic is not part of the committed source.
