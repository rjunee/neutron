## 2026-09-29 — Keep partial importer coverage visible after a successful refresh

The timeline reader checked importer freshness and failure, but discarded its
partial flag and unbound/incomplete counts. A recent successful import could
therefore produce no API coverage warning despite having unassigned observations.

The reader now projects only validated booleans and nonnegative safe-integer
coverage counts into fixed warning text. Partial coverage, unbound observations,
incomplete sources and incomplete discovery each remain visible; explicit zero
and unknown counts stay distinct. Invalid metadata and future success timestamps
remain unverified. Raw errors, paths and additional importer fields never enter
the served warning. Source notes render expanded so the limitation is immediately
visible rather than hidden behind a disclosure control.

This change does not register sources, infer PR ownership, attribute sessions,
invent usage, or change lifecycle/liveness policy. Existing run-owned attempt
receipts still require an explicitly configured repository source. Registering
another repository path remains a separately reviewed deployment operation.

Verification: 39 focused timeline/server/popover tests passed, including the
file-backed authenticated API/HTML positive and negative coverage controls.
Two semantic mutants (suppress every partial warning; warn on complete coverage)
fail the coverage contract. Root and Trident TypeScript checks passed. The initial
sandboxed socket fixture could not bind; the approved loopback-capable rerun passed.
Served deployment verification remains separate from this code change.
