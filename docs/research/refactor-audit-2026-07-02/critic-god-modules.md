# God-Modules Critic — Decomposition Plans for the 10 Monster Files

Audit dimension: god-modules / monster-file decomposition.
Repo: /Users/ryan/repos/neutron-open (read-only). All line numbers verified against working tree on 2026-07-02.

Line counts (verified via `wc -l`):

| File | Lines |
|---|---|
| onboarding/interview/engine.ts | 10,078 |
| runtime/adapters/claude-code/persistent/persistent-repl-substrate.ts | 4,009 |
| open/composer.ts | 3,732 |
| gateway/http/chat-bridge.ts | 3,113 |
| app/app/projects/[id]/docs.tsx | 2,426 |
| gateway/git/project-backup-store.ts | 2,246 |
| app/app/admin.tsx | 2,188 |
| onboarding/history-import/job-runner.ts | 2,103 |
| cores/free/email/src/backend.ts | 2,003 |
| landing/server.ts | 1,516 |

## Cross-cutting observations (read these before any per-file plan)

### A. The repo has already tried decomposition once, and the attempt is a cautionary tale
The one prior extraction pass on engine.ts (the "R5/P2-4" pass) moved 37 methods into
engine-import-routing.ts (2,234 ln), engine-persona.ts (1,155), engine-slug.ts (1,086) as free
functions taking `self: EngineInternals` — a 300-line structural "friend interface"
(onboarding/interview/engine-internals.ts:2027, header self-describes: "Declares every field +
cross-called method the extracted import-routing bodies access through `this.` (now `self.`).
PURE structural move — no new behavior"). engine-import-routing.ts contains **165 `self.`
references**; engine.ts still `implements EngineInternals` (engine.ts:540) and keeps one-line
delegators. Net effect: line count moved, coupling did not. Every signature change now needs
three coordinated edits (method body, EngineInternals declaration, delegator). Any further
"split the god file" work that repeats this pattern makes things worse, not better. The audit
must define done-criteria for a split (see finding 12).

### B. Contracts are trapped inside the god files — extract types first, bodies second
Several monster files are monster files partly because they are the *home of shared types* that
a dozen other modules import:
- landing/server.ts:170-699 owns ChatInbound/ChatOutbound/ChatBridge/PendingChatClaim, imported
  by gateway/http/chat-bridge.ts:45, gateway/http/recovered-reply-store.ts:51,
  gateway/realmode-composer/build-live-agent-turn.ts:67, gateway/proactive/button-store-sink.ts:36,
  reminders/outbound.ts:24, open/composer.ts:214 (verified by grep).
- onboarding/interview/engine-internals.ts:696 owns ImportJobRunnerHook, implemented both by the
  live synthesis runner (gateway/realmode-composer/build-synthesis-import-runner.ts) and the dead
  per-chunk job-runner.
- gateway/http/chat-bridge.ts:162 owns WebChatSenderRegistry, consumed by reminders/outbound,
  gateway/proactive, gateway/comments.
- gateway/http/chat-bridge.ts:1009 imports ChatCommandFilter sideways from app-ws-surface.ts.
A "phase 0" pure-type extraction (move interface + JSDoc, leave a re-export) is near-zero-risk,
unblocks every body split, and lets the splits proceed in parallel. Do it first.

### C. In these files, comments ARE the spec
persistent-repl-substrate.ts, chat-bridge.ts, job-runner.ts, and project-backup-store.ts carry
incident-derived invariant documentation (e.g. the Argus r1/r2 mutex blockers at
project-backup-store.ts:425-435 and 606-635; the one-reply-per-turn and turn-id-correlation
notes in the REPL substrate; the "engine.start BEFORE jti claim" ordering in chat-bridge). The
landing/server.ts ChatBridge JSDoc is the *only written spec* for gateway behavior. Every plan
below requires invariant comments to travel with the code they protect, verbatim.

---

## 1. onboarding/interview/engine.ts (10,078 ln) — P0

### Actual structure (verified method map)
`InterviewEngine` class at engine.ts:540, ~102 methods. Cluster boundaries (start line = method
start, end = next method):

| Cluster | Span | Size |
|---|---|---|
| start()/reconnect/re-emit recovery | 688–1720 (`start` 688–1460, `reuseActivePrompt` 1461, `recoverResolvedAnswer` 1604) | ~1,030 |
| **acceptChoice (DEAD)** | 1721–1988 | 268 |
| advance()/normalAdvance/tick/import-poll | 1989–3086 (`advance` 1989, `tick` 2145, `pollImportRunningTick` 2194, `notifyImportUpload*` 2326–2604, `normalAdvance` 2680) | ~1,100 |
| router consult/whitelist/dispatch | 3087–3792 (`shouldConsultRouter` 3087, `whitelistRouterStateDelta` 3191, `dispatchRouterDecision` 3306–3792) | ~700 |
| nudges + source-switch re-emits | 3793–4084 | ~290 |
| consumeChoice per-phase dispatcher | 4085–4971 | 887 |
| wow dispatch + fallback | 4972–5599 | 628 |
| final handoff | 5600–6093 | 494 |
| personality/agent-name choices | 6094–6134 | 41 |
| projects_proposed | 6135–6672 | ~540 |
| import offered/paste/running/retry | 6673–6946 + 7292–7361 | ~340 |
| gap-fill | 6947–7291 | 345 |
| phase prompt emission | 7362–7490 | 129 |
| resume prompts | 7491–7788 | ~300 |
| LLM spec resolution | 7789–8517 (incl. `resolvePhasePromptSpecUncached` 7808–8423, a **615-line method**) | ~730 |
| suggestion caches | 8518–8727 | ~210 |
| slug-chosen (managed-only) | 8728–8843 | ~115 |
| max-oauth/credentials | 8844–9444 | ~600 |
| persona synth/review | 9445–9543 | ~100 |
| module-level free helpers | 9544–10078 | ~530 |

### What is architecturally wrong
Three compounding problems:
1. **Half-finished friend-interface decomposition** (see cross-cutting A). The class + the three
   sibling files + EngineInternals form one 16,900-line logical unit with a fake boundary.
2. **Dead and unreachable-mode surface inflates the split**: `acceptChoice` (1721–1988) has zero
   production callers (verified: `grep -rn "\.acceptChoice("` outside tests → nothing; chat-bridge
   drives `engine.advance` at chat-bridge.ts:1942/1996). engine-slug.ts (1,086 ln) plus
   `consumeSlugChosenChoice`/`advanceFromSlugChosen`/`reEmitSlugChosen` (8728–8843) serve phases
   open mode never enters (phase.ts open-mode table). Deleting before splitting removes ~1.6k
   lines and their delegator/interface entries for free.
3. **Two live onboarding architectures share the class**: Path-1 live-session (open/composer.ts
   wiring, post-turn extractor) bypasses the phase machine for conversation, while chat-bridge
   still drives the full engine for `web:` topics. The fork decision (shrink the engine to the
   import pipeline + resume/timeout bookkeeping vs. keep both) determines *which half of the
   cluster map is worth extracting at all*. Splitting before deciding does the work twice.

### Extraction plan (behavior-preserving)
Order: (0) decide the Path-1 fork; (1) delete dead surface (`acceptChoice` — port its tests onto
`advance`; slug flow behind the managed-disentanglement decision); (2) phase-0 type moves:
ImportJobRunnerHook, profile-pic hooks, LlmCallFn out of engine-internals/phase-spec-resolver
into a neutral `onboarding/contracts.ts`; (3) carve flow modules **along the cluster table
above**, one at a time, each as a class/factory taking 2–4 narrow capability interfaces instead
of `self: EngineInternals`:
- `StateAccess` (get/upsert phase_state via the state store — the whitelist at engine.ts:372-392
  and the crash-resume watermark semantics live here),
- `PromptEmitter` (emitPhasePrompt/sendAgentText/re-emit family),
- `TranscriptSink`, `Clock/Uuid`.
Suggested module cuts, in rising risk order: `SpecResolutionFlow` (7789–8727 + suggestion
caches — self-contained, cache-lifecycle invariant is `clearResolvedSpecCache()` at top of
start/acceptChoice), `MaxOauthFlow` (8844–9444), `FinalHandoffFlow` (5600–6093 — choice-membership
check BEFORE buttonStore.resolve at 437–443 must move verbatim), `WowFlow` (4972–5599 —
watermark upsert shares the phase-advance write), `GapFillFlow`, `ResumeFlow`,
`ProjectsProposedFlow`, and finally the advance/router/consumeChoice core. As each flow moves,
its EngineInternals entries and delegators are *deleted*, not re-declared — EngineInternals must
shrink monotonically to zero. (4) Fold the three existing sibling files into the same pattern.
(5) Collapse the six parallel per-phase tables (consumeChoice dispatcher, dispatchRouterDecision,
PHASE_INTENTS, PHASE_KNOWLEDGE, STATIC_PHASE_SPECS, interaction-mode) into one per-phase
descriptor with an exhaustiveness check — this is the step that makes the split durable.

### Load-bearing subtleties a split can silently break
- buttonStore.resolve `was_new` idempotency barrier gating router state_delta merge
  (engine.ts:4111-4136 region) — re-merging replays corrections.
- `PENDING_INBOUND_WINDOW_MS` (engine.ts:537) + recordInboundReceived ordering with chat-bridge.
- last_advanced_at dual semantics (stall-watchdog preserve vs. source-switch bump, 3950-3987).
- `walkAutoSkip` + resolver AUTO_SKIP null-return are a matched pair (7813-7820 region).
- 83 test files pin much of this; the dead acceptChoice path is *tested*, so test migration is
  part of the deletion, not optional.

Effort: XL. This is the only file where I recommend NOT starting until the Path-1 fork decision
is written down.

---

## 2. runtime/adapters/claude-code/persistent/persistent-repl-substrate.ts (4,009 ln) — P1

### Actual structure (verified)
Section banners already exist in-file. Clusters:
- 164–322: constants + TUI signature regexes (DEV_CHANNEL_DISCLAIMER_RE:216,
  TOOL_USE_QUESTION_RE:233, RATE_LIMIT_OPTIONS_RE:243, compact-resume REs:262-263) — the "fossil
  record" of real CLI behavior.
- 565–913: options + notice-sink types (PersistentReplSubstrateOptions:637).
- 927–957: ReplToolBridge global (`replToolBridge` let at 934).
- 963–1101: `class ReplSink` (singleton instance `sink` at 1094) — process-wide loopback HTTP.
- 1106–1540: `class ReplSession` state machine.
- 1541–1575: httpHealth probe.
- 1576–2314: `spawnSession` (+resume) — ~740 lines.
- 2315–2594: pending-respawn queue + `drainPendingRespawns` (2475).
- 2595–2691: `poolKeyFor` (2595), `spawnEphemeralSession` (2623).
- 2692–3052: `createPersistentReplSubstrate` — the turn driver (`start(spec)` at 2703).
- 3061–3102: `shutdownAllPersistentRepls`.
- 3103–3440: supervision registry + respawn actuation (`respawnSupervisedSession`:3138,
  `respawnReplSession`:3326).
- 3441–3802: wedge/cwd-drift watchdog ticks + `startReplWatchdog` (3705).
- 3803–3959: model-update watchdog.
- 3960–4009: test accessors.

**13 module-global mutable singletons** (verified by grep): `replToolBridge`:934, `sink`:1094,
`pool`:1384, `childByKey`:1391, `ephemeralSessions`:1398, `pendingChildKills`:1404,
`activeWatchdogs`:3053, `activeModelWatchdogs`:3058, `supervisedBySessionKey`:3115,
`respawnGates`:3151, `wedgeAlertState`:3153, `cwdDriftRespawnState`:3157, `cwdDriftAlertState`:3160.

### What is wrong
The file is actually well-factored *internally* (small helpers orbit it; sections are banered);
the problem is that (a) 17 clusters share one file so every change risks every invariant, and
(b) Substrate instances are stateless facades over ambient module state, so the modules cannot
be split without either import cycles or threading globals. The globals are semantically ONE
object: the per-process REPL pool runtime.

### Extraction plan
Step 1 (the enabler): reify a `PoolRuntime` object holding all 13 structures, constructed once
at module scope so behavior is byte-identical (per-turn `createPersistentReplSubstrate(opts)
.start(spec)` must keep reusing the same warm pool — header comment at 2683 documents this
contract). Every function gains a `rt: PoolRuntime` first parameter (or closes over the module
singleton via one accessor). Tests get `createPoolRuntimeForTest()`.
Step 2: mechanical file split along the existing banners into ~8 modules:
`signatures.ts` (164–322), `types.ts` (565–913), `repl-sink.ts` (927–1101), `repl-session.ts`
(1106–1575), `spawn.ts` (1576–2314), `pending-respawn.ts` (2315–2594), `pool.ts` + turn driver
(2595–3102), `supervision.ts` + watchdogs (3103–3959). Keep persistent-repl-substrate.ts as a
barrel re-exporting today's public names (index.ts:207 createClaudeCodeSubstrateAuto and
gateway consumers must not change imports in the same PR).

### Load-bearing subtleties
- `sink.register` BEFORE `ptyHost.spawn` ordering (1678-1694 region).
- Identity-guarded eviction (unregisterIf / compare-delete) everywhere — respawn re-attaches the
  SAME sessionId; a split that "simplifies" to blind deletes reintroduces the P2-3 resume race.
- pendingChildKills consumption in spawnResume — one-owner-per-transcript.
- Ephemeral gate (`options.ephemeral && spec.session === undefined`) and the NEVER-enqueue-to-
  pending-respawns rule for ephemerals (a replayed internal prompt would land in the user's chat).
- Watchdog ticks scope the pool by owning replRegistryPath (3553-3556) — the `rt` threading must
  preserve that scoping or one instance respawns another's sessions.
- 48 test files under persistent/__tests__ are the safety net; the fake-PtyHost suites drive the
  REAL ReplSink/dev-channel seam, so the split must not fork the sink into per-module instances.

Effort: L. Precondition: none — this can start immediately; it is the highest-value split that
is fully unblocked today.

---

## 3. open/composer.ts (3,732 ln) — P0 (shared with boot-composition critic; my angle: the closure)

### Actual structure
`buildOpenGraphComposer` (396) is ONE async closure to ~3615. Internal narrative comments (no
section banners) mark ~15 clusters: owner-slug/skills materialization (~400-430), persona loader
(~432), cron registry (~437), credential pool + 5 substrate constructions (~440-637: llm-call,
warm conversational + prewarm, live-agent, trident ephemeral factory, trident warm fire), work
board + dispatchBoardHolder (654), agent-dispatch/skill-forge (664-737), uploads + landing stack
(1237-1330: importUseSynthesis:true at 1288), importWatchHolder (1329), cookie/start-token gate +
React bootstrap HTML injection (1453-1653), `openFetch` route ladder (1655-1755), ~20 app
surfaces, onboardingMsgHolder (2321), Path-1 import watcher (2470-2528), appWsHolder (2689) +
bespoke app-ws receiver (3082-3425), no-op Telegram stubs (3434-3440), 190-line CompositionInput
return literal (3426-3613). Module-scope helpers after: formatOwnerSetCookie (3624),
prewarmSubstrate (3661), awaitPrewarmReady (3693).

### What is wrong
The composition root is where a no-functionality-change refactor is most likely to *silently
drop a wire*: ~50 optional CompositionInput fields mean a forgotten slice compiles clean and
404s at runtime (a documented regression class). The closure's four late-bound holder objects
(654, 1329, 2321, 2689) encode a fill-before-first-dispatch timing contract that is invisible at
the type level. And because everything is one closure, none of the wiring (openFetch,
watchImportCompletion, the app-ws receiver) is unit-testable without booting the whole composer.

### Extraction plan
Decompose along the existing comment narrative into ~12 wiring modules, each
`wireX(ctx: OpenWiringContext): Partial<CompositionInput> & {cleanups?}`:
substrates+prewarm, memory (scribe/gbrain/reflection), work-board+dispatch, uploads+landing-stack,
http-shell (cookie gate + bootstrap injection + openFetch), app-surfaces (one per group),
onboarding seams (Path-1 trio + import watcher), app-ws receiver, trident, return-assembly.
The composer becomes a ~150-line orchestrator that constructs the shared context, calls the
wire modules in the current order, and merges slices. Convert each holder into an explicit
two-phase seam: `createX(): {facade, bind(impl)}` so the fill-before-dispatch contract is a
named object with a test, not a mutation buried at line 2183/2528/2769/3011.
Guardrail (do in the same PR): a per-profile required type
`OpenComposition = CompositionInput & Required<Pick<CompositionInput, ...openSurfaces>>` on the
return literal so dropping a slice fails to compile.

### Load-bearing subtleties
- open/server.ts:58-73 env mutation BEFORE boot() (boot re-reads process.env) — untouched by
  this split but adjacent; don't move config reads out of the entrypoint.
- prewarm promise never rejects and is not awaited (3661-3684); prewarmSettled elevates timeouts
  for the whole cold window — the substrates module must keep the flag/promise pair together.
- Trident fire substrate must be WARM per-repo-cwd (comment at ~590-633) and only `cc-agent-`
  gets enableToolBridge — pool-key/instance-id prefixes are semantic.
- The 30 open/__tests__ wiring tests + gateway *-production-composer tests are the lock; add a
  characterization test that snapshots which CompositionInput fields the Open composer sets
  BEFORE the split, and assert it unchanged after.

Effort: L (mechanical but wide). Fully unblocked; pairs naturally with finding 11's type moves.

---

## 4. gateway/http/chat-bridge.ts (3,113 ln) — P1

### Actual structure (verified)
- 162–301: WebChatSenderRegistry + InMemory impl (185) + WebChatSessionProjectRegistry (264).
- 302–420: live-agent eligibility (352) + typing bracket (394).
- 421–520: web rendering — renderButtonPromptForWeb (421), normalizeUploadAffordance (473),
  renderSlugRenameConfirmationForWeb (498, dead).
- 521–838: OwnerRegistryLookup (521) + routed send-prompt/import-progress builders (664, 694) +
  slug-history JWT shim (749–838).
- 839–1051: BuildWebChatBridgeOptions (839) — the option bag.
- 1052–2006: `buildWebChatBridge` closure: validateStartToken (1069), startSession (1224),
  resumeCookieSession (1462), closeSession (1523), handleInbound (1544–2006).
- 2027–2510: **DEAD** slug-picker engine hook (ProcessSlugPickerReplyFn 2027,
  buildSlugPickerEngineHook 2177) — verified zero non-test importers repo-wide (~484 lines,
  plus renderSlugRenameConfirmationForWeb at 498).
- 2511–3043: project-topic group-chat engine (persistProjectUserTurnOnly 2545,
  persistProjectStubTurn 2601, handleProjectTopicInbound 2664).
- 3044–3113: reEmitActiveSeedPromptIfAny.

### Plan
1. Delete the dead slug-picker block + renderSlugRenameConfirmationForWeb (~510 lines) —
   coordinate with the Managed repo check (build-landing-stack takes an injected slugPicker
   nothing in this repo constructs).
2. Phase-0 type moves: WebChatSenderRegistry to a leaf (it is consumed by reminders/outbound,
   gateway/proactive, gateway/comments); ChatCommandFilter out of app-ws-surface (sideways import
   at 1009); ONBOARDING_HANDOFF_SKIP_FOR_NOW_VALUE to a neutral leaf (kills the
   http↔realmode-composer cycle at chat-bridge.ts:116).
3. Split along the partitions the 10 existing chat-bridge test files already use:
   `sender-registry.ts` (162–301), `render-outbound.ts` (421–497), `routed-senders.ts` (521–748),
   `slug-history-shim.ts` (749–838), `bridge.ts` (the buildWebChatBridge closure, kept whole —
   its four entry points share session state deliberately), `project-topic-inbound.ts`
   (2511–3043), `seed-reemit.ts` (3044+).

### Load-bearing subtleties
- Registry send must PROPAGATE throws (202-219) — delivered_at stays NULL for reconnect re-emit;
  identity compare-and-delete unregister (192-200, 1523-1542).
- startSession runs engine.start BEFORE the jti claim (1229/1261 region) and duplicate jti →
  return false not error (1392-1400).
- recordInboundReceived BEFORE engine.advance (1919-1929); typing bracket start-before-dispatch /
  end-in-finally on every path (1940-ish, 2717); FORBIDDEN_INBOUND_VALUES rejection before any
  resolve branch; the live-agent gate is phase==completed ONLY (2026-06-20 P0 note).
- tag_gated no-mention posts persist transcript + send no-render agent_ack (project-topic engine).

Effort: M. The deletion alone is the single best line-count-per-risk move in the whole audit.

---

## 5. landing/server.ts (1,516 ln) — P1 (small file, biggest unblock)

### Actual structure (verified)
- 46–168: helpers — validateActiveTopicId (77, dead), resolveRequestHost (111, dead),
  emitSessionReady (124, dead), CSP hash helpers (136–168, live).
- 170–699: **the chat wire protocol for the entire product** — ChatInbound (170), ChatOutbound
  (203) + per-frame interfaces (215–520), PendingChatClaim (530), ChatBridge (546–699 with the
  only written spec of jti-claim atomicity / identity-unregister / seed-reemit semantics).
- 701–845: LandingServerOptions (the `bridge` option is unread — websocket path removed).
- 846–934: SocketState — dead (only fed the stubbed websocket handler).
- 935–1155: LandingServer type + auth-gate page + CSP (964–1155, live).
- 1156–1516: createLandingServer route table; websocket handler is a defensive stub (1497–1514,
  in-code comment: "/ws/chat removed").

### Plan
Extract lines 170–699 verbatim (JSDoc included) into a zero-dep leaf package
(`chat-protocol/`), re-export from landing/server.ts during transition. Verified consumers that
flip to the leaf: chat-bridge.ts:45, recovered-reply-store.ts:51, build-live-agent-turn.ts:67,
button-store-sink.ts:36, reminders/outbound.ts:24, open/composer.ts:214, plus channels/app-ws
envelope. Then delete the dead cluster (77–134 helpers, 846–934 SocketState, the unread bridge
option) and the file lands at ~700 lines of pure HTTP routing. This inverts the worst layering
edge in the repo (reminders/gateway/channels importing from the edge web package) with an
S-effort, type-only change — do it before the chat-bridge and composer splits so they extract
against the leaf, not against landing.

Risk: near-zero (type moves + dead code with a stubbed runtime path). The one trap: the JSDoc on
ChatBridge is load-bearing spec — move, never rewrite, in the same commit.

---

## 6. onboarding/history-import/job-runner.ts (2,103 ln) — P1

### Actual structure
Header (1–21) self-declares SUPERSEDED on the Open path; retained "(a) for the MANAGED hosted
import path... (b) Pass-2 Sonnet-fallback tests". Verified: open/composer.ts:1288 sets
`importUseSynthesis: true` unconditionally and is the sole buildLandingStack caller; the gate at
build-landing-stack.ts:1124 (`importJobRunner === undefined && importUseSynthesis === true`)
means the per-chunk runner is unreachable in this repo's production. Structure: deps/types
84–392; `class ImportJobRunner` 393–2035 (~1,640 lines: start/status/cancel/synthesizeOnDemand,
pass-1 parallel pool, 429 retry schedule, cooling-off overlay, persistResult); free helpers
2036–2103 (is429RetryableError at 2072 duplicated in substrate-callers.ts).

### Plan (deletion-shaped, not split-shaped)
This file should not be decomposed — it should be evacuated then parked/deleted:
1. Extract what the LIVE path actually shares: history-import/types.ts is already the hub;
   `extractJsonObject` (imported by synthesis-session.ts:30 from the dead substrate-callers
   module) and the 429 matcher move to a small live util.
2. Persist the ImportJobRunnerHook contract (engine-internals.ts:696) in the phase-0 contracts
   module so the synthesis runner stops depending on the engine file.
3. Then either relocate job-runner + pass1/pass2/substrate-callers/entity-populator (+ ~10k test
   lines) to the Managed repo that putatively needs them, or delete with a git tag. Decision
   needed from Ryan/Managed; until then mark the directory ARCHIVED in its AGENTS header.
Behavior risk: nothing on the Open path executes this code; the risk is entirely in step 1's
extraction of the two shared helpers (golden-test them) and in the status-vocabulary coupling —
the synthesis path REUSES ImportJobStatus + progress columns with reinterpreted meanings
(build-synthesis-import-runner.ts:156-174; chat-bridge reads at 643-644), so the types hub must
survive even if the runner dies.

Effort: M (mostly test migration + a cross-repo decision).

---

## 7. gateway/git/project-backup-store.ts (2,246 ln) — P2

### Actual structure (verified)
One `class ProjectBackupStore` (410–1887) + free helpers (1888–2103) + styles of constants
(93–409). Clusters inside the class:
- concurrency fields 419–441: initLocks, inFlight, inFlightRestore, backingUp, nextScheduled —
  with in-code Argus r1/r2 blocker history (425–435, 606–635: restore and backup must interlock;
  the double-await ordering at 624–630 is deliberate).
- init/probe: isGitAvailable 456, ensureInit 485–604.
- backup writer: backupNow 605–911.
- status: getStatus 912, read/writeLastAttemptedAt 949/964.
- snapshot read API: listSnapshots 988, previewSnapshot 1106, getSnapshotFileContent 1203,
  getSnapshotFileDiff 1264.
- restore: 1337–1701.
- scheduler glue: setNextScheduledAt 1702, drain 1708–1771.
- git plumbing privates: gitDir/workTree/gitDirArgs/workArgs 1772–1887.
- classification/util: classifyPushFailure 1888, extractGitFatal 1994, etc.

### Plan
Split behind the existing class facade (consumers — admin surface, scheduler — keep the same
object): extract (a) `git-exec.ts` — the exec wrapper + gitDir/workTree arg builders + error
classification (1772–2050), shared with doc-version-store.ts which duplicates it
(map-verified duplicate); (b) `snapshot-reader.ts` — the four read APIs (988–1336), pure
functions over (gitDir, workTree, caps); (c) `restore.ts` (1337–1701); (d) backupNow + ensureInit
stay in the facade **with all five concurrency maps** — the backup/restore mutex interlock is
the file's crown-jewel invariant and must not be distributed across modules. The facade methods
become "acquire locks → call module fn".
Load-bearing: last_attempted written BEFORE snapshot fires (scheduler contract); SNAPSHOT caps
constants; sha/path validation errors are typed classes the HTTP surface maps to status codes —
keep the error classes exported from the same specifier.
Effort: M; test suite is heavy (1,312 test LOC per map), which makes this safe.

---

## 8. app/app/projects/[id]/docs.tsx (2,426 ln) — P2

### Actual structure (verified)
`DocsTab` default component 113–1522 (~1,410 lines, **32 useState**, 57 hook calls, 4
RequestGates at 190–192 + historyGate 247). Handler clusters: fetchTree 261, fetchFile 285,
deep-link anchor scroll 381–522 (handleScrollToAnchor 460), select + binary upload/drop/delete
523–694, history/preview/revert 695–776, save/reload 777–826, create/open/delete/rename 827–999,
then ~500 lines of JSX. Leaf components are ALREADY extracted in-file (1523–2060: BinaryPreview,
EditorDropTarget, modals, TreeBranch) — moving them to files is free.

### Plan
1. Free move: leaf components + formatError/formatBytes to app/features/docs/ (testIDs unchanged
   — the out-of-repo agent-browser smoke keys on them).
2. Extract per-cluster hooks, each owning its state + gate: `useDocTree(projectId)` (tree +
   treeGate + fetchTree + project-switch reset), `useDocFile` (fileGate + fetchFile + save/reload
   + 409 draft-preserve), `useDocHistory` (historyGate + preview/revert), `useDocMutations`
   (mutateGate + create/rename/delete/binary — one gate covering all mutations is the invariant,
   fixed 4 separate times per review history), `useDeepLinkAnchor` (the scroll math coupled to
   theme tokens).
3. Build the structural `useProjectScopedAsync(project_id)` primitive (acquire before first
   await, isLatest before every post-await setState, reset-on-switch) so gate omission becomes
   impossible; port handlers one at a time.
Behavior risk is real: hook orchestration has NO direct tests (pure-logic-only convention), and
the reset ordering at 305–341 (gates → per-file state → tree BEFORE fetchTree) is positional.
Mitigation: this is the one split where each PR should be gated on the agent-browser smoke pass,
and the extraction must not change effect dependency arrays.
Effort: M–L.

---

## 9. app/app/admin.tsx (2,188 ln) — P2 (cheapest split in the set)

### Actual structure (verified)
AdminScreen shell 100–235 + PANES registry 91. Six pane components already exist as independent
functions taking only a client prop: PersonalityPane 279–807, GatewayPane 814–903, MemoryPane
904–982, CoresPane 983–1223 (+CoreRow 1087), BackupPane 1275–1516 (+BackupCard 1417,
ConnectRemoteModal 1552–1770), MaxAccountPane 1781–1889; shared formatters 1224–1268
(formatError/formatBytes/formatRelative/formatIso duplicated vs docs.tsx:2062); StyleSheet 1890+.
### Plan
Pure file moves: app/features/admin/<pane>.tsx per pane + shared format.ts + shared styles split
per pane (verify no cross-pane style keys — the single StyleSheet is the only coupling). Shell
keeps the PANES registry. No hook re-plumbing, no state model change, testIDs stable. Effort: S.
This is the template PR to establish the "screen = shell + feature files" convention before
attempting docs.tsx.

---

## 10. cores/free/email/src/backend.ts (2,003 ln) — P2

### Actual structure (verified)
Six sections with clean boundaries: contract types + GmailClient interface 51–316; typed errors
317–385; assembleThread util 386–428; in-memory client 429–765 (buildInMemoryGmailClient 462);
seeded in-memory client 766–1075; Google REST client + base64url/MIME/header parsing +
buildRawMessage injection guard 1076–1907 (buildGoogleGmailClient 1514); summarizer 1908–2003.

### Plan
Mechanical split into `contract.ts`, `errors.ts`, `in-memory.ts` (both fake clients),
`google-client.ts`, `mime.ts` (1170–1513: decode/encode, stripHtmlToText, extractBodies,
buildRawMessage + EmailHeaderInjectionError — this is security-relevant parsing and deserves its
own test file), `summarizer.ts`; backend.ts becomes a barrel re-exporting today's names so
tools.ts/wiring-production.ts/mount-open-cores imports don't change. Preserve: draft-only design
(gmail.send excluded from surface AND scopes, 29–37); newest-first ordering contract (24–27).
Effort: S. Zero seam ambiguity; 13 test files already partition along these clusters.

---

## 11. Ranking by (risk reduction × feasibility)

1. **landing/server.ts protocol extraction** — S effort, inverts a repo-wide layering edge,
   unblocks #3/#4; near-zero risk.
2. **Phase-0 contracts pass** (ImportJobRunnerHook, WebChatSenderRegistry, ChatCommandFilter,
   LlmCallFn, llm-timeouts) — S, unblocks everything, type-only.
3. **chat-bridge.ts**: dead slug-picker deletion (S) then cluster split (M) — 10 test files
   already define the partitions.
4. **admin.tsx** — S, pure moves, establishes the screen-split convention.
5. **email backend.ts** — S, documented boundaries, hermetic tests.
6. **open/composer.ts** — L, but the wiring-module pattern + Required<> return type removes the
   repo's worst silent-404 regression class.
7. **job-runner.ts** — M, mostly deletion + a cross-repo decision; huge net-negative LOC.
8. **project-backup-store.ts** — M, facade-preserving; mutex interlock stays centralized.
9. **persistent-repl-substrate.ts** — L; PoolRuntime reification first, then banner-wise split;
   highest care but strong test net.
10. **docs.tsx** — M–L; only split gated on browser smoke because hook orchestration is untested.
11. **engine.ts** — XL; blocked on the Path-1 fork decision; start with the free deletions
    (acceptChoice, slug flow) and the per-phase-descriptor consolidation.

## 12. Done-criteria for any split (anti-EngineInternals rule)

A split PR is done only if: (a) the extracted module does NOT receive the host object (`self`,
`engine`, `bridge`) — max 4 narrow capability interfaces; (b) delegators and friend-interface
entries are deleted in the same PR (the interface shrinks monotonically); (c) invariant comments
travel verbatim with the code they protect; (d) tests move with the code; (e) public import
specifiers unchanged via a barrel until a dedicated import-rewrite PR; (f) a module-boundary
rule is added (dependency-cruiser is already a devDependency at package.json:57 with no config —
configure it as part of the first split so extracted modules cannot silently re-import the host).
