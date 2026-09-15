## Issue #1001 — split the launch gates from the orchestrator

### What changed

The ordered pre-fire preparation block now lives in `trident/launch-preparation.ts:35`, and `trident/orchestrator.ts:2398` calls it before deriving reflection and test-strategy inputs. The move shortened `trident/orchestrator.ts` from 4,389 to 3,749 lines. No refusal text, check ordering, or runtime outcome vocabulary changed: preparation still returns the existing `AdvanceOutcome` shape on refusal (`trident/launch-preparation.ts:34`), whose failed rows continue through the existing failure and delivery handling by default.

The source-scanner inventory was enumerated with `rg` over tests and CI scripts for `readFileSync`, `Bun.file`, and `new URL` reads naming `orchestrator.ts`; the positive control found the scanners listed below. `trident/run-head-width.test.ts:10` had seven recognizers move and now follows them into the new module without lowering its count. `trident/diff-base-option-shaped.test.ts:875` had two `gitRangeArgv` consumers move and now scans and argues the new file too. Its negative assertion was mutation-checked by inserting an unshielded range at the new location: 0 pass / 1 fail, then 1 pass / 0 fail restored.

The scanners needing no change were `trident/mutation-prover.test.ts:59` (`STAGE_REASON_CEILING`: old 3, new 0), `trident/orchestrator.test.ts:1509` (`resolveClaimedCommit`: old 3, new 0), `gateway/__tests__/trident-phase-models-producer.test.ts:153` (the fire call remains old 1, new 0), and `gateway/__tests__/trident-active-runs-wiring.test.ts:63` (the fire call remains old 1, new 0). No CI shell script read the file as source; the same enumeration found the named test readers as its positive control.

### Gate relocation and mutation evidence

| Gate | Old line | New line | Existing covering test | Compiling wrong-answer mutation | Mutated | Restored |
|---|---:|---:|---|---|---:|---:|
| G013 | `trident/orchestrator.ts:2639` | `trident/launch-preparation.ts:288` | `trident/orchestrator.test.ts:9367` | Ignore the second failed fetch | 0 pass / 1 fail | 1 pass / 0 fail |
| G014 | `trident/orchestrator.ts:2489` | `trident/launch-preparation.ts:146` | `trident/orchestrator.test.ts:8380` | Disable seed falsification | 0 pass / 1 fail | 1 pass / 0 fail |
| G015 | `trident/orchestrator.ts:2560` | `trident/launch-preparation.ts:206` | `trident/orchestrator.test.ts:7605` | Disable the unreadable-head stop | 0 pass / 1 fail | 1 pass / 0 fail |
| G016 | `trident/orchestrator.ts:2949` | `trident/launch-preparation.ts:656` | `trident/orchestrator.test.ts:7878` | Disable the foreign-branch refusal | 0 pass / 1 fail | 1 pass / 0 fail |
| G017 | `trident/orchestrator.ts:2734` | `trident/launch-preparation.ts:420` | `trident/orchestrator.test.ts:7929` | Treat a shallow answer as complete | 0 pass / 1 fail | 1 pass / 0 fail |
| G018 | `trident/orchestrator.ts:3065` | `trident/launch-preparation.ts:694` | `trident/orchestrator.test.ts:345` | Disable empty-ID refusal | 0 pass / 1 fail | 1 pass / 0 fail |

The pre-move baseline was 308 pass / 0 fail with 2,670 assertions across `trident/orchestrator.test.ts` and `trident/gates-inventory-citations.test.ts`. After restoration, the complete touched-file validation was 585 pass / 0 fail with 3,232 assertions across four files, followed by a green `bunx tsc -p trident/tsconfig.json --noEmit`.

### Decisions and deliberate omissions

The boundary returns either the unchanged refusal outcome or the values the existing fire path already consumed (`trident/launch-preparation.ts:34`, `trident/orchestrator.ts:2424`). Helper operations owned by the orchestrator are injected at `trident/orchestrator.ts:2398`, avoiding a runtime import cycle while keeping their behavior in place.

I did not clean up comments, rename variables or refusals, alter the outcome taxonomy, touch the excluded workflow or adapter paths, or change product decisions. The scanner tests changed only because their subjects moved; behavioral tests remained unchanged.
