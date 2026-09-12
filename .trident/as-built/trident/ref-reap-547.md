## 2026-09-12 — a run's branch ref no longer outlives the run: a durable holder gate, an atomic delete, and a reap that cannot outrun a dispatch

Measured on the repo of record, 2026-09-12: **79 `refs/heads/trident/*` refs**, 78 of them held by
no worktree at all, and every one of them a ref whose run had already ended. A surviving ref is not
inert — the next launch of the same card RE-ENTERS it (`trident/inner-workflow.mjs:1346`: "If the
branch already exists from a previous run of this card, RE-ENTER it rather than failing"), so the
card's next build starts on the stale base its last attempt failed from.

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

### The generalisation, which outlived the specific fixes

**ON A DESTRUCTIVE PATH, "FALSE" AND "UNKNOWN" MUST NEVER SHARE A BRANCH — AND A BOOLEAN RESULT TYPE
IS WHAT MAKES THEM SHARE ONE.** This is stated first because it is the transferable part; everything
below it is one module's instances of it.

Three review rounds produced three versions of a single mistake, each time a boolean `ok` deciding a
question git answers with an exit code:

| round | the decision | what `ok` collapsed | what it needed |
|---|---|---|---|
| 4 | did the create-only salvage refuse because the ref exists? | "already exists" with every other failure | exit **128** AND the message |
| 6 | did the delete happen? | "refused" with "timed out, so I cannot tell" | success / timeout / other |
| 7 | is the ref there now? | "absent" with "`fatal: permission denied`" | exit **0** / **1** / anything else |

Round 7's is the one that shows the cost plainly: a hard git error read as *absent*, so the sweep
recorded a **deletion it had no evidence for**. Each of the three fixes was correct and each left the
same latent shape next door, because the type carried one bit where the domain has three states. A
`HostCommandResult` exposes `exit_code`; `ok` is a convenience over it, and a convenience is the wrong
thing to branch a destructive decision on.

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
below, stated once; the module header carries the same fourteen in the same order.) The 2026-09-01 incident
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
   `workflow_run_id`. The race is real — the row goes terminal while the detached workflow is still
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

  * GATE 12 re-measures holders and live owners from scratch immediately before the delete. This is
    the ordinary case, and it means the destructive act is never performed at all when a claim has
    already landed.
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
    property the whole design rests on and it holds for every interleaving.
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
