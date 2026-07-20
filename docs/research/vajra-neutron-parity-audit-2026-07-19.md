# Vajra → Neutron FULL Feature-Parity Audit — 2026-07-19

**Author:** Atlas (Vajra fleet research agent)
**Scope:** READ-ONLY. Capability-by-capability inventory of `~/vajra` mapped against `~/repos/neutron-open` at today's HEAD. Six parallel domain audits (gateway/chat surface, reminders/cron/rituals, agent fleet/overnight, memory/knowledge/ingestion, email/calendar/external tools, tasks/projects/ops/skills), every verdict cited file:line on both sides.
**Standard under test (CLAUDE.md, Ryan-locked):** Neutron is a faithful PORT of Vajra. If Vajra has it, Neutron ports it. A capability absent with no recorded drop decision is MISSING, not "scoped out."
**Classification:** PORTED (code + wiring verified, both composition paths checked: `gateway/composition.ts` AND `open/composer.ts`) · PARTIAL (half missing — stated precisely) · MISSING (absent, no recorded decision) · DROPPED (deliberate, decision cited).

---

## EXECUTIVE SUMMARY — M2 blockers in priority order

The engine is substantially closer to parity than the 2026-06-25 audit: five of that audit's headline gaps are now CLOSED (§4). What remains clusters into **one deliberate architectural drop with a five-ritual blast radius, one wiring bug that silently zeroes ambient memory ingestion, two dropped input modalities, and a long tail of absent personal tooling.**

### P0 — blocks daily-driving, in order

1. **Executor-mode reminders dropped → Ryan's entire ritual layer is dead.** Vajra reminders run in two modes; Neutron ported the nudge and deliberately dropped the executor (`reminders/prompt.ts:12-14` — "a NUDGE composer, not an executor… the substrate is wired read-only by the dispatcher"). In Vajra's **live** `gateway/reminders.json` (81 rows), exactly **5 enabled rows carry `prompt_file`** — and they are the load-bearing daily/weekly rituals: `morning-brief.md` (0 9 * * *), `evening-wrap.md` (0 19 * * *), `dreaming.md` (0 */6 * * *, sonnet), `kaizen.md` (0 17 * * 5), `book-sunday-refresh.md` (0 21 * * 0). Executor spawn machinery on the Vajra side: `gateway/gateway-core.ts:2846-2853` (isExecutorReminder), `:2829` (long timeout), `:3061` (smart-model), `:2292-2307` (fire-and-forget). Consequence in Neutron: **evening-wrap, dreaming, kaizen, book-sunday-refresh have NO equivalent at all** (grep-zero); morning-brief survives only as a shallow composed brief (`gateway/proactive/morning-brief.ts` — no overnight-log scan, no PR list, no multi-calendar read).
   *Fix shape:* add an executor dispatch branch to `reminders/dispatcher.ts` — `prompt_file` ⇒ spawn a smart-model agent with its own prompt, write scope, long wall-clock timeout, fire-and-forget delivery.

2. **Scribe calendar/email fan-out is wired but DATA-DARK.** The 2026-06-25 "nothing threads scribeFanOut" gap was half-fixed: `mountCoresScribeFanOut` now exists and IS called on the Open boot path (`open/wiring/memory.ts:315`) — but it is called **without `gmailClient`/`calendarClient`**, so it falls back to the in-memory stub clients (`gateway/cores/mount-cores-scribe-fan-out.ts:192, :217`) → empty inbox/calendar → **zero ambient email/calendar → memory extraction, even on a Google-connected box.** All tests pass; schedulers run; nothing arrives. The memory.ts comment acknowledges it as a "separate parity gap." This is the exact "reads as done" class this audit exists to catch.
   *Fix shape:* thread the OAuth `gmailClient`/`calendarClient` built in `gateway/cores/mount-open-cores.ts:73` into the `mountCoresScribeFanOut` call at `open/wiring/memory.ts:315`.

3. **Two of three inbound modalities dropped: voice notes and documents.** Vajra ingests photos (`gateway/index.ts:7073`), documents/PDFs (`:7104`), and voice notes with Whisper transcription (`:7137` + `whisper-transcribe.ts`). Neutron's upload surface (`gateway/http/app-upload-surface.ts`) whitelists PNG/JPEG/GIF/WEBP only; docs are explicitly punted ("a P7 docs routing concern"); **no transcription code exists anywhere in the repo** (grep-negative). Related: `POST /email-forward` (Vajra `gateway/index.ts:5239`, Gmail-forward-to-agent with v2 classification) has **no Neutron equivalent at all**.
   *Fix shape:* extend the upload whitelist + route doc path into the turn; add audio upload + transcription step; add an email-ingest surface.

4. **Autonomous memory consolidation (dreaming's mechanism) ships default-OFF.** `scribe/reflect/reflect-pass.ts` exists but is gated behind `NEUTRON_PERFECT_RECALL` (default off, `runtime/perfect-recall-flag.ts:13`; `scribe/index.ts:81` "NEVER arms by default"; `open/composer.ts:3399-3405`). A fresh install writes memory but never dedups/promotes/re-synthesizes — Vajra dreams every 6h. (Interlocks with blocker 1: even flag-on, this is the consolidation pass, not the full dreaming executor ritual.)
   *Fix shape:* arm the reflect loop by default (or a lighter default-on dedup pass).

5. **The chat surface Ryan actually lives on is still absent from Open.** Telegram remains disabled by design (`open/composer.ts:3435` `topic_handler: async () => undefined`, "single-owner has no Telegram channel"); the adapter + webhook factory exist with zero callers (`gateway/wiring/build-telegram-webhook.ts:98-101` — reserved for the out-of-repo Managed composer), so it greps as wired but is not. With the topic model went the topic-lifecycle command vocabulary (`/sleep /archive /promote /resume /new /status /reset /nudge`, Vajra `gateway/index.ts:7202-7680`), the `/post` echo-into-live-context behavior (`:4949`), and `vajra-attach` (`POST /attach`, `:4317`) — none have web equivalents. Whether this blocks M2 depends on whether cutover means "Ryan on Managed Telegram" or "Ryan on Open web chat" — but on either surface the missing commands/echo/attach are real losses.

### P1 — degrades daily use

6. **Google cores are composed but dead until manual OAuth bring-up, and single-account.** Cores ARE now composed into Open (`open/composer.ts:115` mountOpenCores, `:3473`) — the June finding is stale — but the OAuth surface only builds when `NEUTRON_CORES_GOOGLE_CLIENT_ID/_SECRET` are set (`gateway/cores/mount-open-cores.ts:78-80`); out-of-box the 3 Google cores `install_failed_runtime` (the "installed=7/10" in STATUS.md:19). A fresh owner must register their own Google Cloud OAuth app. And the model is **one Google grant** — Vajra merges 3 calendars/mailboxes (ryan@junee.org, quintessential, tabs.co; `docs/reference/tools/google-workspace.md:36-44`).
7. **Search recall regressions:** project-doc semantic search removed (`doc-search/store.ts:26` — vec seam deleted as "dead branch"; keyword-only now), HyDE mode missing entirely, no multi-collection scoping (indexer walks only `Projects/<id>/`, `doc-search/indexer.ts:4`), and cross-conversation message search is a per-topic no-op on the server path (`message-search-wiring.ts:11`).
8. **Personal tool layer largely unported, none with drop records:** travel search (SerpAPI flight/hotel — a Vajra HARD RULE, `scripts/flight-search.sh`), Google Slides + deck-export, Drive convert, image generation (`gemini-image.sh`), Oura health ingest, Granola meeting-notes pipeline, meeting-audio ingest (`scribe-meeting-ingest.sh`), tabs-cm-pull, robobuddha poller, IONOS DNS, Netlify deploy, tx-scrape `--thread/--article` modes (unverified), humanizer as an on-demand skill (only the em-dash/validating-openings subset survives in `cringe-check.ts`), last30days.
9. **Ops/hygiene tail:** no vault-hygiene sweep (stale-archive, INDEX.md generation, log rotation — `scripts/vault-hygiene.py` has no equivalent), no aggregate DASHBOARD.md / attention-needed.json (per-project projection only), worktree GC merge-time-only (crashed builds leak worktrees, `trident/merge.ts:202` vs no sweep in `terminate.ts`), no codex CLI auto-upgrade (`scripts/codex-upgrade.sh` unported), login-watchdog became operator-pull (lapsed Max token is silent; Vajra pushed a login button, `gateway/login-watchdog.ts`), event-loop-monitor missing, checkpoint-digest missing.

### Already-logged known gaps (confirmed, not re-derived)
- **Executor-mode reminders** — confirmed above (blocker 1).
- **Trident Ralph multi-task (#362)** — recorded **FIXED 2026-07-17** (`SPEC.md:421`, `docs/AS_BUILT.md:602`; re-fire loop in `trident/inner-workflow.mjs` + `orchestrator.ts refireNextRalphTask`, real multi-task E2E). Recorded-fixed, not live-verified here. Do not re-file.
- **#364/#368 flaky tests, #365 tenant orphan deploys, #367 tenant root 404, #369 apex marketing route** — Managed-side / already logged per the dispatch; out of this Open-engine table's scope. (Note: those numbers do not match `rjunee/neutron` GitHub numbering, where #362–#369 are merged refactor PRs — the dispatcher's tracker numbering could not be located on disk; flagging so the numbers get reconciled rather than trusted.)

---

## 1. FULL CAPABILITY TABLE

Legend: V = `~/vajra`, N = `~/repos/neutron-open`. Both composition paths were checked before any "unwired" verdict.

### 1a. Gateway HTTP surface + loops/watchdogs

| Capability | Vajra | Status | Neutron | Consequence / fix shape |
|---|---|---|---|---|
| `POST /reply` out-of-turn streaming reply | `gateway/index.ts:4803` | PORTED | `gateway/http/deliver.ts` (single delivery seam) + app-ws `agent_message` | — |
| `POST /post` + echo-into-live-CC-context | `gateway/index.ts:4949-5057` | **PARTIAL** | `/api/app/chat/send` + `deliver.ts` | Send works; splicing an out-of-band post into the RUNNING turn's context is absent. Fix: echo path in deliver.ts into live repl inbound. |
| `/reminders` CRUD | `gateway/index.ts:4413-4559` | PORTED | `gateway/http/app-reminders-surface.ts:8-10` + `/remind` | `GET /reminders/stale-drops` (V `:4448`) unverified in N. |
| `POST /agent/complete`, `/forge/delivered`, `/argus/delivered` | `gateway/index.ts:4606,4661,4724` | PORTED | subagent registry report + trident `on_run_terminal` → `trident/delivery.ts` | — |
| `POST /email-forward` (Gmail→agent ingest) | `gateway/index.ts:5239` | **MISSING** | none (grep-zero non-test) | Forwarded email can't reach an agent. Fix: email-ingest surface + core. |
| `POST /attach` (vajra-attach backend) | `gateway/index.ts:4317` + `skills/vajra-attach` | **MISSING** | none (pool-internal "attach" only) | Can't bind an external `claude` session to the chat surface. Fix: attach surface registering into repl-registry. |
| `POST /admin/restart` | `gateway/index.ts:4207` | PORTED | admin surface via `gateway/http/route-slots.ts` | — |
| `POST /admin/respawn-topic` | `gateway/index.ts:4233` | PARTIAL | `gateway/http/admin-respawn-surface.ts` (/admin/respawn-session) | Respawn is per-session, not per-topic (no topics). Acceptable given surface model. |
| `/list-topics /dispatch /create-topic /typing` (topic MCP backends) | `gateway/index.ts:5365-5457` | DROPPED (by-design) | `open/composer.ts:3432-3435` no-op topic_handler | No agent-driven topic creation/cross-topic dispatch in Open. |
| `/nudge/tick` | `gateway/index.ts:5470` | PORTED | `gateway/proactive/idle-nudge-sweep.ts` (wired `open/composer.ts:3448`) | — |
| `GET /health`,`/metrics` | `gateway/index.ts:4111,4182` | PORTED | `gateway/index.ts:771` `/healthz` + memory_health | — |
| `GET /agents` + kill | `gateway/index.ts:4394,5444` | PARTIAL | subagent registry + `/dispatch stop` | REST list/kill surface unverified; chat/MCP path exists. |
| heartbeat / cwd-drift / model-update+graceful-upgrade / session-size / in-flight gate / pending-respawns / pending-replay / post-spawn-assertion / disk-recovery | `gateway/*.ts` (respective) | PORTED | `runtime/adapters/claude-code/persistent/{heartbeat,cwd-drift,model-update}-watchdog.ts`, `session-size-watchdog.ts`, `in-flight-gate.ts`, `pending-respawns-queue.ts`, replay in `supervision.ts:511`, `post-spawn-assertion.ts`, `session-disk-recovery.ts` | Full supervision family ported. |
| banner-check watchdog | `gateway/banner-check-watchdog.ts` | PARTIAL | `rate-limit-banner.ts`, `api5xx-dead-turn-watcher.ts` | Rate-limit/5xx detection ported; tmux sentinel→respawn+post loop is arch-specific (dropped with tmux). Verify banner→respawn fires. |
| login-watchdog (proactive reauth push + button) | `gateway/login-watchdog.ts` | **PARTIAL** | `/api/app/admin/max-oauth/mint-reauth-token` (`app/lib/admin-client.ts:406`) | Pull-only: lapsed Max credential is SILENT until an operator checks. Fix: proactive expiry notifier + reauth affordance in chat. |
| pane-scan (auto-approve, stuck-typing) | `gateway/pane-scan-watchdog.ts` | PARTIAL/N-A | `interactive-prompt-deadlock-detector.ts`, `output-scan.ts`, `resume-picker-detector.ts` | Auto-approve unneeded (trust pre-seed); stuck-typing reaper for web chat unverified. |
| idle-kill-cascade | `gateway/idle-kill-cascade.ts` | PARTIAL/N-A | pool reap + `dead-repl-detector.ts` | Dead-session reap confirmed; idle-but-live eviction unverified. |
| event-loop-monitor | `gateway/event-loop-monitor.ts` | **MISSING** | none | Diagnostics-only loss. Port as observability sink. |
| crash-handler boundary block | `gateway/crash-handler.ts` | unverified | uncaught handlers in `gateway/index.ts` + `logger/fire-and-forget.ts` | Verify greppable crash boundary marker. |
| checkpoint-digest (SessionStart STATUS.md+tail splice) | `gateway/checkpoint-digest.ts` | **PARTIAL** | per-turn context in `gateway/wiring/build-live-agent-turn.ts` | The consult-live-sources checkpoint at session start isn't reproduced. Fix: fold STATUS tail into first turn. |
| auto-retry-recovery | `gateway/auto-retry-recovery.ts` | PARTIAL | `api5xx-dead-turn-watcher.ts` + substrate cooldown detectors | Coverage split differently; user-facing Retry affordance unverified. |

### 1b. Chat surface mechanics + prompts

| Capability | Vajra | Status | Neutron | Consequence / fix shape |
|---|---|---|---|---|
| Telegram end-to-end (topic-map, per-topic REPL) | `gateway/index.ts` + `topic-map.json` | **DROPPED in Open** (recorded) | `open/composer.ts:3432-3435`; adapter present, factory `gateway/wiring/build-telegram-webhook.ts:98-101` has zero callers (Managed-composer reserved); `/webhook/telegram` slot gated `route-slots.ts:640` | Greps as wired; is not, in Open. Surface decision owns this. |
| Per-surface persistent CC REPL | topic sessions | PORTED (re-scoped) | `runtime/.../persistent/repl-registry.ts`, `repl-session.ts` | — |
| enforce-reply Stop hook | Vajra hook | PORTED | `runtime/.../persistent/hooks/enforce-reply.ts` (via build-settings) | — |
| Typing indicators | `gateway/typing.ts` | PORTED | `landing/chat-protocol.ts:211-220` | — |
| Markdown rendering | `markdown-to-telegram.ts` | PORTED (target differs) | client render in `landing/chat-react/*`, `render-outbound.ts` | — |
| Inbound photo | `gateway/index.ts:7073-7101` | PORTED | `gateway/http/app-upload-surface.ts` + `envelope.ts:89` | — |
| Inbound document/PDF | `gateway/index.ts:7104-7135` | **MISSING** | whitelist images-only; docs punted "P7" | Blocker 3. |
| Inbound voice + transcription | `gateway/index.ts:7137-7148` + `whisper-transcribe.ts` | **MISSING** | grep-zero | Blocker 3. |
| Slash commands — topic lifecycle (`/sleep /archive /delete /promote /resume /agents /nudge /reset /new /status`) | `gateway/index.ts:7202-7680` | **MISSING** | N set = `/remind /skills /cal /email /note /research /scrape /dispatch /code` (`open/composer.ts:1367` chain) | Re-map still-wanted verbs (at least `/status`, `/reset`) to the web surface. |
| new-topic flow / cc-ready-activation / fleet-spawn-core | `prompts/new-topic.md`, `gateway/cc-ready-activation.ts`, `fleet-spawn-core.ts` | DROPPED (topic model) | onboarding is a mode of the single chat (`open/composer.ts:1372-1381`) | — |
| topic-agent-base prompt | `prompts/topic-agent-base.md` | PORTED (renamed) | `runtime/.../persistent/repl-agent-base.md` | Content-parity diff of the two prompts NOT done — unverified. |
| `prompts/general.md` / `new-topic.md` | those files | MISSING (topic-model artifacts) | none | Port any still-relevant guidance into repl-agent-base.md. |

### 1c. Reminders + cron + rituals

| Capability | Vajra | Status | Neutron | Consequence / fix shape |
|---|---|---|---|---|
| Store + fire tick + dispatcher | `gateway/gateway-core.ts:2260-2400` | PORTED | `reminders/{tick,store,dispatcher}.ts`; dispatcher seam wired `open/composer.ts:1717` | — |
| Nudge fire-time agent (Haiku) | `prompts/reminder-agent-base.md` | PORTED | `reminders/prompt.ts`, dispatcher FAST_MODEL | — |
| Three message shapes | `prompts/reminder-patterns.md:1-246` | PORTED | `reminders/message-shape.ts`, `prompt.ts:39-91` | — |
| **Executor mode** | `gateway-core.ts:2846-2853,:2829,:3061` | **DROPPED** (`reminders/prompt.ts:12-14`) | none | Blocker 1. Fix: executor dispatch branch. |
| Recurring create — agent/MCP path (incl. cron) | remind `SKILL.md:93-107` | PORTED | `cores/free/reminders/src/backend.ts:315-368` → `store.createRecurring`; forwarded `tools.ts:107` | June "one-shot only" note is STALE. |
| Recurring create — typed `/remind` chat surface | same | PARTIAL | `chat-commands.ts:706` rejects; parser hard-rejects daily at `:382,:388`; docblock `:44-47` stale | Typing "/remind every day…" fails; agent path works. Fix: route recurring branch to existing backend.create. |
| Snooze/cancel/update | `SKILL.md:5,163` | PORTED | `backend.ts:385,466,548` | — |
| Disable/enable (pause) | skill ops | **PARTIAL** | status enum has no `disabled` (`backend.ts:98,135`) | Pause = destroy-and-recreate. Fix: `enabled` column + tools. |
| Timezone | host-local cron | PORTED (single-owner parity) | `reminders/tick.ts:96` hostTimeZone | Per-owner TZ col only matters multi-host. |
| Ritual: morning-brief | `prompts/morning-brief.md`, cron 0 9 * * * | **PARTIAL** | `gateway/proactive/morning-brief.ts` | Composed-from-wired-sources only; no overnight-log scan / gh pr list / 3-calendar read. |
| Ritual: evening-wrap | `prompts/evening-wrap.md` | **MISSING** | grep-zero | No end-of-day wrap. |
| Ritual: dreaming (6h consolidation) | `prompts/dreaming.md` | **MISSING** (mechanism PARTIAL, flag-off — see memory §1e) | reflection/ has no periodic consolidation cron | Blockers 1+4. |
| Ritual: kaizen (weekly self-improve) | `prompts/kaizen.md` | **MISSING** | grep-zero | No weekly corrections-log review/suggestions. |
| Ritual: book-sunday-refresh | `prompts/book-sunday-refresh.md` | **MISSING** | grep-zero | Nudge-mode port may suffice. |
| Ritual: re-engagement sweep | `re-engagement-nudge-agent.md` + `scripts/re-engagement-sweep.sh` | PARTIAL | `proactive/idle-nudge-sweep.ts` (rater at `:228`) | Task-pick-gated, not transcript-aware. |
| Ritual: overnight report | `prompts/overnight-report-agent.md` | PORTED (scope: trident results) | `onboarding/overnight/morning-brief.ts` (06:50) | — |
| Ritual: dharma-pointer crons | `prompts/dharma-pointer.md` | MISSING as scheduled ritual | renamed away in `migrations/0027` | Concept survives per-turn in SOUL. |
| Ritual: granola-processor | `prompts/granola-processor.md` | MISSING | see §1e granola row | — |
| Ritual: neutron-surveillance | `prompts/neutron-surveillance.md` | N/A (self-referential) | correctly absent | — |
| Infra crons (health/vault-backup/cc-update/task-scan/hygiene/issues-sync) | `cron/jobs.yaml` + `sync-crons.sh` | PORTED-DIFFERENTLY | service layer: `neutron-service.sh:144,295`, `install.sh:1512`; scheduler `cron/scheduler.ts` + `timer-emit.ts` | Hygiene sweep itself missing (§1f). |
| App cron registry (morning-brief, idle-nudge, focus-score, prioritize, overnight, …) | — | PORTED | `build-core-modules.ts:39-91`; shared registry both paths (`gateway/composition.ts:267`, `open/composer.ts:669`) | — |
| Model-update watchdog for reminder agents | `gateway/models.ts` + watchdog | PARTIAL | `runtime/models.ts` FAST_MODEL; watchdog for reminder path unverified | Verify. |

### 1d. Agent fleet + autonomous work

| Capability | Vajra | Status | Neutron | Consequence / fix shape |
|---|---|---|---|---|
| Four agent roles (build/research/QA/review) | `prompts/{forge,atlas,sentinel,argus}.md` + `spawn-agent.sh` | **PORTED** (June gap CLOSED) | forge+argus in `trident/prompts.ts`; atlas+sentinel via `agent-dispatch/prompts.ts`; `trident/agent-prompts.ts` loads `prompts/{atlas,sentinel}.md`; composed `open/composer.ts:777+,838` | — |
| Ad-hoc background dispatch | `spawn-agent.sh`; `gateway/spawn-fleet-agent.ts:16` | PORTED | `agent-dispatch/{service,tool,command}.ts` (`dispatch_agent`, `/dispatch`) | — |
| tmux/Max-OAuth transport | `spawn-agent.sh:190-228` | DELIBERATELY DIFFERENT | headless `cc-dispatch-*` REPLs (`open/composer.ts:781`) | Host-specific, not a capability gap. |
| Registry + terminal states + boot orphan reap | `running-agents.jsonl`, `agent-terminal-states.json` | PORTED | `runtime/subagent/{registry,store,boot-sweep}.ts` (migration 0100); wired `open/composer.ts:868` | — |
| Crash/stuck watchdog | `gateway/watchdog.ts`, `stuck-turn-watchdog.ts` | PORTED (cadence differs) | `runtime/subagent/watchdog.ts:63`; trident `orchestrator.ts:183` | 5m vs 15s thresholds — tuning. |
| Trident loop + Ralph mode | trident skill + `trident.sh` | PORTED | `trident/{orchestrator,inner-workflow.mjs,inner-loop,tick}.ts` | Ralph multi-task re-fire FIXED 2026-07-17 (`SPEC.md:421`). |
| Overnight dispatcher (window/budget/[context:] gate/owk-ids) | `gateway/overnight-dispatcher.ts` | PORTED | `onboarding/overnight/{dispatcher,status-md-sync,queue-store}.ts`; wired `build-core-modules.ts:712` | N pins 2/8; Vajra code drifted to 4/40 — align budgets. |
| Morning reporter 06:50 | overnight-report prompt | PORTED | `onboarding/overnight/morning-brief.ts` | — |
| Codex cross-model review | `scripts/codex-review.sh` | PORTED | `trident/codex-review.sh` + `codex-auth.ts` | — |
| **Worktree GC** | `gateway/worktree-gc.log` loop + reaper prune | **PARTIAL** | merge-time cleanup only (`trident/merge.ts:202,464`); `terminate.ts` no cleanup; no periodic sweep | Crashed/stopped runs leak worktrees (the fseventsd-CPU failure class `merge.ts:19` warns about). Fix: cron `git worktree prune` + sweep terminal-non-done runs. |
| **Codex CLI daily auto-upgrade** | `scripts/codex-upgrade.sh` | **MISSING** | install-once only | Silent review regression as upstream drifts. Fix: daily upgrade cron + version-delta log. |
| codex-broker-reaper | `scripts/codex-broker-reaper.sh` | DROPPED (N/A) | broker-free codex transport (`runtime/adapters/codex-cli/`) | — |
| Result delivery to chat | `gateway/pr-delivered.ts` + `/forge/delivered` | PORTED | `trident/delivery.ts` keyed on run chat_id/thread_id | — |
| Review/Merge buttons (human-in-loop merge) | `pr-delivered.ts` inline buttons | **DROPPED** (recorded `trident/delivery.ts:275-281`) | autonomous merge on Argus APPROVE | If a manual gate is wanted: emit `inline_choices` on approve-pending-merge (infra exists `delivery.ts:49,371`). |
| Overnight issue→STATUS sync | `scripts/overnight-sync-issues.sh` | MISSING/N-A | no ISSUES.md convention (see §1f) | Only needed if ISSUES.md returns. |
| auto-argus / auto-fixpass overnight scripts | those scripts | PORTED (absorbed) | native in dispatcher + trident loop | One-off hardcoded batch scripts; capability is native. |

### 1e. Memory + knowledge + ingestion

| Capability | Vajra | Status | Neutron | Consequence / fix shape |
|---|---|---|---|---|
| KG store provisioning | mempalace MCP (pipx) | **PORTED** (June gap CLOSED) | `install.sh:768` ensure_gbrain, install-FATAL `:851`, invoked `:1246,:1349`; opt-out `--no-gbrain` | — |
| Chat-time KG recall | `mempalace_search`/`kg_query` | **PORTED** (June gap CLOSED) | `gbrain-memory/agent-tool.ts` → `mcp__neutron__memory_search`; registered `build-core-modules.ts:194`; bridge `substrates.ts:233` | — |
| Diary read/write | mempalace diary | PORTED | `reflection/diary-store.ts`; `reflection/index.ts:232` | — |
| Corrections + implicit-learning splice | corrections-log.md + kaizen | PORTED | `reflection/corrections-store.ts`; first-turn splice `build-live-agent-turn.ts:846` | — |
| **Dreaming consolidation loop** | `prompts/dreaming.md` (6h executor) | **PARTIAL (default-OFF)** | `scribe/reflect/reflect-pass.ts` behind `NEUTRON_PERFECT_RECALL` (`runtime/perfect-recall-flag.ts:13`; `scribe/index.ts:81`; `open/composer.ts:3399-3405`) | Blocker 4. |
| Entities wiki + slug resolver + lint | `entities/` + `RESOLVER.md` + `entities-lint.py` | PORTED | `runtime/{entity-writer,entity-format,entity-slug,slug-grammar,memory-index}.ts` | Lint moved to write-path; no standalone corpus lint (optional). |
| Auto-index entities into search | `register-entities-qmd.sh` | PORTED (automatic) | `gbrain-memory/GBrainSyncHook.ts` on every writeEntity | — |
| Doc search — lexical | qmd lex | PORTED | `doc-search/store.ts:307` (FTS5/BM25) | — |
| Doc search — **semantic** | qmd vec | **PARTIAL/split** | vec seam REMOVED (`store.ts:26`); semantic only via gbrain memory_search (Ollama nomic-embed-text) | Project docs keyword-only. Fix: embedder re-rank or route through gbrain corpus. |
| Doc search — **HyDE** | qmd hyde | **MISSING** | grep-zero | Vague-query recall worse. |
| Collections scoping | qmd 5 collections | PARTIAL | indexer walks `Projects/<id>/` only (`doc-search/indexer.ts:4`) | Entities not in doc corpus (only memory_search). Fix: widen enumerator/collection param. |
| **Scribe email ingestion** | `scribe-email-poll.sh` + live cursor state | **PARTIAL — DATA-DARK** | fan-out wired `open/wiring/memory.ts:315` WITHOUT gmailClient → in-memory stub (`mount-cores-scribe-fan-out.ts:217`) | Blocker 2. |
| **Scribe calendar ingestion** | `scribe-calendar-poll.sh` + cursor | **PARTIAL — DATA-DARK** | same call, no calendarClient → stub (`:192`) | Blocker 2. |
| Scribe chat-turn extraction + budget | scribe prompt + `.scribe-budget.json` | PORTED | `scribe/index.ts` handleUserTurn wired `memory.ts:298`; `scribe-budget.ts:88` | — |
| Meeting audio ingest (whisper drop-folder) | `scribe-meeting-ingest.sh` | **MISSING** | grep-zero | No recording→meeting-page path. |
| Granola meeting-notes + CRM link | `granola-ingest.sh`, `granola-sync.py`, granola-processor prompt | **MISSING** (no record) | grep-zero in code/SPEC/STATUS | Port as ingestion core or record the drop. |
| Cross-conversation history search | qmd over session notes | PARTIAL | `message-search/` per-topic; `global:true` no-op on server runtime (`message-search-wiring.ts:11`) | Fix: durable cross-topic chatlog store. |
| AAAK spec / taxonomy surface | mempalace tools | PORTED (delegated) | inside gbrain binary | Agent-facing taxonomy query unverified. |
| Auto-memory MEMORY.md | CC harness feature | N/A-equivalent | reflection layer covers the function | — |

### 1f. Email/calendar/workspace + external tools

| Capability | Vajra | Status | Neutron | Consequence / fix shape |
|---|---|---|---|---|
| Gmail read/search/thread/summarize | gog (TOOLS.md:14) | PORTED | `cores/free/email/src/manifest.ts:65-72` | — |
| Gmail drafts + 4-point rule | TOOLS.md:15 + helper/hook scripts | PORTED (server-side) | `manifest.ts:117` DEFAULT_DRAFT_LABEL_IDS + draft-policy.ts | Baked in-core — stronger than Vajra's CC hook. |
| **Gmail SEND** | gog | **PORTED** (June "missing" REVERSED) | `manifest.ts:42,71,87`; `google-client.ts:400` | — |
| Email triage/importance | `Projects/email-system/email-triage.py` (v2 Worker) | PORTED (different arch) | `cores/free/email/src/triage.ts` + scheduler | Mass-mailer→brief heuristic not located as code — unverified. |
| Calendar (3 accounts merged) | google-workspace.md:36-44 | **PARTIAL** | single Google grant | One-account model. Fix: second OAuth slot. |
| Pre-meeting briefs | scribe-calendar-poll | PORTED | calendar core pre-meeting-brief-scheduler; mounted `memory.ts:315` | (Brief scheduling wired; the *memory fan-out* half is data-dark — §1e.) |
| Drive list/read/upload | gog | PORTED | `cores/free/google-workspace/src/manifest.ts:59-61` | — |
| Drive convert | gog convert | **MISSING** | upload only | Add `drive_convert`. |
| Sheets / Docs | gog | PORTED | `manifest.ts:62-67` | — |
| **Slides + deck-export** | `deck-studio-to-slides.sh` + deck-export skill | **MISSING** (no record) | grep-zero | Add `slides_*` tools. |
| OAuth bring-up for fresh owner | (Ryan's shared client) | **PARTIAL (env-gated)** | UI `app/app/integrations.tsx` + `gateway/http/cores-oauth-surface.ts:6-9`; gated `mount-open-cores.ts:78-80` → `oauth_not_configured` 503 | Out-of-box 3 Google cores dead ("installed=7/10", STATUS.md:19). Fix: onboarding step or bundled default client. |
| Travel flight/hotel (SerpAPI HARD RULE) | `flight-search.sh`, `hotel-search.sh` | **MISSING** (no record) | grep-zero | New travel core (byo key). |
| Instagram scrape | `ig-scrape.sh` | PORTED | `cores/free/scraping/src/manifest.ts:36` scrape_instagram; wired `boot-cores-factories.ts:255` | — |
| X/Twitter scrape (+thread/article/summary) | `tx-scrape.sh` | PARTIAL | `scrape_x` in manifest | Mode flags unverified — confirm/port. |
| Browser automation (agent-browser) | TOOLS.md:3 | PORTED | `skills/agent-browser/SKILL.md` via provisionAgentSkills (`open/composer.ts:141`) | June "missing" STALE. |
| Image generation | `gemini-image.sh` + skill | **MISSING** | onboarding profile-pic only | On-demand image-gen tool/skill. |
| Oura health ingest | `oura-fetch.sh` | **MISSING** (no record) | grep-zero | Health core. |
| IONOS DNS / Netlify deploy | `ionos-dns.sh`, TOOLS.md Netlify | **MISSING** (no record) | grep-zero | Infra core/skill — the parity bar bans silent scope-out; record a decision or port. |
| 1Password secrets | TOOLS.md op | REPLACED (arch) | `auth/secrets-store.ts` + byo_api_key | Different-but-equivalent secret sourcing. |
| tabs-cm-pull / robobuddha poller | those scripts | MISSING | (`tabs/` in N is an unrelated tab UI) | Project-specific connectors. |
| Obsidian link convention | obs.junee Worker | N/A (replaced) | app docs surface | — |

### 1g. Tasks + projects + ops + skills + persona

| Capability | Vajra | Status | Neutron | Consequence / fix shape |
|---|---|---|---|---|
| Task store + inbox protocol | `task-inbox.jsonl` + `task-scanner.py` | PORTED (DB+MCP shape) | `tasks/store.ts`; wired `open/composer.ts:250,1982` | — |
| Focus scores + 2h scan | `task-scanner.py:7` | PORTED | `tasks/focus-score.ts` + cron `build-core-modules.ts:68` | N adds LLM prioritization (`prioritize-llm.ts`) — Neutron-extra. |
| STATUS.md projection | DASHBOARD render | PORTED (per-project) | `tasks/projection/write.ts` (+ACTIONS.md) `build-core-modules.ts:1074-1083` | — |
| **Aggregate DASHBOARD.md + attention-needed.json** | `DASHBOARD.md`, `data/attention-needed.json` | **PARTIAL** | none on disk; web Tasks tab only | Fix: instance-level top-N focus digest projection. |
| Overnight opt-in | STATUS frontmatter flag | PORTED (DB enum) | `projects.agent_engagement_mode` (`sqlite-store.ts:63`) + `overnight-task-hook.ts` | — |
| PARA (Areas/Resources) | vault taxonomy | PARTIAL | projects only | Model Areas/Resources or record scope. |
| Project lifecycle CLI | `vajra-project.sh` | PORTED (chat/MCP/web shape) | `sqlite-store.ts:68,:524`, `enumerate.ts` | — |
| **ISSUES.md tracker + verify-tag audit + incident 4-element discipline** | `ISSUES.md`, `verify-tag-audit.sh` | **DROPPED** (recorded `SPEC.md:44,:491` — path banned by purity gate; GitHub Issues instead) | `watchdog/incident.ts` is alert-dedup, not a tracker | The closing-discipline audit has NO replacement — if that discipline matters, port a tag-audit over GitHub issue closes. |
| priority-map lanes | `priority-map.md` (living doc) | PORTED (generated) | `onboarding/persona-gen/priority-map.ts:36,42,98` | Static post-onboarding; allow regen/edit. |
| Git auto-commit backup | `vault-backup.sh` (6h) | PORTED+ (12h, WAL-checkpoint, leak-gate, force-with-lease) | `neutron-backup.sh:118,166,325,445` | Interval choice cosmetic. |
| **Vault hygiene sweep** | `vault-hygiene.py` (stale-archive, INDEX gen, log-rotate) | **PARTIAL/MISSING** | no nightly sweep; no INDEX.md generation | Fix: nightly hygiene cron (stale-archive by last_activity_at, index docs, log rotation). |
| Health doctor | `health-check.sh` (27KB) | PARTIAL (depth unverified) | `neutron-service.sh:474` do_doctor | Line-compare probe coverage. |
| Restart / supervisor install / CC graceful upgrade | respective scripts | PORTED | `neutron-service.sh:552,556,158,205`; `model-update-watchdog.ts:360` (explicitly mirrors Vajra) | — |
| Spec-discipline hooks (CURRENT marker, preflight, pre-commit guard) | `install-spec-guard-hooks.sh`, `hooks/spec-*.sh` | PARTIAL/DROPPED | SPEC.md+AS_BUILT.md exist (`SPEC.md:38`); drift control = Ralph loop + leak-gate (`SPEC.md:485-491`); no git-hook mechanism | Ralph replaces it for trident builds; solo-CC sessions have no guard. |
| install-git-hooks / bisect-test-pollution | those scripts | MISSING (dev tooling, low) | none | Low priority. |
| Skill provisioning | `install-skills.sh` symlinks | PORTED | `agent-skills.ts:45` provisionAgentSkills; wired `open/composer.ts:648` | — |
| Bundled skills | ~25 packs | PARTIAL | design suite + impeccable + remind + agent-browser present; **humanizer** reduced to `cringe-check.ts` subset; **deep-research** → `/research` command (depth unverified); **tx-scrape/deck-export/last30days** absent; trident+skillify are subsystems (`skill-forge/` wired `open/composer.ts:906-931`) | Bundle humanizer at minimum (writing-as-owner is a daily Vajra function). |
| SOUL/USER/TOOLS/priority-map @-imports | @-import mechanism | PORTED | `runtime/system-prompt.ts:64,:80,:141-152` | — |
| Persona generation | (hand-authored in V) | PORTED (N generates — ahead of Vajra) | `onboarding/persona-gen/{soul,user,priority-map,compose}.ts` | — |

---

## 2. PARTIAL PORTS — the ones that read as done

Ranked by danger (all have complete-looking subsystems around the hole):

1. **Reminders** — polished store/tick/dispatcher/patterns; executor half deliberately absent (`reminders/prompt.ts:12`). 5 of Ryan's 81 live reminders (all his rituals) cannot run. The subsystem is tested and green; the gap is invisible without reading Vajra's `gateway-core.ts:2846` next to it.
2. **Scribe ambient ingestion** — fan-out module exists, is mounted on the boot path, has passing tests — and receives stub clients, so email/calendar extraction produces nothing (`open/wiring/memory.ts:315` vs `mount-cores-scribe-fan-out.ts:192,217`). Known-acknowledged in a comment, invisible in behavior until you ask "where are the calendar entities?"
3. **Chat attachments** — upload surface + envelope wiring look full-stack; only images pass the whitelist (`app-upload-surface.ts`). Voice and documents — daily Vajra modalities — silently unsupported.
4. **Memory consolidation** — reflect-pass code is real and reviewed (#369-related work), but default-off behind `NEUTRON_PERFECT_RECALL`; fresh installs accrete without ever consolidating.
5. **Doc search** — FTS5 search works great, so it reads as "search: done"; semantic re-rank was deleted as dead code (`doc-search/store.ts:26`) and HyDE never existed — recall quality is a strict downgrade from QMD's lex+vec+hyde.
6. **Telegram** — adapters, renderer, webhook factory all in-tree; zero callers in Open (`build-telegram-webhook.ts:98-101`). Greps as present; disabled at the composer (`open/composer.ts:3435`).
7. **Google cores** — composed, tested, UI button shipped; dead until the owner registers their own Google OAuth client (`mount-open-cores.ts:78-80`), and single-account by model.
8. **morning-brief** — posts a brief daily, so it reads as ported; it composes only from injected sources, not the executor's free-read of calendars/overnight-logs/PRs.
9. **Login/reauth** — endpoint exists; the proactive push (button + browser-open) that made credential lapses self-announcing is gone.
10. **Worktree GC** — cleanup code exists in `merge.ts`, so "we clean worktrees" is true — only for runs that reach merge; crashed/stopped runs leak forever.
11. **Message search** — tool registered and works per-topic; `global:true` silently no-ops on the server runtime (`message-search-wiring.ts:11`).
12. **Recurring reminders docs-rot** — capability now EXISTS on the agent path, but `chat-commands.ts:44-47` docblock and STATUS notes still claim one-shot-only, and the typed chat surface still rejects — a docs/wiring mismatch in both directions.

---

## 3. DELIBERATELY DROPPED (recorded decisions)

| Capability | Decision record |
|---|---|
| Executor-mode reminders | `reminders/prompt.ts:12-14` |
| Telegram in Open composer | `open/composer.ts:3432-3435` ("Single-owner has no Telegram channel"); factory reserved for Managed composer (`gateway/wiring/build-telegram-webhook.ts:98-101`) |
| Review/Merge buttons (human-in-loop merge) | `trident/delivery.ts:275-281` (autonomous merge on APPROVE) |
| ISSUES.md root tracker | `SPEC.md:44`, `SPEC.md:491` (purity gate bans the path; GitHub Issues instead) |
| codex-broker-reaper | N/A by architecture (broker-free `runtime/adapters/codex-cli/`) |
| tmux transport / topic-pane machinery (idle-kill of panes, banner sentinel, new-topic flow) | Architecture change to WS-native persistent REPLs; per-file notes throughout `runtime/adapters/claude-code/persistent/` |

Everything else absent has **no recorded decision** and is classified MISSING per the standard — notably: travel search, Slides/deck-export, Drive convert, image gen, Oura, Granola, meeting-audio ingest, voice transcription, document upload, /email-forward, vajra-attach, HyDE, event-loop-monitor, codex-upgrade, vault-hygiene, aggregate dashboard, IONOS/Netlify, humanizer-as-skill, last30days, tx-scrape modes.

---

## 4. CORRECTIONS TO THE 2026-06-25 AUDIT (stale findings — do not re-fix)

| Prior finding | Status at 2026-07-19 HEAD |
|---|---|
| gbrain binary never installed (no memory out-of-box) | **FIXED** — `install.sh:768` ensure_gbrain, install-fatal `:851` |
| No chat-time KG reader | **FIXED** — `memory_search` agent tool (`gbrain-memory/agent-tool.ts`, `build-core-modules.ts:194`) |
| 4-agent family collapsed into Trident; no ad-hoc spawn | **FIXED** — `agent-dispatch/` + `work-board/` composed (`open/composer.ts:777+,838,868`) |
| Google cores not composed into Open | **FIXED** (composed `open/composer.ts:115,:3473`) — residual gaps are OAuth env-gating + single-account |
| Email cannot SEND | **FIXED** — `cores/free/email/src/manifest.ts:42,71,87` |
| Recurring reminders one-shot-only | **FIXED on the agent/MCP path** (`backend.ts:315-368`); typed `/remind` chat surface still rejects |
| Browser automation missing | **FIXED** — bundled `skills/agent-browser` |
| scribeFanOut never threaded | **HALF-FIXED** — now mounted but with stub clients (blocker 2) |
| Trident Ralph single-task merge (#362 in dispatch numbering) | **RECORDED FIXED 2026-07-17** — `SPEC.md:421`, `AS_BUILT.md:602` (not live-verified here) |

---

## 5. UNVERIFIED ITEMS (flagged, not guessed)

`/reminders/stale-drops` surface · REST `/agents` list/kill · `/admin/cancel-graceful-upgrade` · crash-handler boundary marker · stuck-typing reaper for web chat · web-chat Retry affordance · idle-but-live session eviction · `topic-agent-base.md` vs `repl-agent-base.md` content diff · model-update watchdog on the reminder path · mass-mailer→brief triage heuristic · `scrape_x` thread/article/summary modes · agent-facing gbrain taxonomy query · `do_doctor` depth vs `health-check.sh` · `install.sh` CC-globals seeding · `/research` depth vs deep-research skill · live behavior of proactive crons without `tasks.proactive` config.

## 6. NOTE ON THE DISPATCH'S ISSUE NUMBERS

The dispatch cites "ISSUES #362/#364/#365/#367/#368/#369." On `rjunee/neutron` GitHub those numbers are **merged refactor PRs**, not open issues; the substance of "#362 trident Ralph multi-task" is recorded FIXED in `SPEC.md:421` (2026-07-17). The tracker whose numbering the dispatch used could not be located in either repo — reconcile the numbering before filing follow-ups so the fix work keys off real rows.
