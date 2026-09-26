---
title: Start the dormant per-project backup scheduler loop
group: platform
status: done
priority: P1
cutover: true
legacy_ref: "SPEC.md § Phases → Steps (2026-09-12 split)"
---

Open starts `ProjectBackupScheduler` with the same canonical vault store used by
document writes and the backup HTTP surface. It enumerates project directories,
backfills on boot and checks the six-hour per-project cadence every minute, with
jitter. Shutdown stops the scheduler and drains active snapshots.

This ships with the [vault reconciliation](project-code-repos-and-vault-split.md),
including nested repository exclusions and consistent SQLite images. It does not
claim that merely starting the loop establishes offsite recovery; that requires
a configured encrypted destination and a live push/clone/restore drill.

## Acceptance

- [x] A scheduled per-project backup fires on its interval in a real composition.
      `ProjectBackupScheduler` is constructed outside its own test file; deleting that
      construction must turn a test red.
      verify: `rg -n "new ProjectBackupScheduler" --glob '!**/*.test.ts'` names a composition file
      Consuming proof: `open/__tests__/loop-inventory-open-composer.test.ts`
      records two scheduled versions without an HTTP backup request; removing
      the scheduler start turns that test red.
- [x] `loop/registry.ts` no longer lists it among the loops that never start in ANY
      composition.
- [x] Nested code-repo working trees are excluded by RULE, not by luck, and a mid-write
      SQLite WAL is never committed as if it were a consistent snapshot.
      Verify: `gateway/__tests__/project-backup-store.test.ts` restores committed
      WAL-only rows and checks the standalone database's integrity.
