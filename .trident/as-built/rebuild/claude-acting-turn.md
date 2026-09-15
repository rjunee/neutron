## 2026-09-15 — WIRE7 Claude acting turn: not implemented

### Delivery status

This lane did not deliver the requested implementation or new tests. It is not
ready for composition. This record is an incomplete investigation and baseline
validation report, not evidence that the Claude acceptance criteria passed.
The contract remains the specification (runtime/workers/project-runners.ts:17).

I read the preceding investigation from the sibling lane's checkout after
`git show rebuild/project-acting-turn:.trident/as-built/rebuild/project-acting-turn.md`
failed with an invalid object name. I did not fetch a ref or use the network.
The reads below are evidence from this build worktree, not fetched-ref claims.

### Completion: a Stop invocation is also insufficient

I did not establish or implement the required final native turn-end signal.
In particular, adding an unconditional notification to the existing Stop hook
would not meet the contract: the hook can return `decision: 'block'` after a reply
promising further work (runtime/adapters/claude-code/persistent/hooks/enforce-reply.ts:357),
and can block a channel turn without a reply
(runtime/adapters/claude-code/persistent/hooks/enforce-reply.ts:381).
The settings writer installs that hook under `Stop`
(runtime/adapters/claude-code/persistent/build-settings.ts:122).
Observing an attempt to stop therefore does not establish that the turn ended.

The three explicitly insufficient observations remain insufficient here:

- **Acceptance:** acknowledged submission awaits text and Enter RPCs, ending
  after the Enter acknowledgement
  (runtime/adapters/claude-code/persistent/herdr-host.ts:654).
- **Empty output:** the generic Claude bridge accepts reply text and immediately
  emits a token and completion, closes the channel and settles the turn
  (runtime/adapters/claude-code/persistent/repl-session.ts:404). That is reply
  delivery, including empty text, not observation of a later native turn end.
- **Exit zero:** the herdr backend has no process exit codes; its exit promise
  resolves null (runtime/adapters/claude-code/persistent/herdr-host.ts:46).
  Process termination also does not identify a particular dispatch turn's end.

The transport should still be reused: `herdrCall` owns connection state per call
and closes the connection at settlement
(runtime/adapters/claude-code/persistent/herdr-client.ts:358;
runtime/adapters/claude-code/persistent/herdr-client.ts:381).
The acknowledged host operation checks terminal state inside its queue before
sending text and Enter in order
(runtime/adapters/claude-code/persistent/herdr-host.ts:651).
I did not add a transport or dispatch operation.

### Enforcement and exact session

I did not implement pre-dispatch grants, model or effort enforcement, or exact
project-session binding. The existing runner names `general-purpose`, passes
the requested model, and places the request and grant instructions in its prompt
(runtime/workers/claude-in-repl.ts:52). Its dispatch spec selects that model
(runtime/workers/claude-in-repl.ts:67).

Native launch configuration can set tools, restricted mode, effort and model
(runtime/adapters/claude-code/persistent/build-repl-argv.ts:150;
runtime/adapters/claude-code/persistent/build-repl-argv.ts:164;
runtime/adapters/claude-code/persistent/build-repl-argv.ts:177).
The settings writer can emit a permissions block
(runtime/adapters/claude-code/persistent/build-settings.ts:175).
These launch primitives alone are not evidence of this request's enforcement
inside the existing project conversation. I did not bind them to the request
or deliver a continuously maintained invariant. I also did not substitute
callbacks that would leave these requirements for the next lane to implement.

This is not a finding that the contract is wrong or impossible. I did not
complete the engineering work. No product decision or permission is requested.

### Uncertainty and refusal

The required behavior is unchanged: throw on uncertain dispatch and never retry
(runtime/workers/project-runners.ts:20). The existing Claude worker reserves the
step with an exclusive file creation before acting; a matching existing
reservation suppresses dispatch (runtime/workers/claude-in-repl.ts:38).
Dispatch exceptions become `unknown`
(runtime/workers/claude-in-repl.ts:94). The host must reconcile the original
reserved step rather than create a second build.

The factory accepts only `turn-ended` from the acting callback
(runtime/workers/project-runners.ts:130). The existing outcome vocabulary is
handled explicitly by the build driver's switch: `unknown` stops the build,
and `refused` becomes blocked (trident/build-run.ts:294). No outcome was added.
I did not deliver the required named non-Claude refusal or its positive-control
test. It would be false to claim that requirement passed.

### Controlled content search

Executed in this working tree:

`rg -n 'turn_duration|end_turn|stop_reason|assistantCalledReply' runtime/adapters/claude-code/persistent/`

The complete output was `hooks/enforce-reply.ts:255` and `:347`, both matching
the `assistantCalledReply` positive control. The other three literal strings
did not match in this searched directory. This is not proof that an alternative
native signal does not exist; it describes only that controlled content search.

### Mutation table

| New guard | Mutation | RED | Restored GREEN |
| --- | --- | --- | --- |
| None delivered | Not run | Not claimed | Not claimed |

There are no new tests or guards in this change. Baseline test execution does
not satisfy the requested bidirectional implementation proof.

### Deliberate limits and live proof

I did not edit the protected workers or contract, implement other providers,
wire composition, delete an old path, change a spec decision, introduce a
feature flag, or dispatch to a live REPL.

The live half remains unproven. A future acceptance command would be
`bun test runtime/workers/claude-project-acting-turn.live.test.ts`; that test is
**not supplied or runnable as a proof in this change**. It must exercise exact
session continuity, pre-dispatch enforcement, native turn-end correlation,
uncertain dispatch without replay, and independent trailer validation against
the real implementation. Naming this future command is not a live-test pass.


### Baseline validation

- `bun test runtime/workers/ runtime/adapters/claude-code/persistent/`: exit 1;
  1,397 pass, 7 skip, 232 fail, 8 errors, 3,911 assertions; 1,636 tests across
  113 files, 236.87 seconds. This is a failed baseline run, not an implementation
  validation.
- `bash scripts/ci/typecheck-all.sh`: exit 0; all 51 configurations passed.
- `bash scripts/ci/leak-gate.sh --tree .`: exit 3, incomplete; zero findings
  from executed rules. The private PII denylist and message checks could not run.
- No code files were changed, so source lint and new-test mutation checks do not
  apply to this documentation-only change. No lint-pass claim is made.

### Failure accounting

Enumeration: parsed every outer `(fail)` line before Bun's repeated failure
summary, grouping by its test-file header. Both the execution section and the
repeated summary contain **231 named entries**, although the aggregate reports
232 failures. One aggregate failure has no separate named entry; it is not
silently assigned to the sandbox. Embedded subprocess `(fail)` text inside an
assertion diff was excluded to avoid counting child output twice.

126 named entries carry direct `EADDRINUSE`, `could not bind`, or
`Failed to start server` diagnostics. Those are compatible with the stated bind
restriction, not passes. The remaining 105 named entries are classified below;
the aggregate's additional unnamed count remains unassigned. Some could be
cascades from sink startup, but this run does not prove that causal attribution.
The separate eight unhandled errors are listed after the cases and are not added
a second time to the failure count.

| Observed diagnostic | Named entries |
| --- | ---: |
| bind | 126 |
| assertion | 43 |
| TypeError | 1 |
| test timeout | 4 |
| waitUntil budget | 30 |
| ENOENT | 1 |
| waitFor timeout | 2 |
| Unix listen | 1 |
| registry key missing | 21 |
| EROFS | 2 |

`registry key missing` means the fixture reported `expected 1 registry key,
got 0`; `waitUntil budget` means its condition was not met within its budget.
The Unix-listen failure concerns a Unix socket, so it is not attributed to the
specific loopback-bind restriction. EROFS is a read-only filesystem failure.
The assertion cases retain their expected/received values where the runner
printed them. In particular, the pipeline-guard cases received exit 0 while
expecting exit 2. None of these diagnostics is reclassified as a successful test.

### Exact named failure entries

Each file heading is relative to the repository root. Repeated parameterized
names and unnamed hook entries are retained in execution order.

#### runtime/adapters/claude-code/persistent/__tests__/adoption-claim-is-a-compare-and-set.test.ts

- (unnamed) — bind

#### runtime/adapters/claude-code/persistent/__tests__/context-reset.test.ts

- resetPooledSessionContext — /reset runtime primitive > clears the warm REPL for the scope: one /clear\r written AFTER the turn, process survives — bind
- resetPooledSessionContext — /reset runtime primitive > is scope-isolated: resetting proj-A never touches proj-B; a cold scope → no_live_session — bind
- resetPooledSessionContext — /reset runtime primitive > reports busy for a reset mid-turn, writes NOTHING, and never wedges the mutex — bind
- resetPooledSessionContext — /reset runtime primitive > waits out an in-flight turn with a generous budget, then clears after it settles — bind
- resetPooledSessionContext — /reset runtime primitive > partial multi-session reset fires on_reset_under_mutex for each session actually cleared before a busy short-circuit — bind
- resetPooledSessionContext — /reset runtime primitive > all-success multi-session reset fires the hook once per session; no live session fires it zero times — bind

#### runtime/adapters/claude-code/persistent/__tests__/tool-restriction.test.ts

- persistent REPL — tool restriction (Codex-r1-P1 SECURITY) > a tools:[] caller spawns the REPL with --tools "" (no built-in tools) — bind
- persistent REPL — tool restriction (Codex-r1-P1 SECURITY) > a tools:[Read,Grep] caller spawns with --tools Read,Grep — bind
- persistent REPL — tool restriction (Codex-r1-P1 SECURITY) > reuse guard: a tools:[] turn never inherits a more-privileged warm REPL — bind
- persistent REPL — tool restriction (Codex-r1-P1 SECURITY) > reuse: same tool surface across turns reuses the one warm REPL — bind

#### runtime/adapters/claude-code/persistent/__tests__/spawn-failure-revokes-credential.test.ts

- a spawn that throws revokes what its registration granted > the credential is refused afterwards and the config is gone — assertion; received undefined
- readiness failure revokes only its own registration > replacement installed: %s — assertion; expected true; received false
- readiness failure revokes only its own registration > replacement installed: %s — assertion; expected true; received false

#### runtime/adapters/claude-code/persistent/__tests__/adopted-pane-latches.test.ts

- (unnamed) — bind

#### runtime/adapters/claude-code/persistent/__tests__/dev-channel-exit-on-close.test.ts

- dev-channel — exit on MCP transport close (ISSUES #217) > closing stdin (parent claude gone) exits the process instead of orphaning it to the HTTP server — bind

#### runtime/adapters/claude-code/persistent/__tests__/todo-sync-hook.test.ts

- (unnamed) — bind

#### runtime/adapters/claude-code/persistent/__tests__/auth-failure-classification.test.ts

- auth-failure classification > a SILENT post-401 turn is reclassified auth_invalid (retryable:false), not turn_timeout — assertion; expected "auth_invalid"; received "channel_wedged"
- auth-failure classification > BLOCKER regression: a HEALTHY turn that ECHOES a credential string but keeps going COMPLETES (never aborted) — assertion; expected false; received true
- auth-failure classification > CEILING BLOCKER (Argus r2): a STILL-STREAMING turn that trips the absolute ceiling is turn_timeout, NOT auth_invalid — assertion; expected "turn_timeout"; received "channel_wedged"
- auth-failure classification > WARM LATCH RE-ARM (Argus r2 MAJOR): a warm second turn 401 (prior banner still latched) reclassifies auth_invalid — assertion; expected false; received true
- auth-failure classification > STALE-BANNER RE-ARM (codex r3): a warm turn that freezes for an UNRELATED reason with a prior turn's banner still in the window is turn_timeout, NOT auth_invalid — assertion; expected false; received true

#### runtime/adapters/claude-code/persistent/__tests__/pipeline-guard.test.ts

- chat Bash pipeline guard > refuses a pipeline into tail and names the offending call — assertion; expected 2; received 0
- chat Bash pipeline guard > refuses a pipeline into sort — assertion; expected 2; received 0
- chat Bash pipeline guard > positive control: a live producer piped into tail -20 goes RED — assertion; expected 2; received 0

#### runtime/adapters/claude-code/persistent/__tests__/session-size-watchdog-wiring.test.ts

- session-size watchdog — substrate wiring (row #13) > a warm session with a ≥5MB post-compact transcript surfaces a warn — assertion; received undefined
- session-size watchdog — substrate wiring (row #13) > requestSessionCompact actuates escape + /compact + enter on the live child — assertion; expected true; received false
- session-size watchdog — substrate wiring (row #13) > an IDLE warm session at ≥10MB AUTO-compacts (gap #4 policy) without a manual press — assertion; received undefined

#### runtime/adapters/claude-code/persistent/__tests__/model-floor.test.ts

- the frontier-model floor holds at the spawn chokepoint > a Haiku record on the owner’s chat substrate spawns the FRONTIER model — bind
- the frontier-model floor holds at the spawn chokepoint > the row it writes back names the FRONTIER model — the value cannot self-perpetuate — bind
- the frontier-model floor holds at the spawn chokepoint > the pool’s REPLAY reader resolves the poisoned row — and the floor still holds — assertion; expected true; received false
- the frontier-model floor holds at the spawn chokepoint > the supervision RESUME reader resolves the poisoned row — the respawn comes up floored — bind
- the frontier-model floor holds at the spawn chokepoint > a substrate WITHOUT the floor keeps its deliberate fast-tier choice — bind
- the frontier-model floor holds at the spawn chokepoint > the floor never DOWNGRADES — a frontier request on a floored substrate is untouched — bind

#### runtime/adapters/claude-code/persistent/__tests__/activity-tap-hook.test.ts

- (unnamed) — bind
- (unnamed) — TypeError

#### runtime/adapters/claude-code/persistent/__tests__/append-system-prompt-wiring.test.ts

- persistent REPL — --append-system-prompt-file reaches the spawned argv > passes the exact autocompact budget to a child whose CLI supports it — bind
- persistent REPL — --append-system-prompt-file reaches the spawned argv > does not pass autocompact to a child whose CLI rejects it — bind
- persistent REPL — --append-system-prompt-file reaches the spawned argv > a ritual caller spawns the REPL with its executor prompt file (not the chat default) — bind
- persistent REPL — --append-system-prompt-file reaches the spawned argv > an unset appendSystemPromptFile spawns with the chat default (repl-agent-base.md) — bind

#### runtime/adapters/claude-code/persistent/__tests__/stuck-agent-turn-wiring.test.ts

- stuck_agent — real dispatch-site wiring (F4 round-2 blocker) > marks the live record BUSY mid-turn and CLEARS it once the turn settles — test timeout
- stuck_agent — real dispatch-site wiring (F4 round-2 blocker) > CANCELLING an in-flight turn still clears the marker (the leak path) — test timeout
- worker prompt observation through a real turn > returns a nonretryable block with the visible prompt — bind
- worker prompt observation through a real turn > a slow working turn survives the inactivity window, then completes — test timeout
- worker prompt observation through a real turn > a working control does not outrank the absolute ceiling — assertion; expected "turn_timeout"; received "channel_wedged"
- a readiness failure captures the prompt before termination and does not retry it — bind
- a capture completing after the reply cannot fail a settled turn — test timeout
- an unclassified deadline still lands: an unclassifiable screen — assertion; expected "turn_timeout"; received "channel_wedged"
- an unclassified deadline still lands: a capture that rejects — assertion; expected "turn_timeout"; received "channel_wedged"

#### runtime/adapters/claude-code/persistent/__tests__/warm-session-abandon-poison.test.ts

- warm reused session — an abandoned/runaway turn must not poison the next turn > substrate turn-timeout: after a wedged turn times out, the NEXT turn delivers on a fresh REPL — assertion; expected 1; received 0
- warm reused session — an abandoned/runaway turn must not poison the next turn > caller cancel: abandoning a turn mid-flight respawns a clean REPL for the next turn — waitUntil budget
- warm reused session — an abandoned/runaway turn must not poison the next turn > control: two NORMAL sequential turns reuse ONE warm REPL (no spurious respawn) — assertion; expected "ok:a"; received ""
- abandon-poison is logged AT POISON TIME (2026-09-03) > a caller cancel writes a `[repl] abandon-poison` line naming the session, generation, cause, turn and time — waitUntil budget

#### runtime/adapters/claude-code/persistent/__tests__/adoption-refuses-a-second-owner.test.ts

- (unnamed) — bind

#### runtime/adapters/claude-code/persistent/__tests__/credential-rotation-rekey.test.ts

- credential rotation re-keys the warm pool (closes #104) > rotating the selected credential (A→B) for the same (instance,user,project) spawns a NEW REPL — bind
- credential rotation re-keys the warm pool (closes #104) > ISSUES #49 — an overlay var set to `undefined` is DELETED from the spawned child env (no host leak) — bind
- warm REPL never serves a turn on a stale OAuth token (closes Codex r2 P1) > a SAME-credential-id token REFRESH evicts the stale warm REPL and respawns under the new token — bind
- warm REPL never serves a turn on a stale OAuth token (closes Codex r2 P1) > interactive-Max-login model: claudeConfigDir threads CLAUDE_CONFIG_DIR and the freshness guard stays inert (self-refresh, no env token) — bind

#### runtime/adapters/claude-code/persistent/__tests__/configured-pty-host.test.ts

- production spawn uses herdr for a complete turn — bind
- production spawn uses bun for a complete turn — bind

#### runtime/adapters/claude-code/persistent/__tests__/pane-handle-persistence.test.ts

- the registry row records the current child terminal > writes the handle a durable host issued — bind
- the registry row records the current child terminal > CLEARS a stale handle when the new child has none — bind
- a pane is OWNED by whoever serves it, however that session came to exist > an actively-served FRESH SPAWN blocks an overlapping adopter — bind
- a pane is OWNED by whoever serves it, however that session came to exist > ...and blocks one IN THE SAME PROCESS, which is the supported case the pid shortcut broke — bind
- a pane is OWNED by whoever serves it, however that session came to exist > A FRESH SPAWN LOSES THE CONTEST for a row another gateway owns, and ends its own child — bind
- a pane is OWNED by whoever serves it, however that session came to exist > ...but a REPLACEMENT SPAWN is not refused by its OWN predecessor's claim — bind
- a pane is OWNED by whoever serves it, however that session came to exist > a REPLACEMENT SPAWN clears ownership its predecessor left behind — bind
- a pane is OWNED by whoever serves it, however that session came to exist > a REPLACEMENT SPAWN inherits no part of the dead child's ownership — bind
- a pane is OWNED by whoever serves it, however that session came to exist > ...and an ordinary spawn with no competitor claims, serves, and gives it back on exit — bind
- an ownership transition that could not hold the lock writes NOTHING > a spawn that cannot RESERVE its key refuses before starting anything — bind
- an ownership transition that could not hold the lock writes NOTHING > a spawn that RESERVED but could not RECORD ownership kills the child it made — bind
- an ownership transition that could not hold the lock writes NOTHING > ...and with the lock held the same spawn serves normally — bind
- an ownership transition that could not hold the lock writes NOTHING > a child exit that cannot hold the lock leaves the row exactly alone — bind
- an ownership transition that could not hold the lock writes NOTHING > ...and with the lock held that same exit disowns the row — bind
- a spawn RESERVES the session key before any process exists > the loser never calls PtyHost.spawn at all — bind
- a spawn RESERVES the session key before any process exists > ...and an uncontended spawn still spawns — bind
- a spawn RESERVES the session key before any process exists > a reservation whose holder DIED does not wedge the key — bind
- a failed first spawn costs a turn, not the key > leaves no reservation stub behind, so the next turn still works — ENOENT
- an ownership write that did not LAND is a refusal, however it failed > a non-ENOENT READ failure (the registry path is a directory) refuses and ends the child — bind
- an ownership write that did not LAND is a refusal, however it failed > a THROWN save refuses and ends the child too — bind
- an ownership write that did not LAND is a refusal, however it failed > a reservation whose DURABLE release failed does not wedge the key for this process — assertion; expected "string"; received "undefined"
- an ownership write that did not LAND is a refusal, however it failed > ...and a healthy registry still records ownership and serves — bind
- a spawn that FAILS READINESS deletes only its own pool entry (#539 r56) > a replacement published during the readiness window survives the failure — bind
- the representations of ownership agree > all four name the same owner while it serves, and three of four release on a fence — bind
- a refused contender leaves the winner able to be answered > an overlapping ADOPTER via direct leaves the winner credential intact — bind
- a refused contender leaves the winner able to be answered > an overlapping ADOPTER via boot gate leaves the winner credential intact — bind
- a refused contender leaves the winner able to be answered > a FRESH SPAWN that loses the reservation does not strip the live session's credential — bind
- an adoption stands down for a spawn that is already in flight > refuses, hands its child back, and leaves the pane and the row alone — bind
- an adoption stands down for a spawn that is already in flight > ...and a reservation whose holder is GONE does not block the adoption — assertion; expected "adopted"; received "undecided"

#### runtime/adapters/claude-code/persistent/__tests__/tool-bridge.test.ts

- P0-1 native-MCP tool bridge — spawn wiring > attaches a SECOND mcpServers entry + manifest + --allowedTools when enabled — bind
- P0-1 native-MCP tool bridge — spawn wiring > SECURITY: an opted-OUT substrate gets NO bridge even when one is wired — bind
- P0-1 native-MCP tool bridge — spawn wiring > no-op when enabled but no bridge is wired (LLM-less / pre-compose) — bind
- P0-1 native-MCP tool bridge — reply-sink dispatch routes > /tools returns the wired bridge schemas (empty when unwired) — bind
- P0-1 native-MCP tool bridge — reply-sink dispatch routes > /tool-call dispatches against the registry and returns a structured result — bind
- P0-1 native-MCP tool bridge — reply-sink dispatch routes > /tool-call bridge grant: ungranted dispatch is refused — bind
- P0-1 native-MCP tool bridge — reply-sink dispatch routes > /tool-call bridge grant: granted dispatch succeeds — bind
- P0-1 native-MCP tool bridge — reply-sink dispatch routes > /todo-sync bridge grant: ungranted dispatch is refused — bind
- P0-1 native-MCP tool bridge — reply-sink dispatch routes > /todo-sync bridge grant: granted dispatch succeeds — bind
- P0-1 native-MCP tool bridge — reply-sink dispatch routes > /tool-call returns ok:false (not an HTTP fault) when the handler throws — bind
- P0-1 native-MCP tool bridge — reply-sink dispatch routes > /tool-call 503s when no bridge is wired; 400s on a missing tool_name — bind
- P0-1 native-MCP tool bridge — reply-sink dispatch routes > threads the calling session’s ACTIVE project scope into dispatch.project_id (P0 work-board fix) — bind

#### runtime/adapters/claude-code/persistent/__tests__/persistent-repl-substrate.test.ts

- PersistentReplSubstrate — conformance > kills local-flag and queue-after mutations: additional input hits /message before completion — bind
- PersistentReplSubstrate — conformance > tool_resolution is internal and respondToTool throws — bind
- PersistentReplSubstrate — conformance > a turn yields token + completion carrying substrate_instance_id and session — bind
- PersistentReplSubstrate — reply→completion bridge > drain returns exactly the reply text — bind
- PersistentReplSubstrate — multi-turn context persists (one warm REPL) > 3 turns reuse ONE REPL and a later turn sees earlier turns — bind
- PersistentReplSubstrate — per-instance isolation > different keys spawn different REPLs with independent state — bind
- PersistentReplSubstrate — failure + status > process death surfaces a retryable error — assertion; expected true; received false
- PersistentReplSubstrate — failure + status > O3 — a missing-binary spawn (ENOENT) stamps binary_not_found + the NON-retryable hint at the producer — assertion; expected "binary_not_found"; received "channel_wedged"
- PersistentReplSubstrate — per-turn timeout override (AgentSpec.turn_timeout_ms) > a per-spec turn_timeout_ms overrides a long construction-time turnTimeoutMs — bind
- PersistentReplSubstrate — a delayed reply from a timed-out turn does not complete the NEXT turn (Codex GPT-5 r4 P2) > a stale /reply that lands while the next turn is parked pre-inject is dropped, not misattributed — bind
- PersistentReplSubstrate — a delayed reply from a timed-out turn does not complete the NEXT turn (Codex GPT-5 r4 P2) > a stale /reply that lands DURING turn 2 inject is rejected by turn-id correlation — bind
- PersistentReplSubstrate — liveness keepalive > emits periodic status keepalives while a SILENT turn is in flight (child alive) — bind
- PersistentReplSubstrate — dev-channel MCP handshake race (P0 2026-06-26) > forces MCP_CONNECTION_NONBLOCKING=false on the REPL spawn (claude AWAITS the dev-channel handshake before turn 1) — bind
- PersistentReplSubstrate — dev-channel MCP handshake race (P0 2026-06-26) > END-TO-END SMOKE: a real LLM turn completes through the substrate — healthz-200 alone is NOT proof the LLM path is alive — bind
- PersistentReplSubstrate — activity-based (inactivity) turn timeout > keeps an ACTIVE turn alive past the inactivity window (PTY activity resets the deadline) — bind
- PersistentReplSubstrate — activity-based (inactivity) turn timeout > abandons a GENUINELY frozen turn after the inactivity window (no PTY activity) — bind
- PersistentReplSubstrate — activity-based (inactivity) turn timeout > enforces the ABSOLUTE CEILING even while the turn keeps producing PTY output — bind
- a malformed error STAMP cannot crash the error path (#539 r43) > a stamp that is not a taxonomy member yields an ordinary error event, and the stream CLOSES — bind
- a malformed error STAMP cannot crash the error path (#539 r43) > ...and a VALID stamp still classifies as itself — assertion; expected "repl_unreconciled"; received "channel_wedged"
- a malformed error STAMP cannot crash the error path (#539 r43) > ...and an error with no stamp at all is unchanged — assertion; received "channel_wedged"
- configured production host carries a complete REPL turn — bind

#### runtime/adapters/claude-code/persistent/__tests__/ritual-auto-approve-gate.test.ts

- ritual auto-approve gate (task 6 / T5 write-containment) > DEFAULT (flag unset): the `tool-use-approve` auto-approver IS registered — bind
- ritual auto-approve gate (task 6 / T5 write-containment) > disableToolUseAutoApprove: true — the auto-approver is ABSENT, wedge-recovery stays — bind

#### runtime/adapters/claude-code/persistent/__tests__/import-warm-session-reset.test.ts

- PersistentReplSubstrate — reset_context_per_turn (import warm-session) > reuses ONE warm REPL across chunks and writes /clear before each REUSED turn — bind
- PersistentReplSubstrate — reset_context_per_turn (import warm-session) > a REFUSED /clear is reported and the import proceeds — never silently skipped — bind
- PersistentReplSubstrate — reset_context_per_turn (import warm-session) > CONTROL — when the submit is accepted, nothing is reported as failed — bind
- PersistentReplSubstrate — reset_context_per_turn (import warm-session) > the default warm substrate (no flag) writes NO /clear — opt-in only — bind

#### runtime/adapters/claude-code/persistent/__tests__/ephemeral-oneshot-isolation.test.ts

- PersistentReplSubstrate — ephemeral one-shot isolation (Argus r4 BLOCKER) > two session-less one-shots on ONE ephemeral substrate do NOT share a transcript — bind
- PersistentReplSubstrate — ephemeral one-shot isolation (Argus r4 BLOCKER) > a third one-shot still spawns fresh (no accumulation across many calls) — bind
- PersistentReplSubstrate — ephemeral one-shot isolation (Argus r4 BLOCKER) > a dispatch carrying a real spec.session pools even on an ephemeral substrate (warm multi-turn) — bind
- PersistentReplSubstrate — ephemeral one-shot isolation (Argus r4 BLOCKER) > the default (non-ephemeral) substrate still warm-reuses across session-less turns — bind
- PersistentReplSubstrate — ephemeral CRASH-path isolation (Argus r5 BLOCKER) > an ephemeral one-shot that crashes mid-turn does NOT enqueue to pending-respawns and does NOT replay to the user — waitFor timeout
- PersistentReplSubstrate — ephemeral CRASH-path isolation (Argus r5 BLOCKER) > CONTROL: a NON-ephemeral one-shot that crashes mid-turn DOES enqueue (proves the enqueue path is exercised) — waitFor timeout
- PersistentReplSubstrate — ephemeral CRASH-path isolation (Argus r5 BLOCKER) > ephemeral dispose unlinks its temp config files (IMPORTANT-1: no unbounded tmp-file leak) — bind

#### runtime/adapters/claude-code/persistent/__tests__/crashed-agent-real-exit.test.ts

- crashed-agent watchdog — real spawn exit handler (F4) > an ABNORMAL exit (non-zero code, not killed by us) is REPORTED by the detector — assertion; expected 1; received 0
- crashed-agent watchdog — real spawn exit handler (F4) > herdr shape — a `null` exit NOT killed by us IS a crash — assertion; expected 1; received 0
- crashed-agent watchdog — real spawn exit handler (F4) > herdr shape — the SAME `null` exit, killed by us, is NOT a crash — assertion; expected 1; received 0
- crashed-agent watchdog — real spawn exit handler (F4) > a CLEAN exit (code 0) is unregistered — the detector reports nothing — assertion; expected 1; received 0
- crashed-agent watchdog — real spawn exit handler (F4) > an INTENTIONAL kill (signal, wasKilledByUs) is NOT a crash — unregistered, no alert — assertion; expected 1; received 0

#### runtime/adapters/claude-code/persistent/__tests__/evict-deletes-only-its-own-entry.test.ts

- a turn that loses the pool is still subject to the reuse guards > is not handed a winner whose tool surface it never asked for — bind

#### runtime/adapters/claude-code/persistent/__tests__/stateless-correlation.test.ts

- S3 #107 — stateless turn-id-echo correlation (behavioral) > a straggler reply with a mismatched turn_id is rejected; the real reply wins — assertion; received ""
- S3 #107 — stateless turn-id-echo correlation (behavioral) > a reply with NO echoed turn_id is rejected — the turn does NOT complete on it — assertion; expected true; received false
- S3 #107 — stateless turn-id-echo correlation (behavioral) > a normal turn still completes on its own echoed turn_id — assertion; expected "echo:hello"; received ""

#### runtime/adapters/claude-code/persistent/__tests__/pool-key-namespace.test.ts

- PersistentReplSubstrate — per-(user,project) isolation + persistence (behavioral) > two distinct (user, project) triples spawn two REPLs; the same triple reuses one — bind
- PersistentReplSubstrate — per-(user,project) isolation + persistence (behavioral) > a different cwd for the same identity does NOT fork the REPL — bind
- PersistentReplSubstrate — per-(user,project) isolation + persistence (behavioral) > a router turn and a conversational turn for the same identity do NOT collapse — bind

#### runtime/adapters/claude-code/persistent/__tests__/sink-restart-survival.test.ts

- sink token — load or create (#537) > a UNIX SOCKET at the token path is REPLACED, not waited on — Unix listen
- sink port — per instance, never ephemeral (#537) > a sink given ONLY a tokenPath binds the DERIVED port — the derivation, not the fixture — bind
- sink port — per instance, never ephemeral (#537) > sequential sink instances agree, and the second authorizes a child the FIRST baked — bind
- sink port — per instance, never ephemeral (#537) > a port already in use FAILS LOUDLY and binds nothing else — bind
- sink port — per instance, never ephemeral (#537) > a sink that cannot bind still leaves the persisted token intact for the next try — bind
- sink port — per instance, never ephemeral (#537) > two concurrent starts share ONE attempt — the loser never sees the winner as EADDRINUSE — bind
- sink port — per instance, never ephemeral (#537) > a concurrent caller inherits a genuine failure rather than inventing a second sink — bind
- sink port — per instance, never ephemeral (#537) > a SECOND home borrows the first sink's coordinates — the documented one-sink-per-process limit — bind
- sink port — per instance, never ephemeral (#537) > a freeing port is adopted within the bounded retry window — bind
- sink token — state-dir placement > the sink records the token path it used, and it is outside any repo tree — bind
- concurrent first startup — the live token IS the persisted token (#537) > when two processes race for the PORT too, the one that BOUND it holds the persisted token — bind
- a credential names WHICH session; a session id names nothing (#537) > an orphan presenting a LIVE session's id — lifted from the process table — is refused — bind
- a credential names WHICH session; a session id names nothing (#537) > an orphan whose session has since RESPAWNED is refused, though the id is unchanged — bind
- a credential names WHICH session; a session id names nothing (#537) > a replacement registered with NO unregister still revokes the displaced credential — bind
- a credential names WHICH session; a session id names nothing (#537) > the LEGITIMATE child still succeeds on every privileged route, with its scope — bind
- a credential names WHICH session; a session id names nothing (#537) > a credential is accepted even when the body names a DIFFERENT session — bind
- a credential names WHICH session; a session id names nothing (#537) > unregistering a session revokes its credential immediately — the reap has teeth — bind
- the OTHER direction — the gateway reaching a surviving child (#537) > the PRODUCTION inject path sends THIS CHILD'S credential, in the request the child expects — bind
- the OTHER direction — the gateway reaching a surviving child (#537) > a child holding a DIFFERENT token refuses the production inject, and injectMessage says so — bind

#### runtime/adapters/claude-code/persistent/__tests__/adopted-repl-serves-a-turn.test.ts

- (unnamed) — bind

#### runtime/adapters/claude-code/persistent/__tests__/repl-supervision.test.ts

- S2 supervision — #2 crash + respawn re-attaches the same session > after a mid-turn crash, the next start() --resumes the SAME sessionId — assertion; expected 1; received 0
- S2 supervision — #1 watchdog tick respawns a wedged (health-dead) REPL > a warm REPL with dead /health is respawned with --resume by the tick — registry key missing
- S2 supervision — #1 watchdog tick respawns a wedged (health-dead) REPL > inside the boot-grace window the tick ignores (no premature respawn) — registry key missing
- S2 supervision — #1 watchdog tick respawns a wedged (health-dead) REPL > pid-dead detection calls the durable child-crash sink before respawn (#514) — registry key missing
- S2 supervision — #1 watchdog tick respawns a wedged (health-dead) REPL > #518 — a pid-dead child the GATEWAY SHUTDOWN killed reaches the sink as a deploy, not a crash — registry key missing
- S2 supervision — #1 watchdog tick respawns a wedged (health-dead) REPL > a rejected crash sink is retried before the dead registry PID is replaced (#514) — registry key missing
- S2 supervision — #1 watchdog tick respawns a wedged (health-dead) REPL > an alive-but-wedged respawn KILLS the old child before the --resume spawn (one owner per transcript) — registry key missing
- S2 supervision — #12 cwd-drift watchdog respawns a child pinned to canonical > a child whose live cwd drifted off canonical is respawned with --resume — registry key missing
- S2 supervision — #12 cwd-drift watchdog respawns a child pinned to canonical > a child whose live cwd matches canonical (descendant) is left alone — registry key missing
- S2 supervision — #12 cwd-drift watchdog respawns a child pinned to canonical > drift BUT canonical missing on disk → NO respawn, alert fired — registry key missing
- S2 supervision — #12 cwd-drift watchdog respawns a child pinned to canonical > a second drift within the 1h throttle does not re-respawn — registry key missing
- S2 supervision — #3 no double-spawn under concurrent respawn > two respawn calls for one key fire exactly ONE spawn (in-flight guard) — registry key missing
- S2 supervision — in-flight stamp lifecycle (Codex P2-3 / P2-4 regressions) > clears the in-flight stamp once the resumed REPL is confirmed alive — registry key missing
- S2 supervision — in-flight stamp lifecycle (Codex P2-3 / P2-4 regressions) > a ghost cwd refuses with spawn-cwd-invalid and does NOT latch in-flight — registry key missing
- S2 supervision — pending-respawns: inbound dropped during the respawn gap is queued + replayed > a mid-turn crash enqueues the dropped inbound, then the drain replays it via /message after resume — registry key missing
- S2 supervision — pending-respawns: replay targets the entry session, not the drain options (Codex P2) > a dropped inbound for substrate A replays into A even when drained via substrate B — assertion
- S2 supervision — pending-respawns: a crash DURING injection still enqueues the dropped inbound (Codex P2) > the inject-time-crash path enqueues for replay, not just a retryable error — registry key missing
- S2 supervision — watchdog tick is scoped to its instance registry (Codex P2) > instance A's tick does not scan or respawn instance B's pooled session — registry key missing
- S2 supervision — pending-respawns: a same-key replacement enqueued mid-drain is not lost (Codex GPT-5 r4 BLOCKER) > replays the CURRENT queued entry (newer inbound B), never the stale snapshot (A) — registry key missing
- S2 supervision — health probe has a deadline (Codex P2) > a dev-channel that accepts but never answers /health resolves false within the timeout — bind
- S2 supervision — health probe has a deadline (Codex P2) > a healthy /health resolves true — bind
- S2 supervision — operator respawn uses the OWNING substrate options, not last-registered (Codex P2) > respawning session A actuates on A's substrate even when B registered last under the same registry — assertion; expected true; received false
- S2 supervision — operator respawn uses the OWNING substrate options, not last-registered (Codex P2) > a session is not recoverable via a different instance registry path — registry key missing
- S2 supervision — operator force path (admin endpoint) clears capped_at + is double-spawn-safe > respawnSupervisedSession force-recovers a hard-capped REPL and clears capped_at — registry key missing
- S2 supervision — operator force path (admin endpoint) clears capped_at + is double-spawn-safe > two rapid operator force requests spawn EXACTLY ONCE (force honors the in-flight gate) — registry key missing
- S2 supervision — #4 respawn refuses when there is no resumable session > a record with has_session=false refuses with no-session-to-resume (never fresh-spawns) — registry key missing
- S2 supervision — cross-incarnation turnId collision (Argus r6) > a straggler tagged with a KILLED incarnation’s turn-id does not complete the resumed incarnation’s turn — assertion; expected "A:q1"; received ""
- #676 registry resume decisions after boot reconciliation > ENOENT: absence starts fresh; unreadability refuses retryably — assertion
- #676 registry resume decisions after boot reconciliation > missing-row: absence starts fresh; unreadability refuses retryably — assertion
- #676 registry resume decisions after boot reconciliation > malformed-json: absence starts fresh; unreadability refuses retryably — assertion
- #676 registry resume decisions after boot reconciliation > EISDIR: absence starts fresh; unreadability refuses retryably — assertion
- #676 registry resume decisions after boot reconciliation > invalid-row: absence starts fresh; unreadability refuses retryably — assertion

#### runtime/adapters/claude-code/persistent/__tests__/gateway-shutdown-survival.test.ts

- a surviving child is handed OVER, not merely left alone > (unnamed) — bind

#### runtime/adapters/claude-code/persistent/__tests__/poison-eviction-live-work-guard.test.ts

- the post-inject `working` status names the child generation (the eviction guard key) > exactly one non-keepalive status carries launcher_session_key, equal to the completion generation — waitUntil budget
- abandon-poison eviction guard — a poisoned launcher hosting live work is QUARANTINED, not killed and not reused > REGRESSION: with hostsLiveWork > 0 the child is SPARED (still running) but NOT reused — the next turn gets a fresh child — waitUntil budget
- abandon-poison eviction guard — a poisoned launcher hosting live work is QUARANTINED, not killed and not reused > POSITIVE CONTROL: an ordinary eviction DOES --resume the dead child's transcript — waitUntil budget
- abandon-poison eviction guard — a poisoned launcher hosting live work is QUARANTINED, not killed and not reused > the replacement does NOT --resume the quarantined transcript (the one-owner invariant a live child cannot give us) — waitUntil budget
- abandon-poison eviction guard — a poisoned launcher hosting live work is QUARANTINED, not killed and not reused > the quarantined child is reaped once its hosted work drains — and never before — waitUntil budget
- abandon-poison eviction guard — a poisoned launcher hosting live work is QUARANTINED, not killed and not reused > a later dispatch reaps the drained quarantined child on its own — nothing else calls the sweep in production — waitUntil budget
- abandon-poison eviction guard — a poisoned launcher hosting live work is QUARANTINED, not killed and not reused > control: with hostsLiveWork → 0 the poisoned child IS evicted, and onChildCrash is told the EVICTED generation — waitUntil budget
- abandon-poison eviction guard — a poisoned launcher hosting live work is QUARANTINED, not killed and not reused > a throwing hostsLiveWork fails SAFE to the old behaviour (evict); the guard can only ever spare a child — waitUntil budget
- abandon-poison eviction guard — a poisoned launcher hosting live work is QUARANTINED, not killed and not reused > unwired hostsLiveWork (every chat / synthesis substrate) keeps the 2026-06-18 cascade fix byte-for-byte: evict + respawn — waitUntil budget
- a gateway shutdown reports its own kills as a deploy, never as a crash > a POOLED child is reported with cause gateway-shutdown before it is killed — waitUntil budget
- a gateway shutdown reports its own kills as a deploy, never as a crash > a QUARANTINED child — the one that certainly hosts live work — is reported too — waitUntil budget
- a gateway shutdown reports its own kills as a deploy, never as a crash > THE COMPLEMENT — an eviction with NO live work still reports cause child-died — waitUntil budget
- a fresh spawn does not inherit the previous generation's excuse (#518) > a respawn clears the gateway-shutdown marker along with the crash edge — waitUntil budget
- a child that was ALREADY DEAD when teardown arrived is not a deploy kill (#518) > reports cause unknown and records it AS undetermined — not as ours, not as a crash — waitUntil budget
- the durable backstop actually backs up a failed report (#518) > sink throws at shutdown → the NEXT boot delivers the attributed deploy report — waitUntil budget
- the durable backstop actually backs up a failed report (#518) > THE COMPLEMENT — a sink that SUCCEEDS at shutdown is not reported twice — waitUntil budget
- no child’s marker or kill sits behind another child’s sink (#518) > a sink that NEVER settles still leaves every child marked and killed — waitUntil budget
- no child’s marker or kill sits behind another child’s sink (#518) > THE COMPLEMENT — a fast sink is still reported INLINE, not deferred away — waitUntil budget
- a quarantined child whose report fails is still recoverable on the next boot > sink throws → the quarantined generation is durably recorded and the probe finds it — waitUntil budget
- a quarantined child whose report fails is still recoverable on the next boot > THE COMPLEMENT — a generation no shutdown killed is still unknown, not a deploy — waitUntil budget
- a delivered undetermined report is not reported again (#518) > successful unknown → the next watchdog tick says NOTHING further — waitUntil budget
- a delivered undetermined report is not reported again (#518) > THE COMPLEMENT — an UNDELIVERED unknown still leaves the edge open for retry — waitUntil budget
- a kill that throws never attributes a deploy (#518) > an ALIVE child whose kill() throws is NOT reported as a deploy kill — waitUntil budget
- a kill that throws never attributes a deploy (#518) > THE COMPLEMENT — a kill that SUCCEEDS still attributes the deploy — waitUntil budget
- a signal that failed does not become a deploy kill when the child dies anyway > reports UNDETERMINED for a child that exited while our signal was failing — waitUntil budget
- an unsettled spawn does not hold the shutdown report of a live child (#518) > the settled child is still marked, killed and reported — waitUntil budget
- an unsettled spawn does not hold the shutdown report of a live child (#518) > a spawn that lands INSIDE the grace is treated like any other child — waitUntil budget
- a liveness probe that throws does not abort the drain (#518) > the healthy child is still confirmed and reported — waitUntil budget

#### runtime/adapters/claude-code/persistent/__tests__/session-config-containment.test.ts

- cleanup checks the FILESYSTEM, because the lexical check cannot see a symlink > REFUSES to unlink through a symlinked directory, and the target survives — EROFS
- cleanup checks the FILESYSTEM, because the lexical check cannot see a symlink > ...and an aliased root does NOT make an outside directory deletable — EROFS

#### runtime/adapters/claude-code/persistent/__tests__/boot-adoption.test.ts

- (unnamed) — bind

### Unhandled errors, in execution order

- runtime/adapters/claude-code/persistent/__tests__/context-reset.test.ts:221:13 — timed out waiting for the turn to inject
- runtime/adapters/claude-code/persistent/__tests__/context-reset.test.ts:221:13 — timed out waiting for the turn to inject
- runtime/adapters/claude-code/persistent/__tests__/stuck-agent-turn-wiring.test.ts:171:22 — expect(received).toBe(expected)
- runtime/adapters/claude-code/persistent/__tests__/stuck-agent-turn-wiring.test.ts:243:70 — expect(received).toBe(expected)
- runtime/adapters/claude-code/persistent/__tests__/stuck-agent-turn-wiring.test.ts:286:46 — expect(received).toBe(expected)
- runtime/adapters/claude-code/persistent/__tests__/stuck-agent-turn-wiring.test.ts:344:40 — expect(received).toBe(expected)
- runtime/adapters/claude-code/persistent/pool-state.ts:329:15 — reply sink bind failure
- runtime/adapters/claude-code/persistent/__tests__/persistent-repl-substrate.test.ts:158:45 — reply sink bind failure
