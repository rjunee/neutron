# Managed↔Open coupling audit — DEFINITIVE catalog (2026-07-02)

Scope audited: `/Users/ryan/repos/neutron-managed` (`src/` + `tests/` + `scripts/`, HEAD `20c850d`,
vendor submodule pinned `f04b3f6` — an ancestor of local neutron-open HEAD, verified via
`git merge-base --is-ancestor`) and `/Users/ryan/repos/neutron-managed-contract` (same GitHub
remote `Quintessential-Ventures/neutron-managed`, OLDER checkout at `9252e63` "feat(ops):
Open→Managed compatibility gate", vendor pinned `23c4351`).

Method: (1) read the vendoring mechanism (git submodule at `vendor/neutron`, tsconfig excludes
vendor — `neutron-managed/tsconfig.json:24`); (2) grepped every `import`/`require` in managed
src+tests+scripts (only relative + `bun:`/`node:` imports exist besides the two vendor imports
below — verified by full non-relative import grep); (3) grepped every named symbol; (4) read the
contract gate + tests in both repos in full.

Excluded from the catalog: `neutron-managed/.claude/worktrees/**` (a stale worktree with its own
vendor copy — not part of the mainline tree).

---

## 1. How the vendoring works (VERIFIED)

- `vendor/neutron` is a **git submodule** of neutron-open (`git submodule status` →
  `f04b3f68… vendor/neutron (remotes/origin/HEAD)`), consumed **UNMODIFIED, re-pin only**
  (`src/ops/open-contract.ts:4`, `src/claim/url-suggester.ts:7`).
- Managed's TypeScript build **excludes vendor** (`tsconfig.json:24` `"exclude": [... "vendor"]`)
  and includes only `src/**` + `tests/**` — so vendor code is never typechecked by Managed except
  transitively through the two direct imports.
- **Managed never imports Open's runtime into its own process** (`src/provision/launcher.ts:4-9`).
  Each tenant is a separate OS process: `bun run <vendor>/open/server.ts` with per-tenant env —
  dev subprocess (`launcher.ts:113-133`) or a systemd unit `neutron-tenant@<slug>.service`
  (`launcher.ts:193-238`), `WorkingDirectory=<vendorNeutronDir>`, running as an isolated
  `neutron-<slug>` POSIX user (`launcher.ts:219-227`).
- Vendor dir location comes from `NEUTRON_VENDOR_NEUTRON_DIR` (`src/config.ts:65-67`; set by
  `scripts/provision-hetzner.sh:521`). Open's own deps are installed separately
  (`bun install --cwd <vendor>` — `provision-hetzner.sh:296`).
- Deploys are "vendor bump" commits gated by `bumpOpenSubmodule`/`deployOpenBump`
  (`src/ops/deploy.ts`, gate in `src/ops/open-contract.ts:212-312`): red contract or red Managed
  test suite ⇒ checkout reverted, fleet NOT rolled (`tests/open-contract.test.ts:159-239`).

### The NEUTRON_GRAPH_COMPOSER_MODULE seam — there is NO Managed composer module (VERIFIED)

- Open side: `open/server.ts:47-50` (`startOpenServer`) calls `loadGraphComposerFromEnv` and
  **defers** to an injected composer if `NEUTRON_GRAPH_COMPOSER_MODULE` is set; otherwise it boots
  `buildOpenGraphComposer` from `open/composer.ts` (`open/server.ts:20-24, 32`). The loader is
  `gateway/index.ts:541-563` (fail-fast if `NEUTRON_AUTH_JWKS_URL` is set without a module,
  `gateway/index.ts:544-557`).
- The long comment at `gateway/index.ts:500-539` describes the **OLD monorepo** Managed composer
  (`provisioning/realmode-composer.ts`, moved out at the C2 OSS split). That module exists in
  **neither** repo today (`ls neutron-open/provisioning` → No such file or directory; grep
  `realmode-composer` in managed src/tests/scripts → one comment hit, `open-contract.ts:35`).
  Note: neutron-open's `gateway/realmode-composer/` directory is Open-internal builders, NOT the
  Managed composer.
- Managed side: **the env is never set.** `buildTenantEnv` (`launcher.ts:72-102`) does not include
  it, and `open-contract.ts:34-39` says explicitly: *"forward seam, intentionally NOT asserted:
  … Managed does not yet thread that env (tenants currently boot the single-owner Open shape)."*
- CONCLUSION (verified): tenants boot the **plain single-owner Open composer**; the composer seam
  is a declared forward seam with zero current consumers on the Managed side.

---

## 2. ALL compile-time imports from Managed into vendor/neutron (VERIFIED — exactly 2)

Grep basis: every `from '…'` string containing `vendor/neutron` across src/tests/scripts (38 hits
total; 36 are comments/shell paths), cross-checked by a full non-relative-import grep.

| # | Managed file | Open-side file | Symbol |
|---|---|---|---|
| 1 | `src/claim/url-suggester.ts:22` | `onboarding/interview/agent-name-suggester.ts` (export at neutron-open `:138`) | `buildDiverseAgentNameFallback(seed) → { picks: {name, tagline}[] }` — deterministic FNV-1a name pool; Managed slugifies the picks for the end-of-onboarding personal-URL claim page. Managed deliberately drives **only the deterministic LLM-less path** (`url-suggester.ts:14-19`). Pinned as contract surface `reuse:agent-name-suggester` (`open-contract.ts:189-196`). |
| 2 | `tests/launcher-substrate.test.ts:10` | `open/ambient-claude-auth.ts` (export at neutron-open `:95`) | `ambientClaudeAuthDisabled` — TEST-ONLY cross-validation that `NEUTRON_DISABLE_AMBIENT_CLAUDE_AUTH: '1'` is a value Open actually accepts (comment at test lines 8-9). |

That is the complete import surface. Nothing else in src/, tests/, or scripts/ imports any Open
module. (`neutron-managed-contract` has **zero** vendor imports — grep verified.)

## 3. Runtime/process contract (no imports — the real coupling)

### 3a. Entrypoint
- `bun run <vendor>/open/server.ts` — dev spawn `launcher.ts:115-117`; systemd `ExecStart`
  `launcher.ts:212, 230`. Requires the named export `startOpenServer`
  (contract surface `entrypoint:open/server.ts`, `open-contract.ts:164-169`; Open export at
  `open/server.ts:47`).

### 3b. Env-var ABI — `buildTenantEnv` (`launcher.ts:72-102`), single source of truth
Contract rule: each name must be READ somewhere under Open's `open/` or `gateway/` dirs
(`open-contract.ts:107-117, 146-159` — `ENV_READ_DIRS = ['open','gateway']`).

| Env var | Managed sets at | Open reads at (verified) |
|---|---|---|
| `NEUTRON_HOME` | launcher.ts:76 | open/owner-identity.ts:41; gateway/boot-helpers.ts:111 |
| `NEUTRON_DB_PATH` | launcher.ts:77 | open/owner-identity.ts:62; gateway/boot-helpers.ts:451 |
| `NEUTRON_INSTANCE_SLUG` | launcher.ts:78 | open/owner-identity.ts:75 |
| `NEUTRON_PORT` | launcher.ts:79 | gateway/boot-helpers.ts:240 |
| `NEUTRON_HOST` | launcher.ts:80 | open/server.ts:79 |
| `NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET` | launcher.ts:81-82 (secret → 0600 EnvironmentFile, launcher.ts:165-168) | open/server.ts:65-66 |
| `NEUTRON_DISABLE_AMBIENT_CLAUDE_AUTH='1'` | launcher.ts:94 | open/ambient-claude-auth.ts:96 |
| `CLAUDE_CODE_OAUTH_TOKEN` (conditional — only when tenant connected its own Max token) | launcher.ts:98-100 (secret env) | open/composer.ts:267 (LLM pool source); open/ambient-claude-auth.ts:9 |

NUANCE (verified): the contract's `MANAGED_TENANT_ENV_NAMES` (`open-contract.ts:107-114`) is
derived from a spec with **no** `claudeOauthToken`, so `CLAUDE_CODE_OAUTH_TOKEN` is NOT in the
gated env-name list — only the 7 unconditional vars are gated.

### 3c. HTTP surface of a tenant Open instance that Managed calls
- `GET /healthz` — `defaultHealthProbe` (`src/provision/systemd.ts:120-130`, 2s timeout, 2xx=ok);
  `FleetSupervisor` restart loop (`src/fleet/supervisor.ts:4-6`); `SystemdLauncher.waitHealthy`
  readiness (`launcher.ts:54-65` contract comment). Gated shape: `gateway/index.ts` must contain
  `defaultHealthzHandler`, `/healthz`, `project_slug`, `status: 'ok'` (`open-contract.ts:171-181`;
  Open handler at `gateway/index.ts:477`, wired `:227,:266`). NOTE: no Managed code actually
  parses `project_slug` today (grep: only contract/comment hits) — the shape pin is prophylactic.
- `GET /chat` — the product entry the Caddy subdomain fronts + post-signup/post-claim redirect
  target (`open-contract.ts:183-187`; claim redirect `src/claim/claim-page.ts:10-11`; Open at
  `open/composer.ts:1783,1789`). Gate: `open/composer.ts` must contain the literal `'/chat'`.
- `POST /webhook/telegram` — **UNPINNED coupling**: per-tenant bot provisioning points Telegram's
  webhook at `https://<subdomain>/webhook/telegram` (`src/bots/provision.ts:7,36`) and the
  control-plane forwarding path POSTs to `${upstreamUrl}/webhook/telegram`
  (`src/bots/routing.ts:84`). Open serves it at `gateway/http/compose.ts:1267-1269` (handler only
  when a telegram webhook handler is configured). NOT in the contract gate. Caveat (verified):
  tenant-side bot-token wiring does not exist yet — `provision-hetzner.sh:708`:
  *"NEUTRON_TELEGRAM_BOT_TOKEN is NOT wired — bots …"*; so this path is half-built
  (control-plane side complete + tested, tenant-side env seam missing).

### 3d. Host-environment/behavioral dependencies
- **gbrain on PATH**: tenant Open spawns a bare `gbrain` (resolved via PATH) from
  `gbrain-memory/gbrain-stdio-client.ts`; Managed pins `TENANT_UNIT_PATH` including
  `/usr/local/bin` (`launcher.ts:141-155`) and provisioning installs gbrain globally from
  `github:garrytan/gbrain` — NOT from vendor (`provision-hetzner.sh:299-336`). Pinned only in
  comments, not in the gate.
- **Caddy edge**: `<slug>.<baseDomain>` reverse-proxied to `127.0.0.1:<port>`
  (`src/routing/resolve.ts`, `src/edge/caddy.ts`); apex route paths in
  `provision-hetzner.sh:452`. Open must keep serving the whole product on one loopback port.
- **Duplicated (not imported) logic**: Managed's Max OAuth is "a faithful thin port of the
  monorepo's `auth/max-oauth.ts`" (`src/identity/oauth/max-oauth.ts:2-4`) — behavioral cousin of
  Open's install-token/ambient auth code, zero shared code. Comment-level references to Open
  internals: `max-token-store.ts:49` (composer reads `CLAUDE_CODE_OAUTH_TOKEN`),
  `launcher.ts:90` (`resolveOpenLlmPool` precedence).

### 3e. Declared forward seams (Open-side ready, Managed NOT consuming — verified)
- `NEUTRON_GRAPH_COMPOSER_MODULE` — see §1; `open-contract.ts:34-39`.
- `NEUTRON_POST_ONBOARDING_CLAIM_URL` — Open reads it at `open/composer.ts:1717` and `:3526`
  (claim bootstrap script + completed-phase redirect, PR #152); Managed's claim page explicitly
  defers threading it: `src/claim/claim-page.ts:22-27` ("OUT OF SCOPE here… tracked as a
  follow-up"). Not in `buildTenantEnv`.

---

## 4. Specific YES/NO answers (each grep-verified across managed src/ + tests/ + scripts/)

| Question | Answer | Evidence |
|---|---|---|
| `buildSlugPickerEngineHook` / any slugPicker construction? | **NO** | Zero hits. Managed REPLACED the monorepo in-onboarding slug picker with its own control-plane `/claim` page (`src/claim/claim-page.ts:2-5` "regressed when the new managed layer replaced the monorepo's in-onboarding slug picker"). Open export at `gateway/http/chat-bridge.ts:2177` has no Managed consumer. |
| `buildImportJobRunnerHook` / per-chunk import pipeline (job-runner, pass1/pass2)? | **NO** | Zero hits (Open export at `gateway/realmode-composer/build-import-job-runner.ts:193`). Import pipeline runs only inside the tenant Open process, untouched by Managed. |
| `composition.channel_router` / `ChannelRouter` / `registerAdapter` / `TelegramAdapter`? | **NO** (no code reference) | Zero hits. Only indirect coupling is HTTP: POST `/webhook/telegram` to the tenant upstream (`src/bots/routing.ts:84`) — see §3c caveat. |
| `loadInstanceEnvOverlay`? | **NO** | Zero hits (Open export at `gateway/realmode-composer/load-instance-env-overlay.ts:68`). Managed injects env via systemd `Environment=` + 0600 `EnvironmentFile=` instead (`launcher.ts:193-238`). |
| `buildMaxOAuthGateHandler` / `buildGateLandingServer` / `buildMaxOauthHandoffUrl` / `createTasksCoreOwnerRegistry` / `defaultListProjects` / `loadAnthropicOAuthConfigFromEnv` / `resolveIdentityPublicBaseUrl` / `resolveBaseDomain`? | **NO — all eight** | Zero hits for every name (Open exports at `gateway/boot-helpers.ts:1389/1642/1461/63/420/1259/1350/1358`). Managed's Max handoff is its own reimplementation (`src/identity/oauth/max-oauth.ts`, `max-handoff.ts`); its base-domain logic is its own `src/config.ts`. |
| `landing/auth-gate.ts`? | **NO** | Zero hits. Managed's auth (Google OIDC, JWT, claim cookies) is entirely its own (`src/identity/*`). |
| `internal_handle` as an option-bag property? | **NO** | Only three comment hits, each saying Managed DROPPED the `internal_handle`/`url_slug` split: `src/registry/registry.ts:9`, `src/edge/rename.ts:3`, `scripts/reset-tenant-by-email.sh:11-15`. No builder receives it. |
| Onboarding phase-machine engine — does Managed drive `InterviewEngine` / slug phases? | **NO** | Zero hits for `InterviewEngine`, phase names, `resolve-onboarding-phase`, etc. The interview runs wholly inside the tenant Open process; Managed's only onboarding-adjacent surfaces are its own signup pages (`src/signup/*`) and the post-onboarding `/claim` page (§2 import #1, §3e). |

## 5. What neutron-managed-contract's compatibility gate pins (VERIFIED — read in full)

`neutron-managed-contract` = the same repo at `9252e63` (the commit that introduced the gate),
vendor pinned `23c4351`. Its `src/ops/open-contract.ts` + `tests/open-contract.test.ts` pin:

1. `entrypoint:open/server.ts` — file exists and contains `startOpenServer`.
2. `boot:/healthz` — `gateway/index.ts` contains `defaultHealthzHandler`, `/healthz`,
   `project_slug`, `status: 'ok'`.
3. `route:/chat` — `open/composer.ts` contains `'/chat'`.
4. `env:<NAME>` for each of the SIX `buildTenantEnv` names of that era (`NEUTRON_HOME`,
   `NEUTRON_DB_PATH`, `NEUTRON_INSTANCE_SLUG`, `NEUTRON_PORT`, `NEUTRON_HOST`,
   `NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET`) — each must be read somewhere under `open/` or
   `gateway/`. (Diff-verified: its launcher lacks `NEUTRON_DISABLE_AMBIENT_CLAUDE_AUTH`.)
5. Deploy-gate behavior: red contract or red test suite → revert checkout, throw, no fleet roll.

Current `neutron-managed` HEAD extends this with: `env:NEUTRON_DISABLE_AMBIENT_CLAUDE_AUTH` and
surface `reuse:agent-name-suggester` (`onboarding/interview/agent-name-suggester.ts` must contain
`buildDiverseAgentNameFallback`) — `open-contract.ts:189-196`; plus the real-pinned-vendor pass
test (`tests/open-contract.test.ts:39-58`).

KEY MECHANISM FACT: the gate is **file-path + literal-substring** based (`mustContain`,
`open-contract.ts:136-144`; `envIsRead` greps `open/` + `gateway/` only, `:146-159`). It does NOT
typecheck or execute Open. So refactors that MOVE code between files break it even when names
survive — e.g. relocating the healthz handler out of `gateway/index.ts`, renaming
`open/composer.ts`, or moving an env read out of `open|gateway/` into a new top-level dir.

## 6. Refactor implications (inference, grounded in the above)

- **Free to delete/move without Managed coordination**: all eight boot-helpers exports in §4 row 5,
  `buildSlugPickerEngineHook`, `buildImportJobRunnerHook`, `loadInstanceEnvOverlay`,
  ChannelRouter/adapter internals, `landing/auth-gate.ts` internals, `internal_handle` plumbing,
  the InterviewEngine's internal shape — Managed has zero references to any of them.
- **Coordinate (same-window cross-repo change to `open-contract.ts` + `buildTenantEnv`)** when
  touching: `open/server.ts` path/`startOpenServer` name; `open/composer.ts` path/`'/chat'`;
  `gateway/index.ts`'s healthz literals; `onboarding/interview/agent-name-suggester.ts`
  path/export/`{picks:[{name,tagline}]}` shape + its deterministic no-LLM path;
  `open/ambient-claude-auth.ts` path/`ambientClaudeAuthDisabled` export; the 7 gated env names;
  the `open|gateway/` env-read-dir assumption; single-port serving; `/webhook/telegram` route;
  `NEUTRON_POST_ONBOARDING_CLAIM_URL` + `NEUTRON_GRAPH_COMPOSER_MODULE` seams; bare-`gbrain`
  PATH spawn in `gbrain-memory/gbrain-stdio-client.ts`.
- Gaps worth closing while both repos are in the window: pin `/webhook/telegram` (or delete the
  half-wired bots tenant path), decide the composer-seam and claim-URL seams' futures explicitly.
