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

### The privilege boundary — the fix review forced

The first version of this change passed the DEFAULT substrate profile, and that made
the arbiter's whole safety argument false where it counted. `PROFILE_EPHEMERAL` sets
`github_credential: true`, which resolves to `GH_TOKEN` plus a git credential helper in
the spawned env, and the turn declares `Bash` under `--dangerously-skip-permissions` —
so `approve`, `merge` and `skip-review` were excluded from the OPTION SET and fully
available to the PROCESS via `gh pr merge` / `git push` / `gh api`. The only thing
standing between them and a merge was a sentence in the prompt, and the injection
vector is in the same turn: the arbiter's evidence embeds the conflict resolver's own
escalation question, written by another bounded agent.

`PROFILE_ARBITER` (`gateway/wiring/substrate-profiles.ts`) drops the grant, following
`PROFILE_LEAK_FIXER`'s "CREDENTIAL-FREE BY PROFILE, not by prompt" rule — which the
leak fixer earns for a turn that EDITS files, i.e. strictly less restricted than this
one. It is registered in the frozen-shape guard so flipping it back fails a test.

WHAT THAT DOES NOT FIX, recorded rather than hidden: `skip_permissions: true` still
means the declared `Bash` is ungated, so "read-only" remains a prompt contract, not an
enforced property. `permission_mode` and `sandbox` are the knobs that would make it
structural and both are RESERVED (not applied by the factory). `arbiter.ts`'s tool-surface
docblock used to say "read-only Bash" as though it were checked; it now states the gap.

### Two more things this change owes the reader

**It buys landed builds with wall-clock.** Arbiter and resolver each default to 8
minutes and `cleanupAfterMerge` is awaited in the SERIAL tick sweep, so with the real
cap of 3 the worst case is 7 model turns (~56 min) on a path that previously ended
after one (~8 min). `orchestrator.ts`'s replay loop quantifies the same cost and
concludes the opposite ("zero progress once is the answer"); the difference is that a
retry here is not a repeat — a different agent read the tree and said why — and the
bound is MAX_CONFLICT_ROUNDS, which retries spend and never reset. Both loops' comments
now say this; the replay one used to assert an invariant this change breaks.

**A successful retry also discharges part of the #542 base-drift hold.**
`resolverCoveredPaths` subtracts a path the resolver was handed with both sides in
context. Pre-#541 that was unreachable for an escalated conflict (the escalation threw
first); a retry that RESOLVES now reaches the drift gate with those paths covered, so a
merge can land where it previously held. The policy is unchanged — the resolver did see
both sides — but it is a behaviour change on a review gate, so it is pinned by three
tests: the baseline that still holds, the retry that lands, and a retry that resolves a
DIFFERENT file than the drift overlaps, which still holds.

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
`open/__tests__/trident-arbiter-wiring.test.ts` guards the composition links on a real
boot, and `gateway/composition/build-core-modules-trident-arbiter-wiring.test.ts` drives
the REAL composed orchestrator (`buildCoreModules` → `tridentModule.init` →
`buildTridentOrchestrator` → `buildMergeCleanupDeps`) through a real merge — reaching it
via the mutation gate's genuine prose-only exemption rather than a stub — and asserts the
arbiter was consulted and acted on. That test exists because the source-text assertion it
supplements stays GREEN when the composition assignment is moved behind `if (false)`,
which is the exact hole a string match cannot see.

Fifteen mutations were reverted one at a time and each proved a test red. Four survived
their first attempt and each produced a new test: guidance commit-scoping, the
orchestrator thread, the MAX_CONFLICT_ROUNDS bound, and the never-reset round counter.
The last two are the loop's only bound, so their tests carry a tripwire that fails by
name at round 13 rather than letting an unbounded loop hang the suite.
