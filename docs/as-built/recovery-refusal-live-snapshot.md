## 2026-09-29 — Preserve recovery refusals in live Work Board snapshots

The durable card refusal from issue #1415 reached HTTP board reads, but Open's
explicit `work_board_changed` WebSocket projection omitted it. Phone and web
replace their local boards with that snapshot, so a live update could erase the
visible reason until reload. The projection now carries the nullable
`recovery_refusal` field, and the wire type names that field. This does not change
the card's durable binding, lane, or refusal authorization.

A consuming test composes the real Open board and socket fan against a temporary
migrated database. It records a refusal and verifies the scoped frame remains
BLOCKED with the same reason after both client decoders. Negative controls prove
an ordinary card has no invented refusal, a stale compare-and-swap emits no new
frame, and another project's frame cannot replace this board. During development,
removing the projection failed the refusal assertion; fabricating a reason for
ordinary cards failed the null assertion. Restored code passed 57 focused Open,
phone, and web tests with 152 assertions. Root, Open, web, wire, and changed app
source typechecks passed; the as-built guard and commit-message leak gate passed.
The full app typecheck still reports an unrelated unused directive in test
support. These are local consuming checks, not a deployed live-traffic claim or
a full-suite receipt.
