## Issue #868 — app tests exercise co-residency deliberately

### What changed

CI now pins Bun 1.3.13 and keeps every install-cache key paired with that pin (`.github/workflows/ci.yml:246-255`, `.github/workflows/ci.yml:435-445`). One existing shard leg runs all app tests in a single invocation with Bun's per-file isolation and the same concurrency as CI (`.github/workflows/ci.yml:449-456`). The ordinary sharded whole-suite runner still follows immediately afterward (`.github/workflows/ci.yml:457-467`), so this adds a deliberate co-residency check without replacing the repository's bounded-memory coverage audit.

The wiring guard scopes its assertions to the `shard` job, requires the single-leg condition, and requires the isolated whole-directory command (`scripts/ci/ci-workflow.test.ts:267-271`). The app runbook names that command as the app-only check (`app/README.md:440-455`), and the runner documentation now distinguishes the app-wide isolation guard from the existing device process lane (`docs/testing-runner.md:94-116`).

### Decisions and why

Runner-owned per-file isolation was chosen because the harness installs a process-global source rewrite (`app/__tests__/support/native-harness.ts:123-163`) and the suite also contains process-global module mocks (`app/__tests__/docs-panes-render.test.ts:30-46`). File-local teardown cannot reverse a module registry collision reliably; Bun isolation supplies a fresh global and module registry for every file while retaining one invocation.

The guard runs only on matrix leg 1 (`.github/workflows/ci.yml:454-456`) but is independent of `NEUTRON_TEST_SHARD`, which is applied only to the following runner step (`.github/workflows/ci.yml:457-467`). A matrix resize therefore does not regroup or remove the app-wide check. Its failure joins the existing `shard` result vocabulary: the required `test` aggregator depends on `shard` (`.github/workflows/ci.yml:469-473`) and treats every result other than `success` as failure (`.github/workflows/ci.yml:478-492`). No new verdict or permissive default was introduced.

### Evidence and mutation table

The filed fetch citation moved: gateway installation is now `app/__tests__/reachability.test.tsx:154-174`, with save/install in `beforeEach` and restore in `afterEach` at `app/__tests__/reachability.test.tsx:178-204`. Harness platform and layout re-arming occurs per file at `app/__tests__/native-harness-selfcheck.test.tsx:34-42`; the shared reset restores layout, socket, and platform globals at `app/__tests__/support/native-harness.ts:347-380`.

| Guard | Mutation | RED | Restored GREEN |
| --- | --- | --- | --- |
| Runtime app-suite isolation | Run the same 159 files without `--isolate` | 1,828 pass / 179 fail | 2,007 pass / 0 fail |
| CI wiring guard | Remove only `--isolate` from `.github/workflows/ci.yml:456` | `parallel CI aggregator > one shard leg runs the whole app suite co-resident with per-file isolation` failed | The same focused test passed after restoring line 456 |

Focused validation passed: `bun test scripts/ci/ci-workflow.test.ts tests/integration/identity-env-readers-registry.test.ts` (102 pass), `bun test gateway/wiring/__tests__/persona-loader.test.ts`, `bash scripts/ci/typecheck-all.sh` (51 configurations), and `bash scripts/ci/lint.sh`. The root package has no `typecheck` script, so `bun run typecheck` refused with `Script not found`; the CI-owned typecheck matrix was run instead (`.github/workflows/ci.yml:261-265`).

### Co-resident app failure found by the new leg

The new leg exposed a real test-harness race in the queue-depth mutation guard. Production schedules the outage transition from a timer (`app/components/ConnectionNotice.tsx:61-64`, `app/components/ConnectionNotice.tsx:120-126`), but the old fixture waited on an unrelated timer and therefore inferred that React had committed the state update from elapsed wall time. The isolated focused run passed while printing React's outside-`act` warning; under co-resident runner load the assertion could arrive before React's timer-driven render flush.

The component now accepts a test-only deadline scheduler while its default remains the same real `setTimeout`/`clearTimeout` implementation (`app/components/ConnectionNotice.tsx:59-64`, `app/components/ConnectionNotice.tsx:150-163`). The queue-depth guard captures that deadline and fires it inside `act`, then still asserts the mounted notice and exact queue-depth text (`app/__tests__/connection-notice-quiet.test.tsx:179-204`). A complete `rg -n "scheduleDeadline|offlineAfterMs" app` enumeration found the scheduler seam only in the component and this test; production call sites do not select it. The old “Time is REAL here” claim was searched tree-wide together with its known replacement and had no remaining hit; the replacement is at `app/__tests__/connection-notice-quiet.test.tsx:28-30`.

| Guard | Mutation | RED | Restored GREEN |
| --- | --- | --- | --- |
| Deterministic mounted queue-depth guard | Change `setElapsed(true)` to `setElapsed(false)` at `app/components/ConnectionNotice.tsx:125` | Focused file: 10 pass / 3 fail; the subject guard failed at `app/__tests__/connection-notice-quiet.test.tsx:202` | Focused file: 13 pass / 0 fail |

Bounded validation passed after restoration: `bun test app/__tests__/connection-notice-quiet.test.tsx` (13 pass), `bun test --isolate app/__tests__/ --max-concurrency=4` (2,007 pass across 159 files), `bash scripts/ci/typecheck-all.sh` (51 configurations), and `bash scripts/ci/lint.sh`. No result vocabulary changed: the notice still returns only the existing text-or-null outcomes (`app/components/ConnectionNotice.tsx:87-97`), and the injected scheduler changes only how the test reaches the existing elapsed state.

### Deliberately not changed

The shard count remains eight (`.github/workflows/ci.yml:433`); pinning that count would only preserve an accidental grouping. The device-harness process lane remains in the bounded-memory runner (`scripts/run-tests.sh:657-675`) because it protects non-app packages and bounds the full-suite module graph; the new app-wide check is an additional CI assertion, not a second production path. No migration or environment read was added.

The production outage duration and rendering policy were deliberately not changed. The flapping guard retains real time because it measures continuity across status transitions (`app/__tests__/connection-notice-quiet.test.tsx:207-238`); only the loaded-runner-sensitive queue-depth fixture uses the controlled scheduler.
