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
completion or lease cleanup. Its fixed compatibility bootstrap executes reviewed
hold DDL and acquires the hold atomically, with source commit/hash recorded first
in a protected prepared operator audit and successful application observed after
commit. This is not a canonical migration receipt: every existing `_migrations`
row and the migration-owner marker remain unchanged. The actual old gateway tree
binds that owner independently from the reviewed protected bootstrap artifact.
The old runner can restart; the ordinary new runner later genuinely executes the
idempotent 0167 migration and writes normal provenance.

The consuming sleep fixture exercises an admitted real turn, cancellation/finally,
old recovery refusal across the durable hold, existing uncapped settled respawn,
same-transcript/new-generation replacement, unchanged timer-driven canonical sleep,
and a genuine v3 wake only after the actual CLI release. It deliberately lets the
replacement sleep before `record-owner`: the CLI records an explicit completed-sleep
generation/census observation, not an invented historical PID. It checks all
previously observed exits, stable canonical sleep, strict replay and fresh
fail-closed whole-process transcript absence, repeating the latter at release.
A separate existing WorkBoard E2E
proves fenced dispatch stays queued and admitted dispatch owns its run lease.
Focused controls cover strict pending replay, foreign/stale operations, retained
native owners, malformed asleep records, rootless authority, unrelated entrypoints,
stale source/process evidence, listener/health mismatch, migration rollback and
idempotence. Independent reviews corrected entrypoint/tree binding and incomplete
asleep-record validation before freeze. Semantic mutants removing old-writer
refusal, refusing every release, accepting unrelated entrypoints, or skipping
physical exits each fail their consuming controls. The final review also exposed
and corrected the early-sleep audit race and old-runner incompatibility of writing
an unknown canonical migration row during bootstrap. No live actuator invocation,
deployment, reboot or live-state repair is claimed by this source change.
