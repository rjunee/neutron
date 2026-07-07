# Critic report — Errors & Observability

Repo: /Users/ryan/repos/neutron-open @ d30280c. All counts exclude node_modules, tests, `__tests__`, and `.claude/worktrees`.

## 0. Executive summary

Neutron Open has unusually *good* micro-level failure isolation (per-row try/catch loops, edge-latched detectors, honest-failure gates, fail-soft memory) and essentially *zero* macro-level observability. There is:

- **No logging framework.** 468 raw `console.*` calls (298 warn / 79 info / 66 error / 25 log) plus 36 `process.stderr.write` calls, in at least four incompatible conventions, with no levels, no global verbosity control (the only knob is `NEUTRON_REPL_DEBUG=1`, adapter-scoped), and ~34 per-module hand-rolled `log?:` DI seams each with its own signature.
- **No error taxonomy.** 139 ad-hoc `class XError extends Error`, 54 distinct HTTP error-code strings minted per-surface, and — most damaging — typed error metadata (`retryable`, `retry_after_ms` on the substrate `Event`) that is **flattened into a message string at the central seam and then re-derived downstream by regex** in at least four places.
- **No diagnostics surface.** `/healthz` returns `{status:'ok', project_slug, uptime_ms}` and nothing else; the systemd watchdog tick is an unconditional `setInterval(sdNotify('WATCHDOG=1'))` (event loop alive = healthy); `neutron doctor` checks only GBrain. Every known degradation mode (GBrain latch, core install failures, credential cooldown saturation, capped/wedged REPL sessions, failing cron jobs, dead import results) is invisible to the owner unless they read journald or open SQLite by hand.
- **A whole tier of built-but-unwired degradation reporting.** The persistent-REPL substrate defines five DI notice sinks (`onRecoveredReply`, `onDeadTurnNotice`, `onSizeAlert`, `onRateLimitBanner`, `onModelUpdate`); **none is wired by the Open composer**, and the in-band fallback (`kind:'status'` events pushed onto the active turn's channel) is **dropped by every production consumer** (`collectTokensToString` treats `status` as "informational" and discards it). The watchdog package's notifier is a literal no-op. `cron_state` records per-job errors that nothing reads.

The codebase *knows how to do this right in miniature* — onboarding telemetry is a typed, leveled, durable event journal (`gateway_events` table with `(ts, level, module, event_name, payload_json)`), the GBrain latch logs exactly once, the rate-limit banner detector is edge-latched. The refactor should generalize those three patterns (durable event journal, leveled tagged logger, log-once/latch helpers) rather than invent anything new.

Finally — and this matters for a NO-FUNCTIONALITY-CHANGE refactor — many of the "silent swallows" are **load-bearing on purpose**. Section 8 catalogs the deliberate fail-soft/fail-open decisions that a well-meaning "add error handling everywhere" pass would break (the sender registry that MUST throw, the persist-failure that MUST report `was_new:true`, the email LLM stub that MUST throw, etc.).

---

## 1. The logging landscape (evidence)

### 1.1 Raw counts

```
console.warn   298      catch (e) {...}        698
console.info    79      bare catch {}          582
console.error   66      .catch(() => {}/null)   41
console.log     25      process.stderr.write    36
```

Comment idioms marking intentional degradation: 199 hits for "best-effort", 234 for "never block / must never break / must never crash / never throws / swallow".

### 1.2 At least four logging conventions coexist

1. **Tagged key=value ("event=") style** — the best one, used in only ~11 files (65 distinct `event=` names). Example: `gateway/realmode-composer/build-live-agent-turn.ts:1429-1431` (`${LOG_TAG} event=send_failed err=...`), `gateway/http/chat-bridge.ts` (LOG_TAG family).
2. **Tagged JSON style** — `gateway/storage/binary-store.ts:65` (`[docs.binary] ${event} ${JSON.stringify(fields)}`), `gateway/git/doc-version-store.ts:171`, `gateway/git/project-backup-store.ts:180`, `gateway/git/project-backup-scheduler.ts:113`, `gateway/comments/anchor-walker.ts:285`.
3. **Tagged freeform** — ~30 files with `[scribe]`, `[cores]`, `[push]`, `[app-ws]`, `[open]`… prefixes and prose messages (e.g. `channels/adapters/app-ws/adapter.ts:189-193`, `scribe/index.ts:167-169`).
4. **Untagged freeform / stderr** — `cron/scheduler.ts:173-176` (`cron scheduler: skipping job…`), `trident/tick.ts:174-185` (`trident advance failed for run…`), and 36 `process.stderr.write` sites concentrated in the persistent-REPL adapter (`[session-size]`, `[rate-limit-banner]`, `[resume-picker]` at `persistent-repl-substrate.ts:520,550-552,602-604`).

### 1.3 34 hand-rolled logger DI seams

`grep "log?: ("` finds 34 per-module optional log-sink declarations (e.g. `doc-search/indexer.ts`, `reminders/dispatcher.ts`, `gateway/cores/install-bundled.ts:108`, `onboarding/interview/llm-router.ts`, `gbrain-memory/gbrain-doctor.ts`, `runtime/adapters/claude-code/persistent/session-respawn.ts`…), each with a slightly different signature (`(msg)`, `(msg, err)`, `(event: SyncHookFailureEvent)`, `(msg, fields)`). This is the *right instinct* (testable sinks) implemented 34 separate times. These seams are also the cheapest adoption path for a real logger: they can be satisfied by `logger.warn` adapters without touching call sites.

### 1.4 No levels, no verbosity control, no spam guards as a convention

- The only debug flag anywhere is `NEUTRON_REPL_DEBUG=1` (`runtime/adapters/claude-code/persistent/persistent-repl-substrate.ts:264`); there is no `LOG_LEVEL`/`NEUTRON_LOG` (grep: zero hits).
- Log-once / dedupe exists only where an incident forced it: the GBrain unavailability latch (`gbrain-memory/GBrainSyncHook.ts:141-148,306-313` — "logged once, no per-page/per-edge failure storm"), the rate-limit-banner rising-edge latch (`persistent-repl-substrate.ts:579-585`), `wedgeAlertState` cooldown map (`persistent-repl-substrate.ts:3153,3571-3605`). Everything else re-logs on every occurrence: a permanently failing cron job logs every tick forever (`cron/scheduler.ts:343`), a failing chat-log append logs per message (`channels/adapters/app-ws/adapter.ts:189`), trident logs per run per 90s tick (`trident/tick.ts:184`).

---

## 2. Error propagation conventions

### 2.1 What is actually good

The per-loop isolation discipline is consistently applied and correct:

- `trident/tick.ts:158-186` — per-run try/catch; terminal-delivery hook in its own try/catch AFTER persist so a posting failure can't undo the save.
- `cron/scheduler.ts:339-360` — handler throw → `status:'error'` recorded to `cron_state` with duration; the tick loop survives.
- `onboarding/wow-moment/action-runner.ts:43-67` — hang→handled 60s timeout with a typed `ActionTimeoutError` sentinel (born from prod incident t-33333333).
- `gateway/composition.ts:413-426` — graph teardown if HTTP composition throws; `gateway/index.ts:236-255` — db.close on composer throw.
- The Bun.serve catch-all (`gateway/index.ts:309-331`) keeps the listener up on any handler throw.

### 2.2 The three propagation styles, undocumented

1. **Throw typed error → boundary converts** (InterviewError('send_failed') in the chat bridge; EntityWriteError with a code union at `runtime/entity-writer.ts:219-226`; BusyRetryExhaustedError in persistence).
2. **Return degraded value** (`null`/`[]`/`0`/`false`) — the dominant composer style: `open/composer.ts:1551` (projects list → `[]` on ANY db error), `:1516` (unread → 0), `:1650` (cookie claim → false), `:2595` (system-prompt fragment → null).
3. **Result-ish objects** — `{ ran: false, reason }` (scribe), `{ fired: false, reason: 'timeout' }` (wow), `{ status, detail }` (cron handlers), `RespawnOutcome`.

No file says when to use which. The 582 bare `catch {}` sites are mostly style 2 without any log — the degradation is invisible even to journald.

### 2.3 Concrete silent-loss examples (verified)

- **Web client bundle build failure → silent 404.** `landing/server.ts:1243-1262`: `Bun.build` failure (either `result.success === false` or a throw) → `return null` → `landing/server.ts:1379` returns `404 'chat-react.js unavailable'`. `result.logs` (the actual compile errors) are discarded; **not one log line is emitted**. The entire web chat client can be down with zero diagnostic.
- **Prewarm failure is fully silent.** `open/composer.ts:3661-3684` — `prewarmSubstrate` catch is bare ("best-effort warm-up — never blocks boot, never throws"). If the warm-up fails because credentials are dead or the claude binary is missing, nothing is logged; the user's first turn just times out into a fallback elsewhere.
- **Projects sidebar silently empties.** `open/composer.ts:1544-1553` — any exception in the projects query returns `[]`; the UI shows "no projects" indistinguishably from a real empty state.
- **Supervision dir mkdir failure silently degrades all REPL supervision.** `runtime/adapters/claude-code/index.ts:248-255` — "a write failure later degrades supervision, never bricks" — registry, heartbeat, pending-respawns all ENOENT-degrade with no surfaced signal.
- **Import result loss on restart** (onboarding-flows mapper's P0, confirmed shape): `gateway/realmode-composer/build-synthesis-import-runner.ts` holds results in an in-process Map; a restart orphans pass1-running rows with no boot sweep and no "your import silently died" message.

---

## 3. Silent degradation catalog

| Degradation | Where decided | Signal emitted | Owner-visible? |
|---|---|---|---|
| GBrain binary missing → ALL memory writes no-op forever | `gbrain-memory/GBrainSyncHook.ts:141-148,306-313` | one console.error, then latched silence | Only via `neutron doctor` run by hand |
| GBrain deferred edges dropped on restart (RAM-only queue) | `GBrainSyncHook.ts:138-139` | none | No |
| GBrain init failure → logged no-ops | `gbrain-memory/ensure-brain-init.ts:117-193` | console | No |
| Scribe extraction failure / budget exhaustion | `scribe/index.ts:198,234` | console.warn per event | No |
| Core install failure (below 50% gate) | `gateway/cores/install-bundled.ts:245-280,619-643` | console.warn + in-memory `state.failures` | **Yes** — `cores-surface.ts:480` exposes `install_error` (the good example) |
| Credential pool all-cooldown | `build-llm-call-substrate.ts:437-442` | error event on the turn | Mid-turn only; no ambient status |
| REPL session capped (`capped_at`) after 3 respawns/hr | persistent adapter registry | stderr | No (respawn endpoint exists, no list/status endpoint) |
| Transcript ≥5/10 MB size alert | `persistent-repl-substrate.ts:537-558` | stderr + status event **that every consumer drops** | No |
| Rate-limit / usage-cap banner | `persistent-repl-substrate.ts:585-615` | stderr + dropped status event; `onRateLimitBanner` unwired | No |
| Mid-turn API-5xx dead turn | `onDeadTurnNotice` (`claude-code/index.ts:133`) | sink unwired in Open | No |
| Crash-dropped assistant reply | `recovered-reply-store.ts` + `chat-bridge.ts:991-997` ("Open self-host … no recovered reply is ever produced") | none on Open | No |
| Cron job failing every tick | `cron/scheduler.ts:343-359` → `cron_state` | DB row + console | No (nothing reads cron_state; see §7) |
| Wow action failed/timed out | `wow-moment/action-runner.ts` → `failed[]` | dispatcher log | No |
| Import job orphaned by restart | `build-synthesis-import-runner.ts` results Map | none | No |
| Chat-log persist failure → reply without seq (invisible to later resume) | `channels/adapters/app-ws/adapter.ts:184-196` | console.warn | No |
| systemd watchdog: process wedged-but-loop-alive counts as healthy | `gateway/index.ts:370-382` | n/a | n/a |

The pattern: **the decision to degrade is almost always right; the invisibility of the degraded state is the defect.** A self-hosted product must be able to answer "is my memory actually being written?", "why is chat slow?", "did my import finish?" without journalctl.

---

## 4. Error taxonomy: typed → string → regex

The substrate `Event` union is the one place errors carry structure: `{ kind:'error'; message; retryable; retry_after_ms? }` (`runtime/events.ts:56`). `build-llm-call-substrate.ts:59-63,423-541` carefully preserves taxonomy (`no_credentials` retryable:false / `all_cooldown` retryable:true / `oauth_refresh` false / binary-ENOENT fatal-not-retryable so it can't "launder into a 429 pool cooldown").

Then the single most-used consumer **destroys it**: `collectTokensToString` (`gateway/realmode-composer/build-llm-call-substrate.ts:823-825`) throws `new Error('cc-llm-call: ' + ev.message)` — `retryable` and `retry_after_ms` are gone. Downstream re-derives classification by regexing the message:

- `onboarding/history-import/job-runner.ts:2072-2083` — `is429RetryableError`: `/HTTP\s+429\b/i`, `/rate[_-]?limit/i`.
- `onboarding/history-import/substrate-callers.ts:402-406` — the same regexes, duplicated "so the substrate caller doesn't take a runtime dependency on the runner".
- `gateway/realmode-composer/build-live-agent-turn.ts:1445-1447` — `isFreezeTimeout`: `/turn timeout/i || /\baborted\b/i` distinguishes "wedged" from "your setup is broken" **purely by message text** produced by two different modules (the adapter's `persistent-repl: turn timeout` and the composer's own `cc-llm-call: aborted`).
- 8 more `message.includes`/regex classification sites repo-wide.

This is the classic brittleness bomb: renaming an error message in the adapter (a "cosmetic" refactor) silently reclassifies timeouts as credential faults and 429s as permanent failures. The messages are load-bearing API.

Adjacent taxonomy sprawl: 139 `class XError extends Error` definitions (16 in `app/lib/*-client.ts` alone), duplicated `CapabilityDeniedError` (`cores/sdk/secrets.ts:63` vs `cores/runtime/errors.ts:56`), 54 distinct `jsonError` code strings minted ad hoc per surface with no registry (top: `malformed_json` ×20, `missing_path` ×15, `method_not_allowed` ×15 — each duplicated per file).

---

## 5. Diagnosing a wedged session in prod — the walkthrough

What an owner/operator actually has today when chat stops responding:

1. `/healthz` — `{status:'ok', uptime_ms}` (`gateway/index.ts:477-496`). Says nothing.
2. `neutron logs` — journald/launchd tail: unleveled console noise in four formats.
3. `neutron doctor` — GBrain only (`bin/neutron:87-95`).
4. The on-disk registry `~/.neutron/repl-registry.json` (`runtime/adapters/claude-code/index.ts:185-195`) — session keys, pids, respawn counts, `capped_at`. **Readable only by hand; no endpoint lists it.**
5. `POST /admin/respawn-session?session=<sessionKey>` (`gateway/http/admin-respawn-surface.ts`) — the ONLY remediation endpoint, which requires a sessionKey the operator can only obtain from step 4.
6. `NEUTRON_REPL_DEBUG=1` + restart — enables `debugRing()` PTY inspection (`pty-ring.ts:8`), i.e. diagnosis requires a restart that destroys the wedged state being diagnosed.

Meanwhile the substrate *internally* knows: lastDataAt, wedge verdicts, respawn cooldowns/caps, size severities, rate-limit banners, model-update state — a `buildStatusSnapshot`-shaped tick already assembles per-session facts for watchdog decisions (`persistent-repl-substrate.ts:3553-3605`). None of this is exported as a queryable surface.

### The unwired notification tier (verified)

- `onDeadTurnNotice`, `onSizeAlert`, `onRateLimitBanner` (`runtime/adapters/claude-code/index.ts:133-135,226-231`): repo-wide grep shows **only runtime files** reference them — no gateway/open wiring exists.
- The in-band fallback pushes `{kind:'status'}` onto the active turn's channel (`persistent-repl-substrate.ts:550,602`) — but `collectTokensToString` drops status events (`build-llm-call-substrate.ts:826` "informational"), and no other production consumer forwards them (grep across gateway/onboarding/channels/trident/agent-dispatch: zero hits).
- `onRecoveredReply`: threaded at `build-llm-call-substrate.ts:484` when provided; `open/composer.ts` has zero "recovered" references; `chat-bridge.ts:995` documents Open as the "no recovered reply is ever produced" case.

Net: the user sees a usage-capped or size-critical session as "Neutron got slow/stopped answering", with the honest explanation written to stderr where nobody looks.

---

## 6. healthz + watchdog depth

- `/healthz` (`gateway/index.ts:477-496`): status/slug/uptime. No DB probe, no substrate-pool state, no memory-sync state, no cron state, no degraded-mode flags.
- systemd watchdog (`gateway/index.ts:370-382`): unconditional `sdNotify('WATCHDOG=1')` every 5s. It proves the event loop spins — correct as *liveness*, but there is no *readiness/health* concept anywhere in the product.
- The HTTP catch-all 500 (`gateway/index.ts:324-330`) logs `'http handler threw:' + err` with **no method/path/context** and returns `text/plain 'Internal Server Error'` — breaking the `{ok:false,code,message}` JSON contract every app surface otherwise maintains (12 `jsonError` copies) and that the Expo/web clients parse.
- No access log, no request id, no correlation of any kind (grep for request_id/x-request-id in gateway/: only git-remote and unrelated hits). When a surface 500s in prod, the only artifact is a context-free stack in journald.
- The silent-404 regression class (forgotten CompositionInput field → surface absent; `gateway/composition.ts:264-295` gate already diverged from the mapping per the boot mapper) has no runtime counterpart of a route manifest — the server cannot report which surfaces it actually mounted.

---

## 7. Failure state that is captured but never read

- `cron_state` records `(job_name, fired_at, duration_ms, status, error)` on every fire (`cron/scheduler.ts:351-359`). Readers: only `watchdog/detectors.ts:194-202` (OverrunCronDetector) — which is **never registered** in production (`gateway/composition/build-core-modules.ts:488-494` registers only Heartbeat/Stuck/Crashed and the comment admits the other three "wired in sprints S5/S6"). The wow overnight action even writes cron_state "so observability can answer when…" (`onboarding/wow-moment/actions/07-overnight-pass.ts:71-74`) — nothing ever asks.
- `watchdog_alerts` table + `AlertStore` (`watchdog/alert-store.ts:25-63`): the supervisor persists alerts and dispatches through `input.watchdog_notifier` — which Open wires as `{ notify: async () => undefined }` (`open/composer.ts:3435`), with `heartbeat_tracker: { lastHeartbeatAt: () => Date.now() }` (`:3439`) so HeartbeatDetector can never fire, and Stuck/Crashed depend on a ProcessRegistry with no production `register()` callers. The package is decorative; its tables are write-only (when written at all).
- `gateway_events` (onboarding telemetry, `onboarding/telemetry/event-emitter.ts:536-542`): a real durable, typed, leveled event journal `(ts, level, project_slug, module, event_name, payload_json, duration_ms)` — the best observability primitive in the repo, scoped to onboarding events only, read by the metrics view + week-4 collector.

The refactor should treat `gateway_events` as the seed of the product-wide degradation journal instead of inventing a new table.

---

## 8. Load-bearing fail-soft/fail-open invariants (DO NOT "fix" during the refactor)

These are places where swallowing, throwing, or degrading is **deliberate and semantically required**. A refactor that normalizes error handling must preserve each of these bit-for-bit; each is documented only in comments today.

1. **Sender registry MUST propagate throws** — `gateway/http/chat-bridge.ts:202-219`: catching a closed-socket throw here silently downgrades to `was_new=false`, `delivered_at` gets stamped wrongly, and reconnect re-emit recovery dies. (Codex r1 P1 rationale in-code.)
2. **AppWs persist-failure fails OPEN twice**: agent reply falls back to no-seq live emit (`channels/adapters/app-ws/adapter.ts:184-196`); user-message persist failure reports `was_new:true` on purpose so the turn still dispatches (`adapter.ts:300-356`).
3. **Substrate error taxonomy strings are API** — `isFreezeTimeout` (`build-live-agent-turn.ts:1445-1447`) and the 429 regex family (§4) mean adapter error MESSAGES are contract. Any wording change is a behavior change.
4. **Binary-ENOENT must stay non-retryable** so it can't launder into a 429 cooldown (`build-llm-call-substrate.ts:515-523`); `all_cooldown` must stay retryable:true (`:437-442`).
5. **Email triage LLM stub THROWS by design** so triage renders its deterministic fallback (`gateway/cores/mount-open-cores.ts:177-277`); agent-settings fallbacks must report `available:false`, never fake success (`gateway/boot-helpers.ts:1163-1180`).
6. **Reminder dispatcher degrades to literalFallback on ANY LLM failure** so a reminder always delivers (`reminders/dispatcher.ts`); outbound is persist-before-send with swallowed live-push throws (`reminders/outbound.ts:7-18`).
7. **Engagement gate fails soft to `all_messages`** — a DB read error must never drop a chat turn (`gateway/http/chat-bridge.ts:2749-2791`).
8. **wow-push emitter fails CLOSED** (skip + warn, never pushAll) for privacy (`gateway/wow-push-emitter.ts:105-171`) while calendar/email briefs intentionally DO pushAll — opposite policies, both correct.
9. **GBrain latch + remove-before-add + append-only merge** (`GBrainSyncHook.ts:199-256`; `scribe/write-to-gbrain.ts:19-41`) — fail-soft with exactly-once logging is the contract; chat turns must never crash on memory.
10. **`InMemoryWebChatSenderRegistry` identity-guarded unregister, recovered-reply drain topic gating, recordInboundReceived-before-advance** — error/ordering invariants a "cleaner" async refactor could reorder.
11. **Import honest-failure gate**: attempted>0 && succeeded==0 && projects==0 → `failed`, never a blank `completed` wow (`build-synthesis-import-runner.ts:203-220`).
12. **429 exhaustion → `rate_limit_paused` (resumable), never `failed`** (`job-runner.ts:1604-1619`); cooling-off overlay on `error_message` must be cleared on success (`:1414-1427`).
13. **`drainSubstrateEvents` must NOT break on the completion event** (adapter teardown depends on iterator finishing, `substrate-callers.ts:486-510`) — an "early-return on completion" cleanup breaks teardown.
14. **cron missed-fire catch-up fires exactly once; unsupported grammar warns+skips** (`cron/scheduler.ts:166-177,191-234`) — converting the warn+skip into a throw bricks boot for Managed-grammar jobs.

**Recommendation:** before any error-handling refactor, land a `docs/` invariants inventory + a conformance test suite pinning items 1–5 and 11–13 (several already have tests; 3 and 13 do not).

---

## 9. Proposals

### 9.1 One `observability/` leaf package (logger)

- `createLogger(subsystem: string)` → `{ debug, info, warn, error }`, key=value line format (journald-friendly; matches the best existing convention, `LOG_TAG event=… k=v`), optional JSON mode, level from `NEUTRON_LOG_LEVEL`.
- Built-in `once(key)` and `rateLimited(key, interval)` helpers to replace the three hand-rolled latches and cover the unguarded storm paths (cron per-tick, per-message persist failures).
- Adoption path: (1) satisfy the 34 existing `log?:` seams with logger-backed defaults — zero call-site churn; (2) mechanical sweep of the 468 console sites keeping message text stable where tests pin it; (3) lint rule banning new bare `console.*` outside the package.
- Zero behavior risk if line content is preserved; tests that assert specific console output (a few sinks are capture-tested) must be migrated with the modules.

### 9.2 Degradation journal + diagnostics surface (the self-hosted product's "why is X broken")

- Generalize the onboarding `gateway_events` journal into a product-wide `system_events` writer (same columns; `module` = subsystem). Emit on every latch/degrade decision: gbrain_unavailable, core_install_failed, credential_all_cooldown, repl_session_capped, cron_job_error (rising edge), import_orphaned, bundle_build_failed.
- `GET /api/app/admin/diagnostics` composing **existing state, read-only**: gbrain latch + last sync success + deferredEdgeCount (getter exists), core install failures (`state.failures` / `core_installations`), credential pool via pure `hasUsableCredential`/`soonestCooldownUntil` probes, REPL registry sessions (key, age, lastDataAt, respawn count, capped_at) from `repl-registry.json`, cron last-fire per job from `cron_state`, import job statuses, recent `system_events`. Surface it in the Expo/web admin tab and extend `neutron doctor` to call it.
- Optionally deepen `/healthz` with a `?deep=1` readiness mode (DB `SELECT 1`, state-dir writable) while keeping the default byte-identical for anything scraping it.

### 9.3 Error taxonomy

- One `errors.ts` leaf: `NeutronError extends Error { code, retryable?, retry_after_ms?, cause }` plus a registered code table (union type) for the 54 HTTP codes and the substrate dispatch codes (`no_credentials`, `all_cooldown`, `oauth_refresh`, `binary_not_found`, `channel_wedged`, `turn_timeout`, `aborted`, `rate_limited`).
- Fix the flatten seam: `collectTokensToString` throws `SubstrateCallError` carrying `{code, retryable, retry_after_ms}` **with today's exact message text preserved** so `isFreezeTimeout`/429 regexes keep working during migration; then flip classifiers to `err.code` with the regex as fallback; then (only then) the strings stop being API.
- Fold the 12 `jsonError` copies into the surface-kit dedup the gateway-http critic will propose, keeping the wire bytes identical, and route the Bun.serve catch-all through the same shape (`{ok:false,code:'internal'}`, content-type json) — a small, flagged behavior change (body bytes of 500s change; grep clients for text-500 dependence first).

### 9.4 Wire the built-but-dead notification tier (flagged functional change)

- In `open/composer.ts`, wire `onSizeAlert`/`onRateLimitBanner`/`onDeadTurnNotice` to (a) `system_events` and (b) the app-ws registry as a system bubble on the owner's topic; wire `onRecoveredReply` to the existing `RecoveredReplyStore` + chat-bridge drain (all plumbing already exists and is tested).
- Decide watchdog package fate: either delete it (autonomous-work critic's option) or give it a real heartbeat source + a notifier that writes `system_events`/chat. The current state — a supervision package whose notifier is `async () => undefined` — is worse than either option because it reads as coverage that does not exist.

---

## 10. Cross-references

- Overlaps acknowledged: watchdog-inert and trident liveness constants (autonomous-work mapper), synthesis-import restart durability (onboarding-flows P0), surface-kit/jsonError dedup (gateway-http), CompositionInput silent-404 (boot-composition). My findings take the errors/observability angle only: the *visibility* of those failures, not their fixes.
