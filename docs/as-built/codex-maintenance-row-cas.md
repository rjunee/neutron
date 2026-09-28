## 2026-09-28 — Conditional offline Codex credential maintenance

Added a separate encrypted-store maintenance primitive, bound to the exact
drained owner lease. Signed issuer/audience/account checks and independently
supplied identity digests precede preparation; a snapshot witness rejects changes
during asynchronous verification. The bounded two-account case refuses extra
unverified named homes. Named token bytes must agree after removing surrounding
whitespace, matching the existing materializer's terminal newline behavior.

Recovery receipts authenticate before/after encrypted rows and protected rotation
state. The apply boundary fsyncs the private receipt and its directory before SQL,
then checks the entire observed default row, named rows and rotation metadata in
one transaction. UPDATE triggers and inbound foreign keys refuse because either
can modify unrelated data while SQLite reports one directly changed row.
Rollback restores only the exact row image and refuses intervening changes;
normal account rotation remains a separate operation and invalidates rollback.

Focused tests exercise signatures, expiry, independent mapping, key/auth drift,
verification races, metadata preservation, durable-receipt failures, trigger and
cascade positive controls, rollback and both rotation directions with unchanged
auth files. Service admission and generic credential write guards remain intact.
The focused four-file run passed 67 tests and 315 assertions. Both affected
TypeScript projects passed. Six semantic mutations were killed: signed-input
snapshot witness, independent identity mapping, receipt fsync, key witness,
named-peer equality and inbound foreign-key refusal. Whitespace checks passed.
The local whole-tree leak gate still reports existing findings, including its
scan of the worktree metadata file; the changed-file comparison with the base
introduced no findings. The full partitioned suite runs in hosted CI; no merge
or deployment is claimed.
The first hosted full-suite run found one dashboard fixture still using generic
credential writes to seed and remove Codex. That fixture now uses the Codex-owned
methods; its connection/gauge assertions are unchanged, and its focused run
passes 10 tests and 65 assertions. Hosted purity, layering, lint,
typecheck and CodeQL passed on the initial reviewed head.

This is a library and synthetic proof. No root operator adapter, host-wide native
writer exclusion, live mutation, deployment or provider refresh-token usability
attestation is supplied. Exceptions during apply are conservatively unknown and
must retain the fence and durable receipt until inspected.
Delayed rollback also refuses expired signed tokens or grants; it does not
automatically relax freshness for recovery. The external host authority must
protect receipt storage and its ancestors against replacement, not merely set
the immediate receipt directory to owner-only access. Those host guarantees
remain absent here.
