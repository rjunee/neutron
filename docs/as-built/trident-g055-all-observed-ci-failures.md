## 2026-09-25 — Preserve optional CI failures in the review verdict

Issue #1311 restores the existing G055 contract in
`docs/trident-gates-inventory.md:140`. Required names determine whether review
readiness must wait, but they do not limit which observed failures count as
actionable CI evidence. The classifier previously discarded settled CodeQL or
lint failures whenever the required `test` check was green.

`trident/gates/review-readiness.ts:47` retains the required-check settlement
rules and collects every observed failed name at line 54. Optional running checks
still permit readiness once the required checks settle. Unknown configuration,
incomplete evidence, required running checks and conflicts retain their existing
refusals. The unchanged adapter at `trident/project-observation-sources.ts:62`
carries those names into G055, where missing pinned-base evidence grants no
advisory exemption.

`trident/gates/review-readiness.test.ts:36` covers multiple optional failures,
deduplication and an optional running sibling. Consuming cases at
`trident/project-build-host.test.ts:394` exercise acquisition through
`assessReviewCi` and `applyReviewCi`: settled CodeQL, lint and required-test
failures demand a fix; optional running/skipped/green checks preserve approval;
unknown or incomplete evidence defers.

Two temporary semantic mutations were applied to production code and restored.
Filtering failed rows back to required names made both consuming optional-failure
cases fail with missing findings, while the required-red and optional-running
controls passed. Counting running rows as failed made the consuming
optional-running control fail with a fabricated CodeQL finding; the unknown
evidence control still passed. These were assertion failures, not parser errors.

Local validation used a fresh worktree based on public main
`14d3aec8c56542be3c719555d756a31f97e369a0`, with frozen dependencies installed
inside that worktree:

- `bun test trident/gates/review-readiness.test.ts trident/gates/review-ci.test.ts trident/project-build-host.test.ts`:
  68 passed, zero failed after restoring both mutations.
- `bunx tsc --noEmit -p tsconfig.json` and
  `bunx tsc --noEmit -p trident/tsconfig.json`: both passed.
- `bash scripts/ci/lint.sh`: passed all checks. Changed-file ESLint and
  `git diff --check` also passed.
- The explicit `open/__tests__/project-build-e2e.test.ts` run initially hit
  sandbox `EPERM` on three Unix-socket fixtures. The targeted rerun outside the
  sandbox (`-t 'idle Codex MCP revocation|durable Open owner MCP'`) passed all
  three. The remaining cases were still running when this record was prepared;
  no complete-file pass is claimed here.
- The leak gate passed with zero findings over a snapshot of the four changed
  files plus `LICENSE`. A full worktree scan reported 452 findings, including
  the linked-worktree metadata and existing local-denylist matches outside this
  change; it is not claimed green.

Full host-suite, public CI, merge and served deployment verification belong to
integration and are not claimed here.
