## 2026-09-12 — a run's branch ref no longer outlives the run, and the delete now rests on eleven pieces of evidence

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

**ELEVEN pieces of evidence, and unprovable refuses at every one.** The 2026-09-01 incident
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
9. The ref still points at the sha the enumeration read. `branch -D` has no old-value check, so
   the sha is re-read and compared; a ref that moved is a ref something just wrote to.
10. A salvage ref was written AND verified first. 67 of the 79 carry commits origin does not have,
    so the delete would otherwise drop the last reference to them. `refs/trident-reaped/<slug>/<sha>`
    keeps them reachable — outside `refs/heads` so it can never re-enter a launch, outside
    `refs/tags` so it neither clutters `git tag` nor rides a `--follow-tags` push. Recovery is
    `git branch <name> <sha>`. Salvage failing refuses the delete.
11. `git branch -D` itself agrees. Chosen over `git update-ref -d` precisely because it carries
    git's own refusal for a branch a worktree, rebase or bisect holds — measured on git 2.43:
    `branch -D` exits 1 with "cannot delete branch 'feat' used by worktree at ...", while
    `update-ref -d` deletes it without a word. Gate 4 should already have refused; this is the gate
    that does not depend on gate 4 being right.

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
test, and each gate was mutation-checked by reverting it and proving the suite reds.
