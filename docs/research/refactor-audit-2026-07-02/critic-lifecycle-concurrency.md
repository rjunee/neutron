# Critic report: lifecycle-concurrency

Audit date: 2026-07-02. Repo: /Users/ryan/repos/neutron-open (read-only). All paths relative to repo root.
Charter: jobs, loops, races — tick loops, watchdogs, in-process maps of in-flight work, restart/resume
paths, fire-and-forget promises. Diagnose the pattern behind the known bug history (import watcher armed
only on upload PR #107; reminders delivered to a registry no client binds PR #105/#106; one-shot MCP
channel bind wedge; turn-timeout poisoning warm sessions) and propose consistent primitives.

---

## 1. Inventory: every background lifecycle construct, with production liveness (Open composition)

I verified each item in code — "LIVE" means constructed AND started on the Open boot path;
"INERT" means started but structurally unable to act; "UNWIRED" means no production constructor
exists in this repo (only tests).

### Tick loops
| Loop | Cadence | Started at | Status |
|---|---|---|---|
| `CronScheduler` (cron/scheduler.ts:77) | per-job interval/OnCalendar | gateway/composition.ts:377 (after graph.compose) | LIVE — the healthiest primitive; missed-fire catch-up, single-flight, "N job(s) ticking" boot alarm (composition.ts:380) |
| `TridentTickLoop` (trident/tick.ts:99) | 90 s | build-core-modules.ts:420 | LIVE |
| `ReminderTickLoop` (reminders/tick.ts:74) | 30 s | build-core-modules.ts:297 | LIVE |
| `WatchdogSupervisor` (watchdog/supervisor.ts) | 30 s | build-core-modules.ts:495 | **INERT** — see F2 |
| Chunked-upload sweeper | interval | open/composer.ts:1395 | LIVE (cleanup via realmodeCleanups:1396) |
| `ProjectBackupScheduler` (gateway/git/project-backup-scheduler.ts:85) | 60 s poll / 6 h per-project | — | **UNWIRED** — sole importer is its own test (gateway/__tests__/project-backup-scheduler.test.ts:21) |
| Comments `AgentWatcher` (gateway/comments/agent-watcher.ts:265) | poll interval | — | **UNWIRED** — zero non-test constructors; `buildAgentWatcherLlmCall` (gateway/realmode-composer/build-agent-watcher-llm-call.ts:97) has zero callers; open/composer.ts never mentions comments (docs surface built without the `comments` option, open/composer.ts:2003-2007) |
| `runLifecycleTick` / `runAgentWatchdog` (runtime/subagent/lifecycle.ts:52, watchdog.ts:148) | "driven by the gateway's main interval" (lifecycle.ts:4) | — | **UNWIRED** — zero production callers repo-wide (grep); `buildDispatchWatchdogNotifier` exported (agent-dispatch/index.ts:46), never used |
| Cron-registered handlers (import-running, resume, overnight, morning-brief, idle-nudge, nudge-engine, focus-score, sean-ellis, oauth-pending-sweep) | via CronScheduler | various `registerXxxCron` | LIVE |
| REPL watchdog family (repl watchdog, size, model-update, heartbeat, wedge/prompt/channel-bind detectors) | adapter-internal | createClaudeCodeSubstrateAuto side effect (runtime/adapters/claude-code/index.ts:243-273) | LIVE |
| Trident hang/stall reap + 2 h ceiling | inside orchestrator step | orchestrator.ts:168,184 | LIVE |

### Durable-job / restart-resume constructs (maturity spectrum)
| Job system | Durable state | Boot resume | In-memory-only state |
|---|---|---|---|
| profile-pic pipeline | `profile_pic_pending` rows (pending-call-store.ts) | YES — restart-resume.ts boot sweep with 60 s fresh / 5 min hard windows, one invisible auto-retry | none — **the gold standard** |
| REPL pending respawns | disk queue, "disk is the source of truth" (pending-respawns-queue.ts:13-19) | YES — boot drain before anything else | none |
| trident runs | `code_trident_runs` rows | YES — orphan re-fire from checkpoint; `fired`/`redispatched` sets deliberately per-process (orchestrator.ts:198-205) | fired/redispatched/inflight sets (by design) |
| reminders | rows + claim-before-dispatch (#319, tick.ts:130-177) | implicit (rows) | none |
| synthesis import (the LIVE onboarding import) | `import_jobs` status row only | **NO** — no orphan sweep; `pass1-running` rows strand until the engine's 15-min hard timeout | **completed `ImportResult` held in a Map** (build-synthesis-import-runner.ts:131), `cancelled` Set (:132), fire-and-forget `runJob` (:267) |
| agent-dispatch (Atlas/Sentinel/adhoc) | **nothing** | **NO** | entire `SubagentRegistry` (runtime/subagent/registry.ts:74-75); header promises "S4 wires it to a SQLite-backed table" (:5-7) — never landed; control.ts:11,119 same promise |
| wow dispatch | `wow_report`/`wow_dispatch_error` watermark in phase_state | only on `engine.start` (user activity), engine.ts:739-755 | dispatch promise |
| import-completion watcher (Path 1) | none (derived from onboarding_state) | **NO boot re-arm** — armed on upload, re-armed only on socket reconnect (open/composer.ts:3248-3272) | setTimeout chain + `importWatchActive` Set (:2481) |

### Subscription / delivery registries
- `WebChatSenderRegistry` (`web:` topics, gateway/http/chat-bridge.ts:162) and
  `InMemoryAppWsSessionRegistry` (`app:` topics, channels/adapters/app-ws/session-registry.ts) —
  duplicated by admission (session-registry.ts:5-9 "so a future consolidation can fold both").
- Producer-side registry guessing already caused deliver-to-nobody bugs twice: reminders (PR #105/#106)
  and the proactive brief (open/composer.ts:1904-1911 — "the previous `web:` + `landing.registry` path
  reached no app-ws client — same live-delivery bug as reminders, now fixed for both").
- Work-board live updates open a SECOND WebSocket to the same `app:<user>` topic
  (app/lib/work-board-live.ts:5-11) because there is no shared frame bus.

### Fire-and-forget census
28 bare `void fn(...)` sites across gateway/, open/, onboarding/, trident/, reminders/, channels/
(excluding tests), plus `.catch(() => undefined)` variants. No process-level `unhandledRejection` /
`uncaughtException` handler exists anywhere in production code (grep). Some voids are principled and
documented (prewarm never rejects, open/composer.ts:3656-3682; scribe hot-path isolation); most are ad
hoc (`void materializeProjectScaffold(...)` open/composer.ts:2277; `void appWsHolder.adapter?.send(msg)`
:2731; `void this.runOnce()` in every loop).

---

## 2. The pattern behind the bug history

The four historical incidents named in the charter share one shape: **lifecycle state that must survive
event X lives only in a construct that does not survive X, and the only re-arm points are other
events** — never a reconciliation from durable state.

1. **Import watcher wedge (PR #107 class, still visible today)** — the consume-import watcher is a
   process-memory setTimeout chain armed inside the upload handler. The restart fix (open/composer.ts:
   3248-3272) did not make arming a function of durable state; it added a *second event-coupled arming
   point* (socket reconnect). Recovery now depends on the owner reconnecting.
2. **Reminders → dead registry (PR #105/#106)** — the producer resolved its delivery subscription by
   convention (topic prefix → registry) with two overlapping registries; no shared "resolve the live
   senders for this topic" primitive. The same bug then recurred for the proactive brief and was fixed
   again, producer-by-producer (open/composer.ts:1904-1911).
3. **One-shot MCP channel bind wedge** — a bind with no supervised retry loop; fixed by growing a
   bespoke detector + respawn path inside the adapter (channel-wedge-respawn.ts).
4. **Turn-timeout poisoning warm sessions** — turn-scoped failure state leaked into a longer-lived
   resource with no owner to reconcile; fixed by another bespoke mechanism (abandon-poison + eviction).

Each fix was correct and each fix was local. The system now contains at least seven independently
invented supervision/recovery mechanisms (REPL watchdog family, trident reaper trio, engine import
hard-timeout, wow action-runner 60 s hang timeout, reminder claim/revert, pending-respawn boot drain,
profile-pic boot sweep) and **two entire supervision systems that are dead** (watchdog/ package,
runtime/subagent watchdog). There is no durable job queue, no supervised-loop primitive, no subscription
registry abstraction, and no idempotent re-arm-on-boot convention — so every new background feature
re-decides these questions, and the ones that decided wrong are only discovered by incident.

The repo *already contains* the correct doctrine, stated verbatim: "**disk is the source of truth** — a
crash between 'schedule the deferred respawn' and 'the setTimeout fires' must not silently drop the
recovery" (runtime/adapters/claude-code/persistent/pending-respawns-queue.ts:13-16). It is applied in
two places and violated in the rest.

---

## 3. Findings

### F1 (P0, L) — No durable-job primitive: in-flight background jobs are process-memory artifacts

**Evidence.**
- Synthesis import (the LIVE onboarding import path): the completed `ImportResult` lives only in
  `const results = new Map<string, ImportResult>()` (gateway/realmode-composer/
  build-synthesis-import-runner.ts:131); the run itself is `void runJob(...)` fire-and-forget (:267);
  `status()` attaches the result only from the Map (:305-308); `synthesizeOnDemand` salvages nothing
  (:327-333). A restart after completion but before the engine's poll consumes it returns
  `completed`-without-result → the engine degrades to gap-fill; the entire import (tokens + minutes) is
  silently lost. A restart mid-run leaves a `pass1-running` row that nothing resumes or fails at boot —
  it strands until the engine's `started_at`-anchored hard timeout (~15 min,
  onboarding/interview/engine-internals.ts:121) declares it dead.
- Agent-dispatch: `SubagentRegistry` is in-memory; its own header says "At S3 the registry is in-process
  only; S4 wires it to a SQLite-backed table so the lifecycle watchdog can survive a gateway restart and
  reap orphaned children" (runtime/subagent/registry.ts:5-7) — S4 never landed (control.ts:11,119 repeats
  the promise). A restart erases every live dispatched run; the `delivery_target` is never notified; the
  owner's /dispatch'ed agent just vanishes.
- Contrast: profile-pic (durable pending rows + boot sweep + bounded auto-retry,
  onboarding/profile-pic/pending-call-store.ts + restart-resume.ts) and trident
  (`code_trident_runs` + harvest-first orphan re-fire) prove the pattern is known and cheap.

**Why it matters.** This is the direct generalization of the PR #107 wedge. Any process restart —
deploy, crash, `launchctl kickstart` — is a data-loss / silent-abandon event for exactly the two job
families a user most visibly waits on (history import, dispatched agents).

**Proposal.** One `job_runs` table + a small JobHost: `enqueue(kind, payload) → durable row`,
`claim/heartbeat/complete(result)/fail(code,msg)`, and a boot-time resume sweep with profile-pic-style
windows (fresh → leave; stale+unretried → retry-or-fail; hard ceiling → fail loud). Migrate synthesis
import first (persist the `ImportResult` to the existing `import_results` table shape the per-chunk
runner already uses, job-runner.ts:1959-2018, + boot sweep for orphaned statuses), then persist
`SubagentRecord`s (schema mirrors trident's run rows) with a boot sweep that marks prior-process live
rows crashed and fires the report sink.

**Behavior risk.** Medium: engine poll contract (`ImportJobRunnerHook`) must stay byte-identical;
boot sweeps must respect trident's deliberate crash semantics (do NOT persist the orchestrator's
`fired`/`redispatched` sets — losing them on restart IS the orphan-detection mechanism,
orchestrator.ts:198-205). Pin with the existing hook tests plus a new restart-resume test per job kind.

---

### F2 (P1, M) — Supervision is decorative: both general watchdog systems are dead; dispatched agents have zero stuck/dead detection

**Evidence.**
- The `watchdog/` package supervisor is started (build-core-modules.ts:495) but cannot act: the notifier
  is `{ notify: async () => undefined }` (open/composer.ts:3436); the heartbeat tracker is
  `{ lastHeartbeatAt: () => Date.now() }` (:3440) so staleness is impossible; Stuck/CrashedAgentDetector
  watch `ProcessRegistry`, which has **zero production `register()` callers** (grep; tools/
  process-registry.ts also references a `gateway/orphan-adoption.ts` that does not exist); 3 of 6
  detectors are never registered ("wired in sprints S5/S6" — never happened, build-core-modules.ts:488-494).
- The agent-aware subagent watchdog — the one the code claims supervises dispatch ("The SAME registry is
  supervised by the already-ported agent-aware watchdog", agent-dispatch/service.ts:28-30) — is **never
  scheduled**: `runAgentWatchdog` / `runLifecycleTick` have zero production callers;
  `buildDispatchWatchdogNotifier` is exported and unused. A wedged or crashed Atlas/Sentinel run is never
  reaped, never surfaced; its board item stays bound forever (until restart erases the registry, F1).
- The only real supervision in the process: the REPL adapter's watchdog family (adapter-internal), the
  trident orchestrator's reapers, the engine's import hard-timeout, and wow's action-runner timeout —
  four bespoke implementations.

**Why it matters.** A decorative safety system is worse than none: the 30 s supervisor tick and the
916-line watchdog test suites read as coverage that does not exist. The charter's bug history (bind
wedge, turn-timeout poisoning) shows what happens in this codebase when liveness is unsupervised.

**Proposal.** Delete the `watchdog/` package + writer-less ProcessRegistry (or wire them for real —
one decision, not drift), and schedule `runLifecycleTick` as a cron job (the infrastructure exists;
one `registerXxxCron` call) with the already-written `buildDispatchWatchdogNotifier` routed to the
app-ws delivery path. Fix the false service.ts header either way.

**Behavior risk.** Wiring the subagent watchdog is a (desirable) behavior change: stuck dispatches start
being killed after 5 min (DEFAULT_STUCK_THRESHOLD_MS, watchdog.ts:60) — verify the threshold against
real dispatch durations before enabling; run notify-only first if unsure. Deleting the inert watchdog
package changes nothing observable.

---

### F3 (P1, M) — Built-and-tested loops that never run; no boot-time loop inventory

**Evidence.**
- `ProjectBackupScheduler` (227 lines + jitter + boot backfill + sleep/resume design notes): sole
  importer is its own test. Nothing in this repo constructs `ProjectBackupStore`,
  `createAppBackupsSurface`, or the scheduler in production (grep; open/composer.ts contains zero
  "backup" references) — scheduled 6-hourly project backups do not run on an Open install, and
  `next_scheduled_at` (project-backup-store.ts:440-441) is only ever written by the unwired scheduler.
- Comments `AgentWatcher` (~1,000 lines + 916-line test suite): zero production constructors; its LLM
  seam `buildAgentWatcherLlmCall` has zero callers; Open's docs surface is built without the `comments`
  option (open/composer.ts:2003-2007), so the whole gateway/comments subsystem is dormant here.
- Both *may* be wired by the private Managed composer through the env seam — unverifiable from this repo,
  which is precisely the problem: **the set of loops that run in production is not derivable from any
  single place**, and no test or boot log asserts it. The one good counter-example is cron's boot alarm:
  "started — N job(s) ticking: [...]" (gateway/composition.ts:377-380), which exists because a silent
  0-job boot already burned them (S15 note, cron/scheduler.ts:286-291).

**Why it matters.** This is the "reminders delivered to a registry no client binds" class one level up:
whole supervised loops delivered to a composition that never binds them. The subsystem mappers themselves
were fooled — the gateway-services map lists the backup scheduler's write-before-fire ordering as
load-bearing; it never executes.

**Proposal.** A `LoopRegistry` every long-lived loop must register with (name, cadence, started_at,
last_tick, last_error) + one boot log line mirroring cron's, + a production-composer test asserting the
expected loop inventory for the Open composition (the same pattern as the existing
*-production-composer HTTP-surface tests, which fixed the identical bug class for routes, ISSUE #32).
Then make an explicit decision per dormant loop: wire in Open, or move to the Managed repo, with a
tracking note — never silent dormancy.

**Behavior risk.** The registry/log/test is behavior-neutral. Wiring the backup scheduler is a
functional change (new git commits/pushes on user data every 6 h) — do it as a deliberate feature PR
after the Managed-repo check, not inside the refactor.

---

### F4 (P1, M) — Watcher arming is event-coupled and recovery is user-activity-coupled; arming is never a function of durable state

**Evidence.**
- Import-completion watcher: in-memory setTimeout chain armed ONLY inside `notifyImportUpload`; the
  restart fix re-arms it on socket reconnect (`on_session_open`, open/composer.ts:3248-3272 — the
  comment narrates the whole wedge). If the owner does not reconnect, the row sits at
  `import_analysis_presented` with its accept button deliberately suppressed — the exact PR #107
  wedge, now gated on user activity instead of boot.
- Same file, same handler: post-import finalize recovery (:3236-3247) and the seeded-welcome self-heal
  (:3302-3309) are also parked in `on_session_open` — the reconnect handler has become the de-facto
  recovery sweep for whatever last wedged.
- Wow dispatch crash-resume re-fires only inside `engine.start` (engine.ts:739-755) — again
  activity-gated, not boot-gated.
- Leak symptom of the missing primitive: every 3 s watcher tick pushes a fresh
  `realmodeCleanups.push(() => clearTimeout(t))` closure into the boot-lifetime cleanup array
  (open/composer.ts:2521-2524) — ~600 entries per 30-min watch, never removed, growing per import for
  the life of the process.

**Why it matters.** The invariant that keeps this class of bug dead is: *at any moment, the set of armed
watchers must be recomputable from durable state*. Today it is the union of "every event handler that
remembered to arm" — and each incident adds one more arming point.

**Proposal.** An idempotent `rearmFromDurableState()` sweep run at composition time (and optionally on a
slow cron): scan `onboarding_state` for import-active phases → arm the watcher; wow_fired-without-
watermark → re-fire dispatch (same guards as engine.start). Keep event arming as the fast path; the
sweep is the safety net. Replace per-tick cleanup pushes with one owned timer handle per watcher.

**Behavior risk.** Low-medium: boot re-arm can race the reconnect re-arm — the existing
`importWatchActive` guard (:2483) and the idempotent upsert/finalize already handle double-arming;
add a test that boots with an `import_analysis_presented` row and asserts single consumption.

---

### F5 (P2, M) — Five hand-rolled tick loops share the same blind spots: escaping rejections, no quiesce, unwired drain

**Evidence.**
- All loops fire `void this.runOnce()` / `void this.fireOnce(name)` / `void this.poll()` from timer
  callbacks (trident/tick.ts:129-131; reminders/tick.ts:103-105; cron/scheduler.ts:155,211,265-266;
  project-backup-scheduler.ts:130-133; agent-watcher same pattern). Per-item try/catch is disciplined,
  but **store-level throws escape**: `listNonTerminal` (tick.ts:154) and the reminder claim writes
  (`advanceRecurrence`/`markFired`, reminders/tick.ts:150-177) sit inside try/finally with no catch;
  cron's `state.record` (scheduler.ts:351-358) and the backup poller's `readLastAttemptedAt`
  (project-backup-scheduler.ts:165) are unprotected. A transient SQLITE_BUSY exhaustion
  (`BusyRetryExhaustedError` is deliberately non-retryable, persistence/retry.ts:49-56) becomes an
  unhandled rejection — and there is **no process-level unhandledRejection handler anywhere** — so the
  tick dies silently for that round with nothing counting consecutive failures.
- `stop()` clears the timer but never awaits an in-flight tick (all five loops), so shutdown proceeds to
  `db.close()` (gateway/index.ts:385-458) while a tick may still be mid-write. The one quiesce seam ever
  built — trident's `drain()` (orchestrator.ts:188) — is destructured away and never called:
  build-core-modules.ts:415 takes only `{ step }`; module shutdown is `loop.stop()` (:424).

**Proposal.** One `SupervisedLoop` primitive owning: single-flight, per-tick catch-all with a
consecutive-failure counter and escalation hook, stats, and `stop(): Promise<void>` that awaits the
in-flight tick. Adopt it in trident/reminders/backup/sweeper (cron's scheduler can keep its calendar
logic and delegate its fire path). Wire trident `drain()` into module shutdown while there.

**Behavior risk.** Low if the primitive replicates current semantics exactly (skip-not-stack, per-item
isolation, hook-after-persist ordering — tick.ts:154-186 exactly-once terminal delivery depends on
`listNonTerminal` + save-then-hook ordering; reminders' claim-before-dispatch #319 must not move).
Port the existing loop tests wholesale.

---

### F6 (P2, M) — Cancellation marks rows but never stops work; terminal writes bypass a single chokepoint

**Evidence.**
- Board-item delete / X-cancel writes `phase:'stopped'` directly through the store
  (gateway/http/work-board-surface.ts:286-305). The comment claims this prevents the run "keep building
  headless" — it does not: only harvesting stops; the detached inner workflow keeps building on the warm
  substrate to completion and writes an `inner_result` nobody reads. There is no kill/abort seam on the
  fire substrate even though the Workflow runId is known.
- Because the write bypasses the tick/orchestrator, the terminal-observer chain (delivery → board
  reconcile → skill-forge audit, build-core-modules.ts:341-380) never fires for stopped runs; the
  in-memory `fired` set self-heals only on a later no-op step (orchestrator.ts:404-407).
- Synthesis import `cancel()` adds to an in-memory Set that is consulted only AFTER the synthesis
  session finishes (build-synthesis-import-runner.ts:191) — the substrate keeps consuming tokens for the
  whole run; the Set itself dies on restart.

**Proposal.** One store-level `terminate(run, phase, reason)` used by stop/X-cancel/delete/reap that
also runs the observer chain (or records why not), plus a best-effort cancellation seam threaded to the
detached work: a kill(runId) on the fire substrate for trident; an AbortSignal checked between synthesis
read passes for imports.

**Behavior risk.** Medium: killing detached workflows is a behavior change (today they finish and waste
tokens; after, they die mid-build — worktree cleanup finally{} blocks must still run). Land the
single-chokepoint refactor first (behavior-identical), the kill seam second (flagged, observable).

---

### F7 (P2, M) — Live-delivery subscriptions are duplicated registries + producer-side guessing (the PR #105 class is patched per-producer, not fixed)

**Evidence.** Two live registries for two topic grammars (`WebChatSenderRegistry` chat-bridge.ts:162;
`InMemoryAppWsSessionRegistry` session-registry.ts:1-15, which admits it exists "so a future
consolidation can fold both"); reminders were fixed by rerouting to the app registry (PR #105/#106),
then the proactive brief had the identical bug and identical fix (open/composer.ts:1904-1911: "the
previous `web:` + `landing.registry` path reached no app-ws client — same live-delivery bug as
reminders, now fixed for both"); work-board live opens a second socket to the same topic because
there is no frame bus (app/lib/work-board-live.ts:5-11). The correct delivery discipline —
durable row first, live push best-effort (reminders/outbound.ts:7-18) — is re-implemented per producer.

**Proposal.** One subscription registry keyed by parsed topic id (`parseAnyTopicId` already exists,
channels/topic-id.ts) behind a `deliver(topic, envelope)` helper that owns durable-row-first +
push-best-effort + throwing-sender eviction. Every timer/cron producer (reminders, briefs, nudges,
run-progress, work-board changes) calls the helper; no producer names a registry again.

**Behavior risk.** Medium — delivery ordering/idempotency is riddled with load-bearing subtleties
(persist-first seq assignment, identity-guarded unregister, send-throw propagation for crash recovery,
chat-bridge.ts:202-219). Build the helper over the existing registries and migrate producers one at a
time with hydration-parity tests; fold the registries last.

---

### F8 (P2, S) — Boot-order and failure-attribution safety by convention: silent-no-op holders and bare fire-and-forget

**Evidence.** Four late-bound holders in the composer (dispatchBoardHolder open/composer.ts:654,
importWatchHolder :1329, onboardingMsgHolder :2321, appWsHolder :2689) are consumed through optional
chaining (`dispatchBoardHolder.store?.attachRun(...)` :658-661; `importWatchHolder.watch?.(...)` :1333;
`void appWsHolder.adapter?.send(msg)` :2731; `onboardingMsgHolder.emit?.(input) ?? Promise.resolve()`
:2347) — an invocation before fill (or after a refactor reorders the 3,200-line closure) silently drops
the work instead of failing. The safety argument is a comment: "the store is always populated by the
time `dispatch()` runs" (:649-654). Separately, 28 bare `void fn(...)` sites have no shared envelope —
no name, no counter, no last-error surface; whether a voided rejection even gets logged depends on the
runtime's default unhandledRejection behavior (no handler is installed).

**Proposal.** (a) Replace holders with a two-phase `late<T>(name)` that THROWS if dereferenced before
`bind()` — turning ordering regressions into loud boot failures; (b) a `fireAndForget(name, p)` wrapper
(log + counter + optional escalation) required by lint for every voided promise; (c) install one
process-level unhandledRejection logger in boot().

**Behavior risk.** Low. The throw-before-bind change converts today's silent no-op into an error — audit
each holder's earliest possible consumer first (they are all post-boot request/turn paths).

---

### F9 (P3, S) — Liveness thresholds scattered and mutually stale

**Evidence.** trident liveness spans five constants in four files with no shared module: 10 m display
warn whose comment still documents the reap as "(15m)" (run-progress.ts:24-30) vs the real 25 m reap
(orchestrator.ts:184) vs 2 h ceiling (:168) vs 90 s tick (tick.ts:121) vs 3 m fire settle
(inner-loop.ts). The subagent watchdog default is another 5 m constant (watchdog.ts:60) plus a
deprecated alias (lifecycle.ts:32). Tuning requires grep-archaeology; the stale comment already misled
one mapper.

**Proposal.** `trident/liveness.ts` (and a runtime equivalent) exporting the constants with a unit test
asserting `warn < reap < ceiling` and `keepalive < synthesis idle window`; fix the stale comment.

**Behavior risk.** None (constant relocation).

---

## 4. Proposed primitives (the consistent shape)

1. **Durable job queue** (`job_runs` + JobHost): every background unit of work a user waits on gets a
   row before the work starts, terminal state + result persisted, boot resume sweep with
   fresh/retry/hard-fail windows. Templates already in-repo: profile-pic store + restart-resume;
   pending-respawns "disk is the source of truth".
2. **SupervisedLoop**: single-flight, per-tick catch + failure counter + escalation, stats,
   `stop()` that quiesces. All timers go through it; it registers in the LoopRegistry.
3. **LoopRegistry + boot inventory assertion**: cron's "N job(s) ticking" generalized; one
   production-composer test pins the loop set (the ISSUE #32 pattern, applied to loops).
4. **Subscription registry + deliver() helper**: one topic-keyed registry; durable-row-first delivery
   as a function, not a convention.
5. **Idempotent re-arm on boot**: arming derived from durable state at composition; event arming stays
   as the fast path; `on_session_open` stops being the recovery dumping ground.
6. **Cancellation seam**: `terminate()` chokepoints + AbortSignal/kill threaded to detached work.

Migration order (lowest risk first): F9 constants → F8 holders/wrapper → F5 SupervisedLoop (port loop
tests) → F3 LoopRegistry + inventory test → F4 re-arm sweep → F1 job table (synthesis import, then
subagent registry) → F2 watchdog decision → F6 kill seams → F7 delivery consolidation.

## 5. Load-bearing subtleties this refactor must NOT break (verified)

- Exactly-once terminal delivery depends on `listNonTerminal`-only sweeps + save-before-hook
  (trident/tick.ts:154-186). Any job-table generalization must preserve "changed→terminal implies fresh".
- Reminder claim-before-dispatch + compare-and-swap revert (#319, reminders/tick.ts:130-177) — the
  at-most-once-on-crash path is deliberate.
- Orchestrator `fired`/`redispatched` are per-process ON PURPOSE (restart = orphan detection,
  orchestrator.ts:198-205); persisting them changes crash semantics.
- Warm fire substrate is a singleton; per-fire substrates would kill detached workflows on settle
  (inner-loop.ts:296-311). Any kill seam must target the workflow, not the substrate session.
- Cron: `started` flag prevents double-binding between `start()` sweep and `onRegister`
  (scheduler.ts:87-130); catch-up fires once, never per missed occurrence (:219-266).
- Backup scheduler (if ever wired): `writeLastAttemptedAt` BEFORE the snapshot fires is the
  restart-loop guard (project-backup-scheduler.ts:176-194).
- Ephemeral one-shots must never enter the pending-respawn queue (replayed internal prompts would be
  redelivered to the user's chat topic — persistent-repl-substrate.ts:2861-2877).
- The engine's import hard-timeout anchors on the durable `job.started_at`
  (engine-import-routing.ts:998-1001) — a boot orphan-sweep must not race it into double-failure UX.
