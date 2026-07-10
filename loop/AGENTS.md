# @neutronai/loop

The `SupervisedLoop` primitive (world-class refactor §F1) — ONE driver for every
long-lived in-process tick loop.

- `SupervisedLoop` — single-flight interval loop with a per-tick catch-all,
  consecutive-failure counter + escalation hook, `stats()`, and a
  `stop(): Promise<void>` that quiesces the in-flight tick before resolving.
- `guardedFire(name, work, onError?)` — the shared "fire path" catch-all
  (`Promise<boolean>`, never rejects). Used by `SupervisedLoop`'s tick and by
  cron's per-job fire path (cron keeps its own calendar timers + overlap skip).

## Layer

Contracts-band leaf (zero `@neutronai/*` deps). Importable by any higher band
(platform/services/composition). Adopters: `trident/tick.ts`,
`reminders/tick.ts`, `gateway/git/project-backup-scheduler.ts`,
`gateway/upload/chunked-upload-sweeper.ts`, `cron/scheduler.ts` (fire path only).

## Invariant

Each adopting loop keeps its OWN tick body + domain guarantees. The primitive
owns ONLY the scaffolding (interval, single-flight, error handling, quiescing
stop). Never move a loop's domain ordering into here.
