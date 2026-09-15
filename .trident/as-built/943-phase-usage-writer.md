## Issue 943 — phase usage writer production wiring

### What changed

Completed worker turns now report usage from the shared plan/build/review/fix boundary at `trident/build-run.ts:239-272`. The driver maps its work roles into the existing phase vocabulary at `trident/build-run.ts:256`: plan is decomposition, build and fix share build, and review is adversarial review. Repeated turns accumulate absolute input, output, and available cache-read totals at `trident/build-run.ts:257-269`; unavailable cache creation and cost measurements remain null at `trident/build-run.ts:266-267` instead of being invented as zero.

The production host requires the existing store at `trident/build-host.ts:20-28` and invokes its writer at `trident/build-host.ts:75-101`. It reads the persisted baseline before writing, so a resumed driver adds this invocation's cumulative totals without erasing earlier usage at `trident/build-host.ts:78-95`. A store verdict other than recorded throws at `trident/build-host.ts:99-100`; the driver's existing exception taxonomy converts that failure to an unknown build outcome.

### Decisions

The phase mapping joins the model-phase registry already defined in execution order at `trident/phase-models.ts:166-236`; no new outcome or phase value was added. Build fixes remain part of build because that registry describes build as both writing code and rewriting it against review findings at `trident/phase-models.ts:182-185`.

Reports are partial because the bounded-work contract supplies input, output, and optional cache-read tokens at `runtime/bounded-work.ts:112-116`, but supplies neither cache-creation tokens nor cost. Unknown measurements remain null, matching the database constraint at `migrations/0144_trident_phase_usage.sql:23-33`.

The continuously maintained invariant is that every completed worker turn passes through the single `work` helper and awaits persistence before proceeding at `trident/build-run.ts:239-273`. Persistence is host-owned and does not depend on the worker continuing after it returns its completed outcome.

### Tests and mutation proof

The driver test enumerates plan, build, review, fix, and repeated review dispatches through the fixture's scripted outcomes and checks every resulting cumulative report at `trident/build-run.test.ts:56-82`. The composed-host test checks the production store receives decomposition, build, and adversarial-review writes at `trident/build-host.test.ts:308-342`. Restart-safe baseline addition is checked at `trident/build-host.test.ts:344-361`.

| Guard | Mutation | Red | Restored green |
|---|---|---|---|
| Production host delegates phase reports to the store at `trident/build-host.ts:77-101` | Replaced the `recordPhaseUsage` implementation at the then-current `trident/build-host.ts:75` with an async no-op; the printed mutated line was `recordPhaseUsage: async () => {}` | `bun test trident/build-host.test.ts --test-name-pattern 'fresh null reviewed_head reaches allow and publishes through the driver'` failed because the expected three records were `[]` | The same focused command passed after restoring the writer call |

Validation: the five touched suites passed 174 tests. `runtime/tsconfig.json`, `trident/tsconfig.json`, and the root `tsconfig.json` pass. `bash scripts/ci/lint.sh` passes. The required environment-reader registry suite passes 21 tests. The full typecheck matrix checked 51 configurations; its affected configurations pass, while unrelated `app/tsconfig.json` fails because its implicit `@types` definition cannot be found.

### Deliberately not changed

No migration was added because the phase rows and update constraints already exist at `migrations/0144_trident_phase_usage.sql:11-43`. No feature flag or alternate writer path was added. Complete status and cost were not claimed because the bounded-work outcome does not measure all fields required for a complete database report.
