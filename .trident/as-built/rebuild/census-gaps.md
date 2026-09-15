## 2026-09-15 — Restore the three census gate properties

### Scope and decisions

Implemented G032, G100 and G140, the three conflicts specified for this lane. Read the second audit's conflict entries from the sibling audit worktree after `git show rebuild/gate-audit-2:...` failed to resolve the supplied branch. The task brief supplies the acceptance properties; no product decision was changed. Re-read `docs/process/work-tracking.md` before writing this record and used the task's explicit staging destination.

### G032 — Full local heads with a host-owned read budget

Local build and fix completion now receives at most three host measurement attempts before trusting its trailer (`trident/build-run.ts:263`, `trident/build-run.ts:265`). The existing full-OID predicate accepts 40 or 64 hexadecimal characters (`trident/build-run.ts:137`). An invalid or missing full head returns `unknown` naming the missing fact; an unreadable observation retains its detail (`trident/build-run.ts:268`, `trident/build-run.ts:272`). The check runs on every local build/fix completion, including the common fix path, before corroboration and downstream review (`trident/build-run.ts:284`). The worker cannot set the read count.

Certification: new local build/fix fixtures reject short, absent, empty and 39-character matching heads at exactly three reads (`trident/build-run.test.ts:754`), recover from two unreadable observations (`trident/build-run.test.ts:777`), and accept a full SHA-256 head (`trident/build-run.test.ts:830`). Retained certification `trident/inner-workflow-built-head.test.ts:169` and `trident/inner-workflow-built-head.test.ts:178` stays green: the complete file passed 37 tests.

This bounds attempts, not the duration of an individual injected host measurement. It does not ask the worker to attest to the measurement or enforce its own budget (`trident/build-run.ts:265`).

### G100 — Preserve before refusing a real disagreement

A differing hexadecimal build/fix claim invokes the host claim gate (`trident/build-run.ts:275`), composed from the host command runner and run-row branch (`trident/build-host.ts:75`). Git resolves the claim as a commit. Quiet resolution exit 1 treats a nonexistent commit claim as absent; other unsuccessful or malformed observations stay unknown (`trident/gates/build-claim.ts:15`). A matching resolved claim also allows the independently measured head (`trident/gates/build-claim.ts:19`). Diff and PR corroboration still follows head resolution (`trident/build-run.ts:282`, `trident/build-run.ts:284`). Non-hexadecimal malformed envelopes retain the existing corroboration refusal; this change handles commit claims, not arbitrary envelope repair (`trident/build-run.ts:277`).

For a real mismatch, the gate reads the remote reference, pushes the measured object with a lease against that observation, and reads a receipt before reporting a preserved conflict (`trident/gates/build-claim.ts:20`, `trident/gates/build-claim.ts:31`, `trident/gates/build-claim.ts:34`, `trident/gates/build-claim.ts:36`). An already matching remote observation supplies the receipt without another push (`trident/gates/build-claim.ts:29`). It never uses a moving local branch as the push source (`trident/gates/build-claim.ts:31`). This host sequence maintains preservation independently of the builder still working; it makes no guarantee against subsequent external branch deletion.

The driver awaits this gate before returning its existing `failed` / `built-head-unverified` outcome; missing sources and uncertain preservation use existing nonterminal `unknown` (`trident/build-run.ts:278`, `trident/build-run.ts:281`, `trident/build-run.ts:123`). This joins `BuildRunOutcome`, rather than creating a new terminal cause. The terminal-cause sentence vocabulary deliberately adds no generic sentence for `built-head-unverified`, preserving the supplied detail (`trident/terminal-cause.ts:247`, `trident/terminal-cause.ts:253`).

Certification: the driver test holds preservation pending and checks that neither build nor fix can finish the refusal first (`trident/build-run.test.ts:794`). The command test checks resolution/push/receipt order and exact leased object refspec (`trident/gates/build-claim.test.ts:19`). The composed host test uses a real local bare Git remote and verifies both remote and local branch survival (`trident/build-host.test.ts:619`). Retained certification at `trident/orchestrator.test.ts:3090` and `trident/orchestrator.test.ts:3116` stays green; the entire orchestrator test file passed 305 tests.

### G140 — Warning with acceptance

The panel now emits `panel-single-family` with `configuration-accepted=true`, then proceeds with its existing evidence checks (`trident/gates/review-panel.ts:75`, `trident/gates/review-panel.ts:79`). Enabled seats and the supplied builder contribute to the family set (`trident/gates/review-panel.ts:69`, `trident/gates/review-panel.ts:72`); the composed host supplies the builder identity (`trident/build-host.ts:122`). This follows the retained implementation's inclusion of the builder (`trident/inner-workflow.mjs:5336`). Family metadata comes from host configuration, otherwise the existing model registry, otherwise provider identity; the generic Pi transport uses model identity rather than equating every Pi model (`trident/gates/review-panel.ts:72`). Custom models sharing a family behind that transport can declare `family` (`trident/gates/review-panel.ts:12`).

The warning does not introduce an outcome: `ReviewDecision` still governs review and the existing successful panel returns `approve` (`trident/gates/review-panel.ts:112`). New certification asserts the warning and acceptance together, includes a different-family builder, ignores disabled seats, and covers identical models without metadata (`trident/gates/review-panel.test.ts:122`, `trident/gates/review-panel.test.ts:141`). Inventory G140 explicitly had **NO TEST** (`docs/trident-gates-inventory.md:234`); these are its new certifications.

### Mutation proof

Enumerated below are all 18 executed mutations. Each modified the printed production line, compiled and executed through `bun test`, and failed an assertion about the answer or effects. Each was restored immediately and the same selected test passed. No red result below was a syntax error or failed import. The command form was `bun test <test-file> -t '<test-title-prefix>'`. Tests were not skipped or relaxed.

| Guard / production line | Mutation | Selected test | Mutated → restored |
| --- | --- | --- | --- |
| G032 full head, `trident/build-run.ts:268` | Add `&& false` to invalid-head refusal | `trident/build-run.test.ts:754`, G032 local | RED failed vs unknown → GREEN |
| G032 upper budget, `trident/build-run.ts:265` | `attempt < 3` → `attempt < 4` | Same test | RED 4 reads vs 3 → GREEN |
| G032 recovery, `trident/build-run.ts:265` | `attempt < 3` → `attempt < 2` | `trident/build-run.test.ts:777`, G032 transient | RED unknown vs merged → GREEN |
| G100 driver refusal, `trident/build-run.ts:281` | Disable conflict stop with `&& false` | `trident/build-run.test.ts:794`, G100 waits | RED merged vs failed → GREEN |
| G100 preservation order, `trident/gates/build-claim.ts:29` | Return blocked with `branch preserved` before push | `trident/gates/build-claim.test.ts:19`, G100 resolves full | RED missing push/receipt commands → GREEN |
| G100 receipt, `trident/gates/build-claim.ts:34` | Disable receipt refusal | `trident/gates/build-claim.test.ts:35`, G100 unobserved | RED blocked vs unknown → GREEN |
| G100 push result, `trident/gates/build-claim.ts:32` | Disable push-result refusal | Same test | RED blocked vs unknown → GREEN |
| G100 measured head, `trident/gates/build-claim.ts:11` | Disable full-head refusal | `trident/gates/build-claim.test.ts:57`, G100 invalid | RED 5 host calls vs zero → GREEN |
| G100 branch, `trident/gates/build-claim.ts:14` | Disable reference refusal | Same test | RED allow vs unknown → GREEN |
| G100 absent claim, `trident/gates/build-claim.ts:17` | Disable absent-claim allowance | `trident/gates/build-claim.test.ts:27`, G100 same | RED unknown vs allow → GREEN |
| G100 resolution, `trident/gates/build-claim.ts:18` | Disable unreadable-resolution refusal | Same test | RED blocked vs unknown → GREEN |
| G100 equivalent claim, `trident/gates/build-claim.ts:19` | Disable equal-claim allowance | Same test | RED blocked vs allow → GREEN |
| G100 remote read, `trident/gates/build-claim.ts:21` | Disable unsuccessful-read refusal | `trident/gates/build-claim.test.ts:35`, G100 unobserved | RED blocked vs unknown → GREEN |
| G100 remote shape, `trident/gates/build-claim.ts:28` | Disable malformed-reference refusal | Same test | RED blocked vs unknown → GREEN |
| G140 acceptance, `trident/gates/review-panel.ts:76` | Replace warning with `return blocked('Single family refused')` | `trident/gates/review-panel.test.ts:122`, G140 | RED blocked vs approve → GREEN |
| G140 warning, `trident/gates/review-panel.ts:75` | Disable warning condition | Same test | RED missing warning → GREEN |
| G100 missing source, `trident/build-run.ts:278` | Disable explicit missing-source check | `trident/build-run.test.ts:816`, G100 missing | RED exception detail vs named missing source → GREEN |
| G100 uncertain receipt, `trident/build-run.ts:280` | Disable unknown stop | Same test | RED merged vs unknown → GREEN |

Two early mutation attempts stayed green because later checks masked the removed check: a failed push also produced a mismatching receipt, and malformed remote data remained malformed on the receipt read. The fixtures now isolate those facts: failed push plus a matching remote head, failed read carrying matching bytes, and malformed first read followed by a valid receipt (`trident/gates/build-claim.test.ts:39`, `trident/gates/build-claim.test.ts:42`, `trident/gates/build-claim.test.ts:43`). Re-running those landed mutations then produced the wrong outcomes shown above.

### Validation and limits

- `bun test trident/build-run.test.ts trident/build-host.test.ts trident/gates/`: 198 pass, 0 fail across 9 files. After the type-only fixture correction, the touched host file passed again: 42 pass.
- `bun test trident/inner-workflow-built-head.test.ts`: 37 pass, 0 fail.
- `bun test trident/orchestrator.test.ts`: 305 pass, 0 fail.
- `bun run typecheck` reports no such script. Used the repository's documented `bash scripts/ci/typecheck-all.sh` and scoped `bunx tsc --noEmit -p trident/tsconfig.json` instead: all 51 configurations and the final scoped check passed.
- `bash scripts/ci/lint.sh`: passed.
- `git diff --check`: passed.
- Public-tree leak scan: zero findings in executed rules, **INCOMPLETE** because the file and message PII denylists are unavailable. Do not treat this as a clean purity gate.

Deliberately did not modify the retained workflow, inner loop or review runner, the inventory's acceptance properties, product decisions, unrelated application directories, or historic as-built records. Did not run the full test suite. Did not push, open a PR, or merge. The local bare-remote test is the only Git publication performed as part of testing.
