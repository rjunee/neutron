---
title: Checkpoint writes survive build-load contention
group: trident
status: done
priority: P1
cutover: false
---

# Checkpoint writes survive build-load contention

## Acceptance

- [x] A real second SQLite writer holds the project database beyond the former
      five-second ceiling, then releases it; both checkpoint and stage-event
      writes subsequently land.
      verify: `bun test trident/checkpoint-sh.test.ts trident/stage-stamp-sh.test.ts`
- [x] A genuine SQLite failure remains distinguishable from exhausted lock
      contention: checkpoint writes preserve a non-contention failure status and
      diagnostic, while the best-effort stage writer labels the failure class.
      verify: `bun test trident/checkpoint-sh.test.ts trident/stage-stamp-sh.test.ts`
- [x] Removing the application-level retry makes the held-lock cases fail, and
      restoring it makes them pass.
      verify: mutation evidence in the change's as-built record
