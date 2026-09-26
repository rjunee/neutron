## 2026-09-27 — Private process-test init reaps adopted children

The test namespace supervisor waited only for its foreground command. Exited
grandchildren adopted by PID 1 therefore remained zombies while the suite ran.
A confined natural-exit probe established both a readable pidfd and a remaining
`Z` process with parent PID 1. This explained why worker cancellation could kill
its grandchild yet fail the unchanged process-disappearance assertion.

After typed-namespace verification and external-parent authorization, the fresh
private init now restores the default SIGCHLD disposition and owns one central
child wait loop (`trident/process-test-isolation.py:151`). It reaps adopted
orphans while waiting for the exact foreground PID, preserves that command's
exit or signal status, and returns immediately when that command ends. It does
not wait for live orphans after foreground completion; exiting namespace init
retires the remaining namespace. A missing wait status is an error, never an
invented success. The `--check` and outer-launcher paths do not reset signal
dispositions or reap arbitrary children (`trident/process-test-isolation.py:172`).
No process census, numeric-PID signal, production ownership rule, or worker
disappearance assertion changed. The exact-claim and pidfd contract in
`docs/spec-items/dead-lane-process-reaping.md:16`–`26` remains intact.

Three real tests execute only after verifying the kernel boundary. They prove
that a live adopted child survives until released, its exited process is actually
waited away while the foreground continues, foreground zero/red/signal outcomes
are exact, and a foreground exit does not hang on a live orphan. Sixteen mock-only
controls retain the bootstrap and lifetime checks and cover central status
ownership, unknown waits, and non-init refusal. The original thirteen controls
remain mocked; no ownership fixture runs outside containment.

The original reviewed launcher with the new single orphan regression failed the
named unreaped-orphan assertion after three seconds. The repaired launcher passed
all three real tests in 0.690 seconds, and the same natural-exit probe reported
the orphan reaped. Standalone and already-contained Bun isolation suites each
passed six tests and 33 assertions. Root and Trident typechecks completed with
exit zero. The focused evidence does not replace the canonical suite or fresh CI
required by `docs/spec-items/cancel-stops-host-review-suite.md:78`–`80`.
