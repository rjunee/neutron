## 2026-09-14 — Release the reply listener during gateway shutdown (#786)

### Status and scope

Candidate fix; production root cause and deployment acceptance remain unverified.
The task-specific build-lane instructions require this staging path and a local
commit only. This record does not claim the issue is resolved.

### Change and evidence

The pool shutdown now calls `sink.stop()` after delivering shutdown reports
(`runtime/adapters/claude-code/persistent/pool.ts:1390`). The existing stop method
closes the HTTP server and clears its bound state
(`runtime/adapters/claude-code/persistent/pool-state.ts:408`). Keeping this release
in the pool owner covers its callers, including the gateway signal path
(`gateway/index.ts:1077`, `gateway/index.ts:1108`). The later gateway cleanup and
DB close remain after that call (`gateway/index.ts:1086`, `gateway/index.ts:1093`).

Before the change, enumerating `sink.stop` and `sink.ensureStarted` calls with
`rg -n 'sink\.stop\(|sink\.ensureStarted\('` across the persistent adapter found
production starts at `spawn.ts:81` and `boot-adoption.ts:2397`; stop matches were
in tests. The start matches are the search's positive control. This identifies
a cleanup gap by source inspection, not a measured explanation of the incident.

### Measurement and its limits

A subprocess probe started the real reply sink, called pool shutdown, and offered
an explicit sink-stop control. Both attempts failed before shutdown because socket
creation is prohibited in the build sandbox. A separate Python positive control
returned EPERM for both TCP and Unix socket creation. Bun's bind error must not be
interpreted as evidence of an occupied port.

The host-level test runs real host polling and an externally owned `sleep`
process, with scripted RPC. It observes poll completion and the same live PID
through two pool shutdown/reattach cycles
(`runtime/adapters/claude-code/persistent/__tests__/shutdown-sink.test.ts:42`).
It does not run a Claude REPL or a live pane server.

The gateway subprocess test uses the real gateway signal handler and reply
listener, checks normal exit and DB close, and repeats startup against the same
registry, port, and process (`gateway/__tests__/sigterm-survivor.test.ts:29`).
Its RPC boundary is scripted (`gateway/__tests__/fixtures/sigterm-survivor.ts:19`).
It remains unskipped, but cannot reach readiness here. Its exit and survival
assertions therefore have not been validated in this environment.

### Decisions and lifetime ownership

Use the existing listener stop operation after the pool's report drain. Do not
add a forced process exit: subsequent cleanup must still execute. The existing
survival vocabulary is `ShutdownSurvivalVerdict` with `survive` and `kill`
(`runtime/adapters/claude-code/persistent/gateway-shutdown-survival.ts:53`). This
change adds no verdict or default classification. The survivor path still detaches
its host wrapper (`runtime/adapters/claude-code/persistent/pool.ts:1190`).

The shutdown owner performs the listener release directly; it does not wait for
a surviving child to exit. This is a graceful-shutdown repair, not a new guarantee
that cleanup executes after a crash. No product decision was changed.

### Mutation evidence

| Property | Mutation and printed landing line | Mutated result | Restored result |
| --- | --- | --- | --- |
| Shutdown releases listener | Remove `sink.stop()` at `pool.ts:1394` | RED: expected one stop call, received zero | GREEN |
| Survivor is not killed | Replace detach with kill at `pool.ts:1190` | RED: pane closed was true | GREEN |
| Real gateway exits naturally | Remove listener release in subprocess test | Not exercised: socket creation denied before readiness | Not established |

The first two mutations ran against
`runtime/adapters/claude-code/persistent/__tests__/shutdown-sink.test.ts`; both
restored cases passed. The initial survival fixture used an invalid channel name;
it was corrected to the required schema before mutation runs
(`runtime/adapters/claude-code/persistent/repl-registry.ts:478`). Assertions were
not loosened.

### Deliberately outside this change

No deployment, push, PR, merge, live pane manipulation, process-exit workaround,
new backend, or change to the survival decision. A runner allowed to create local
sockets must run the gateway test and its release/kill mutations. The incident
still needs a live shutdown measurement and unchanged REPL PID across restart;
the scripted process tests are not substitutes for that proof.

### Validation results

- `bash scripts/ci/typecheck-all.sh`: all 51 discovered configurations passed.
- `bash scripts/ci/lint.sh` and ESLint on the changed TypeScript files: passed.
- `bun test runtime/adapters/claude-code/persistent/__tests__/shutdown-sink.test.ts`:
  2 passed, including both restored mutation cases.
- `bun test gateway/__tests__/sigterm-survivor.test.ts`: failed during sink startup;
  the socket restriction prevents reaching its acceptance assertions.
- Targeted existing `gateway-shutdown-survival.test.ts` and
  `shutdown-timer-cancellation.test.ts`: 32 passed, one setup failure at sink bind.
- `bash scripts/ci/leak-gate.sh --tree .`: exit 3, zero findings from executed
  rules; private denylist rules could not run because the denylist is unavailable.
- `git diff --check`: passed. The record has exactly one level-two heading.

No whole-suite run was attempted. The local checks are not all green, and the
candidate must not be represented as deployment-verified.
