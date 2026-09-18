## 2026-09-18 — Fresh retry composed regression

### What changed

The composed production-host end-to-end surface now recreates a prior publication with real local git: the retry worktree remains at its pinned base while the remote build branch and OPEN PR point at a different commit (`open/__tests__/project-build-e2e.test.ts:609-633`). The owned case then drives the existing fresh path through plan, build, review, host suite, republication onto the same PR, and merge, asserting branch movement, unchanged PR identity, durable provenance, the review flow, and the terminal outcome (`open/__tests__/project-build-e2e.test.ts:844-865`).

The complement gives that run a durable publication receipt naming a different PR. It asserts the existing admission refusal, no worker dispatch, no PR mutation, no remote-branch movement, and no persisted PR adoption (`open/__tests__/project-build-e2e.test.ts:867-878`). This joins no new outcome vocabulary: it pins the existing `blocked` outcome constructor, whose recipient defaults to the orchestrator (`trident/build-run.ts:223`), and the existing fresh-PR admission refusal (`trident/build-run.ts:271-272`).

### Why

The governing item requires every build-loop gate to survive composition (`docs/spec-items/the-orchestrator-owns-the-build-loop.md:56-59`) and a dispatched card to reach MERGED without human intervention (`docs/spec-items/the-orchestrator-owns-the-build-loop.md:64-66`). Checkpoint inheritance is narrower: only review-capable checkpoints on an unmoved tip carry (`docs/spec-items/a-retry-must-resume-from-the-checkpoint.md:13-18`), so a prior publication without such a checkpoint must still take the fresh path.

Before this change, the composed surface covered first publication and merge (`open/__tests__/project-build-e2e.test.ts:804-842`), while the different-head owned retry was simulated at the driver layer (`trident/build-run.test.ts:259-283`) and durable publication reuse was isolated at the production-effect layer (`trident/production-host-effects.test.ts:267-274`). This list was enumerated with `rg -n "published_pr"` across those three test files; the known effect-layer matches were the positive control and the composed file had no match.

### Decisions

The fixture's literal worker was unchanged. The setup creates the prior remote commit outside the retry worktree, keeping the mismatch observable by the real production measurement rather than encoding a matching worker claim (`open/__tests__/project-build-e2e.test.ts:614-633`). Git operations and branch state are real; only the fixture's existing GitHub API seam supplies PR records (`open/__tests__/project-build-e2e.test.ts:381-451`). The claim is therefore limited to the composed production host with real local git and fake GitHub.

No runtime or specification decision changed. No feature flag, alternate path, or checkpoint inheritance was added.

### Mutation evidence

| Guard | Mutation | RED | Restored GREEN |
|---|---|---|---|
| Owned fresh retry may start while the prior PR is at a different head (`trident/build-run.ts:269`) | Added `snapshot.pr.head === snapshot.head` to ownership | The owned-retry case received `blocked` instead of `merged` | Targeted fresh-retry run: 2 pass, 0 fail |
| Ownership requires the observed PR number to equal the durable receipt (`trident/build-run.ts:269`) | Replaced number equality with `input.owned_pr !== undefined` | The foreign-PR case advanced to publication instead of returning the admission refusal | Targeted fresh-retry run: 2 pass, 0 fail |

The exact mutated line was printed before each red run and restored to `snapshot.pr.number === input.owned_pr` before the green run.

### Verification

- `bun test open/__tests__/project-build-e2e.test.ts` — 37 pass, 0 fail, 240 assertions.
- `tsc -p tsconfig.json` — pass.
- `tsc -p trident/tsconfig.json` — pass.
- `bash scripts/ci/lint.sh` — pass, zero findings in every reported gate.

### Deliberately not done

No runtime repair was needed because the composed regression passed against the existing implementation. This change does not claim real GitHub coverage, does not close the broader build-loop item, and does not alter another change's as-built record.
