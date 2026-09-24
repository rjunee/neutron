## 2026-09-24 — Restrict review reconciliation to original evidence

This is an independently testable prerequisite for #1196, not the cross-run
retry fix. The retry pending guard remains in place. No predecessor observation
is imported into a successor, and this change does not eliminate planner or
builder replay.

`trident/project-review-source.ts:48` exposes a reconciliation constructor that
shares the existing receipt identity and validation implementation. Its operation
authority permits reading completed receipts and recovering exactly journaled
pending requests, but refuses missing receipts before claiming or dispatching
work (`trident/project-review-source.ts:153`). This covers missing seats,
synthesis and deferred retries. It is an explicit restricted operation, not a
deployment feature flag. Recovered rejection remains rejection; unresolved
provider evidence remains uncertain. Original run, worktree, task, head, model,
credential and policy identities remain part of receipt eligibility.

`trident/project-review-source.test.ts:63` counts dispatches for completed reuse,
missing work, pending recovery and changed identity. The semantic mutation test
at `trident/review-verdict-repair-mutation.test.ts:59` proves both directions:
removing the refusal purchases work, while unconditional refusal loses valid
reuse. Each mutant has a separately passing sibling control.

Validation on base `1ba43691d388bf4bae588c89356c8071c921301b` plus this change:

- Review source and mutation suites: 63 passed, zero failed.
- `bun test trident/cross-run-retry-checkpoint.test.ts trident/build-run.test.ts
  open/__tests__/project-build-e2e.test.ts`: 725 passed, nine failed in the
  sandbox. A focused diagnostic reproduced denied Unix socket listening
  (`EPERM`). Rerunning the nine socket-dependent cases with local socket access
  passed all nine. These are regression checks, not new cross-run acceptance.
- Root and Trident TypeScript projects: passed with `tsc --noEmit -p`.
- ESLint for the three changed TypeScript files: passed.
- Full-tree leak gate: failed with 456 findings, including the worktree metadata
  pointer and matches outside the changed files. This is not a clean purity
  receipt.
- Export of the four changed files plus the repository license: leak gate passed
  with zero findings. This limited check does not replace full-tree validation.

Still required for the P0: original standalone-runner reconstruction, authenticated
predecessor scope selection, a compare-and-append reconciliation receipt pinned
to the source event and current inputs, and successor consumption preserving
base/head/budgets while retaining suite and review gates. Consuming cross-run
dispatch-count acceptance remains outstanding.
