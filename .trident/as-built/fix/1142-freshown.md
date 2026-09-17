## 2026-09-17 — Admit fresh retries by publication provenance

### Change and evidence

Fresh admission accepts an OPEN PR when its number matches `owned_pr`, independent of the fresh checkout's head (`trident/build-run.ts:267-272`). A fresh checkout at base can therefore rebuild while its prior published PR still names the preceding output. The regression starts fresh with distinct heads, performs plan/build, republishes the same PR number, and reaches merge (`trident/build-run.test.ts:259-282`). The former moved-head refusal test asserted the defect and was replaced, while the original foreign refusal remains (`trident/build-run.test.ts:240-244`).

Ownership comes from durable `published_pr`, passed as `owned_pr` by `trident/project-build-host.ts:133` and carried from the card's prior run by `trident/board-dispatch.ts:1528`. New provenance is minted from the successful create receipt and persisted only after readback (`trident/production-host-effects.ts:384-396`). Readback validates branch, base, repository relationship and number (`trident/production-host-effects.ts:197-200`). A discovered PR without provenance is refused (`trident/production-host-effects.ts:392-393`). Thus admission head equality adds no protection against foreignness: matching code does not establish publication identity, while a prior owned publication need not match a newly cut base. The existing durable publication writer maintains ownership across worker failure without relying on that worker to remain alive.

Publication still checks OPEN state and reviewed head before persistence (`trident/production-host-effects.ts:395`). Before merge, `pinnedMergeReadiness` checks snapshot and remote heads (`trident/gates/release-readiness.ts:53`, `:62`), called at `trident/production-host-effects.ts:406`. The merge command pins the head atomically at `:424-425`, and the merged witness checks it at `:428`. Correction to the brief: the last comparison is after merge; the pre-merge comparison is in readiness. The checkpoint rule remains review-capable checkpoint plus recorded/live equality (`docs/spec-items/a-retry-must-resume-from-the-checkpoint.md:13-17`).

### Acceptance and outcome boundary

- Fresh OPEN owned PR at the previous build's head is admitted: `trident/build-run.test.ts:259`.
- Foreign PR with absent provenance is refused: `trident/build-run.test.ts:240`; a different nonempty provenance number is also refused for both equal and unequal heads at `:285`.
- Matching CLOSED PR is refused for both equal and unequal heads: `trident/build-run.test.ts:293`.
- MERGED is an outstanding wording conflict, not a claimed completed refusal: `trident/build-run.ts:260` returns terminal `merged` before admission, as explicitly required by the existing G036 regression (`trident/build-run.test.ts:1267`). The added matching-provenance case proves terminal success without plan/build, review or publication (`trident/build-run.test.ts:300`). The progress report escalates whether acceptance intends to replace that existing product contract. This change preserves it.

The refusal uses the existing `blocked/on` vocabulary (`trident/build-run.ts:38`, `:272`); terminal merge retains the existing `merged` result (`trident/build-run.ts:260`). This change adds no outcome requiring default classification.

### Mutation evidence

Each mutation was applied alone, the actual modified source lines were printed, the selected tests exited 1, then restoration of the shipped source made the same selection exit 0.

| Guard / binding | Mutation and printed line | RED | Restored GREEN |
| --- | --- | --- | --- |
| Provenance independent of head | Restore `&& snapshot.pr.head === snapshot.head`, `trident/build-run.ts:270` | Fresh base regression: 1 failure | 1 pass |
| Ownership distinction | Replace `snapshot.pr.number === input.owned_pr` with `true`, `trident/build-run.ts:269` | Original and two additional foreign regressions: 3 failures | 3 pass |
| OPEN required | Remove OPEN conjunct, `trident/build-run.ts:270` | Both closed-head cases: 2 failures | 2 pass |
| OPEN owned allowed | Invert OPEN comparison, `trident/build-run.ts:270` | Equal-head and fresh-base retries: 2 failures | 2 pass |
| Existing terminal merge contract | Remove initial confirmed-merge return, `trident/build-run.ts:260` | Owned merged case: 1 failure | 1 pass |

The fresh-base fixture initially failed after publication because its simulated review trailer retained the old PR head. Updating the trailer after simulated publication follows the existing fixture's behavior (`trident/build-run.test.ts:75-78`, `:274-277`); the merge and worker assertions were retained.

### Scope and documentation audit

Only admission and its tests change. Receipt parsing, provenance storage and carry, checkpoint policy, publication, merge and local-mode admission were deliberately left as they were. No product decision in SPEC.md or a spec item was rewritten; changing G036 remains escalated. The single record uses the explicitly requested lane staging path rather than the general docs/as-built destination.

The documentation audit enumerated Markdown using `rg -n --hidden -g '!.git' -g '!node_modules' -g '*.md' 'ownsMeasuredPr|same-head PR|head equality' .`. Positive control: `.trident/as-built/fix/1142-published-pr-provenance.md:62` matched `ownsMeasuredPr`. That record's `:44` describes a historical same-head reproduction and stays immutable. Other hits concern resume equality (`.trident/as-built/fix-1061-auto191813.md:7`, `.trident/as-built/rebuild/driver-modes.md:48`, `docs/SYSTEM-OVERVIEW.md:6720`), which this change does not alter.

### Validation

The requested consuming set was run explicitly: `bun test trident/build-run.test.ts trident/board-dispatch.test.ts trident/project-build-host.test.ts trident/production-host-effects.test.ts open/__tests__/project-build-e2e.test.ts` — **408 pass, 0 fail**, five files. The full build-run file separately passed **194 tests**. No whole-suite run was performed.

Both `node_modules/.bin/tsc -p tsconfig.json` and `node_modules/.bin/tsc -p trident/tsconfig.json` exited 0. `bash scripts/ci/lint.sh` exited 0 across its checks. `git diff --check` passed. Mutation results above are observed failures and restorations, not inferred coverage.

The public-tree leak gate exited **3 (INCOMPLETE)**: zero findings from runnable rules, but the private PII denylist and message-denylist rules could not run because their input was unavailable. This is not a clean leak-gate result. A separate added-byte check found none of the lane-prohibited text, and the record has exactly one `## ` heading.
