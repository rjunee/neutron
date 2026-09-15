## Issue 1014 — usage probe outcome logging

### What changed

The credential usage monitor now emits one event when the probe outcome changes. The existing four-case probe taxonomy is consumed exhaustively at `open/credential-usage-monitor.ts:255-294`, and its logging switch names success, a response without windows, credential rejection, and transient failure separately at `open/credential-usage-monitor.ts:297-317`. Success carries `measured_at`; rejection carries HTTP status; transient failure carries a fixed cause rather than the probe's exception text. The logger is injectable at `open/credential-usage-monitor.ts:106-137`, so the test drives the production formatting path without intercepting process-global output.

Standing is still recorded before its observer runs, and now emits `credential_standing_changed` only when the three-valued standing changes at `open/credential-usage-monitor.ts:350-370`. The previous outcome is maintained in monitor-owned memory at `open/credential-usage-monitor.ts:167-176`; neither suppression mechanism depends on the probe or observer remaining operational after it returns an outcome.

An expired successful reading now returns `reading_aged_out` at `open/credential-usage-monitor.ts:210-217`, distinct from the initial `not_measured_yet` state and the live `probe_failed` outcome. The shared vocabulary owns that value at `contracts/credential-usage.ts:29-43`, and its two intentionally mirrored client unions include it at `landing/chat-react/usage-client.ts:18-37` and `app/lib/usage-client.ts:23-40`. By default the new value remains unavailable: both renderers branch only on `available` and pass null fractions at `landing/chat-react/UsageMeter.tsx:70-75` and `app/components/UsageMeter.tsx:62-67`, preserving the plain divider rather than displaying stale utilization.

### Decisions

Outcome logs are edge-triggered by outcome kind, while standing logs are edge-triggered by standing value. This makes an `ok` to `no-windows` change observable even though both map to `healthy`, while a steady successful poll does not add a line every minute. The tests demonstrate the four distinct events at `open/__tests__/credential-usage-monitor.test.ts:183-217` and the steady/change behavior at `open/__tests__/credential-usage-monitor.test.ts:219-239`.

No credential material, response body, or probe exception message is logged by the new outcome events. The adversarial fixture places the token value inside the probe error text and verifies that it is absent from every captured line at `open/__tests__/credential-usage-monitor.test.ts:208-217`.

The filed issue cited `open/credential-usage-monitor.ts:204-211` and `open/credential-usage-monitor.ts:218-222`; both citations were current before this change. One factual correction was required: the filed statement that aged-out, probe-failed, and never-read reasons already existed separately in the type was not true of the base tree. The base contract enumerated only four reasons at the then-current `contracts/credential-usage.ts:29-41`, and `snapshot()` explicitly mapped age-out to `probe_failed`; this change adds the missing vocabulary member and tests all three states at `open/__tests__/credential-usage-monitor.test.ts:153-181`.

### Mutation table

| Guard or distinction | Compiling mutation | Red proof | Restored proof |
|---|---|---|---|
| Rejection and transient failure have different events, `open/credential-usage-monitor.ts:308-315` | Changed the rejection event to `usage_probe_failed`; the mutation landed on line 309 | Focused file: 1 failure, 22 passes; the rejection-event assertion received no matching line | Focused file: 24 passes, 0 failures |
| Outcome edge suppression, `open/credential-usage-monitor.ts:298-300` | Inverted equality; the mutation landed on line 299 | Focused file: 4 failures, 19 passes; all first-outcome event assertions received no line | Focused file: 24 passes, 0 failures |
| Standing transition suppression, `open/credential-usage-monitor.ts:354-361` | Inverted inequality; the mutation landed on line 356 | Focused file: 1 failure, 22 passes; the second identical tick added a line | Focused file: 24 passes, 0 failures |

Final validation ran `bun test open/__tests__/credential-usage-monitor.test.ts`: 24 tests passed, 0 failed, with 35 assertions. `bunx tsc -p open/tsconfig.json --noEmit` passed. `bash scripts/ci/lint.sh` passed every reported gate, and `git diff --check` passed.

The local leak gate reported zero findings from every rule it could run, but exited incomplete because this environment does not provide the external owner-PII denylist. The changed-file vocabulary scan used `usage_probe_ok` as its positive control and found no forbidden vocabulary hit.

### Deliberately not done

The polling interval and freshness ceiling remain `60_000` and `5 * 60_000` at `open/credential-usage-monitor.ts:58-70`. No stale reading is served: the freshness branch and explicit age-out branch remain at `open/credential-usage-monitor.ts:210-217`. The probe request, UI layout, wiring, runtime adapters, and all files under `trident/` were left unchanged. `SPEC.md` was not changed because this adds observability and corrects an unavailable-reason conflation without changing a product decision.
