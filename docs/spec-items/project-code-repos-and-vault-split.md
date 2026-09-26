---
title: Split a project into declared code repos and a versioned vault
group: platform
status: open
priority: P1
cutover: true
legacy_ref: "SPEC.md § Phases → Steps (2026-09-12 split)"
---

A project owns a private vault and zero or more declared code repositories.
The vault includes working documents, plans, notes, research and per-Core data;
code repositories have independent remotes and publication rules. A project
without a code repository is fully supported.

The owner selected the existing `.project-backup/` repository as the canonical
vault history on 2026-09-26, with one private encrypted GitHub destination for
all vaults. The materializer and document editor must share that writer.
Original `.git` and `.docs-versions` histories are imported under immutable
SHA-named refs and retained on disk; this change does not delete legacy data.
There is no fourth store. Local history is useful without a remote, and a remote
failure must not discard a local snapshot or fall back to plaintext publication.

Snapshots exclude declared repository paths and discovered nested repositories.
A gitlink alone is not recoverable code and must never masquerade as vault data.
Live SQLite databases enter Git through a consistent standalone image containing
committed WAL transactions; live journal files never enter a new snapshot.
Database consistency is per database, not a transaction across every project file.
In-place restore refuses database replacement or removal: live connections and
WAL must be quiesced through offline/fresh-directory recovery. Document-only
restore remains available when an unrelated database exists. Every destructive
restore first requires a successful local safety snapshot.

The scheduler runs every six hours, with boot backfill and jitter, using the same
store as the owner backup surface. Document edits record local history immediately.
The owner remote receives authenticated encrypted bundles of all canonical refs,
including imported history. Configuration pins private repository identity and
requires an owner attestation that the recovery key is held off the host.
See [backup recovery](../vault-backup-recovery.md) for operational limits and the
fresh-host restore procedure. A local fixture restore is not evidence of live
offsite recovery or of physical recovery-key custody.

The location-independent publication-classification criterion below remains open.
Repository declarations and encrypted transport prevent automatic vault publication;
they cannot classify a private note copied into a public code checkout.
Repo location and selection are resolved by Decisions Log 2026-09-15 (#935).

## Acceptance

- [x] A project declares its code repos (path + remote) **as data**, rather than by their
      presence on disk. A project with ZERO code repos is a fully supported shape, and a
      project with several is too; assert both, since a one-repo assumption passes any
      single-repo test.
      Delivered by #935: `trident/project-repos.ts` reads `project-repos.json`, and both
      shapes are asserted — zero at `trident/project-repos.test.ts:34`, several at
      `trident/project-repos.test.ts:25` (a declaration holding `code` and `repos/docs`,
      selected by name and by default). This is the same criterion the #935 addendum below
      already records; it was left unticked here when that section was added.
      Verify: `bun test trident/project-repos.test.ts`.
- [x] The vault is committed automatically on change, with a recoverable history.
      Verify: `open/__tests__/loop-inventory-open-composer.test.ts` captures two
      scheduled versions and reads the first after the second lands.
- [x] Nested repo working trees are excluded **by rule, not by luck**. Assert a vault
      backup of a tree containing a nested clone stores no gitlink pointing at content the
      backup does not hold.
      Verify: `gateway/__tests__/project-backup-store.test.ts` covers discovered
      clones, zero declarations, multiple declarations and previously tracked paths.
- [x] Live SQLite is never committed mid-write. Assert `.db-wal` files are excluded by the
      applied `.gitignore`, not merely by the seeded one.
      Verify: the same store test restores committed WAL-only rows from a standalone
      database blob and runs `PRAGMA integrity_check`.
- [x] A project with no remote is still recoverable from local history, and a single
      owner-level backup remote can be configured for all vaults at once.
      Verify: `gateway/__tests__/project-backup-store.test.ts` and
      `gateway/__tests__/project-backup-remote.test.ts` exercise local recovery,
      encrypted remote push and fresh-clone restore, including archived refs.
- [ ] Asking "is this file publishable?" has an answer that does not depend on which
      folder someone happened to save it in.
- [x] No third mechanism is written. The change reconciles the materialize `.git`,
      `doc-version-store.ts` and `project-backup-store.ts`; a diff that adds a fourth
      store fails this criterion.
      Verify: `gateway/__tests__/vault-history-migration.test.ts`,
      `gateway/__tests__/doc-version-store.test.ts` and
      `onboarding/wow-moment/__tests__/project-materializer.test.ts`.

### Repo declaration model (#935)

The model lane implements repo declaration and card selection; the vault work above
remains open. A project may write `project-repos.json` in its root:

```json
{
  "repos": [
    { "name": "widgets", "path": "code", "remote": null },
    { "name": "docs", "path": "repos/docs", "remote": null }
  ],
  "default": "widgets"
}
```

`remote` is declaration metadata; cloning and remote reconciliation are outside this
lane. A remote-bearing entry requires an existing checkout before dispatch. New
named paths are `repos/<repo-name>`; `code` is accepted for the existing workspace.
Without a declaration, the compatibility model names the single `code` workspace
after the project slug. Write a declaration to give it its repository name. An
explicit empty set (`repos: [], default: null`) is valid and refuses a build.
`WorkBoardStore.create/update` accepts nullable `repo_name`; null selects the default.
The declaration is checked on each resolution, including external edits. Missing
names, invalid defaults, duplicate names/paths, malformed declarations and read
failures other than a missing file refuse preparation.

- [x] Named card selects that repo, omitted name selects the default, and an unknown
      name refuses by name with a populated default available.
      Verify: `bun test trident/project-repos.test.ts trident/board-dispatch.test.ts`.
- [x] Existing single-code projects resolve unchanged; explicit zero and multiple
      repo declarations are tested. Verify: `bun test trident/project-repos.test.ts`.
- [x] Card repo selection persists and can be cleared to the default.
      Verify: `bun test work-board/store.test.ts`.

Evidence: `trident/project-repos.ts:19`, `trident/project-repos.ts:49`,
`trident/project-repos.ts:60`, `trident/build-workspace.ts:74`,
`work-board/store.ts:731`, `work-board/store.ts:995`.
