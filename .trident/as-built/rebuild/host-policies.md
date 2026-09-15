## Partial host release policies — admission and panel evidence blocked

### Delivery status

This is a partial HOST2 delivery, not the four-policy cutover. Admission still returns unknown at `trident/build-host.ts:70`; review still returns unknown without panel provenance at `trident/build-host.ts:79`; publication still returns unknown for missing previous-review lineage at `trident/build-host.ts:87`. The owner prohibited composition-contract changes. I interpreted that as including `BuildHostOptions`, whose fields are enumerated at `trident/build-host.ts:17`. A product decision is needed: identify the authoritative project/panel observation source available through this contract, or permit an observation extension. A worker trailer must not stand in for that source.

### Sources and inventory fates

| Requested gate | Existing implementation read | Delivered behavior and inventory coverage |
| --- | --- | --- |
| Admission | Fresh-branch ancestry: `trident/orchestrator.ts:4405`; prior-run ownership exception: `trident/orchestrator.ts:4428` and `trident/orchestrator.ts:4479`; shallow uncertainty: `trident/orchestrator.ts:4268` | Unchanged refusal. G016–G017 are keep-in-place (`docs/trident-gates-inventory.md:80`); prior-run ownership observations are not supplied by this host. Full project admission remains unresolved. |
| Review | Recorded approval provenance: `trident/orchestrator.ts:5228`; core-seat and configured peer measurements: `trident/inner-workflow.mjs:5339`; deferred-peer veto: `trident/inner-workflow.mjs:2498`; severity arithmetic: `trident/inner-workflow.mjs:2427` | Not re-homed. G104 is keep-in-place; G057–G062 are re-home-to-TS (`docs/trident-gates-inventory.md:131`). The current role request and verdict trailer do not constitute the configured panel or independent seat evidence. |
| Publication | Full local OID: `trident/orchestrator.ts:2535`; remote observation: `trident/orchestrator.ts:2595`; first-push launch ancestry: `trident/orchestrator.ts:2605` | Host wiring at `trident/build-host.ts:85`; observations at `trident/gates/release-readiness.ts:21`. G083 local-head portion, G085 and G086, all keep-in-place (`docs/trident-gates-inventory.md:167`). PR-only mode remains the driver check at `trident/build-run.ts:92`. |
| Merge | Full reviewed pin: `trident/merge.ts:1881`; actual PR base/head/repository: `trident/merge.ts:1909`; explicit fetch: `trident/merge.ts:1983`; file-backed size: `trident/merge.ts:214`; drift: `trident/merge.ts:2038`; atomic effect: `trident/merge.ts:2065` | Host wiring at `trident/build-host.ts:93`; eligibility at `trident/gates/release-readiness.ts:49`. G107 eligibility portion and G108 are keep-in-place (`docs/trident-gates-inventory.md:196`). The atomic merge remains an effect obligation, not a claim that an earlier observation makes the write atomic. |

### Decisions and limits

- Kept the old implementations in place as instructed. These are bounded readiness checks, not replacements for the old publication/replay and merge effects. The driver already delegates publication and merge effects (`trident/build-run.ts:55`).
- Re-measure local and remote branch state before publication; a first publication must contain the launch base (`trident/gates/release-readiness.ts:21`). Distinguish ancestry exit 1 (refusal) from inability to establish ancestry (unknown), at `trident/gates/release-readiness.ts:33`.
- Read the PR's actual base and branch rather than the configured default (`trident/gates/release-readiness.ts:54`). Refuse a foreign repository, refresh explicit remote refs, and compare the fetched head with the review pin (`trident/gates/release-readiness.ts:60`, `trident/gates/release-readiness.ts:68`, `trident/gates/release-readiness.ts:85`).
- Preserve the exemplar's complete diff measurement: file output and stat, using the existing range builder (`trident/gates/release-readiness.ts:75`). A missing output file is uncertainty, and a large file with short stdout still blocks (`trident/build-host.test.ts:253`).
- G084 fix lineage is not extracted: the old implementation consumes `run.reviewed_head` (`trident/orchestrator.ts:2564`), while the host mutation run is limited to id, slug, repository and branch (`trident/mutation-prover.ts:4046`). The host preserves unknown after the new readiness checks pass (`trident/build-host.ts:87`), so this missing policy never becomes publication permission.
- G098 lease enforcement and G099 post-push witness remain obligations of the publication effect; the existing implementations are `trident/orchestrator.ts:2719` and `trident/orchestrator.ts:2731`. This gate cannot enforce an atomic write by inspecting an arbitrary callback. Likewise G107's atomic write remains at `trident/merge.ts:2065` and is required of the merge effect by `trident/build-run.ts:195`.
- No provider or panel defaults were invented. The existing per-role provider selection remains at `trident/build-host.ts:44`. No decision in SPEC was changed.

### Outcome vocabulary and continuous enforcement

The new checks join the existing `GateResult` union, with allow, blocked and unknown (`trident/build-run.ts:21`). The driver's gate handler stops on blocked and preserves uncertainty on unknown (`trident/build-run.ts:86`); host exceptions also become unknown (`trident/build-run.ts:203`). No new error class relies on a generic catch default. Each invocation re-measures its evidence through the host runner; it does not depend on a worker producing a trustworthy claim. Atomic head enforcement still requires the merge effect's server-side pin, and base movement has no atomic server-side pin in the existing implementation (`trident/merge.ts:2059`). These checks do not promise crash recovery or full admission/panel enforcement.

### Tests and mutation evidence

The changed host tests are enumerated by `rg -n "test\(" trident/build-host.test.ts`. The old tests' merge expectations now use measured success controls; publication expects explicit lineage uncertainty (`trident/build-host.test.ts:156`, `trident/build-host.test.ts:173`); refusal assertions were retained, and the merge fixtures now provide an open PR. Admission/review expectations remain unchanged.

Every row below replaced the indicated refusal with `{ kind: 'allow' }` (or the equivalent const expression in the ancestry ternary), except the host wiring rows which replaced refusal forwarding, the lineage hold, or merge delegation with allow. Each mutation was applied alone, its actual source line printed, compiled and executed by Bun, produced assertion failures, and was restored before an independently green host run. Enumeration: every refusal return in the new gate module, including both ancestry outcomes and exception handlers, plus publication refusal forwarding, the publication lineage hold, and merge delegation. No mutation used a parse or type error as evidence.

| Guard location | Refusal / delegation mutated to allow | Test that went red | Mutated → restored |
| --- | --- | --- | --- |
| `trident/gates/release-readiness.ts:23` | `return unknown('Publication branch head could not be resolved')` | publication readiness measures local head, remote state and first-push ancestry | RED (exit 1) → GREEN (exit 0) |
| `trident/gates/release-readiness.ts:24` | `return blocked('Publication branch differs from reviewed head')` | publication readiness measures local head, remote state and first-push ancestry | RED (exit 1) → GREEN (exit 0) |
| `trident/gates/release-readiness.ts:26` | `return unknown('Publication remote branch state could not be read')` | publication readiness measures local head, remote state and first-push ancestry | RED (exit 1) → GREEN (exit 0) |
| `trident/gates/release-readiness.ts:29` | `return unknown('Publication remote branch observation is malformed')` | publication readiness measures local head, remote state and first-push ancestry | RED (exit 1) → GREEN (exit 0) |
| `trident/gates/release-readiness.ts:34` | `blocked('Publication branch does not contain the pinned launch base')` | publication readiness measures local head, remote state and first-push ancestry | RED (exit 1) → GREEN (exit 0) |
| `trident/gates/release-readiness.ts:35` | `unknown('Publication launch ancestry could not be established')` | publication readiness measures local head, remote state and first-push ancestry | RED (exit 1) → GREEN (exit 0) |
| `trident/gates/release-readiness.ts:38` | `return unknown('Publication host observation failed')` | publication readiness measures local head, remote state and first-push ancestry | RED (exit 1) → GREEN (exit 0) |
| `trident/gates/release-readiness.ts:50` | `return blocked('Merge requires a PR number and full reviewed head OID')` | merge eligibility refuses absent, malformed, closed or mismatched review pins | RED (exit 1) → GREEN (exit 0) |
| `trident/gates/release-readiness.ts:52` | `return blocked('Merge PR does not match the reviewed head')` | merge eligibility refuses absent, malformed, closed or mismatched review pins | RED (exit 1) → GREEN (exit 0) |
| `trident/gates/release-readiness.ts:55` | `return unknown('Merge PR refs could not be read')` | merge eligibility measures actual PR refs and rejects unreadable or foreign observations | RED (exit 1) → GREEN (exit 0) |
| `trident/gates/release-readiness.ts:58` | `return unknown('Merge PR head, base or repository identity could not be established')` | merge eligibility measures actual PR refs and rejects unreadable or foreign observations | RED (exit 1) → GREEN (exit 0) |
| `trident/gates/release-readiness.ts:60` | `return blocked('Merge head is in a different repository')` | merge eligibility measures actual PR refs and rejects unreadable or foreign observations | RED (exit 1) → GREEN (exit 0) |
| `trident/gates/release-readiness.ts:61` | `return blocked('Remote PR differs from reviewed head')` | merge eligibility measures actual PR refs and rejects unreadable or foreign observations | RED (exit 1) → GREEN (exit 0) |
| `trident/gates/release-readiness.ts:64` | `return unknown('Merge PR ref could not be validated')` | merge eligibility preserves refresh, size and fetched-head gates | RED (exit 1) → GREEN (exit 0) |
| `trident/gates/release-readiness.ts:69` | `return unknown('Merge PR refs could not be refreshed')` | merge eligibility preserves refresh, size and fetched-head gates | RED (exit 1) → GREEN (exit 0) |
| `trident/gates/release-readiness.ts:79` | `return unknown('Merge diff could not be read')` | merge eligibility preserves refresh, size and fetched-head gates | RED (exit 1) → GREEN (exit 0) |
| `trident/gates/release-readiness.ts:84` | `return unknown('Base drift could not be assessed')` | base drift preserves uncertainty and blocks overlapping changes | RED (exit 1) → GREEN (exit 0) |
| `trident/gates/release-readiness.ts:85` | `return blocked('Fetched PR head differs from reviewed head')` | merge eligibility preserves refresh, size and fetched-head gates | RED (exit 1) → GREEN (exit 0) |
| `trident/gates/release-readiness.ts:86` | `return blocked('Base drift overlaps reviewed changes')` | base drift preserves uncertainty and blocks overlapping changes | RED (exit 1) → GREEN (exit 0) |
| `trident/gates/release-readiness.ts:88` | `return unknown('Merge host observation could not be decoded')` | merge eligibility measures actual PR refs and rejects unreadable or foreign observations | RED (exit 1) → GREEN (exit 0) |
| `trident/gates/release-readiness.ts:82` | `return blocked(mergeDiffTooLargeReason(bytes))` | merge eligibility preserves refresh, size and fetched-head gates | RED (exit 1) → GREEN (exit 0) |
| `trident/build-host.ts:86` | `return readiness` | host publication readiness is reached after a measured prose exemption | RED (exit 1) → GREEN (exit 0) |
| `trident/build-host.ts:87` | `return unknown('Publication previous reviewed-head lineage could not be established')` | mutation proof blocks missing nomination and pins the reviewed head | RED (exit 1) → GREEN (exit 0) |
| `trident/build-host.ts:93` | `return pinnedMergeReadiness(options.mutation.run_host, options.mutation.run.repo_path, snapshot)` | base drift preserves uncertainty and blocks overlapping changes | RED (exit 1) → GREEN (exit 0) |

Admission and review have no new mutations because they remain blocked work. The full four-gate mutation requirement is not satisfied by this partial delivery.

### Validation

- `bun test trident/build-host.test.ts trident/merge.test.ts`: 123 passed, 0 failed, 438 assertions.
- Mutation runs: 24 of 24 red; each restored host run green (18 tests).
- `bun run typecheck`: command unavailable (no script). `bash scripts/ci/typecheck-all.sh` checked 51 configurations and failed only the untouched app configuration with TS2688 (missing type definition entry `@types`); the Trident and root configurations passed. This is recorded as a pre-existing environment failure outside the changed files, per the lane instructions.
- `bunx tsc --noEmit -p trident/tsconfig.json`: passed after the final code change.
- `bash scripts/ci/leak-gate.sh --tree .`: zero findings from executed rules; INCOMPLETE because the private PII denylist and corresponding message rule could not run. This is not a clean leak result.
- `bash scripts/ci/lint.sh`: passed all nine reported checks.

### Search evidence

Before writing this record, searched the whole working tree with `rg -n 'Complete publication readiness is not wired|Atomic pinned-head merge eligibility is not wired|Complete project admission policy is not wired' --glob '*.ts' --glob '*.md' .`. The positive control matched `trident/build-host.ts:70` and `trident/build-host.test.ts:120`; the removed publication and merge wording produced no hits. This is a working-tree content result, not a tracked-file absence claim.

For the contract gap, `rg -n 'provenance|admissionGate|observeCi|panel' trident/build-host.ts trident/build-run.ts` found the explicit `observeCi` observer at `trident/build-host.ts:27` as positive control, plus the panel obligation at `trident/build-run.ts:49`. The full option declaration was read at `trident/build-host.ts:17`; the snapshot declaration at `trident/build-run.ts:14`; and the closed verdict schema at `trident/gates/result-contract.ts:14`. This establishes the declared input gap, not absence of an admission policy elsewhere in the repository.
