## 2026-09-12 — preparing a branch-ref reap: fourteen gates and a measurement, with the deletion held behind a boundary until its guard lands

Measured on the repo of record, 2026-09-12 **before 02:38Z**: **79 `refs/heads/trident/*` refs**, 78 of
them held by no worktree at all, and every one of them a ref whose run had already ended. A surviving
ref is not inert — the next launch of the same card RE-ENTERS it (`trident/inner-workflow.mjs:1346`: "If
the branch already exists from a previous run of this card, RE-ENTER it rather than failing"), so the
card's next build starts on the stale base its last attempt failed from.

TWO POPULATIONS APPEAR IN THIS RECORD, 79 AND 80, AND THE DIFFERENCE IS THIS LANE'S OWN BRANCH.
Re-derived rather than reconciled, because a durable record is the one artefact where a plausible number
is worse than an admitted gap. Every trident ref's creation time is recoverable from its per-branch
reflog (`.git/logs/refs/heads/trident/*`, first entry): exactly one was created after 2026-09-02, namely
`trident/ref-reap-547` at **2026-09-12T02:38:22Z** — the branch this change is being built on. So the
publication measurement below ran against 79 refs before that moment, and the dry-sweep inventory ran
against 80 after it. The count is still 80 as of 2026-09-12T10:14Z.

THE EIGHTIETH REF CANNOT AFFECT THE CANDIDATE FIGURE, and that is checkable rather than reassuring: it
is checked out by name in this lane's own linked worktree, so gate 4 keeps it, which is why the
inventory's "held by a worktree" count is 2 where the 79-population line above says 1 (78 of 79 held by
none). The other held ref is `trident/throughput-blocker-trident-s-own-pl`, held by COMMIT rather than
by name — a detached worktree standing on its tip, which is gate 5's witness. The arithmetic closes
from either end: 80 = 2 held + 6 unowned + 72 candidates, and 79 = 1 held + 6 unowned + 72 candidates.
**The 72 is a count over the 78 refs that predate this lane, and it is the same 72 in both populations.**

THE MEASUREMENT INSTRUMENT ADDED ITSELF TO THE POPULATION, which is the transferable part: a sweep of
`trident/*` run from a `trident/*` branch counts its own branch, and the two numbers a reader will
compare were taken on either side of that event. Neither figure was wrong; the record simply failed to
say they had different denominators.

WHICH PUBLICATION MEASUREMENT, because an unqualified number in a durable record invites exactly one
re-derivation that disagrees — and one was made. By LIVE `git ls-remote` against origin the 79 split
3 at the exact sha / 9 already contained in `origin/main` / **67 local-only**. Recomputed against
LOCAL TRACKING REFS (`refs/remotes/origin/*`) the same 79 split 30 / 6 / **44**. Both are right about
different questions. `ls-remote` asks the remote what it has NOW and is the conservative reading — a
stale or absent tracking ref makes a branch look local-only, never the reverse — so it is the figure
the design rests on. Tracking refs answer what this clone last fetched, which is the larger
"already published" number and the one to prefer when the remote cannot be reached. The conclusion is
the same either way: tens of these refs hold commits that exist nowhere else, so the delete must be
salvaged first.

Why teardown never happened. `worktree-cleanup.sh` does tear the ref down, and its gating is sound
(`delete-branch` mode, only once origin holds the exact sha) — but it is invoked from the inner
workflow's `finally{}` (`trident/inner-loop.ts:417-426` threads its path in), so it runs only while
the workflow's own process is alive. A run reaped by the hang watchdog, cancelled from the board or
`/code stop`, or lost to a gateway restart never reaches it. And the worktree reaper, the one thing
that already fires on every path, was built to never delete a branch: the ref WAS the rescue copy
of a failed run's commits (`.trident/plans/trident/nothing-ever-reaps-a-trident-worktr.md`).

### The third route, and why the deferral was not what made it safe

`refClaimedNow` checked only command FAILURE, then parsed the output and proceeded — so a probe that
returned `{ok: true, stdout: '', exit_code: 0}` while a claimant worktree existed read as "no
claimants" and permitted the delete. The module already got this right 280 lines up, where the
worktree pass treats an empty initial listing as unprovable *because git must report the main
worktree*: one site knew that and the other did not. It also falsified this record's own claim that
unreadable holder measurements refuse.

TWO THINGS ABOUT IT ARE WORTH KEEPING. First, the guard belongs on the PARSE RESULT and not on the
string: measured against `parseHoldersZ`, an empty string, bare NULs, records carrying no `worktree`
field, and arbitrary non-porcelain text ALL parse to zero records, so a `stdout === ''` check would
have caught one shape of four — the malformed payload is the same defect wearing a different coat.
Second, and more important: **the deferral is what made this survivable, not the probe's
correctness.** #606 deletes nothing, so the bug could not fire; but #635 is designed to re-enable
deletion with one call, and it would have re-enabled this too. A guard that is only safe because the
thing it guards is switched off is not a guard yet — which is why #635's acceptance now requires the
probe to refuse on an unreadable listing, proven BEFORE deletion is re-enabled.

### WHAT THIS SHIPS, AND WHAT IT DELIBERATELY DOES NOT

**THIS IS A PREPARATORY CHANGE, AND #547 STAYS OPEN.** What ships makes the deletion possible and
safe to enable ONCE #635 LANDS; it does not enable it, and it does not by itself make the deletion
safe (see "which gates are current" below — the gates prove they RAN, and #635 is what eliminates the
outcome they cannot). Stale `trident/*` refs still survive their runs after
this merges, and the next launch of those cards still re-enters them — the failure #547 describes is
unchanged until #635 lands and the deletion is turned on. The issue closes with the PR that turns it
on, and this record is a record of the half that can be built safely first, not of a fix.

THAT DISTINCTION WAS ALMOST LOST, AND LOSING IT IS THE INTERESTING PART. The deferral was decided
deliberately and for a good reason (below), and then the PR kept its original title — "reap a run's
branch ref on every terminal path" — and its `Closes #547`. Both were true of the change as first
conceived and neither was true of what shipped. A deferral that is agreed in review and not carried
into the claim produces something worse than an un-deferred change: an issue marked solved by a PR
that does not solve it, and nobody looking again.

**IT PERFORMS NO DELETIONS.** Every gate, the salvage, the atomic compare-and-swap, the claim probe,
the repair, the measurement and the reporting all land. The `update-ref -d` itself does not run: the
destructive half is an exported `deleteReapableRef` the sweep does not call, behind one named reason
(`DEFERRED_PENDING_CLAIMANT_GUARD`) pointing at **#635** — and it accepts only a `ReapableCandidate`
the gate chain minted, so being exported does not make it reachable around the gates (see below). The
sweep records CANDIDATES — refs that pass gates 1-10 — in `refs_candidates`; measured on the repo of
record AFTER this lane's own branch existed, **72 of 80 refs** pass those gates, with 2 held by a
worktree (one by name — this lane's — and one by a detached HEAD on its tip) and 6 kept for unprovable
ownership. The 80 and the 79 at the top of this record are the same population one ref apart; see there
for the derivation and why the 72 is unchanged by it.

THAT NUMBER IS AN UPPER BOUND, NOT A MEASUREMENT OF WHAT WOULD BE DELETED, and an earlier version of
this record said otherwise — it claimed the dry run "runs all fourteen checks". It runs ten. The field
was then called **`refs_reapable`**, which promised the stronger thing, and the 72 was quoted onward as
the answer to "what exactly would this delete". It is the answer to "what could this delete at most".
(CORRECTED, round 14: this sentence named `refs_candidates` as the offending field — the NEW name, the
fix — so the passage explaining why the rename was necessary indicted the name it had arrived at. A
reader following the explanation would conclude the current field is the overclaiming one.)

The gap is not laziness and cannot be closed by trying harder. GATE 11 IS THE SALVAGE WRITE, so a dry
run that evaluated it would not be dry — and a candidate whose salvage the host rejects is correctly
listed and correctly never deleted, which is a distinction the report now carries rather than hides.
GATES 12-14 are not skipped for convenience either: gate 12 re-reads the very sources gates 4, 5, 7
and 8 have just read, and gate 13's precondition is the sha `for-each-ref` returned moments earlier.
Their entire value is re-measuring AFTER time has passed and AFTER writes; in a dry sweep nothing has
mutated in between, so running them would re-derive the same answer from the same inputs and add the
APPEARANCE of rigour rather than any of it. Gate 14 requires the delete to have happened.

So the field is named `refs_candidates`, the number is presented as an upper bound with the reason,
and #635's comment was corrected in place. The sequencing argument is unaffected — 72 is still not a
small first exposure — but "an upper bound presented as a measurement" is exactly the class this
change spent nine rounds eliminating, and it appeared in the one artefact other people act on.

**THE DEFERRAL WAS FIRST DECIDED THE OTHER WAY, AND THE REASON IT WAS WRONG IS THE BASELINE.** The
coordinating judgement was to narrow the record's claim and file the claimant-side guard as follow-up;
the review gate overturned it and the overturn was right. The error was measuring this change against a
world in which these refs were already being deleted — which was never true. Nothing deletes them
today. So #606 does not *improve* a destructive operation, it *introduces* one, and with it a failure
mode that does not currently exist: a run committing onto no history at all, its PR a whole-tree diff
against unrelated history. "The commits are never lost" is true, was verified, and is not the same
claim as "nothing bad happens". Narrowing the record made it honest; it did not make the change safe.

THE GENERAL FORM, which is the part worth carrying: **a change that introduces automation is measured
against a world in which that automation does not exist.** Comparing it to the improved version of
itself flatters it, and "the bad outcome is rare and recoverable" is an argument for shipping the guard
first, not for shipping without it.

WHY THE GUARD IS NOT BUILDABLE IN THIS LANE, measured rather than assumed:
`trident/inner-workflow.mjs` contains **zero** `git commit` calls. A build's commit is the LLM agent
running `git commit` in Bash inside its worktree, driven by prompt text (11 sites). The four TS files
that do call `git commit` are none of them the build's commit — workspace init, the leak preflight's
scratch commit, the as-built appender's, and the outer publisher's rebase replay. So there is no
function to guard: the options were a per-worktree `pre-commit` hook (a new mechanism with new failure
modes), editing a file outside this lane, or prompt text, which is not an enforceable guard.

WHY AN EXTRACTION RATHER THAN A SHORT-CIRCUIT, since the simpler change was available. Short-circuiting
inside the sweep would have left the destructive half unreached **in tests as well as in production**,
so #635 would re-enable roughly twenty tests' worth of code whose coverage had lapsed — arriving back
in production carrying a green history that no longer meant anything. The extraction keeps all of those
tests running against the very function #635 re-enables, and the 87-test suite is itself the safety net
for the refactor. Three things fell out of it that the short-circuit would not have given:

  * THE DRY-RUN CANDIDATE INVENTORY IS WORTH HAVING ON ITS OWN. A sweep that runs gates 1-10 and
    reports which refs are CANDIDATES is strictly more than exists today, where nothing reaps and
    nothing reports. It is the evidence attached to #635 rather than an argument about it — an upper
    bound, stated as one.
  * ZERO WRITES IS AN IMPROVEMENT, not merely a smaller change. Not creating ~72 salvage refs for
    deletions that are not happening avoids seeding a namespace this record already flags as having no
    pruner.
  * #635'S DIFF BECOMES ONE DELETION AND ONE CALL, about as reviewable as an enabling change gets.

### The generalisation, which outlived the specific fixes

**`false`, `threw`, AND `succeeded-with-impossible-output` ARE ALL "UNKNOWN", AND ON A DESTRUCTIVE
PATH NONE OF THEM MAY SHARE A BRANCH WITH "NO".** This is stated first because it is the transferable
part; everything below it is one module's instances of it.

There are exactly three routes by which a host call can fail to answer, and this module shipped a bug
down each one in turn — each found only after the previous had been audited and closed:

| route | how it presents | why the previous audit missed it |
|---|---|---|
| a non-`ok` result | `ok: false` | — (the first audit; 11 `.ok` decisions classified) |
| a **throw** | an exception, after the command may already have taken effect | a `catch` is not an `.ok` decision |
| a **success whose output is impossible** | `ok: true`, no exception, no error string | nothing failed; the signal is purely semantic |

The third is the least visible and the most dangerous to reason about, because the knowledge that
makes it detectable — *`git worktree list` always reports the main working tree, so zero records is
impossible* — is per-command and cannot be derived from any type. It has to be written down. The
module header now carries all three classifications side by side: every `.ok` decision, every `catch`
by whether its command mutates, and every parsed payload by what output is impossible for that
command.

Three review rounds produced three versions of a single mistake, each time a boolean `ok` deciding a
question git answers with an exit code:

| round | the decision | what `ok` collapsed | what it needed |
|---|---|---|---|
| 4 | did the create-only salvage refuse because the ref exists? | "already exists" with every other failure | exit **128** AND the message |
| 6 | did the delete happen? | "refused" with "timed out, so I cannot tell" | success / timeout / other |
| 7 | is the ref there now? | "absent" with "`fatal: permission denied`" | exit **0** / **1** / anything else |
| 7b | did the delete happen, when the call THREW? | "threw" with "refused" | a throw after the command had its chance is *unknown* |

Round 7's is the one that shows the cost plainly: a hard git error read as *absent*, so the sweep
recorded a **deletion it had no evidence for**. Each of the three fixes was correct and each left the
same latent shape next door, because the type carried one bit where the domain has three states. A
`HostCommandResult` exposes `exit_code`; `ok` is a convenience over it, and a convenience is the wrong
thing to branch a destructive decision on.

INSTANCE FOUR ARRIVED BY A ROUTE THE `.ok` AUDIT DID NOT COVER, which is the most useful thing about
it. A `catch` is not an `.ok` decision — but "the command threw AFTER having its chance to take
effect" IS a failure class, and it is the one that looks least like one. The delete's catch recorded
`delete-refused` and moved on, so a throw landing after the ref lock committed left the ref deleted
with the repair never reached. The extracted test therefore has to be read with that included: does
every failure class — the throw-after-doing-it included — take the same branch, and is that branch the
refusing one?

The follow-up audit classifies every `catch` around a host call by whether the command MUTATES: six are
read-only, where a throw genuinely means no measurement and refusing is right; five mutate. Exactly ONE
of those five was wrong, and the classification is what found it rather than inspection. Of the
remaining four, the restore's catch does infer on throw — a throw after a successful restore produces a
false "RESTORE FAILED" alarm — and it is left that way deliberately: over-reporting on a repair path is
the correct place to be wrong, and the sentence naming it is the difference between a residue that is
known and one that is not.

THE TEST FOR WHETHER TWO VALUES SUFFICE, which is the part to carry to the next module: **does every
failure class take the SAME branch, and is that branch the refusing one?** If yes, collapsing costs
nothing and `ok` is right. If the branches differ — or if one of them is the destructive one — the
decision must be keyed on the value the tool actually returned. Applied to this module, 8 of the 11
`.ok` decisions are legitimately two-valued (every failure refuses identically) and 3 are necessarily
three-valued; the full classification is in the module header so it can be checked against the code
rather than taken on trust. It is the same discipline `#628` applied to its cap — absent → default,
valid → honour, invalid → refuse, as three classes keyed on the value and not on truthiness.

### What shipped

**The reap is state-driven, not hooked onto each terminal path.** `sweepTridentWorktrees`
(`trident/worktree-reaper.ts`) gained a second pass over `refs/heads/trident/*`, keyed on what the
store says: every run row that owns the ref is in a terminal phase. That covers every terminal path
by construction, including the ones that run no code at all — a gateway killed mid-run leaves a row
whose next reap is the next boot (`immediate: true`). The tick loop's terminal chain already wakes
this loop, so an in-band terminal transition reaps within a tick; an out-of-band cancel reaps on the
15-minute cadence.

`TridentRunStore.listBranchOwners(repo_path)` is the new read: branch, phase, worktree,
`workflow_run_id` for every row in one repo that names a branch. Deliberately unbounded — a `LIMIT`
could drop the one old row that turns "a non-terminal run still owns this" into "every owner is
terminal", which is the answer that authorises the delete.

**FOURTEEN CHECKS, and unprovable refuses at every one.** (The count is the length of the list
below, stated once; the module header carries the same fourteen in the same order.) They sit behind a
GATE 0 that is not one of them: the destructive half accepts only a `ReapableCandidate`, so gates 1-10
are not advice to a caller but the thing its argument attests to. The 2026-09-01 incident
(`docs/as-built/wrong-base-guard-prints-a-destructi.md`) is a guard that composed an unconditional
`git branch -D` from nothing and aimed it at a branch a live locked worktree was holding. So:

1. `/proc` readable at all, or the WHOLE sweep does nothing — worktrees and refs alike.
2. The ref is under `refs/heads/trident/`, the namespace trident itself creates
   (`board-dispatch.ts:877`). A member-mode run builds on a pinned branch outside it.
3. `for-each-ref` AND `worktree list --porcelain -z` both answered. Either failing is the absence
   of a holder measurement, so no ref in that repo is touched. The `-z` form because a worktree
   path may legally contain a newline and splits its own record in the other one.
4. No worktree holds the ref — including the ones git calls DETACHED, because a tree mid-rebase or
   mid-bisect prints no `branch` attribute while genuinely holding one. `readRebaseHead` answering
   'unknown' freezes every ref in the repo: what could not be read may name any of them.
6. No worktree THIS SWEEP detached still exists — a same-sweep fast path, kept only for the
   refusal wording. The worktree pass detaches a process-free `trident/*` holder BEFORE it decides
   whether the tree may be removed, so a tree preserved immediately afterwards (dirty, or inside
   retention) has had its ref freed while its only-copy work sits on top of it.
5. No DETACHED LINKED worktree still on disk is standing on the ref's COMMIT. This is the gate that
   actually holds that line, and 4b is not — see "GATE 4b HELD FOR EXACTLY ONE SWEEP" below. Keyed
   on the commit rather than a name, because the worktree pass's own `checkout --detach` leaves HEAD
   on the tip, so the tree still points at the ref however many sweeps later. It does not cover a
   conflicted rebase (there HEAD is the `onto` commit) and does not need to, because gate 4 reads
   the rebase's own `head-name`. The SHARED checkout is excluded: it is never a disposable build
   tree, so it is never the tree this protects, and including it refuses on coincidence — measured
   while writing it, two cases refused a ref whose worktree had genuinely been removed.
7. At least one run row names the branch. NO row is the absence of an owner, not evidence of
   disposability — it is what protects a hand-made branch, and it keeps 6 of the 79.
8. EVERY row naming it is terminal.
9. No owning run's recorded worktree still exists on disk — **which cannot fire today, and this
   record credited it as evidence when it should not have.** Measured read-only against the
   production store on 2026-09-12: 0 of 291 run rows carry a non-null `worktree`, because the
   orchestrator writes `worktree: null`. Kept because it is correct and costs nothing the day that
   column is populated, not because it is load-bearing now.
10. No live process stands in an owning run's worktree, and none stands in a path bearing its
   `workflow_run_id` — **re-measured at delete time since round 15**, see below. The race is real — the row goes terminal while the detached workflow is still
   running — but **this gate cannot fire today either.** The worktree half is dead for the same
   reason as gate 7; the generation half compares a 36-character run UUID against
   `wf_<8hex>-<3hex>-<n>` basenames, measured 0 of 17 matches, because they are different
   identifiers. What actually protects a LIVE workflow is not this gate: its tree is `isLive`, so
   the worktree pass never detaches it, so it still holds its branch by name and gate 4 keeps the
   ref. The same mis-keying makes `claimedByNonTerminalRun` weaker than it reads.
11. A salvage ref was CREATED first, create-only. 67 of the 79 carry commits origin does not have
   by live `ls-remote` (44 by local tracking refs — see the measurement note above),
   so the delete would otherwise drop the last reference to them. `refs/trident-reaped/<slug>/<sha>`
   keeps them reachable — outside `refs/heads` so it can never re-enter a launch, outside
   `refs/tags` so it neither clutters `git tag` nor rides a `--follow-tags` push. Recovery is
   `git branch <name> <sha>`. Salvage failing refuses the delete.
12. Nothing CLAIMS the ref as of now — holders and live owners re-measured, not remembered,
   immediately before the delete.
13. THE DELETE IS ONE ATOMIC COMPARE-AND-SWAP — `git update-ref --no-deref -d <ref>
   <expected-sha>`, which
    checks the old value and unlinks the ref under one ref lock. A branch that advanced since the
    enumeration cannot be deleted at all, because there is no read-then-delete window: there is no
    separate read. See below for what this replaces.

   `--no-deref` IS PART OF THE PRIMITIVE, not a nicety. Without it `update-ref -d` FOLLOWS a
   symref and deletes what it points at, leaving the symref standing — measured on git 2.43:
   with `refs/heads/trident/evil` a symref to `refs/heads/main`, every gate passes on the
   symref's own name (gate 14 included, since the holder's `branch` never matches it) and the
   delete removed `refs/heads/main`. There are no symrefs under `refs/heads/` on the repo of
   record and nothing in trident makes one; the flag is here because "unreachable in this
   tree" was the wrong answer twice in this change already, and the blast radius of being
   wrong a third time is the default branch. The CAS is unaffected: the old-value compare
   still resolves through the symref, so a stale sha still refuses.

14. And nothing claimed it DURING the delete: the same measurement again afterwards, with a
   create-only restore at the unchanged sha if one did. See "THE CAS PROTECTS THE REF'S VALUE"
   below for why both, and what each of the three possible restore outcomes means.

**THE CAS PROTECTS THE REF'S VALUE, NOT ITS HOLDER — so the holder and owner checks were still
racy, and this is the inverse of the bug the card exists to fix.** The holder listing and the owner
rows are snapshotted before the per-ref loop; the delete happens later. A new run can claim the slug
and `git worktree add` the branch at its UNCHANGED tip in between — so the sha is exactly what was
expected, the compare-and-swap succeeds, and a branch a live run is standing on is deleted.
`update-ref -d` does not refuse a checked-out branch, a fact this suite measures on purpose, so
nothing fails closed by itself. The zero-retention argument invokes the very scenario: "a NEXT launch
that can be seconds away" is the thing that claims the slug inside the sweep.

WHY NOT THE EXISTING CLAIM CHOKEPOINT, which was the first direction to evaluate. `createIfClaimsAvailable`
(`trident/store.ts`) does arbitrate exactly this question, in one transaction, backed by the live-only
unique index (`migrations/0120_trident_slug_unique_only_live.sql`). The reaper cannot join it:

  * Its refusals are typed `conflict: 'path' | 'branch'` and each carries a `holding_run`. A reap
    lease has no run to name, so admitting one needs a NEW conflict kind — and the consumer of those
    kinds is `board-dispatch.ts`, which this lane may not edit. Naming a terminal row as the
    `holding_run` would be a lie about liveness in the one place that exists to tell the truth.
  * The alternative, holding a SQLite write transaction across the git delete so the dispatch's own
    transaction blocks on it, would serialise correctly and stall every other writer — the tick loop
    included — for the duration of up to `MAX_REF_DELETIONS_PER_SWEEP` subprocess calls.

A RETENTION FLOOR DOES NOT CLOSE IT EITHER, and it is worth saying why rather than just declining
it: the race is not about age. A dispatch can claim a slug whose owners went terminal weeks ago, so
any floor still leaves the same interleaving on the other side of it.

SO A DETECTED CLAIM IS REPAIRED RATHER THAN RACED:

  * GATE 12 re-measures holders, live owners AND PROCESS LIVENESS from scratch immediately before the
    delete. This is the ordinary case, and it means the destructive act is never performed at all when
    a claim has already landed.
  * GATE 14 takes the SAME measurement again afterwards, and a claim that appeared puts the ref back
    at exactly the sha it had, with a bounded create-only retry. Git offers no primitive that compares
    a HOLDER and unlinks a ref in one operation — `update-ref --stdin` refuses `verify` + `delete` on
    one ref — so a detected claim is repaired instead of raced.

WHAT THAT DOES **NOT** GUARANTEE, said plainly, because an earlier draft of this section claimed the
outcome was correct for EVERY interleaving and that claim was false. `refClaimedNow` takes a git
snapshot and a store snapshot, both AFTER the delete. A concurrent `git worktree add` that has already
resolved the branch but appears in NEITHER snapshot yet reads as "no claimant" — so the ref stays
deleted and that claimant finishes with a dangling symbolic HEAD, which nothing in this module
repairs. What IS guaranteed, and what is not:

  * THE COMMITS ARE NEVER LOST. The salvage ref holds the tip before any delete is attempted, so
    `git rev-list --all` still reaches it and the printed `git branch <name> <sha>` works. This is the
    property the whole design rests on, and it is the ONE property that holds for every interleaving —
    which is not the same as the outcome being correct for every interleaving, and the distinction is
    the reason the deletion waits for #635.
  * A DETECTED CLAIMANT IS RESTORED, at the identical sha, create-only, retried a bounded number of
    times.
  * AN UNDETECTED CLAIMANT — one that resolved the branch between the probe's two snapshots — IS LEFT
    WITH A DANGLING HEAD. Measured: `git symbolic-ref HEAD` still names the deleted branch,
    `git rev-parse --verify HEAD` fails with "Needed a single revision", `git status` says "No commits
    yet", the index is intact, and the next commit is PARENTLESS — so its PR reads as a whole-tree
    diff against unrelated history.

That window is not closed here and deliberately so. Two separate git invocations cannot atomically
observe "nobody holds this ref" and delete it, so every additional probe narrows the window while
making the code assert a guarantee it still does not have. The fix that ELIMINATES the outcome rather
than reducing its probability is on the CLAIMANT's side — a run whose HEAD symref does not resolve
must refuse to commit — because that side can observe the condition definitively with one
`rev-parse --verify HEAD`, with no race and no snapshot, and it covers interleavings nobody has
enumerated. Filed as **#635** against the cutover milestone rather than built here, with acceptance in
`docs/spec-items/a-run-whose-head-does-not-resolve-must-refuse-to-commit.md` — bidirectional, because
a guard that refuses every commit satisfies "refuses an unresolvable HEAD" on its own.

The repair is lossless, which is what makes it an answer and not a hedge: the sha is unchanged by
construction (the CAS proved it, and the salvage ref already holds it), so the claimant's worktree
HEAD symref resolves to the same commit it did before, and no commit, working tree or index is
touched. The restore is CREATE-ONLY, and its result is read as THREE outcomes rather than two —
which is the round-4 correction, and it was this file's own doctrine broken in its newest code. The
first cut read ANY failure of the restore as "the claimant recreated the branch, so ours losing is
correct" and counted a restore unconditionally, so a lock failure, a permission error or a transient
host fault left the ref ABSENT — the claimant's symbolic HEAD dangling, the one outcome gate 9b
exists to prevent — while the summary said it had been put back. Now: SUCCESS is counted as a
restore; an EEXIST refusal (`reference already exists` AND exit 128, both required, matched on git's
own words) means the claimant owns its own ref and nothing was put back or needed to be; and EVERY
OTHER failure is `refs_restore_failed` — not counted as a restore, logged at error, breaking the
summary's silence, and carrying the one-line `git branch <name> <sha>` recovery, which works because
the salvage ref still holds the tip. A command that failed establishes that it did not succeed and
nothing else.

THE RESIDUE, STATED AT ITS WORST RATHER THAN AT ITS BEST. On the SUCCESS and EEXIST paths it is a
sub-second window in which the ref does not resolve, which can fail a `git switch` in the claiming
run's first step — retryable, in a run that has just started. On the `refs_restore_failed` path it is
neither sub-second nor retryable, and an earlier draft of this paragraph said it was: a claimant whose
HEAD symref points at a deleted branch reports "No commits yet", and its next commit is PARENTLESS.
Its PR then reads as a whole-tree diff against unrelated history — the silently-wrong-base class this
card exists to eliminate. No commit is lost and the printed recovery works, but nothing automated
repairs it, because a ref that does not exist does not enumerate on the next sweep. That is why the
restore is RETRIED, `MAX_RESTORE_ATTEMPTS` times, create-only on every attempt — a fixed count rather
than a deadline because it sits inside a sweep that must stay finite, and create-only on every attempt
because a retry that degraded to a force-create would clobber a claimant that made its own branch
between attempts, which is worse than not retrying at all. Both halves refuse on an unreadable measurement, git side and store side alike.

Pinned by the reviewer's exact interleaving — `worktree add` at the already-enumerated tip, fired on
the delete command itself — plus a claim landing before the delete, a live run ROW appearing
mid-sweep, a DETACHED worktree appearing on the tip, a claimant that re-made the branch itself, and
all four unreadable-measurement cases.

**GATE 4b HELD FOR EXACTLY ONE SWEEP, NOT "UNTIL THE TREE IS GONE" — and this document said
otherwise.** `detachedThisSweep` is built inside the per-repo loop, so it is memory for ONE sweep.
On the next sweep the tree is already detached, its listing entry has no `branch` attribute, the
detach block never runs, the map is empty, and nothing refuses: the ref of a tree the previous sweep
deliberately preserved was deleted anyway. The shipped test ran a single sweep and could not see it.

It was live. Measured on the repo of record: 16 `wf_*` worktrees had already been detached by
earlier sweeps of shipped main and **all 16 were dirty** (3-67 changed paths), one of them standing
exactly on the tip of a `trident/*` ref whose every other gate passes — so the first sweep after
this landed would have taken it.

GATE 4c is the fix, and it is durable by construction rather than by bookkeeping: it matches the
ref's commit against the HEAD of every linked worktree still on disk, and `checkout --detach` leaves
HEAD on the tip. Regression-tested over TWO sweeps and a third, for the dirty case and the
within-retention case; both red without it, with the ref deleted on sweep 2.

**THE FIRST CUT'S "COMPARE-AND-SWAP" WAS NOT ATOMIC, and the cross-model review caught it.** The
delete was a `rev-parse` read of the sha followed by a SEPARATE `git branch -D`, described as a
compare-and-swap. It was not one. Anything could advance the branch in the window between the two
commands, `git branch -D` has no old-value check at any price, and the commit that had just arrived
went with the branch — while the salvage written a moment earlier preserved only the OLD tip. With
67 of the 79 targets carrying commits that exist nowhere else, that window destroyed work. The
review's repro is now a test: advance the branch in the instant before the delete command runs, and
measure what happens to the arriving commit. Against the old primitive the sweep REPORTS SUCCESS
while the commit is gone; against `update-ref -d <ref> <expected-sha>` git refuses under its own
ref lock (measured on git 2.43: exit 1, "cannot lock ref ... is at X but expected Y", ref intact).

The measurement that put `branch -D` there was real — git 2.43: it refuses a branch a worktree
holds, where `update-ref -d` does not — but it answered the wrong question, conflating two axes.
Holder safety was already established by three gates that do not depend on the delete primitive (the
worktree listing, the rebase/bisect read, this sweep's own detach memory); atomicity can only come
FROM the primitive. So the holder refusal is given up and nothing is lost: the test that used to
lean on git's refusal now blinds the holder listing and shows a gate of OURS catching it one step
later. `git branch -D` is banned from the file outright, as a command and as a flag, because it can
never be compare-and-swapped — and the boundary test above is what makes that ban load-bearing
rather than stylistic.

**The salvage write is create-only for the same reason.** `refs/trident-reaped/<slug>/<sha>` is named
by the value it holds, so two sweeps of one slug write the SAME ref at the same tip and SIBLING refs
at different tips — neither can overwrite the other's. The write is still `update-ref <ref> <new> ''`
(the empty old-value meaning "must not exist"; measured on git 2.43: exit 128, "reference already
exists") so the one case the naming cannot rule out — an existing salvage at some OTHER sha — is
refused rather than clobbered. A refusal falls through to a read that cannot be harmfully stale: it
is reached only because the ref exists, and all it must establish is that what exists is this tip.
The create path needs no read at all.

**EACH REF IS INDEPENDENTLY SAFE**, which is what makes `MAX_REF_DELETIONS_PER_SWEEP = 50` and a
mid-sweep death harmless rather than merely unlikely. One ref's whole work is: create its salvage,
then CAS away its branch. A process dying between the two leaves a salvage and an intact branch, and
the next sweep confirms that salvage and finishes; dying after leaves the intended end state.
Nothing spans two refs, so a crash can leave no partially-applied state. Tested in both directions.

**THE BOOT RESCUE GETS FIRST CRACK, and CI is what found that it wasn't.** The stranded-failure
sweep (`trident/orchestrator.ts:722` `sweepStrandedFailures`, wired at module init) publishes a
stranded failed PR run's commits by PUSHING ITS BRANCH — and the reaper's startup pass
(`immediate: true`) won that race on the one boot where both fire, so the rescue found nothing to
push (`gateway/composition/build-core-modules-trident-stranded-sweep.test.ts` went red on shard
6/8). The reaper now takes a `refs_ready` PREDICATE, lifted by the composition once that sweep has
settled however it went. A predicate rather than an awaited promise because a tick must never block
on a rescue talking to a remote: the WORKTREE half of the sweep runs from tick one either way, and
the ref half records that it is waiting. The no-rescue branch of the composition sets the latch
explicitly, so a latch only ever lifted on the other branch cannot disable half the reaper here.

**The 79 are swept by this change rather than left to age out**, because the same guard answers
them: measured against the live rows, 73 pass gates 5-6 and 6 are refused for unknown ownership.
Gates 7 and 8 contribute nothing to that count, which is consistent with their being inert (above).
Ref retention is deliberately ZERO where a worktree gets 24 h — a worktree can hold work no probe
can read intent out of, whereas gate 10 has already copied a ref's commits elsewhere, and the
failure being fixed is a NEXT launch that can be seconds away. `MAX_REF_DELETIONS_PER_SWEEP = 50`
bounds one sweep, so the backlog drains over two.

**One existing invariant changed, and it is the one #547 ordered reversed.** The source assertion
"the reaper can never force, delete a branch, or kill" kept its force and kill bans and traded the
branch-delete ban for something stricter. Hiding the delete in a sibling module to keep the old
assertion green would have left a test asserting the opposite of what the module does.

CORRECTED (round 4 — this paragraph had drifted): it said "there is EXACTLY ONE `-D` in the file",
which was true for the one round in which `git branch -D` was still the primitive. Since the
atomicity fix there are ZERO occurrences of `'-D'`: the delete is lowercase `git update-ref -d`, and
the source assertions ban `'branch', '-D'` and the bare `'-D'` flag outright while requiring exactly
one `'update-ref', '-d'`. A record that describes the round before last is worse than no record.

### A rename must follow the CONCEPT, not just its mentions

The `refs_reapable` → `refs_candidates` rename was propagated through the code, the module header,
this record, and the corrected #635 comment — every place that *describes* the change. It stopped at
`docs/spec-items/a-run-whose-head-does-not-resolve-must-refuse-to-commit.md`, whose acceptance
criterion still named the old field. That document is not about this rename; it is about a different
piece of work that happens to depend on the name — and it is the document that will be used to judge
whether #635 is done. So the one place the stale name could do real damage was the one place the
sweep for stale names did not look.

**A rename must follow the concept into documents that do not mention the change at all.** The
mentions are easy: they are in the diff, or one grep away in the files you already touched. The
dangerous references are in artefacts written for other purposes, by other work, that took a
dependency on the name in passing — a normative acceptance clause, a runbook, a card. The test is not
"did I update everything I changed" but "what else takes this name as an input, including things I
have no reason to open".

Grepping caught it here, and the grep needed a positive control precisely because a field name appears
in prose without ceremony — there is no syntax to look for, so a search that finds nothing is
indistinguishable from a search that was wrong. The stale clause also carried the stale FRAMING, not
only the stale token: it said the sweep "records what it *would* reap", which is the overclaim the
rename existed to retire. Fixing the identifier without fixing the sentence would have left the
document wrong in the way that mattered.

### AN ATTESTATION PROVES THE GATES RAN; IT DOES NOT PROVE THEY STILL HOLD

**Provenance is not currency.** This is the third layer of the same problem, and the only one that no
amount of care about the token itself can reach. Round 12 asked whether the destructive path could be
reached without minting. Round 13 asked whether the token named every input the operation consumes.
This round asks the question neither of those can: **is what it proved still true?**

`ownerProcessLive` — gate 10 — was evaluated only while minting, against the sweep's one-time `/proc`
snapshot. `refClaimedNow` exists precisely because things mutate between the gates and the delete; it
refreshed the HOLDER listing and the OWNER rows and skipped the PROCESS question. There was no reason
for the asymmetry, and it was not a design decision — it was an omission wearing one.

THE REPRO. Mint a candidate for a terminal owner whose recorded worktree is an ordinary directory with
nothing running in it. Then start a process whose cwd is under that directory, before the delete. The
fresh holder listing shows no linked worktree (an ordinary directory is not a worktree git knows about);
the owner row is still terminal; the candidate is genuinely minted, for the right repository, at the
right sha — and the ref is deleted beneath a now-live process. With the re-measurement removed the
suite prints `event=worktree_reaper_ref_deleted` for exactly that case.

WHY THIS IS NOT THE OPPOSITE OF ROUND 12'S ARGUMENT, which said that re-running gates 12-13 in a DRY
sweep adds the appearance of rigour and no rigour. That reasoning turned on nothing having mutated in
between: the same inputs re-derive the same answer. Here something HAS happened — that is the entire
reason `refClaimedNow` exists — so a second measurement is a different measurement, not a repeat of
the first. The test is not "have I already measured this" but **"can the subject have changed since I
measured it"**.

SO EVERY GATE NOW CARRIES A FRESHNESS CLASSIFICATION, in the module header beside the three-route
`.ok` classification, because the two answer the same kind of question about different axes: that one
says which decisions need three values, this one says which gates are CURRENT and which are merely
HISTORICAL. Five are mutable and re-measured (4, 5, 7, 8, 10); two are mutable and deliberately not,
with the reason written down (9, whose remaining case is an empty unregistered directory holding no
work; 11, which is itself a write); three are immutable for a candidate's life (2, 6 and the sha,
pinned by the CAS); and two are global and now re-asked per ref as well (1 and 3). A gate that is
merely historical is a gate that was true once, and the person enabling deletion is entitled to know
which is which without re-deriving it.

AN UNREADABLE `/proc` AT DELETE TIME REFUSES, which is gate 1's posture applied at the second
measurement rather than only at the first. The sweep aborts wholesale when `/proc` cannot be read; if
it stops being readable afterwards, "is anything running in there" has no answer, and an unanswered
question has never been an absence in this module.

WHAT THE ALTERNATIVE WOULD HAVE BOUGHT, and why it was not taken: making candidates single-use and
inseparable from a liveness snapshot. A snapshot bound to the candidate is still a snapshot — it
narrows the window between measurement and delete rather than closing it, and it would have encoded
the wrong model, that a candidate is a promise about the world rather than a record of a check.

### EVERY CELL OF A CLASSIFICATION IS A CLAIM NEEDING ITS OWN EVIDENCE

The freshness audit above was the right structure — the right question, asked of all fourteen gates,
on the right axis, laid out so a reader can check it. **One cell's answer was wrong, and it was the
cell that mattered.** Gate 7 (at least one row names the branch) sat under IMMUTABLE with the
justification *"rows are not deleted by the dispatch path"*. They are: `store.ts`'s `delete(id)` is
`/trident stop`'s hard delete, `DELETE FROM code_trident_runs WHERE id = ?`. So the row that proved
ownership can be gone by delete time, both `find` calls miss on the empty list, `refClaimedNow` falls
through to `null`, and the ref is deleted with NO ownership evidence — the exact condition the sweep
itself refuses as `owner-unknown`. With the new check removed the suite prints
`event=worktree_reaper_ref_deleted` for precisely that case.

THE FAILURE IS A STATEMENT ABOUT CODE I DO NOT OWN, BELIEVED BECAUSE IT IS THE KIND OF THING THAT IS
USUALLY TRUE. It is the same shape as #638's *"the caller will fail loudly"* (a claim about git's
behaviour that was never run) and #636's *"citing a validator is not reading it"* — three lanes, three
subsystems, one habit. The grep that would have settled it is four characters long.

AND THE TABLE MADE IT WORSE, which is the part worth carrying: **a classification makes every cell
look equally established.** An asserted cell sits in the same column, in the same typeface, under the
same heading as the measured ones, and inherits their credibility. Prose hedges — "probably", "I
believe" — survive into a paragraph and warn the reader; a table cell has no room for them, so the
uniformity silently promotes a guess to a finding. The fix is not to distrust tables but to hold each
cell to the standard the table implies: every entry now names a MECHANISM that can be pointed at, and
where the argument is still "this cannot happen", it says which code makes it so. Re-checking the other
thirteen on that basis moved gate 2 from "a ref does not change its own name" to "the candidate's
`ref` is a frozen string on a frozen object", and gate 6 from "a fact about this sweep" to "its subject
is in the past, and gate 5 holds the line anyway" — same verdicts, but now for reasons that are checkable.

THE PAIRING GAP WAS THE SAME BELIEF, EXPRESSED AS COVERAGE. Round 15's cases pair on the process axis
(a process appearing stops the delete; an owner that stays dead still deletes) and did not pair on the
owner-existence axis: an owner APPEARING was covered, an owner VANISHING was not. That is exactly
consistent with the classification — I tested the axis I believed could move. **A missing pair is a
belief about mutability, made visible.** Both halves now exist, and the hard-delete path the gate
defends against is itself asserted in a test, so a soft-delete replacement announces itself instead of
letting the classification go quietly stale.

A SECOND FINDING CAME OUT OF THE FIX, and it is the reason the round-13 field is no longer
canonicalised. Adding the fresh gate-7 read broke four cases, and the reason was that
`listBranchOwners(repo_path)` is keyed by the path STRING it is handed: a store configured with a
symlinked spelling answers NOTHING for the resolved one. So canonicalising the ROUTING key turned
"which repository do I act on" into "which repository does the store think I mean", and a repo reached
by a link would have had every ref refused — fail-closed, thanks to the new gate, but silently never
reaped. The candidate now carries the sweep's own spelling, because that is the key to both `git -C`
and the store, while the ATTESTATION stays canonical, because that comparison must not turn on how a
path was written. Two spellings, and each is load-bearing in the opposite direction: canonicalising
the routing key reds the sweep-through-a-link case, and de-canonicalising the comparison reds the
mint-here-act-there case.

### An extraction for testability can create an unguarded destructive primitive

The destructive half was EXTRACTED rather than short-circuited so that its ~20 tests would keep
covering the code #635 re-enables — coverage that a short-circuit would have let lapse in tests as
well as in production. That reasoning was right and its consequence was not followed through:
extracting it made it an EXPORTED ENTRY POINT whose doc comment read *"preconditions, all fourteen of
them, are the caller's"*. That sentence is an accurate description of an unguarded destructive
primitive. A direct caller could hand it `refs/heads/feature/abcdefgh` with that branch's true tip and
delete it with no owner row, no terminal phase and no holder evidence — and the tests had established
direct invocation as a supported pattern, so the bypass was not even unusual.

**TEN GATES PROTECTING A PATH ARE WORTH NOTHING IF THE PATH IS CALLABLE AROUND THEM.** The fix is to
stop expressing preconditions as prose addressed to a caller and express them as a VALUE the caller
cannot fabricate: `deleteReapableRef` takes a `ReapableCandidate`, minted at exactly one place — the
end of the gate chain — by a module-private `mintReapableCandidate`. The tests obtain one the way
production will: run the sweep, take what the gates minted, hand it back. It is the same object, not a
reconstruction, and that is the point.

WHY THE PROOF IS RUNTIME IDENTITY AND NOT A PHANTOM TYPE. A type-level brand is erased at runtime, so
`as` and plain JavaScript both walk straight through it — and, decisively, the negative test cannot
CONSTRUCT the forged input it needs in order to prove the refusal, so the guard ships untested.
Membership of a module-private `WeakMap` is unforgeable in both, because there is no expression outside
the module that writes to it. It also gets two things right for free: a dropped report takes its
candidates with it, and a candidate that has been serialised and revived is a copy carrying no
evidence, which is correctly not a candidate.

(CORRECTED, round 13. This section first said the resulting bypass was *unconstructible*. It was not:
the attestation covered `(ref, sha)` and the delete also consumed `repo`, which was free to vary. The
map — a `WeakSet` at first — now carries the canonical repository the gates ran against. See the next
section, which is the finding rather than a footnote to it.)

THE FALLBACK WAS TAKEN AS WELL, NOT INSTEAD. The namespace and object-name checks are re-asserted
INSIDE the destructive boundary, so the checks travel with the operation rather than living only at the
place that mints. On the production path they can never fire — minting already implies both. They are
there for the same reason `--no-deref` is: "unreachable in this tree" has been the wrong answer twice
in this change already. Ordering them ahead of the membership test also makes each independently
reddenable, which is how they are mutation-checked.

WHAT THE MUTATIONS SHOW, and one of them is the whole argument: dropping the membership check leaves
the namespace string as the only barrier, and the in-namespace forgery is then DELETED. Dropping the
mint's attestation reds 47 tests — the boundary is on the production path, not decoration bolted to the
side of it.

### AN ATTESTATION MUST COVER EVERY INPUT THE ATTESTED OPERATION CONSUMES

The round-12 boundary attested to `(ref, sha)`. The destructive operation consumes `(repo, ref, sha)`:
`deleteReapableRef` receives the repository as a SEPARATE argument and every git command it issues is
`git -C <repo>`. So the guard was complete along the axes it named and absent along the one it did not.

THE REPRO, and it is not exotic. Mint in repo A; create the same `trident/*` ref at the same commit in
repo B — a clone does it in one command; call `deleteReapableRef` with B's repo and A's candidate.
Membership passes, the namespace passes, the sha matches B's real tip, and B's ref is salvaged and
DELETED although B's gates never ran. Reproduced, then closed: with the repo check removed the suite
emits `event=worktree_reaper_ref_deleted repo=.../clone` and the cross-repository test reds.

WHY THE TESTS DID NOT FIND IT. Every forgery case built its bad value out of `ref` and `sha` — the two
fields the type has — inside a single repository. A test suite written against an attestation naturally
varies what the attestation TALKS ABOUT, so the input it is silent about is the one that stays fixed in
every case. The negative space of a guard is not a list of malformed values; it is **the set of inputs
the operation reads that the proof does not name**, and that set is invisible from the type.

**A token proving "these gates ran" is only as strong as the tuple it names.** Anything outside the
tuple is unattested by construction, however carefully the rest is checked. Applied here: the
repository identity lives in the mint's map, not as a field on the candidate, because a field the
caller can write cannot be the thing that proves anything — a forger sets `repo` as readily as `ref`.

CANONICAL IN THE ATTESTATION, LITERAL IN THE ROUTING, and both directions matter. Two spellings of one
repository (a symlinked path, a relative one, a trailing slash) must not mint under one name and be
refused under another — that failure is silent, since a refusal reads like a gate doing its job. So both
ends of the COMPARISON resolve through `realpathSync`. The fallback when resolution fails is the raw
string, which compares equal only to the identical spelling: the worst outcome is a refusal for a
repository that has just disappeared, never an acceptance for the wrong one. There is a test for the
symlinked spelling still deleting, and it reds under two separate mutations — attesting the raw path,
and canonicalising nothing.

READ THE ROUND-16 SECTION BELOW BEFORE ACTING ON THIS PARAGRAPH. As first written this round
canonicalised the candidate's ROUTING field too, and that was wrong for a reason this section could not
see yet: `listBranchOwners(repo_path)` is keyed by the path string it is handed. The resolution belongs
to the comparison only; the field stays faithful to the sweep's spelling. This paragraph is left
standing rather than silently rewritten because the distinction it lacks is the finding.

### A GUARD ADDED FROM FIRST PRINCIPLES CAN CONTRADICT SOMETHING THE TREE ALREADY KNEW

The same round's object-name check accepted exactly 40 hex characters. This tree supports SHA-256
repositories, and `trident/codex-build.sh`'s `sha_or_empty` carries the warning in as many words:
*"Both object formats count: 40 for sha1, 64 for sha256 — hard-coding 40 would collapse every measured
sha on a sha256 repo."* On a repository created with `--object-format=sha256` the destructive half
refused ITS OWN minted candidate as "not a full object name", and the reap silently did nothing.

This is the stale-assertion class inverted. Every other instance in this change was a COMMENT that had
stopped being true; here the tree held a LIVE warning and the new code contradicted it. Both are the
same failure to ask what already exists — and the live-warning direction is worse, because the warning
was written by someone who had already paid for the lesson.

AND THE COVERAGE WAS ONE-SIDED, which is why the widening needed its own tests rather than just a
wider regex. The original case proved only that a TRUNCATED sha is rejected: it established that the
check rejects something, never that it accepts what it must. A guard tested only in the rejecting
direction is untested in the direction that breaks users. There are now positive cases at both widths
against real git — a sha1 repository asserted at length 40, a sha256 one asserted at 64 and reaped end
to end, salvage name included — alongside negatives at 39, 41, 63, 65 and right-width-wrong-charset, so
"40 or 64" cannot quietly become "40 or more".

### NARROWING A CLAIM MEANS NARROWING IT WHEREVER IT IS ASSERTED, AND THE COMMENTS OUTLIVE THE RECORD

Round 8 narrowed this change's strongest claim — gate 14 does NOT make the outcome correct for every
interleaving — and the narrowing landed in THIS FILE, because this file is what the instruction named.
The module header and the comment at the gate itself kept the strong version for six more rounds:
*"what makes the OUTCOME correct for every interleaving"*, and a residue described only as a
sub-second retryable `git switch` failure, directly above the code whose failure mode is a dangling
HEAD and a PARENTLESS commit.

WHY THAT PARTICULAR DUPLICATE WAS THE WORST ONE. **#635 will be written against those comments.**
Whoever enables the deletion reads the sentence beside the gate they are unlocking — and that
sentence said the thing whose falseness is the entire reason the gate is locked. A record nobody is
required to open was honest while the code that the next change is written from was not.

So the comments now state the residue at its worst, name the two surviving interleavings (a claimant
the probe does not see, and a restore that fails), and point at #635 as the thing that eliminates the
OUTCOME rather than narrowing its probability. The one property that really does hold for every
interleaving — the commits are never lost, because the salvage precedes every delete — is now
distinguished from the outcome being correct, because collapsing those two is how the overclaim
survived this long.

### The pattern all four of these findings share

A decision made correctly, whose consequences were not propagated to the things that DEPEND on it.
The deferral was right and the PR's claim still said the opposite. The extraction was right and the
guard did not follow it across the new boundary. This is the rename lesson one level up: the change
reaches everything that is ABOUT it — the diff, the record, the comments — and stops at the thing that
merely TAKES A DEPENDENCY on it. The dependent artefact is never in the diff, which is exactly why
nothing prompts you to open it.

So the question after any decision is not "did I implement this" but **"what now asserts something
that was true before I decided, and is not true after"** — an issue link, a title, a function's
contract, an acceptance clause. Each of those was written by someone who had no reason to expect the
decision. It caught this PR twice in one round, on a review that was explicitly watching for it
elsewhere.

AND THEN THREE TIMES MORE. First, in the two directions that question has to be asked in. Deciding
the primitive takes an attested candidate did not prompt anyone to ask **what else that primitive
reads** — `repo`, which the attestation then did not cover. Deciding it should re-check the object name
did not prompt anyone to ask **what this tree considers an object name** — a question `codex-build.sh`
had already answered. Neither is in the diff; both were one grep away. So the question has a second
half: after asking what my decision has made false, ask **what my decision assumes that something else
here has already decided** — the inputs the new rule reads, and the conventions it re-states.

AND A THIRD FAILURE MODE OF THE SAME QUESTION, which is asking it and then answering it about ONE
artefact. Round 8 asked what the narrowed claim had made false and fixed the record; two comments
asserting the same claim stayed. Round 14 found them. The question has to be answered with a GREP for
the claim, not with a list of the documents that came to mind — because the places that assert a thing
are not the places that discuss it, and the ones that matter most are the ones the next change will be
written from.

THE SAME SHAPE ONE LEVEL DOWN, and it is the most instructive instance in this record because two
correct decisions collided. The test harness routed every minted candidate to the FIRST repository, a
harmless simplification while a candidate was `{ ref, sha }` and the attestation was repo-blind.
Binding the attestation to the repository — correct — turned that simplification into a defect: every
candidate from the second repository onward was refused, so the destructive path across repositories
was WRONG in the stand-in for the very call structure #635 restores. Neither decision was wrong and
nobody checked the join. A guard's blast radius includes the test harness, and a harness that stands
in for a call structure is production code for the purpose of asking what a change has made false.

### The transferable pattern

FOUR ROUNDS OF THIS REVIEW WERE SPENT NARROWING A RACE THAT CANNOT BE CLOSED FROM THIS SIDE OF IT.
Rounds 2, 3 and 4 each found a real defect in the reap's ownership checking and each was fixed by
adding another probe; round 5's remaining window is the same shape, and a sixth probe would narrow it
again without closing it. The fix that eliminates the outcome — rather than reducing its probability —
lives in the component that can observe the condition without a race: the claimant, which can ask
`git rev-parse --verify HEAD` about its own worktree and get a definitive answer.

So: WHEN A GUARD NEEDS A THIRD PROBE, THE QUESTION IS WHETHER IT IS ON THE WRONG SIDE OF THE BOUNDARY.
A guard that must sample two things it does not own, in sequence, to decide about a third is asking a
question its position cannot answer; the component that owns the state can usually answer the same
question with one call and no window. Probe-tightening buys probability, and the honest way to record
probability is as a residue rather than as a guarantee.

AND ITS SIBLING, from the same lane: a guard can also be on the right side of the boundary and still
be wrong because its RESULT TYPE is too small. The boundary question is about position; the
false-versus-unknown question is about representation. Both end the same way — a destructive action
taken on evidence that was never established.

### Coverage

Every terminal and non-terminal phase is enumerated by parsing the shipped
`migrations/expected-schema.txt` phase CHECK and splitting it with the module's own
`TERMINAL_PHASES`, so the table cannot drift from the schema or be guessed. Each of the three
terminal phases deletes; each of the five active phases keeps. Every refusal above has its own
test, and each gate was mutation-checked by reverting it and proving the suite reds. That includes
every gate added under review: the boot-rescue latch in both halves (dropping it inside the reaper
reds the reaper suite; dropping its wiring in the composition reds the stranded-sweep test); the
atomicity of the delete, where restoring the exact pre-review primitive reddens the boundary test by
REPORTING SUCCESS while the arriving commit is gone; gate 4c, where removing it deletes a preserved
dirty tree's ref on sweep 2; the claim probe, each of whose six witnesses and both of whose
unreadable-measurement refusals have their own case; and the restore classification, including an
adversarial shape for EACH half of the EEXIST predicate — a fatal exit carrying a different message,
and a non-fatal exit carrying the EEXIST message — since real git answers both together and either
half alone would classify the real case correctly while mis-classifying a failure.

FRESHNESS HAS NINE CASES OF ITS OWN, paired as always: a process appearing after minting stops the
delete, an owner that stays dead still deletes (or the first is satisfied by a boundary that refuses
whenever a recorded directory exists), the GENERATION witness is seen at delete time too, a `/proc`
that becomes unreadable between mint and delete refuses, and the header's freshness audit is pinned —
including a check that the re-measurement it describes is really inside `refClaimedNow`, with a
positive control against the slice reaching the sweep's own gate-10 call instead. On the owner axis:
a row that DISAPPEARS after minting stops the delete, a row that stays put still deletes, and the
hard-delete path the gate defends against is asserted to exist in `store.ts` (with a positive control
on the read), so the classification cannot go stale in silence. Six mutations: dropping the liveness
re-measurement reds four cases and DELETES the ref beneath the live process; reading an unreadable
`/proc` as "nobody home" reds one; dropping gate 10's generation witness reds three, two of them
pre-existing; dropping the re-measured gate 7 reds one and DELETES the ref with no owner row at all;
canonicalising the routing key reds the sweep-through-a-link case; de-canonicalising the attestation
comparison reds two.

THE DESTRUCTIVE BOUNDARY HAS ITS OWN THIRTEEN CASES and its own thirteen mutations, every negative paired with
a complement so no refusal can be satisfied by a boundary that refuses everything. Within one
repository: an out-of-namespace forgery, an in-namespace forgery, a COPY of a genuinely minted
candidate (which pins that the proof is identity, not field equality), and malformed object names at
39, 41, 63, 65 and right-width-wrong-charset — each refused with nothing written, not even the
salvage, and without spending the sweep's deletion allowance. Across repositories: a candidate minted
in one repo refused against another holding the same ref at the same commit, and the same candidate
still deleting in the repo it was minted for. Across spellings: a symlinked path to the SAME
repository still deletes. Across object formats: real-git positives at both widths, a sha1 repo
asserted at 40 and a sha256 repo asserted at 64 and reaped end to end. And across A SWEEP'S
REPOSITORIES, which is the call structure #635 restores: two repos reaped in one sweep with each
salvage landing in its own repo, one repo's held ref not stopping the other's, the same branch NAME in
both repos judged by each repo's own owner rows, and a sweep driven through a symlinked repo path
routing by the spelling the STORE is keyed by. The last three exist because the first cut of the
multi-repo test left three mutations alive — the harness routing, the field's spelling, and
per-repository ownership — and a surviving mutation is a missing case, not a note to add. That third
case asserted the opposite of what it asserts now: it was written when the field was canonicalised, and
round 16 inverted it, because the store read is what decides which spelling the field must carry.

SIX MUTATIONS SURVIVED A FIRST PASS ACROSS THE REVIEW ROUNDS and each one got a test rather than a
note: the detached-on-tip witness, a failed holder listing reading as "no claimants", an unreadable
rebase state reading as clear, the owners read failure, the restore's create-only-ness, and the
`!confirmed.ok` half of the salvage verify. One guard is documented as NOT reddenable and kept
anyway with the reason stated, rather than given tests that pretend otherwise. FOUR of them, not one,
and an undercount in this particular record costs more than in ordinary prose because this file is
where the honest-accounting standard in this repo is set:

  * gate 5's `existsSync(holder.path)` — a listed entry whose directory is gone is refused either
    way, by name via gate 4 or by `readRebaseHead` answering 'unknown' and standing the repo down.
  * the in-loop gate 2 `!ref.startsWith(TRIDENT_REF_PREFIX)` — `for-each-ref` is already scoped to
    that prefix, so the check can never fire on real output.
  * `holder.head !== ''` in gate 5's map build — git never prints an empty `HEAD` attribute.
  * `holder.path !== ''` in `parseHoldersZ`'s record close — git never emits a pathless record.

All four are benign defence-in-depth against a malformed or future git, all four are one comparison,
and none of them can change an outcome in this tree. They are named because a reader counting
mutation survivors should find the same number here that they measure.
