## 2026-09-29 — Keep partial importer coverage visible after a successful refresh

The timeline reader checked importer freshness and failure, but discarded its
partial flag and unbound/incomplete counts. A recent successful import could
therefore produce no API coverage warning despite having unassigned observations.

The reader (`scripts/build-timeline-import-status.ts:8`) now projects only validated booleans and nonnegative safe-integer
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

The single-phase hover (`trident/build-timeline-popover.ts:66`) also removes the duplicate activity heading and redundant
interval sentence. Duration, tokens and model appear before both local clocks;
the full explorer retains its range explanation. Existing grouped rows, shared
linear focus/overflow geometry and unknown-completion semantics are unchanged.
The consuming popover test checks the actual displayed text and both clocks,
including the explorer's positive control for retained range context
(`trident/build-timeline-popover.test.ts:128`).

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

Local validation at `19a9e3b82498db429dbd87b027b08b855f11c49c`:
`bash scripts/check-shared-host.sh` passed all 51 TypeScript configurations,
including root and Trident. Its partitioned 1,762-file suite was then terminated
on the coordinating agent's request to release host capacity; exit 143 is an
incomplete run, not full-suite acceptance. The focused command was
`bun test trident/build-timeline-popover.test.ts trident/build-timeline-html.test.ts trident/build-timeline.test.ts scripts/__tests__/build-timeline-import-status.test.ts scripts/__tests__/build-timeline-server.test.ts`
(41 passed, 600 assertions). The local whole-tree purity scan failed with 452
findings, including the untracked worktree pointer and existing denylist matches;
purity is not claimed green. Publication, exact-head CI and served acceptance
remain outstanding.

The publication preflight compared immutable tracked archives of candidate
`093c2c507` and fetched main `718fb2def` using the same local denylist and
`bash scripts/ci/leak-gate.sh --tree <archive>`. Both report the same 451
denylist findings (167 substring and 284 word matches); the worktree adds one
untracked-pointer finding. The candidate's changed files have zero denylist hits
under the gate's actual pattern compiler. The same compiler rejects known
baseline controls in `README.md` and `app/__tests__/general-scope.test.ts`.
The outgoing eight commit-message lines pass the messages-only scan. These
checks establish no candidate-introduced denylist finding, not a clean whole
tree. Main's successful CI purity uses inputs whose exact difference from the
local denylist remains unverified; candidate CI purity is still required.
