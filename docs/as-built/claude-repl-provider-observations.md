## 2026-09-23 — Retain provider observations from bound Claude children

Implements the same-provider observation slice of
`docs/spec-items/trident-build-efficiency.md:100-115` for #1196. The project runner
reads host-owned child evidence after every outcome, including interruption,
refusal, provider block, invalid result and reservation recovery. The reader does
not dispatch work or authorize a result. The existing trailer validation and
reservation mechanisms still decide completion and prevent replay.

Only a uniquely identified child's transcript whose initial user envelope binds
the complete request, child and session supplies measurements. Assistant provider
envelopes supply the reported model, child identity and token/cache fields;
assistant text and worker result claims do not. Repeated content blocks for one
provider message retain cumulative maxima, and distinct message counts are
summed. Missing values stay unknown, explicit zero remains zero, and price stays
unknown because these provider envelopes do not report cost. The source is
`claude-repl-jsonl`. Host timestamps describe the bounded observation read window,
not inferred child execution duration. The durable attempt-ledger consumer is a
separate integration slice.

The reader rejects symlinks and special files, limits metadata to 16 KiB,
transcripts to an 8 MiB fixed snapshot, individual lines to 256 KiB and directory
enumeration to 4096 entries. A 250 ms deadline bounds the reader; timeout or
unreadable evidence leaves telemetry unavailable without changing the outcome.
Late I/O closes its descriptor and cannot proceed after cancellation. These
bounds intentionally prefer unknown totals over silently counting a prefix.

Verification uses `runtime/workers/claude-child-observation.test.ts`,
`runtime/workers/project-runners.test.ts`,
`runtime/workers/claude-acting-turn.test.ts`, and the unchanged consuming
`open/__tests__/project-build-e2e.test.ts`, plus both TypeScript configurations.
The real acting-turn/project-runner test retains nonzero usage through a provider
rate limit and recovery, with exactly one dispatch. Parser tests cover repeated
provider messages, partial failure, unknown/zero values, foreign identities,
oversized evidence, symlinks and stalled metadata I/O against legitimate reads.
Semantic mutations relaxed request ownership, over-applied the ownership refusal,
double-counted duplicate usage, discarded zero, and dropped the observation at
the consumer. Additional mutations removed symlink rejection, removed byte/line
bounds against otherwise-valid oversized evidence, and disabled the observation
deadline. Each made the corresponding tests fail before restoration. The bounded
reader does not prove complete live usage coverage: deployment measurement must
check that actual transcripts fit these limits and report unavailable readings.

Final local results: 137 focused tests and 125 consuming E2E tests passed; both
TypeScript checks passed. The consuming suite required local socket permission.
The exact prerequisite-base and candidate archive leak scans both report 455
identical inherited findings; this is a baseline-red tree, not a clean-tree
claim. The changed-file archive with the known-present LICENSE positive control
is silent, including this change's commit message scan.
