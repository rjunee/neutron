# Usage / quota / spend dashboard — design + implementation plan (2026-08-13)

> Design pass, no feature code. Every claim about this repo carries a `file:line`
> citation verified against the tree at the time of writing; anything not verified
> is marked **unverified**. Paths are repo-relative throughout.
>
> **Relationship to `docs/plans/2026-08-09-model-usage-dashboard.md`:** this doc
> SUPERSEDES that plan's token-ledger design (its §A.3 "transcript collector",
> §C.2 role-prompt phase classification, and PR 3) and its panel-scope decisions
> that the owner has since overridden (per-project splits and read/write/cache
> splits are IN scope here). Its PR 1 has landed (`migrations/0119_usage_pool_samples.sql`,
> `persistence/usage-samples-store.ts`, `gateway/http/app-usage-surface.ts`); its
> gauge posture, account-honesty rules, staleness discipline, no-chart-library and
> placement decisions survive and are incorporated below.

## 0. The governing directive

The owner's instruction, verbatim:

> *"I dont want to complicate the dashboard design with random hacks you decided
> to do in the past. It's meant to be architected for the ongoing future of how
> neutron open will actually be used."*

The reference implementation in the owner's personal harness is a **scraper**: it
tails Claude Code JSONL transcripts with an incremental byte-offset reader,
classifies turn roles heuristically, and NNLS-fits an exchange rate against a
scraped gauge. That architecture exists because it observes Claude Code from the
**outside**, with no access to the call sites. Neutron Open owns every one of its
call sites, so none of that machinery is ported. The rule this design follows:

- **SPEND is EMITTED, never RECONSTRUCTED.** The code that makes the call writes
  the usage event, carrying the project, surface, phase and token breakdown it
  already knows.
- **The provider GAUGE is the only inherently external read** — how much of an
  account's window is consumed is a fact only the provider knows. That is a
  small, per-provider surface, and the one place external-API quirks enter.

If any part of this design had required parsing Neutron's own transcripts to
find out what Neutron itself did, that part would be wrong. §2.4 records the one
place this line needed actual care (the interactive `claude` child) and how the
design stays on the right side of it.

---

## 1. What exists today (verified)

### 1.1 The gauge path — real, wired, Anthropic-only

- `GET /api/app/usage/dashboard` **exists and is served.** The surface is
  `gateway/http/app-usage-surface.ts:56-88` (exact-path match for
  `/api/app/usage/dashboard` at `:36,65`, returns `{ pools: opts.dashboard() }`
  at `:84`). It is wired in the production composer at `open/composer.ts:3918-3927`
  and registered as the `app_usage_surface` route slot at `open/composer.ts:5802`.
- The payload is `{ pools: PoolSummary[] }`. `PoolSummary` is
  `persistence/usage-samples-store.ts:58-66` — `pool`, `measured_at`,
  `account_label`, `session`, `weekly`. Pace and exhaustion projection are
  computed at read time off a persisted month-long series
  (`summariseWindow`, `usage-samples-store.ts:92-139`; retention
  `USAGE_SAMPLE_RETENTION_MS` = 30 days at `:83`).
- The series is written by a 60-second probe: `open/credential-usage-monitor.ts`
  (poll interval `:63`, staleness ceiling `:70`) → `onSample` →
  `UsageSamplesStore.record` (`open/composer.ts:3906-3909`). The probe itself is
  `auth/credential-usage-probe.ts:127-179`: a one-token `POST /v1/messages`
  whose only purpose is to read Anthropic's unified rate-limit headers verbatim
  (`:49-52`), with seconds→ms normalisation at the boundary (`:90-94`), 429
  read as a full window (`:167-172`), and "200 without headers" classified as
  `no-windows` rather than zero (`:36-41,178`).
- `UsagePool = 'anthropic'` **only** (`persistence/usage-samples-store.ts:19`);
  the table schema is already pool-generic
  (`migrations/0119_usage_pool_samples.sql:40-50`).
- The account dimension exists and is honest: `account_label` comes from an
  optional fingerprint-verified sidecar written by whatever swaps the
  credential file (`open/credential-label.ts:1-40`); a label that does not
  fingerprint-match the live token degrades to null, never to a guess.
- Two thin clients render it: `app/lib/usage-dashboard-client.ts` and
  `landing/chat-react/usage-dashboard-client.ts` (deliberate twins; null
  semantics documented at `app/lib/usage-dashboard-client.ts:24-45`).

**Verdict on the brief's first claim: TRUE.** The dashboard endpoint exists,
renders, and already computes pace/projection — for one pool, one account at a
time.

### 1.2 The spend path — observed on two adapters, fabricated on the third, persisted nowhere

- The event vocabulary carries usage: `TokenUsage` at `runtime/events.ts:19-24`
  (`input_tokens`, `output_tokens`, `cache_creation_input_tokens?`,
  `cache_read_input_tokens?`), on every `completion` event
  (`runtime/events.ts:80-88`, with `substrate_instance_id` and optional
  `dollars`).
- **`openai-responses` fills it with real numbers** parsed from the SSE stream
  (`runtime/adapters/openai-responses/responses-stream.ts:294-295`, accumulated
  at `:141,166-168`).
- **`codex-cli` fills it with real numbers** from `turn.completed`
  (`runtime/adapters/codex-cli/event-map.ts:16,122-125`), zeros only on a
  synthesized completion after truncation (`runtime/adapters/codex-cli/exec.ts:276`).
- **The Claude Code persistent REPL — the adapter serving essentially all
  Anthropic traffic — emits hardcoded zeros.** `ZERO_USAGE` is defined at
  `runtime/adapters/claude-code/persistent/signatures.ts:43` and pushed on every
  completion at `runtime/adapters/claude-code/persistent/repl-session.ts:284-291`.
  This is structural, not an oversight: the substrate is an *interactive* PTY
  REPL (`gateway/wiring/build-llm-call-substrate.ts:791-793`:
  "`createClaudeCodeSubstrateAuto` UNCONDITIONALLY builds the persistent
  interactive-REPL substrate"), there is no `-p --output-format json` result
  object to read, and the reply is lifted off a reply channel
  (`repl-session.ts:260-291`).
- **Nothing persists per-call usage.** The chokepoint proxy consumes completion
  events only to advance pool cooldown bookkeeping
  (`gateway/wiring/build-llm-call-substrate.ts:800-806` calls
  `reportSuccess` and never reads `ev.usage`); the shared drain type has no
  usage field (`DrainOutcome`, `runtime/substrate-text.ts:133-138`). A
  repo-wide grep for production readers of `ev.usage` returns only tests
  (survey control: the same pattern positively matches
  `runtime/adapters/openai-responses/responses-stream.ts:294-295`).
- **Prior art was deliberately dropped.** `meters`
  (`migrations/0003_meters.sql:23-47`) was exactly this table — one row per
  substrate dispatch with five token columns, cost, `pricing_version`,
  `substrate_instance_id` — and it was dropped in
  `migrations/0109_drop_vestigial_chat_tables.sql:41` for having **no writer**;
  `migrations/runner.test.ts:201-208` now asserts its absence. The lesson this
  design takes: the store is the easy half; the writers are the feature. Every
  table proposed below names its writer in the same phase.
- A pricing registry exists and is currently caller-less:
  `runtime/model-pricing.ts` (`resolveModelPricing`, header rule at `:6-9`:
  never hardcode $/MTok outside that file).

**Verdict on the brief's second claim: PARTLY TRUE, and the correction matters.**
"Neutron observes per-turn token counts and persists none" is true for the
OpenAI-family and codex-cli adapters. For the Anthropic path it is FALSE in the
more important direction: the persistent REPL observes nothing — it fabricates
zeros. So the gap is not only emission + attribution; on the main path it is
also **acquisition** (§2.4).

### 1.3 Where the calls are made

There is one type-level seam — `Substrate.start(spec)`
(`runtime/substrate.ts:138`, `AgentSpec` at `:108-127`) — and one production
factory every in-process LLM call is built from: `buildLlmCallSubstrate`
(`gateway/wiring/build-llm-call-substrate.ts`, header `:1-40`: "Single primitive
that every LLM call site in the gateway dispatches through"; Claude dispatch at
`:795`, OpenAI-family dispatch at `:1205`). Its nine production construction
sites, each already carrying a distinct surface label
(`substrate_instance_id`), verified by survey this session:

| Surface | Construction | Instance id |
|---|---|---|
| Live chat turns | `open/wiring/substrates.ts:241` | `cc-agent-<owner>` |
| Onboarding phase-spec | `open/wiring/substrates.ts:186` | `cc-llm-<owner>` |
| Per-project compose | `open/wiring/substrates.ts:321` | `cc-compose-<owner>` |
| Ephemeral worktree (dispatch) | `open/wiring/substrates.ts:365` | `<prefix>-<owner>` |
| Trident fire (warm, per repo) | `open/wiring/substrates.ts:415` | `cc-trident-fire-<owner>-<hash>` |
| Scribe | `open/wiring/memory.ts:142` | `cc-scribe-<owner>` |
| Reflection | `open/wiring/memory.ts:285` | `cc-reflection-<owner>` |
| Reflect-pass | `open/wiring/memory.ts:390` | `cc-reflect-<owner>` |
| Onboarding synthesis | `open/composer.ts:1231` | `cc-synthesis-<owner>` |

Context already reaches the chokepoint per dispatch: it resolves the live
project id as `input.projectIdResolver?.() ?? spec.metering_context?.project_id`
on both the Claude path (`build-llm-call-substrate.ts:742-744`) and the
OpenAI-family path (`:633`). Note `metering_context` is a documented
near-dead dimension on the CC adapter (`runtime/substrate.ts:98-107`; the
2026-06-08 incident at `build-llm-call-substrate.ts:305-312` is why the live
resolver exists) — §5.1 does not overload it.

Calls that do NOT pass through the chokepoint (each needs its own answer, §5):

- **Trident's Claude lanes.** The gateway only dispatches a short "fire" turn
  (`trident/inner-loop.ts:495-505`); the workflow then runs **detached inside
  the `claude` child** as a CC Dynamic Workflow, and every lane —
  `plan:fable`, `forge:build`, `forge:fix-round-N`, `argus:claude`,
  `argus:adversarial`, `argus:synthesis`, `checkpoint:*`, probes, cleanup
  (label literals in `trident/inner-workflow.mjs`; stable phase vocabulary in
  `trident/phase-models.ts:100-161`) — is an `agent()` call made by the
  workflow runtime, not by repo code.
- **`argus:codex`** — a workflow agent runs `trident/codex-review.sh`, which
  pipes a prompt into `codex exec` and maps the **exit code** to a verdict; no
  token or usage field is read anywhere in trident (survey grep with positive
  control; the only per-lane observability is a log line at
  `trident/inner-workflow.mjs:369` with no code consumer).
- **`argus:kimi`** — a workflow agent runs `trident/kimi-review-cli.ts`, which
  calls `reviewWithKimi` (`trident/kimi-review.ts:160-170`): an in-process
  `POST {KIMI_BASE_URL}/v1/messages` whose Anthropic-shaped response carries a
  `usage` block that the parser currently discards (`extractAnswerText` reads
  only `content[].type === 'text'`).
- **Auth-tier probes** (`auth/credential-usage-probe.ts:46`,
  `auth/max-oauth.ts`) — allow-listed exceptions to the no-direct-API rule
  (`credential-usage-probe.ts:14-22`). ~1 token per minute, acknowledged and
  left unmetered (§6.4).
- **Non-LLM paid calls** out of scope for this dashboard but noted for
  honesty: transcription (`gateway/transcription/openai-transcription.ts:30`),
  profile-pic image gen — the one place a per-call dollar figure exists today,
  reported to a callback and never a table
  (`onboarding/profile-pic/gemini-imagegen.ts:69,82-83`), and gbrain
  embeddings (free/local by default, `gbrain-memory/embedder-config.ts`).
- Domains verified to make **no** LLM calls: doc-search
  (`doc-search/store.ts:26-32`), message-search, skill-forge
  (`skill-forge/distiller.ts:8`), tasks/work-board (consume an injected
  `LlmCallFn`; wired at `open/composer.ts:2701,3777`).

### 1.4 Trident run state — what the waste metric can stand on

- One SQLite row per run: `code_trident_runs`
  (`migrations/0077_code_trident_runs.sql:89-118`; typed row
  `trident/store.ts:60-137`), carrying `id` (the run id threaded into workflow
  args, `trident/inner-loop.ts:245`), `project_slug`, `phase`, `branch`, `pr`,
  `worktree`, `inner_checkpoint`, `inner_verdict`, `inner_result`
  (`migrations/0091_code_trident_runs_inner_result.sql`), and `harvested_at`
  (`migrations/0102_code_trident_runs_harvested_at.sql:28-29`) — the only
  trustworthy "the outer loop really decided" signal.
- Mid-run writes happen from inside the workflow via `trident/checkpoint.sh`
  (whitelisted field/value CLI over the run row, busy-timeout hardened,
  `checkpoint.sh:1-45`) — **this is the proven seam by which an out-of-process
  lane writes durable state**, and §5.3 reuses its pattern.
- Worktree cleanup is deterministic and preservation-biased
  (`trident/worktree-cleanup.sh`, decision table `:19-36`): dirty or
  unverifiable ⇒ **preserve** and print `PRESERVED worktree|branch` lines;
  clean ⇒ plain `git worktree remove` (never `--force`); branch deleted only
  when `git ls-remote` proves origin holds the exact sha (`:271-305`). Output
  lines are machine-readable (`REMOVED`, `PRESERVED …`, `KEPT branch`,
  `DELETED branch`, `RESULT preserved=<n> removed=<n>`, `:60-68`), and the
  workflow classifies them (`classifyCleanupOutcome`,
  `trident/inner-workflow.mjs:2155-2172`) — **but the classification is only
  logged, never persisted** (survey-verified; §7 fixes this).
- Resume: live-run recovery exists (orphan re-fire from `inner_checkpoint`,
  `trident/orchestrator.ts:361-363,765-790`; hang reaper `:270-282`; ralph
  re-fire `:493-563`). **Resume of a terminal run does not exist** — the
  command surface is `dispatch | stop | help | unrecognized`
  (`trident/code-command.ts:32-36`) and the tick scans `listNonTerminal()`
  only (`trident/store.ts:383`). Survey-verified with absence greps + positive
  controls.
- Account rotation is NOT implemented in Open: `auth/max-oauth-multi-sub.ts`
  is a throw-on-call stub by design (`:120-122`, rationale `:1-33`); rotation
  happens outside the process by swapping the credentials file
  (`gateway/wiring/resolve-llm-credentials.ts:292-296`). The general
  `runtime/credential-pool.ts` rotation machinery exists but trident never
  touches it (survey grep + control).

---

## 2. The architecture — first-party emission

### 2.1 Statement

**Every LLM call site in this repo emits a `spend_event` at the moment its
result is known, carrying the context only the call site has: provider, model,
account label, project, surface, phase/lane, run id, and the four token
classes.** The dashboard is a read model over two owned tables — `spend_events`
(what we spent, at call grain) and `usage_pool_samples` (what the providers'
own meters said, at account×window grain) — joined only where the join is
honest (§4.4).

There are exactly four writers, one per acquisition channel, and no fact has
two writers (double-count safety is structural, not filtered):

| # | Channel | Covers | Token source | Context source |
|---|---|---|---|---|
| W1 | Chokepoint emitter in `buildLlmCallSubstrate` | every OpenAI-family / codex-cli-adapter dispatch | `completion.usage` (real on these adapters, §1.2) | construction input + per-dispatch `spend_context` (§5.1) |
| W2 | CC telemetry intake (loopback OTLP receiver) | every turn of every spawned `claude` child — chat, scribe, cores, onboarding, **and every trident Claude lane** | the `claude` binary's own OpenTelemetry export (§2.4) | session-registry lookup: session id → context registered by the spawner (§5.2) |
| W3 | Kimi lane writer in `trident/kimi-review.ts` | `argus:kimi`, `argus:kimi-retry` | the `usage` block already present in the HTTP response it parses | its own argv/env: run id + lane label (§5.3) |
| W4 | Codex lane writer in `trident/codex-review.sh`'s replacement path | `argus:codex`, `argus:codex-retry` | `codex exec --json` structured stdout events (§5.3) | its own argv/env: run id + lane label |

The Claude chokepoint path (W1's Claude branch) emits **context registration**
for W2 rather than a spend row — because its `completion.usage` is fabricated
zeros (§1.2) and writing zeros would be worse than writing nothing.

### 2.2 Why this is not a scraper

The reference implementation's defining moves were: tail *all* transcripts
under a config root with byte watermarks; decide *whose* spend a turn was by
classifying its text; convert tokens to quota by fitting. Here:

- Nothing tails anything. W2 receives what the `claude` binary **pushes** over
  a supported telemetry channel designed for exactly this purpose.
- Nothing classifies content. Attribution is a lookup of context that the
  spawner **registered before the spend happened** (project/surface at
  dispatch, run id at fire), or that the writer carries in its own argv.
- Nothing is fitted. Tokens stay tokens; window consumption stays the
  provider's own gauge; the two are shown adjacently (§8), and the only
  weighting offered is deterministic list-price weighting computed at read
  time from `runtime/model-pricing.ts` and labelled an estimate (§8.3).

### 2.3 What is deliberately not carried over from the reference implementation

| Reference module (concept) | Why it existed there | Why it does not exist here |
|---|---|---|
| Incremental JSONL reader + per-file watermarks | outside observer had to tail every transcript | the call sites emit; nothing is tailed |
| Turn parser + role classifier (heuristics over transcript text) | attribution had to be reconstructed after the fact | attribution is registered before the call returns |
| NNLS exchange-rate fit, `exchange-rate.json`, quota-points | tokens had to be converted to "% of a 5h cap" to be comparable to the gauge | the gauge is first-class and shown in its own unit; no conversion is presented as a measurement |
| Activity tagger (content probing) | wanted "what was this turn about" without instrumentation | surface/phase arrive as explicit parameters |
| External import / multi-source ledgers | aggregated several machines | this dashboard measures **this instance**, full stop (unchanged from the 2026-08-09 plan §E) |
| Rotator-log parsing | account identity had to be inferred | account labels come from the fingerprint-verified sidecar (`open/credential-label.ts`) or are honestly null |
| Static-HTML publish pipeline | dashboard was a generated page | live gateway surface; no "stale page that looks current" failure class |

Facts *harvested* from the reference implementation and kept (they are
properties of external providers, not of the scraper): the Codex facts and
Kimi facts in §6, each with the test that pins it in §10.

### 2.4 The one hard acquisition problem: the interactive `claude` child

The Anthropic substrate is a PTY REPL with no JSON result (§1.2), so first-party
token counts need a channel the child itself supports. Verified against the
official Claude Code docs this session
(`code.claude.com/docs/en/monitoring-usage`, `…/hooks`, `…/headless`):

- **Claude Code exports OpenTelemetry metrics and log events**, enabled by env
  at spawn: `CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_METRICS_EXPORTER=otlp`,
  `OTEL_LOGS_EXPORTER=otlp`, `OTEL_EXPORTER_OTLP_PROTOCOL=http/json`,
  `OTEL_EXPORTER_OTLP_ENDPOINT=<loopback receiver>`, with configurable export
  intervals (`OTEL_LOGS_EXPORT_INTERVAL`). Token counts are carried on
  `claude_code.token.usage` (attribute `type` ∈ `input` / `output` /
  `cacheRead` / `cacheCreation`) and cost on `claude_code.cost.usage`;
  standard attributes include `session.id` (kept by default) and a per-prompt
  id. It works in interactive PTY sessions and under subscription (OAuth)
  auth. Env is read at startup — a respawn is required, which fits this
  codebase: the spawn env is already layered per child
  (`gateway/wiring/build-llm-call-substrate.ts:14-17`; argv/env assembly in
  `runtime/adapters/claude-code/persistent/build-repl-argv.ts` and
  `…/spawn.ts`).
- **Hooks are NOT a usage channel**: the Stop hook payload carries
  `session_id` / `transcript_path` / `last_assistant_message` and explicitly no
  token or cost fields. The existing Stop-hook machinery
  (`runtime/adapters/claude-code/persistent/hooks/enforce-reply.ts:44,291-311`)
  stays what it is.
- The exact **log-event name and attribute set for per-request events is
  pinned by Phase 0** (§9), not assumed here. Rule of record: a field's name is
  not a contract — print the field from a real export before keying logic on
  it. The fixtures captured in Phase 0 become the contract tests' inputs.

So W2 is: the gateway hosts a tiny OTLP/HTTP intake (one POST route, loopback
only, gateway-owned — same route-slot discipline as every other surface,
`gateway/http/route-slots.ts`), every spawned `claude` child gets the OTEL env
vars, and the intake writes `spend_events` rows attributed via the session
registry (§5.2). **The child pushes its own accounting; Neutron never reads a
transcript.** The 2026-08-09 plan's transcript collector — the last surviving
scraper organ — is thereby replaced wholesale.

Rejected alternatives, with reasons:

- *Parse the child's session JSONL on Stop* — is precisely the banned
  architecture, just narrower. Also inherits every format-drift risk the
  reference implementation carries.
- *Estimate tokens from reply length via the pricing registry* — a fabricated
  number wearing a measurement's clothes; violates the "never a default
  masquerading as a measurement" rule the repo already enforces for models
  (2026-08-09 plan §A) and for gauges (`credential-usage-probe.ts:36-41`).
- *Switch the substrate to `claude -p --output-format json`* — `-p` was
  deliberately rejected for billing reasons; the interactive REPL is the sole
  spawn shape (`build-repl-argv.ts:6-10`,
  `build-llm-call-substrate.ts:791-793`). The dashboard must not re-litigate
  the substrate decision.

---

## 3. The gap, as a spec-conformance diff

```
OWNER ASKS:                                  EXISTS TODAY:                                  MISSING:
all connected accounts, per provider         one pool ('anthropic'), one account at a       codex + kimi pools; per-account label
                                             time, label via sidecar                        series & chips; codex/kimi samples
5h + 7d usage, pace, predicted cap           YES for anthropic (store + surface + both      same three numbers for codex (window
                                             clients; §1.1)                                 regime-aware) and kimi
spend by project / surface / trident phase   NOTHING persisted; context exists at the       spend_events + 4 writers + context
                                             chokepoint (project) and in the workflow       propagation (§5)
                                             (labels) but is never written
read / write / cache-read / cache-write      TokenUsage carries all four classes; real on   persistence + per-class rendering;
                                             2 of 3 adapters; zeros on CC                   CC acquisition via OTEL (§2.4)
"quota points, not raw tokens"               nothing                                        honest proxy only: gauge shown
                                                                                            adjacently + list-price weighting
                                                                                            labelled estimate (§8.3); no fit
burn-rate lines, cap-out with no rotation    pace/exhausts_at per window per pool           burn series from spend_events; pool-
                                             (read-time, §1.1)                              level cap-out gated on fleet data (§8.4)
wasted tokens (unrecoverable-only defn)      run rows + deterministic cleanup verdicts      artifact_state persistence + run-grain
                                             (logged, not persisted; §1.4)                  spend join + waste panel (§7)
multiple accounts per provider               anthropic label sidecar; codex per-project     per-label sample series; "fleet"
                                             CODEX_HOME dirs; kimi single key               posture stays honest: last-known + age
```

---

## 4. Data model

Forward-only migrations per `migrations/` conventions (STRICT tables, ownership
entry, `expected-schema.txt` regen — the 0119 migration is the template).

### 4.1 `spend_events` — the spend grain (new table, new migration)

```sql
-- 01XX_spend_events.sql — first-party spend ledger. One row per LLM call
-- (or per provider-reported usage event), written AT THE CALL SITE.
-- NOTE deliberately NOT named `meters`: that table was dropped in 0109 for
-- having no writer, and migrations/runner.test.ts:201 pins its absence.
-- This table ships in the same PR as its first writer.
CREATE TABLE IF NOT EXISTS spend_events (
    source        TEXT    NOT NULL,   -- 'substrate' | 'cc-otel' | 'kimi-lane' | 'codex-lane'
    event_id      TEXT    NOT NULL,   -- writer-scoped idempotency key (§4.2)
    ts            INTEGER NOT NULL,   -- epoch ms, writer clock
    provider      TEXT    NOT NULL,   -- 'anthropic' | 'openai' | 'kimi'
    model         TEXT,               -- NULL when genuinely unknown; NEVER defaulted
    account_label TEXT,               -- fingerprint-verified label, else NULL (never guessed)
    project_id    TEXT,               -- NULL for platform-internal work
    surface       TEXT    NOT NULL,   -- 'chat'|'scribe'|'reflection'|'reminders'|'cores'|
                                      -- 'onboarding'|'compose'|'dispatch'|'trident'|'unattributed'
    phase         TEXT,               -- trident lane label VERBATIM ('argus:kimi',
                                      -- 'forge:fix-round-3', …), NULL outside trident
    run_id        TEXT,               -- code_trident_runs.id, NULL outside trident
    session_id    TEXT,               -- substrate session id when known
    input_tokens          INTEGER NOT NULL DEFAULT 0,  -- INCLUDES the cached portion
    output_tokens         INTEGER NOT NULL DEFAULT 0,  -- INCLUDES reasoning (§6.1)
    cache_read_tokens     INTEGER NOT NULL DEFAULT 0,  -- subset of input
    cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens      INTEGER NOT NULL DEFAULT 0,  -- subset of output; display-only
    estimate      INTEGER NOT NULL DEFAULT 0,          -- 1 when the writer had less than
                                                       -- a full provider-reported breakdown
    PRIMARY KEY (source, event_id)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_spend_events_ts         ON spend_events (ts);
CREATE INDEX IF NOT EXISTS idx_spend_events_project_ts ON spend_events (project_id, ts);
CREATE INDEX IF NOT EXISTS idx_spend_events_run        ON spend_events (run_id);
CREATE INDEX IF NOT EXISTS idx_spend_events_provider_ts ON spend_events (provider, ts);
```

Decisions encoded here:

- **No cost column.** Cost is a derivative of (tokens, model, price table) and
  a stored derivative goes stale the moment the table improves — the same
  reasoning `usage-samples-store.ts:9-14` applies to pace. Cost-weighted views
  are computed at read time via `resolveModelPricing`
  (`runtime/model-pricing.ts`), which finally gains its first caller.
- **Four token classes as four columns**, never a single total: the owner
  asked for them separately, cached reads are routinely the majority of
  volume, and the classes have four different prices (§6.1). `reasoning_tokens`
  is stored as the subset it is and excluded from all sums (§6.1).
- **`estimate` is a flag, not a licence**: an estimated row still never
  invents a model or an account.
- Retention: 90 days, pruned on the writers' own ticks (same
  writer-owns-pruning rule as `usage_pool_samples`,
  `migrations/0119_usage_pool_samples.sql:31-34`). No rollup table in v1;
  the read queries are indexed GROUP BYs over ≤ a few hundred thousand rows.

### 4.2 Idempotency keys per writer

Keying rule of record: *a field's name is not a contract — every key below is
pinned to a Phase-0-printed real artifact before code keys on it.*

- `substrate`: a ULID minted per completion event (no replay path exists in
  the proxy; the key exists so a future retry path cannot double-write).
- `cc-otel`: the exported event's own identity — expected
  `session.id` + per-prompt id + event sequence (**exact attribute names
  pinned in Phase 0**). The intake dedupes on it because OTLP delivery is
  at-least-once.
- `kimi-lane`: `<run_id>:<lane>:<attempt>` — the lane and retry-lane are
  distinct labels already (`trident/phase-models.ts:186-190`).
- `codex-lane`: `<run_id>:<lane>:<seq>` where `seq` is the cumulative
  `total_token_usage.total_tokens` — the one value measured (reference
  implementation, 2026-08-08, over 16,155 events) to be strictly increasing
  and byte-identical across the duplicate `token_count` emissions that
  otherwise overcount input by ~16%. §10 pins this with a test.

### 4.3 `usage_pool_samples` — extended, not replaced (migration + type change)

- `UsagePool` widens to `'anthropic' | 'codex' | 'kimi'`
  (`persistence/usage-samples-store.ts:19`); the table is already generic.
- New nullable columns `session_window_ms INTEGER`, `weekly_window_ms INTEGER`:
  the store currently hardcodes 5h/7d (`usage-samples-store.ts:69-70`), which
  is correct for Anthropic and **wrong across Codex's window-regime change**
  (§6.2). `summariseWindow` reads the sample's own window length, falling back
  to the pool default. A historical series that straddles a regime change is
  summarised per-sample, never with one global constant.
- `account_label` stays as-is and gains writers: the Kimi poller stamps the
  key's account id; the codex harvest stamps the per-project `CODEX_HOME`
  label (§6.2–6.3).
- Pace for a stale sample is computed **as of `measured_at`**, not as of the
  render clock — computing "fraction ÷ elapsed" with a fresh `now` against a
  stale fraction silently deflates pace as the sample ages. The summary
  carries `measured_at` already (`usage-samples-store.ts:61`); the fix is in
  `summarise()` threading `latest.ts` as `now` when the sample is older than
  one poll interval, plus an age field the clients render (§8.1). Test in §10.

### 4.4 The grains, and where they join

- A **gauge sample** belongs to (provider, account, window, instant).
- A **spend event** belongs to (project, surface, phase, instant), with the
  account label stamped *at dispatch time* when the sidecar can name it.
- **Honest join:** spend and gauge share provider + account_label + time, so
  the dashboard can show, for one account, the gauge climbing alongside the
  spend that account served — adjacently, as two series in two units.
- **Refused join:** apportioning an account's *window consumption* across
  projects. That would require the provider's quota-weighting function, which
  is not published; the reference implementation's answer was to fit one, and
  that answer is rejected here (§2.3). What the owner gets instead: per-project
  token/cost-weighted breakdowns (owned data, exact) NEXT TO per-account gauge
  behaviour (provider data, exact), and no number that pretends to be both.
- **Rotation** means the account behind a project's spend changes over time;
  because the label is stamped per event at dispatch, rotation appears in the
  data as it happened, and an unlabeled interval appears as NULL — shown as
  "active credential", never backfilled.

### 4.5 `code_trident_runs.artifact_state` — the waste evidence column (migration)

```sql
ALTER TABLE code_trident_runs ADD COLUMN artifact_state TEXT;
-- 'merged' | 'branch_pushed' | 'branch_local' | 'worktree_preserved' | 'none'
-- NULL = predates this feature / not yet classified.
```

Written by the outer loop and the cleanup path (§7.2). `checkpoint.sh` gains
`artifact_state` in its field whitelist (`trident/checkpoint.sh:22-33`) so the
workflow's `finally{}` can persist what `classifyCleanupOutcome` currently only
logs (`trident/inner-workflow.mjs:2155-2172`).

---

## 5. Attribution — how context reaches each writer

### 5.1 In-process dispatches: an explicit `spend_context`, not ambient scope

`AgentSpec` gains one optional field:

```ts
spend_context?: {
  surface: string          // vocabulary of §4.1
  phase?: string           // trident lane label, verbatim
  run_id?: string
}
```

with the project id continuing to arrive exactly as it does today
(`input.projectIdResolver?.() ?? spec.metering_context?.project_id`,
`build-llm-call-substrate.ts:633,742-744`). Construction sites that serve one
surface forever (scribe, reflection, compose, synthesis — §1.3 table) set a
construction-time default on the `buildLlmCallSubstrate` input instead of
touching every call; per-dispatch context overrides it.

**Explicit parameter over ambient `AsyncLocalStorage`, deliberately:**

- The failure mode of ambient context here is proven, not hypothetical: this
  exact seam already had a context field that silently died —
  `metering_context` collapsed every project into one warm REPL for months
  because nothing populated it and nothing could tell
  (`build-llm-call-substrate.ts:305-312`). An explicit required-by-type field
  on the emitting path is testable per call site; an ALS scope is not.
- The heaviest spender (trident) runs **detached past the dispatching turn**
  (`trident/inner-loop.ts:495-505`): any ALS scope opened at fire time is gone
  while 95% of the run's spend happens. Ambient context structurally cannot
  carry this codebase's main workload; explicit registration (§5.2) can.
- `metering_context` itself is NOT overloaded: it is documented as
  Private-substrate metering (`runtime/substrate.ts:98-107`) and semantically a
  different thing (who is billed) from `spend_context` (what the spend was
  for).

The chokepoint emitter then, on each completion event: OpenAI-family/codex
adapters → write a `spend_events` row (`source='substrate'`, real usage,
provider from the adapter branch, account_label = pooled credential id
(`runtime/credential-pool.ts:49-52`)); Claude branch → **register context,
write nothing** (§2.1, zeros rule).

### 5.2 The `claude` child: a session-context registry feeding the OTLP intake

A small in-memory registry, owned by the gateway, keyed by substrate session
id:

- **At spawn**, the adapter registers `session_id → { surface default,
  substrate_instance_id }` — it already knows both, and already threads
  `launcher_session_key` onto completions
  (`runtime/adapters/claude-code/persistent/repl-session.ts:289`).
- **At each dispatch**, the chokepoint updates `session_id → { project_id,
  spend_context }`. Warm REPLs are already keyed per project scope
  (`gateway/wiring/build-live-agent-turn.ts:1537-1540`), so a session's
  project mapping is stable between dispatches by construction.
- **At trident fire**, the fire path registers `session_id → { surface:
  'trident', run_id }` for the child the workflow detaches into, and clears it
  when the run row goes terminal (`harvested_at` stamp,
  `trident/orchestrator.ts:584`).

The OTLP intake resolves every incoming usage event through this registry and
writes `source='cc-otel'` rows. Unresolvable session ids are written with
`surface='unattributed'` and counted loudly (a climbing unattributed counter is
a wiring bug surfacing, not data to hide). Because OTEL export is periodic
(§2.4), rows land seconds after the spend — the dashboard's burn charts are
minute-grain, so this lag is invisible; the intake's last-received timestamp is
surfaced as the spend series' own staleness (§8.1).

**Trident lane grain, honestly:** run-level attribution (`run_id`) is
guaranteed by registration above. Lane-level attribution (`phase`) for Claude
lanes depends on whether the child's telemetry attributes identify the
workflow subagent (`agent.name` / subagent markers are documented attributes;
whether a Dynamic Workflow `agent()` label surfaces there is **unverified**
until Phase 0 prints it). Two honest outcomes:

- Attributes carry the lane → stamp `phase` verbatim, full fidelity.
- They do not → Claude lanes report at run grain; the phase panel shows
  "trident (run-level)" for Claude lanes alongside exact `argus:codex` /
  `argus:kimi` lanes (§5.3), and says so. **Time-bucketing lane spans is
  rejected** even as a fallback: the review panel runs its lanes in parallel
  (`trident/inner-workflow.mjs:1621-1710` labels; parallel panel per §1.4
  survey), so wall-clock windows cannot separate them without lying.

What remains honestly unattributable either way: which *fix round* a
mid-round subagent tool call belongs to when rounds share one lane label
(dynamic labels `forge:fix-round-N` disambiguate if and only if the attribute
carries them); and any spend of a child that dies before its final export
interval flushes (bounded by the export interval; measured in Phase 0).

### 5.3 Subprocess lanes: the writer is the lane itself

- **Kimi** (`trident/kimi-review.ts`): the response JSON already contains
  `usage`; the parser keeps it instead of discarding it, and
  `trident/kimi-review-cli.ts` persists a `source='kimi-lane'` row via the
  same DB-CLI pattern `checkpoint.sh` proved (busy-timeout-hardened, arg
  whitelist; §1.4). Run id and lane label arrive by argv — the workflow
  already threads `runId` into the lane's own file naming
  (`trident/inner-workflow.mjs:1569-1571`), so the plumbing precedent exists.
  Provider = `kimi`, account_label = the stored key's account (single,
  account-wide — §6.3), model = the request's model id (it is in the request,
  known exactly).
- **Codex** (`trident/codex-review.sh`): the review moves from bare
  `codex exec` to **`codex exec --json`**, which the repo already knows how to
  consume — `runtime/adapters/codex-cli/exec.ts:2-12,67` spawns exactly this
  and `event-map.ts:122-125` maps its usage payloads. The lane writer parses
  its OWN child's structured stdout for the final `token_count` /
  `turn.completed` usage (dedupe key §4.2) and the `rate_limits` snapshot
  (which doubles as a Codex gauge sample, §6.2), then writes a
  `source='codex-lane'` row. This is the subprocess's own structured result
  stream — the CLI-lane equivalent of an API response body — not transcript
  archaeology. **Unverified until Phase 0:** whether `token_count` events
  appear on `--json` stdout (they demonstrably appear in the CLI's session
  rollouts; the stdout shape is pinned by fixture in Phase 0). If stdout lacks
  them, the fallback is the single rollout file the invocation itself created
  under this run's own `CODEX_HOME` — still per-invocation, still the child's
  structured output, never a fleet tail — and the doc treats that as strictly
  second choice.
- Verdict-path behaviour is unchanged in both lanes: **a spend-write failure
  must never fail a review** (fail-soft, logged — same posture as
  `credential-usage-monitor.ts:281-291`).

---

## 6. Gauge sampling, per provider

All three feed `usage_pool_samples`. Uniform failure rule, already proven on
the Anthropic path and now a stated invariant: **a failed read writes no row
and fabricates nothing** — "no data" must remain distinguishable from "measured
zero" (`usage-samples-store.ts:151-156`, `credential-usage-probe.ts:36-41`).
Staleness is a rendered value, not an error state (§8.1).

### 6.1 Anthropic — exists; facts restated as contract

- 60 s probe of the active credential; unified 5h/7d utilization headers read
  verbatim; reset headers arrive in epoch SECONDS and are normalised to ms at
  the boundary (`auth/credential-usage-probe.ts:29-34,90-94`).
- 429 still carries the headers and is read like a 200; header-less 429 is
  recorded as a full window (`:161-172`).
- **Reasoning tokens are a subset of output tokens** (provider fact, both
  Anthropic-shaped and OpenAI-shaped usage): `reasoning_tokens` is display
  detail, never an addend. Reference-implementation measurement: subset held
  in 16,155/16,155 Codex events. Pinned by test (§10).
- **Read / write / cache-read / cache-write have four different prices** —
  which is why §4.1 stores four columns and §8.2 renders them separately.

### 6.2 Codex — opportunistic harvest first, no quota spent to measure quota

- There is no known free gauge endpoint (**unverified absence** — nothing in
  this repo or the reference implementation found one; if one exists the
  poller slots in beside Kimi's). What every real Codex run DOES return is a
  `rate_limits` snapshot riding its `token_count` events: `used_percent`,
  `window_minutes`, `resets_at`, `plan_type` (shape verified in the reference
  implementation's parser against 1,474 real session files).
- So the Codex gauge is **harvested from real runs** (W4, §5.3): every
  `argus:codex` review yields a sample at zero marginal cost. Consequence the
  owner sees: the Codex card's freshness equals "time since the last codex
  run", displayed as such (§8.1). A scheduled keep-fresh probe would spend
  subscription quota to measure it — Open Question #2.
- External facts this path must respect, each with a named test (§10):
  - `resets_at` is epoch **SECONDS** → ms at the boundary, same as Anthropic's
    headers. A unit slip lands every reset in 1970 and produces
    plausible-looking wrong windows.
  - **Reset jitter is real**: the same window's reported reset moves by
    seconds between snapshots → window membership is decided by time
    comparison (`|reset_a − reset_b|` under a tolerance), never equality.
  - **The window length changed regime** (300 → 10,080 minutes, observed
    2026-07-12): `window_minutes` is stored per sample (§4.3) and summaries
    never assume one constant across a series.
- Multiple Codex accounts: per-project `CODEX_HOME` dirs already exist
  (`trident/codex-auth.ts`; resolved per launch, `open/composer.ts:5637-5639`)
  — the harvest stamps `account_label` from the credential dir's identity, so
  two Codex accounts produce two labelled series without new machinery.

### 6.3 Kimi — a real poller against the documented usages endpoint

- `GET {base}/coding/v1/usages`, bearer subscription key. Key source: the
  stored instance credential (`trident/kimi-key.ts:18-26`,
  `KIMI_CREDENTIAL_SERVICE='kimi'`), enterable in Settings. Kimi returns **no
  rate-limit headers on normal calls** (reference-implementation verification,
  2026-08-08); the endpoint is the gauge.
- Poll on a `SupervisedLoop` like the Anthropic monitor, at 10 minutes (the
  cadence proven adequate externally; there is no 60 s need — kimi serves one
  lane).
- **Account-wide only**: two different keys returned byte-identical numbers
  and the same account id (reference-implementation verification, 2026-08-08).
  The card is captioned "account-wide", and per-key attribution is never
  offered from the gauge. Neutron's own Kimi token counts (W3) are a SUBSET of
  account activity and are never reconciled against the gauge — adjacent
  series, stated as such.
- The endpoint's full schema is undocumented upstream: absent fields are "no
  reading", never zero. The response reports window standings in the
  provider's own percentage-like units — those units are what the card shows
  (locked decision 2; no token conversion; the reference implementation's
  ~245k-tokens-per-unit calibration is deliberately NOT shipped — it is a
  fitted constant, the exact class of number this design refuses to display).

### 6.4 Staleness, end to end

`measured_at` (already on `PoolSummary`) → an explicit `age_ms` on the wire →
rendered age chip on every card ("as of 12m ago"), with pace computed as of the
sample (§4.3). A gauge older than its pool's expected cadence renders **floored
with its age**, never blanked, never extrapolated (locked decision 1). The
spend series carries its own staleness: last event received per source, so a
dead OTLP intake shows up as "anthropic spend: last event 3h ago" instead of a
flat zero line. Known permanently-unmetered spend is documented on the surface
itself: the 1-token/60s probe (§1.3) — cheap, but stated rather than hidden.

---

## 7. The waste metric

### 7.1 The definition, as locked

> *"if the branch survived and can be picked up, it's not waste. Waste is only
> when something wasn't recoverable and had to be redone."*

Three-way, decided per RUN (the unit of redoable work), from evidence Neutron
itself produced:

| Class | Meaning | Evidence (all first-party) |
|---|---|---|
| **merged** | landed | `phase='done'` + `harvested_at` set (`trident/store.ts`, `migrations/0102…:28-29`) + merge recorded by the outer merge path (`trident/merge.ts`, `trident/orchestrator.ts:596-620`) |
| **recoverable** | stopped, but the work survives and can actually be resumed | `artifact_state` ∈ `branch_pushed` (cleanup proved origin holds the sha — `worktree-cleanup.sh:271-305`), `branch_local` (`KEPT branch` in local merge mode), `worktree_preserved` (dirty/unverifiable worktree preserved — `worktree-cleanup.sh:19-36`) |
| **unrecoverable — the only waste** | the work was lost; redoing it costs the tokens again | terminal non-done run with `artifact_state='none'` (cleanup verified removal and no surviving ref), or a crash class that provably destroyed the workspace |

The evidence bar for "recoverable" is deliberately *a surviving ref or
worktree that a resume path can consume*, not "the run didn't error": a
branch is recoverable because `git ls-remote` / the cleanup contract proved a
reachable copy exists, which is exactly what the preservation-biased cleanup
already computes and prints (§1.4) — it just doesn't persist its verdict yet.

### 7.2 What ships

1. `artifact_state` column (§4.5), written at the two places the truth is
   known: the workflow's `finally{}` persists the cleanup classification via
   the extended `checkpoint.sh` whitelist, and the outer merge path stamps
   `merged` at harvest.
2. The waste read model: `spend_events` grouped by `run_id`, joined to
   `code_trident_runs (phase, artifact_state, slug, project_slug)`. Tokens of
   unrecoverable runs = wasted tokens; per week, per project, per phase.
3. The panel (§8.5) renders the three classes in three colours with
   unrecoverable called out as the only "waste" number. Runs predating the
   column (`artifact_state IS NULL`) render as "unclassified", excluded from
   the waste rate rather than polluting either side.

### 7.3 The second-order consequence, stated in the owner's terms

Under this definition, **mid-loop resume capability converts waste into
recoverable work**. Today a terminal run has no resume verb at all
(`trident/code-command.ts:32-36` — `dispatch | stop | help`; §1.4), so
"recoverable" currently means *recoverable by hand*. Every token the waste
panel shows in the recoverable band is the standing case for building the
resume verb (re-attach a preserved worktree/branch to a fresh run row — the
orphan re-fire path, `trident/orchestrator.ts:765-790`, already proves
checkpoint-resume inside a live run). The chart is designed to make that
investment case legible: recoverable-band tokens are labelled "resumable if
picked up", and if the owner routinely redoes recoverable runs from scratch,
that shows up as merged-runs-with-a-sibling-recoverable-run — measurable then,
not guessed now.

---

## 8. The surface

Placement and rendering discipline carry over from the 2026-08-09 plan §D
verbatim (one server-computed payload; twin thin clients; no chart library;
settings-shaped surface behind ☰ / Settings). The payload grows additively —
`{ pools }` stays, new top-level sections arrive beside it, and both clients
already treat absent sections as "older server", never as zeros
(`app/lib/usage-dashboard-client.ts:43-45`).

Order of panels — each earns its place by the decision it serves, most urgent
first:

### 8.1 Pool cards — "which account takes the next build?"

One card per provider, **side by side, each in its own unit, never summed**
(locked decision 2). Per card: account chips (one per known `account_label`,
each with its last-known 5h/7d fractions, pace, projected cap time, and an age
chip); the active account first. Staleness is a value: every number renders
with its age when older than the pool's cadence (§6.4). A pool with no
credential renders its honest empty state (`no meter` / `not connected`),
reusing the `UsageUnavailableReason` discipline
(`contracts/credential-usage.ts`).

### 8.2 Where it went — by project, then by surface, then by phase

Tokens over 24h/7d, grouped: project rows (from `project_id`), expandable into
surfaces (`chat` vs `trident` vs `scribe`…), trident expandable into phases
(lane labels via `phaseForLabel`, `trident/phase-models.ts:245`, rendered with
the owner-facing phase names of `TRIDENT_PHASES`). **Each row shows the four
token classes as a stacked bar** — input / output / cache-read / cache-write —
because cached reads dominating volume is precisely the fact a single number
hides. Per provider; no cross-provider total anywhere on the surface.

### 8.3 The quota-pressure proxy — answering "quota points, not raw tokens" without fitting

The owner's question is real: raw token counts mis-rank surfaces because the
four classes cost differently. The honest answer this design gives, instead of
the reference implementation's fitted exchange rate:

- Within a provider, rows can be ranked by **list-price-weighted tokens**
  (computed at read time from `runtime/model-pricing.ts`, labelled
  "est. cost-weighted"). Deterministic, documented, recomputable — an
  estimate wearing an estimate's clothes.
- The card column stays in tokens; the weighting is a toggle. It never crosses
  providers (locked decision 2) and never claims to be quota units: the
  provider's actual quota weighting is unpublished, and the gauge cards (§8.1)
  are the ground truth for window consumption, shown adjacently.

### 8.4 Burn + cap-out

- **Burn**: tokens/hour per provider (from `spend_events`) and window-fraction
  over time per account (from `usage_pool_samples`) — two thin strips, same
  time axis, adjacent, unmerged.
- **Cap-out ("when do we run out with nothing to rotate to")** models the
  POOL of accounts, and the design refuses to draw it beyond its data: Open
  can see the gauge of the account currently installed, plus last-known
  values for other labels (§4.4). The projection therefore renders per-label
  exhaustion times (each with its age), and the pool line — "no account
  available from T₁ to T₂" — is drawn ONLY over labels with a
  fresher-than-one-window sample, with unseen labels listed as "standing
  unknown" rather than assumed full or empty. The honest error bar is stated
  on the panel: a label not sampled since its window reset contributes
  nothing but its name. (A rotator-side fleet feed can upgrade this wholesale
  — 2026-08-09 plan §B tier 2 — but this design does not require inventing
  one, and Open ships honest without it.)

### 8.5 Waste

The three-band run chart of §7.3 plus the headline number: unrecoverable
tokens this week (and est. cost-weighted, §8.3). Beside it, the recoverable
band with "resumable if picked up".

---

## 9. Implementation phases

Each independently shippable and verifiable; no feature flags — each phase is
default-on behaviour when it lands.

- **Phase 0 — contract fixtures (small, one day).** Run one `claude` child
  with OTEL exporters at a console/file endpoint and one `codex exec --json`
  invocation; commit sanitised fixtures (no PII, `owner` / `example-project`
  placeholders) of: the CC per-request usage event (exact event name +
  attribute names, incl. whether workflow-subagent identity appears), and the
  codex stdout event stream (whether `token_count`/`rate_limits` ride it).
  **Acceptance:** fixtures in `tests/fixtures/`, plus a short findings note in
  the PR description; every §4.2 key decision cites a fixture line. This
  phase exists because a field's name is not a contract (§2.4, §5.3).
- **Phase 1 — every connected account on one screen (gauges).** Widen
  `UsagePool`; window-length columns + per-sample summarisation (§4.3); Kimi
  poller (§6.3); pool cards with account chips, age chips, stale-pace fix;
  both clients. **Acceptance:** a box with an Anthropic credential and a Kimi
  key shows two cards with 5h/7d, pace, projected cap and age — and a killed
  Kimi poller shows an ageing card, never a zero. *This is the owner's
  stated minimum view; it lands first.* (The Codex card appears in Phase 3
  when its harvest exists; until then it renders "not connected / no samples
  yet" honestly.)
- **Phase 2 — the spend ledger (store + in-process emitters).**
  `spend_events` migration; `spend_context` on `AgentSpec`; chokepoint
  emitter (real rows for OpenAI-family/codex-adapter dispatches; context
  registration for Claude dispatches); construction-site surface defaults;
  wiring test against the production composer. **Acceptance:** a live
  OpenAI-family dispatch lands one row with correct surface/project and four
  token classes; a Claude dispatch lands zero rows and one registry entry
  (asserted, not assumed).
- **Phase 3 — the two lane writers + Codex gauge.** Kimi usage capture
  (§5.3); `codex exec --json` migration of `codex-review.sh` + lane writer +
  opportunistic gauge harvest (§6.2); run id/lane threading via argv.
  **Acceptance:** one real trident run with both lanes configured produces
  exactly two lane rows (dedupe test green) and ≥1 codex gauge sample; a
  spend-write failure demonstrably does not change the review verdict.
- **Phase 4 — CC telemetry intake.** OTLP/HTTP intake surface (route slot +
  composer wiring); OTEL env on child spawn; session-context registry;
  `cc-otel` writer with dedupe; unattributed counter. **Acceptance:** a chat
  turn on a fresh install lands attributed anthropic rows whose four token
  classes match the child's own `/usage` readout for the session; killing the
  intake yields "last event Xm ago" staleness, not zeros.
- **Phase 5 — trident attribution + waste.** Fire-time run registration;
  lane-grain stamp if Phase 0 proved the attribute (else run-grain, stated);
  `artifact_state` column + checkpoint whitelist + merge-path stamp; waste
  read model + panel. **Acceptance:** a merged run, a stopped-dirty run and a
  forced-loss run classify into the three bands; the stopped-dirty run's
  tokens are NOT counted as waste.
- **Phase 6 — the full surface.** Where-it-went (project → surface → phase,
  four-class stacks), cost-weighted toggle, burn strips, cap-out panel with
  its refusals, waste panel; mobile screen. **Acceptance:** every panel
  renders from the one payload; no panel renders a number whose input data is
  absent (each has a designed empty/stale state).

---

## 10. Tests

One named test per external-API fact, plus wiring tests. Time-dependent tests
use `Date.now()`-relative timestamps (repo rule of record).

| Test | Pins |
|---|---|
| `codex-resets-at-seconds.test.ts` | a 2026 `resets_at` in SECONDS lands as a 2026 epoch-MS `*_reset_at`; a value already in ms is rejected loudly, not double-converted |
| `reset-jitter-window-membership.test.ts` | two samples whose resets differ by ±10s classify as the SAME window (time comparison); equality-based membership is the mutation the test kills |
| `codex-window-regime.test.ts` | a series straddling 300→10,080 `window_minutes` summarises each sample with its own window; pace never mixes regimes |
| `reasoning-subset-not-added.test.ts` | `reasoning_tokens ≤ output_tokens` accepted as subset; any sum in store/read model excludes it; a fixture where adding it would inflate totals by the known ratio fails the wrong implementation |
| `codex-duplicate-token-count-dedupe.test.ts` | byte-identical duplicate `token_count` events (the observed ~20% duplication) write ONE row via the `total_tokens` seq key |
| `four-token-classes-preserved.test.ts` | a spend event round-trips all four classes distinctly; the dashboard payload carries them unmerged |
| `gauge-failure-is-loud.test.ts` | kimi poller HTTP failure / missing fields ⇒ NO row written, summary ages; asserts the "no row" via count, with a control write proving the counter can move |
| `anthropic-probe-429-full-window.test.ts` (exists conceptually at probe level) | keep: header-less 429 records full windows, never zero |
| `stale-pace-as-of-measurement.test.ts` | pace for a 3h-old sample is computed as of `measured_at`; the render-clock version produces a detectably different (wrong) value |
| `spend-write-failure-never-fails-review.test.ts` | throwing spend sink leaves kimi/codex lane verdicts byte-identical |
| `otel-intake-contract.test.ts` | Phase-0 fixture in → attributed row out; unknown session id → `surface='unattributed'` + counter increment; duplicate delivery → one row |
| `session-registry-project-stability.test.ts` | dispatch re-registration follows the live project resolver; a swapped project re-registers before the next event lands |
| `artifact-state-three-way.test.ts` | cleanup outputs (`PRESERVED worktree`, `KEPT branch`, `DELETED branch` + ls-remote-proven) map to the three classes; `NULL` renders unclassified |

**Wiring tests assert against the production composer's output, never a
hand-built config literal** (the payload-I-built-myself trap): extend the
existing pattern of `gateway/__tests__/app-usage-surface.test.ts` so that the
composed gateway's dashboard handler returns three pools; the composed
substrate's completion path reaches the spend emitter
(`expect(store rows)` after driving a fake adapter through the REAL
`buildLlmCallSubstrate` construction from `open/composer.ts` composition); and
the OTLP route slot is present in the composed route table
(`gateway/http/route-slots.ts` registration, mirrored by the
`open/composer.ts:5802` pattern). A module that exists but is not composed is
a gap, not a feature — every new module here gets a composition assertion.

---

## 11. Open questions for the owner (each answerable in one word)

1. **CC token source = OTEL loopback intake** (child env gains the OTEL vars;
   gateway gains one loopback POST route). It is the only supported
   first-party per-request channel for an interactive `claude` session
   (hooks carry no usage; there is no JSON result; transcript parsing is
   banned by your directive). **Recommendation: yes.** The alternative is no
   Anthropic token data at all — gauges only.
2. **Codex gauge freshness:** opportunistic-only (samples ride real reviews;
   card shows honest age) vs. a scheduled minimal `codex exec` ping that
   spends subscription quota to keep the gauge fresh.
   **Recommendation: opportunistic-only** — spending quota to measure quota
   inverts the point, and the age chip makes staleness legible (your locked
   decision 1 makes this posture viable).
3. **Cost-weighted ranking as the quota-pressure proxy** (list-price weighting
   from `runtime/model-pricing.ts`, computed at read time, labelled estimate,
   never cross-provider): acceptable as the answer to "quota points rather
   than raw tokens"? **Recommendation: yes** — it is the only deterministic
   weighting that exists without fitting, and the true gauge sits adjacent.
4. **Waste evidence bar:** does a preserved LOCAL artifact (unpushed branch /
   dirty worktree on this box) count as *recoverable*?
   **Recommendation: yes** — your definition keys on survival ("the branch
   survived and can be picked up"), and the cleanup contract proves survival
   deterministically; requiring a pushed ref would misclassify every
   local-merge-mode run.

Determined without asking (would not change shape on any answer): spend
retention 90 days; no rollup table in v1; the Kimi calibration constant is not
shipped; the probe's ~1 token/min stays unmetered but documented on-surface.

---

## 12. `docs/SYSTEM-OVERVIEW.md` changes (when the feature ships, per phase)

- **UPDATE `## Usage meter — the active credential's two ceilings…`**: note
  the meter now sits atop a multi-pool sample series; link the dashboard
  section.
- **NEW section (after the usage-meter section): `## Usage dashboard — gauges
  + first-party spend emission`** — the two grains (§4.4), the four writers
  (§2.1), the OTLP intake and session registry, the staleness rules, and the
  "spend is emitted, never reconstructed" directive as the section's first
  paragraph (seed content: §2.1–§2.4 of this doc, compressed).
- **UPDATE `## Foundational Trident — state machine + tick + git-mode…`**:
  `artifact_state` on the run row, the extended `checkpoint.sh` whitelist,
  lane spend writers in the two cross-model lanes, and the waste
  classification.
- **UPDATE the boot-path / composer material** where route slots are
  enumerated: the OTLP intake slot and the two new pollers' arm-last
  registration (they follow the `credential-usage` monitor's pattern,
  `open/composer.ts:5253`).
