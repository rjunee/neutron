## 2026-09-24 — Preserve named host suite failures through the Bun package wrapper

Follow-up to #1261. The host ran the repository's package test command, `bun run test`,
which resolves through `package.json` to the partitioned Bun runner. The diagnostic
parser recognized direct `bun test` and `run-tests.sh` commands but classified that
package wrapper as generic. A red test near the middle of a long suite log was then
absent from the bounded tail in the fix finding. The review panel happened to name the
test independently in the observed run, but the host finding could not provide it.

`suiteFailure` now recognizes the exact `bun run test` wrapper (with the host's
bounded job and concurrency exports) only when the pinned worktree's `package.json`
names `bash scripts/run-tests.sh` and that regular runner file contains its Bun
execution and coverage-audit seams. Other commands and missing, changed, oversized,
or unreadable files remain generic. This is static inspection; no script is run to
classify a failure. Existing limits on log lines, the tail, and failure identity
remain in force. The host-observed exit and review gate still decide the suite result.

The focused parser and review-gate run passed 14 tests with 123 assertions. Its
regression checks both admission and refusal, and confirms that the named test
reaches the fix finding. Restricting the valid wrapper to generic and admitting a
changed package script were each tested as semantic mutations; both made that
regression fail, and the restored implementation passed. Re-parsing the captured
live red log with the admitted wrapper produced a Bun identity and named the
discovery-order test.

The explicit consuming `open/__tests__/project-build-e2e.test.ts` run passed 295
tests and hit nine local Unix-socket permission failures in Codex owner cases.
Those exact nine were rerun with socket access and passed (125 assertions). Root
and Trident TypeScript checks and `scripts/ci/lint.sh` passed. No full suite was
run for this follow-up.
