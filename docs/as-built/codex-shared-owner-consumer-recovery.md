## 2026-09-19 — Recover the shared Codex owner after credentials and consume bridge cancellation

Remeasured the release at `004162cf68d0568e38ae7648d9cd26d262dec31a` against
the project-REPL decision in `SPEC.md:626`. The existing composition already
constructs one `CodexOwnerBindings` and passes it to both owner chat and project
builds (`open/composer.ts:1088`, `open/composer.ts:1200`,
`open/composer.ts:1241`). This change repairs its consumers rather than creating
another session authority.

Boot reconciliation previously ran before the credential service declaration.
Its project resolver therefore threw during the temporal dead zone, and
`CodexOwnerBindings.reconcile` treated that exception as unavailable credentials
(`open/wiring/codex-owner-binding.ts:262`). Reconciliation now runs after service
construction and materialization (`open/composer.ts:1847`). Production boot
tests verify credential lookup follows materialization, an existing journal
attempts reattachment with the exact project directory, and a cold project
does not open a native owner.

The native build wrapper now consumes the bridge submission's signal and
remaining time budget (`open/wiring/codex-owner-binding.ts:553`), supplied by
the companion runtime cancellation-contract change. The consumer interrupts
the exact parent through the existing conversational lease; uncertain work
keeps its existing shared chat/build fence. It neither fabricates a thread id
nor broadens the factory's capability or workspace attestation.

Validation: 64 owner-binding tests, 11 production boot tests, 44 substrate
wiring tests, and eight existing selected Codex consuming build E2E tests passed.
Socket fixtures required local Unix-domain socket access. Root, Open, and
Trident TypeScript checks passed. Reverting boot order
made both recovery regressions fail. Independently dropping the bridge signal
or remaining budget made the corresponding interruption regression fail;
refusing every submission made the healthy chat/build/chat continuity control
fail. Restored controls passed.

The full local leak gate exited 1 with 454 findings across the tree, including
the worktree gitdir pointer and existing files outside this change. This slice
does not claim a clean full-tree purity gate.

The existing Work Board mapping returns real project ids verbatim
(`work-board/store.test.ts:1242`), so project directory derivation was retained.
This slice does not establish a live deployed Codex card-to-merge run. The
separate consuming project-build E2E lane remains responsible for that broader
integration evidence; its test file and publication guards were not changed.
