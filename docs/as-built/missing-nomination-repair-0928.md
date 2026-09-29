## 2026-09-28 — Repair a verified missing nomination through the bounded loop

A completed build with an explicit null mutation nomination stopped at publication
even when its pinned diff contained an executable legal target. Invalid executable
argv already reached the bounded nomination repair loop. The missing case now
produces a distinct typed repair outcome in `trident/mutation-prover.ts:4791`.
The outcome remains `ok: false`, nonexempt and without proof evidence. Eligibility
requires a Git-read diff, a surviving legal executable source and a successful
head recheck. Unknown heads or diffs, deletion-only changes, configuration-only
changes, failed proofs and infrastructure errors remain refusals.

The production reader at `open/wiring/project-build.ts:958` distinguishes an
authenticated worker's explicit null from unavailable, stale or foreign artifacts
by returning undefined for the latter. The forge schema requires the nomination
property (`trident/gates/result-contract.ts:155`); validation supplies no default.
The existing bounded driver owns repair, round ceilings and repeated-finding
arithmetic. Host-only stops retain `REVIEW_NOT_RUN`. A repaired nomination still
requires the mutation proof, suite, fresh review, CI and pinned merge gates.

Validation against the candidate based on `e69d0c773c776a92f8a2c13297c7d6d03feca3c9`:

- `bun test trident/mutation-prover.test.ts trident/build-host.test.ts open/__tests__/project-build-wiring.test.ts`:
  371 passed, zero failed, exit 0.
- Focused `open/__tests__/project-build-e2e.test.ts` selection covering unchanged-tip
  nomination retries, bounded fresh PR/local repairs, launch-pin mutation scope and
  the production base-drift refusal: 18 passed, zero failed, exit 0. The retry
  exercises `tests/fixtures/trident-sequence-trace/cli.ts` under `task_sequence`,
  retaining task iteration and budget, original artifact bytes and task-scoped
  FIX identity. Invalid worker identities dispatch no FIX; repeated omissions and
  exhausted rounds cannot merge or invent a review.
- Root and Trident TypeScript checks and ESLint on all seven changed source/test
  files passed. `git diff --check` passed.
- Three deliberate regressions each exited 1: removing missing-nomination repair
  fails the real PR consuming test; admitting all missing cases fails eligibility
  controls; removing the head recheck fails the moved-head control. Restored
  targeted controls and all 18 consuming cases passed.

The complete suite, complete TypeScript matrix, independent review, publication
and served verification belong to the combined integration gate; this focused
receipt does not claim those outcomes or close the live acceptance item.

The frozen combined code revision `a6b70aa328a02036121ce5ece73477a5ed269e4a`
subsequently passed `bash scripts/check-shared-host.sh` on 2026-09-29: all 51
TypeScript projects, including root and Trident, and all 1,751 discovered files
across 19 test lanes, with no failed lane. Its before/after suite-input identity
remained `2a20e9db0bd2335103e28999e4da5b2df1a0e862994cafb20a67144e6d379e72`.
The combined nomination/worker-scope change passed independent native and
complete-diff Claude Fable review. The intervening failed integration run exposed
a separate pre-existing native-snapshot test defect, repaired in the same batch;
that failed result was retained rather than rerunning unchanged until green.
Only documentation and the new as-built records changed after the passing code
check. Exact publication-head CI, deployment and a fresh unattended sequence
merge remain unproved; no review ceiling or failed-run history was reset.
