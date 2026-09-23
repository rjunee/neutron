## 2026-09-23 — Recover host suite proof without replaying it

The project build host previously kept its review-suite observation only in a
closure. Reconstructing the same run lost that observation and reran the full
publication suite. This change persists the original host observation in the
run's existing stage-event store, with atomic compare-and-append invalidation
before fresh acquisition and completion bound to that acquisition's event.

Reuse requires the same run, project, repository, worktree, branch, launch base,
head, round, full-suite scope and strategy. A host identity callback measures
dependency manifests and locks, runtime executable, workspace and installation
identity, and local package resolutions using the dependency-preparation owner's
existing fingerprint functions. The suite identity additionally observes every
installed file's inode, mode, size and nanosecond modification/change timestamps,
including internal package files beyond the resolved entrypoint. Restoring a
file's modification time cannot hide its changed content. Directory links must
remain inside the workspace. Dirty or unknown inputs do not reuse proof.
The complete installation measurement uses a bounded native no-follow metadata
walk with NUL-delimited fields, and validates links before traversing extra local
roots. It returns unknown on timeout, failed acquisition or malformed data. On a
real 1.3 GB installation the replacement measured a known identity in 0.92 seconds;
the superseded serial JavaScript walk took 26.59 seconds. This is still linear in
installed files, not a constant-time claim or a deployed benchmark result.
The publication round is read from the driver's durable checkpoint on recovery.
Receipts retain their original identity and are still assessed by G063–G065;
they neither grant review approval nor replace publication and merge gates.

This implements the proof-reuse portion of
`docs/spec-items/trident-build-efficiency.md` and does not close that item's
deployment and live benchmark requirements. Composition must supply the measured
identity callback; an absent callback performs fresh proof every time.

Verification covers reconstructed host reuse and required fresh proof after
head, round, run, strategy, scope or measured input changes; malformed and missing
receipts; interrupted acquisition; stale completion; and invalidation during an
asynchronous identity measurement. Separate real-worktree tests exercise dirty
manifests, lock/config and code changes, runtime replacement, moved worktrees,
installation replacement and ancestor symlink refusal. Semantic mutations remove
identity equality (unsafe reuse is detected) and suppress reuse (unnecessary
suite replay is detected). Both mutations fail invocation-count assertions rather
than parsing. Omitting the installed-tree fingerprint also fails the internal
dependency edit test. Native acquisition tests require a single bounded argv
invocation for ordinary installed files, preserve unusual filenames, and exercise
timeout, exit failure, truncated output and local/external link targets. Removing
the timeout and link-confinement guards produces semantic assertion failures.
The restored focused suite passes 50 tests; both TypeScript projects pass
independently.

Integration remains pending in this intermediate commit: the composition does
not yet supply the callback. The consuming
`open/__tests__/project-build-e2e.test.ts` run therefore has two suite-count
failures from the missing callback (140 passing, plus nine socket-listen sandbox
failures). Final wiring and an unrestricted consuming rerun are required before
this change is eligible for publication.
