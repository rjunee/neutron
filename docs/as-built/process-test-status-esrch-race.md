## 2026-09-28 — Orphan status polling accepts procfs ESRCH

PR #1346's unchanged process-isolation test failed in shard 3 when `Path.exists()` on an exiting orphan's `/proc/<pid>/status` raised `ProcessLookupError` (`ESRCH`) instead of returning false. PR #1368's shard 3 passed the same test. The failure was in the test's observation of procfs disappearance, after the pidfd reported exit; it did not establish a change to the namespace init's reaping behavior.

`trident/process-test-init-test.py` now interprets only `ProcessLookupError` as disappearance in both the bounded polling loop and final assertion. The live-child status assertion remains before release, and the test still requires pidfd exit and a vanished proc entry. A focused control drives present, absent, and ESRCH outcomes and requires permission and I/O errors to propagate. The consuming Bun test now expects four Python tests.

The complete `trident/process-test-isolation.test.ts` passed 8/8. The real namespace init case passed 20 consecutive runs. Mutating ESRCH handling to report presence made the focused control fail; broadening the catch to all `OSError` made both unrelated-error controls fail. Root and Trident TypeScript checks passed with `tsc -p ... --noEmit`. This focused evidence is not a substitute for the host-observed full-suite receipt required by G063 (`docs/trident-gates-inventory.md:148`).
