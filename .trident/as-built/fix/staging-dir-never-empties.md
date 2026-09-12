## 2026-09-12 — the as-built staging directory cannot empty, and the rule is a CI refusal rather than a paragraph

`#651`. Fixes a merge-conflict class that arrived carrying instructions to break the
as-built one-writer rule.

**THE DEFECT, MEASURED RATHER THAN PREDICTED.** A branch stages exactly one as-built
record at `.trident/as-built/<branch>.md`, and after the PR merges the promoter moves it
to `docs/as-built/<slug>.md` on the base and deletes the staging file
(`promoteInScratch`, `trident/as-built-appender.ts:161`). trident is not running that
loop yet, so promotion is currently manual. When a promotion consumes the LAST staged
record in a directory, that directory has no tracked file left and so stops existing in
the tree — and the promotion commit is, file for file, a move out of that directory into
`docs/as-built/`. Git reads the pair as a DIRECTORY RENAME, and every open PR carrying a
staged record there acquires:

```
CONFLICT (file location): .trident/as-built/<path>.md added in <sha> inside a directory
that was renamed in origin/main, suggesting it should perhaps be moved to
docs/as-built/<name>.md
```

On 2026-09-12 promoting the single remaining record emptied the directory and two of the
seven then-open PRs immediately acquired exactly that conflict. What makes it worth a fix
rather than a rebase is the suggestion: moving a staged record into `docs/as-built/`
writes a shard FROM A BRANCH, which is the one thing the one-writer rule exists to
forbid — the promotion happens on the base, after the merge, or not at all. A conflict
that arrives with instructions to violate an invariant is worse than a plain conflict,
because the fastest way out of it is the wrong way.

**THE FIRST FIX WAS TOO SMALL, AND THE TEST IS WHAT SAID SO.** The branch shipped a
single tracked `.trident/as-built/.gitkeep` plus a README paragraph. Writing the test the
cross-model gate asked for — a real merge across a real promotion, not "the file exists" —
produced a four-way probe with this result:

```
  floor in the record's own directory   merge clean
  no floor at all                       CONFLICT (file location)
  TOP-LEVEL floor only, record in a subdirectory   CONFLICT (file location), STILL
  top-level floor only, record at the top          merge clean
```

Git decides directory-rename detection ONE DIRECTORY AT A TIME, and skips it only for a
directory that still exists. Branch names in this repo carry a slash, so records land at
`.trident/as-built/fix/<name>.md` far more often than at the top — measured across the
seven open PRs, six staged into a subdirectory (`docs/`, `feat/`, `fix/`, `trident/`) and
one at the top. A lone top-level placeholder therefore left the common case entirely
unfixed. It would have merged green, and the next promotion would have reproduced the
conflict it claimed to have removed.

**WHAT SHIPPED.** The floor is per-directory: `.trident/as-built/.gitkeep` and a
`.gitkeep` in each directory that holds a staged record. Floors ship for the four
branch-name prefixes the open PRs actually use, so no open PR has to do anything but
rebase; a record staged under a new prefix brings its own, and the guard names the exact
path to add.

**WHY THE FLOOR IS NOT A `README.md`.** Both promoters glob the staging directory for
`*.md` (`trident/as-built-appender.ts:101`), so a `.md` file placed there as a
placeholder would be consumed and promoted as though it were a record — and the directory
would be empty again, one run later, with the explanation of the invariant now filed as a
historical record. A floor is any tracked file that glob cannot carry away.

**THE RULE IS ENFORCED, NOT DOCUMENTED.** The first version of this change stated the
invariant in `docs/as-built/README.md` ("must never be deleted") with no machine check.
That is the failure the root `AGENTS.md:65-67` names: a rule living only in prose is
advice to an agent that has never read it, and the mechanism that works is a
machine-checked refusal at the moment of the mistake. So:

  - `scripts/ci/as-built-staging-floor-guard.sh` refuses two things — a branch that
    removes the floor under `.trident/as-built/` itself, and a proposed tree in which ANY
    directory holding a staged record has no floor. It reads the TREE rather than a diff,
    which catches a deletion, a rename of the floor, a rename of the whole directory, and
    a record staged into a directory that never had one; and it needs no merge base, so a
    depth-1 Actions checkout cannot make it indeterminate.
  - It is invoked from `scripts/ci/check-governed-repo-attributes.ts`, which the
    `layering` job already runs unconditionally at `fetch-depth: 0` — the same relocation
    the two guards already hosted there document, for the same reason: no agent in this
    system can write `.github/workflows/`, so the event filter lives in the script.
  - `1` means the tree can empty and `2` means the guard could not tell. Those stay
    separate, and an unreadable tree is `2` rather than a pass.
  - The base is READ, not assumed: a base with no floor means this diff is the one
    installing it, so the guard does not red the only PR that can make its own claim
    true. That exemption covers the top-level deletion check ONLY — the per-directory
    rule still applies, or the exact state the repo was in on 2026-09-12 would pass.

**WHAT THE TESTS PROVE, AND THEIR CONTROLS.**

  - `trident/as-built-staging-floor-realgit.test.ts` runs the four arms above with the
    REAL promoter and real merges. Two arms are positive controls that the instrument can
    see the conflict at all; the top-level-only arm is the one that killed the weaker fix,
    and it stays in the suite so nobody reduces the rule back to it.
  - `scripts/ci/as-built-staging-floor-guard.test.ts` drives the guard through real git
    fixtures: floor deleted, floor renamed out of its directory, a record in an unfloored
    directory, a `.md` file offered as a floor, the bootstrap, the bootstrap NOT being a
    general amnesty, both event payloads, and the refusals. Its last test pins the rule
    against THIS repo's tracked tree, which is the only check that can catch main
    arriving in the bad state by a route the guard never sees (a manual promotion, a
    force-push, a revert).
  - `scripts/ci/ci-workflow.test.ts` pins the wiring with a mutation battery, because a
    guard that is declared and never called is a rule nobody wrote — this repo shipped
    exactly that for five days with the migration ordinal guard.

**A BUG THIS CHANGE CAUSED IN AN EXISTING TEST, CAUGHT BY THAT TEST'S OWN BATTERY.** The
ordinal guard's wiring check scoped its "the exit code propagates" search from its
function declaration to END OF FILE. Sound while it was the last guard in the gate;
hosting a THIRD guard below it meant the new guard's identical propagation line satisfied
the search over a body whose own line had been deleted, and the `exit code is discarded`
mutation stopped being caught. It went red when the third guard landed, which is what a
mutation battery is for. Both windows are now bounded at their own top-level call.

**THE THREE TEST SITES THE GATE FLAGGED, decided per site rather than in bulk.**
`trident/as-built-appender-realgit.test.ts` asserted emptiness through a helper that
listed EVERY file under the staging directory; its fixture now carries the floor (so the
promoter is exercised against the tree it will meet) and the helper filters to `*.md`, so
the claim is "no records remain" rather than "nothing remains". The two sites in
`trident/as-built-fold-wiring-realgit.test.ts` are orchestrator-wiring fixtures that seed
no floor and no `docs/as-built/` layout: their emptiness assertion is true of the fixture
and measures the thing they are about — the run's staged file is gone from the base — so
they keep it, with a comment saying it is fixture-local and not the repo's shape.

**THE DETAIL WORTH KEEPING.** The first commit on this branch failed to create the
placeholder at all — "No such file or directory", because `.trident/as-built/` does not
exist in a fresh worktree once the last record has been promoted out of it. The defect
demonstrated itself during its own repair.
