## 2026-09-28 — Retain a candidate after a settled proof-only fix failure

The recovery requirement in `docs/spec-items/trident-build-efficiency.md` owns
this change (#1196). An initial single-strategy build could publish successfully,
receive approving code reviews, and fail only the host suite. A completed fix
that left the candidate unchanged correctly stopped at G042, but its terminal
pending fix reservation prevented an ordinary retry from retaining the build.

`trident/settled-proof-fix-recovery.ts` admits only the exact initial
plan/build/review/rejection/fix sequence, under its original identity. It checks
the original armed requests, complete attempt journals, intact briefs and turn
contexts, matching results, and independently completed approving standalone,
panel, and synthesis results. The panel census is the authenticated synthesis
input corroborated by the admitted attempt ledger and individual receipts; it
does not claim a separately persisted historical configuration roster. The
sole host rejection must match the original nonzero full-suite receipt and its
recorded blocker baseline. A worker's pre-existing-failure claim establishes
neither eligibility nor suite success.

The importer leaves the terminal source unchanged and presents its candidate
as built at round two, charging the consumed fix round. It carries the original
findings, review baseline, strategy and task spend. Changed current role models,
effort, authority, budget or rendered instructions refuse consumption. New suite,
mutation and review evidence is required; the failed source suite is never
adopted. G042, arithmetic stops, publication preservation and round ceilings
remain enforced. Other terminal shapes, later-round fixes, legacy evidence and
unsettled work remain outside this narrow admission path.

Focused verification on the working change based on `ed1c4a205dd2`:

- `bun test trident/settled-proof-fix-recovery.test.ts trident/build-run.test.ts trident/cross-run-retry-checkpoint.test.ts open/__tests__/project-build-e2e.test.ts -t 'settled proof-only'`:
  13 passed, 208 assertions. The consuming fixture restores the published
  candidate with zero additional planner, builder or fix dispatches, runs a
  fresh suite and round-two review, and retains the original source events.
  Missing or altered evidence, a missing seat across the ledger and artifacts,
  genuine code findings, changed inputs, persistent suite failure and a lowered
  ceiling exercise refusal and bounded-stop paths.
- A subsequent consuming check added an explicit new-run mutation-worktree
  assertion and exercised the existing historical settled-review consumers:
  5 passed, 91 assertions. It ran only the selected cases, not the full E2E file.
- Two semantic mutations were killed at behavioral assertions: disabling the
  new import failed candidate reuse; bypassing settlement authentication failed
  missing-evidence refusal. Each mutant retained a passing G042 control. The
  restored focused run above passed; neither kill was a parser or import error.
- `git diff --check` passed. Final integrated TypeScript checks, complete local
  gates and exact-head CI remain the publication gate; these focused results do
  not establish a served cutover or close #1196.
