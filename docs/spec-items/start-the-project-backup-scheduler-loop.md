---
title: Start the dormant per-project backup scheduler loop
group: platform
status: open
priority: P2
cutover: false
legacy_ref: "SPEC.md § Phases → Steps (2026-09-12 split)"
---

> **CORRECTED 2026-09-12, at the split.** The old blocker text — that this needs a
> wired `ProjectBackupStore` first — is **stale**. The store IS constructed in the
> production composition at `open/composer.ts:3975`
> (`new ProjectBackupStore({ platform, owner_home, project_slug })`), behind the
> app-backups surface. **Only the loop is missing:** `ProjectBackupScheduler` is
> constructed nowhere outside `gateway/__tests__/project-backup-scheduler.test.ts`,
> and `loop/registry.ts:9` still names it among the loops that "never start in ANY
> composition".
>
> The coupling to the vault model below is real and unchanged: decide the model
> before starting a loop that snapshots trees holding nested code repos and live
> SQLite.

Wire `ProjectBackupScheduler` (dormant loop today) — a scheduled per-project backup fires on its interval. (D-7)
Do NOT resolve this one alone: see the code-repo-vs-vault entry below. Wiring the scheduler without
deciding the model would start snapshotting trees that contain nested code repos and live SQLite.

## Acceptance

- [ ] A scheduled per-project backup fires on its interval in a real composition.
      `ProjectBackupScheduler` is constructed outside its own test file; deleting that
      construction must turn a test red.
      verify: `rg -n "new ProjectBackupScheduler" --glob '!**/*.test.ts'` names a composition file
- [ ] `loop/registry.ts` no longer lists it among the loops that never start in ANY
      composition.
- [ ] Nested code-repo working trees are excluded by RULE, not by luck, and a mid-write
      SQLite WAL is never committed as if it were a consistent snapshot. (Blocked on the
      vault model — see `project-code-repos-and-vault-split`.)
