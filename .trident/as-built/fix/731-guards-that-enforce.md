## Issue 731 — guards that enforce

### Built

The resolved-HEAD commit control is now enforceable in clones with the repository hooks installed. The versioned pre-commit hook runs `git rev-parse --verify HEAD` and refuses a failed, empty, or malformed answer before Git creates a commit (`.githooks/pre-commit:4`, `.githooks/pre-commit:6`, `.githooks/pre-commit:12`, `.githooks/pre-commit:17`). The installer already points Git at the versioned hook directory and now reports the new hook explicitly (`scripts/install-git-hooks.sh:71`, `scripts/install-git-hooks.sh:75`). The prompt continues to route Forge through the more diagnostic wrapper (`trident/inner-workflow.mjs:1686`), but interception no longer depends on that sentence when hooks are installed.

The real-Git test attempts `git commit` directly, after deleting the branch ref, and observes the hook refusal (`trident/commit-with-resolved-head-realgit.test.ts:59`). Its complement proves an ordinary direct commit still succeeds with the expected parent (`trident/commit-with-resolved-head-realgit.test.ts:71`). A refusing wrapper is also driven through the complete workflow body and reaches the existing `workflow-threw` terminal vocabulary (`trident/inner-workflow-gates.test.ts:120`, `trident/inner-workflow.mjs:9267`). That vocabulary is reporting rather than a retry grant; the workflow catch returns the failure and persists it through the terminal result writer (`trident/inner-workflow.mjs:9274`, `trident/inner-workflow.mjs:9279`).

The reaper now hands each candidate minted by gates 1–10 directly to the guarded destructive boundary (`trident/worktree-reaper.ts:1497`, `trident/worktree-reaper.ts:1501`). The boundary still refuses any value not minted for the same repository before spending the deletion budget (`trident/worktree-reaper.ts:1533`, `trident/worktree-reaper.ts:1538`). Production coverage proves the salvage write, deletion, retained candidate inventory, and absence of a keep reason (`trident/worktree-reaper.test.ts:2580`, `trident/worktree-reaper.test.ts:2596`, `trident/worktree-reaper.test.ts:2602`, `trident/worktree-reaper.test.ts:2605`). The complete call inventory was enumerated by matching `await deleteReapableRef(` in the whole module; the test requires exactly one production call and includes a matching positive control (`trident/worktree-reaper.test.ts:2740`, `trident/worktree-reaper.test.ts:2749`, `trident/worktree-reaper.test.ts:2752`).

### Prompt-only claims

G132 and G133 cannot be made into receiving-side refusals within this surface: they describe model tool use and output volume, not a value received by the workflow. Their inventory entries remain explicitly narrowed to instructions, including that G132 is not an independent refusal and that G133 is a resource precondition (`docs/trident-gates-inventory.md:222`, `docs/trident-gates-inventory.md:223`). G135 is now described with its exact installation boundary; without installed hooks, only the wrapper instruction remains (`docs/trident-gates-inventory.md:225`, `docs/trident-gates-inventory.md:296`).

### Mutation evidence

| Guard | Mutation and printed landing line | Mutated result | Restored result |
| --- | --- | --- | --- |
| Direct commit interception | `.githooks/pre-commit:9`, `exit 65` changed to `exit 0` | prompt-bypass test red: expected status 1, received 0 | 1 pass |
| Production reaper call | removed `await deleteReapableRef(...)` at `trident/worktree-reaper.ts:1501` | 4 red deletion/call assertions | 7 focused tests pass |
| Terminal classification | `trident/inner-workflow.mjs:9267`, `workflow-threw` changed to `unknown` | end-to-end wrapper test red: expected `workflow-threw`, received `unknown` | 1 pass |

The restored specific run passed 154 tests across `trident/commit-with-resolved-head-realgit.test.ts`, `trident/inner-workflow-gates.test.ts`, and `trident/worktree-reaper.test.ts`. The repository typecheck matrix passed all 51 configurations. The lint, type-query, void-promise, pre-swallow, console, wall-clock, dependency, keyboard, and diff-base gates all passed.

### Decisions and exclusions

The reaper keeps `refs_candidates` as a pre-write inventory because gates 11–14 can still refuse at deletion time (`trident/worktree-reaper.test.ts:2609`). Tests that need a late-arriving claimant restore the exact deleted ref and reuse the genuinely minted candidate before exercising the boundary; this preserves their ability to reach the recheck after production began deleting during the sweep.

No feature flag or alternate production path was added. The existing diagnostic wrapper was not removed because it distinguishes failed, empty, and malformed HEAD answers (`trident/commit-with-resolved-head.sh:12`, `trident/commit-with-resolved-head.sh:18`, `trident/commit-with-resolved-head.sh:23`). G132 and G133 were not relabeled as enforcement because the current code cannot intercept those behaviors (`docs/trident-gates-inventory.md:222`, `docs/trident-gates-inventory.md:223`). No spec decision changed.
