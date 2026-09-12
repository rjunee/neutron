## 2026-09-12 — a run's branch ref no longer outlives the run, and the delete now rests on ten pieces of evidence, atomically

Measured on the repo of record, 2026-09-12: **79 `refs/heads/trident/*` refs**, 78 of them held by
no worktree at all, and every one of them a ref whose run had already ended. A surviving ref is not
inert — the next launch of the same card RE-ENTERS it (`trident/inner-workflow.mjs:1346`: "If the
branch already exists from a previous run of this card, RE-ENTER it rather than failing"), so the
card's next build starts on the stale base its last attempt failed from.

Why teardown never happened. `worktree-cleanup.sh` does tear the ref down, and its gating is sound
(`delete-branch` mode, only once origin holds the exact sha) — but it is invoked from the inner
workflow's `finally{}` (`trident/inner-loop.ts:417-426` threads its path in), so it runs only while
the workflow's own process is alive. A run reaped by the hang watchdog, cancelled from the board or
`/code stop`, or lost to a gateway restart never reaches it. And the worktree reaper, the one thing
that already fires on every path, was built to never delete a branch: the ref WAS the rescue copy
of a failed run's commits (`.trident/plans/trident/nothing-ever-reaps-a-trident-worktr.md`).

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

**TEN pieces of evidence, and unprovable refuses at every one.** The 2026-09-01 incident
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
4b. No worktree THIS SWEEP detached still exists. Found by a test rather than by reasoning: the
   worktree pass detaches a process-free `trident/*` holder BEFORE it decides whether the tree may
   be removed, so a tree preserved immediately afterwards (dirty, or inside retention) has had its
   ref freed while its only-copy work sits on top of it. The ref is now kept until the tree is gone
   — which extends #541's dirty-worktree preservation into the ref namespace instead of undoing it.
5. At least one run row names the branch. NO row is the absence of an owner, not evidence of
   disposability — it is what protects a hand-made branch, and it keeps 6 of the 79.
6. EVERY row naming it is terminal.
7. No owning run's recorded worktree still exists on disk.
8. No live process stands in an owning run's worktree, and none stands in a path bearing its
   `workflow_run_id` — the gate for the race the store cannot see, where the row went terminal
   while the detached workflow is still running.
9. A salvage ref was CREATED first, create-only. 67 of the 79 carry commits origin does not have,
   so the delete would otherwise drop the last reference to them. `refs/trident-reaped/<slug>/<sha>`
   keeps them reachable — outside `refs/heads` so it can never re-enter a launch, outside
   `refs/tags` so it neither clutters `git tag` nor rides a `--follow-tags` push. Recovery is
   `git branch <name> <sha>`. Salvage failing refuses the delete.
10. THE DELETE IS ONE ATOMIC COMPARE-AND-SWAP — `git update-ref -d <ref> <expected-sha>`, which
    checks the old value and unlinks the ref under one ref lock. A branch that advanced since the
    enumeration cannot be deleted at all, because there is no read-then-delete window: there is no
    separate read. See below for what this replaces.

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
them: measured against the live rows, 73 pass gates 5-7 and 6 are refused for unknown ownership.
Ref retention is deliberately ZERO where a worktree gets 24 h — a worktree can hold work no probe
can read intent out of, whereas gate 10 has already copied a ref's commits elsewhere, and the
failure being fixed is a NEXT launch that can be seconds away. `MAX_REF_DELETIONS_PER_SWEEP = 50`
bounds one sweep, so the backlog drains over two.

**One existing invariant changed, and it is the one #547 ordered reversed.** The source assertion
"the reaper can never force, delete a branch, or kill" kept its force and kill bans and traded the
branch-delete ban for something stricter than zero: there is EXACTLY ONE `-D` in the file, and it
is the guarded one. Hiding the delete in a sibling module to keep the old assertion green would
have left a test asserting the opposite of what the module does.

### Coverage

Every terminal and non-terminal phase is enumerated by parsing the shipped
`migrations/expected-schema.txt` phase CHECK and splitting it with the module's own
`TERMINAL_PHASES`, so the table cannot drift from the schema or be guessed. Each of the three
terminal phases deletes; each of the five active phases keeps. Every refusal above has its own
test, and each gate was mutation-checked by reverting it and proving the suite reds — including the
boot-rescue latch, in both halves (dropping it inside the reaper reds the reaper suite; dropping its
wiring in the composition reds the stranded-sweep test) and the atomicity of the delete, where
restoring the exact pre-review primitive reddens the boundary test by REPORTING SUCCESS while the
arriving commit is gone.
