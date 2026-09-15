## 2026-09-15 — WIRE6 acting-turn investigation; implementation not delivered

### Delivery status

This is an investigation record, **not a completed production implementation**.
The assigned contract remains unimplemented in this lane. Its requirements are
unchanged: exact project session, pre-dispatch enforcement, observed dispatch-turn
end, uncertainty without replay, and Pi definition/trailer-writer binding
(runtime/workers/project-runners.ts:17).

I did not deliver the requested code or new tests. In particular, substituting a
new callback for the enforcement and observation work would merely move the
unfinished contract. This record must not be used as evidence that WIRE6 is ready
for composition or that the all-provider acceptance criteria passed.

### Findings from the supplied base

The current selector explicitly rejects Pi conversational selection
(runtime/adapters/select-substrate.ts:108). The Codex execution path constructs
`exec --json`, optionally adding a resume argument, then starts a subprocess
(runtime/adapters/codex-cli/exec.ts:120;
runtime/adapters/codex-cli/exec.ts:151). These are concrete reasons that simply
calling the current selected substrate does not establish the requested
all-provider live-project-REPL behavior.

The task's unset-host premise differs from this checkout: `undefined` and `herdr`
both return `herdrHost`
(runtime/adapters/claude-code/persistent/configured-pty-host.ts:13). I did not
change this selector or request a change to that product decision.

### Transport and terminal evidence

The existing transport already implements the measured connection strategy:
`herdrCall` owns the socket and reply state inside each invocation, closing the
socket when that call settles
(runtime/adapters/claude-code/persistent/herdr-client.ts:358;
runtime/adapters/claude-code/persistent/herdr-client.ts:381).
The existing host awaits `pane.send_text` and then `pane.send_keys` for Enter
(runtime/adapters/claude-code/persistent/herdr-host.ts:654). A future implementation
should reuse this host operation, preserving its queued ordering and checks
(runtime/adapters/claude-code/persistent/herdr-host.ts:636).

I did **not** establish a usable measured terminal signal for all three live
project providers. The reasons not to substitute the available weaker evidence are:

- Acceptance: the acknowledged host operation finishes after the two input RPCs;
  that code does not wait for a provider turn to end
  (runtime/adapters/claude-code/persistent/herdr-host.ts:654).
- Empty output: the existing composer returns collected text from a substrate
  handle. That return value contains no distinct observation of native terminal
  evidence (gateway/wiring/build-live-agent-turn.ts:1110).
- Exit zero: the Codex adapter explicitly synthesizes `completion` when execution
  reaches the end without having emitted one
  (runtime/adapters/codex-cli/exec.ts:333). The recorded Pi measurement also reports
  a killed child as exit zero with no messages
  (docs/plans/harness-orchestrator-pivot-2026-09-11.md:390).
- Claude's generic `completion` is produced during receipt of a correlated reply,
  followed by closing and settling the turn channel
  (runtime/adapters/claude-code/persistent/repl-session.ts:393;
  runtime/adapters/claude-code/persistent/repl-session.ts:404). This read establishes
  reply receipt; I did not prove a subsequent native end-of-turn event from it.

The Pi probe waits for correlated RPC `response` messages
(scripts/probes/pi-in-repl.py:41), tests tool registration and session identity
(scripts/probes/pi-in-repl.py:103), and kills the example child
(scripts/probes/pi-in-repl.py:126). It is not a live parent-model dispatch proof;
its header explicitly describes the absence of a parent model prompt
(scripts/probes/pi-in-repl.py:3).

### Grants and continuous enforcement

No new enforcement was delivered for any provider. Claude's runner puts the
request in the child prompt and supplies a model argument
(runtime/workers/claude-in-repl.ts:52). The existing Claude settings writer can emit
session permissions (runtime/adapters/claude-code/persistent/build-settings.ts:175),
and the spawn options describe the conditions required for those permissions to
refuse writes instead of prompting
(runtime/adapters/claude-code/persistent/types.ts:413). Those are not evidence that
this lane bound a particular bounded child to those restrictions.

Pi explicitly requires the host to bind the generated definition and provide a
writer outside restricted child grants (runtime/workers/pi-in-repl.ts:14).
The measured example tool allowlist is explicitly distinguished from OS
confinement (docs/plans/harness-orchestrator-pivot-2026-09-11.md:391).
I did not implement that definition, sandbox, or writer. I also did not implement
a Codex live-session policy boundary. Consequently there is no new continuously
maintained enforcement invariant to claim or mutation-check.

### Uncertainty and existing outcome vocabulary

The current factory accepts only `turn-ended` from the acting-turn callback;
an explicit unknown becomes an existing unknown bounded-work result
(runtime/workers/project-runners.ts:130;
runtime/workers/project-runners.ts:139). The driver switches on that existing
vocabulary and stops on unknown (trident/build-run.ts:287). No new outcome value
or default handling was added in this lane.

The required future behavior remains: throw on uncertain dispatch, do not replay,
and leave reconciliation of the original reserved step to the host
(runtime/workers/project-runners.ts:20). This investigation does not implement
that reconciliation or change the contract.

### Controlled searches

These are working-tree content searches, not fetched-ref inventory claims.

`rg -n 'agent_end|assertConversationalProviderWired' runtime scripts/probes`

The complete result was the positive control at
runtime/adapters/select-substrate.ts:104 and :174. No `agent_end` text matched
in those two searched trees. This establishes only that narrow text-search result,
not the nonexistence of some differently named signal or an installed-provider API.

`rg -n 'ProjectActingTurn|bounded-worker|BoundedWorkRequest' runtime/adapters runtime/workers/project-runners.ts`

The complete result was runtime/workers/project-runners.ts at lines
4, 23, 25, 37, 44, 74, 118, and 119 (the positive control). No matching text appeared
in the searched adapter tree. This is a request-binding search, not proof that no
adapter could be extended to enforce the contract.

### Mutation table

| New guard | Mutation | RED | Restored GREEN |
| --- | --- | --- | --- |
| None delivered | Not run | Not claimed | Not claimed |

There are no new tests, so there is no new bidirectional test claim. Existing-suite
results below are baseline measurements only and cannot validate an acting-turn
implementation that was not built.

### Deliberate limits and live proof

This lane did not modify the protected workers or runner contract, wire the
launcher, delete an old path, add a feature flag, amend a spec decision, dispatch
into a live REPL, or publish a branch. It does not claim the contract is wrong or
that the implementation is impossible. I did not complete it.

Live dispatch remains unproven. Proposed future acceptance command:
`bun test runtime/workers/project-acting-turn.live.test.ts`.
That test is **not delivered by this lane**; this is not a currently supplied proof
command. It must exercise the real implementation against each live project
provider, check exact session and pre-dispatch confinement, distinguish native
turn end from acceptance/empty output/exit zero, validate the child trailer, and
verify that uncertainty does not dispatch a second time. The existing offline Pi
probe command, `python3 scripts/probes/pi-in-repl.py`, proves only the narrower
measurements listed above.

### Baseline validation results

- `bun test runtime/workers/ runtime/adapters/claude-code/persistent/`: exit 1; 1,397 passed, 7 skipped, 232 failed, 7 errors; 1,636 tests across 113 files. This is a failed baseline run, not an acting-turn validation. The file inventory is the discovery of that exact command.
- `bash scripts/ci/typecheck-all.sh`: exit 0; all 51 configurations passed.
- `bunx --no-install eslint .trident/as-built/rebuild/project-acting-turn.md`: exit 0 with an ignored-file warning. Markdown has no matching ESLint configuration, so this is not a lint-pass claim.
- `bash scripts/ci/leak-gate.sh --tree .`: exit 3, INCOMPLETE; zero findings from executed rules. The private denylist file and message checks could not run.
- `git diff --check`: passed before staging. Exactly one `## ` heading was observed in this shard.

Failures include non-bind diagnostics: the three `pipeline-guard.test.ts` cases reported exit-code assertion mismatches; the two failing `session-config-containment.test.ts` cases reported EROFS. Timeout and other failures are not classified as sandbox-bind failures here.

### Exact cases with a socket-bind diagnostic

Enumerated from the execution portion of the test log, before Bun repeats its failure summary: 126 failure entries had `EADDRINUSE`, `could not bind`, or `Failed to start server` in their immediately preceding diagnostic block. These are the cases for which this run carries direct bind evidence; this is not a claim that all 232 failures share that cause. Repeated parameterized names are retained. An unnamed entry is a hook failure, reported as unnamed by Bun.


runtime/adapters/claude-code/persistent/__tests__/adoption-claim-is-a-compare-and-set.test.ts

- (unnamed)

runtime/adapters/claude-code/persistent/__tests__/context-reset.test.ts

- resetPooledSessionContext — /reset runtime primitive > clears the warm REPL for the scope: one /clear\r written AFTER the turn, process survives
- resetPooledSessionContext — /reset runtime primitive > is scope-isolated: resetting proj-A never touches proj-B; a cold scope → no_live_session
- resetPooledSessionContext — /reset runtime primitive > reports busy for a reset mid-turn, writes NOTHING, and never wedges the mutex
- resetPooledSessionContext — /reset runtime primitive > waits out an in-flight turn with a generous budget, then clears after it settles
- resetPooledSessionContext — /reset runtime primitive > partial multi-session reset fires on_reset_under_mutex for each session actually cleared before a busy short-circuit
- resetPooledSessionContext — /reset runtime primitive > all-success multi-session reset fires the hook once per session; no live session fires it zero times

runtime/adapters/claude-code/persistent/__tests__/tool-restriction.test.ts

- persistent REPL — tool restriction (Codex-r1-P1 SECURITY) > a tools:[] caller spawns the REPL with --tools "" (no built-in tools)
- persistent REPL — tool restriction (Codex-r1-P1 SECURITY) > a tools:[Read,Grep] caller spawns with --tools Read,Grep
- persistent REPL — tool restriction (Codex-r1-P1 SECURITY) > reuse guard: a tools:[] turn never inherits a more-privileged warm REPL
- persistent REPL — tool restriction (Codex-r1-P1 SECURITY) > reuse: same tool surface across turns reuses the one warm REPL

runtime/adapters/claude-code/persistent/__tests__/adopted-pane-latches.test.ts

- (unnamed)

runtime/adapters/claude-code/persistent/__tests__/dev-channel-exit-on-close.test.ts

- dev-channel — exit on MCP transport close (ISSUES #217) > closing stdin (parent claude gone) exits the process instead of orphaning it to the HTTP server

runtime/adapters/claude-code/persistent/__tests__/todo-sync-hook.test.ts

- (unnamed)

runtime/adapters/claude-code/persistent/__tests__/model-floor.test.ts

- the frontier-model floor holds at the spawn chokepoint > a Haiku record on the owner’s chat substrate spawns the FRONTIER model
- the frontier-model floor holds at the spawn chokepoint > the row it writes back names the FRONTIER model — the value cannot self-perpetuate
- the frontier-model floor holds at the spawn chokepoint > the supervision RESUME reader resolves the poisoned row — the respawn comes up floored
- the frontier-model floor holds at the spawn chokepoint > a substrate WITHOUT the floor keeps its deliberate fast-tier choice
- the frontier-model floor holds at the spawn chokepoint > the floor never DOWNGRADES — a frontier request on a floored substrate is untouched

runtime/adapters/claude-code/persistent/__tests__/activity-tap-hook.test.ts

- (unnamed)

runtime/adapters/claude-code/persistent/__tests__/append-system-prompt-wiring.test.ts

- persistent REPL — --append-system-prompt-file reaches the spawned argv > passes the exact autocompact budget to a child whose CLI supports it
- persistent REPL — --append-system-prompt-file reaches the spawned argv > does not pass autocompact to a child whose CLI rejects it
- persistent REPL — --append-system-prompt-file reaches the spawned argv > a ritual caller spawns the REPL with its executor prompt file (not the chat default)
- persistent REPL — --append-system-prompt-file reaches the spawned argv > an unset appendSystemPromptFile spawns with the chat default (repl-agent-base.md)

runtime/adapters/claude-code/persistent/__tests__/stuck-agent-turn-wiring.test.ts

- worker prompt observation through a real turn > returns a nonretryable block with the visible prompt
- a readiness failure captures the prompt before termination and does not retry it

runtime/adapters/claude-code/persistent/__tests__/adoption-refuses-a-second-owner.test.ts

- (unnamed)

runtime/adapters/claude-code/persistent/__tests__/credential-rotation-rekey.test.ts

- credential rotation re-keys the warm pool (closes #104) > rotating the selected credential (A→B) for the same (instance,user,project) spawns a NEW REPL
- credential rotation re-keys the warm pool (closes #104) > ISSUES #49 — an overlay var set to `undefined` is DELETED from the spawned child env (no host leak)
- warm REPL never serves a turn on a stale OAuth token (closes Codex r2 P1) > a SAME-credential-id token REFRESH evicts the stale warm REPL and respawns under the new token
- warm REPL never serves a turn on a stale OAuth token (closes Codex r2 P1) > interactive-Max-login model: claudeConfigDir threads CLAUDE_CONFIG_DIR and the freshness guard stays inert (self-refresh, no env token)

runtime/adapters/claude-code/persistent/__tests__/configured-pty-host.test.ts

- production spawn uses herdr for a complete turn
- production spawn uses bun for a complete turn

runtime/adapters/claude-code/persistent/__tests__/pane-handle-persistence.test.ts

- the registry row records the current child terminal > writes the handle a durable host issued
- the registry row records the current child terminal > CLEARS a stale handle when the new child has none
- a pane is OWNED by whoever serves it, however that session came to exist > an actively-served FRESH SPAWN blocks an overlapping adopter
- a pane is OWNED by whoever serves it, however that session came to exist > ...and blocks one IN THE SAME PROCESS, which is the supported case the pid shortcut broke
- a pane is OWNED by whoever serves it, however that session came to exist > A FRESH SPAWN LOSES THE CONTEST for a row another gateway owns, and ends its own child
- a pane is OWNED by whoever serves it, however that session came to exist > ...but a REPLACEMENT SPAWN is not refused by its OWN predecessor's claim
- a pane is OWNED by whoever serves it, however that session came to exist > a REPLACEMENT SPAWN clears ownership its predecessor left behind
- a pane is OWNED by whoever serves it, however that session came to exist > a REPLACEMENT SPAWN inherits no part of the dead child's ownership
- a pane is OWNED by whoever serves it, however that session came to exist > ...and an ordinary spawn with no competitor claims, serves, and gives it back on exit
- an ownership transition that could not hold the lock writes NOTHING > a spawn that cannot RESERVE its key refuses before starting anything
- an ownership transition that could not hold the lock writes NOTHING > a spawn that RESERVED but could not RECORD ownership kills the child it made
- an ownership transition that could not hold the lock writes NOTHING > ...and with the lock held the same spawn serves normally
- an ownership transition that could not hold the lock writes NOTHING > a child exit that cannot hold the lock leaves the row exactly alone
- an ownership transition that could not hold the lock writes NOTHING > ...and with the lock held that same exit disowns the row
- a spawn RESERVES the session key before any process exists > the loser never calls PtyHost.spawn at all
- a spawn RESERVES the session key before any process exists > ...and an uncontended spawn still spawns
- a spawn RESERVES the session key before any process exists > a reservation whose holder DIED does not wedge the key
- an ownership write that did not LAND is a refusal, however it failed > a non-ENOENT READ failure (the registry path is a directory) refuses and ends the child
- an ownership write that did not LAND is a refusal, however it failed > a THROWN save refuses and ends the child too
- an ownership write that did not LAND is a refusal, however it failed > ...and a healthy registry still records ownership and serves
- a spawn that FAILS READINESS deletes only its own pool entry (#539 r56) > a replacement published during the readiness window survives the failure
- the representations of ownership agree > all four name the same owner while it serves, and three of four release on a fence
- a refused contender leaves the winner able to be answered > an overlapping ADOPTER via direct leaves the winner credential intact
- a refused contender leaves the winner able to be answered > an overlapping ADOPTER via boot gate leaves the winner credential intact
- a refused contender leaves the winner able to be answered > a FRESH SPAWN that loses the reservation does not strip the live session's credential
- an adoption stands down for a spawn that is already in flight > refuses, hands its child back, and leaves the pane and the row alone

runtime/adapters/claude-code/persistent/__tests__/tool-bridge.test.ts

- P0-1 native-MCP tool bridge — spawn wiring > attaches a SECOND mcpServers entry + manifest + --allowedTools when enabled
- P0-1 native-MCP tool bridge — spawn wiring > SECURITY: an opted-OUT substrate gets NO bridge even when one is wired
- P0-1 native-MCP tool bridge — spawn wiring > no-op when enabled but no bridge is wired (LLM-less / pre-compose)
- P0-1 native-MCP tool bridge — reply-sink dispatch routes > /tools returns the wired bridge schemas (empty when unwired)
- P0-1 native-MCP tool bridge — reply-sink dispatch routes > /tool-call dispatches against the registry and returns a structured result
- P0-1 native-MCP tool bridge — reply-sink dispatch routes > /tool-call bridge grant: ungranted dispatch is refused
- P0-1 native-MCP tool bridge — reply-sink dispatch routes > /tool-call bridge grant: granted dispatch succeeds
- P0-1 native-MCP tool bridge — reply-sink dispatch routes > /todo-sync bridge grant: ungranted dispatch is refused
- P0-1 native-MCP tool bridge — reply-sink dispatch routes > /todo-sync bridge grant: granted dispatch succeeds
- P0-1 native-MCP tool bridge — reply-sink dispatch routes > /tool-call returns ok:false (not an HTTP fault) when the handler throws
- P0-1 native-MCP tool bridge — reply-sink dispatch routes > /tool-call 503s when no bridge is wired; 400s on a missing tool_name
- P0-1 native-MCP tool bridge — reply-sink dispatch routes > threads the calling session’s ACTIVE project scope into dispatch.project_id (P0 work-board fix)

runtime/adapters/claude-code/persistent/__tests__/persistent-repl-substrate.test.ts

- PersistentReplSubstrate — conformance > kills local-flag and queue-after mutations: additional input hits /message before completion
- PersistentReplSubstrate — conformance > tool_resolution is internal and respondToTool throws
- PersistentReplSubstrate — conformance > a turn yields token + completion carrying substrate_instance_id and session
- PersistentReplSubstrate — reply→completion bridge > drain returns exactly the reply text
- PersistentReplSubstrate — multi-turn context persists (one warm REPL) > 3 turns reuse ONE REPL and a later turn sees earlier turns
- PersistentReplSubstrate — per-instance isolation > different keys spawn different REPLs with independent state
- PersistentReplSubstrate — per-turn timeout override (AgentSpec.turn_timeout_ms) > a per-spec turn_timeout_ms overrides a long construction-time turnTimeoutMs
- PersistentReplSubstrate — a delayed reply from a timed-out turn does not complete the NEXT turn (Codex GPT-5 r4 P2) > a stale /reply that lands while the next turn is parked pre-inject is dropped, not misattributed
- PersistentReplSubstrate — a delayed reply from a timed-out turn does not complete the NEXT turn (Codex GPT-5 r4 P2) > a stale /reply that lands DURING turn 2 inject is rejected by turn-id correlation
- PersistentReplSubstrate — liveness keepalive > emits periodic status keepalives while a SILENT turn is in flight (child alive)
- PersistentReplSubstrate — dev-channel MCP handshake race (P0 2026-06-26) > forces MCP_CONNECTION_NONBLOCKING=false on the REPL spawn (claude AWAITS the dev-channel handshake before turn 1)
- PersistentReplSubstrate — dev-channel MCP handshake race (P0 2026-06-26) > END-TO-END SMOKE: a real LLM turn completes through the substrate — healthz-200 alone is NOT proof the LLM path is alive
- PersistentReplSubstrate — activity-based (inactivity) turn timeout > keeps an ACTIVE turn alive past the inactivity window (PTY activity resets the deadline)
- PersistentReplSubstrate — activity-based (inactivity) turn timeout > abandons a GENUINELY frozen turn after the inactivity window (no PTY activity)
- PersistentReplSubstrate — activity-based (inactivity) turn timeout > enforces the ABSOLUTE CEILING even while the turn keeps producing PTY output
- a malformed error STAMP cannot crash the error path (#539 r43) > a stamp that is not a taxonomy member yields an ordinary error event, and the stream CLOSES
- configured production host carries a complete REPL turn

runtime/adapters/claude-code/persistent/__tests__/ritual-auto-approve-gate.test.ts

- ritual auto-approve gate (task 6 / T5 write-containment) > DEFAULT (flag unset): the `tool-use-approve` auto-approver IS registered
- ritual auto-approve gate (task 6 / T5 write-containment) > disableToolUseAutoApprove: true — the auto-approver is ABSENT, wedge-recovery stays

runtime/adapters/claude-code/persistent/__tests__/import-warm-session-reset.test.ts

- PersistentReplSubstrate — reset_context_per_turn (import warm-session) > reuses ONE warm REPL across chunks and writes /clear before each REUSED turn
- PersistentReplSubstrate — reset_context_per_turn (import warm-session) > a REFUSED /clear is reported and the import proceeds — never silently skipped
- PersistentReplSubstrate — reset_context_per_turn (import warm-session) > CONTROL — when the submit is accepted, nothing is reported as failed
- PersistentReplSubstrate — reset_context_per_turn (import warm-session) > the default warm substrate (no flag) writes NO /clear — opt-in only

runtime/adapters/claude-code/persistent/__tests__/ephemeral-oneshot-isolation.test.ts

- PersistentReplSubstrate — ephemeral one-shot isolation (Argus r4 BLOCKER) > two session-less one-shots on ONE ephemeral substrate do NOT share a transcript
- PersistentReplSubstrate — ephemeral one-shot isolation (Argus r4 BLOCKER) > a third one-shot still spawns fresh (no accumulation across many calls)
- PersistentReplSubstrate — ephemeral one-shot isolation (Argus r4 BLOCKER) > a dispatch carrying a real spec.session pools even on an ephemeral substrate (warm multi-turn)
- PersistentReplSubstrate — ephemeral one-shot isolation (Argus r4 BLOCKER) > the default (non-ephemeral) substrate still warm-reuses across session-less turns
- PersistentReplSubstrate — ephemeral CRASH-path isolation (Argus r5 BLOCKER) > ephemeral dispose unlinks its temp config files (IMPORTANT-1: no unbounded tmp-file leak)

runtime/adapters/claude-code/persistent/__tests__/evict-deletes-only-its-own-entry.test.ts

- a turn that loses the pool is still subject to the reuse guards > is not handed a winner whose tool surface it never asked for

runtime/adapters/claude-code/persistent/__tests__/pool-key-namespace.test.ts

- PersistentReplSubstrate — per-(user,project) isolation + persistence (behavioral) > two distinct (user, project) triples spawn two REPLs; the same triple reuses one
- PersistentReplSubstrate — per-(user,project) isolation + persistence (behavioral) > a different cwd for the same identity does NOT fork the REPL
- PersistentReplSubstrate — per-(user,project) isolation + persistence (behavioral) > a router turn and a conversational turn for the same identity do NOT collapse

runtime/adapters/claude-code/persistent/__tests__/sink-restart-survival.test.ts

- sink port — per instance, never ephemeral (#537) > a sink given ONLY a tokenPath binds the DERIVED port — the derivation, not the fixture
- sink port — per instance, never ephemeral (#537) > sequential sink instances agree, and the second authorizes a child the FIRST baked
- sink port — per instance, never ephemeral (#537) > a port already in use FAILS LOUDLY and binds nothing else
- sink port — per instance, never ephemeral (#537) > a sink that cannot bind still leaves the persisted token intact for the next try
- sink port — per instance, never ephemeral (#537) > two concurrent starts share ONE attempt — the loser never sees the winner as EADDRINUSE
- sink port — per instance, never ephemeral (#537) > a concurrent caller inherits a genuine failure rather than inventing a second sink
- sink port — per instance, never ephemeral (#537) > a SECOND home borrows the first sink's coordinates — the documented one-sink-per-process limit
- sink port — per instance, never ephemeral (#537) > a freeing port is adopted within the bounded retry window
- sink token — state-dir placement > the sink records the token path it used, and it is outside any repo tree
- concurrent first startup — the live token IS the persisted token (#537) > when two processes race for the PORT too, the one that BOUND it holds the persisted token
- a credential names WHICH session; a session id names nothing (#537) > an orphan presenting a LIVE session's id — lifted from the process table — is refused
- a credential names WHICH session; a session id names nothing (#537) > an orphan whose session has since RESPAWNED is refused, though the id is unchanged
- a credential names WHICH session; a session id names nothing (#537) > a replacement registered with NO unregister still revokes the displaced credential
- a credential names WHICH session; a session id names nothing (#537) > the LEGITIMATE child still succeeds on every privileged route, with its scope
- a credential names WHICH session; a session id names nothing (#537) > a credential is accepted even when the body names a DIFFERENT session
- a credential names WHICH session; a session id names nothing (#537) > unregistering a session revokes its credential immediately — the reap has teeth
- the OTHER direction — the gateway reaching a surviving child (#537) > the PRODUCTION inject path sends THIS CHILD'S credential, in the request the child expects
- the OTHER direction — the gateway reaching a surviving child (#537) > a child holding a DIFFERENT token refuses the production inject, and injectMessage says so

runtime/adapters/claude-code/persistent/__tests__/adopted-repl-serves-a-turn.test.ts

- (unnamed)

runtime/adapters/claude-code/persistent/__tests__/repl-supervision.test.ts

- S2 supervision — health probe has a deadline (Codex P2) > a dev-channel that accepts but never answers /health resolves false within the timeout
- S2 supervision — health probe has a deadline (Codex P2) > a healthy /health resolves true

runtime/adapters/claude-code/persistent/__tests__/gateway-shutdown-survival.test.ts

- a surviving child is handed OVER, not merely left alone > (unnamed)

runtime/adapters/claude-code/persistent/__tests__/boot-adoption.test.ts

- (unnamed)
