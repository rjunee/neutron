## 2026-09-30 — Sample importer freshness after reading status

The dashboard sampled its snapshot clock before asynchronous catalogue,
observation and importer-status reads. An importer success written during those
reads could therefore appear to be in the future and produce a false stale or
failed warning. `scripts/build-timeline-server.ts:94-95` now reads the status
before sampling the clock used for its freshness validation. The existing
future-time rejection and 60-second freshness bound remain enforced by
`scripts/build-timeline-import-status.ts:8-10`, consistent with
`docs/spec-items/temporary-build-timeline-dashboard.md:49-55`.

The production-source/API fixture in
`scripts/__tests__/build-timeline-server.test.ts:217-252` rewrites a real status
file and advances a controlled clock between the initial sample and source-read
completion. A success between those samples stays fresh; a success one
millisecond beyond the completion clock and one older than 60 seconds both warn.
Reverting the production call to its initial snapshot clock makes that fixture
fail (0 pass, 1 fail). The semantic mutants in
`scripts/__tests__/build-timeline-import-status.test.ts:75-90` also reject both
removing future-time rejection and applying it to every success.

Validation: the focused source, server and importer-status tests passed with
30 tests, 0 failures and 282 assertions. The existing loopback HTTP fixture
required running the focused command outside the restricted network sandbox.
TypeScript checks passed for the root and Trident configurations. An ignored local
dependency layer uses cached third-party packages with workspace links pointing
to this worktree; its Zod link uses the cached 3.25.76 package specified by the
lockfile rather than the cache's root 4.x link. Shared dependencies were not
modified. No visual, collector, publication or deployment behavior changed.
