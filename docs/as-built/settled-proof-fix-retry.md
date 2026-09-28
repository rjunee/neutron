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
- `git diff --check` passed. These focused results do not establish a served
  cutover or close #1196.

Final integrated local receipt:

- Reviewed implementation was rebased without content changes onto merge
  `e8e8ed40e5cae2e4736f846659e7fe0d94091438`; the two implementation commits
  remained identical under `git range-diff`. Integrated tested revision:
  `3c482747d87af2696137c01b19f3114ad0a23c81`.
- `bash scripts/check-shared-host.sh` passed once on that revision: all 51
  TypeScript configurations, including root, Trident and Open, and all 1,751
  declared/discovered/executed test files across 19 lanes, with zero failed
  lanes. The complete consuming `open/__tests__/project-build-e2e.test.ts`
  ran in that suite. The wrapper retained unchanged suite-input identity
  `3c5dc59fadea786b1e578658a4686f6a3e0249afed97d36ada1953f7fb6ae5fb`.
- Final fixture typing corrections preserve all refusal controls without casts
  or readonly mutation. The consuming focused rerun passed 13 cases and 209
  assertions; the binding fixture passed one case and 11 assertions.
- This final narrative is the only addition after the measured local gate.
  Required CI must pass on the publication head. Deployment and a fresh live
  proof-only retry remain unverified; neither this receipt nor the earlier
  unattended single-build merge demonstrates this new importer in production.
