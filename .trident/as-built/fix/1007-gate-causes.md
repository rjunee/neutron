## Issue 1007 — diagnosable unknown gate refusals

### What changed

Every gate catch that discarded a host exception now routes through `unknownCause`. The helper writes one `gate_host_observation_failed` journal event containing `run_id` and the full cause, then returns the existing `unknown` outcome with a cause-bearing detail capped by `TERMINAL_CAUSE_MAX` (`trident/gates/unknown-cause.ts:7-10`). The cap is the existing 500-character terminal-cause limit (`trident/inner-loop.ts:818-825`).

The gate catch sites are project admission (`trident/gates/project-admission.ts:75`), review suite (`trident/gates/review-suite.ts:51`), review CI (`trident/gates/review-ci.ts:39`), review artifact (`trident/gates/review-artifact.ts:26`), build claim (`trident/gates/build-claim.ts:38`), publication and remote-merge readiness (`trident/gates/release-readiness.ts:39,89`), local-merge readiness (`trident/merge.ts:1638-1660`), brief admission (`trident/build-host.ts:142-150`), and remote merge evidence persistence (`trident/production-host-effects.ts:394-402`). Run ids were threaded through existing composition calls; refusal conditions, ordering, and result kinds were not changed.

### Enumeration

The enumeration used a multiline `rg` over both `trident/gates/` and `trident/` for a catch followed by `unknown(` or `unknownCause(`, then a complete `rg -n "catch\\s*\\{" trident --glob '*.ts'` listing to inspect catches that formatting could hide. The pre-change search found the ten swallowing paths listed above. It also found the positive controls at `trident/project-observation-sources.ts:55,79`, where caught causes were already interpolated, and `trident/build-run.ts:554-556`, where a caught cause was already returned. Those controls were left alone. Other catches were left alone when they did not return an unknown refusal, or already retained the cause; `trident/gates/review-panel.ts:123` returns the separate infrastructure vocabulary and was outside this unknown-refusal change.

The filed review-suite citation moved from line 48 to `trident/gates/review-suite.ts:51`; the project-admission catch moved from line 74 to `trident/gates/project-admission.ts:75` after its import was added.

### Outcome vocabulary and invariant

These results remain members of `GateResult`/`SuiteAssessment`'s `unknown` vocabulary. Existing gate composition treats `unknown` as a refusal or deferral and does not convert it into allow; the new helper itself fixes `kind: 'unknown'` (`trident/gates/unknown-cause.ts:7-10`). No new verdict or state was introduced.

The maintained invariant is that a caught gate exception has two representations: bounded refusal detail and an uncapped journal record. `unknownCause` performs both synchronously at the catch boundary (`trident/gates/unknown-cause.ts:8-10`), so preservation does not depend on the throwing source recovering or on a downstream relay retaining the full detail.

### Tests and mutation proof

Focused tests supply a throwing source for every changed gate, assert the recognizable cause in `detail`, and assert `kind: 'unknown'`. Each suite also pins a normal refusal string exactly. The helper test proves the detail is exactly 500 characters at the cap while the single journal line retains the full cause and run id (`trident/gates/unknown-cause.test.ts:5-22`).

| Guard paths | Compiling mutation | RED | Restored GREEN |
|---|---|---:|---:|
| All ten catch paths plus shared cap/journal behavior | `trident/gates/unknown-cause.ts:10` changed from `` `${message}: ${cause}`.slice(...) `` to `message.slice(...)`; the landed line was printed before the run | 11 failed, 140 passed across 9 focused files | 168 passed, 0 failed, 804 expectations across 10 focused files |

The normal-refusal positive controls passed in the restored run, demonstrating their byte-identical strings remained unchanged. `bunx tsc -p trident/tsconfig.json --noEmit` also passed.

### Decisions and exclusions

One helper owns formatting, capping, and journaling so every gate cannot drift independently. The journal retains the uncapped `String(error)` because it is the diagnostic source of record; only the relayed detail uses the existing terminal cap. Error-level logging matches an unexpected host failure that forces refusal.

No refusal condition, ordering, or allow/blocked/unknown classification changed. No feature flag or alternate path was added. The orchestrator, open wiring, persistent runtime adapter, product specification, and current-target decisions were not changed.
