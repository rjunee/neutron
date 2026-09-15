## Issue #981 — built-head gate ownership

### Outcome

The extracted gate duplicated G032, so this change deletes `trident/gates/built-head.ts` and its duplicate-only test. Before deletion, the extracted implementation retried three times and accepted only a normalized full head at `trident/gates/built-head.ts:20-36`. The surviving driver performs an initial host measurement, retries until three observations have been made, and rejects a known non-full head at `trident/build-run.ts:318-328`; its full-OID predicate accepts 40- and 64-character object IDs at `trident/build-run.ts:154`.

The inventory row governing this property is G032. It now cites the surviving enforcement and behavioral pins at `docs/trident-gates-inventory.md:101`. Those pins cover both inventory requirements: bounded rejection for local build and fix at `trident/build-run.test.ts:1052-1073`, and recovery when the third observation succeeds at `trident/build-run.test.ts:1075-1090`.

### Reachability evidence

The reference set was completely enumerated with `grep -rn 'createBuiltHeadGate' --include='*.ts' . | grep -v node_modules`. Before deletion it found only the declaration at `trident/gates/built-head.ts:16` and calls in `trident/gates/built-head.test.ts:33`, `trident/gates/built-head.test.ts:40`, `trident/gates/built-head.test.ts:46`, and `trident/gates/built-head.test.ts:53`; after deletion it found no matches. The positive-control invocation used the same TypeScript scope and exclusions with `fixLineage`, finding production references including `trident/build-host.ts:7`, `trident/build-host.ts:116`, and `trident/orchestrator.ts:2565`, so the empty subject result is meaningful.

### Decisions

G032 has one owner: the host driver. Its retry is outside worker execution at `trident/build-run.ts:318-328`, and the driver comment explicitly assigns the read budget to the host at `trident/build-run.ts:320`. This continuously maintains the invariant without relying on a worker-reported head. Wiring the extracted gate would create a second implementation of the same three-read/full-head rule.

The rejection joins the existing `unknown` build outcome defined at `trident/build-run.ts:140` and constructed with the current phase and step identity at `trident/build-run.ts:168`. The default is therefore to stop the current path with preserved uncertainty; the measurement-unknown path uses the same outcome at `trident/build-run.ts:328`.

No product decision changed, so `SPEC.md` and its Decisions Log are unchanged. No new guard or outcome was added. I deliberately did not modify the production composition files named as out of scope; the mutation below was temporary and restored before the final diff.

### Mutation table

| Guard | Mutation | RED | Restored GREEN |
| --- | --- | --- | --- |
| Local build/fix three-observation guard at `trident/build-run.ts:319` | Changed the condition to `false && local && ...`; the printed source confirmed the mutation on line 319 | `bun test trident/build-run.test.ts -t G032`: 2 failed, 1 passed. The bounded refusal failed at `trident/build-run.test.ts:1067`; third-read recovery failed at `trident/build-run.test.ts:1087`. | Restored the original condition at `trident/build-run.ts:319`; the same command passed 3 tests with 0 failures. |

### Validation

- `bun test trident/gates/ trident/build-run.test.ts`: 238 passed, 0 failed.
- `bun test trident/build-run.test.ts -t G032`: 3 passed, 0 failed after restoration.
- `bunx tsc -p trident/tsconfig.json --noEmit`: recorded after the final source check.
