# Naming & Vocabulary Critic — Neutron Open Architecture Audit (final)

Critic: naming-vocab · Date: 2026-07-02 · Tree: /Users/ryan/repos/neutron-open @ main (d30280c)

All counts measured fresh with `git grep` / `grep` against the working tree (node_modules and
`.claude/worktrees/` excluded). Every finding-bearing claim is cited file:line and was verified in
this session; where a subsystem map was corrected, it is called out explicitly. This file
supersedes the earlier draft at the same path (merged + re-verified; two of the draft's prompt
claims were corrected — see §4.3).

---

## 0. Executive summary

1. **The declared "tenant rename" debt is mislabeled.** The tenant→owner *word* purge is complete
   and CI-enforced (leak-gate `tenant-purged`, zero-tolerance, scripts/ci/leak-gate.sh:145-155).
   `TenantsRegistry` / `resolveTenantSlug` exist nowhere in code (1 comment each in leak-gate.sh:147-148).
   The real remaining debt is the **substitute vocabulary**: `project_slug` (6,494 word-bounded
   refs / 719 files) means *the owner/instance slug, not a project*; `internal_handle` (855 refs /
   114 files) is its frozen twin; and one value flows under **four different names at a single
   call site** (gateway/cores/mount-open-cores.ts:183 `internal_handle:`, :215 `owner_slug:`,
   :250/:260/:263 `project_slug:`, :264 `slug_suffix:` — all `input.project_slug`).
2. **Two live `tenant` tokens survive the "zero-tolerance" gate**, each via a different regex
   blind spot: (a) `tasks/history-import-seeder.ts:63` hashes `` `tenant:${input.project_slug}\x00` ``
   with a **raw NUL byte** (verified at byte offset 2097) — grep classifies the file as binary and
   the gate's `-I` flag silently skips it; the literal is a task-id hash seed, so "fixing" the word
   changes every history-import task id (idempotent re-seed breaks). (b)
   `cores/free/research/migrations/0001_research_claims.sql:38` names a **live sidecar-schema
   index** `research_tasks_tenant_project_status_idx` — the boundary class `[^a-z0-9_]` treats the
   preceding `_` as a word char, and the `migrations/*` allowlist glob does not cover
   `cores/free/research/migrations/`.
3. **Verified kill-list:** ~20 truly dead modules/files (zero non-test importers, re-verified),
   plus a quarantine list of Managed-ABI lookalikes that must NOT be deleted without a
   private-repo audit.
4. **The audit brief's "prompts/*.md are legacy Nova" is wrong three different ways** (§4):
   atlas/sentinel/reminder-patterns are LIVE runtime inputs; forge/argus are ZOMBIES (loaded, but
   only into dead render paths — the live Forge/Argus contract is a *fourth* copy inlined in
   trident/inner-workflow.mjs:281,330); scribe/topic-agent-base/reminder-agent-base are DEAD
   (registered in KNOWN_PROMPTS, never loaded). And the live reminder-patterns.md instructs the
   production fire-time agent to run `tg-post.sh`/`weather.sh` — Vajra scripts absent from Open.
5. Package naming is internally inconsistent in ways cheap to fix pre-release and expensive after:
   one `@neutron/` package among 40 `@neutronai/` (chat-core), `core-sdk` vs `cores-sdk` one letter
   apart, `email-managed-core` carrying Managed vocabulary as a bundled Open core name (and
   `packageNameToSlug` couples any rename to installed data), 4 floating non-workspace source dirs,
   and the Managed-era `realmode-composer` name on the shared 13k-LOC wiring library.

---

## 1. Charter (a): the "tenant" rename — real blast radius and staged plan

### 1.1 Status correction (measured)

| Term | word-bounded refs | files |
|---|---|---|
| `TenantsRegistry` / `resolveTenantSlug` | 0 in code (leak-gate comments only) | — |
| `tenant` (any case, in code) | 2 live escapes (§2) + allowlisted fixtures/migration comments | — |
| `internal_handle` | **855** | **114** (gateway 365, auth 177, onboarding 152, cores ~65, tests 31, runtime 25, open 24, landing 14, migrations 3) |
| `project_slug` | **6,494** | **719** (incl. 38 migration .sql files ≈ 25 live tables + indexes) |
| `instance_slug` | 87 | 26 |
| `url_slug` | 212 | 55 |
| `owner_slug` (target, already seeded) | 117 | 20 |
| `owner_handle` (proposed) | 0 | 0 — no collisions |

### 1.2 The core defect: "project" means two unrelated things

- `project_slug` = the OWNER/INSTANCE slug: `gateway/index.ts:184` `const project_slug = resolveOwnerSlug()`;
  the `GraphComposer` seam is typed `(input: { db: ProjectDb; project_slug: string })`
  (gateway/boot-helpers.ts:362); `ProjectDb` is the per-*instance* database.
- `project_id` = an actual user project (`Projects/<id>/`, tasks rows, docs, sidecars).
- Both coexist as sibling columns: `tasks/store.ts` Task rows carry `project_slug` (instance) AND
  `project_id` (project, `''` = none); same shape in reminders, work_board_items, research_tasks
  (the §2 index spans `(project_slug, project_id, status)`).
- `internal_handle` = the frozen provisioning-time identity key, documented with its motivating
  production defect at auth/secrets-store.ts:10-27 ("callers MUST pass the FROZEN internal_handle
  ... the on-disk SQL column is still literally named project_slug"). In Open it is definitionally
  the boot slug: open/composer.ts:405 `const internal_handle = project_slug` ("Single-owner: the
  frozen instance handle IS the boot slug.").
- Wire-visible: healthz returns `{status:'ok', project_slug, uptime_ms}` (gateway/index.ts:474-486);
  start-tokens carry BOTH `instance_slug` and `project_slug` claims with the same value
  (runtime/start-token-types.ts:54-69, documented compat mirror); session cookie serializes
  `<project_slug>.<expires>.<hmac>` (landing/session-cookie.ts:9 — a *value*, safe to rename in TS).

### 1.3 Frozen names (must NOT be renamed) — verified

1. **SQL column names** (`secrets.project_slug` auth/secrets-store.ts:200, `api_keys.project_slug`,
   `tasks.project_slug`, `cores_oauth_pending.project_slug` "frozen internal_handle"
   migrations/0035:17, + ~25 tables). Immutable migration history + byte-pinned schema snapshot
   (`migrations/expected-schema.txt`, e.g. :216-218). The precedent is set by secrets-store:
   column stays, TS API surface uses the honest name.
2. **`internal_handle` is NOT a wire key** — zero `'internal_handle'` string-literal keys in
   non-test code (verified). Purely a TS identifier → mechanically renameable in-repo.
3. **BUT it IS an undeclared cross-repo ABI property name.** The private Managed composer loads
   via `NEUTRON_GRAPH_COMPOSER_MODULE` (gateway/index.ts:540) and constructs builders whose
   option-bag property names include `internal_handle`:
   gateway/realmode-composer/build-landing-stack.ts:122,1314-1315,1420;
   gateway/realmode-composer/resolve-llm-credentials.ts:83,99,238; runtime/platform-adapter.ts:95,144,166;
   `BootOwnerRow.internal_handle` / `getByInternalHandle` (gateway/boot-helpers.ts:162,176).
   All-optional bags → a rename breaks Managed silently at runtime.
4. **The `tenant:` hash seed** (§2) — changing the literal changes every `hi_<sha256>` task id.
5. Migration 0074's `tenant_provisioned` string (allowlisted, immutable) and connect's retired
   `workspace` tokens (leak-gate.sh:156-170 documents the exemptions).
6. Wire field names: healthz `project_slug`, start-token `instance_slug`/`project_slug` claims
   (minted cross-repo), jwt claim `slug` (jwt-validator/claims.ts:26), `NEUTRON_INSTANCE_SLUG`
   env, `.url_slug` filename (resolver precedence gateway/index.ts:147-157).

### 1.4 Target vocabulary

Already seeded in-tree (`resolveOwnerSlug`, `ownerSlugMismatch`, `owner_slug` in connect handlers,
`OWNER_HOME`; leak-gate.sh:150 describes the purge as "collapsed to the single-owner `owner*`
vocabulary"). Complete it — do NOT introduce a third noun:

| Current | Target | Notes |
|---|---|---|
| `internal_handle` | `owner_handle` | 0 collisions today; keeps the frozen-vs-mutable distinction the 2026-05-12 incident requires |
| `project_slug` (instance sense, TS) | `owner_slug` | SQL columns keep `project_slug` + secrets-store-style header comment |
| `project_id` | unchanged | the real project |
| `ProjectDb` | `OwnerDb` (alias re-export first) | 374 files import persistence relatively |
| `GraphComposer` `{db, project_slug}` | `{db, owner_slug}` | cross-repo ABI — dual-accept window |
| `url_slug` | unchanged | correct (mutable public slug) |
| `instance_slug` (TS identifiers) | fold into `owner_slug` | keep only env var + wire-claim spellings |

### 1.5 Staged mechanical plan (each stage a CI-green no-op PR)

- **Stage 0 (S):** identity glossary in persistence/AGENTS.md + branded
  `type OwnerHandle = string & {__brand}` adopted at the SecretsStore/ApiKeyStore boundary
  (federation-auth mapper independently proposed this) — compile-time guard against
  url_slug-where-handle-expected.
- **Stage 1 (M):** in-repo, non-ABI `internal_handle` → `owner_handle` sweep (onboarding 152,
  cores ~65, open 24, landing 14, gateway/http + gateway/cores internals). Zero persisted keys
  (§1.3.2), compiler-checked.
- **Stage 2 (M):** ABI surfaces with a compat window: realmode-composer builders, platform-adapter,
  boot-helpers accept `{ owner_handle ?? internal_handle }` for one release; coordinate the private
  composer; snapshot-test export names (ride the gateway-services ABI-barrel proposal).
- **Stage 3 (L):** `project_slug` → `owner_slug` for instance-sense TS identifiers, package by
  package (auth, tasks, reminders, trident, gateway, cores/free, open), SQL strings untouched
  (`WHERE project_slug = ?` stays, `/* owner_handle */` comment at prepared statements). The
  6,494-ref bulk; sed-shaped per package but needs review where `project_slug` sits next to
  `project_id` in one row type.
- **Stage 4 (S):** docs/AGENTS.md sweep + new leak-gate rule banning NEW `internal_handle`
  introductions; fix the two §2 escapes.
- **Stage 5 (XL, recommend NOT doing pre-1.0):** SQL column rebuild migrations + expected-schema
  regeneration. The "column frozen, TS honest" convention makes this optional forever.
- **Ordering:** run AFTER the dead-code deletions (§3) — chat-bridge slug-picker (~490 LOC),
  engine-slug.ts (1,086 LOC), and the per-chunk import pipeline carry heavy handle/slug traffic;
  deleting first shrinks stages 1–3 materially.

---

## 2. Two live `tenant` escapes through the zero-tolerance gate (verified end-to-end)

1. **NUL-byte binary-skip bypass.** `tasks/history-import-seeder.ts:63-64`:
   `` h.update(`tenant:${input.project_slug}\x00`) `` — the template literal contains a **literal
   0x00 byte** (verified: `b'\x00' in data` → True at offset 2097; the bytes read
   `` `tenant:${input.project_slug}<NUL>` ``). grep's binary heuristic + the `-I` flag in the
   gate's `run_grep` (scripts/ci/leak-gate.sh:107-109) silently skip the file, so `tenant-purged`
   never sees the one remaining live `tenant` token in code. Not allowlisted. The string seeds
   `historyImportTaskHash` → `hi_<sha256[0:24]>` deterministic task IDs — the idempotency guard
   for re-seeding an ImportResult. A well-meaning scrub (`tenant:` → `owner:`) changes every id →
   re-seeding a previously-seeded import duplicates task rows.
   **Fix (S):** replace the raw NUL with the two-character escape `\x00` (byte-identical hash
   input; file becomes text; gate sees it), then explicitly LOCK the `tenant:` literal as a hash
   seed with a comment + allowlist entry (it is data, not vocabulary). Add a gate tripwire failing
   any tracked source file grep classifies as binary — this closes the bypass *class* for every
   grep-based CI gate in the repo.
2. **Underscore-boundary + allowlist-scope bypass.** `cores/free/research/migrations/0001_research_claims.sql:38`
   `CREATE INDEX IF NOT EXISTS research_tasks_tenant_project_status_idx` — a live schema object
   applied to every research sidecar. `(^|[^a-z0-9_])tenant` cannot match `s_tenant`, and the
   `migrations/*` allowlist globs cover only the top-level tree. Also
   `migrations/0055_connected_members.sql:19` names `stampOriginTenant(...)` in a comment
   (allowlisted; but it names a retired symbol — the live one is `stampOriginInstance` — and will
   mislead grep-driven refactors). **Fix (S):** rename the index in a new sidecar migration
   (index names are not queried; perf-neutral; existing sidecars get a drop/recreate), and widen
   the gate regex for new code.

---

## 3. Charter (b): verified kill-list

Method: `git grep -l <token>` excluding the defining file, `__tests__/`, `*.test.*`; comment-only
hits inspected by hand. "Zero importers" below means zero non-test, non-comment references.

### 3.1 Delete now (dead in this repo, verified this session)

| # | Item | Evidence |
|---|---|---|
| 1 | `landing/connect-relay.ts` (351 LOC) | zero references of any kind repo-wide |
| 2 | `landing/connect-accept.ts` (239) + `connect-accept.html` + `landing/connect-disclosure.ts` (163) | only cross-refs are comments + each other; nothing serves the html. Coordinate with Connect quarantine |
| 3 | `landing/start-token-topic-id.ts` (124) | consumer `landing/chat.ts` deleted 06-26 |
| 4 | `landing/markdown.ts` renderer | only `escapeHtml` still imported (mobile-install-config.ts:18) — split it out, delete the rest |
| 5 | `gateway/http/chat-bridge.ts:2027-2511` `buildSlugPickerEngineHook` + `renderSlugRenameConfirmationForWeb` (~490 LOC) | grep → self-file only; Managed rename machinery stranded by the carve |
| 6 | `gateway/connect/syndication-relay.ts`, `open-instance-source-resolver.ts` | zero non-test importers |
| 7 | `runtime/adapters/claude-code/api-key-helper.ts` | header self-declares deletable since 2026-06-24; own test only |
| 8 | Per-chunk import pipeline: `history-import/job-runner.ts` (2,104) + pass1/pass2 + `substrate-callers.ts` + `entity-populator.ts` + `gateway/realmode-composer/build-import-job-runner.ts` (710) + ~10k test lines | open/composer.ts:1288 hard-codes `importUseSynthesis: true` at the sole buildLandingStack call site; extract shared leaves first (types.ts hub, zip-reader, `extractJsonObject` — synthesis-session.ts:30 imports it from the dead module) |
| 9 | `prompts/onboarding/import-analyzer-pass{1,2}.md` | loaded ONLY by dead item 8 (build-import-job-runner.ts:361) |
| 10 | `prompts/scribe.md`, `prompts/topic-agent-base.md`, `prompts/reminder-agent-base.md` | zero production loaders (only production `loadPrompt` calls repo-wide are trident/prompts.ts:89,275; only prompts-dir `readFileSync` is boot-helpers.ts:727-728 reading reminder-patterns.md). Content was inlined into scribe/extract.ts and reminders/prompt.ts ports. Must shrink `KNOWN_PROMPTS` (prompts/template.ts:140-147) + the KNOWN_PROMPTS≡disk parity test in the same PR — the parity test currently *forces* the dead files to stay |
| 11 | `onboarding/interview/engine.ts:1721` `acceptChoice` (~270 LOC + types) | no external production caller; chat-bridge routes taps through `advance` |
| 12 | `cores/free/reminders/manifest.json` (310 ln) | zero TS refs; already diverged from the authoritative package.json block |
| 13 | `cores/free/notes/` residue | untracked `node_modules/` ghost of the PR #161 deletion (verified `ls`) |
| 14 | `tests/e2e-browser/__pycache__/*.pyc` | git-tracked Python bytecode |
| 15 | `docs/AS-BUILT.md` (1,469 ln) | abandoned third changelog (archive → delete as part of the changelog merge) |
| 16 | `app/app/projects/[id]/cores/dtc-analytics.tsx` (420) + `'dtc_analytics'` key (gateway/cores/install-bundled.ts:1033) | fronts a paid Core absent from the repo |
| 17 | `createAppLauncherSurface` + `project-launcher-store.ts` (~700 LOC) | grep → surface file, compose slot types, 3 tests; no composer populates `app_launcher_surface` |
| 18 | `core-sdk/validator.ts` `validateNeutronManifest` + `manifest.schema.json` + `_schema-runner` (~1,400 LOC w/ tests) | grep → barrel, own test, comment-only mentions in cores/sdk/manifest.ts:175,298; prod validates via Zod `parseManifest`. NB: core-sdk/package.json:5 is `"private": true` — the map's "published on npm" claim is wrong, so there is no external-consumer risk |
| 19 | `cron/timer-emit.ts` `emitTimerUnits`; `persistence/retry.ts:40` `CHECKPOINT_EVERY_N_WRITES` | barrel + own test only, each |
| 20 | Barrel-export zombies pending the ChannelRouter decision: `runLongPoll` (channels/index.ts:164), forum-topics helpers (:165-173), `tool-loop-detection.ts` (runtime barrel + one comment) | verified barrel/test-only |

Corroborated from other mappers (spot-checked, not fully re-derived): trident v1 stack
(`session.ts` 333 LOC, `substrate-dispatch.ts`, render/parse half of `prompts.ts` — I verified
`renderForgePrompt` consumers = trident/index.ts barrel + the production-dead code-gen core only),
the code-gen core retired pipeline (~2,900 src LOC; `buildCodegenWiring`'s only gateway presence is
the skeleton note at boot-helpers.ts:1128-1152), `onboarding/interview/engine-slug.ts` (1,086 LOC,
open-mode-unreachable), and the production-inert `watchdog/` package (no-op notifier
open/composer.ts:3436, always-fresh heartbeat :3440, writer-less process registry).

### 3.2 Quarantine — looks dead in-repo, live (or plausibly live) cross-repo. Do NOT delete.

- `gateway/boot-helpers.ts` 8 zero-in-repo-consumer exports (:63,420,1259,1350,1358,1389,1461,1642)
  — reachable by the private Managed composer via the env seam. Action: explicit ABI barrel +
  export-name snapshot test, then private-repo audit.
- `auth/max-oauth-multi-sub.ts` (documented intentional Managed orphan);
  `cores/free/email/src/substrate-llm.ts` `buildSubstrateEmailLlm`; `composition.http_handler`
  override path (gateway/index.ts:230-232).
- `runtime/adapters/claude-code/router-thinking-budget.ts` — only refs are comments
  (build-llm-call-substrate.ts:333-335) + a test that hand-injects `extra_env`. Either a
  silently-lost router-hang fix (restore + wiring test) or delete module + seam together. A comment
  claiming a protection that doesn't exist is worse than none.
- Dormant Connect set (designed-dormant, quarantine don't delete): `shared-projects-resolver.ts`
  (test-only construction), `app-connect-auth.ts` surface (constructed only in a test),
  `landing/auth-gate.ts` `applyAuthGate` (no production setter of `composition.auth_gate`).
  Prerequisite: move the LIVE `connect/agent-engagement.ts` (chat policy — chat-bridge, projects
  store, agent-settings core) out of `connect/` first.

### 3.3 Stale-flag / carve-residue confirmations

- `NEUTRON_WEB_CHAT_CLIENT` / `web-chat-flag.ts`: gone from code; survives in a tombstone comment
  (landing/server.ts:1159), **two false-as-live claims in docs/SYSTEM-OVERVIEW.md:369,3430**, and
  `landing/chat-react/tsconfig.json:2` (comment names the deleted file).
- `landing/package.json:4` `"main": "./chat.ts"` → deleted file; root `tsconfig.json:42` includes
  deleted `landing/chat.ts`.
- `scripts/lib/discover-test-files.sh:5-6` names `scripts/install/lib/flake-tolerant-test-gate.sh`;
  **`scripts/install/lib/` does not exist** (deploy gate stayed in Managed).
- `dependency-cruiser@17.4.3` devDep: no config, no invocation — dead UNLESS the test-tooling
  critic's layering-rules proposal is adopted (endorsed; then it's the opposite of dead).
- Removed-flag comment archaeology: `NEUTRON_PERSISTENT_REPL`, `NEUTRON_TABS_REGISTRY` survive
  only as "no longer gates this" comments (compose.ts:671, app-tabs-surface.ts:20).

---

## 4. Prompts: the brief is wrong three ways; the live contract is quadruplicated

### 4.1 Per-file truth table (all loaders grep-verified)

| File | Production consumer | Verdict |
|---|---|---|
| `atlas.md`, `sentinel.md` | trident/agent-prompts.ts → agent-dispatch/persona.ts:17 (production system-prompt path) | **LIVE** |
| `reminder-patterns.md` | gateway/boot-helpers.ts:727-728 readFileSync → reminders-core smart-wrap (`loadPattern` at mount-open-cores.ts) | **LIVE** |
| `forge.md`, `argus.md` | trident/prompts.ts:89,275 `loadPrompt` → `renderForgePrompt`/`renderArgusPrompt`, whose only consumers are the dead v1 `trident/session.ts` and the production-dead code-gen core (runtime-runner.ts:48-55) | **ZOMBIE** |
| `scribe.md`, `topic-agent-base.md`, `reminder-agent-base.md` | none (KNOWN_PROMPTS entries only; content inlined into scribe/extract.ts:10 and reminders/prompt.ts:4-5 ports) | **DEAD** |

### 4.2 The four-copy Forge contract

`trident/prompts.ts:80-86` claims a "single-source guarantee" for the disk-loaded forge.md — but
the LIVE v2 exec-model contract is a separate inline copy in `trident/inner-workflow.mjs:281,330`
("Forge build contract (from prompts/forge.md)" — the comment admits the copy; the .mjs cannot
import TS). Plus `FORGE_FALLBACK` inline in prompts.ts:63-77 and the fork in
`cores/free/code-gen/src/prompts/forge-system.ts:24`. **Editing prompts/forge.md today does not
change production build behavior.** This same fork carries the AS-BUILT filename collision
(trident/prompts.ts:113 root `AS-BUILT.md` + nonexistent root `SPEC.md`; forge-system.ts:7
`AS_BUILT.md`) — the mechanism that minted three changelogs. Sequencing (concurring with
vision-docs, adding one step): single-source the contract per role FIRST (inner-workflow.mjs reads
the .md at fire time, or the .md is regenerated from the .mjs), then fix writer filenames, then
consolidate changelogs + move allowlist entries in the same commit.

### 4.3 Live prompts and operator errors point at ghost machinery

- `prompts/reminder-patterns.md:50,109,209,217` instructs the fire-time agent:
  `bash {{OWNER_HOME}}/scripts/tg-post.sh ...`, weather via `scripts/weather.sh --for-reminder` —
  **neither script exists in Open** (verified). `cores/free/reminders/src/smart-wrap.ts:71` bakes
  the weather.sh reference into stored reminder instruction text. Reminders still deliver (the
  dispatcher's literal fallback is load-bearing) but the production agent is systematically
  instructed to use Vajra machinery Open doesn't ship.
- `gateway/boot-helpers.ts:205` operator-facing log directs a self-hoster to
  `scripts/install/regenerate-owner-slug-dropin.sh` — not in the repo. A tree-wide scan found ~18
  references to nonexistent `scripts/**` paths (incl. `scripts/sprint-c/*` carve machinery from
  runtime/__tests__/stub-platform.ts:9-10, `scripts/restart-gateway.sh`,
  `scripts/e2e/synthetic-test-instance.sh` in runtime/slug-grammar.ts).
- Draft corrections: the earlier draft of this report listed scribe.md as live via
  scribe/extract.ts and treated reminder-agent-base.md's ghost refs as reaching the runtime —
  both wrong: neither file has any loader (extract.ts:10 is a provenance comment; the "Sam" +
  tg-post.sh text in reminder-agent-base.md is dead weight, not live instruction). The live
  ghost-instruction path is reminder-patterns.md + smart-wrap.ts only.

### 4.4 Fail-soft hazard for the refactor

Prompt loads are silent-fail-soft: `loadForgeTemplate` (trident/prompts.ts:88-95) and
`loadAgentSystemPrompt` catch everything and degrade to terse inline contracts. Moving/renaming
`prompts/` breaks nothing loudly — dispatched agents silently lose their detailed personas. The
`KNOWN_PROMPTS` ≡ disk parity test conversely *forces* dead files to stay until both are changed
together.

---

## 5. Charter (b)+(c): structural naming defects

### 5.1 `realmode-composer` and the open/ vs gateway/ split

- `gateway/realmode-composer/` (33 files, ~12,971 LOC) is named for a Managed-era Sprint-19
  distinction; the *private* `provisioning/realmode-composer.ts` is its namesake
  (gateway/index.ts:11,505-509). ~97 files reference the name; ~20 importers live outside gateway/
  (onboarding engine, landing/server.ts, connect/member-join.ts, open/composer.ts). The vocabulary
  leaked into the composition contract: `CompositionInput.realmode_cleanups`
  (gateway/index.ts:192-210,446-454; open/composer.ts:778,3578) — really `shutdown_cleanups`.
  Rename to `gateway/wiring/` + field rename with a one-release deprecated alias (ABI: the private
  composer imports these paths through the env seam — keep path re-export shims one release).
- **"open" is overloaded four ways:** the product, the deployment-mode enum `'open'`
  (gateway/deployment-mode.ts), the non-workspace `open/` dir (composition root), and "open
  instance" in the federation sense (`gateway/connect/open-instance-source-resolver.ts`). The dir
  participates in the repo's directory-level cycle (gateway/cores/mount-open-cores.ts:48 →
  open/agent-profile-backend.ts while open/composer.ts:110 → mount-open-cores).
- **gateway/ subdirs collide with top-level workspaces:** gateway/cores vs cores/, gateway/tasks
  vs tasks/, gateway/connect vs connect/ (verified; the gateway-services map's "4 collisions"
  overcounts — gateway/push has no top-level twin). Combined with `@neutronai/tasks` vs
  `@neutronai/tasks-core`, THREE things are called "tasks".
- Post-refactor vocabulary rule: `boot/` (shell), `wiring/` (shared factories), `open/composer.ts`
  (mode composer); reserve "composition" for the CompositionInput data contract.
- `landing/` names a package whose landing page is dormant while its real contents are the
  web-chat server, the auth library, and the de-facto chat wire-protocol home (web-client critic's
  P1) — rename what remains after that extraction (`web-chat/`).

### 5.2 Package-name inconsistencies

Census: 40 workspace packages, 30 top-level `@neutronai/` + 9 `@neutronai/*` cores + **one
`@neutron/`** — `chat-core` (chat-core/package.json:2), imported as `@neutronai/chat-core` by 43
files + 3 manifests (app, landing, message-search) + app/metro.config.js. Rename is mechanical
but must include the metro monorepo config and the raw-TS import path.

- **`@neutronai/core-sdk` (core-sdk/) vs `@neutronai/cores-sdk` (cores/sdk/)** — two SDKs one
  letter apart, each with a manifest validator, only the Zod one production-live. Whatever the
  merge direction (cores-platform critic owns it), the *name pair* must not survive.
- **Dir ↔ package mismatches + Managed leak:** cores/free/code-gen → `codegen-core`;
  cores/free/email → **`email-managed-core`** (Managed vocabulary in a bundled Open core name);
  `@neutronai/agent-settings` is the only core missing `-core`. **Trap:** `packageNameToSlug`
  output keys core_installations rows, sidecar filenames, table prefixes, BACKEND_KEY_BY_SLUG
  (cores/runtime/loader.ts:61-81) — core renames orphan installed data without a slug-alias
  migration. Pre-first-release or never.
- **Floating non-workspace dirs:** `open/`, `tabs/`, `work-board/`, `project-credentials/` have no
  package.json and are absent from root workspaces (verified) yet imported by 17+ files across
  workspaces — invisible to all dependency tooling.
- **Manifests are decorative:** persistence imported relatively from ~374 external files,
  migrations ~300, channels ~215, runtime ~152. Consequence: renaming *directories* is a 300-file
  diff; renaming *package names* is nearly free. Fix boundaries (declare deps + lint cross-package
  relative imports) BEFORE any directory moves.

### 5.3 Wire-level vocabulary forks (persisted-data traps)

- `ChannelKind 'app_socket'` (channels/types.ts:12, underscore) vs `ChannelKindForButton
  'app-socket'` (channels/button-primitive.ts:57, hyphen) — same channel, two spellings, **both
  persisted in button_prompts rows** (web resolutions stamped `'app-socket'`/`'webhook'` sentinel,
  chat-bridge.ts:1653). Unification = data migration + dual-read window, not a type edit. `'cli'`
  and `'webhook'` kinds have no adapters (dead enum members pending the ChannelRouter decision).
- `topic_id` = topics-table UUID in `Topic` but channel-native string in ButtonStore/engine —
  type-level split (`topic_uuid` vs `channel_topic_id`) is safe; persisted-key renames are not.

### 5.4 One-concept-per-word violations in the CC adapter (cosmetic, batchable)

`wedge-detector.ts` (liveness) vs `wedged-prompt-detector.ts` (stuck TUI) vs
`channel-wedge-respawn.ts` (MCP never bound); `disk-recovery.ts` vs `session-disk-recovery.ts`;
model-generation-bound dirs `gpt-5-5-api/`, `gpt-5-5-codex-cli/` → `openai-responses/`, `codex-cli/`.

### 5.5 Era/codename residue census (word-bounded, code files)

| Term | refs | Notes |
|---|---|---|
| `managed` | **648 non-test** | incl. behavior-shaping defaults in an Open-only repo: onboarding engine.ts:573 `deploymentMode ?? 'managed'`; phase.ts:146-158 `isLegalTransition` defaults to the managed table. Load-bearing (pinned test matrices) — flag, don't flip, during the refactor |
| Nova | ~106-132 | pre-carve monorepo codename (provenance comments) |
| Vajra | ~25-92 (test-heavy) | parity-port provenance; vajra-fixes.test.ts is a live anchor — keep in test anchors, add GLOSSARY.md |
| Topline | 88 (16 non-test) | private customer codename for the absent paid core, incl. core-sdk/types.ts:42,83 (a contract file) |
| Hermes / OpenClaw | 21 / 11 | earlier lift sources |

**Stale AGENTS.md files that actively lie to agents:** prompts/AGENTS.md ("P0 ships only the empty
dir" — 8 live prompt files), gateway/AGENTS.md ("P0 ships only the empty-but-correct skeleton" —
71k LOC), cores/AGENTS.md (lists removed Notes + never-built Coordinator). In a repo whose build
agents read these files for orientation, stale AGENTS.md is bad input to the machine that writes
the code — treat the sweep as part of the vocabulary pass, not doc polish.

---

## 6. Load-bearing subtleties a rename/deletion pass could silently break

1. `tenant:` + raw-NUL hash seed → task-id determinism (§2.1). Fix the byte, freeze the word.
2. SecretsStore identity: frozen handle NOT url_slug; SQL column keeps the old name by design
   (auth/secrets-store.ts:10-27). Branded type is the guard.
3. Cross-repo ABI property names (`internal_handle` option bags; realmode-composer/boot-helpers
   export names + paths) reachable only via NEUTRON_GRAPH_COMPOSER_MODULE — invisible to in-repo grep.
4. `packageNameToSlug` couples core package renames to installed data.
5. ChannelKind strings are persisted row values.
6. docs/AS_BUILT.md leak-gate exemptions keyed to LITERAL paths — changelog consolidation must move
   allowlist entries in the same commit.
7. prompts/*.md loads are silent-fail-soft; KNOWN_PROMPTS≡disk parity test pins dead files in place.
8. Migration numbers + 0074's `tenant_provisioned` string immutable; never renumber.
9. `.url_slug` file > NEUTRON_INSTANCE_SLUG resolver precedence (gateway/index.ts:147-157).
10. Healthz `project_slug` field + start-token dual claims + jwt `slug` are wire contracts.
11. `KNOWN_PROMPTS` throws on unknown names — file + registry entry must change together.
12. `deploymentMode`/`isLegalTransition` 'managed' defaults are pinned by test matrices — rename
    the vocabulary, do not change the default values.

---

## 7. Findings index (mirrors StructuredOutput)

1. P1 — Identity vocabulary: tenant purge done; real debt is project_slug-as-owner + internal_handle; staged plan (XL).
2. P1 — Two live `tenant` escapes through the zero-tolerance gate (NUL-byte binary skip; underscore/allowlist-scope) (S).
3. P1 — Verified dead-code kill-list, ~20 items (L).
4. P1 — Quadruplicated Forge/Argus contract; per-file prompt truth table corrects the brief; ghost-machinery instructions in a LIVE production prompt (M).
5. P1 — Managed-ABI quarantine prerequisite (ABI barrel + snapshot) gating all deletions (S).
6. P2 — realmode-composer naming + realmode_cleanups field (M).
7. P2 — open/gateway overloads, dir collisions, three composition-root nouns (M).
8. P2 — Package scope fork + core naming drift + slug coupling + floating dirs (M).
9. P2 — Dormant-Connect naming quarantine; agent-engagement extraction first (M).
10. P2 — ChannelKind/topic_id persisted-value forks (M).
11. P3 — Stale flags/configs referencing deleted files; ghost script paths; dependency-cruiser (S).
12. P3 — Era vocabulary rot (managed/Nova/Vajra/Topline) + lying AGENTS.md + CC-adapter word collisions (M).
