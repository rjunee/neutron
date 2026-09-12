---
title: A run whose HEAD does not resolve must refuse to commit
group: trident
status: open
priority: P1
cutover: false
legacy_ref: "#635 — filed from #547 / PR #606, the reap's undetectable-claimant residue"
---

> **NOT MARKED AS BLOCKING THE CUTOVER, deliberately.** It sits in the cutover milestone because it
> is trident work, but `cutover: false` because the claim "the cutover cannot ship without this" is
> one I cannot defend: the commits are never lost (#547's salvage ref holds the tip), and reaching the
> bad outcome needs a narrow race between a reap and a dispatch. It is a correctness gap to close
> before trident is relied on unattended — not a gate on the cutover itself. Overstating a blocker is
> the same species of error as overstating a guarantee, which is what #606's last round was about.

## The condition

A build worktree can end up with a **dangling symbolic HEAD**: `HEAD` names a branch whose ref no
longer exists. From inside that worktree git is unambiguous about it, and unambiguously wrong-footed
by it. Measured on git 2.43, in a worktree on `trident/slug` whose ref was deleted underneath it:

```
$ git symbolic-ref HEAD
refs/heads/trident/slug          # HEAD still names the branch

$ git rev-parse --verify HEAD
fatal: Needed a single revision  # exit non-zero — the definitive signal

$ git status
On branch trident/slug
No commits yet                   # the index is INTACT; staged files are still staged

$ git commit -m "the next commit"
$ git rev-list --parents -1 HEAD
35fc5bf2…                        # ONE word: the commit is PARENTLESS
```

That last line is the whole problem. A parentless commit is a root commit, so the run's PR is a
**whole-tree diff against unrelated history** — the silently-wrong-base class `#547` exists to
eliminate, arrived at from the other direction. No commit is lost and nothing errors; the build
simply produces a diff nobody can review.

## Why this belongs on the claimant's side

`#547`'s reaper deletes a finished run's branch ref, guarded on fourteen checks, and it re-measures
holders and live owners immediately before and after the delete so that a **detected** claimant has
its ref restored. A claimant that resolved the branch between those two snapshots is not detected:
two separate git invocations cannot atomically observe "nobody holds this ref" and delete it. PR #606
spent four review rounds narrowing that window, and each round's fix was another probe. The window is
smaller; it is not closed, and it cannot be closed from the reaper's side.

The claimant can settle it with **one call, no race, no snapshot**: `git rev-parse --verify HEAD`
either resolves or it does not. A check there eliminates the parentless-commit outcome for every
interleaving, including ones nobody has enumerated — rather than reducing the probability of one
enumerated interleaving. That is the difference between a guard on the wrong side of a boundary and a
guard on the right one.

It is also not only about the reaper. Any cause of an unresolvable HEAD — a hand-deleted branch, a
half-finished `worktree add`, a pruned ref, a future path nobody has written yet — produces the same
parentless commit, and this check catches all of them.

## Acceptance — BIDIRECTIONAL, and both halves are required

A guard that refuses everything satisfies (a) on its own and is worthless, so (b) is not a courtesy
test:

- **(a) A run whose HEAD does not resolve REFUSES to commit,** and fails with a reason naming the
  condition and the branch — not a generic git error. Proven against real git by deleting the branch
  ref under a live worktree with a populated index, then attempting the commit: no commit object is
  created, and the run reaches a terminal state whose `failure_reason` says HEAD does not resolve.
- **(b) A run whose HEAD resolves normally STILL COMMITS,** with the commit carrying its expected
  parent. Proven in the same suite, against the same code path, with an ordinary worktree: the commit
  lands and `git rev-list --parents -1 HEAD` shows two words, not one.
- **(d) THE REAP PERFORMS DELETIONS ONLY ONCE THIS GUARD IS IN PLACE.** #606 landed every gate, the
  salvage, the measurement and the reporting but deliberately performs **no deletions** — the
  destructive half sits in an exported `deleteReapableRef` that the sweep does not call, behind one
  named reason (`DEFERRED_PENDING_CLAIMANT_GUARD`). That function accepts only a `ReapableCandidate`
  minted by the gate chain, so the single call this item restores must pass the candidate the sweep
  minted — reconstructing `{ ref, sha }` is refused at the boundary and deletes nothing. Satisfying
  this item therefore includes deleting that deferral and restoring the single call, and proving the
  sweep deletes again. Until then the sweep records CANDIDATES in `refs_candidates` — refs that pass
  gates 1-10: **72 of 80 on the repo of record** as of 2026-09-12 (see the issue comment). That figure is an UPPER BOUND on what would be
  deleted, not a measurement of it: gate 11 *is* the salvage write, so a dry run that evaluated it
  would not be dry, and gates 12-14 re-measure sources gates 4-8 have just read, so in a dry sweep
  they would re-derive the same answer and add the appearance of rigour rather than any. The exposure
  this sequencing holds back is therefore "at most 72", which is still not a small first exposure for
  an operation that does not exist today.
- **(e) THE CLAIM PROBE REFUSES ON AN UNREADABLE HOLDER LISTING, proven before deletion is
  re-enabled.** #606's probe had a hole — a `worktree list` that succeeded with impossible output
  (zero records, which git cannot produce) read as "no claimants" and would have permitted a delete.
  It is fixed there, but the fix was only ever *survivable* because #606 deletes nothing; re-enabling
  deletion re-enables everything the probe decides. So this item's change must re-run those refusals
  as part of its own acceptance rather than trusting them: a guard that is safe only because the
  thing it guards is switched off is not yet a guard.
- **(c) The refusal is not inferrable from the index.** A worktree whose HEAD resolves but which has
  nothing staged is a no-op commit, not this condition, and must not be conflated with it — the
  discriminator is `rev-parse --verify HEAD`, not "No commits yet" in `git status` output, which is
  prose and is translated.

## Notes

The reaper's residue is recorded honestly in `.trident/as-built/trident/ref-reap-547.md` — the
commits are never lost (the salvage ref holds the tip and `rev-list --all` reaches it), a detected
claimant is restored, and an undetected one is left with a dangling HEAD that nothing in that module
repairs. This item is what makes that residue harmless rather than merely documented.
