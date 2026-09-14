## 2026-09-14 — Detached-wrapper fixture discriminates detachment

### What changed

The regression fixture now launches its foreground Bash caller as a new process group and sends `SIGTERM` to that entire group after 50 ms (`trident/__tests__/cross-model-dispatch.test.ts:861-871`). Its backgrounded wrapper starts a separate session with `setsid`, so the wrapper survives the caller-group signal and writes the completion marker asserted by the test (`trident/__tests__/cross-model-dispatch.test.ts:866-880`).

This reproduces the relevant structure of the production command: the generated instruction launches its wrapper with `nohup setsid` and backgrounds it (`trident/inner-workflow.mjs:2229-2230`). The test continues to pin that command and its bounded-wait wording (`trident/__tests__/cross-model-dispatch.test.ts:882-888`).

### Cause and decisions

The former fixture used synchronous execution with a timeout, which signalled Bash without reaching the grandchild. The changed fixture imports the asynchronous process primitive needed to obtain the caller PID (`trident/__tests__/cross-model-dispatch.test.ts:28`), creates the caller group with `detached: true`, and signals that group through the negative PID (`trident/__tests__/cross-model-dispatch.test.ts:864-871`). This makes the wrapper's separate session load-bearing rather than illustrative.

The existing marker deadline and payload assertions were retained unchanged (`trident/__tests__/cross-model-dispatch.test.ts:872-880`). The continuously maintained invariant is the named regression test itself: removing the detachment prevents the marker from arriving and fails its existing assertion. This fixture-only change adds no product error, verdict, state, or refusal, so there is no outcome vocabulary to extend.

### Mutation proof

| Guard | Mutation and landing evidence | Broken result | Restored result |
|---|---|---|---|
| Detached wrapper leaves the caller's process group (`trident/__tests__/cross-model-dispatch.test.ts:866`) | Replaced the printed line 866 command `nohup setsid ... & wait` with foreground `sh -c ...` | Named test RED at the marker assertion on line 879 after 3.06 s: expected `true`, received `false` | Named test GREEN in 0.30 s; full touched file GREEN |

### Verification

- `bun test trident/__tests__/cross-model-dispatch.test.ts`: 67 pass, 0 fail, 375 assertions.
- `bash scripts/ci/lint.sh`: pass, including the wall-clock-bound gate.
- `bash scripts/ci/typecheck-all.sh`: all 51 TypeScript configurations passed.

### Deliberately not changed

Production dispatch was not changed: its detached launch remains at `trident/inner-workflow.mjs:2229-2230`, and its wait protocol remains at `trident/inner-workflow.mjs:2232`. No assertion in the touched test file was removed or loosened; the marker and generated-command assertions remain at `trident/__tests__/cross-model-dispatch.test.ts:879-888`. No specification decision changed.
