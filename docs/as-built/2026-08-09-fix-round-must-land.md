# A fix round that never reached the branch now stops the run

**Landed:** 2026-08-09 · **Surface:** `trident/inner-workflow.mjs`

## The defect

A fix round runs with `isolation: 'worktree'` — its own throwaway git worktree.
Edits that are not committed AND pushed die with it, and the round still reports
success. The next review then reads the UNCHANGED pushed head and re-reports the
SAME findings, which reads as "the fixes didn't work" rather than "the fixes were
never there".

PR #145 is the record. Its review blocked it with, verbatim: *"pushed head does
not contain the round-2 fix set; merging now ships rejected code … addressed only
in uncommitted tree."* Three rounds, four reviewers each, essentially all of it
spent on a head that never moved. The work was found afterwards in a `git stash`
on the build host and pushed by hand.

## The gate

After every fix round, before the re-review, a one-command probe reads the
branch's current head — from the REMOTE in PR mode (`git ls-remote`), because
"pushed" is the property that matters and a local ref can be ahead of anything a
reviewer or the merge will ever see. `roundLanded(before, after)` then decides, in
code:

- head moved → carry on,
- head unchanged → **stop**, with `blockKind: 'round-lost'` and a finding naming
  which round to recover and where to look,
- head unreadable → does NOT count as landed (a failed fetch is not progress),
- baseline unreadable → permissive, because with no baseline there is nothing to
  compare and failing the run there would block builds for an unrelated reason.

**The decision is in code, not in a prompt.** The agent is asked for one fact — a
sha — and makes no judgement about it. An agent asked "did your round land?" is
auditing itself, and the failing case is exactly the one where it believes it
succeeded. Same reasoning as the deterministic cross-model gate.

A lost round is reported as its own `blockKind` rather than as `code`, for the
same reason `infra-only` exists: the code was not re-judged, so calling it a code
rejection is a false statement about the diff.

## Coverage

`trident/round-landed.test.ts` — 13 tests against the real function bodies
extracted from the shipped script. Mutants killed: making an unreadable head count
as landed fails the failed-fetch test; inverting the comparison fails three.
