## 2026-09-15 — Pay the per-shard CI toll four times

### What changed

The CI test matrix now has four legs at `.github/workflows/ci.yml:403-439`, and its executable shard denominator is the matching `/4` at `.github/workflows/ci.yml:463-465`. The app co-residency check remains on matrix leg one at `.github/workflows/ci.yml:455-462`.

### Decision and evidence

The prior eight-leg rationale was replaced with the measured queue-cost rationale at `.github/workflows/ci.yml:413-436`: eight legs consumed 1200 job-seconds, including about 920 seconds outside the test slice, while the complete run consumed 1527 job-seconds. Four legs remove four repeated setup tolls while returning the estimated longest test slice to 70.4 seconds, below the measured 163-second typecheck job.

Coverage does not default to permissive. The existing partition vocabulary enumerates two- and four-way layouts at `scripts/__tests__/run-tests-shard.test.ts:109-161`, requires no overlap at `scripts/__tests__/run-tests-shard.test.ts:130-132`, and requires no gaps at `scripts/__tests__/run-tests-shard.test.ts:134-136`. The workflow outcome vocabulary remains the aggregate `test` job: `scripts/ci/ci-workflow.test.ts:237-255` checks that every shard result is required and that matrix width equals the executable denominator.

### Mutation table

| Guard | Mutation | Red | Restored green |
|---|---|---|---|
| Matrix width equals `NEUTRON_TEST_SHARD` denominator | Changed `.github/workflows/ci.yml:465` from `/4` to `/8` while retaining four legs | `bun test scripts/ci/ci-workflow.test.ts` failed “the shard matrix size MATCHES the /N”, expected 4 and received 8 | `bun test scripts/ci/ci-workflow.test.ts scripts/__tests__/run-tests-shard.test.ts`: 95 pass, 0 fail |

### Deliberately not changed

No test-runner partition algorithm, test roster, fail-fast policy, app-suite isolation check, concurrency, or chunk size changed. No feature flag or alternate path was added.

### Verification

`bun test scripts/ci/ci-workflow.test.ts scripts/__tests__/run-tests-shard.test.ts` passed 95 tests. `bun test tests/integration/identity-env-readers-registry.test.ts` passed 21 tests. `bash scripts/ci/typecheck-all.sh` passed all 51 TypeScript projects, and `bash scripts/ci/lint.sh` passed. The leak gate found zero issues in runnable rules but was incomplete because its external identity denylist was unavailable.
