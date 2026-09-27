## 2026-09-27 — Retain host-suite identity and process observations

A host-selected full-suite attempt ended with an interrupted chunk and incomplete
coverage. Its terminal message said the suite inputs changed, but the receipt
consumer used that same message when the follow-up identity measurement returned
null. The old event retained neither measurement. The retained runner log showed
private PID/mount isolation for the interrupted chunk and a completed coverage
audit; it did not identify the TERM sender or the failing identity component.
Those historical causes remain unknown. This change does not claim to repair the
interruption or establish a passing full-suite observation.

`trident/project-suite-receipt.ts:43` now stores the first measurement before
execution. At completion it retains both hashes/timestamps and the observed host
exit even when the identity guard refuses proof (`:58`). An unavailable second
measurement has its own unknown reason; a different measured hash retains the
existing changed-input reason. Diagnostic metadata has no `receipt` or top-level
reusable `identity`. The existing atomic ownership check controls its write, and
the existing identity/owner/scope/revision/round/strategy checks still control
reusable proof (`:68`).

`open/wiring/project-build-dependencies.ts:113` identifies failed installed-tree
probes using fixed reason codes and elapsed time, including the existing five
second deadline. Suite-level probes also report their stage and safe component
digests (`:183`, `:229`). Logs exclude raw workspace paths, status output, file
contents and exception text. `trident/host-suite.ts:101` records the actual process
exit, elapsed time, configured deadline, timeout/cancellation flags and validated
owner cleanup outcome before disposing of the temporary report. None of these
diagnostics is suite evidence or permission to bypass G063/G065.

Validation on base `8cb600a4eb415b0104fada2d2c5bf518c532820b` plus this diff:

- `bun test trident/project-suite-receipt.test.ts trident/project-build-host.test.ts open/__tests__/project-suite-identity.test.ts`:
  71 passed, zero failed. Real database events distinguish both measurement
  outcomes for host exits zero and one; recovery reacquires refused observations,
  while unchanged measurements reuse their original receipt.
- `bun test trident/host-suite.test.ts open/__tests__/project-build-e2e.test.ts -t 'prepared host suite receipt|workspace scratch churn|package-local workspace resolution|reported known cleanup|suite timeout stays|low suite timeout'`:
  14 passed, zero failed, 368 filtered, in the required private process namespace.
  These consuming cases exercise reconstruction, input changes, scratch churn,
  generated-file rewrites, publication reuse and timeout refusal.
- `bunx --no-install tsc --noEmit -p tsconfig.json` and
  `bunx --no-install tsc --noEmit -p trident/tsconfig.json`: both exited zero.
- Semantic mutations of the receipt identity guard were restored after testing.
  Disabling refusal produced six assertion failures and two passing unchanged
  siblings: changed/unavailable inputs incorrectly returned known observations.
  Refusing every nonempty identity produced eight assertion failures, including
  both legitimate unchanged observations. Restoring the guard returned the
  focused command to 71 passes. These were behavior assertion failures, not
  parser failures.

The complete partitioned suite, all-project typecheck wrapper, exact publication
head CI, and a new deployed host observation remain for the coordinated
publication workflow. Existing cached third-party dependencies were used with
workspace aliases pointing at this worktree for the focused checks; these checks
are not an isolated-install or full-suite reuse receipt.
