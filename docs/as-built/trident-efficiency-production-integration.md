## 2026-09-23 — Connect measured proof reuse and recurring worker conversations

The efficiency requirement in `docs/spec-items/trident-build-efficiency.md`
requires both saved work and refusal when its measured inputs change. Open now
supplies the durable suite owner with `projectSuiteIdentity(worktree, head)` and
wraps recurring cross-provider planning, building and fixing in the durable
conversation owner. Credential binding hashes the selected token or bounded
credential-file bytes; neither secrets nor assumed account names are stored.
Same-provider work continues through the native project transport, and review
seats retain their separate conversation owner.

An atomic SQLite initiation witness permits one first conversation per run and
worker role. It lives outside the replaceable filesystem receipts: deleting the
entire receipt directory cannot make a follow-up look like a first turn.
Reconstructed hosts, competing claims, malformed witnesses and stopped runs
retain the refusal; other runs and roles remain eligible.

The integration preserves attempt accounting around reused suite observations.
Standalone review fixtures now assert that the identity contains the revision
independently measured from git; the fixture model reads the review round before
the revision suffix rather than treating a commit hash as a round number.

Consuming controls in `open/__tests__/project-build-e2e.test.ts` execute actual
Open preparation and adapter construction. They observe Claude's first session
creation, successor resume and reconstructed-host resume, then refuse changed
model, credential, project, missing or corrupt bindings and an occupied writer.
Each refusal has a legitimate successor control. Suite controls observe one
invocation across unchanged reconstruction and two after a moved head, changed
strategy, changed installed dependencies or missing, corrupt or subset evidence.
The host and adapter tests retain runtime, workspace and request-identity controls.

This record establishes local integration behavior. Deployed timing, usage and
the next live unattended merge remain tracked by issue #1196.
