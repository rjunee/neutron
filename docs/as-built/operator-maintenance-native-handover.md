## 2026-10-04 — Durable operator maintenance for native protocol handover

Within the existing native continuation P0 (#1416/#1342), ordinary maintenance
could not reliably retire an old transport parent: periodic recovery reopened a
plain draining fence, recurring pending work admitted another turn, and an
actually cancelled parent remained poisoned until normal replacement. Deploying
a new launch fingerprint first would then correctly refuse adoption of that old
parent. None of those observations authorizes a lease deletion or credential bypass.

Migration 0167 adds an operation-bound hold and database triggers that return zero
changes to old recovery's fence rewrite. `ProjectAdmissionStore` atomically acquires
the ordinary draining fence with its hold; exact release requires drained admission
and current independent proof. Existing work finishes through its own finally path.
The root-only local actuator captures original ownership before fencing, records
subsequent exact native owners, and releases only after canonical asleep, every
recorded process's disappearance, and verification of the new served tree/process,
entrypoint, listener and health. It never performs force, sleep, cap release, replay
completion or lease cleanup. Its additive installer applies only the committed
hold migration while retaining the existing migration-owner marker and ledger.

The consuming sleep fixture exercises an admitted real turn, cancellation/finally,
old recovery refusal across the durable hold, existing uncapped settled respawn,
same-transcript/new-generation replacement, unchanged timer-driven canonical sleep,
and a genuine v3 wake only after exact release. A separate existing WorkBoard E2E
proves fenced dispatch stays queued and admitted dispatch owns its run lease.
Focused controls cover strict pending replay, foreign/stale operations, retained
native owners, malformed asleep records, rootless authority, unrelated entrypoints,
stale source/process evidence, listener/health mismatch, migration rollback and
idempotence. Independent reviews corrected entrypoint/tree binding and incomplete
asleep-record validation before freeze. Semantic mutants removing old-writer
refusal, refusing every release, accepting unrelated entrypoints, or skipping
physical exits each fail their consuming controls. No live actuator invocation,
deployment, reboot or live-state repair is claimed by this source change.
