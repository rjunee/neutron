## 2026-09-12 — the Fable arbiter gets a production call site, at the one merge hold it can actually see (#541)

`buildFableArbiter` (`trident/arbiter.ts:173`) was 297 lines of built, unit-tested,
re-exported (`trident/index.ts:137`) gate that **nothing constructed**. A whole-tree
search for call sites outside `trident/arbiter.test.ts` returned the definition and
the re-export and nothing else. `SPEC.md` § Decisions Log 2026-09-11 lists the arbiter
rule among the gates "ahead of every shipped system surveyed" that STAY through the
pivot; the same entry measures what its absence costs — 291 runs, 9 done, all 9 merged
by hand.

### What is wired

ONE hold: the bounded conflict resolver ESCALATING a rebase conflict in
`rebaseBranchOntoBase` (`trident/merge.ts`). That is the site `arbiter.ts:4-8` was
written for — *"resolver fails → arbiter decides → only then chat"*. The seam:

- `arbitrateConflict()` in `merge.ts` asks ONE question with a two-option set
  (`CONFLICT_ARBITRATION_OPTIONS`: `retry-resolution` | `stop`) and never throws.
- A `retry-resolution` decision re-enters the rebase loop WITHOUT advancing it, so the
  same conflicted commit goes back to the resolver carrying the arbiter's reasoning as
  the new `guidance` field on `MergeConflictResolver`. `MAX_CONFLICT_ROUNDS` still
  bounds the loop; the arbiter's own per-run cap bounds how often it can ask.
- Guidance is cleared the moment a round resolves: the next commit's conflict is a
  different pair of sides, and stale guidance would describe the wrong one.
- **Every other outcome — `unavailable`, `owner-only`, `stop`, an option that was never
  offered, an arbiter that throws, no arbiter wired — falls through to the identical
  `rebase --abort` + `TridentMergeConflictEscalation(resolver question)` the owner has
  had all along.** The arbiter can only ever ADD one retry. It cannot block a run,
  cannot guess, and cannot change the text the owner reads.

Composition, following `resolve_conflict`'s path exactly: `open/composer.ts` builds it
on `makeEphemeralSubstrate('cc-trident-arbiter')` per `arbiter.ts:155`, gated on the
same live-credential predicate as the resolver; `gateway/composition/input/misc-input.ts`
DECLARES the `arbitrate` key (an undeclared key is silently dropped — the
`resolve_phase_models` failure mode); `gateway/composition/build-core-modules.ts`
copies it onto the orchestrator options; `trident/orchestrator.ts` threads it into the
default `buildMergeCleanupDeps`.

### What is deliberately NOT wired, and why

The four other merge holds all fail the same two tests — can the arbiter SEE the fact
in question, and is the alternative to holding something an arbiter is permitted to
choose?

- **Base-drift holds** (`merge.ts` `baseDriftHoldMessage`, both the assessable and the
  unassessable branch, and the three throws that use it). The only alternative to
  holding is landing a combination no reviewer saw. That is a review waiver, and
  `arbiter.ts:66-91` keeps `approve`/`merge`/`skip-review`/`bypass-review`/`self-approve`
  out of any set an arbiter selects from *structurally*. Renaming the same authority
  would defeat the boundary, not satisfy it.
- **The dirty merge-worktree refusal** (`provisionRunWorktree`). The only alternative is
  `git worktree remove --force` on uncommitted work that, by that function's own
  contract, exists nowhere else. The arbiter is read-only, and the refusal is documented
  as the intended trade that keeps failing until a human looks.
- **PR-mode: GitHub would not name the base** / **the head lives in a fork.** The
  missing fact is in a GitHub API response, not in the tree. The arbiter's prompt
  confines every path it may read to `input.repo_path` (`arbiter.ts:134`), so it would
  be adjudicating something it cannot inspect — worse than not being asked.

Also left: `rebaseOntoObservedBase`'s replay-path conflict in `orchestrator.ts`. It is a
genuine candidate (its tree holds the markers too) but a different seam in a different
file; one seam per change. And `on_infra_retry` (`orchestrator.ts:387`), which is the
other never-passed production option — issue #535 owns it, and this change does not
silently expand into it.

### Tests

`trident/arbiter-wiring.test.ts` (13) drives the composed merge path: the qualifying
hold reaches the arbiter and its selection lands the run; `stop`/`owner-only`/
`unavailable`/an unwired arbiter/a throwing arbiter/an unoffered option all reach the
owner unchanged and neither block nor resolve; guidance is scoped to its commit; the
real `buildFableArbiter` refuses the (cap+1)th call naming the cap, and that refusal is
an `unavailable` the merge falls through on; the option set is non-empty and passes
`assertArbitrableOptions`. The two non-qualifying holds assert the arbiter is called
ZERO times. `trident/orchestrator.test.ts` adds the end-to-end pair (escalation → landed
build; unavailable → `failed` with the specific question).
`open/__tests__/trident-arbiter-wiring.test.ts` guards the three composition links on a
real boot. Twelve mutations were reverted one at a time and each proved a test red.
