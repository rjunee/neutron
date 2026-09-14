## 2026-09-14 — Explicit worker cwd and serialized Claude trust seeds (#751)

### Change and evidence

An absent or blank worker cwd is a programming error. It must not become the
service's working directory. `runtime/adapters/claude-code/persistent/spawn-configuration-error.ts:8`
validates it, `runtime/adapters/claude-code/persistent/spawn.ts:71` refuses before
starting the sink, and `runtime/adapters/claude-code/persistent/pool.ts:438`
refuses before looking up a warm session. The separate checks cover direct
respawns and ordinary turns; neither depends on Claude responding.
The validated value feeds trust at `runtime/adapters/claude-code/persistent/spawn.ts:330`
and the host at `runtime/adapters/claude-code/persistent/spawn.ts:413`.

The concrete caller defect repaired here is resume construction:
`runtime/adapters/claude-code/persistent/supervision.ts:175` validates the recorded
cwd, and `runtime/adapters/claude-code/persistent/supervision.ts:192` now also
passes that recorded cwd to the spawn. Previously it forwarded only the options
bag, which could omit cwd or describe a different directory. The missing-option
fixture is `runtime/adapters/claude-code/persistent/__tests__/worker-cwd.test.ts:83`.
This is evidence of a resume defect, not proof that this call created the
observed production workers. The supplied production cwd diagnosis is accepted;
this lane did not repeat that investigation.

Caller enumeration used repository-wide `rg` for `createPersistentReplSubstrate`,
`createClaudeCodeSubstrateAuto`, `buildLlmCallSubstrate`,
`spawnWithChannelWedgeRespawn`, and `getOrSpawnSession`, excluding test files for
production reads. Each search matched its definition as a positive control.
The worker construction chain supplies cwd at `open/wiring/substrates.ts:504`,
forwards it at `gateway/wiring/build-llm-call-substrate.ts:835`, and forwards the
normalized value at `runtime/adapters/claude-code/index.ts:451`. Direct persistent
factory construction is at `runtime/adapters/claude-code/index.ts:647` and replay
at `runtime/adapters/claude-code/persistent/pool.ts:196`. Spawn wrapper calls are
in `runtime/adapters/claude-code/persistent/pool.ts:350` and
`runtime/adapters/claude-code/persistent/spawn.ts:1548`.

Recovery now uses the session's actual cwd for the dropped-inbound record
(`runtime/adapters/claude-code/persistent/pool.ts:136`) and transcript recovery
(`runtime/adapters/claude-code/persistent/signatures.ts:566`). The legacy pool key
uses an empty missing-cwd slot instead of the service directory
(`runtime/adapters/claude-code/persistent/pool.ts:306`); start refuses that input.
Current default documentation was updated. A whole-tree search for
`pool's own documented default|The REPL still runs|defaults to process.cwd|CWD for the REPL`
finds only the positive control at `runtime/adapters/claude-code/persistent/types.ts:196`.
Historical descriptions explicitly describing the old behavior remain historical.

### Trust concurrency

`runtime/adapters/claude-code/persistent/ensure-claude-trust.ts:72` canonicalizes
the config directory. Its stable sidecar flock encloses the read, merge, and
rename at `runtime/adapters/claude-code/persistent/ensure-claude-trust.ts:77`.
Locking the replaced config inode would not protect the next writer, so the
sidecar remains in place. Failure to acquire refuses before the read at
`runtime/adapters/claude-code/persistent/ensure-claude-trust.ts:104`.
The existing helper was checked rather than copied blindly: it reports failure
but runs the callback unless that report throws
(`runtime/adapters/claude-code/persistent/registry-lock.ts:177`). It calls the
kernel flock at `runtime/adapters/claude-code/persistent/registry-lock.ts:170`
and releases/closes at `runtime/adapters/claude-code/persistent/registry-lock.ts:181`.
Kernel descriptor lifetime releases a crashed holder's lock; recovery does not
require a heartbeat or cleanup from the failed holder.

The established guarantee is exclusion among Neutron seed writers using this
sidecar. Claude itself is not demonstrated to participate in this lock protocol.
No claim is made that the seed race caused the production wedge.
The race fixture starts with 19,531 entries and pauses the first process after
its real config read while a second process enters the seed:
`runtime/adapters/claude-code/persistent/__tests__/ensure-claude-trust.test.ts:33`.
The restored implementation preserves both new entries and the old config;
the entire pre-change seeder loses the second entry.

### Error vocabulary and consumer defaults

Both missing cwd and refused trust-lock acquisition join `SubstrateErrorClass`
as `spawn_configuration`, registered nonretryable at `runtime/errors.ts:106`.
The producer stamps the error at
`runtime/adapters/claude-code/persistent/spawn-configuration-error.ts:5`;
`runtime/adapters/claude-code/persistent/classify-spawn-error.ts:99` recognizes
registered stamps. The pool emits the code and taxonomy retry hint at
`runtime/adapters/claude-code/persistent/pool.ts:455`. Unclassified errors would
instead default to retryable, so leaving this as an unstamped Error was rejected.

The bounded-spawn wrapper propagates non-wedge failures immediately
(`runtime/adapters/claude-code/persistent/channel-unbound-respawn.ts:69`).
Pooled spawn rejection removes its own entry and clears resume-in-flight state
(`runtime/adapters/claude-code/persistent/spawn.ts:1558`). Background resume
schedules that promise through `fireAndForget`
(`runtime/adapters/claude-code/persistent/supervision.ts:190`): its existing
default logs/counts the rejection (`logger/fire-and-forget.ts:132`), while the
synchronous resume result still means scheduled, not ready. This change does not
claim to change that asynchronous outcome contract.

The gateway's default for other stamped classes sets no credential cooldown
(`gateway/wiring/build-llm-call-substrate.ts:1093`). The code matrix includes the
new class at `gateway/wiring/__tests__/build-llm-call-substrate.test.ts:890`.
Text drains preserve code and retryability in `SubstrateCallError`
(`runtime/substrate-text.ts:147`). Direct Trident consumers retain their existing
error-event dispositions: launcher fails and cancels (`trident/inner-loop.ts:1105`),
resolver returns a question (`trident/conflict-resolver.ts:232`), arbiter reports
unavailable (`trident/arbiter.ts:267`), and leak fixer reports not fixed
(`trident/leak-fixer.ts:181`). The dispatch result vocabulary can carry this class
without a new switch (`agent-dispatch/service.ts:150`). These are the worker-path
consumers inspected, enumerated by taxonomy references and error-event branches;
this is not a claim to enumerate every application reader of an error event.

### Mutation evidence

Every mutation below printed the modified source line, failed its targeted test,
then passed the same test after restoring the source. No assertions were loosened.
Paths in the first six rows are under `runtime/adapters/claude-code/persistent/`.

| Guard or behavior | Mutation and landing line | Mutated | Restored |
| --- | --- | --- | --- |
| Spawn cwd boundary | `spawn.ts:71`: restore service-cwd fallback | RED, 3 failures | GREEN |
| Blank cwd refusal | `spawn-configuration-error.ts:9`: check undefined only | RED, 2 failures | GREEN |
| Supplied cwd reaches child | `spawn-configuration-error.ts:12`: return service cwd | RED | GREEN |
| Validate before pool lookup | `pool.ts:438`: remove validation | RED | GREEN |
| Resume forwards recorded cwd | `supervision.ts:192`: forward options only | RED | GREEN |
| Refuse an unacquired lock | `ensure-claude-trust.ts:104`: condition false | RED | GREEN |
| Serialize seed updates | Entire HEAD seeder restored; old read at line 76, rename at 96 | RED, second project absent | GREEN |
| Local configuration is nonretryable | `runtime/errors.ts:107`: retryable true | RED | GREEN |
| No credential cooldown | `gateway/wiring/build-llm-call-substrate.ts:1093`: map new class to 429 | RED | GREEN |
| Real-binary trust seed | `runtime/adapters/claude-code/persistent/ensure-claude-trust.ts:93`: acceptance false | RED, probe exit 1 | GREEN, probe exit 0 |

### Validation and limits

The six targeted files passed: 78 tests, 273 assertions. They are
`runtime/adapters/claude-code/persistent/__tests__/worker-cwd.test.ts`,
`runtime/adapters/claude-code/persistent/__tests__/ensure-claude-trust.test.ts`,
`runtime/__tests__/o3-substrate-error-codes.test.ts`,
`gateway/wiring/__tests__/build-llm-call-substrate.test.ts`,
`runtime/adapters/claude-code/persistent/__tests__/post-spawn-assertion.test.ts`,
and `runtime/adapters/claude-code/persistent/__tests__/classify-spawn-error.test.ts`.
The repository typecheck matrix passed all 51 configurations; repository lint passed.
Final runtime and gateway package typechecks also passed after the test updates.
The full test suite was not run, per lane instructions. The leak gate reports
INCOMPLETE (exit 3): zero findings in executed rules, but the private PII denylist
for file and message checks is unavailable. This is not a clean leak-gate result.

The cwd test mocks reply-sink startup and coordinates because this sandbox
refuses listening sockets; it executes a real subprocess at the host boundary
(`runtime/adapters/claude-code/persistent/__tests__/worker-cwd.test.ts:41`). It is
not a Claude end-to-end turn. The previous probe was preserved byte-for-byte from
caa9ae3e at `scripts/proof/claude-workspace-trust.py:1`. Its seed-only run against
Claude 2.1.270 reports matching process cwd, no trust dialog, and a REPL prompt.
It explicitly reports authenticated-turn proof as false
(`scripts/proof/claude-workspace-trust.py:74`). Authenticated usable-worker
acceptance remains unproven in this lane.

A worker that never announces channel readiness already has a host-driven
30-second budget (`runtime/adapters/claude-code/persistent/post-spawn-assertion.ts:100`),
returns no-channel-ready at the deadline
(`runtime/adapters/claude-code/persistent/post-spawn-assertion.ts:118`), and requests
child termination before throwing (`runtime/adapters/claude-code/persistent/spawn.ts:571`).
No new timer or claim about successful production termination was added.

### Deliberate exclusions and handoff

No home trust workaround, pruning, feature flag, alternate spawn path, or change
to product decisions was added. Retention of the 19,531-entry trust registry is a
separate issue. The previous issue draft is reused in the lane progress file,
with concurrency removed from its scope because this change addresses that part.
Filing needs the orchestrator's network access; it has not occurred in this
offline lane. An authenticated live worker check is also outstanding.

This record uses the explicitly requested `.trident/as-built/` staging location
instead of the repository standard's permanent shard location. No second record
or frozen-history edit is included. Delivery is a local commit only; the
orchestrator owns review, push, and PR creation.
