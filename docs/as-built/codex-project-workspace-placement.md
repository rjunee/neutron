## 2026-09-28 — Place new native Codex owners in their project workspace

Refs #1226; implements the Codex conversation placement slice of
`docs/spec-items/project-herdr-workspaces.md`. The issue and its live acceptance
remain open.

The production composer supplies a serializable workspace descriptor for the
actual project scope, including null General (`open/composer.ts:1112`). It uses
the bounded worker journal path (`open/wiring/project-build-terminal.ts:32`).
The binding passes that descriptor to both initial owner launch and the existing
General account successor (`open/wiring/codex-owner-binding.ts:378`,
`open/wiring/codex-owner-binding.ts:479`).

Fresh durable launches require a matching, explicit scope before reserving their
launch file. The helper operation ID and workspace descriptor are saved in that
exclusive launch record before its `Owner helper · Codex` placement
(`open/wiring/codex-durable-owner.ts:168`). The helper gives its already-required
native TUI the strict workspace host and `Chat` placement
(`runtime/adapters/codex-cli/persistent/project-owner-helper-main.ts:18`). Neither
new process chooses a workspace from inherited terminal environment.

Incomplete launches remain reserved; a retry cannot launch another helper.
Previously placed owners refuse a changed instance or journal authority before
attachment (`open/wiring/codex-durable-owner.ts:143`). A live pre-cutover owner
continues through the existing exact pane/native binding checks; adoption does
not move its panes, rewrite its launch record or change its transcript.

Validation uses the real Open composer HTTP chat path for two projects and General,
with the credential and native launch boundaries replaced by fixtures. The
workspace test consumes the durable launch path and the helper's terminal factory
through the real strict host and manager, against a scripted Herdr RPC server. It
asserts helper/Chat/worker workspace identity, Chat-first ordering, tab labels,
preserved focus, distinct null General, invalid-scope refusal and reserved retries.
The server never executes a native command; these checks do not claim a deployed
native conversation was measured.

The 43 focused checks passed in `open/__tests__/codex-workspace-composition.test.ts`,
`open/__tests__/codex-workspace-placement.test.ts`, `codex-durable-owner.test.ts`,
`codex-owner-crash-recovery.test.ts` and `codex-account-handoff.test.ts` in the
same directory. The latter two assert successor descriptor propagation and live
legacy adoption. An additional 172 tests passed across owner bindings, worker
terminal composition, workspace host/manager, native bootstrap and bootstrap
account handoff. Temporary fixture Unix listeners required an unsandboxed test
run after the sandbox refused their socket binding; the rerun was green.

Three actual mutations were applied and reverted:

- Removing exact project equality made the foreign-project refusal fail while
  valid helper/Chat/worker routing stayed green.
- Refusing a valid project made valid routing fail while the foreign-project
  refusal and its valid General sibling stayed green.
- Removing the project descriptor from production composition made the actual
  HTTP chat composition test fail at the missing descriptor assertion.

The root, Open and Trident typechecks passed, followed by the complete 51-config
`scripts/ci/typecheck-all.sh` matrix. The dependency-cruiser architecture
gate passed (3,127 modules and 8,463 dependencies). The local purity gate remains
failed: exported baseline and changed trees both reported 451 local denylist
findings (167 substring and 284 word findings). Scanning the working tree itself
also includes its untracked Git worktree pointer. No rule or denylist was changed
to suppress these results. The complete host test suite and CI were not run as
part of this isolated, unpublished slice.

This change does not activate Claude conversation placement or workspace sleep.
Claude still needs the locked credential handoff; complete retirement needs the
original pane input holds and Claude, Codex and worker census participants. No
live pane was retired, no service was deployed, and no live-cycle criterion is
claimed. The separate build-dispatch guard change shares no edited files with
this slice.
