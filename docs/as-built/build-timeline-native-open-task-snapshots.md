## 2026-10-03 — Native registered tasks appear before completion

The native importer accepted only completed task envelopes, so an explicitly
registered build, review, fix or test remained absent while underway. The
receipt projection also discarded task starts. A bounded local shape inspection
confirmed native `task_started` carries `turn_id` and epoch-second `started_at`,
and `task_complete` repeats that start with `completed_at`. Only sanitized shapes
were used; no transcript content or private identities enter these fixtures.

`scripts/build-timeline-codex-import.ts:241` now consumes native starts and
`:299` emits a missing-completion envelope as open with incomplete coverage.
Exact session/turn bindings still own its PR links and category (`:303`).
Cumulative exact-turn usage remains disjoint input/output/cache-read evidence;
missing, foreign, malformed or regressing usage stays unknown. The importer
updates one stable phase with deterministic snapshot event IDs (`:312`), native
observation clocks, and no liveness inference from its absent end. Nested command
spans retain unknown usage. The checkpoint projection retains starts and needed
observation clocks (`:118`); partial tails defer start-backed snapshots (`:389`).

The journal's native-task model exception in
`scripts/build-timeline-sources.ts:434` permits later evidence to reveal a model
or mixed-model uncertainty. Exact turn identity, category, PR links and start
remain immutable. Other phase models remain immutable. Equal-time conflicting
snapshots retain the existing ambiguity refusal. Existing older checkpoints
cannot recover discarded starts on zero-byte replay: bounded backfill is required
while retaining the observation journal. The dashboard guide and the existing
temporary-dashboard spec item document that upgrade limit and the remaining
manual registration/source-coverage boundary.

Validation on the candidate based on `118e287ff`:

- `bun test scripts/build-timeline-codex-import.test.ts scripts/build-timeline-codex-discover.test.ts scripts/build-timeline-codex-projection.test.ts scripts/build-timeline-sources.test.ts scripts/build-timeline-register-turn.test.ts trident/build-timeline-html.test.ts`: 90 passed. The consuming checkpoint/API test at importer test `:39` verifies start, cumulative usage growth, completion, mixed model, replay, auth and no command double-accounting. Registration test `:29` exercises root and child tasks in all four requested categories.
- `bun test scripts/__tests__/build-timeline-server.test.ts`: 11 passed with loopback listener permission. The initial sandboxed invocation failed only its ephemeral listener creation; that refusal is not counted as a pass.
- Disabling the native-start branch made the consuming API test fail. Removing exact turn matching made the foreign-turn refusal test fail. Both semantic mutations were restored before the passing run.
- `bunx tsc --noEmit` and `bunx tsc --noEmit -p trident/tsconfig.json`: both passed. Full shared-host validation, publication, CI and deployment remain the coordinating change's responsibility; this focused receipt does not claim those gates or all-PR coverage.
