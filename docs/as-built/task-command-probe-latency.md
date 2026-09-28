## 2026-09-28 — Stop the Tasks socket probe on either observed reply

Follow-up evidence for #1298 and
[`host-test-suite-efficiency`](../spec-items/host-test-suite-efficiency.md).
This change establishes a focused consumer-test saving, not a full-suite or
production latency improvement.

`open/__tests__/open-task-command-wiring.test.ts:278` now waits for either the
Tasks cheatsheet or the synthetic model reply. The `/taskfoo` negative control
intentionally reaches the model, so waiting only for a Tasks reply previously
spent the entire ten-second deadline after receiving its answer. Silence still
pays that deadline. The existing one-second claimed and 1.5-second unclaimed
settling windows remain (`:287`); both outcomes are read after settling (`:289`).
The two routing tests and their four assertions are unchanged (`:323`). No
production code, test selection, concurrency, timeout or dependency changes.

### Matched focused measurements

Baseline: `c3acc6b4760758a40e982380d19613a30ccd3a72`.
Candidate consumer-test Git blob: `f0c8c2abc6344455b52d71cafc4271a0a87a7ede`.
Same dependencies and command, two sequential runs per version, with no other
checks started by this change during measurement:

```sh
/usr/bin/time -f 'wall_seconds=%e' bun test open/__tests__/open-task-command-wiring.test.ts
```

| Version | Process wall seconds | `/taskfoo` case milliseconds | Result per run |
|---|---|---|---|
| Baseline | 14.90 / 14.90 | 11518.09 / 11523.09 | 2 pass, 0 fail, 4 assertions |
| Candidate | 4.96 / 5.03 | 1526.01 / 1525.01 | 2 pass, 0 fail, 4 assertions |

The focused file saves about 9.9 seconds. Its real composed WebSocket receiver,
database, mock-model path and independent routing assertions remain in use.

### Semantic controls and verification

Two temporary production mutations were tested against the candidate, each
producing an assertion failure rather than a parse or setup failure, then
restored:

- Bypass the Tasks receiver at `open/wiring/app-ws.ts:1088`: `/task help`
  fails its required claim assertion; `/taskfoo` still passes.
- Return a help command for a non-whitespace `/task` suffix at
  `cores/free/tasks/src/chat-commands.ts:64`: `/taskfoo` fails its forbidden
  claim assertion; `/task help` still passes.

After restoration, the socket consumer plus
`gateway/__tests__/tasks-core-chat-pick-next-composer.test.ts` and
`gateway/__tests__/tasks-chat-router-deep-link.test.ts` pass together: 17 tests,
79 assertions, zero failures. Root and Trident typechecks both exit zero:

```sh
bunx tsc --noEmit -p tsconfig.json
bunx tsc --noEmit -p trident/tsconfig.json
```

The complete partitioned host suite, required CI and any aggregate suite-lane
saving are not established by these focused checks. No deployment is involved.
