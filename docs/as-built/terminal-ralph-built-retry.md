## 2026-09-23 — Resume an evidenced terminal Ralph build after publication failure

The governing acceptance requires a retry to keep its checkpoint without paying
for planning again, including local merge mode
(`docs/spec-items/a-retry-must-resume-from-the-checkpoint.md:52`, `:57`).
The preserved constraints are G037 (intermediate tasks do not publish) and G038
(resume requires the exact recorded head), at
`docs/trident-gates-inventory.md:106` and `:107`. The locked pivot's live acceptance
remains an unattended merge (`docs/plans/harness-orchestrator-pivot-2026-09-11.md:294`).

A completed Ralph build used the same `built` checkpoint whether its validated
plan had more tasks or was finished. Cross-run retry therefore refused every such
checkpoint. This change records the validated plan's remaining-task count alongside
the host-measured build head (`trident/build-run.ts:488`). It is an optional field
in the existing JSON state, with no database migration. The parser rejects a
present malformed count (`trident/build-mode-state.ts:37`), and retry admits a
Ralph `built` checkpoint only with exactly zero remaining tasks (`:66`). An absent
field remains unknown; old checkpoints receive no inferred completion evidence.

The existing task, card link, project, repository, branch, base, head and source
event checks still apply. An appended retry note changes task identity and still
refuses adoption. Pending work and prior approval do not become retry authority.
The predecessor supplies completed checkpoint data, while the successor performs
publication proof and review again under its own identity.

Integration with the delivered continuation path preserves its separate
`ralph-task-built` eligibility and branch-local ledger. The composed fixtures seed
no ledger and let the host alone commit it. The checkpoint writer test supplies a
ledger consistent with its remaining count, satisfying the handoff's G025 guard.

Measured verification:

- `bun test trident/build-run.test.ts trident/cross-run-retry-checkpoint.test.ts
  trident/retry-resumes-checkpoint.test.ts trident/production-host-effects.test.ts`:
  442 passed, zero failed after integration with the terminal-suite and ledger changes.
- `tsc -p tsconfig.json` and `tsc -p trident/tsconfig.json`: passed.
- `bun test open/__tests__/project-build-e2e.test.ts`: 125 passed, zero failed
  (host execution with the local Unix sockets required by its owner fixtures).
- Real consuming cases in `open/__tests__/project-build-e2e.test.ts:2976` first build
  an intermediate task with the subset strategy, then the terminal task with zero
  remaining tasks and full-suite instructions. PR creation fails after its object
  push; local readiness fails before review. Both re-dispatch through the real store,
  import the exact build, repeat real mutation proof and review, execute the full
  suite in the successor, and merge without planning or building. Companion cases
  request a fix during resumed review and assert full-suite fix context even though
  no in-memory plan exists. A newly identified review is the positive control for
  the absence checks; the successor's suite log is the fresh execution receipt.
- Semantic mutations: accepting remainder one fails the unfinished-plan refusal;
  rejecting all Ralph builds fails the valid terminal retry; removing count
  validation fails all five malformed-count cases; rejecting zero as malformed
  fails twelve cases; writing zero for an intermediate plan fails the persisted
  count assertion. Each mutation changes behavior, not parsing, and was restored.
  After rebasing onto the terminal-suite change, both retry eligibility directions
  were repeated. The composed cases also fail when suite scope is forced always to
  subset or always to full-suite; forcing only fixes to subset specifically fails
  the two resumed-fix cases while the two no-fix controls still merge.

Limits: terminal-built adoption in PR mode still requires origin to hold the
candidate tip at dispatch; adopting an entirely unpublished terminal build is
outside this change. The existing intermediate continuation path uses the local
tip. A changed task remains
ineligible even if its added prose asks to resume. These tests are offline evidence,
not a deployment or live acceptance receipt; this extends the delivered retry behavior.
