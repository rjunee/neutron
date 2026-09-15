## 2026-09-15 — Plan documents are versioned at the production write seam

### What changed

The production composer now constructs the existing document version store and supplies it to the one `DocStore` used by both the Documents surface and card-plan service (`open/composer.ts:3663-3671`). The plan remains below the visible `plans/` folder because the card service still derives that relative path and writes it through `DocStore` (`work-board/spec-doc-service.ts:144-156`).

`DocStore` already owned the continuous maintenance mechanism: after each successful document write it awaits a version commit (`gateway/http/doc-store.ts:749-761`). `DocVersionStore` serializes the git add/commit operation by project (`gateway/git/doc-version-store.ts:528-564`), and its history/read-at operations expose both the commit list and historical bytes (`gateway/git/doc-version-store.ts:611-689`). This mechanism does not depend on the card writer continuing after the write: the version commit happens inside the awaited document-write operation.

The build's existing durable vocabulary is the `code_trident_runs.task` field (`migrations/0138_code_trident_runs_review_not_run.sql:78-86`). Run creation copies the resolved task bytes into that field (`trident/store.ts:862-873`), so later edits to the live document do not alter what that run records.

### Decisions

The existing per-document version store was selected instead of adding another repository or snapshot format. It already provides commit-per-edit history without moving files from the Documents tree (`gateway/git/doc-version-store.ts:10-34`) and already has the read-at interface needed for historical inspection (`gateway/git/doc-version-store.ts:676-689`). The new composition object is the sole non-test `DocStore` construction found by enumerating non-test TypeScript under `open/` and `gateway/` with `rg`; the positive-control hit is `open/composer.ts:3665`, and the same search finds the supplied version store at `open/composer.ts:3667`.

No new error or refusal value was introduced. Existing versioning failures remain in the `docs.versioning.commit_failed` structured event vocabulary (`gateway/git/doc-version-store.ts:565-572`), whose default preserves the completed file write and lets a later successful mutation pick up changes (`gateway/git/doc-version-store.ts:573-601`).

### Tests and mutation proof

`open/__tests__/plan-doc-versioning.test.ts:35-83` contains two focused checks. The first pins production composition. The second creates a card through `WorkBoardSpecDocService`, verifies its `plans/` reference, inspects the automatically created commit and original bytes, snapshots the resolved task into a run, edits the live document, and verifies both the run record and original version remain recoverable.

| Guard | Mutation | RED | Restored GREEN |
|---|---|---|---|
| Production `DocStore` receives `versionStore` (`open/composer.ts:3667`) | Removed only `versionStore: docVersionStore`; printed the mutated constructor at `open/composer.ts:3663-3668` | `the production composer supplies the version store to its document writer` failed at `open/__tests__/plan-doc-versioning.test.ts:39` | `bun test open/__tests__/plan-doc-versioning.test.ts`: 2 pass, 0 fail |

Validation: `bunx tsc -p open/tsconfig.json --noEmit` and `bunx eslint open/composer.ts open/__tests__/plan-doc-versioning.test.ts` both exited 0.

### Deliberately not changed

The plan document was not moved or mirrored, the card reference format was not changed, and no second persistence path or feature flag was added. Project-wide scheduled backups remain outside this change; per-write document history is sufficient for this acceptance surface and is maintained at the write chokepoint.
