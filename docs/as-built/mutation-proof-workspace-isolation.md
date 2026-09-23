## 2026-09-23 — Mutation proofs resolve the reviewed workspace

The locked pivot preserves the mutation prover
(`docs/plans/harness-orchestrator-pivot-2026-09-11.md:271`), and the orchestrator
spec keeps every gate (`docs/spec-items/the-orchestrator-owns-the-build-loop.md:56`).
G148 requires a green control and G161 requires a fresh restored checkout
(`docs/trident-gates-inventory.md:247`, `:265`). This change repairs the test
environment without relaxing either requirement.

A detached proof beneath an installed checkout inherited that checkout's
workspace links. The reviewed candidate's store expected its new column while
the ancestor's migrations created the old schema. The resulting control failure
was classified as an overbroad mutation even though the nominated behavior was
correct. An isolated replay of the preserved candidate reproduced 13 passing and
145 failing control tests with the ancestor layout. With the fix, the unchanged
nomination produced 51 passing/1 failing guard tests, 158 passing/0 failing control
tests, and 52 passing/0 failing restored guard tests; the prover accepted it.

`trident/mutation-prover.ts` now provisions Bun workspaces from their committed
lockfile, with lifecycle scripts disabled and copied dependency bytes, before
either observation tree runs. Root and package install destinations must be
absent before the installer starts, preventing committed symlinks from redirecting
writes into another checkout. Each workspace directory-pattern prefix is also
enumerated without following symlinks and linked directory paths are refused
before installation. This covers both explicit directories that Bun follows and
wildcard discovery that Bun skips, including links above a selected package.
Dependency resolution is checked against the local
workspace packages, and tracked bytes are reverified after installation. Both
installs consume the existing shared proof deadline. Other supported repository
types do not acquire a Bun-lockfile requirement.

The signed observations additionally retain a fixed failure category. The composed
build host carries that category, each exit/timeout, and output digests into its
refusal. It retains no raw command output, paths, database identifiers, or secrets
from that output. Prover version 2 binds the additional diagnostic fields.

Verification: 342 prover, real-git, workspace-isolation, and build-host tests passed;
both required TypeScript projects passed. The consuming surface
`open/__tests__/project-build-e2e.test.ts` was explicitly included in a 451-test
passing run alongside the prover and host tests. The final consuming-surface run
of that file and `trident/project-build-host.test.ts` passed all 146 tests. The
as-built and stale-prose guards passed.

Five semantic mutations turned tests red: removing the initial local install,
removing restored-tree provisioning, enabling lifecycle scripts (the committed
hook actually executed), removing destination preflight (the external fixture
gained dependency entries), and removing workspace-directory preflight (explicit
and ancestor links gained an external `node_modules`). Restored tests passed.
Positive controls prove that
the hook exists and runs when explicitly enabled, ancestor resolution really
loads an older schema, honest local-workspace proofs succeed, ordinary non-Bun
workspaces remain supported, and a broad mutation still fails its control.

This is an offline reproduction and repair, not a claim of deployment or a fresh
unattended live merge. Existing same-user execution and non-Bun dependency
provisioning limits remain; the repair does not introduce an OS sandbox.
