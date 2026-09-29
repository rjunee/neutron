## 2026-09-29 — Keep partial importer coverage visible after a successful refresh

The timeline reader checked importer freshness and failure, but discarded its
partial flag and unbound/incomplete counts. A recent successful import could
therefore produce no API coverage warning despite having unassigned observations.

The reader now projects only validated booleans and nonnegative safe-integer
coverage counts into fixed warning text. Partial coverage, unbound observations,
incomplete sources and incomplete discovery each remain visible; explicit zero
and unknown counts stay distinct. Legacy success-only records and omitted
completeness fields remain visibly unverified. Invalid metadata and future success timestamps
remain unverified. Raw errors, paths and additional importer fields never enter
the served warning. Source notes render expanded so the limitation is immediately
visible rather than hidden behind a disclosure control.

This change does not register sources, infer PR ownership, attribute sessions,
invent usage, or change lifecycle/liveness policy. Existing run-owned attempt
receipts still require an explicitly configured repository source. Registering
another repository path remains a separately reviewed deployment operation.

The single-phase hover also removes the duplicate activity heading and redundant
interval sentence. Duration, tokens and model appear before both local clocks;
the full explorer retains its range explanation. Existing grouped rows, shared
linear focus/overflow geometry and unknown-completion semantics are unchanged.
The consuming popover test checks the actual displayed text and both clocks,
including the explorer's positive control for retained range context.

Verification: 41 focused timeline/server/popover tests passed, including the
file-backed authenticated API/HTML positive and negative coverage controls.
Three semantic mutants (suppress every partial warning; warn on complete coverage;
suppress unknown coverage)
fail the coverage contract. The initial
sandboxed socket fixture could not bind; the approved loopback-capable rerun passed.
Served deployment verification remains separate from this code change. A read-only
anonymous request to the existing deployment returned 401; its pinned source still
contains the redundant hover content. No authenticated visual review or deployment
was performed for this change.
