## HOST5 — host publication and G084 extraction

### Change and decisions

The host now returns the extracted lineage verdict after mutation proof and publication readiness allow (`trident/build-host.ts:80`, `trident/build-host.ts:86`). The composer must supply the persisted `reviewed_head`, explicitly null for a fresh first round (`trident/build-host.ts:28`). This is a required typed observation, not a policy override.

G084 retains normalization and the exact full-width pattern (`trident/gates/fix-lineage.ts:9`). Null bypasses the observation (`trident/gates/fix-lineage.ts:8`); equality goes through git's ordinary ancestry check (`trident/gates/fix-lineage.ts:15`), certified against real git alongside descendants and siblings (`trident/gates/fix-lineage.test.ts:49`). The original operator messages are preserved in the extracted returns (`trident/gates/fix-lineage.ts:11`, `trident/gates/fix-lineage.ts:19`, `trident/gates/fix-lineage.ts:20`), with exact-message assertions (`trident/gates/fix-lineage.test.ts:21`, `trident/gates/fix-lineage.test.ts:29`, `trident/gates/fix-lineage.test.ts:35`). The outer publisher throws the returned refusal text at the same pre-replay point (`trident/orchestrator.ts:2565`).

The existing vocabulary is `GateResult` (`trident/build-run.ts:22`). Its consumer preserves blocked as an orchestrator-directed stop and unknown as uncertainty, allowing only allow to continue (`trident/build-run.ts:132`, `trident/build-run.ts:135`). To preserve G084 behavior, empty stderr on unsuccessful ancestry remains blocked; nonempty stderr remains unknown (`trident/gates/fix-lineage.ts:16`). Command exceptions become unknown with their original message (`trident/gates/fix-lineage.ts:23`). The outer publisher converts that result back to an Error (`trident/orchestrator.ts:2566`).

The host checks each publication attempt against the measured head (`trident/build-host.ts:86`); the driver checks the measurement again before invoking the publication effect (`trident/build-run.ts:326`). Enforcement runs in host control flow, independently of worker cooperation. The composer remains responsible for supplying the authoritative persisted pin (`trident/build-host.ts:28`). No product decision changed.

### Positive publication proof

A fresh first round with explicit null reaches allow and invokes the publication effect exactly once through `buildRun` (`trident/build-host.test.ts:305`, `trident/build-host.test.ts:327`, `trident/build-host.test.ts:333`). Admission, review, leak, mutation exemption and readiness use the host policies in this fixture (`trident/build-host.test.ts:307`, `trident/build-host.test.ts:310`, `trident/build-host.test.ts:314`). This is a local effect-spy proof, not a network publication: the fixture deliberately stops at the subsequent missing-PR observation (`trident/build-host.test.ts:329`).

Two previous assertions expected the deliberate lineage hold. They now require allow (`trident/build-host.test.ts:157`, `trident/build-host.test.ts:275`); dedicated refusals remain independently asserted (`trident/build-host.test.ts:336`).

### Validation and mutation table

- `bun test trident/build-host.test.ts trident/gates/*.test.ts`: 46 pass, zero fail across six files, enumerated by the explicit file plus shell glob.
- `bun test trident/orchestrator.test.ts --test-name-pattern 'FIX-ROUND ANCESTRY GATE'`: six pass, zero fail. This named describe group includes the three inventory certifications, now at `trident/orchestrator.test.ts:1548`, `trident/orchestrator.test.ts:1559`, and `trident/orchestrator.test.ts:1567`, plus descendant, null and equality controls. The inventory's older line numbers were resolved by searching the actual test names.
- `bun run typecheck`: script unavailable. `bunx tsc --noEmit -p trident/tsconfig.json`: exit 0 after correcting the new fixture's usage fields (`trident/build-host.test.ts:322`).
- `bash scripts/ci/lint.sh`: exit 0.

Each mutation below was applied alone; its changed source line was printed, `bun build <source> --target=bun --packages=external` compiled it successfully, and the named test ran with an assertion failure (exit 1). Restoration then passed (exit 0). No parse failure counted as RED.

| Guard / actual mutated line | Mutation | Test that turned RED | Restored |
| --- | --- | --- | --- |
| `trident/gates/fix-lineage.ts:11` | Return allow for short/malformed pin | short and malformed pins are blocked before git | GREEN |
| `trident/gates/fix-lineage.ts:19` | Return allow for non-descendant | non-descendant is blocked with the original message | GREEN |
| `trident/gates/fix-lineage.ts:20` | Return allow for unverifiable ancestry | unverifiable ancestry remains unknown with the original message | GREEN |
| `trident/gates/fix-lineage.ts:24` | Return allow for command exception | unverifiable ancestry remains unknown with the original message | GREEN |
| `trident/gates/fix-lineage.ts:8` | Return unknown for fresh null pin | fresh null reviewed_head reaches allow and publishes through the driver | GREEN |
| `trident/build-host.ts:86` | Replace lineage call with allow | host propagates G084 refusals after proof and readiness allow | GREEN |
| `trident/orchestrator.ts:2566` | Replace refusal condition with false | FIX-ROUND ANCESTRY GATE | GREEN |

### Scope and historical statements

Only the G084 import and extracted block changed in the outer publisher, as enumerated by `git diff -- trident/orchestrator.ts`. No driver, workflow, gateway or application restructuring was undertaken; no flags or alternative policy paths were introduced. Composer wiring and actual remote publication remain outside this lane.

A whole-tree content search for `Publication previous reviewed-head lineage could not be established` paired with the positive control `Publication branch does not contain the pinned launch base` found the latter at `trident/gates/release-readiness.ts:34` and `trident/build-host.test.ts:273`. A separate search including hidden records found the old hold in `.trident/as-built/rebuild/host-policies.md:60`, with related historical descriptions at lines 5, 22 and 32. That prior record stays immutable; this record supersedes its publication limitation. The record is placed here under the lane's explicit deliverable instruction, overriding the general as-built destination.
