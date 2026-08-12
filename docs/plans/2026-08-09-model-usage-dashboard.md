# Model usage dashboard — design + implementation plan (2026-08-09)

> Arbiter design pass. Read-only investigation; repo claims carry `file:line`. Items the
> arbiter could not establish are listed rather than inferred.

## The recommendation, in five lines

1. **Nothing is persisted today, so the first PR is a store, not a chart:** persist the
   5h/7d readings the credential-usage monitor already takes every 60 seconds and throws
   away, and serve one aggregated payload with pace and time-to-reset — that alone
   answers "can Anthropic take the next build?".
2. **Then add the Codex and Kimi gauges** (Codex from its own CLI session files, Kimi
   from its account-wide quota endpoint), so the three pool cards can be ranked by
   headroom — the dashboard's whole job is that ranking.
3. **Then the token ledger:** a collector over the Claude transcript root the adapter
   already resolves, classified into trident phases by each subagent's opening role
   prompt — the one mechanism worth lifting from the prior dashboard, and it needs no
   new instrumentation.
4. **Per-account honesty:** Open cannot name the account behind the swapped credentials
   file; it shows "active credential" until the rotator writes a one-line label sidecar
   (proposed below). No inferred attribution is ever presented as a measurement.
5. **Surface:** one global "Usage" surface behind the web ☰ menu and behind mobile
   Settings — hand-drawn fill bars from existing theme tokens, no chart library,
   dark-only on mobile, and none of the prior dashboard's multi-source machinery.

---

## A. What is measured, and where it is stored

**Plain-language consequence: today Open measures everything and remembers nothing.**
Every turn's token counts cross the runtime boundary and are dropped; the usage meter is
a live probe whose history evaporates after five minutes. The dashboard's real first
deliverable is durability, and the design content is choosing the write paths so a chat
turn, a trident subagent, and a background job all land in the same table.

### What exists (verified)

- **Per-turn counts are observed, never stored.** `runtime/events.ts:19-23` defines
  `TokenUsage` (`input_tokens`, `output_tokens`, cache fields); every `completion` event
  carries it (`runtime/events.ts:81-83`). Its only consumer is credential-pool health:
  `gateway/wiring/build-llm-call-substrate.ts:794` calls `reportSuccess` on completion
  and reads nothing else. There is **no usage table**: the latest migration is
  `migrations/0116_trident_launcher_crashes.sql`, and a grep for `usage` across
  `migrations/` hits only `0072_secret_audit_author.sql` (an unrelated audit column).
  This confirms in code what the governed spec recorded on 2026-08-08.
- **The live meter is instantaneous, not a history.** `open/credential-usage-monitor.ts`
  probes every 60s (`USAGE_POLL_INTERVAL_MS`, line 60), caches one reading in memory, and
  ages it out at 5 minutes (`USAGE_MAX_AGE_MS`, line 67).
  `gateway/http/app-usage-surface.ts:34-58` serves that single snapshot at
  `GET /api/app/usage`. The probe (`auth/credential-usage-probe.ts:108-120`) reads the
  unified 5h/7d utilization + reset headers verbatim; a 429 is read as a full window
  (`:167-172`). **Every reading after the current one is discarded.** Persisting them is
  nearly free and is the seed of the whole dashboard.
- **Trident's numbers never reach the gateway's event stream.** The workflow runs
  detached on a warm substrate (`trident/inner-loop.ts:6-22`); `trident/inner-workflow.mjs`
  contains no token-usage handling at all. A completion-event tap would therefore miss
  the single largest spender.
- **But every Claude agent writes a transcript Open can already locate.**
  `runtime/adapters/claude-code/persistent/spawn.ts:460-475` resolves the transcript
  root explicitly: `options.projectsDir` → `CLAUDE_CONFIG_DIR/projects` →
  `~/.claude/projects`, and computes each session's `jsonlPath`. The CLI writes workflow
  subagents' transcripts under `<project>/<session>/subagents/[workflows/<wf>/]agent-*.jsonl`.
  Chat turns, trident subagents, and background/cron turns all dispatch through the same
  adapter, so **one filesystem root covers all Claude spend**.
- **Codex:** the codex CLI writes `event_msg/token_count` session events carrying both
  token usage and `rate_limits` (`used_percent`, `resets_at`, window minutes).
  Open materializes per-owner/per-project `CODEX_HOME` dirs
  (`trident/codex-auth.ts:169-196`), so codex sessions land under paths Open already
  owns. `trident/codex-review.sh` records **no spend today** (verified: no sink/ledger
  anywhere in it). The host-side Codex forge bridge (a private deployment script,
  outside this repo) does record spend — but stamps every row with a **default model
  label** when the env override is unset, so its ledger asserts a model it does not know.
  The Open design must record `model = NULL` when the model is not actually known.
  Never a default masquerading as a measurement.
- **Kimi:** rate-limit information is **not** in response headers (verified: a live
  messages call returns only a trace id); the gauge endpoint is
  `GET {base}/coding/v1/usages`, which reports the **account-wide** weekly and 5-hour
  windows. Consequence, stated plainly: **per-service Kimi attribution is impossible** —
  Open's own Kimi token counts (available in the review lane's API responses, currently
  discarded by `trident/kimi-review.ts`) are a subset that can never be reconciled
  against the account gauge. The Kimi card is a whole-account gauge and says so on its
  face. The key is now enterable in Settings, so the poller has a credential source.

### The store (new migration, forward-only per `migrations/AGENTS.md`)

```sql
-- Gauge history: what the pools' own meters said, when.
CREATE TABLE IF NOT EXISTS usage_pool_samples (
  ts               INTEGER NOT NULL,
  pool             TEXT    NOT NULL,          -- 'anthropic' | 'codex' | 'kimi'
  account_label    TEXT,                      -- NULL unless the rotator names it (§B)
  session          REAL,                      -- 0..1, governing short window
  weekly           REAL,                      -- 0..1, governing long window
  session_reset_at INTEGER,
  weekly_reset_at  INTEGER,
  PRIMARY KEY (ts, pool)
);

-- Token ledger: what Open itself spent, per turn.
CREATE TABLE IF NOT EXISTS usage_turns (
  session_id TEXT NOT NULL,
  request_id TEXT NOT NULL,                   -- codex: seq; kimi: call id
  ts         INTEGER NOT NULL,
  provider   TEXT NOT NULL,                   -- 'anthropic' | 'codex' | 'kimi'
  model      TEXT,                            -- NULL when genuinely unknown
  source     TEXT NOT NULL,                   -- 'chat' | 'trident' | 'background' | 'review'
  phase      TEXT,                            -- trident phase key (§C), NULL otherwise
  project    TEXT,
  in_tok     INTEGER NOT NULL DEFAULT 0,
  out_tok    INTEGER NOT NULL DEFAULT 0,
  cache_w    INTEGER NOT NULL DEFAULT 0,
  cache_r    INTEGER NOT NULL DEFAULT 0,
  estimate   INTEGER NOT NULL DEFAULT 0,      -- 1 when the writer only had a total
  PRIMARY KEY (session_id, request_id)
);
```

Plus `table-ownership.json` entries and an `expected-schema.txt` regen. Retention:
`usage_pool_samples` pruned at 30 days, `usage_turns` at 90 — both by the collector's own
tick, no separate job. No rollup table in v1; SQLite over a few hundred thousand rows
with these indexes is instant.

### Write paths — three, each at its natural choke point

1. **Pool samples: a persist hook on the existing monitor tick.**
   `CredentialUsageMonitor.measureOnce()` already holds the reading; it gains an injected
   `persistSample` observer, wired in `open/composer.ts` beside the existing `onStanding`
   observer (registration discipline at `open/composer.ts:5185`). Codex and Kimi gauges
   are two more small pollers on the same `SupervisedLoop` pattern.
2. **Claude token rows: a transcript collector loop.** Reads new bytes from `*.jsonl`
   under the resolved projects root using per-file byte-offset watermarks (the prior
   dashboard's incremental reader is the piece worth porting — it is what makes a 60s
   tick cheap), parses assistant rows for `usage`, skips synthetic rows. Path shape gives
   `source`: `subagents/` ⇒ `trident`, else chat/background by session origin.
3. **Non-Claude rows: capture at the call site.** `trident/kimi-review.ts` already
   receives usage in the API response — persist it instead of discarding it.
   `trident/codex-review.sh` gets a stderr total-parse written through a tiny fail-soft
   sink (a usage-logging failure must never fail a review), with `estimate=1` and no
   default model label.

**Why the collector and not a completion-event tap:** the tap misses trident entirely
(verified above), and running both would be a dual path for the same fact. One writer per
provider.

## B. The account dimension, honestly

**Plain-language consequence: Open genuinely does not know which Anthropic account it is
using, and no code in this repo can find out on its own.** Rotation is an external
hosting layer swapping the credentials file underneath the child —
`gateway/wiring/resolve-llm-credentials.ts:292-296` states it exactly: *"the child
authenticates from the credential file, and rotation happens by SWAPPING THAT FILE
underneath it."* `open/active-credential.ts:23-29` reads that same file per tick, which
is why the meter tracks a rotation within one tick — but the file contains a token, not a
name, and the contract is deliberately singular (`contracts/credential-usage.ts:11-17`:
*"There is no pooling, no averaging, and no multi-account shape"*).

**What Open can attribute, alone:** utilization of the currently-installed credential, as
a time series once persisted; and the moment of a swap (a utilization discontinuity plus
a changed reset timestamp). **What it cannot:** the account's identity; the standing of
accounts not currently installed (it holds no tokens to probe them with); the account
behind any past token row. Reset-timestamp clustering could group samples into anonymous
credentials, but that is an inference and it is **rejected for display** — a dashboard for
deciding where to send work must not contain a guessed measurement.

**The smallest contract, two tiers, both optional and fail-soft** (absent ⇒ today's
singular display, unchanged):

- **Tier 1 — a label.** The rotator writes `<CLAUDE_CONFIG_DIR>/.credentials.meta.json`
  — `{"label": "acct-2", "fingerprint": "…"}` — atomically with each swap. An opaque
  owner-chosen string, never an email. Open reads it on the same tick it reads the token
  and stamps `account_label` onto pool samples. Cost to the rotator: a few lines. Buys:
  per-account gauge chips and honest "acct-2 is the one that's nearly capped".
  **The `fingerprint` is REQUIRED and is not optional politeness:** the label is used only
  when it demonstrably describes the token in hand, so a sidecar left behind by the
  previous swap degrades to null instead of naming the wrong account. It must be produced
  by calling `credentialFingerprint` (`open/credential-label.ts`, importable through
  `vendor/neutron`) — never reimplemented from prose, which is how this bullet came to
  describe a sidecar the reader silently rejects. As built:
  `docs/as-built/2026-08-09-credential-account-label.md`.
- **Tier 2 — the fleet feed.** The rotator already probes every account on its own tick
  to decide rotation; if it also appends
  `{ts, label, session, weekly, session_reset_at, weekly_reset_at}` as JSON lines to
  `<CLAUDE_CONFIG_DIR>/rotation-usage.jsonl`, Open ingests them into
  `usage_pool_samples` and the Anthropic card becomes a true fleet gauge: headroom floor
  across accounts, and "every account capped" as a fact rather than a deduction.

Without tier 2, the Anthropic card says "active credential", and other labels appear only
with a "last seen 3h ago" staleness mark. Never an averaged fleet number from partial
data.

## C. The panels, ranked by the decision each serves

**Plain-language consequence: the first screenful IS the answer.** The prior dashboard's
owner-verdict was "overcomplicated"; the panels that survive are the ones that answered a
question during real rate-limit incidents, ordered so the top card is where the next
build goes.

1. **Pool cards — "which pool can take this build right now?"** One card per pool,
   **sorted by headroom** so the answer is literally first. Each: governing-window fill
   bars in the existing band colours (`contracts/credential-usage.ts:74-77`, 0.85/0.95 —
   server and both clients already share them), % used, **resets in H:MM**, and **pace** —
   window consumed ÷ window elapsed, from the samples series. Pace > 1 means "running out
   before reset" and derives the one number worth a projection: *"caps ~4:10pm at this
   pace."* Anthropic card carries the account label/chips from §B. Kimi card is captioned
   "account-wide" per §A.
2. **Phase split — "what do I move off Anthropic?"** Horizontal bars of tokens by phase,
   24h/7d toggle, using the stable phase vocabulary in `trident/phase-models.ts:100-160`
   (decomposition · build · build-mechanical · rubric review · adversarial review ·
   synthesis · bookkeeping) plus `chat` and `background`. This is the panel that turns
   "Anthropic is tight" into "builds are 41% of it — put builds on Codex".
   Classification: each subagent transcript's **first user message is its role prompt** —
   anchored literal matching against the prompts `trident/agent-prompts.ts` emits, mapped
   through `phaseForLabel` (`trident/phase-models.ts:245`). Deterministic, retroactive,
   zero new instrumentation. A wrong phase silently moves cost between phases, so anything
   unmatched lands in `NULL` → "other", never a guess.
3. **Burn strip — "is right now a spike or the new normal?"** Tokens/hour, last 24h, one
   thin bar row per pool. Nothing more.
4. *(Deferred, tier-2 only)* **Cap events** — count of fleet lockouts in 7d. Only honest
   with the fleet feed.

Killed because they answered no decision: 30-day per-pool facet charts, the 72h sawtooth,
lockout history tables, per-project splits, dollar figures.

## D. Mobile and web, from one design

**Plain-language consequence: the server does all the thinking; the phones and browsers
only draw bars.** Shared: a new `contracts/usage-dashboard.ts` wire shape and one
surface, `GET /api/app/usage/dashboard`, computing pace/resets/splits server-side — the
same one-producer-two-thin-clients pattern the existing meter proves
(`open/credential-usage-monitor.ts` docblock: *"the web bar and the phone bar cannot
disagree"*; twin clients at `landing/chat-react/usage-client.ts` and
`app/lib/usage-client.ts`). Written twice, necessarily: the components — React DOM in
`landing/chat-react/`, RN in `app/`.

**No chart library.** Every surviving panel is fill-bars and numbers, which both
codebases already render natively (`landing/chat-react/UsageMeter.tsx`,
`app/components/UsageMeter.tsx`). `react-native-svg` is **not** in `app/package.json` and
adding a native module plus a new native build to draw one diagonal is not worth it when
"pace 1.6×" carries the same decision; on web, chart.js is ~200KB min and recharts ~500KB
with d3. Hand-drawn wins on both.

**Mobile is dark-only** (`app/lib/theme.ts:139`) and already has
`usage_nominal/warning/critical` tokens (`theme.ts:61-66`) — no light variant is designed.
Web uses the existing chat-react theme variables in both schemes.

**Placement — follow the 2026-08-07 consolidation, and say why:** settings-shaped
surfaces live behind the ☰, not in the tab band (`landing/chat-react/HeaderMenu.tsx:9-23`:
*"the band keeps the places you work, the menu holds the things you adjust"*). Per the
sibling decision on code-gen settings, this is **not a core-injected tab or webview**: the
gateway owns the data shape and each client renders it natively. Concretely: a
global-scope builtin descriptor `usage` beside `admin` (`tabs/registry.ts:133-140`) so the
web ☰ gains a "Usage" row through the existing items plumbing — registry-driven
underneath — and on mobile a nav row on the Settings screen (the Admin-row pattern,
`app/app/settings.tsx:353-355`) pushing a `/usage` screen. A dashboard is a thing you
check, not a place you work.

**Mobile layout — the pool cards ARE the first screenful, stacked, not a squeezed grid:**

```
┌────────────────────────────────┐
│ ← Settings · Usage             │
├────────────────────────────────┤
│ ANTHROPIC              acct-2  │
│ 5h ███████████░░░░  72%        │
│ 7d ████████░░░░░░░  55%        │
│ resets 1h 40m · pace 1.6×      │
│ caps ~4:10pm at this pace      │
├────────────────────────────────┤
│ CODEX                   OPEN   │
│ wk ███░░░░░░░░░░░░  22%        │
│ resets 3d 2h · pace 0.4×       │
├────────────────────────────────┤
│ KIMI · account-wide            │
│ wk █████░░░░░░░░░░  38%        │
│ resets 4d · pace 0.9×          │
├────────────────────────────────┤
│ WHERE IT WENT      [24h] 7d    │
│ build          ████████  41%   │
│ review         █████     27%   │
│ chat           ███       15%   │
│ decomposition  ██         9%   │
│ other          █          8%   │
├────────────────────────────────┤
│ BURN — tok/h, 24h              │
│ ▁▂▁▅▇▃▁▁▂▆▇▅▂▁                 │
└────────────────────────────────┘
```

**Web — cards in a row, panels beneath; same payload, same order:**

```
┌ ☰ → Usage ───────────────────────────────────────────────────┐
│ ┌ ANTHROPIC · acct-2 ─┐ ┌ CODEX · OPEN ┐ ┌ KIMI · acct-wide ┐│
│ │ 5h ████████░░  72%  │ │ wk ██░░  22% │ │ wk ████░░  38%   ││
│ │ 7d █████░░░░   55%  │ │ resets 3d 2h │ │ resets 4d        ││
│ │ resets 1h 40m       │ │ pace 0.4×    │ │ pace 0.9×        ││
│ │ pace 1.6× → ~4:10pm │ └──────────────┘ └──────────────────┘│
│ └─────────────────────┘                                      │
│ ┌ WHERE IT WENT   [24h] 7d ──────┐ ┌ BURN — tok/h, 24h ────┐ │
│ │ build          ██████████ 41%  │ │ ▁▂▁▅▇▃▁▁▂▆▇▅▂▁        │ │
│ │ review         ███████ 27%     │ │ (per-pool colour)     │ │
│ │ chat           ████ 15% …      │ └───────────────────────┘ │
│ └────────────────────────────────┘                           │
└──────────────────────────────────────────────────────────────┘
```

## E. What is deliberately not built

- **Multi-source ingestion** — no remote pulls, no other hosts' ledgers, no
  external-service panels. This dashboard measures **this instance's** usage, full stop.
  (The owner's verdict on the prior version, and the reason its 20-file, ~9,000-line
  pipeline is not being lifted.)
- **Quota-points normalization** — the prior dashboard fit a regression to convert tokens
  into "% of a 5h cap". Cleverest and least trustworthy part; here the pools' own meters
  provide utilization directly and tokens stay tokens.
- **A publish pipeline** — no static HTML, no deploy cron, no "stale page that looks
  current" failure class. The dashboard is a live surface of the gateway.
- **Per-account attribution by inference** — reset-fingerprint clustering is possible and
  rejected (§B).
- **Dollar figures** — everything runs on subscriptions; a dollars column would be an
  estimate wearing a measurement's clothes.
- **A chart library, a light mobile theme, a feature flag** — §D, `app/lib/theme.ts:139`,
  and the repo's hard rule respectively. Ships on, one code path; absent data renders as
  honest empty states using the existing `UsageUnavailableReason` discipline, never zeros.
- **A content-probing activity tagger** — the prior dashboard grew role-classification,
  activity tags, and an NNLS solver around data never designed to be attributed. Open
  designs the attribution in (§A write paths, §C classifier) instead of excavating it
  later.

## What the arbiter could not establish

- **Open's subagent transcript layout byte-for-byte** —
  `subagents/[workflows/<wf>/]agent-*.jsonl` is the CLI's own behaviour as documented by
  the prior collector; expected identical under Open's `CLAUDE_CONFIG_DIR`, to be
  confirmed against a live run in PR 3.
- **Codex session-file location under Open's `CODEX_HOME`** — the CLI writes sessions
  under its home; verified against the CLI by the prior collector, not yet against an
  Open install.
- **The Kimi `/coding/v1/usages` schema beyond the fields the prior script reads** — the
  endpoint is undocumented upstream; the poller must treat missing fields as "no
  reading", per the existing never-fabricate-zero rule.

## Implementation sequence

- **PR 1 — the Anthropic card, real.** Migration for `usage_pool_samples` + persist hook
  on `CredentialUsageMonitor.measureOnce()` + `GET /api/app/usage/dashboard` (pools:
  anthropic only) + the web Usage surface (☰ row, one card with pace, resets, caps-at
  projection). Small, one pass, and the owner can look at it the same day.
- **PR 2 — Codex + Kimi gauges.** Two pollers (codex session `rate_limits`; Kimi usages
  endpoint via the Settings-stored key), cards ranked by headroom. The "which pool takes
  the next build" question is now answered.
- **PR 3 — the token ledger.** `usage_turns` migration, transcript collector with
  watermarks, kimi-review response capture, codex-review stderr capture (`estimate=1`,
  `model=NULL` when unknown), phase classification via role prompts, and the "Where it
  went" + burn panels.
- **PR 4 — mobile.** `/usage` screen + Settings row, rendering the same payload with RN
  Views.
- **PR 5 — the rotator contract.** Read the label sidecar and the optional fleet feed
  fail-soft; account chips and fleet-floor on the Anthropic card. (The rotator-side write
  is a few lines in the hosting layer, outside this repo.)
