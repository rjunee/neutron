## 2026-10-04 — Fail shared-host admission early on CI lint errors

The shared-host wrapper previously started every typecheck and then the full
suite without first running the existing CI lint gate. A deterministic lint
failure could therefore be discovered in CI after expensive local work began.
`scripts/check-shared-host.sh:119` now calls `bash scripts/ci/lint.sh` before
either expensive gate. A lint error preserves its nonzero status, explicitly
reports that no receipt was established, and exits before typechecks or tests
(`scripts/check-shared-host.sh:120`). Green lint continues through the existing
typechecks, complete runner and before/after suite identity comparison
(`scripts/check-shared-host.sh:124`). The invocation stays inside the existing
admission lock and follows the existing environment scrub; no selector or bypass
is added.

The executable fixture records lint, typecheck and suite in order under the real
directory lock (`scripts/check-shared-host.test.ts:22`), proves green lint reaches
both gates with the existing jobs/chunk settings
(`scripts/check-shared-host.test.ts:44`), and proves red lint invokes neither
expensive gate, produces no unchanged-identity receipt, preserves exit 17 and
releases admission. Green lint followed by red typechecks or red tests retains
the same failure status (`scripts/check-shared-host.test.ts:126`). Existing
identity-drift, selector-scrub, remote-base and worktree-contention controls remain.

Validation: `bun test scripts/check-shared-host.test.ts` passed 19 tests and 76
assertions through the required process isolation. Replacing the lint invocation
with `true` made `bun test scripts/check-shared-host.test.ts -t 'lint failure'`
fail (expected exit 17, observed 0); the mutation was restored. Shell syntax and
diff whitespace checks passed. This focused proof does not establish a full-suite
receipt; no full-suite run or CI run was started for this bounded change.
