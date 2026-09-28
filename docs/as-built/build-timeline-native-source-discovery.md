## 2026-09-28 — Bounded native rollout discovery for the temporary dashboard

The native importer already reconstructed recorded command and completed-task
intervals, but the private refresher had to register every rollout/config pair.
That left a new native session invisible until manually registered
(`docs/as-built/build-timeline-native-task-phases.md:47-49`). The dashboard specification
requires explicit time-scoped PR mapping and invoking model context for direct
commands (`docs/spec-items/temporary-build-timeline-dashboard.md:102-108`).

The new discovery command scans one operator-authorized `sessions` root in the
native dated layout and imports each `rollout-*.jsonl` found there. It bounds a
scan to 256 files, 4,096 directory entries and 128 MiB. It rejects a symlink
root, skips symlink entries, checks resolved paths stay inside the authorized
root, and reads each source from
a file descriptor whose device, inode and size still match discovery. A fixed
byte count prevents a growing file from bypassing the scan budget. It refuses
duplicate native event identities across files. It emits phase observations on stdout and
aggregate coverage on stderr, without exporting command text, output or source
paths. The authenticated dashboard consumes the discovered phases.

Discovery supplies receipt files, not attribution. The existing importer still
requires an explicit time-bounded checkout-to-PR binding for ordinary command
spans; exact successful GitHub commands can identify their own PR. Completed
in-conversation tasks still require exact session/turn PR and phase bindings.
Unbound sources report coverage but do not create guessed phases. The private
refresher must retain immutable event IDs when appending observations, and must
register the one authorized root and binding config. No deployed refresh or
newly served live source is claimed here.

Focused tests verify new-file discovery through the authenticated JSON handler,
unbound exclusion, path/content privacy, symlink and unrelated-file exclusion,
post-discovery file and parent-directory replacement, and duplicate identity
refusal. Two semantic mutations were detected and restored: widening the
filename filter admitted an unrelated JSONL file; dropping
explicit bindings erased the positively attributed dashboard phase. Both root
and Trident TypeScript checks passed. Deployment verification remains the open
criterion in the dashboard spec.
