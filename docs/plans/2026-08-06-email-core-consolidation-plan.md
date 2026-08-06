---
title: Email Core consolidation — absorb ~/repos/email-system into cores/free/email
type: refactor
status: active
date: 2026-08-06
---

# Email Core consolidation plan

Absorb the Cloudflare-Worker email pipeline (`~/repos/email-system`) into Neutron Open's
`cores/free/email/`, running on the instance itself (VPS or self-host laptop). The two
capabilities that must survive, per the owner: **(1) twice-daily email briefs** and
**(2) escalated important-email notifications**. Everything else is a deletion candidate.

All work lands in **Neutron Open** (`~/repos/neutron-open`). Managed consumes it via the
`vendor/neutron` submodule bump. Nothing here is Managed-only.

---

## 0. OWNER DECISIONS — 2026-08-06 (AUTHORITATIVE; supersedes any conflicting recommendation below)

These were settled by the owner after the first draft. Where §§ 3, 4, 6 or 7 disagree with
this section, **this section wins** and those sections are wrong.

**D1 — THE BRIEF ARRIVES BY EMAIL. That IS the feature.** The draft recommended deleting
email delivery in favour of chat + push. That recommendation misread the product. Owner:
*"Of course the brief needs to arrive by email. That's the whole fucking feature. I don't
want a chat message listing dozens of emails that came in every 12 hours. Chat messages are
for important escalations only."*
⇒ `brief/template.ts` + `brief/email-sender.ts` (~507 LOC) are **KEEP**, not DELETE. The
delivery split is now explicit and load-bearing: **the twice-daily brief is an EMAIL; chat +
push carry ESCALATIONS ONLY.** A digest must never be posted to chat. Q1 in § 7 is closed.

**D2 — SENDER RULES ARE USER DATA AND THE CORE MUST BE GENERALIZABLE. This was never a
question.** Owner: *"sender addresses is VERY OBVIOUSLY user data. Why is this even a
question? When architecting the core, it needs to be generalizable so anyone can set up
their own sender rules."* The `sender-map.json` finding is not a discovery to be weighed —
owner-specific sender data in code is simply a defect. **No owner data in the tree, ever;
every classification rule is per-owner instance data.** The Core ships the MECHANISM and
zero rules.

**D3 — CORE SETUP BUILDS THE INITIAL RULES BY SURVEY + INTERVIEW (new requirement).** Owner:
*"when setting up this core we need the LLM to go through the user's inbox and then interview
the user to ask about different classes of emails to create the initial classification
rules."* So installing the Email Core runs an onboarding pass: sample the real inbox, cluster
what is actually there, then ASK the owner about each class it found and write the resulting
rules as per-owner data. This replaces the idea of an importer that seeds one owner's
hand-built map — **that importer was a migration shortcut for a single user; the interview is
the product.** It also means a brand-new self-hoster gets working classification on day one
with no hand-authored rules at all. Needs a phase of its own (see § 6, Phase 2.5).

**D4 — THE RETURN-TO-INBOX FEEDBACK + LEARNING LOOP IS KEPT.** The draft proposed deleting
it as "not serving (1) or (2)". That is wrong on the merits, and the loop is **live and
closed**, verified in code: feedback writes `inbox_learning_patterns`, and the poller reads
them at `pipeline/poller.ts:82` (`getLearningPatterns`, `hit_count >= 2`) and feeds them into
the classifier via `engine.setLearningPatterns`. Classification quality is exactly what brief
usefulness and escalation accuracy rest on, so the learning loop serves (1) and (2) more
directly than most of what the draft proposed keeping. **KEEP**, and it composes naturally
with D3 — the interview seeds the rules, the feedback loop refines them.

**D5 — unsubscribe machinery: NOT broken, decision deferred.** Verified: it is reachable at
`POST /api/admin/run-unsubscribes` (`index.ts:194` → `handleRunUnsubscribes:1204`) plus
`scripts/run-unsubscribes.ts`, and it is **manually triggered — it is on no cron** (the three
Worker crons are poll / brief / cleanup). So "propose delete" was a scope judgement, never a
claim that it fails. Carry it as its own decision rather than folding it into this refactor.

## 1. Verdict

This is a **selective port wrapped in a large deletion**, not a rewrite and not a full port.
Roughly 1,700 of email-system's ~7,600 source+config lines survive (the classification
cascade, the poller loop shape, the batch-summarize + anti-drift validation, the escalation
dedup); the other ~5,900 lines — the entire HTTP surface, Telegram delivery, HTML email
templates, reauth flow, unsubscribe machinery, admin/repair endpoints, and 9 of 13 tables —
are deleted or replaced by seams Neutron already owns. One finding changes the shape of the
brief's key design call: **the Core's existing scheduled digest has never been visible to
the owner in the Open composition** — its production mount passes no LLM and hardcodes a
null dispatcher (evidence in § 2, correction 7) — so the absorbed brief pipeline is not
"replacing a competing digest"; it is replacing a scheduler whose only live output is the
scribe fan-out, which the new poller takes over. No inbound-SMTP or Cloudflare-Email-Routing
dependency exists; the port is host-agnostic (§ 2, correction 1).

## 2. Corrections to the brief

Each numbered against the brief's "WHAT I BELIEVE" list; extra findings follow.

1. **CONFIRMED — pure Gmail polling, host-agnostic.** `poller.ts:12` (`BASE_INBOX_QUERY =
   "label:inbox -label:<legacy-processed-label>"`), `poller.ts:132` (`gmail.listMessagesPage`),
   `gmail/client.ts:55` (plain REST against `https://www.googleapis.com/gmail/v1`).
   `wrangler.toml` declares only a D1 binding (`:9-13`) and cron triggers (`:32`) — no
   `[[email]]` / Email Routing / MX anywhere. Nothing changes the plan.

2. **PARTIALLY WRONG — the conversion target is not a `.prepare().bind()` rewrite of
   `queries.ts`.** `ProjectDb` exists as described (`persistence/db.ts:65`; sync
   `prepare` with `.get()`/`.all()`, async `run`/`exec`/`transaction` behind a
   per-instance mutex — `persistence/db.ts:55-63`), but the Email Core's own storage
   convention is a **bun:sqlite sidecar with core-local migrations**
   (`cores/free/email/src/cache.ts:22-41` — `openSidecar` +
   `applyProjectScopedMigrations` over `cores/free/email/migrations/`). The right move is
   a NEW instance-level sidecar for pipeline state (§ 5), not growing `queries.ts` into
   ProjectDb. Real traps confirmed: D1's `.first()` / `.all().results` /
   `.run().meta.changes` result shapes all differ from bun:sqlite; and email-system's
   schema is **not** in migrations at all — `initDb` replays 20 inline
   `CREATE TABLE IF NOT EXISTS` statements on every cold start (`db/queries.ts:87-258`),
   so "port the migrations" actually means "write migrations for the first time."

3. **CONFIRMED — `/ingest` and `/classify` die with the whole HTTP surface.** They exist
   only for the legacy personal-agent's cron→worker service boundary (`index.ts:127-137`, README routes list).
   In-process, classification is a function call. Nothing in either repo depends on them.
   Note the deletion is bigger than the brief says: **every** route in `index.ts` is
   legacy-agent-facing or brief-web-facing and dies (§ 4).

4. **CONFIRMED, mechanism named.** Neutron's cron substrate is `cron/jobs.ts`
   (`CronJobDef.schedule: { kind: 'oncalendar' | 'interval_ms' }` — `cron/jobs.ts:27-28`)
   with handler registries, registered per the `registerIdleNudgeSweepCron` pattern
   (`gateway/proactive/cron.ts:91-108`). The timezone story is sound and already solved:
   per-fire `resolveTimezone(owner_slug)` wins over any static tz
   (`gateway/proactive/cron.ts:45-51` — deliberately per-fire because a boot-time read
   would freeze the host zone), reading `instance_metadata.timezone`
   (`gateway/storage/owner-metadata.ts:32-46`). The brief windows therefore run as an
   interval tick + owner-local window check (the `computeBriefWindow` shape,
   `brief/generator.ts:16-36`, generalized from hardcoded Pacific to the resolved zone) —
   never `0 17,22 * * *` UTC. One nuance: these jobs are **instance-level**, not
   per-project; `project_id` only decides where output is posted.

5. **ONE SUBSTANTIVE CORRECTION — do not map `OPENAI_API_KEY` to the shared OpenAI key.**
   Neutron must run fully with **no** OpenAI key (Managed `SPEC.md` § Phases→Steps: "the
   system runs fully with none set"; the 2026-08-04 one-key decision governs *optional*
   OpenAI-backed features). The Email Core already has the single right seam: the
   substrate-backed one-shot LLM (`gateway/cores/mount-open-cores.ts:412-417`
   `buildOneShotSubstrateLlm(substrate)`, model via `getBestModel` /
   `runtime/models.ts:95-96` `FAST_MODEL`). Classification and brief summarization move
   onto that seam — **zero new secrets AND zero new provider dependencies**, one fewer
   than the brief assumed. The rest of the secret mapping is confirmed:
   Gmail → the Core's OAuth grant (`manifest.ts:54` `OAUTH_SECRET_LABEL`, 4-scope grant
   per `README.md:56-71`); Telegram/gateway-forward env → `OutboundSink` + push (§ 5);
   `BRIEF_FROM`/`BRIEF_TO` → moot if brief-by-email is deleted (owner question, § 7).

6. **CONFIRMED — 13 tables; 4 are load-bearing.** All 13 verified: 12 in
   `db/queries.ts:87-245` + `email_processing_state` (`state/email-state.ts:35-59`,
   duplicated at `queries.ts:218`). Load-bearing for (1)+(2): `emails`, `sender_cache`,
   `briefs`, `checkpoints`. `email_processing_state` folds into columns on `emails`
   (§ 5). The other 8 are deleted (§ 4).

7. **DIRECTIONALLY RIGHT, BUT THE PREMISE IS WRONG IN A WAY THAT MATTERS — the existing
   scheduled digest has NEVER been user-visible in Open, so there is no live competing
   digest to dedup against.** Three independent dead-ends, beyond the two PR #115 fixes:
   - The production mount hardcodes `pushDispatcher: null`
     (`gateway/cores/mount-cores-scribe-fan-out.ts:302`), and the fire callback only
     posts through that dispatcher (`gateway/cores/email-managed-wiring.ts:148-166`) —
     so `chat_message_id` is always null and nothing is ever delivered.
   - The mount call passes **no `emailLlm` and no `emailModel`**
     (`open/wiring/memory.ts:354-358`), so the scheduler falls to the throwing stub
     (`mount-cores-scribe-fan-out.ts:286-290`) and every fire composes the
     deterministic fallback ranking with `outcome: 'llm_error'` — the real substrate
     LLM built at `mount-open-cores.ts:412` reaches only the on-demand tool/chat paths.
   - Nothing in the app renders the push payload kind (`email_daily_triage` appears
     only in `email-managed-wiring.ts:155`).
   So: **yes, delete the scheduler** (Phase 3) — but its only live production output is
   the scribe fan-out ride-along + watermark (`email-managed-wiring.ts:167-197`), and
   THAT is what the new poller must take over, or ambient email→GBrain memory goes dark.
   Two more reasons it should not survive: it runs a bespoke 60s timer wheel off the
   cron substrate with a ONE-MINUTE daily fire window (`isFireTime` matches exact
   hour+minute, `triage-scheduler.ts:112-116` — a 60s outage loses the day), and its
   timezone math is a static build-time string through the lossy
   `new Date(now.toLocaleString(...))` round-trip (`triage-scheduler.ts:114`,
   `email-managed-wiring.ts:137`) rather than the per-fire `instance_metadata` contract
   everything else uses.
   Also a scope correction: the `email_triage` MCP tool and `/email triage` chat command
   are **on-demand** surfaces, not the scheduled digest — they stay (the owner asked to
   keep the Core's existing features), and `triage.ts`/`composeTriage` stays with them.

8. **WRONG on both specifics of the model claim.** (a) `email-system/docs/AS_BUILT.md`
   contains no model pins at all (grep for `gpt-4.1|nano|mini` = zero hits; the file
   documents the importance refactor). (b) The pins live in code and are simpler than
   "per-category nano/mini": classification is `gpt-4.1-mini` (`classify/llm.ts:120`);
   ALL brief batch-summarizers are `gpt-4.1-mini` (`brief/generator.ts:198` default,
   `:287`, `:351`, `:399`); `gpt-4.1-nano` appears once, in the `/goto` interstitial
   summary (`generator.ts:526`) — a surface this plan deletes. What varies per category
   is body-length/token budgets, not model. Per correction 5, none of these pins move to
   a registry — the calls move to the substrate.

**Findings beyond the brief:**

9. **`src/config/sender-map.json` is 1,384 lines of owner PII** (~500 real sender
   addresses + personal domain rules) and `taxonomy.json`/`labels.ts` encode the owner's
   personal categories ("bar-community", "newsletter/emptiness", a personal Gmail label namespace).
   None of it can enter the public tree (the `purity` leak gate,
   `.github/workflows/ci.yml:85-123` → `scripts/ci/leak-gate.sh`, exists to block
   exactly this). Sender rules and taxonomy become **per-owner instance data** with a
   generic shipped default; the owner's tuned set is imported at cutover (§ 8).

10. **Hardcoded owner addresses in logic**: `PROTECTED_SENDERS`
    (`pipeline/process-email.ts:35-38`) and `OWNER_EMAILS` (`classify/engine.ts:41-46`)
    contain real addresses. They become configuration derived from the instance (the
    connected accounts' own addresses via `GmailAccountDescriptor.account_email`,
    `multi-account.ts:84-91`, plus owner-added protected senders in `sender_rules`).

11. **`topic-router` is a production no-op**: `process-email.ts:119` calls
    `routeEmailToTopic(...)` and discards the return value. `sender-analysis.ts`,
    `triage-state.ts`, and `brief/telegram-digest.ts` are referenced **only by tests**.
    All four are dead code walking.

12. **The current escalation is two-stage** — it forwards an enriched payload to the
    legacy agent's gateway which ALSO dispatches an agent session for conversational triage
    (`pipeline/context-notify.ts:1-17`). Phase 1 ports the deterministic notification
    (chat post + push). Conversational agent handling of an escalated email is named as
    an explicit follow-up (§ 7), not silently dropped.

13. **The Core's `GmailClient` contract is missing two operations the pipeline needs**:
    per-MESSAGE label modify (only `modifyThread` exists — `contract.ts` /
    `google-client.ts:435-453`; archiving a whole thread when one message classifies as
    archive is wrong for active threads) and ensure-label for non-project labels (the
    processed marker; `ensureLabelImpl` is project-label-specific,
    `google-client.ts:463-499`). Phase 1 adds `modifyMessage` + a generalized
    `ensureLabel` to the contract and both backends. In the multi-account client,
    message-addressed ops must walk accounts the way `getMessage` does
    (`multi-account.ts:45-47`).

## 3. Capability map

Every email-system capability, disposition-tagged. (LOC per `wc -l`, 2026-08-06.)

| Capability | Where | Disposition |
|---|---|---|
| Gmail polling loop (backoff, go-live cutoff, wall-time caps, per-message state) | `pipeline/poller.ts` (359) | **KEEP** — becomes the Neutron poll cron job; feeds (1)+(2) and scribe fan-out |
| Classification cascade (2FA / billing-action / deadline / sender rules / learned cache / LLM / mass-mailer downgrade) | `classify/engine.ts` (343), `classify/llm.ts` (141) | **KEEP** — the importance decision IS capability (2); LLM call moves to substrate; owner PII constants become instance data |
| Importance escalation w/ retry + dedup | `pipeline/context-notify.ts` (372), parts of `poller.ts` | **KEEP** (2) — delivery rewired to `OutboundSink` + `PushDispatcher`; gateway/Telegram transport deleted |
| Brief window computation + batch summarize + anti-drift validation | `brief/generator.ts` (541) | **KEEP** (1) — tz generalized, per-category prompts become taxonomy data, LLM to substrate |
| Brief dedup per local day (`email_sent_at` gate) | `db/queries.ts:361-386` | **KEEP** (1) — the exact double-brief guard the reminders lane needed |
| Sender cache learning | `db/queries.ts:396-408`, engine | **KEEP** — bounds LLM cost; load-bearing for both capabilities |
| Retention cleanup | `maintenance/cleanup.ts` (70) | **KEEP** (shrunk) — weekly duty on the same loop |
| Taxonomy-as-data mechanism | `classify/taxonomy.ts` (23) | **KEEP** mechanism; Ryan's data → instance data |
| HTML email brief (template + MIME + send-to-self) | `brief/template.ts` (420), `brief/email-sender.ts` (87) | **PROPOSE DELETE — confirm** (owner question § 7): brief delivery becomes chat + push; chat render is ~40 new lines |
| Whole HTTP route surface (`/ingest`, `/classify`, `/brief*`, `/goto/*`, `/attachment/*`, feedback, summary, admin repair/labels/telegram-test) | `index.ts` (1364), `api/summary.ts` (197) | **DELETE** — service-boundary and brief-web artifacts; in-process now |
| Telegram notification transport + ops alerts (thread 409) | `notifications/telegram.ts` (181) | **DELETE** — Neutron chat/push replaces; op failures go to structured logs |
| Self-service OAuth reauth flow | `admin/reauth.ts` (217) | **ALREADY IN NEUTRON** — cores Google OAuth broker owns token lifecycle; delete |
| Gmail REST client + label helpers | `gmail/client.ts` (328), `labels.ts` (72), `actions.ts` (13), `utils.ts` (26) | **ALREADY IN THE CORE** — `google-client.ts` + `multi-account.ts`; delete (add `modifyMessage`/`ensureLabel`, § 2.13) |
| Return-to-inbox feedback + learning patterns | `index.ts:879-1027`, 2 tables | **PROPOSE DELETE — confirm**: tied to the deleted brief-web interstitial; chat-native feedback is a follow-up |
| Deal-flow feedback ratings | `index.ts:824-860`, `deal_feedback` | **DELETE** — email-button artifact, no consumer |
| Unsubscribe execution (one-click POST/GET, batch cursor) | `unsubscribe/*` (214) | **PROPOSE DELETE — confirm**: not tied to (1)/(2); not an existing Core feature |
| Topic router | `classify/topic-router.ts` (96) + `topic-routes.json` | **DELETE** — production no-op (§ 2.11) |
| Sender analysis / triage-state parsing | `sender-analysis.ts` (62), `triage-state.ts` (24) | **DELETE** — test-only (§ 2.11) |
| Telegram digest payload builder | `brief/telegram-digest.ts` (71) | **DELETE** — test-only |
| Crash-alert throttle for cron ticks | `index.ts:330-365` | **DELETE** — Neutron cron handlers return status; failures land in the job registry + logs |
| Attachment proxy/download | `index.ts:676-715` | **DELETE** — brief-web artifact; chat deep-links to Gmail |
| **Neutron side:** scheduled daily triage digest | `cores/free/email/src/triage-scheduler.ts` (253) + scheduler halves of `email-managed-wiring.ts` | **DELETE** (Phase 3) — replaced by the absorbed brief; never user-visible today (§ 2.7) |
| **Neutron side:** on-demand `email_triage` tool + `/email triage`, all 8 MCP tools, drafts/send 4-point policy, multi-account, summarize | `tools.ts`, `chat-commands.ts`, `triage.ts`, `draft-policy.ts`, … | **KEEP** — the Core's existing surface, untouched |
| **Neutron side:** scribe email fan-out + watermark | `email-managed-wiring.ts:145-199` | **KEEP, re-homed** onto the poller (Phase 3) |

## 4. The DELETE list

**email-system (entire repo retired at Phase 4; per-file accounting of what is never ported):**

| Item | LOC |
|---|---|
| `src/index.ts` — all routes, brief-web pages, admin/repair endpoints, crash alerter | 1,364 |
| `src/config/sender-map.json` (becomes instance data, exits code entirely) | 1,384 |
| `src/brief/template.ts` (HTML email) — PROPOSE DELETE, confirm | 420 |
| `src/gmail/client.ts` + `labels.ts` + `actions.ts` + `utils.ts` (superseded by Core client) | 439 |
| `src/admin/reauth.ts` (superseded by cores OAuth broker) | 217 |
| `src/api/summary.ts` | 197 |
| `src/notifications/telegram.ts` | 181 |
| `src/unsubscribe/` — PROPOSE DELETE, confirm | 214 |
| `src/state/email-state.ts` (folds to columns on `emails`) | 147 |
| `src/classify/topic-router.ts` + `topic-routes.json` | 110 |
| `src/brief/email-sender.ts` — PROPOSE DELETE, confirm | 87 |
| `src/classify/sender-analysis.ts` + `triage-state.ts` (test-only) | 86 |
| `src/brief/telegram-digest.ts` (test-only) | 71 |
| `src/db/queries.ts` shrinkage (493 → ~150 in the new store) | ~340 |
| 24 test files, Worker/CF scaffolding (`wrangler.toml`, miniflare config), docs | ~3,000+ |
| **Tables deleted: 8 of 13** — `audit_log`, `deal_feedback`, `inbox_feedback`, `inbox_learning_patterns`, `unsubscribed`, `triage_decisions`, `sender_profiles`, `classification_history`; `email_processing_state` folded | — |

**neutron-open deletions (Phase 3):**

| Item | LOC |
|---|---|
| `cores/free/email/src/triage-scheduler.ts` + its test | 253 + ~330 test |
| Scheduler halves of `gateway/cores/email-managed-wiring.ts` (fire/deps builder; watermark helpers survive, re-homed) | ~120 of 201 |
| Email half of `mount-cores-scribe-fan-out.ts` arm | ~40 |

Net: **~8,000+ lines and one entire hosted service (Worker + D1 + 6 secrets + 3 crons)
deleted**; surviving ported logic ≈ 1,700 lines rehoused in the Core.

## 5. Target architecture

**Module layout** (inside `cores/free/email/` unless noted):

```
cores/free/email/
  src/pipeline/
    poller.ts        # poll loop body: list new INBOX mail, classify, act (port of poller.ts)
    classify.ts      # cascade engine (port of classify/engine.ts, PII-free; substrate LLM)
    prompts.ts       # classification + summary prompt templates (generic defaults)
    escalate.ts      # capability (2): compose + dedup the important-email notification
    store.ts         # pipeline sidecar CRUD (replaces db/queries.ts, ~150 LOC)
  src/digest/
    window.ts        # owner-tz brief windows (generalized computeBriefWindow)
    generator.ts     # capability (1): group by category, batch-summarize, anti-drift validate
    render.ts        # chat-markdown digest render (~40 LOC; replaces template.ts)
  src/taxonomy.ts    # data-driven categories: shipped generic default + per-owner override file
  migrations-pipeline/0001_email_pipeline.sql  # OWN migration tree for the new sidecar —
                     # a sidecar namespace is per-DB-FILE (each gets its own _migrations,
                     # migrations/runner.ts:58-63), and reusing the per-project cache tree
                     # would drag triage_cache et al. into the pipeline DB
gateway/cores/email-pipeline-wiring.ts # deps bundle: cron jobs, deliver, push, tz, settings
```

**Data model (the 4+1 surviving tables)** in a NEW instance-level sidecar
`<owner_home>/email/pipeline.db` (the inbox is instance-scoped — multi-account merges
accounts; per-project sidecars stay untouched for triage/summary/draft caches). Opened via
`openSidecar` + `applyProjectScopedMigrations` exactly like `cache.ts:22-41`:

- `emails` — id, thread, sender, subject, snippet, body_text, received/processed, category,
  handling, brief_id, **plus folded escalation state**: `escalated_at`, `escalation_attempts`,
  `last_error` (replaces `email_processing_state` + the `audit_log`-based
  `hasSuccessfulTelegramNotification` dedup, `db/queries.ts:296-303`).
- `sender_cache` — learned classifications (bounds LLM cost; port as-is).
- `sender_rules` — NEW: owner-editable sender/domain → category/handling/protected rules.
  Replaces `sender-map.json` + `SENDER_NAME_OVERRIDES` + `PROTECTED_SENDERS` as *data*.
  Ships empty; the owner's tuned set imports at cutover (§ 8).
- `briefs` — id, period, generated_at, email_count, delivered_at, data (dedup gate:
  delivered per owner-local day, porting `getBriefForDate`'s sent-gate semantics,
  `db/queries.ts:361-386`).
- `checkpoints` — go_live_after, last_poll_at, consecutive_errors, scribe watermark
  (absorbing `.scribe-email-watermark.json`).

**Cron jobs** — registered on the existing registries (`cron/jobs.ts` + `cron/handlers.ts`)
via the `registerIdleNudgeSweepCron` pattern (`gateway/proactive/cron.ts:91-108`), from
`open/composer.ts`:

- `email-pipeline-poll` — `{ kind: 'interval_ms', interval_ms: 5 * 60_000 }`,
  `skip_if_running: true`. Duties per tick: resume failed escalations, poll + classify +
  act, then check the digest windows (owner-local, resolved per-fire via
  `readOwnerTimezone` — `owner-metadata.ts:32` — with the `withTickTimezone` precedence,
  `proactive/cron.ts:45-51`) and fire the digest when inside a window and not yet
  delivered today. One job, DST-correct by construction, no UTC hour pinning.
- `email-pipeline-cleanup` — weekly interval; ports `runRetentionCleanup` (90/30/30-day
  windows, `maintenance/cleanup.ts:10-12`).

**LLM seam** — the substrate one-shot caller (`buildOneShotSubstrateLlm`,
`mount-open-cores.ts:412-417`; models via `getBestModel` / `FAST_MODEL`,
`runtime/models.ts:95`). Single path; no OpenAI dependency; an LLM-less box degrades to the
deterministic cascade (sender rules + patterns + cache classify most mail without an LLM,
and the digest falls back to snippet lines — the same graceful shape `composeTriage`
already has).

**Delivery seams** (both capabilities, identical transport):
- **Chat**: `deliver(topic_id, envelope)` — the ONE out-of-turn chat seam
  (`gateway/http/deliver.ts:99-116`; durable-row-FIRST, then best-effort live push to
  the app-ws session), wired once at the composition root (`open/composer.ts:2382-2395`)
  and targeted at the owner's bare topic `appWsTopicId(OWNER_USER_ID)`
  (`open/composer.ts:2433` — the exact topic discipline the PR #105 deliver-to-nobody
  incident produced). Digest posts use `durability: 'inert'` (the morning-brief/nudge
  shape — an already-resolved history turn, `deliver.ts:59-70`); escalations use
  `durability: 'reply'` (the fired-reminder shape — a row the owner can answer). The
  chat transcript is the **guaranteed** surface.
- **Mobile push**: `PushDispatcher.pushAll(project_slug, message)`
  (`gateway/push/dispatcher.ts:85-98`) — best-effort alongside chat, never instead of it
  (zero registered devices today; self-heal is PR #114). The escalation never depends on
  push alone.

**The settings toggle** — the digest on/off the owner asked for is a **user-facing product
setting, not a feature flag** (owner-requested 2026-08-05; do not strip it citing the
no-flags rule). It follows the `transcription_backend` precedent exactly: an additive
column `email_digest_enabled` on `instance_metadata` (NULL = enabled — default ON), read/
written only in `gateway/storage/owner-metadata.ts` (the module that owns the table,
`owner-metadata.ts:11-16`), exposed through a small settings surface (the
`voice-transcription-surface.ts` shape) and a section in `app/app/settings.tsx`. The
escalation path has no toggle — it IS capability (2).

**Scribe fan-out** — moves from the daily scheduler onto the poller (Phase 3): each newly
seen message fans to `scribe.extractFromCoresSource` via the existing binding
(`mount-cores-scribe-fan-out.ts:104-131`), guarded by the same high-watermark semantics
(`email-managed-wiring.ts:50-83`) now stored in `checkpoints`. Net effect: ambient email
memory goes from daily-batch (and only the top-50 lookback) to ~5-minute freshness.

## 6. Phases

Every phase = one reviewable Open PR, updates `AS_BUILT.md`, names its composition seam,
and its acceptance is an observable outcome on a real install — never "tests pass."
Purity constraints bind every phase: fixtures use `*.example.com`, no real senders/hosts,
"instance/owner" vocabulary (leak gate: `ci.yml:85` → `scripts/ci/leak-gate.sh`).

**Phase 0 (prerequisite, already in flight — not a plan PR):** merge PR #115
(`fix/email-digest-project-label` — the Core's list path + whole-inbox read; its
`google-client.ts` q-fix stays load-bearing for `email_list`/`email_search` regardless of
the scheduler's deletion) and PR #114 (push self-heal).

**Phase 1 — pipeline + escalation (capability 2 live end-to-end).**
- Scope: pipeline sidecar + migration `0002_email_pipeline.sql`; `pipeline/` modules
  (poller body, cascade port with substrate LLM, escalation, store); contract additions
  `modifyMessage` + generalized `ensureLabel` on both Gmail backends and the
  multi-account router (§ 2.13; processed label = `Neutron/processed`); NEW
  `gateway/cores/email-pipeline-wiring.ts`; cron job registration + sink/push/tz threading
  in `open/composer.ts`.
- Composition seam: `open/composer.ts` (job + handler registration on the registries
  built at `composer.ts:849` / `build-core-modules.ts:584-592`; `deliver`,
  `PushDispatcher`, `readOwnerTimezone`, substrate LLM threaded into the wiring module).
- Acceptance (real install, connected Gmail): send a test email matching a deterministic
  importance rule (e.g. a protected-sender rule added via `sender_rules`, or a
  billing-action subject) → within ~5 min a chat message appears in the owner's
  transcript naming sender, subject, and the importance reason, and a push attempt is
  logged. A newsletter-shaped email is archived + labeled + queued with NO chat post.
- Tests + the mutation each catches: cascade port keeps the email-system importance
  suite's semantics (2FA/billing/deadline/mass-mailer downgrade — asserting the RESULT
  fields, so inverting the `has_unsubscribe` downgrade kills them); poller test with a
  fake Gmail backend asserts the label mutations issued AND the sink received an
  `OutgoingMessage` whose text contains the sender + subject (a digest/escalation that
  fires-but-says-nothing kills it); dedup test: second tick after a delivered escalation
  posts nothing (removing the `escalated_at` guard kills it); go-live test: pre-cutoff
  mail is archived, never classified (dropping the cutoff check kills it).
- Out of scope: the digest, scheduler deletion, settings, scribe fan-out.

**Phase 2 — twice-daily brief + settings toggle (capability 1).**
- Scope: `digest/` modules (owner-tz windows at 10:00 and 15:00 local; category
  grouping; batch summarize with the ported sibling-drift/identity validation,
  `generator.ts:56-183`; chat-markdown render with Gmail thread deep-links); per-day
  delivered-gate; `instance_metadata.email_digest_enabled` column (top-level migration
  0116) + owner-metadata accessors + settings surface + `settings.tsx` section; digest
  fire wired into the Phase-1 poll job.
- Composition seam: `email-pipeline-wiring.ts` (digest duty on the existing job) +
  `gateway/http` settings surface + `app/app/settings.tsx`.
- Acceptance (real install): at the next window boundary a digest chat post appears
  grouping the day's test emails with LLM summaries and correct Gmail links; flip the
  toggle off in Settings → the next window produces nothing; flip on → it resumes.
- Tests + mutations: window math across a DST transition in a non-UTC zone (hardcoding
  UTC hours kills it); per-day dedup (removing the delivered-gate → the double-brief
  test fails — the exact failure shape excluded from the reminders lane); summary→email
  identity validation (swapping two summaries in the LLM stub output kills it — the
  anti-drift guard); content assertion that the rendered digest contains each queued
  email's subject or summary (an empty-but-fired digest kills it); toggle honored
  (ignoring the setting kills it).
- Out of scope: scheduler deletion, scribe fan-out move, HTML-email delivery (pending
  § 7 Q1).

**Phase 3 — delete the old digest path; scribe fan-out rides the poller.**
- Scope: delete `triage-scheduler.ts` + its tests; strip the scheduler deps/fire builder
  from `email-managed-wiring.ts` (keep + re-home the watermark semantics into the
  pipeline store); remove the email half of `mount-cores-scribe-fan-out.ts` `arm`
  (calendar half untouched); poller fans each newly seen message to scribe via the
  existing binding.
- Composition seam: `open/wiring/memory.ts` + `open/composer.ts:5094-5098` (the arm) +
  `email-pipeline-wiring.ts`.
- Acceptance (real install): send a test email containing a distinctive fact → within
  ~10 min `gbrain_search` recalls it; `grep -rn buildTriageScheduler` outside
  `__tests__` returns nothing; `/email triage` on-demand still answers.
- Tests + mutations: watermark idempotency — two poll ticks over the same mailbox fan
  each message exactly once (removing the watermark check → duplicate-extraction test
  fails); teardown drains in-flight extractions (the existing `idle()` contract).
- Out of scope: any change to the 8 MCP tools / chat commands.

**Phase 4 — owner cutover + Cloudflare decommission.**
- Scope: an importer (script under `scripts/`, PII-free — it reads the owner's local
  `sender-map.json`/`taxonomy.json` paths at runtime) that seeds `sender_rules` + the
  owner taxonomy override; a short runbook in the PR description; Managed
  `vendor/neutron` bump + redeploy after merge (routine, separate Managed commit).
- Cutover order — **no parallel run, ever**: both systems mutate the same inbox labels
  and the Worker archives mail out of INBOX before Neutron's poller would see it
  (`process-email.ts:55-57`). So: (1) deploy Neutron with the pipeline live and digest
  ON; (2) disable the Worker's cron triggers in the same hour; (3) observe 48h against
  the incident-verification structure (baseline / window / result / `[verified:]` tag);
  (4) `wrangler delete` + keep a D1 export snapshot as a cold archive. Rollback at any
  point = re-enable the Worker triggers.
- Acceptance: two consecutive real days produce both briefs at owner-local times and at
  least one real escalation, on the owner's live instance, with the Worker's crons off.

### Phase 2.5 — classification setup by survey + interview (D3)

**Scope.** Installing the Email Core runs an onboarding pass instead of shipping rules: sample
a bounded window of the owner's real inbox, cluster it by sender and by shape, then ask the
owner about each class it actually found ("mail from these 6 senders looks like order
receipts — brief them, escalate them, or ignore them?") and write the answers as per-owner
rules. Ships zero rules in the tree (D2). Reuses the existing approval/question surface
rather than inventing a wizard.

**Composition seam.** The Core's install lifecycle (`cores/free/email/src/` install hook) plus
the substrate one-shot LLM already wired at `gateway/cores/mount-open-cores.ts:412-417`.

**Acceptance (observable, end-to-end).** On a fresh instance with a connected mailbox and NO
hand-authored rules, completing setup produces a populated per-owner rule set, and the next
brief is organised by classes the owner actually confirmed. A self-hoster who has never seen
this repo gets working classification on day one.

**Tests + the mutation each catches.** Assert the interview's proposed classes are DERIVED
from the sampled inbox, not from a built-in list — a mutation that returns a hardcoded
taxonomy regardless of the sample must red. Assert an owner "ignore" answer is persisted and
then HONOURED by the next classification pass (write-only persistence is the failure mode
here, exactly as with the learning loop). Assert zero rules ship in the tree: a fixture-free
instance classifies nothing until setup runs.

**Out of scope.** Re-running the interview on drift, and multi-mailbox rule merging.


## 7. Risks + open questions for the owner

**Open questions: NONE REMAIN — all closed by § 0.** Kept here with their answers because
the reasoning matters:

1. ~~Does the brief also arrive as an email?~~ **CLOSED — D1: yes, by email. That is the
   feature.** The recommendation this section originally carried (chat + push only) was
   wrong, and wrong in a way worth recording: it optimised for deleting ~507 LOC and in
   doing so proposed deleting the product. A twice-daily digest of dozens of messages is
   an email; chat is for the escalation that needs you NOW. The LOC count was allowed to
   argue with the requirement.
2. ~~Confirm the PROPOSE DELETEs.~~ **CLOSED — D4: the learning loop is KEPT** (it is live
   and closed at `poller.ts:82`, and it is what makes classification improve). **D5:
   unsubscribe is not broken and is decided separately.** The HTML template is KEPT per D1.

**Facts and risks (not decisions):**

- **Escalation latency is bounded by the poll interval (~5 min)** — identical to the
  current Worker (`*/5` cron). Not a regression; stated so nobody "fixes" it.
- **LLM cost moves from metered OpenAI to the substrate.** The cascade + sender cache
  keep LLM calls to first-contact senders and ambiguous mail; the digest adds ~10 batch
  calls/day. Same order of work the Core's other surfaces already put on the substrate.
- **Conversational escalation follow-up**: today's Stage-1 forward also triggered a CC
  session that could act on the email (§ 2.12). Phase 1 ships the deterministic
  notification; wiring an agent turn on escalation is a clean later increment on the
  same seam.
- **Push is dark until PR #114 lands and a device registers** — which is why chat is the
  guaranteed surface in both delivery paths.
- **The Worker's D1 has drifting `sender_cache`/learning state until cutover** — cutover
  is a hard switch (§ 6 Phase 4), so drift is bounded to the days between Phase 1 and
  Phase 4. Keep that gap short.

## 8. Migration / cutover — what happens to the existing data

**Recommendation: clean start on pipeline state; import the tuned rules; archive D1.**

- **D1 rows: do not import.** Retention already caps them at 90/30/30 days
  (`cleanup.ts:10-12`); `emails`/`briefs` are re-derivable views over Gmail, which still
  holds every message; and the ported go-live checkpoint (`poller.ts:97-110`) guarantees
  the fresh instance never reprocesses or re-briefs history. Importing rows would buy
  nothing capability (1) or (2) needs.
- **The one asset worth migrating is the tuned rule set**: `sender-map.json` (~500
  sender/domain rules) and the owner taxonomy. The Phase-4 importer seeds them into
  `sender_rules` + the taxonomy override on the owner's instance — data, never code, so
  the public tree stays clean. Optionally the same importer can fold D1's
  `inbox_learning_patterns` domains (hit_count ≥ 2) into `sender_rules` as
  importance hints; low value, near-zero cost — importer flag, default off.
- **Decommission**: disable Worker cron triggers at cutover (hard switch, § 6 Phase 4),
  48h verified observation, then `wrangler delete` with a final D1 export kept as a cold
  snapshot. The `email-system` repo is archived read-only; nothing in Neutron references
  it.
