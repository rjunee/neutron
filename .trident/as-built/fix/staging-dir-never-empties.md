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

**AN EXEMPTION MUST BE SCOPED TO THE SIDE THAT IS ALLOWED TO BE WRONG.** The guard needs a
bootstrap: the diff that installs the floor is judged against a base that does not have it
yet, and a blind refusal would red the only PR that can ever make the guard's own claim
true. That exemption first shipped as "fail when the base HAS a floor and the head does
not" — which reads as the rule and is not it. With NEITHER side floored the condition is
false, and a tree whose every record-holding subdirectory happened to carry its own floor
then walked the per-directory loop clean as well, so the guard exited 0 over a tree that
never installs the top-level floor at all. It exempted precisely the state it exists to
refuse, on its first run, when nothing else was watching. Caught in cross-model review,
reproduced with real git, and fixed by asking the question of the HEAD unconditionally and
letting only the BASE be absent. The general shape is worth keeping: an exemption written
to let a guard install itself must name the side that is allowed to be wrong, because
"either side" always includes the one that must not be.

**THE SECOND SCOPE ERROR WAS THE MIRROR OF THE FIRST, AND IT IS THE MORE USEFUL PAIR.** The
verdict loop walked only directories holding a record at the head, so deleting
`.trident/as-built/feat/.gitkeep` while `feat/` held no `.md` exited 0 — under a rule
`docs/as-built/README.md` states unconditionally and this record claimed the guard enforced.
That is not a harmless cleanup of an empty directory: THE RENAME SOURCE IS THE MERGE BASE,
NOT THE TIP. Measured — `feat/` holds a record, a promotion moves it to `docs/as-built/`
with the floor keeping the directory alive, the floor is then deleted from the now
record-less directory, and a concurrent branch staging `feat/b.md` merges to
`CONFLICT (file location) ... suggesting it should perhaps be moved to docs/as-built/b.md`
in full. A directory that looks empty today is still a rename source for every branch cut
before it was drained. So the guard refuses the removal rather than the documentation being
narrowed, and it cannot ever know when retiring a prefix is safe — it would have to know
that no unmerged branch anywhere stages there.

What the two findings share is the thing to check: the bootstrap exemption let a state
through by making the PREDICATE false; this one let a state through by never enumerating
the directory at all. A guard's coverage is the product of its predicate AND its domain,
and a suite that only drives the predicate will report a guard sound over the states it
cannot see. The guard's tests now sweep the domain explicitly — a floor deleted from a
record-less directory, a prefix present only on the base side, a prefix present only on the
head side floored and unfloored, a floor renamed within its own directory, and an untouched
tree as the positive control that the harness can produce a pass at all.

**THE THIRD SCOPE ERROR WAS THE EVENT, AND THE THREE TOGETHER ARE THE POINT.** The guard
skipped every non-branch event, so a push to main deleting `.trident/as-built/docs/.gitkeep`
— a record-less prefix floor — passed it untouched. The predicate was right by then and the
domain was right, and neither ran. Worse, the compensating control this record and the
guard's header both named for exactly that event did not compensate: the main-tree pin
required the top-level floor plus a floor in each directory CURRENTLY holding a `.md`, and a
record-less directory satisfies both clauses by being absent. `ci.yml` triggers on
`push: branches: [main]` and `layering` runs there with `fetch-depth: 0`, so the event was
reachable the whole time; the push payload's `before`/`after` are exactly the base and head
the guard already judges, which also covers a force push for free, since `before` is the tip
being overwritten.

So: **coverage is the product of predicate, domain, trigger — and the identity of the rule
you document with the rule you check.** Four rounds of review each found one factor wrong
while the others were right, and each round's tests measured only the factor it had just
fixed. Named explicitly so a fifth has somewhere to be noticed, with what pins each:

  - PREDICATE — is the question right for a directory it looks at. Pinned by the
    floor-deleted, floor-renamed, unfloored-record, `.md`-as-floor and bootstrap cases in
    `scripts/ci/as-built-staging-floor-guard.test.ts`, and by the two-sided-exemption
    mutation in `scripts/ci/ci-workflow.test.ts`.
  - DOMAIN — which directories it looks at at all. Pinned by the `describe` block sweeping
    every shape a staged-prefix directory can take across the two trees (record-less floor
    deleted, prefix only on the base side, prefix only on the head side floored and
    unfloored, floor renamed within its directory, untouched tree as the positive control),
    and by the `BASE_FLOOR_DIRS` mutations.
  - TRIGGER — which events it runs on at all. Pinned by the push cases (a record-less floor
    deleted on a push, a clean push, a force push, a ref deletion, a branch creation), by the
    `push)`-arm and `event_sha before` mutations, and by a test that `ci.yml` still fires on
    `push: branches: [main]` — the arm is inert if that trigger ever goes away.
  - PROMISE VERSUS CHECK — whether the rule the documentation states is the rule the code
    enforces. The guard accepted ANY non-`.md` blob as a floor while
    `docs/as-built/README.md` said the floor is `.gitkeep` and that permanent floors are
    asserted BY NAME, so replacing `.trident/as-built/fix/.gitkeep` with `junk.txt` passed
    the guard AND passed the pin — whose own comment said "by name" while it compared parent
    directories. Pinned now by the replacement and rename-within cases, by the pin asserting
    the exact paths as well as the directories, and by the `FLOOR_NAME` mutations.

    THIS IS THE FACTOR A TEST OF THE GUARD CAN NEVER FIND ON ITS OWN, and it is why it is
    worth naming separately from the other three. Every test of a guard is written from the
    same understanding as the guard; one of this suite's own cases asserted that renaming the
    floor within its directory was FINE, stating "the rule is a property of the directory,
    not of the filename" — a coherent claim, agreeing with the code, contradicting the
    README, and therefore invisible to any amount of further testing. Only reading the
    documentation against the code finds it.

**WHY THE NAME IS ENFORCED RATHER THAN THE DOCUMENTATION NARROWED.** The two resolutions were
genuinely different and the property argument favours the looser one: the floor's job is to
stop git inferring a directory rename, and ANY tracked file does that, so `junk.txt` really
does satisfy the mechanism. The name is enforced anyway, because the floor has a second job —
being legible to whoever meets it next. The failure this entire change exists to refuse is
someone tidying away a file whose purpose is not obvious, and a directory held open by
`junk.txt` invites precisely that deletion; `.gitkeep` reads as "kept on purpose" to a person
and to every agent trained on a decade of repositories. A third consideration settled it:
narrowing the documentation would have meant weakening three documents to match the loosest
possible implementation, and documentation is narrowed to match code only when the code's
behaviour is the one you want. Here it was not. A directory may hold other files beside its
floor — the rule is that it must hold THIS one.

The main-tree pin is a real second control now rather than a claim standing in for one: it
asserts the PERMANENT floors by name. That has to be a list, because a record-less directory
leaves no trace in the tree once its floor is gone — nothing in HEAD can say that
`.trident/as-built/docs/` ever existed. Adding a prefix means adding its floor to that list
too, and the guard will already have refused the PR that stages there without one.

**WHAT THE TESTS PROVE, AND THEIR CONTROLS.**

  - `trident/as-built-staging-floor-realgit.test.ts` runs the four arms above with the
    REAL promoter and real merges. Two arms are positive controls that the instrument can
    see the conflict at all; the top-level-only arm is the one that killed the weaker fix,
    and it stays in the suite so nobody reduces the rule back to it.
  - `scripts/ci/as-built-staging-floor-guard.test.ts` drives the guard through real git
    fixtures: floor deleted, floor renamed out of its directory, a record in an unfloored
    directory, a `.md` file offered as a floor, the bootstrap, the bootstrap NOT being a
    general amnesty, NEITHER side floored at the top while every record directory is
    floored, both event payloads, and the refusals. Its last test pins the rule
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
