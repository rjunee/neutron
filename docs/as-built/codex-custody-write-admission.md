## 2026-09-28 — Reserve Codex credential writes and drain service mutations

Generic credential mutation previously reached Codex rows without passing the
Codex service's custody checks. The store now reserves only the normalized
`codex` and `codex-acct-*` write namespace, including access through another
module's reserved-write entry points (`project-credentials/store.ts:70`,
`:323`, `:343`). Explicit `setCodex` and `deleteCodex` methods remain available
to the owning service. Ordinary reads, per-project resolution, metadata listing,
unrelated credentials and the existing MCP reservation keep their contracts.

Stores sharing one `ProjectDb` object share a process-local admission gate
(`project-credentials/store.ts:307`). Admission closes synchronously, drains
already-admitted operations and stays closed until explicitly released
(`project-credentials/codex-custody-gate.ts:61`, `:109`). An async-context-bound
admission lets an already-queued operation finish nested persistence after the
closure; a detached continuation cannot borrow a settled writer's authority.

The credential service admits before its account mutation queue
(`trident/codex-credential.ts:1246`), includes async harvest persistence through
the owned setter (`:1173`), and covers status probes and synchronous paths that
produce rotation metadata (`:642`, `:891`, `:1531`). Project status checks that
can create custody owner markers are admitted too (`:492`, `:558`); a synthetic
missing-directory test proves refusal leaves the marker absent and release
restores normal creation. Stored-only metadata stays readable. The HTTP surface
maps a maintenance refusal to 409 without authoring
credential or auth data. Synthetic seed code uses the explicit owned methods;
the real generic HTTP path is tested for refusal and retained read behavior.

This is service/store admission only. It is not durable across process restart,
does not exclude native refreshers, independent database handles or raw SQL
writers, and does not implement or authorize a live reconciliation operation.
No live credential or database was read or changed during implementation.

Validation: nine synthetic gate, store, service, HTTP, rotation, custody and
General credential suites passed 262 tests with 1,050 assertions. Both root and
Trident TypeScript checks passed. Four semantic mutations each failed their
controlling test: removing generic-write refusal, overbroad reservation that
rejects the unrelated `codex-extra` service, premature drain while a writer is
pending, and removing maintenance admission refusal. Each mutation was restored
before the passing final suite. The consuming project-build and production
credential-composer suites passed 389 tests with 4,935 assertions, using their
required private PID namespace. The optional whole-tree leak check refused on
452 findings; the unchanged parent reproduced the same rule counts and emitted
findings except its worktree metadata path. This is not a purity pass. No full
repository-suite or deployment claim is made.
