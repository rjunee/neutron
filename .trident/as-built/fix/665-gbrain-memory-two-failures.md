## 2026-09-14 — Make GBrain wiring tests independent of host installs

### Root cause and result

Both failures were test defects, not product-code defects. The command resolver checks the supplied `PATH` and then an ordered set of absolute install locations (`gbrain-memory/resolve-gbrain-command.ts:56-61`, `gbrain-memory/resolve-gbrain-command.ts:86-92`). On the failing box it legitimately resolved `/usr/local/bin/gbrain`, so the warning fixture had not established the absence it claimed and the spawn fixture launched a real persistent service.

The per-connect coherence test now supplies a controlled nonexistent absolute command (`gateway/wiring/__tests__/build-gbrain-memory.test.ts:918-926`). This preserves the real init-then-serve connection sequence while making the intended spawn failure immediate and independent of host state. The warning test now injects the existing resolver seam with a `null` verdict (`gateway/wiring/__tests__/build-gbrain-memory.test.ts:1067-1077`), directly constructing the missing-command precondition whose warning branch is selected at `gateway/wiring/build-gbrain-memory.ts:805-813`.

No new product outcome or invariant was introduced. The existing missing-command vocabulary remains the resolver's `string | null` result (`gbrain-memory/resolve-gbrain-command.ts:75-92`): `null` keeps the bare-command fail-soft runtime path and emits the boot warning (`gateway/wiring/build-gbrain-memory.ts:746-749`, `gateway/wiring/build-gbrain-memory.ts:805-813`), while an absolute nonexistent command exercises the client's existing binary-missing classification and latch (`gbrain-memory/gbrain-stdio-client.ts:193-224`). The test fixtures continuously maintain their own preconditions through the already-supported `resolveCommand` seam, independent of the host resolver.

### Decisions

I did not widen the 5000 ms timeout: the elapsed time was spent in the real service connection reached through the host install, whereas the controlled missing-command path completes in milliseconds. I used a nonexistent absolute command for the spawn case because a `null` resolver result intentionally retains the bare `gbrain` fallback (`gateway/wiring/build-gbrain-memory.ts:746-749`), which the transport can still resolve from its ambient environment (`gbrain-memory/gbrain-stdio-client.ts:193-197`). I used `null` for the warning-only case because that is the exact existing verdict that selects the warning (`gateway/wiring/build-gbrain-memory.ts:805-813`).

### Mutation evidence

| Guard | Mutation | RED | Restored GREEN |
|---|---|---|---|
| Controlled nonexistent command at `gateway/wiring/__tests__/build-gbrain-memory.test.ts:926` | Removed `resolveCommand`, reintroducing host resolution; the printed fixture showed `env: {}` followed directly by `resolveOpenAiKey` | Focused coherence test timed out at 5000 ms | Focused coherence test passed in 22 ms; full file passed |
| Forced `null` verdict at `gateway/wiring/__tests__/build-gbrain-memory.test.ts:1074` | Removed `resolveCommand`, reintroducing the absolute host probes; the printed fixture ended after the temporary `HOME`/`PATH` | Focused warning test failed because the `DISABLED` predicate received `false` | Focused warning test passed; full file passed |

The complete touched test file passed with 71 tests and 163 expectations. `bash scripts/ci/typecheck-all.sh` passed all 51 TypeScript projects, and `bash scripts/ci/lint.sh` passed every reported gate.

### Deliberately not changed

I did not change production resolution, spawning, warning behavior, timeouts, assertions, or specifications. The production resolver correctly found a supported absolute installation, and the issue required deterministic fixtures rather than a change to that behavior.
