---
title: Split a project into declared code repos and a versioned vault
group: platform
status: open
priority: P1
cutover: false
legacy_ref: "SPEC.md § Phases → Steps (2026-09-12 split)"
---

> **ONE MEASUREMENT BELOW IS NOW STALE (2026-09-12, at the split).** Mechanism (c)
> is described as *"Also built, tested, and never constructed"*. Half of that has
> changed: **`ProjectBackupStore` IS constructed in the production composition** at
> `open/composer.ts:3975`, behind the app-backups surface. What is still never
> constructed is the **scheduler** — `ProjectBackupScheduler` appears outside its own
> test only in `loop/registry.ts:9`, which still lists it among the loops that "never
> start in ANY composition". Mechanism (b), `doc-version-store.ts`, has no production
> construction at all, so its "built, tested, never constructed" stands.
>
> This does not change the item: the work is still deciding the model and then
> reconciling three overlapping mechanisms, not writing a fourth.

**A project needs a first-class split between its CODE REPO(s) and its VAULT — and the vault must be
versioned and backed up whether or not any repo exists** (owner-directed 2026-08-14: *"every project
needs to have the notion of things that are inside the repo … and also things that are outside the repo,
which is working documents, stuff that only I need … we need to make sure that all the stuff that's
considered outside the repo is still backed up, still tracked as a git repo, even though it's not
necessarily pushed anywhere. Or it may be pushed somewhere as one master backup."*). THE MODEL HE ASKED
FOR, generalised: a project owns a private **vault** (docs, plans, notes, research, per-Core sidecars —
everything that is only his) and **zero or more code repos**, each with its own remote and its own
publication rules. `neutron-open` is the demanding case: the vault is private, and `code/` is a clone of
a PUBLIC repo that must contain only a subset of the project. Most projects have no code repo at all;
some will have several; the model must not assume one.
MEASURED on this instance, 2026-08-14 — the current state is NOT a design, it is three overlapping
mechanisms of which only the weakest runs:
(a) `Projects/<id>/.git` — created by the materialize path, **one commit ("Neutron materialize: <id>"),
dated 2026-07-22, on every project, and never committed to since. No remote on any of them. No
`.gitignore`.** 9 of 16 project folders have one; 7 have no git at all.
(b) `gateway/git/doc-version-store.ts` — P7.4 Phase 1, a per-doc-edit repo at `<project>/.docs-versions/`.
**Built, tested, and never constructed: no `.docs-versions/` exists for any project.**
(c) `gateway/git/project-backup-store.ts` + `ProjectBackupScheduler` — P7.4 Phase 2, a whole-tree
snapshot every 6h at `<project>/.project-backup/` with an OPTIONAL per-project remote and push-failure
classification. **Built, tested, and — as of 2026-09-12 — the STORE is constructed (`open/composer.ts:3975`) but the
SCHEDULER never is** (`loop/registry.ts` already names it as a
loop that "never starts in ANY composition"; the existing backlog line "Wire `ProjectBackupScheduler`
(D-7)" is the same defect seen from the other end — these two entries must be resolved together).
NET EFFECT: the owner's private working context — every plan doc, note and research artifact across 16
projects — is un-versioned and un-backed-up on one volume. `neutron-backup.sh` would cover it, but it
backs up `NEUTRON_HOME` and **this instance's `NEUTRON_HOME` is not a git repo** — the script has never
been run here, and the one backup timer installed on this host does not cover the owner's data at all.
TWO HAZARDS THE FIX MUST HANDLE, both measured:
1. **A nested code repo is not just another directory.** `code/` is a real clone and is neither tracked
   nor ignored by the vault repo. `git add -An` in the vault emits *"warning: adding embedded git
   repository: code"* — a naive whole-tree backup stores a gitlink, so the backup contains a pointer to
   content it does not have, while looking complete. A vault backup must EXCLUDE nested repo working
   trees by rule (they have their own remote and their own recovery story), not by luck.
2. **Live SQLite is in the tree.** The same dry-run would stage `.nexus/nexus.db-wal`,
   `.comments/comments.db-wal` and `calendar/calendar.db-wal`. Phase 2's seeded `.gitignore` is the
   designed answer; whatever ships must actually apply it, and a mid-write WAL must not be committed as
   if it were a consistent snapshot.
Acceptance: a project declares its code repos (path + remote) as data rather than by their presence on
disk, and a project with none is a fully supported shape; the vault is committed automatically on
change, with nested repo trees excluded by rule and a recoverable history; a project with no remote is
still recoverable from local history, and a single owner-level backup remote can be configured for all
vaults at once (his *"one master backup"*); and the public/private boundary is explicit enough that
asking "is this file publishable?" has an answer that does not depend on which folder someone happened
to save it in. Phases 1 and 2 are ALREADY BUILT — the work is deciding the model, then wiring and
reconciling them against the materialize `.git`, NOT writing a third mechanism.
OPEN, owner's call, deliberately not decided here: whether the vault's canonical git is the materialize
`.git` or Phase 2's `.project-backup/` (three repos over one tree is one too many); whether the master
backup remote is per-project or one owner-level remote holding every vault; and whether a code repo
lives inside the project folder as today (`<project>/code/`) or beside it with a declared link.

## Acceptance

- [ ] A project declares its code repos (path + remote) **as data**, rather than by their
      presence on disk. A project with ZERO code repos is a fully supported shape, and a
      project with several is too; assert both, since a one-repo assumption passes any
      single-repo test.
- [ ] The vault is committed automatically on change, with a recoverable history.
- [ ] Nested repo working trees are excluded **by rule, not by luck**. Assert a vault
      backup of a tree containing a nested clone stores no gitlink pointing at content the
      backup does not hold.
- [ ] Live SQLite is never committed mid-write. Assert `.db-wal` files are excluded by the
      applied `.gitignore`, not merely by the seeded one.
- [ ] A project with no remote is still recoverable from local history, and a single
      owner-level backup remote can be configured for all vaults at once.
- [ ] Asking "is this file publishable?" has an answer that does not depend on which
      folder someone happened to save it in.
- [ ] No third mechanism is written. The change reconciles the materialize `.git`,
      `doc-version-store.ts` and `project-backup-store.ts`; a diff that adds a fourth
      store fails this criterion.
