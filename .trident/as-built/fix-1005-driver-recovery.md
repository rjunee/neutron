## Driver recovery after a gateway restart

### What changed

- `trident/project-launcher.ts:6-37` stamps the pre-run `unknown` reservation with an in-process driver kind and a per-gateway session. A driver-authored measured `unknown` has no marker, so the two formerly identical states are distinguishable on the row.
- `trident/orchestrator.ts:3367-3413` recognizes only a reservation from a prior gateway. It resumes only after reading a durable branch, head, and checkpoint; otherwise it records a terminal refusal rather than replaying uncertain work. A measured driver `unknown` still reaches the existing waiting short-circuit.
- `trident/store.ts:1541-1558` atomically clears the exact reservation, releases the old driver slot, and increments the existing durable `crash_recoveries` budget. Its compare-and-swap predicate prevents a stale tick from clearing a completion.
- `gateway/composition/build-core-modules.ts:811-813` wires that claim into production.

### Decisions

- A gateway-session marker was selected over treating every `unknown` as recoverable: only the marker proves the value was written before an in-process promise began. The measured driver outcome remains reconciliation work and is not replayed.
- Recovery requires branch, checkpoint head, and checkpoint. A PR is read and passed through when present, but a branch can legitimately precede PR creation. Missing continuation evidence records terminal rather than starting fresh.
- The existing `crash_recoveries` counter remains the sole recovery budget. It is maintained continuously by the store's atomic claim and cannot be refunded by an ordinary run save.

### Evidence and tests

- `trident/liveness-death-e2e.test.ts:224-253` simulates the next tick after a gateway restart and proves one resumed launch carries `ralph-task-built`, the existing branch and PR, with one durable recovery spent.
- `trident/orchestrator.test.ts:447-513` proves a checkpointed continuation, terminal refusal for incomplete durable evidence, and terminal refusal at the crash budget.
- `trident/project-launcher.test.ts:64-78,143-153` proves driver-authored uncertainty remains pending while a prior-gateway reservation is recognizable.
- `gateway/__tests__/trident-crash-recovery-wiring.test.ts:21-41` pins the production composition callback.
- Green: `bun test trident/project-launcher.test.ts trident/orchestrator.test.ts trident/liveness-death-e2e.test.ts gateway/__tests__/trident-crash-recovery-wiring.test.ts` (324 passing); `bunx tsc -p trident/tsconfig.json --noEmit`; `git diff --check`.

### Mutation checks

| Guard | Mutation and line printed | Result | Restored result |
| --- | --- | --- | --- |
| Prior-gateway reservation discriminator | Replaced `driverReservation` with `return null` at `trident/project-launcher.ts:14` | RED: reservation mapping and restart-resume tests failed | GREEN: focused suites passed |
| Durable continuation requirement | Changed all three `&&` terms to `||` at `trident/orchestrator.ts:3372` | RED: uncheckpointed case fired once | GREEN: it terminated with zero fires |
| Durable crash budget | Changed `>=` to `>` at `trident/orchestrator.ts:3385` | RED: zero-budget case fired once | GREEN: it terminated with zero fires |

### Deliberately not changed

- No driver-authored `unknown` behavior was relaxed or converted into recovery.
- No detached-worker recovery, gate implementation, or persistent runtime adapter was changed.
- No `SPEC.md` decision changed: this implements the issue's stated durability requirement using its existing crash-recovery vocabulary and budget.
