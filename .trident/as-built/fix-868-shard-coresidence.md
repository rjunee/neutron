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

### Deliberately not changed

The shard count remains eight (`.github/workflows/ci.yml:433`); pinning that count would only preserve an accidental grouping. The device-harness process lane remains in the bounded-memory runner (`scripts/run-tests.sh:657-675`) because it protects non-app packages and bounds the full-suite module graph; the new app-wide check is an additional CI assertion, not a second production path. No migration or environment read was added.
