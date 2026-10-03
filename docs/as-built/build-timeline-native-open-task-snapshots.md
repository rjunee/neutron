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

### Consolidated local release verification

The coordinating `umask 022; bash scripts/check-shared-host.sh` exited zero
on tested revision `2ce3ab4886b58ff681f13b82cb747a3b85ef096a`. All 51 owned
TypeScript configurations passed. Declared, Bun-discovered, assigned and
executed coverage matched at 1,776 files across all 19 bounded-memory lanes,
with zero failed lanes. This includes the consuming Open project-build and
boot-adoption tests as well as the native importer, projection, registration,
journal and authenticated-server tests. Normal case-level skips were preserved;
the final 74-file HTTP batch reported 792 passes, 14 skips and zero failures.

Suite input identity remained
`973fc7de25171986b96bfb77c09aa6608a9ae4d89b1f4b7e3233f771742962ac`;
the retained complete log has SHA-256
`1e5b2e47ef468720e8aeeaa76371c579f0adf7a97c3e70c5ebfc1d6384f83460`.
The final publication head records this result without changing the tested
source, tests or dependencies. Exact-head CI and served deployment are still
required; this receipt does not invent active-worker liveness, registration of
unbound historical work, provider cost or complete all-PR phase coverage.

## Post-CI fixture correction: final tested revision

The unchanged dashboard implementation was included in the final canonical
`bash scripts/check-shared-host.sh` on clean revision
`225b91a01b630cb47f719fd64a632438bee661f4`. All 51 TypeScript configurations and
all 1,776 test files passed across 19 lanes, with zero failed lanes and unchanged
suite input identity `7b4722809fd1e649d8a44db71bfa104089e5f353beea94215704a83547ccb2fe`.
The complete retained log SHA-256 is
`012bf8475a6b5ace6590a6374f1ed65bf3be74a64ed3dbab5dd1c54dbd99cebe`.
The final publication head adds documentation only. This is local consuming
verification, not a claim that the new importer is deployed or that unknown
historical phase coverage has been recovered.
