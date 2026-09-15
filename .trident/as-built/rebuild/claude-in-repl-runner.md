## 2026-09-15 — Claude bounded work inside the project REPL

### Change and evidence

Implements `WorkerRunner` with provider `anthropic` and in-REPL placement
(`runtime/workers/claude-in-repl.ts:22`). The project conversation's existing
composition method is injected structurally (`runtime/workers/claude-in-repl.ts:14`);
its production signature and queue are at
`gateway/wiring/build-live-agent-turn.ts:1066`. This avoids a runtime import of the
gateway package. Adds exactly one tool name, `Task`, to the constant live surface
(`gateway/wiring/build-live-agent-turn.ts:349`). The supplied CLI-name and idle-wait
probe results were accepted; neither probe was repeated.

The dispatch requests one background `Agent` with explicit `model: req.model_id`
(`runtime/workers/claude-in-repl.ts:55`) and sets the composing turn's
`model_preference` independently (`runtime/workers/claude-in-repl.ts:69`). The base
project spec preserves the caller's tool definitions and metering scope
(`runtime/workers/claude-in-repl.ts:68`). The brief stays on disk; its path and the
bounded request are forwarded as data (`runtime/workers/claude-in-repl.ts:59`).

The worker is instructed to write the trailer directly using its harness file tool,
with temporary-file/rename publication (`runtime/workers/claude-in-repl.ts:61`).
The host reads file bytes and passes them to its required schema/identity decoder
(`runtime/workers/claude-in-repl.ts:85`). Outcome metadata is the decoder's
responsibility (`runtime/workers/claude-in-repl.ts:15`); the runner does not derive
usage or reported model from a conversational reply. The test writes a real file
and supplies a contradictory reply (`runtime/workers/claude-in-repl.test.ts:52`);
completed metadata is exercised separately (`runtime/workers/claude-in-repl.test.ts:150`).

### Decisions and maintained invariants

- Follow the locked same-provider placement decision in
  `docs/plans/harness-orchestrator-pivot-2026-09-11.md:101` and the narrow turn seam
  at `docs/plans/harness-orchestrator-pivot-2026-09-11.md:168`. This change does not
  change a product decision or acceptance criterion.
- Reserve a step before dispatch using an exclusive file creation in a host-owned,
  durable directory. The key hashes the run/step tuple, independent of trailer
  path (`runtime/workers/claude-in-repl.ts:38`); a changed request is unknown and an
  identical retry only observes (`runtime/workers/claude-in-repl.ts:43`). The host
  retains this directory for the run's lifetime (`runtime/workers/claude-in-repl.ts:10`).
  The marker survives runner replacement and does not require the worker to report
  its own dispatch state. A crash after reservation but before dispatch conservatively
  leaves an unknown step for host reconciliation; it does not authorize a replay.
- Bound the composing-turn wait with the host budget and signal
  (`runtime/workers/claude-in-repl.ts:74`), then poll the trailer within that budget
  (`runtime/workers/claude-in-repl.ts:83`). Cancellation/timeout is an observation
  stop, not proof of worker termination (`runtime/workers/claude-in-repl.ts:95`).
- Join the existing `BoundedWorkOutcome` vocabulary
  (`runtime/bounded-work.ts:97`): unavailable placement is `refused` with
  `placement-unavailable`; uncertain dispatch/read/validation is `unknown`.
  No new outcome tag is introduced. Liveness uses the existing three-value
  vocabulary (`runtime/bounded-work.ts:139`); missing or throwing probes produce
  `unknown` (`runtime/workers/claude-in-repl.ts:102`). In the existing evidence
  decision, unknown defers reaping when no recent activity was observed
  (`trident/run-evidence.ts:97`). This runner does not install that watchdog.

### Mutation evidence

Enumerated below are all 17 mutations executed for this change. Each was applied
alone, its landed line and unified diff recorded before running the focused test
file, and restored before the next mutation. Every mutant also passed Bun's source
compilation; the failures below are behavioral assertions or the explicitly tested
observation deadline, not parser failures. Every restored run passed all 24 tests.
Line numbers refer to the restored source. Test references are in
`runtime/workers/claude-in-repl.test.ts`.

| Guard and source line | Mutation | RED witness | Restored |
|---|---|---|---|
| Subagent model, `runtime/workers/claude-in-repl.ts:55` | Delete `model` argument | Model assertions, tests at :52 and :74 | 24 GREEN |
| Dispatch turn model, `runtime/workers/claude-in-repl.ts:69` | Delete override | Dispatch preference assertion, :52 | 24 GREEN |
| Blind probe, `runtime/workers/claude-in-repl.ts:102` | Default to `nothing` | Blind liveness, :227 | 24 GREEN |
| Throwing probe, `runtime/workers/claude-in-repl.ts:104` | Catch returns `nothing` | Throwing liveness, :227 | 24 GREEN |
| Placement, `runtime/workers/claude-in-repl.ts:23` | Accept headless instead | Placement assertions, :171 | 24 GREEN |
| Run admission, `runtime/workers/claude-in-repl.ts:32` | Delete refusal return | Headless run assertion, :171 | 24 GREEN |
| Initial budget/cancellation, `runtime/workers/claude-in-repl.ts:34` | Delete check | Reservation unexpectedly created, :181 and :206 | 24 GREEN |
| Cancellation after reservation, `runtime/workers/claude-in-repl.ts:51` | Delete check | Unexpected dispatch, :197 | 24 GREEN |
| Stable step key, `runtime/workers/claude-in-repl.ts:39` | Key reservation by trailer path | Changed path redispatches, :128 | 24 GREEN |
| Exclusive reservation, `runtime/workers/claude-in-repl.ts:43` | `wx` becomes `w` | Retry dispatch count, :103 | 24 GREEN |
| Request identity, `runtime/workers/claude-in-repl.ts:45` | Condition becomes false | Wrong request accepted, :112 | 24 GREEN |
| Retry deduplication, `runtime/workers/claude-in-repl.ts:48` | Set dispatch true | Retry dispatch count, :103 | 24 GREEN |
| File input, `runtime/workers/claude-in-repl.ts:85` | Replace read with `{}` bytes | File result assertions, :52 and :150 | 24 GREEN |
| Invalid trailer, `runtime/workers/claude-in-repl.ts:87` | Invert ENOENT condition | Validation and delayed-file assertions, :144 and :92 | 24 GREEN |
| Observation cancellation, `runtime/workers/claude-in-repl.ts:83` | Remove signal condition | Cancelled observation accepts trailer, :190 | 24 GREEN |
| Dispatch deadline, `runtime/workers/claude-in-repl.ts:77` | Deadline promise never settles | Bounded-dispatch test times out, :213 | 24 GREEN |
| CLI tool grant, `gateway/wiring/build-live-agent-turn.ts:349` | Remove `Task` | Tool-surface assertion, :241 | 24 GREEN |

The cancellation-during-observation fixture includes an actual valid trailer
(`runtime/workers/claude-in-repl.test.ts:190`), so removing its guard can accept a
result. The initial cancellation test checks that no reservation was created
(`runtime/workers/claude-in-repl.test.ts:181`), preventing the later cancellation
check from masking its mutation.

### Validation

- `bun test runtime/workers/claude-in-repl.test.ts`: 24 passed, zero failed.
- `bunx tsc --noEmit -p runtime/tsconfig.json`: passed on final restored source.
- `bash scripts/ci/lint.sh`: passed.
- `bun run typecheck`: unavailable. The positive-control search
  `rg -n '"typecheck"|"test:bun"' package.json` finds `test:bun` at `package.json:61`
  and no typecheck script. Used the documented matrix (`CONTRIBUTING.md:79`).
- `bash scripts/ci/typecheck-all.sh`: 51 configurations enumerated by that script;
  46 passed, five failed: app, gateway, logger, onboarding, and root. Diagnostics:
  app cannot resolve the implicit `@types` definition; typed-array mismatch at
  `gateway/transcription/__tests__/whisper-install.test.ts:186`; event overload at
  `logger/__tests__/fire-and-forget.test.ts:301`; missing `crc32` type export at
  `onboarding/history-import/__tests__/zip-writer.ts:10`. These files were not edited.
  The matrix is not green; no test or check was weakened to hide it.
- `bash scripts/ci/leak-gate.sh --tree .`: exit 3, incomplete. Zero findings from
  available rules; the private denylist and message-denylist checks could not run.
- Staged scope enumerated with `git diff --cached --name-only`: this record,
  the runner, its test, and the single live tool-surface edit. The record has
  exactly one `## ` heading; `git diff --cached --check` passes.

### Deliberate limits and handoff

Production assembly must supply the existing conversation method, the project's
spec/topic, an existing durable state directory and the host's schema/identity
validator with measured metadata (`runtime/workers/claude-in-repl.ts:8`). The
focused tests simulate the harness file write and conversation call; they do not
claim a live Claude execution. The trailer payload is worker-authored through a
file tool, not a deterministic harness completion hook. Tool/write/network limits
are forwarded as instructions (`runtime/workers/claude-in-repl.ts:60`), not new
sandbox enforcement. These distinctions matter when binding the host decoder.

An already-enqueued composition cannot be cancelled through the existing
three-argument composition interface (`gateway/wiring/build-live-agent-turn.ts:839`).
An expired wait therefore remains unknown and the durable reservation prevents
blind redispatch. This change does not install a worker kill mechanism.

Did not rebuild the idle gate, introduce a headless Claude process, wire the build
loop, change schemas or model policy, or modify other lanes. The one-heading record
is placed under `.trident/as-built/` as explicitly required by this lane's brief,
overriding the general record-path convention. Delivery is a local commit only;
publishing and review belong to the orchestrator.
