# IMPLEMENTATION_PLAN — "already at the built sha" is a publish NO-OP, not a failure

Card: the outer publisher calls "already at the built sha" a FAILURE, discarding a finished build
(3 occurrences 2026-08-17: enterprise run `26ed32c1`/PR #521, open run `88efe1ca`/PR #391 — the
deploy blocker — and near-miss `95fcfb91`/PR #527). Boundary: the fix lives in the OUTER publish
path only (`trident/orchestrator.ts` — `publishBuiltCommit` and its caller in `applyResult`); the
inner loop must NOT gain a push. Distinct from the git-truth-reconciliation card
(`01M07YTEDDMDRQRZRSD16ADBTQ`): that one asks git after a failure; this one stops manufacturing
the failure. Both are wanted; build only this one here.

- [x] Diagnosis confirmed against this tree: the refusal is `trident/orchestrator.ts:1807-1811`
      (`if (expected === resolvedHead) throw … "already at … on origin — the build left no new
      commits to publish"`), reached from `applyResult`'s publish handoff (`:2325`), and
      `trident/orchestrator.test.ts:1875` ("zero commits ahead of the remote still fails")
      currently PINS the defective behaviour.
- [x] Verified no other consumer keys on the refusal string: `classifyPublishFailure`
      (`orchestrator.ts:474`) matches credential/ref-rejection words only ("no new commits"
      classifies `publish-unknown`, never auto-retried); delivery/board paths carry the reason
      opaquely. Removing the throw orphans nothing.
- [x] Verified the genuine "nothing was built" outcome already has its own, correct guard
      downstream: the empty `base..head` diff refusal (`outer publisher refused to dispatch
      reviewers for an empty diff`, `orchestrator.ts:1876-1878`) — content vs base, the predicate
      that actually measures "the build produced nothing". It stays.
- [x] **TASK 1 — resolve-and-continue (acceptance 1, 2, 4, 5).** Introduce the exported pure
      predicate `remoteAlreadyAtPublishHead(observedRemoteSha, headToPublish)` in
      `trident/orchestrator.ts`; in `publishBuiltCommit`, compare the OBSERVED remote sha against
      `headToPublish` (the POST-rebase head — not `resolvedHead`): equal → skip the lease push +
      witness (the observation IS the witness), return `push: 'noop-already-at-head'`; delete the
      "no new commits" refusal entirely. `applyResult` folds the no-op into the transition note
      ("push no-op — the ref was already correct"). The `outer-published:<oid>:<n>:<r>[:deviated]`
      checkpoint format is UNTOUCHED (three lockstep readers). Test-first in
      `trident/orchestrator.test.ts`: rewrite the `:1875` test to assert done + no
      `--force-with-lease` + checkpoint pinned + null failure_reason; add a note-visibility test
      (expose `step` from `buildHarness`); add pure predicate tests ('' → first push, equal →
      no-op, stale → push); fix the stale comment at `:166-169`. Mutation check: hard-coding the
      predicate result to `false` must turn the new tests red. Prepend the `docs/AS_BUILT.md`
      entry.
- [ ] **TASK 2 — the REAL-remote regression (acceptance 3).** New
      `trident/publish-noop-already-published-realgit.test.ts`: a real bare origin (`file://`), a
      real checkout whose branch is FULLY PUSHED (origin already at the built sha), the real
      orchestrator driven with a hybrid host (real `git` via `spawnCapture`, canned `gh`). Assert
      the run reaches `done` with the right commit (`outer-published:<branchTip>:0:1` handed to
      the review re-fire), no `--force-with-lease` push was issued, the publish transition note
      carries the no-op sentence, and `failure_reason` is null. Follows the seeded-world pattern
      of `publish-rebase-realgit.test.ts` / `as-built-publish-wiring-realgit.test.ts`.
- [ ] **Post-fix verification sweep (acceptance 4 + 5 closure).** On the completed branch: grep
      for the non-test caller of `remoteAlreadyAtPublishHead` (must be exactly the
      `publishBuiltCommit` call site) and record in the PR that deleting it turns both the
      harness no-op test and the real-git test red (refusal direction fails the run; always-push
      direction trips the no-push assertion); re-grep the tree for any path reading the no-op as
      "the build produced nothing" (expected: none — the empty-diff guard is the only
      nothing-built refusal).
