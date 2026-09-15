## 2026-09-14 — Stored per-phase Trident accounting (#554)

### Change and scope

The run projection enumerated at `trident/store.ts:581` has 41 columns, verified
by evaluating `COLS.split(", ").length`. The filed count is correct; an earlier
progress entry miscounted it and is corrected below in the append-only progress
log. This change uses a child table rather than widening that projection. Migration `migrations/0144_trident_phase_usage.sql:11` stores one
snapshot per run and phase, with disjoint uncached-input, output, cache-read and
cache-creation token counters plus reported USD cost. Foreign keys and the primary
key bind each snapshot to its run and model phase (`migrations/0144_trident_phase_usage.sql:12`).

The phase vocabulary is the nine keys enumerated from `TRIDENT_PHASES`
(`trident/phase-models.ts:164`), including the mechanical-build follower.
`trident/phase-usage.test.ts:41` compares every seeded key with that registry;
removing the follower from SQL made this test fail. Catalog evolution therefore
requires a migration and backfill, not only a settings edit.

SQLite backfills existing runs and seeds new ones at insertion, in the same write
transaction (`migrations/0144_trident_phase_usage.sql:37`). This initialization
works without any reporting process surviving. SQLite constraints validate all
writes (`migrations/0144_trident_phase_usage.sql:15`); the store's transaction
serializes its observation-time check and replacement (`trident/phase-usage.ts:44`).
Foreign keys are armed by `persistence/db.ts:17`.

The public store export is `trident/index.ts:17`. Ownership is registered at
`migrations/table-ownership.json:140`. Tests run through the existing CI shard
command at `.github/workflows/ci.yml:437`; the ownership and phase-parity checks
are executable tests, not an uncalled validation script.

### Decisions and unknowns

The task explicitly requests a stored format. The filed issue did not specify
an ingestion contract. The enforceable storage criteria are now in
`docs/spec-items/trident-phase-accounting.md:27`, indexed by the generated rollup.

The new coverage vocabulary is `unknown`, `partial`, `complete`
(`trident/phase-usage.ts:20`), not the workflow verdict vocabulary at
`trident/store.ts:68`. Unknown is the database default: all measurements and
observation metadata are NULL. It does not claim the phase was skipped or spent
zero. Partial means some metrics were reported; complete requires all five,
including cost (`migrations/0144_trident_phase_usage.sql:23`). Completeness says
nothing about whether the workflow finished. Zero requires an explicit report.

Reports are absolute totals across every attempt of the named phase in this run,
not per-call increments (`docs/spec-items/trident-phase-accounting.md:17`). Source
and observation time establish provenance; the writer returns `recorded`, `stale`
or `unknown-target` (`trident/phase-usage.ts:38`). Older and duplicate timestamps
return stale without writing; unknown targets never create a free-floating row.
Invalid accepted writes throw the existing SQLite constraint error; nonfinite JS
values throw TypeError before binding can turn NaN into NULL
(`trident/phase-usage.ts:42`). These are storage outcomes, with no implicit
success/default conversion in this API (`trident/phase-usage.ts:48`).

Deliberately not built: provider harvesting, inferred prices, billing estimates,
a dashboard, workflow-wide totals, per-attempt history, or attribution from
instance-wide capacity samples. Reporters must supply phase-scoped cumulative
snapshots. Until such a reporter supplies measurements, real runs correctly
remain unknown. The task's explicit staging path overrides the standard shard
location for this record; no frozen record was edited.

### Mutation evidence

Each mutation ran alone against `bun test trident/phase-usage.test.ts`, with its
actual landing line printed and file diff captured before the run. Every mutant
parsed and ran behavioral assertions. After each restoration all 14 tests passed.
The following table enumerates all 18 mutation cases executed. Test locations
below are in `trident/phase-usage.test.ts`; SQL locations are in migration 0144.

| Guard / landing line | Mutation | RED test location | Restored |
| --- | --- | --- | --- |
| Input bounds, migrations/0144_trident_phase_usage.sql:15 | Replace CHECK with 1 | `trident/phase-usage.test.ts:97` (input) | GREEN |
| Output bounds, migrations/0144_trident_phase_usage.sql:16 | Replace CHECK with 1 | `trident/phase-usage.test.ts:97` (output) | GREEN |
| Cache-read bounds, migrations/0144_trident_phase_usage.sql:17 | Replace CHECK with 1 | `trident/phase-usage.test.ts:97` (cache read) | GREEN |
| Cache-creation bounds, migrations/0144_trident_phase_usage.sql:18 | Replace CHECK with 1 | `trident/phase-usage.test.ts:97` (cache creation) | GREEN |
| Observation bounds, migrations/0144_trident_phase_usage.sql:21 | Replace CHECK with 1 | `trident/phase-usage.test.ts:106` | GREEN |
| Cost bounds, migrations/0144_trident_phase_usage.sql:19 | Replace CHECK with 1 | `trident/phase-usage.test.ts:106` | GREEN |
| Coverage/provenance, migrations/0144_trident_phase_usage.sql:23 | Add 1 OR to CHECK | `trident/phase-usage.test.ts:125` | GREEN |
| Integer types, migrations/0144_trident_phase_usage.sql:35 | Remove STRICT | `trident/phase-usage.test.ts:97` (all four), `trident/phase-usage.test.ts:106` | GREEN |
| Run FK, migrations/0144_trident_phase_usage.sql:12 | Remove reference | `trident/phase-usage.test.ts:142` | GREEN |
| Phase FK, migrations/0144_trident_phase_usage.sql:13 | Remove reference | `trident/phase-usage.test.ts:142` | GREEN |
| Uniqueness, migrations/0144_trident_phase_usage.sql:22 | Remove primary key | `trident/phase-usage.test.ts:142` | GREEN |
| Backfill, migrations/0144_trident_phase_usage.sql:38 | Add WHERE 0 | `trident/phase-usage.test.ts:51` | GREEN |
| Insert trigger, migrations/0144_trident_phase_usage.sql:43 | Add WHERE 0 | `trident/phase-usage.test.ts:37` | GREEN |
| Catalog parity, migrations/0144_trident_phase_usage.sql:6 | Remove mechanical-build phase | `trident/phase-usage.test.ts:37`, `trident/phase-usage.test.ts:51` | GREEN |
| Unknown run, `trident/phase-usage.ts:31` | Disable run-existence check | `trident/phase-usage.test.ts:37` | GREEN |
| Finite values, `trident/phase-usage.ts:42` | Disable finite check | `trident/phase-usage.test.ts:116` | GREEN |
| Unknown target, `trident/phase-usage.ts:48` | Return stale instead | `trident/phase-usage.test.ts:89` | GREEN |
| Stale snapshot, `trident/phase-usage.ts:49` | Disable time check | `trident/phase-usage.test.ts:78` | GREEN |

### Validation

- 217 tests passed across `trident/phase-usage.test.ts`, `trident/store.test.ts`,
  `migrations/snapshot.test.ts`, `migrations/__tests__/table-ownership-conformance.test.ts`
  and `scripts/__tests__/spec-items-index.test.ts`.
- `migrations/runner.test.ts`: initially RED on its exhaustive migration list;
  after adding version 144 at `migrations/runner.test.ts:211`, all 22 tests passed.
  The assertion remains an exact list, not a count or relaxed comparison.
- `bunx tsc --noEmit -p trident/tsconfig.json`: GREEN.
- `bash scripts/ci/lint.sh`: GREEN.
- `bash scripts/ci/typecheck-all.sh`: FAILED after checking all 51 configs.
  Errors were TS2688 in app's implicit type-library resolution, TS2769 at
  `gateway/transcription/__tests__/whisper-install.test.ts:186` and
  `logger/__tests__/fire-and-forget.test.ts:301`, and TS2305 at
  `onboarding/history-import/__tests__/zip-writer.ts:10`. The root config repeats
  those source errors. No unrelated source or test assertion was changed to hide them.
- `bash scripts/ci/leak-gate.sh --tree .`: INCOMPLETE (exit 3), zero findings
  from executed rules, PII denylist and message-denylist rules unavailable.
- `git diff --check`: GREEN. The full test suite was not run.
