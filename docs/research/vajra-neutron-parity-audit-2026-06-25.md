# Vajra → Neutron Feature-Parity & Daily-Driver Readiness Audit

**Date:** 2026-06-25
**Author:** Atlas (Vajra fleet research agent)
**Scope:** READ-ONLY. Grounded in actual code + running state, not spec checkboxes (the spec is known-drifted and self-confesses it).
**Repos:** `~/vajra` (Vajra), `~/repos/neutron-open` + `~/neutron/core`/`~/neutron/data` (Open engine/runtime), `~/repos/neutron-managed` (hosted control plane).

Ryan's two questions:
1. Are we 100% feature parity with Vajra?
2. Can I use Neutron as my daily driver?

---

## BLUNT VERDICT

**Feature parity (engine): ~85% — close, with two real gaps.** Neutron-open is NOT a stub harness. It is a genuine generalized port of Vajra's own codebase (source comments literally say "LIFTED from Nova `gateway/...`"). On 10 of 12 daily capabilities it has real, wired, working equivalents. The two genuine engine gaps are **memory (KG/semantic depends on an external `gbrain` binary the installer never installs)** and **email send (paid tier only — draft+triage in free)**. Two more are presentation traps, not capability gaps: **Telegram is fully built but disabled in the OSS build** (web/app-first), and **`webhook`/`cli` channel kinds are enum placeholders**.

**Daily-driver TODAY: NO.** Not because the engine can't — it largely can — but because **a clean install → onboard → daily-use cycle has NEVER been verified end-to-end.** The one load-bearing checkbox for this, `install-VERIFIED` in WAVE 1, is **unchecked**. The single recorded live managed-signup test (2026-06-23) **failed outright** (tenant never provisioned: zero registry rows, Caddy 502, ERR_SSL). The standing **Vajra→Neutron fix-reconciliation FINAL lift** — the explicit HARD GATE on Ryan's cutover (M3) — is **unchecked and not started**. Neutron-managed's own SPEC Decisions Log says it plainly: *"the honest status is BUILT-not-VERIFIED … daily-driver readiness is NOT verified."*

So: **the code is real and mostly complete; the proof that Ryan can live on it does not exist yet.** Treat any "daily-drivable" claim as **estimate/aspirational, NOT verified.**

---

## PARITY TABLE

Status legend: **PARITY** = real, wired, working equivalent · **PARTIAL** = exists but with a named gap · **MISSING** = no working equivalent.
"Verified?" column flags whether the equivalent has been proven to actually run for a real user, vs code-on-disk + unit tests.

| # | Capability (Vajra daily use) | Vajra implementation | Neutron status | Evidence (Neutron) | Gap / Verified? |
|---|---|---|---|---|---|
| 1 | **Persistent topic chat** (forum topic → long-lived CC REPL) | gateway + topic-map.json + `.composed-prompts/` (multiple live sessions) | **PARITY (engine); PARTIAL (Ryan's surface)** | `channels/router.ts:39`, `gateway/http/chat-bridge.ts:280+`, `runtime/.../persistent/dev-channel.ts` (turn-id echo + Stop-hook reply sink) | Same persistent-CC-per-topic mechanism. But OSS build is **web/app-first**; Telegram disabled (#2). Unverified end-to-end. |
| 2 | **Gateway routing + reply enforcement** | `gateway/index.ts`, `webhook-channel.ts`, `hooks/enforce-reply.ts` | **PARITY** | `channels/router.ts` (adapter registry + SQLite topic resolve); dev-channel Stop-hook reply sink | Direct lineage port. |
| 3 | **Telegram surface** | core daily surface (bot → per-thread sessions) | **PARTIAL** — built but OFF in OSS | adapters `channels/adapters/telegram/` exist; **Open composer disables it** — `open/composer.ts:966` `topic_handler: async () => undefined` ("single-owner has no Telegram channel") | Telegram parity is **Managed-only**, and Managed's one live provision test failed. `webhook`/`cli` kinds are stubs. |
| 4 | **Agent fleet** (Forge/Atlas/Sentinel/Argus + trident loop) | `scripts/spawn-agent.sh`, `prompts/{forge,atlas,...}.md`, trident skill | **PARITY** | `trident/orchestrator.ts` (forge-init/fix/argus state machine), `trident/agent-dispatch.ts` (Atlas/Sentinel), `trident/tick.ts`; `/code` command wired (`gateway/__tests__/trident-code-command-wiring.test.ts`); productized in `cores/free/code-gen/` | Full Forge→Argus→merge loop present + runtime-wired. (One sub-audit falsely reported "no fleet" — bad grep; corrected.) |
| 5 | **Memory recall** (MemPalace KG + semantic) | `mcp__mempalace__*`, save/precompact hooks | **PARTIAL → MISSING out-of-box** | `gbrain-memory/` is production-grade code, BUT `gbrain-stdio-client.ts:39` spawns an **external `gbrain` binary**; `install.sh` has **0 references** to it | **The most material gap.** Fresh self-host = no KG/semantic memory; degrades silently. Lexical doc-search still works (#7). |
| 6 | **Doc/vault search** (QMD) | QMD MCP over 3137 docs | **PARITY** | `doc-search/store.ts` — native SQLite FTS5/BM25, incremental refresh, project scoping; optional embedder | Self-contained, bundled. Semantic optional; lexical always works. |
| 7 | **Entities knowledge wiki** | `entities/` (people/companies/originals + RESOLVER.md) | **PARITY (storage); PARTIAL (recall timing)** | `<ownerDataDir>/entities/{people,companies,...}/*.md` identical shape; synced to KG post-write | Vajra **pre-loads** entities each turn; Neutron exposes them as **on-demand** tools the agent chooses to read. Functional parity, looser recall discipline. |
| 8 | **Reminders** | `remind` skill → `/reminders` + gateway tick (90 live entries) | **PARITY** | `reminders/{tick,store,dispatcher}.ts` — 30s tick, claim-before-dispatch, recurring; fire spawns Haiku-class composition turn; wired `build-core-modules.ts:189` | Real end-to-end, same shape. |
| 9 | **Morning brief / proactive nudges** | morning-brief reminder + re-engagement-sweep | **PARITY** | `gateway/proactive/{morning-brief,idle-nudge-sweep}.ts` — sectioned brief, same-day idempotency, idle dedupe | Requires `tasks.proactive` config set, else silently no-ops. Unverified live. |
| 10 | **Scribe ingestion** (Telegram/email/cal → entities) | `prompts/scribe.md`, scribe-*-poll.sh, scribe-watchdog | **PARITY (code); UNVERIFIED** | Managed WAVE 2 marks scribe `[x]`; Open has `reflection/` + entities-sync + calendar/email cores feeding the wiki | Coded across reflection + cores; no live ingestion-cycle verification on record. |
| 11 | **Calendar / email** (gog) | `gog` CLI + scribe polls | **PARITY (calendar); PARTIAL (email)** | `gateway/cores/oauth-token-manager.ts`, `cores/free/calendar/` (9 MCP tools, pre-meeting briefs), `cores/free/email/` (draft+triage) | **Email cannot SEND** — no `gmail.send` scope (reserved Tier 2). Calendar/email also need an **operator OAuth step not yet performed**. |
| 12 | **Tasks** | tasks.md + task-inbox.jsonl + task-scanner.py | **PARITY** | `tasks/store.ts` (DB CRUD), `focus-score.ts` + cron, `prioritize-llm.ts`, `tasks/projection/` (auto-writes STATUS.md) | DB-backed replacement of the inbox scanner. (Vajra's own tasks.md is stale since Jun 5 — low daily signal both sides.) |
| 13 | **Cron / scheduled jobs** | `cron/jobs.yaml` → launchd (infra crons) | **PARITY** | `cron/scheduler.ts` (in-process tick, interval+oncalendar, DST-aware, missed-fire catch-up); 10 jobs in `build-core-modules.ts`; `cron/timer-emit.ts` for systemd | Real. Vajra's `health-check` cron is actually disabled (`.plist.disabled`) — relies on in-process watchdogs, like Neutron. |
| 14 | **Reflection / corrections / diary** | corrections-log.md + MemPalace-write-after-exchange | **PARITY** | `reflection/` (25-cue pre-gate + LLM judge), `corrections-store.ts`, `diary-store.ts`; injected first-turn | Mirrors Vajra's implicit-learning loop. |
| 15 | **Backup** | `vault-backup.sh` (6h git auto-commit) | **PARITY** | managed `src/ops/` backup; Open data-dir git | Present; cadence/verification unconfirmed. |
| 16 | **Onboarding / install** (N/A for Vajra — already set up) | — | **PARTIAL — built, NEVER verified** | `install.sh` (62KB: bun bootstrap, `claude setup-token`, secret gen, DB migrate, service install); `onboarding/interview/engine.ts` (interview + history import + persona gen); `app/` Expo web+mobile | README stamps it **"pre-release, not for production."** `install-VERIFIED` checkbox **unchecked**. The whole daily-driver question rides on this. |

---

## DAILY-DRIVER READINESS — what concretely breaks

For Ryan to switch **today**, he'd go one of two routes; both have blockers:

**Route A — self-host Open (`install.sh`, web/app surface):**
- ✅ Boots per README (`bun start` → `/chat` + `/healthz`); interview onboarding + history import exist.
- ❌ **No KG/semantic memory out of the box** — `gbrain` binary not installed (#5). Memory recall is a daily-core capability; this silently degrades.
- ❌ **Surface change** — Ryan lives in Telegram; Open ships web chat + Expo app, Telegram disabled (#3). Behavior, not bug — but it's a real switch.
- ❌ **Email can't send** (#11); calendar/email need an OAuth step not yet done.
- ❌ **Never verified** — `install-VERIFIED [ ]`. The dogfood was *attempted twice* (upload-import 404 on 2026-06-16; incomplete import analysis on 2026-06-17) and hit breakages; the cycle was never cleanly closed.

**Route B — Managed (Telegram wired, hosted):**
- ✅ Feature code across WAVES 1–5 merged; managed test suite **377 pass / 0 fail** (real, green).
- ❌ **The one live signup test FAILED (2026-06-23):** user redirected but tenant never provisioned — `registry.db` zero rows, no systemd unit, Caddy → 502, ERR_SSL. Fix PRs #110–118 followed (SystemdLauncher prod-wiring, POSIX user isolation, wildcard-TLS pre-issue, OAuth cookie).
- ⚠️ **Post-fix verification is piecemeal** — TLS handshake "VERIFIED on box" and `/healthz` 200 + landing-page 200, but **NO record of a full live "signup → registry row → systemd unit → tenant serves /chat with working LLM → daily use" cycle** after the fixes. The fact that `scripts/reset-tenant-by-email.sh` exists is itself evidence that live provisioning broke and needed manual teardown.
- ⚠️ E2E suite (`docs/E2E-TEST-PLAN.md`) **deliberately skips the OAuth round-trip** ("Google declines headless creds") and runs against a **synthetic tenant** — asserts route-mounting + healthz, not a working daily-driver session.

**Has a clean install→onboard→daily-use cycle EVER been verified? — NO.** Estimate-grade "built," not verified-grade "works." (Source: `neutron-managed/SPEC.md:133`, `:308`, `:311`.)

---

## PRIORITIZED GAP LIST — NOW → "Ryan daily-drives Neutron"

**P0 — blocks daily-drive, must close first:**
1. **`install-VERIFIED` (WAVE 1, `SPEC.md:133`)** — Ryan runs `install.sh` on a clean machine, completes onboarding, confirms the daily basics. Never done cleanly. *This is the single highest-leverage gate.*
2. **Memory out-of-box (`gbrain`)** — installer must provision/bundle the `gbrain` binary, or fresh installs ship with no KG/semantic recall. (`gbrain-stdio-client.ts:39`; `install.sh` 0 refs.)
3. **Live managed provision loop** — prove (post-#110–118) a real signup → tenant row → systemd unit → tenant `/chat` with working LLM completes end-to-end. The only recorded live attempt failed; current verification stops at TLS/healthz.

**P1 — required for true parity / Ryan's actual workflow:**
4. **Vajra→Neutron fix-reconciliation FINAL lift (WAVE 2 step 22, `SPEC.md:152`) — HARD GATE on M3.** Comprehensive port of ALL Vajra bugfixes/edge-case fixes accumulated through the build. Unchecked, not started. Ryan's Vajra keeps shipping fixes Neutron hasn't absorbed; cutover (M3) cannot complete until this is done + verified.
5. **Surface decision** — Ryan is a Telegram daily user. Either wire Telegram into the OSS/owner build or commit to web/app. Today Telegram = Managed-only, and Managed provisioning is unverified.
6. **Email send** — add `gmail.send` (currently draft+triage only, Tier-2-gated).
7. **Calendar/email operator OAuth** — perform the OAuth step WAVE 3 cores need to actually function.

**P2 — polish / hygiene:**
8. `webhook` + `cli` channel kinds are enum stubs — implement or remove from the union.
9. Worktree cruft — 12 stale `.claude/worktrees/` + `.git/worktrees` in managed; GC them.
10. v0.1.0 tag + Apache headers + DCO (WAVE 1, `:139`); GA4 analytics (WAVE 5, `:197`).

---

## ESTIMATE vs VERIFIED — explicit flags

- **VERIFIED (real evidence):** Vajra is live (gateway PID running, scribe state files fresh within the hour, 90 reminders, multiple topic sessions). Neutron-managed test suite 377/0 green (run this session). Neutron-open `trident/` fleet exists + is wired (greps + wiring test). TLS handshake + healthz on the managed box.
- **ESTIMATE / UNVERIFIED:** Neutron daily-driver readiness; clean install→onboard→use cycle; full managed provision→chat loop post-fix; memory working on a fresh install; that "WAVE 1–4 complete" equals "Vajra parity." The managed SPEC itself flags this (`:308`).
- **FAILED (recorded):** 2026-06-23 live managed signup — no provisioning, 502, ERR_SSL.

**Bottom line for Ryan:** The engine is genuinely close — this is a real port of your own system, not vaporware. But "close on features" ≠ "I can live on it." The three things standing between now and daily-drive are all *verification/integration* gates, not greenfield builds: (1) actually complete a clean install→use cycle, (2) make memory install itself, (3) run the final Vajra→Neutron fix-lift before cutover. None has been done.
