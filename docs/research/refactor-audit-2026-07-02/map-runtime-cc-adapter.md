# Subsystem map: runtime-cc-adapter (`runtime/adapters/`)

Audited 2026-07-02 against `main` @ d30280c. All paths relative to `/Users/ryan/repos/neutron-open`.

---

## 1. Purpose & responsibilities

`runtime/adapters/` holds the three concrete implementations of the locked `Substrate` seam
(`runtime/substrate.ts:133-135` — `start(spec: AgentSpec): SessionHandle`):

1. **`claude-code/`** — THE production substrate. Hosts one persistent interactive `claude`
   REPL per warm-pool key `(substrate_instance_id, user_id, project_id, credential_identity)`
   over a PTY, drives each turn through a per-session loopback MCP "dev-channel", and bridges
   the REPL's `reply()` tool call onto exactly one `{token}+{completion}` event pair
   (`persistent/persistent-repl-substrate.ts:10-27`). It is the *sole* spawn shape — the
   legacy per-turn `claude -p` transport was hard-deleted in the S3 rip-replace
   (`claude-code/index.ts:7-12`); an interactive Max session is billing-exempt where
   `claude -p` is capped.
2. **`gpt-5-5-api/`** — OpenAI Responses API adapter (streaming SSE + `previous_response_id`
   resume + in-adapter model rotation + an MCP shim that makes external tool calls look
   `internal`). Declared risk mitigation for "Anthropic blocks the hosted-CC pattern"
   (`gpt-5-5-api/index.ts:21-23`).
3. **`gpt-5-5-codex-cli/`** — Codex CLI shell-out adapter (`codex --json`, `--resume`
   via thread id, ChatGPT-OAuth-or-API-key auth with a deliberate empty-env default,
   ISSUES #67, `gpt-5-5-codex-cli/index.ts:25-58`).

The CC adapter additionally owns the whole **session-supervision stack**: persisted REPL
registry, respawn-is-always-resume, a watchdog family (wedge, cwd-drift, API-5xx dead-turn,
session-size, model-update, restart-rate, heartbeat), PTY output-scan detectors (interactive
prompt auto-clear / recovery ladders), and a pending-respawns replay queue with
recovered-reply redelivery.

---

## 2. Module inventory

Non-test source (`wc -l`), grouped:

### 2a. The god file
| file | LOC |
|---|---|
| `claude-code/persistent/persistent-repl-substrate.ts` | **4,009** |

Internal responsibility clusters of that one file (line-anchored):
1. Constants + Ink-normalized TUI signature regexes (164-322)
2. Keystroke actuation + detector dispatch + recovery-ladder launchers (`runOutputScan`,
   `dispatchWedgeRecovery`, `dispatchResumePickerRecovery`) (329-525)
3. Notice surfacing (size alert, rate-limit banner, dead-turn default) (537-633)
4. `PersistentReplSubstrateOptions` — a 60+-field options bag mixing product options,
   DI seams, test injection, and supervision paths (637-865)
5. `ReplToolBridge` late-bound module singleton (914-956)
6. `ReplSink` — module-singleton loopback HTTP server (reply/typing/channel-ready/
   channel-bound/tools/tool-call routes) (958-1100)
7. `ReplSession` — the per-REPL state machine object (1106-1382)
8. Pool + child lifecycle (pool/childByKey/ephemeralSessions/pendingChildKills maps,
   `terminateChild`, `terminatePidGracefully`, env merge, auth fingerprint, `httpHealth`)
   (1384-1574)
9. `spawnSession` — ~515 lines doing config-file generation, tool-bridge attach, argv build,
   scanner registration (6 detectors inline), PTY spawn, death handler, post-spawn assertion,
   size-watchdog start, registry write, ghost-session capture (1576-2090)
10. Spawn wrappers + resume resolution + `getOrSpawnSession` reuse guards (2092-2290)
11. Turn injection + pending-respawns enqueue/replay/drain + redelivery (2292-2558)
12. `poolKeyFor` + ephemeral spawn/dispose (2560-2679)
13. `createPersistentReplSubstrate` — the ~350-line per-turn driver closure (2681-3048)
14. Shutdown + supervision actuation (`respawnReplSession`, respawn gates, registry claim)
    (3050-3439)
15. Wedge watchdog tick + cwd-drift tick + `startReplWatchdog` (3441-3801)
16. Model-update watchdog wiring (3803-3950)
17. Test/operator introspection helpers (3952-4009)

### 2b. Extracted helpers (already well-factored, mostly pure cores)
| file | LOC | role |
|---|---|---|
| `persistent/model-update-watchdog.ts` | 620 | 6h model probe + idle-gated graceful upgrade core |
| `persistent/session-size-watchdog.ts` | 428 | post-compact JSONL size bands + idle auto-`/compact`; also home of `sessionJsonlPath` |
| `persistent/dev-channel.ts` | 392 | the spawned per-session HTTP↔MCP bridge script (`reply`/`send_typing` tools, `/message` inject, `/channel-bound` true-bind signal) |
| `persistent/api5xx-dead-turn-watcher.ts` | 360 | transcript-JSONL tail watcher for mid-turn 5xx |
| `persistent/cwd-drift-watchdog.ts` | 339 | lsof-based live-cwd drift detection core |
| `persistent/session-respawn.ts` | 298 | pure plan/execute respawn core (`planRespawn`/`executeRespawn`) |
| `persistent/orphan-adoption.ts` | 261 | cross-restart pid verify-then-kill (recycled-pid safety) |
| `persistent/rate-limit-banner.ts` | 254 | banner detectors (per-severity edge latch) |
| `persistent/wedged-prompt-detector.ts` | 239 | stuck-interactive-prompt detector + escape/ctrl-c ladder |
| `persistent/wedge-detector.ts` | 220 | REPL-liveness wedge verdict + action decision (pure) |
| `persistent/resume-picker-detector.ts` | 205 | `--resume` stale-id picker escape-then-recover |
| `persistent/hooks/enforce-reply.ts` | 205 | the Stop hook: blocks turn end without `reply()` (lifted verbatim from Nova) |
| `persistent/disk-recovery.ts` | 205 | boot-drain resumability classifier (JSONL mtime/last-real-turn) |
| `persistent/tools-bridge.ts` | 201 | second MCP server script fronting the gateway ToolRegistry |
| `persistent/repl-registry.ts` | 198 | flock-guarded persisted registry (TOCTOU-safe read-modify-write) |
| `persistent/restart-rate.ts` | 193 | crash-loop marker guard |
| `persistent/output-scan.ts` | 193 | detector framework (edge latch, doc-quote strip, bottom-N, stamp-before-actuate) |
| `persistent/post-spawn-assertion.ts` | 186 | 4-stage spawn readiness (alive → channel-ready → /health → channel-bound) |
| `persistent/pending-respawns-queue.ts` | 170 | dropped-inbound replay queue (disk) |
| `persistent/heartbeat-watchdog.ts` | 169 | 100ms mtime heartbeat + event-loop block detector |
| `persistent/admin-respawn-session.ts` | 145 | operator force-respawn wrapper (gateway HTTP surface consumes) |
| `persistent/bun-terminal-host.ts` | 141 | real `Bun.spawn({terminal})` PtyHost |
| `persistent/agent-skills.ts` | 127 | skills dir sync consumed by skill-forge/open composer |
| `persistent/pty-noise.ts` | 118 | PTY noise filtering |
| `persistent/build-repl-argv.ts` | 116 | argv construction (default-deny `--tools`, `--model` last) |
| `persistent/channel-wedge-respawn.ts` | 105 | bounded channel-wedged respawn loop |
| `persistent/session-disk-recovery.ts` | 100 | find-latest-resumable-session disk scan (picker recovery) |
| `persistent/ensure-claude-trust.ts` | 98 | pre-seed trust/bypass dialogs |
| `persistent/pty-ring.ts` | 96 | append-only PTY byte ring |
| `persistent/registry-lock.ts` | 94 | flock(2) via Bun FFI |
| `persistent/turn-id-echo.ts` | 92 | stateless reply correlation + stale-reply debt (dev-channel side) |
| `persistent/wedge-respawn-dispatch.ts` | 84 | plan→execute→mark-in-flight sequencing |
| `persistent/pty-host.ts` | 81 | PtyHost/PtyChild interfaces |
| `persistent/session-capture.ts` | 69 | ghost-session JSONL landing probe |
| `persistent/keystrokes.ts` | 67 | structured key encoding |
| `persistent/event-channel.ts` | 60 | push/pull async Event queue |
| `persistent/respawn-strategy.ts` | 53 | resume-vs-fresh resolution (pure) |
| `persistent/build-settings.ts` | 53 | `--settings` JSON with Stop hook |
| `persistent/session-validation.ts` | 50 | `dashifyCwd` + JSONL existence gate |
| `persistent/in-flight-gate.ts` | 41 | claim/release mutex |
| `persistent/pty-text.ts` | 37 | ANSI/whitespace normalization |

### 2c. Sibling adapters + claude-code root
| file | LOC | note |
|---|---|---|
| `claude-code/index.ts` | 275 | `createClaudeCodeSubstrateAuto` — the public constructor + supervision boot |
| `claude-code/api-key-helper.ts` | 89 | **self-declared deletable** (header, lines 12-21) |
| `claude-code/router-thinking-budget.ts` | 72 | **unwired in production** (see debt #5) |
| `gpt-5-5-api/index.ts` | 204 | Responses adapter |
| `gpt-5-5-api/responses-stream.ts` | 286 | SSE → Event mapping |
| `gpt-5-5-api/mcp-shim.ts` | 149 | external→internal tool-resolution shim |
| `gpt-5-5-api/multi-model-rotation.ts` | 66 | rotation state |
| `gpt-5-5-api/auth.ts` | 37 | key resolution |
| `gpt-5-5-codex-cli/exec.ts` | 289 | spawn + JSONL envelope drain |
| `gpt-5-5-codex-cli/index.ts` | 147 | adapter |
| `gpt-5-5-codex-cli/event-map.ts` | 146 | envelope → Event mapping |
| `gpt-5-5-codex-cli/auth.ts` | 132 | OAuth-file vs API-key resolution (empty-env default) |

Total non-test adapter source: **13,744 LOC**, of which 29% is one file.

---

## 3. Public seams / contracts other subsystems consume

- **The Substrate triple** — `runtime/substrate.ts` (`Substrate`, `AgentSpec`),
  `runtime/session-handle.ts` (`SessionHandle`), `runtime/events.ts` (`Event` union).
  Locked "verbatim per engineering-plan § B.P1"; every drain call site in the gateway/
  onboarding consumes this shape.
- **`createClaudeCodeSubstrateAuto(options)`** (`claude-code/index.ts:207`) — the ONLY
  production constructor. Consumed by `gateway/realmode-composer/build-llm-call-substrate.ts:42`
  (the shared LLM-call primitive), `gateway/realmode-composer/build-import-substrate.ts`,
  `gateway/realmode-composer/build-live-agent-turn.ts`, `open/composer.ts:223-235`
  (Open self-host boot).
- **`deriveReplSupervisionPaths(home)`** (`claude-code/index.ts:185-195`) — the
  `<home>/.neutron/*` state-file layout contract; the gateway boot uses the SAME function
  to mount the admin-respawn endpoint (no path drift).
- **DI notice sinks (runtime→gateway inversion; the substrate never imports `gateway/*`)**:
  `onRecoveredReply`, `onDeadTurnNotice`, `onSizeAlert`, `onRateLimitBanner`,
  `onModelUpdate`, `postWedgeAlert` (`claude-code/index.ts:114-139`,
  `persistent-repl-substrate.ts:664-690`). `RecoveredReply` type is imported by
  `gateway/http/recovered-reply-store.ts:52`.
- **`setReplToolBridge` / `clearReplToolBridgeIf`** (`persistent-repl-substrate.ts:942-956`)
  — late-bound singleton the gateway composition wires with its in-process `McpServer`
  (`gateway/composition/build-core-modules.ts:270`).
- **Operator/boot surface**: `respawnSupervisedSession` via `admin-respawn-session.ts`
  (consumed by `gateway/http/admin-respawn-surface.ts:24`), `shutdownAllPersistentRepls`
  (`gateway/index.ts:6,442`), `drainPendingRespawns`, `requestSessionCompact`,
  `getReplRegistrySnapshot`.
- **`McpToolResolver`** type from `gpt-5-5-api/mcp-shim.ts` (consumed by `mcp/server.ts:15`).
- **`agent-skills.ts`** (consumed by `skill-forge/registrar.ts` and `open/composer.ts:122`).
- **Spawned-script contracts (process boundary, env-configured)**: `dev-channel.ts` and
  `tools-bridge.ts` speak to the in-process `ReplSink` over loopback HTTP with a shared
  `X-Sink-Token`; `hooks/enforce-reply.ts` is wired via the generated `--settings` file.

## 4. Workspace dependencies

**Out (imports from):** only intra-`runtime/` (`substrate.ts`, `session-handle.ts`,
`events.ts`, `models.ts`, `atomic-write.ts`, `constant-time-equal.ts`), the
`@modelcontextprotocol/sdk` (the sole `package.json` dependency of `@neutronai/runtime`),
node builtins, and Bun globals (`Bun.serve`, `Bun.spawn`, `Bun.sleep`, FFI). `substrate.ts`
imports `ToolDef` from `../core-sdk/types.ts` — the one cross-workspace type edge. **No
gateway/persistence/onboarding imports — the layering direction is clean.**

**In (imported by):** `gateway/` (composition, realmode-composer ×3, http ×2, index),
`open/composer.ts`, `onboarding/history-import/job-runner.ts`, `mcp/server.ts` (type only),
`skill-forge/registrar.ts`, `tests/integration/*`.

---

## 5. Session lifecycle state machine (as built)

**Spawn:** `start(spec)` → `getOrSpawnSession(poolKeyFor(opts))` → (reuse guards pass? serve
warm) else evict+`terminateChild`, resolve resume directive (forceResume > picker-miss-fresh >
picker-hit > registry `resolveRespawnStrategy`) → `spawnWithChannelWedgeRespawn` →
`spawnSession`: write per-session `--mcp-config`/`--settings`/tools-manifest to tmpdir →
register session in `ReplSink` **before** spawning → `ptyHost.spawn(buildReplArgv(...))` →
4-stage `assertReplAlive` (child alive → `/channel-ready` → `/health` → `/channel-bound`
i.e. MCP `oninitialized`) → start size watchdog + dead-turn JSONL watcher → write registry
record (clearing `respawn_in_flight_at`) → async ghost-gate flips `has_session:true`.

**Turn:** `acquireTurn()` (per-session mutex) → optional `/clear` interstitial
(`reset_context_per_turn`) → mint `turnId = <incarnation>:<seq>` → `waitForReplIdle` →
`injectMessage` (dev-channel `POST /message {text, turn_id}`) → keepalive interval (status
heartbeats + static-wedge rescan) + activity watchdog (inactivity window on `lastDataAt` +
absolute ceiling) → dev-channel `reply()` → sink `POST /reply {turn_id}` → `onReply`
correlates, pushes `token`+`completion`, closes channel, settles → post-settle enqueue of
dropped inbound if `diedMidTurn`.

**Failure/recovery:** child exit → `onDeath` (retryable error) + identity-guarded eviction;
watchdog tick (15s) probes registry∪owned-pool keys, `detectReplWedged`/`decideWedgeAction`
→ `respawnReplSession` (process-local gate + flock in-flight stamp + 3-per-hour cap with
operator-clearable `capped_at`) → `killChild`(+orphan verify-kill) → `spawnResume` awaits
old child's exit → `--resume`; `drainPendingRespawns` replays dropped inbounds through the
OWNER substrate's options and redelivers the recovered reply via `onRecoveredReply`.

---

## 6. Architectural debt

### P1 — `persistent-repl-substrate.ts` is a 4,009-line god orchestrator (17 clusters)
Evidence: cluster map in § 2a. Every cluster except the driver already has a pure sibling
core; the god file is the mutable-state orchestration layer that never got the same split.
The result: any change to (say) the size watchdog wiring risks the turn driver; the file
holds constants, an HTTP server class, a state-machine class, spawn logic, a turn driver,
three watchdog wirings and a disk queue in a single module scope.
**Sketch:** split along the existing section comments into ~8 modules — `signatures.ts`
(constants/regexes), `repl-sink.ts`, `repl-session.ts`, `spawn.ts` (spawnSession +
wedge-respawn wrapper + scanner registrations table), `pool.ts` (pool maps + terminate +
reuse guards + poolKeyFor + ephemeral), `turn-driver.ts` (the `start()` closure),
`pending-replay.ts`, `supervision.ts` (respawn actuation + watchdog ticks + starts). The
split is mechanical BECAUSE all cross-cluster access already goes through the maps/classes;
the hard precondition is debt item #2.

### P1 — 13 module-global mutable singletons; `Substrate` instances are stateless facades
Evidence: `pool` (1384), `childByKey` (1391), `ephemeralSessions` (1398),
`pendingChildKills` (1404), `sink` (1094), `replToolBridge` (934), `supervisedBySessionKey`
(3115), `respawnGates` (3151), `wedgeAlertState` (3153), `cwdDriftRespawnState` (3157),
`cwdDriftAlertState` (3160), `activeWatchdogs` (3053), `activeModelWatchdogs` (3058).
`createPersistentReplSubstrate` returns a closure over options; ALL state is ambient.
This is load-bearing (per-turn `createPersistentReplSubstrate(opts).start(spec)` calls —
the pattern `replayPendingInbound` itself uses at 2400 — must reuse the same warm pool),
but it has forced a long tail of identity/scoping patches: `unregisterIf` (996),
`clearReplToolBridgeIf` (954), registry-path scoping of watchdog ticks (3553-3556,
3643-3645), owner-resolution in the drain (2498), childByKey compare-and-delete (1933).
**Sketch:** reify one `PoolRuntime` object holding all 13 structures, constructed once at
module scope (preserving ambient-sharing semantics exactly), threaded explicitly into the
split modules. Tests get a fresh runtime; production keeps the single instance. No behavior
change; kills the whole class of "which map did we forget to scope" bugs.

### P2 — `SessionHandle` contract deviation: `iterator.return()` does not propagate cancel on the CC adapter
Contract: `session-handle.ts:8-15` ("Adapters MUST also cancel from inside the events
iterator's `finally` so `iterator.return()` is enough") and `events.ts:11-12`. The
gpt-5-5-api and codex-cli adapters conform (generator `finally { ac.abort() }`,
`gpt-5-5-api/index.ts:172-178`, `gpt-5-5-codex-cli/index.ts:119-125`). The CC adapter's
`events` is an `EventChannel` (`event-channel.ts:45-59`) whose iterator has NO finally and
no link to `handle.cancel()`: a consumer that abandons via `iterator.return()` leaves the
turn active (mutex held, no poison) until the reply lands or the activity watchdog fires.
Today's drains all run to completion or call `cancel()` explicitly, so this is latent —
but it is exactly the kind of divergence a refactor consuming "the contract" would trip on.
**Sketch:** either wrap the channel in a generator with `finally → cancel()` (behavior
change: abandonment would then poison the warm session — must be deliberate) or amend the
contract docs to state the CC adapter's exception. Decide, don't leave silent.

### P2 — `/tool-call` sink route authorizes on the process-wide token, not per-session bridge enablement
Evidence: `persistent-repl-substrate.ts:1036-1062` — the `/tools` + `/tool-call` routes are
handled BEFORE session lookup, gated only by the single `ReplSink.token` (965) shared by
EVERY spawned REPL's config files (`SINK_TOKEN` in each tmpdir mcp-config, 1618-1640). The
`enableToolBridge` security boundary (default-off for import/Trident REPLs,
`persistent-repl-substrate.ts:742-752`) is enforced only by not attaching the bridge MCP
server + `--allowedTools`; a REPL that has Bash/Read (Trident build REPLs do, per
WORKFLOW_FIRE_TOOL_NAMES) can read its own tmpdir mcp-config and POST `/tool-call`
directly, reaching gateway Core tools despite `enableToolBridge:false`. Single-owner
self-host shrinks the blast radius, but the stated sandbox ("a prompt-injection in
imported data can never reach a Core tool", 748-750) is not enforced at the sink.
**Sketch:** require `session_id` on `/tool-call`, look up the session, and refuse unless
`session.toolBridgeActive` — one map lookup, no behavior change for legitimate callers.

### P2 — dormant sibling adapters with zero production consumers
Evidence: `createGptResponsesApiSubstrate` is constructed only in
`tests/integration/adapter-equivalence.test.ts`; `createCodexCliSubstrate` only in its own
unit tests (repo-wide grep). Both are plan-mandated risk mitigation (`substrate.ts:8-18`,
`gpt-5-5-api/index.ts:21-23`) — legitimate to keep, but they are maintained, reviewed code
whose conformance is only pinned by a mocked-shape test. The refactor should either wire a
conformance suite that all three adapters run against (extending adapter-equivalence) or
explicitly mark them frozen.

### P2 — unwired router thinking-budget fix / self-declared dead auth helper
- `claude-code/router-thinking-budget.ts` exports (`routerThinkingEnvOverlay`, 68-72) are
  consumed ONLY by their own test. The documented wiring ("threads this as `extra_env`
  (`gateway/index.ts`)", 26-27) does not exist: `build-llm-call-substrate.ts:341` declares
  `extra_env` but repo-wide NO production caller passes it, and nothing sets
  `MAX_THINKING_TOKENS` on any spawn. Either the router-hang fix (20-40s classifier
  thinking, root-caused 2026-06-05) was silently lost in a later rewire, or the module +
  the `extra_env` seam are dead. Needs a decision + a wiring test either way.
- `claude-code/api-key-helper.ts` header (12-21) says its sole consumer was retired
  2026-06-24 and "this file can be deleted once nothing else needs the loader"; grep
  confirms only its own test imports it. Delete candidate.

### P2 — transcript-path/recovery logic spread across five modules
The `<projectsDir>/<dashifyCwd(cwd)>/<sessionId>.jsonl` layout is derived in at least four
places: `session-validation.ts` (dashifyCwd + existence gate), `session-size-watchdog.ts`
(`sessionJsonlPath` — an odd home for a path helper), `persistent-repl-substrate.ts:1910`
(inline join for the dead-turn watcher), `disk-recovery.ts` and `session-disk-recovery.ts`
(two separately-named disk-recovery classifiers with overlapping missions). The projects-dir
root resolution was already bitten by divergence once (Codex P2, fixed by
`resolveTranscriptProjectsDir`, `persistent-repl-substrate.ts:344-359`) — but that helper
lives in the god file, not next to the path logic.
**Sketch:** one `transcript-paths.ts` (root resolution + jsonl path + dashifyCwd) consumed
by all five; merge/rename `disk-recovery.ts` vs `session-disk-recovery.ts` so the boot-drain
classifier and the picker-recovery scanner are distinguishable.

### P2 — constructor-with-side-effects on the public seam
`createClaudeCodeSubstrateAuto` (`claude-code/index.ts:243-273`) mkdirs the state dir,
registers supervision, and starts two watchdog families as a side effect of *constructing a
substrate*. It is idempotent per registry/state path (`startReplWatchdog`:3717-3719,
`startModelUpdateWatchdogForInstance`:3866-3868), and callers construct per-dispatch, so
behavior is fine — but "build a value" and "arm process-lifetime supervision" are fused,
which makes the composition order invisible and forces the idempotence maps (debt #2).
**Sketch:** split into `createClaudeCodeSubstrate(opts)` + `armSupervision(opts)` called
from the composer; keep a compat wrapper with today's name/behavior during the refactor.

### P3 — naming collisions in the watchdog family
Three unrelated "wedge" concepts: `wedge-detector.ts` (REPL liveness verdict),
`wedged-prompt-detector.ts` (stuck interactive TUI prompt), `channel-wedge-respawn.ts`
(MCP-never-bound spawn failure) — plus `wedge-respawn-dispatch.ts`. Correct code, hostile
vocabulary for newcomers. Similarly `gpt-5-5-*` directory names bind adapter identity to a
model generation (the OpenAI adapter serves any Responses model via `model_preference`).

### P3 — `AgentSpec` fields with adapter-specific semantics
`spec.session` is honored by gpt-5-5-api (previous_response_id) and codex-cli (`--resume`),
deliberately IGNORED by the shipped CC adapter (pool-key continuity,
`substrate.ts:52-61`) except as the ephemeral gate (`persistent-repl-substrate.ts:2712`);
`turn_timeout_ms`/`turn_absolute_ceiling_ms` are CC-only; `metering_context` is
Private-substrate-only with a CC fallback nobody populates (`substrate.ts:93-101`).
All documented, but the "one contract" is really three dialects — a conformance table
belongs in the contract file.

---

## 7. Test posture

Strong — this is the best-tested subsystem I'd expect to find: 48 test files /
~10,660 LOC under `persistent/__tests__` alone, plus per-adapter suites and two repo-level
integration tests (`tests/integration/adapter-equivalence.test.ts`,
`no-direct-anthropic-api.test.ts`).

- Pure cores (detectors, respawn planning, registries, turn-id echo, keystrokes, disk
  classification) each have dedicated unit suites.
- Full substrate flows are driven through an injected fake `PtyHost` + the REAL
  `ReplSink`/dev-channel seam (`repl-supervision.test.ts` 1,150 LOC,
  `persistent-repl-substrate.test.ts` 893, `ephemeral-oneshot-isolation`,
  `warm-session-abandon-poison`, `credential-rotation-rekey`, `pool-key-namespace`,
  `stateless-correlation`, `tool-restriction`, `tool-bridge`).
- The 2026-06-26 channel-bind P0 has an opt-in REAL-PTY e2e regression guard
  (`dev-channel-pty-bind.e2e.test.ts`, `NEUTRON_PTY_E2E=1`) — skipped in CI (needs a real
  `claude` + credentials), so the true bind path is only proven on a dev machine.

**Gaps:** no test pins `iterator.return()` semantics on the CC handle (debt #3); no test
exercises `/tool-call` from a non-bridge session (debt #4); `router-thinking-budget` has
tests but no wiring test, which is exactly how its wiring could vanish (debt #5); real-CLI
behavioral drift (new claude TUI strings/pickers) is inherently untestable in CI — the
signature constants (164-263) are the fossil record of that risk. Timing-driven tests use
injected budgets/fake hosts, so flake risk is low; the known CI flake (PGLite boot) is
outside this subsystem.

---

## 8. Load-bearing subtleties a refactor MUST NOT break

1. **Exactly-one-completion**: the `enforce-reply` Stop hook guarantees one `reply()` per
   channel turn (`hooks/enforce-reply.ts:189-198`); `onReply` maps it 1:1 to
   `token`+`completion` (1317-1327). Notice turns (`system="notice"|"true"`) are exempt
   (enforce-reply:32,176-179). The hook must match `…__reply` MCP-form names (:105) and
   must NOT skip `isMeta` entries (:156) — both are recorded incidents.
2. **Turn-id correlation** `<incarnation>:<seq>` (877-912, 1296-1316): rejects stragglers
   within an incarnation (pre-inject-park AND inject-in-flight windows) and across resume
   incarnations (per-spawn nonce). The dev-channel echoes it via `_meta` primary +
   reset-per-turn scalar fallback with stale-reply debt (`dev-channel.ts:25-48`,
   `turn-id-echo.ts`). Never re-derive correlation from ordering/FIFO.
3. **Ordering: register in sink BEFORE spawn** (1678-1694) so a fast `/channel-ready`
   can't race; **dev-channel sets the turn scalar only AFTER `mcp.notification` resolves**
   (`dev-channel.ts:259-268`) so a failed notify can't desync.
4. **Identity-guarded eviction everywhere**: a respawn re-attaches the SAME sessionId, so
   the old child's death handler uses `unregisterIf` (996), `childByKey` compare-delete
   (1931-1933), and `(await pooled) === session` (1934-1941). Blind deletes reintroduce the
   P2-3 resume race.
5. **One-owner-per-transcript**: the `--resume` replacement never spawns until the old
   child is dead — `pendingChildKills` consumed by `spawnResume` (3271-3299), await in the
   reuse-guard eviction (2260-2267), await before rethrow on channel-wedged (1972-1979),
   post-SIGKILL pid poll in `terminatePidGracefully` (1436-1471) with re-verified identity
   before SIGKILL (recycled-pid TOCTOU).
6. **Abandon-poison**: `cancel()` and the turn watchdog poison the warm session
   (2938-2942, 3027-3038); `getOrSpawnSession` evicts poisoned sessions (2246-2258). Without
   this, one abandoned turn permanently desyncs the warm REPL (the production hang).
7. **Activity-based timeout semantics**: `lastDataAt` advances on every PTY byte (1868-1871);
   the keepalive pushes `status` events but deliberately does NOT touch `lastDataAt`
   (2917-2921) — conflating them would blind the freeze detector. Ceiling coerced ≥ idle
   window (2725-2730). Keepalive must stay below the synthesis idle window (281-290).
8. **Idle gating**: `waitForReplIdle` before inject (2816-2820, back-to-back-turn drop
   race); the `/clear` interstitial's idle→write→forced-beat→idle sequence (2768-2775);
   `/clear` must go via PTY write, never the dev-channel (it would become content, 725-733).
9. **Detector framework invariants** (`output-scan.ts:12-31`): edge-latched (no time-dedupe
   re-fire), doc-quote strip, bottom-N windows (the rate-limit-options bottom-30 is
   load-bearing — the picker text never scrolls away after `3` stops CC, 1788-1798),
   latch/debounce stamped BEFORE actuation so a transport throw can't double-send a
   keystroke (366-368). The compact-resume picker is ARROW-driven — `down`+`enter`, never a
   digit (253-263). The wedged-prompt and resume-picker detectors carry no keys — their
   recovery is a ladder, guarded by `wedgeRecovering`/`resumePickerRecovering` async flags.
10. **Registry stamps**: `respawn_in_flight_at` must be cleared on spawn completion
    (2050-2058), on refused/threw dispatch (3409-3411), and on async resume-spawn failure
    (2280-2288) — a latched stamp blocks recovery for the TTL. The cap (3/h → `capped_at`)
    is operator-cleared only; `force` bypasses cooldown/cap but NEVER the in-flight gates
    (3337-3366).
11. **Ephemeral one-shots**: gate = `options.ephemeral && spec.session === undefined`
    (2712); never pooled, supervision stripped (2644-2646), and crucially NEVER enqueued to
    pending-respawns — a replayed internal prompt would be redelivered to the USER's chat
    topic (cross-purpose bleed, 2861-2877). Disposed in the driver's `finally` AFTER the
    terminal event (2984-2994).
12. **Pending-respawns drain**: owner options resolved by `entry.sessionKey` — never the
    drain caller's options (2358-2373); unregistered entries retained; single-shot claim
    re-reads the CURRENT entry so a superseded inbound isn't lost and nothing replays twice
    (2527-2548).
13. **Pool key**: NUL-separated; `cwd` is derived, NOT keyed (642-644); legacy 2-part
    fallback shape when no identity fields are threaded (2595-2609) — supervision fixtures
    key on whatever this returns.
14. **Reuse guards are spawn-time properties**: tool surface (`--tools` value), bridge
    attachment, auth fingerprint (hashed token, empty ⇒ inert) — checked on EVERY dispatch
    (2242-2254); the credential guard is the PRIMARY prod stale-token defense (the
    `claudeConfigDir` self-refresh path is dormant plumbing, `claude-code/index.ts:95-99`).
15. **Spawn readiness**: the TUI string "no MCP server configured with that name" is a
    BENIGN claude 2.1.186 warning — the only true bind signal is `/channel-bound` from
    `mcp.oninitialized` (`dev-channel.ts:343-360`, 1944-1962). Never reintroduce a TUI-scan
    gate. `MCP_CONNECTION_NONBLOCKING='false'` is set unconditionally as belt-and-suspenders,
    documented as NOT the fix (1700-1722).
16. **dev-channel self-termination** on transport close / stdin EOF (dev-channel:366-380)
    — the fix for the 632-orphan / ~19 GB leak class. Any dev-channel refactor keeps both
    hooks.
17. **argv construction**: `--tools` ALWAYS emitted (default-deny; empty ⇒ `--tools ""`),
    `--allowedTools` does NOT restrict built-ins (only grants MCP namespaces), `--model`
    emitted LAST (`build-repl-argv.ts:92-115`).
18. **`spec.session.id` is deliberately not consumed by the CC adapter** — continuity is
    pool-key + registry (`substrate.ts:52-61`). A refactor that "fixes" this breaks warm
    pooling.
19. **CC completions carry `ZERO_USAGE`** (186, 1320-1325) — downstream metering treats
    absent/zero as "not metered"; don't invent usage.
20. **Watchdog scoping**: ticks filter the module-global pool by
    `supervisedBySessionKey.get(k)?.replRegistryPath === registryPath` (3553-3556) so
    instance A never respawns instance B's sessions; heartbeat `utimesSync` runs FIRST in
    its tick (`heartbeat-watchdog.ts:19-25`).

---

## 9. What the refactor should do here

1. **First reify the module state** (debt #2, `PoolRuntime`) — it is the precondition that
   makes the god-file split (debt #1) mechanical instead of risky. Keep ONE process-level
   instance so per-turn re-construction semantics are byte-identical.
2. **Split `persistent-repl-substrate.ts` along its own section comments** (§ 2a clusters →
   ~8 modules). The invariant comments are excellent and must travel with the code they
   guard; the § 8 list above is the acceptance checklist.
3. **Close the two contract holes deliberately**: `iterator.return()` cancellation (decide
   + test) and `/tool-call` per-session bridge authorization (one lookup).
4. **Prune confirmed dead code** (`api-key-helper.ts`) and resolve the
   `router-thinking-budget` question — restore the wiring with a test, or delete the module
   and the `extra_env` seam together.
5. **Consolidate transcript-path logic** into one module; rename the wedge/recovery family
   for one concept per word.
6. **Add a three-adapter conformance suite** (extend `adapter-equivalence.test.ts`) so the
   dormant adapters either stay honest or get explicitly frozen; document the AgentSpec
   dialect table in `substrate.ts`.
7. **Split construct-vs-supervise** on `createClaudeCodeSubstrateAuto` behind a compat
   wrapper.

Do NOT: change the pool key composition (2595), the event ordering (`status* → token →
completion` / terminal `error`), the tmpdir config lifecycle, the enforce-reply hook logic,
or any detector signature/window/keys — each encodes a paid-for incident.
