# IMPLEMENTATION_PLAN — Publish-path rebase conflicts must be resolved, not escalated (Plan card 2026-08-15)

Governing spec: this Plan card (wire the Forge conflict resolver into `rebaseOntoObservedBase`). Build branch: `trident/a-rebase-conflict-on-the-publish-pa` (tip `3cbfb52`, based on `23a29b3`; origin holds `0de2a1e`). Verified 2026-08-15 against BOTH the branch tip and current `origin/main` (`cbcfb65`, #292):

- T1–T3 ARE LANDED AND VERIFIED ON THE BRANCH: `rebaseOntoObservedBase` takes an optional 7th arg `resolve?: { run: TridentRun; resolve_conflict: MergeConflictResolver }` and loops the resolver in the scratch worktree bounded by `MAX_CONFLICT_ROUNDS` (exported from `trident/merge.ts`), re-reading `--diff-filter=U` after every claimed RESOLVED (`0de2a1e`); real-git proof for resolving/declining/no-resolver cases (`f2e09a1`, `trident/publish-rebase-realgit.test.ts`); AS_BUILT entry (`3cbfb52`). Stub-host acceptance 1–6 covered in `trident/orchestrator.test.ts` including the review-gate second-fire proof.
- BUT MAIN MOVED UNDER THE BRANCH. `origin/main` is now `cbcfb65`: #290 (`d5ba62b`, git-truth heads) and #292 (`cbcfb65`, fork-point diff base + `--output` patch bytes) REWROTE `rebaseOntoObservedBase` — new return shape `{ head, rebased, baseSha }`, a `localForkPoint()` for the no-PR diff, `git diff --output=` instead of captured stdout, and a NEW carve-out: a failed apply with ZERO unmerged paths is a WHOLESALE apply failure (plain `Error` surfacing git's stderr), NOT a `TridentRebaseConflict`. `git merge-tree --write-tree --merge-base 23a29b3 cbcfb65 3cbfb52` reports exactly three conflicted files: `trident/orchestrator.ts`, `docs/AS_BUILT.md`, `IMPLEMENTATION_PLAN.md` (both test files merge textually clean but must be re-proven by running them).
- THE SUBTLE HUNK, named per the card's own bar: the branch throws `TridentRebaseConflict` when `paths.length === 0 || resolve === undefined`; main now throws a plain wholesale-failure `Error` when `paths.length === 0`. Taking EITHER side verbatim is wrong — the branch's line would regress #292's carve-out (resurrecting `REBASE CONFLICT … (paths unreadable)`), main's would drop the resolver. The merged order MUST be: empty unmerged → main's wholesale `Error` (resolver NEVER invoked — nothing is unmerged, it is not a conflict); non-empty + no resolver → `TridentRebaseConflict` unchanged; non-empty + resolver → bounded loop, then fall through to the ordinary commit + CAS.
- Local `main` in the repo of record is stale (`d8324cc`); fetch and base all work on `origin/main` = `cbcfb65`.

- [x] Bounded Forge conflict resolver exists with the correct tool grant and ESCALATE/RESOLVED contract (`trident/conflict-resolver.ts`, #342/#361).
- [x] Local-mode merge path invokes it, bounded by `MAX_CONFLICT_ROUNDS` (`trident/merge.ts`).
- [x] Composer builds the resolver gated on the live-credential predicate and passes `resolve_conflict` into the orchestrator opts (`open/composer.ts`, no composer change needed).
- [x] **T1 — thread `resolve_conflict` into `rebaseOntoObservedBase`, invoke it at the throw site bounded by `MAX_CONFLICT_ROUNDS`, rewrite the two stale comment blocks, prove acceptance 1–6 in the stub-host suite** (LANDED `0de2a1e` on the branch).
- [x] **T2 — real-git proof in `trident/publish-rebase-realgit.test.ts`**: resolving resolver's staged resolution commits and lands in the CAS-moved head; declining resolver stays an attention state with the branch ref unmoved; no-resolver case renamed (LANDED `f2e09a1`).
- [x] **T3 — `docs/AS_BUILT.md` changelog entry**, newest-first, citing the three dead runs (`25b2327d`/`5a17ec86` #290, `9e813276` #289), root cause #291, and the kept invariants (LANDED `3cbfb52`).
- [x] **T5 — close the review round-1 findings (`26c19dd` → this commit).**
  - BLOCKER — the lie-detector read the INDEX only. `git add` clears the unmerged bit for a whole
    path whatever is left inside the file, so a resolver that fixes hunk 1 of 2 and stages (exactly
    what its own contract orders) read as CLEAN and would have committed + force-pushed `<<<<<<<`
    to the shared branch. Added a staged-BYTES scan (`git diff --cached -U0` over every path that
    ever conflicted, matching added `<<<<<<<` / `>>>>>>>` lines); a marked file goes back into the
    unresolved set. Proven against real git AND against the stub host, and both tests were shown to
    FAIL with the scan disabled.
  - MAJOR — the resolver's prompt was factually false at the new call site (it claimed a `git
    rebase` in progress, and ordered a test run in a worktree with no `node_modules`, whose module
    lookups escape upward into a checkout other lanes are building in). Added `mode: 'rebase' |
    'replay'` to `MergeConflictResolver`'s input; `'replay'` describes the detached apply-`--3way`
    worktree, forbids the test run, says the outer publisher commits, and confines every path to
    the cwd. Local-mode merges keep the old wording by default.
  - MAJOR — `MAX_CONFLICT_ROUNDS` was ported without `merge.ts`'s per-round progress guarantee.
    There is exactly ONE apply here, so rounds 2..12 re-hand the resolver an identical tree: up to
    12 × 8 min of zero-progress Forge turns inside the SERIAL tick sweep. Now every round must
    SHRINK the unresolved set or it bails to `TridentRebaseConflict` at once.
  - MINOR — a resolution that empties the branch's delta hit `git commit`'s "nothing to commit",
    which git writes to STDOUT while `publishFailureReason` forwarded only stderr → a causeless
    failure after the `finally` deleted the evidence. Both streams are forwarded now, and the
    empty-delta case lands in the same non-verdict attention state.
  - MINOR — conflicted paths were C-quoted (`"\303\274nicode file.txt"` names no file). Read with
    `-z` + `core.quotePath=false` here and in `merge.ts`'s `listConflictedFiles`.
  - MINOR — `docs/SYSTEM-OVERVIEW.md`'s "never auto-resolved" claim and its stale two-dot-diff
    claim rewritten. The AS_BUILT entry's falsified "cannot commit an unresolved tree" sentence
    replaced with what is actually checked.
  - NITS — added a partial-resolution-across-rounds test (2 conflicts → 1 resolved → round 2 sees
    only the remainder), and the real-git `TridentRun` fixture now carries `task`, the field the
    production resolver interpolates into its prompt.
- [x] **T4 — rebase the branch onto `origin/main` (`cbcfb65`), reconciling the resolver threading with #290/#292's rewrite of `rebaseOntoObservedBase`; keep BOTH semantics; re-prove all suites; push with a pinned lease.** Resolve `trident/orchestrator.ts` per the merged-order rule above (wholesale-failure carve-out wins on empty unmerged; resolver loop wins on non-empty; `{ head, rebased, baseSha }` return and 7th `resolve?` arg coexist; call site keeps main's `baseSha` consumption and adds the branch's 7th argument; keep main's fork-point/patch-bytes/wholesale comment blocks AND the branch's rewritten class-doc + ON CONFLICT paragraphs). `docs/AS_BUILT.md`: keep main's file, insert the branch's `## 2026-08-15 — a publish-path rebase conflict is resolved, not escalated` entry directly under the intro line, above main's current newest content. `IMPLEMENTATION_PLAN.md`: this body. Then run the trident suites (orchestrator, publish-rebase-realgit, merge, merge-realgit, conflict-resolver + full `trident/`) and repair any stub-host drift the textually-clean test merge hid. Push `trident/a-rebase-conflict-on-the-publish-pa` with `--force-with-lease` pinned to origin's observed `0de2a1e`.
