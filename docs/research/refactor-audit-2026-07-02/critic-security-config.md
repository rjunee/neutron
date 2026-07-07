# Critic report — Config + Security architecture (Neutron Open)

Charter: config/env architecture, secrets handling, and the auth gate vs. the
"fail-closed for public launch" bar. Evidence verified in code; file:line cited.

---

## 1. Env-var / config inventory (measured, not estimated)

Counts from grep across the tree (excluding node_modules + tests):

- **~150 distinct `NEUTRON_*` identifiers** referenced across `.ts/.tsx/.mjs/.sh`
  (`grep -rhoE "NEUTRON_[A-Z0-9_]+" | sort -u | wc -l` = 150).
- **64 distinct `process.env`/`Bun.env` keys** read in code overall.
- **71 production (non-test) files read `process.env`/`Bun.env` directly.**
- Non-`NEUTRON_` secrets/config also read raw: `CLAUDE_CODE_OAUTH_TOKEN`,
  `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CLAUDE_BIN`, `SINK_TOKEN`, `SINK_PORT`,
  `SESSION_ID`, `NODE_ENV`, `TZ`, `HOME`, `NOTIFY_SOCKET`, plus `EXPO_PUBLIC_*`.

### Where config is resolved (no single owner)

Resolution logic is smeared across at least a dozen resolver functions, each
with its own inline default, plus dozens of inline `?? default` reads:

- `open/owner-identity.ts` — `resolveNeutronHome` (`~/neutron`), `resolveOpenDbPath`
  (`<NEUTRON_HOME>/project.db`), `resolveOwnerSlug` (`'dev'`), `OWNER_USER_ID='owner'`
  (constant).
- `gateway/index.ts:118` — `resolveDbPath()` defaults to
  `~/.local/share/neutron/owner.db` — **a DIFFERENT default DB path** than
  `open/owner-identity.ts:resolveOpenDbPath` (`<NEUTRON_HOME>/project.db`).
  `resolveOwnerSlug` (`gateway/index.ts:147`) is a **second, `.url_slug`-file-aware
  copy** of the open one.
- `gateway/boot-helpers.ts:224` — `resolveListenPort` (CLI > env `NEUTRON_PORT` >
  7800), the only resolver that validates (`assertPort` throws on non-integer).
- `gateway/index.ts:308` — host default `127.0.0.1` read inline in the `Bun.serve`
  arrow.
- `gateway/deployment-mode.ts:59` — `resolveDeploymentMode` (`NEUTRON_ROLE` >
  `NEUTRON_DEPLOYMENT_MODE` > `'open'`).
- `runtime/models.ts` — `NEUTRON_BEST_MODEL`/`NEUTRON_FAST_MODEL`/`NEUTRON_SONNET_MODEL`
  read inline.
- `open/server.ts:47-73` — **mutates `process.env` as its DI mechanism** because
  `boot()` re-reads `process.env` independently for DB path/slug/host/port
  (documented deliberate, `open/server.ts:42-46`). A config-object refactor must
  change both sides in lockstep.

There is **no typed config type, no schema, and no boot-time validation pass.**
A mistyped bool/number/path silently falls to a default at each read site
(exceptions: `resolveListenPort` throws; `resolveDeploymentMode` normalizes).
The net effect: config correctness is unknowable at boot, and there is no single
place to read to learn what an Open box can be tuned with.

### `.env.example` completeness

`.env.example` (117 lines) documents ~15 knobs: `NEUTRON_HOME`, `NEUTRON_DB_PATH`,
`NEUTRON_PORT`, `NEUTRON_HOST`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`,
`CLAUDE_BIN`, Telegram, cookie secret, model overrides, embeddings, backups.

**Undocumented but operationally/security-relevant** (partial list): the two
auth-bypass toggles `NEUTRON_APP_WS_BYPASS` / `NEUTRON_APP_WS_DEV_SECRET`,
`NEUTRON_DEPLOYMENT_MODE`/`NEUTRON_ROLE`, `NEUTRON_AUTH_JWKS_URL`,
`NEUTRON_POST_ONBOARDING_CLAIM_URL`, `NEUTRON_GRAPH_COMPOSER_MODULE`,
`NEUTRON_DISABLE_AMBIENT_CLAUDE_AUTH`, `NEUTRON_INSTANCE_SLUG`, the timeout
family (`NEUTRON_ROUTER_*`, `NEUTRON_SYNTHESIS_*`, `NEUTRON_PREWARM_AWAIT_CAP_MS`),
overnight limits, upload cap, and the codex-home vars. ~135 of ~150 vars are
undocumented for a self-hoster.

---

## 2. Secrets handling

The store layer is genuinely good; the surrounding conventions are fragmented.

### The encrypted store (solid)

`auth/secrets-store.ts` — AES-256-GCM, envelope `{v:1, iv_b64, ct_b64, tag_b64}`,
keyfile `<owner_home>/.neutron-aes-key` at mode 0600, with a defense-in-depth
`chmodSync(path, 0o600)` even on the legacy-reuse path (`secrets-store.ts:458-465`)
and `expires_at` honored on read (`:208-210`). `replaceAtomic` wraps delete+insert
in one transaction (`:257-302`). This is the right primitive.

**Caveats:**
- The SQL column is literally named `project_slug` but holds the FROZEN
  `internal_handle` (`secrets-store.ts:8-27, 97-107`). A caller that passes
  `url_slug` instead silently loses all credentials — enforced by prose
  convention only, not the type system. (Cross-cutting with the tenant-vocab
  rename; the branded-type fix belongs to security.)

### Plaintext-on-disk surfaces (three different models coexist)

1. **`.env`** — Anthropic OAuth token / API key live here in plaintext (`.env`
   is 0600 on disk, gitignored via `.gitignore:6`). Read by
   `open/composer.ts:291-303:resolveOpenLlmPool` into an in-memory
   `CredentialPool` as plaintext `secret`. Standard env model, acceptable.
2. **Codex `auth.json`** — the ChatGPT-subscription bundle is stored *encrypted*
   in `SecretsStore`, then **materialized to disk in plaintext** at
   `CODEX_HOME/auth.json`, mode 0600 (`trident/codex-auth.ts:20, 207-217`).
   Necessary (the `codex` CLI reads the file) but it is a second at-rest plaintext
   secret with a different lifecycle than the encrypted store.
3. **Dev-channel `SINK_TOKEN`** — a **process-wide** random token
   (`persistent-repl-substrate.ts:965 randomBytes(24)`) shared by ALL warm REPL
   sessions and injected into each session's tmp `mcp-config`
   (`tools-bridge.ts:52`, `X-Sink-Token` at `:173`). Authorization on `/tool-call`
   checks only this shared token (`persistent-repl-substrate.ts:1003-1004`), not
   the per-session bridge. A Bash-equipped REPL can read its own mcp-config and
   thus call tools for *other* sessions inside the loopback trust boundary. (Also
   flagged by cores-platform; noted here as the security dimension.)

There is no single "secrets convention" doc or module: encryption-at-rest is used
for OAuth/BYO/bot tokens, env-plaintext for the primary Anthropic cred,
disk-plaintext for codex, and a shared in-memory token for the tool bridge.

The credential-pool threading into spawns is disciplined:
`gateway/realmode-composer/build-llm-call-substrate.ts:184-207` explicitly
UNSETS `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`/`CLAUDE_CODE_OAUTH_TOKEN` before
setting ONLY the selected cred (ISSUES #49 scrub), and `cred_id` (not the secret)
is what surfaces on completions. This part is done right.

---

## 3. The auth gate: current state vs. the "fail-closed for public launch" bar

README is explicit (`README.md:232-234`): the gateway binds loopback by default
and is "not yet safe … leave it that way until the auth gate ships fail-closed
(tracked for the public launch)." Assessment of current state against that bar:

### What exists and is fine

- **Bind loopback by default** — `gateway/index.ts:308` `hostname: NEUTRON_HOST ?? '127.0.0.1'`.
- **Session cookie** — `landing/session-cookie.ts`: HMAC-SHA256, 30-day sliding,
  `HttpOnly; SameSite=Lax; Path=/`, `Secure` only on https
  (`open/composer.ts:3630`). Constant-time HMAC compare (`session-cookie.ts:96`).
- **Start tokens** — one-shot, single-use JTI claim
  (`open/composer.ts:1638-1653`), 15-min TTL, minted from the cookie secret.
- **Cookie secret** — pinned by `install.sh:499-540`; ephemeral-with-warn if unset
  (`open/server.ts:64-73`).
- **HTTP app-surface bearer** wrapped to reject any resolved user_id ≠
  `OWNER_USER_ID` (`open/composer.ts:1977-1993`).

### The gaps vs. fail-closed (the substantive findings)

**(a) App-ws auth is hardcoded dev-bypass with a PUBLIC-CONSTANT bearer.**
`open/composer.ts:1978` constructs `createAppWsAuthResolver({ project_slug,
bypass: true })` — unconditionally, NOT gated on `NEUTRON_APP_WS_BYPASS`. The
accepted token is `dev:<OWNER_USER_ID>` = `dev:owner`
(`owner-identity.ts:26`, `chat-react/config.ts:15-18,64-71`). So the entire app
API + WebSocket "auth" reduces to: *present the fixed public string `dev:owner`*.
The wrapper restricts to the owner id, but the id is a compile-time constant, not
a secret. Auth is 100% "you can reach the port," i.e. the loopback bind is the
ONLY real gate.

**(b) No `Origin`/host validation on the WebSocket upgrade.** The upgrade
(`gateway/http/app-ws-surface.ts:204-261`) reads `?token=` from the query string
and calls `server.upgrade(req)` with **no `Origin` header check**. Browsers do
NOT apply same-origin policy to WebSocket connections and do NOT send a CORS
preflight for them. Therefore **any web page the owner visits can open
`ws://127.0.0.1:7800/ws/app/chat?token=dev:owner` and drive the agent** — a
classic cross-origin-WebSocket / DNS-rebinding hijack that loopback binding does
NOT stop (the request originates from the victim's own machine). The HTTP app
surfaces are incidentally protected (a cross-site page can't set
`Authorization:` without a preflight that gets no CORS response), but the WS is
wide open. This is the sharpest concrete current-state gap.

**(c) No coupling between bind mode and auth mode (no fail-closed).** There is no
server-side guard that refuses to bind non-loopback while auth is in dev-bypass.
`grep` for any `throw/warn/refuse` keyed on `NEUTRON_HOST`/`0.0.0.0` in
`open/`+`gateway/` returns nothing. An operator who sets `NEUTRON_HOST=0.0.0.0`
(the code permits it; README merely warns) exposes the box on the network where
**anyone who sends `Bearer dev:owner` / `?token=dev:owner` is the owner** — full
agent control, doc read/write, credential rotation. The "fail-closed" property is
literally absent: the system fails OPEN when misconfigured.

Net: against the stated bar, the auth gate is **not yet fail-closed**. The
minimum to reach it is (1) an Origin allowlist on the WS upgrade, (2) a real
per-boot bearer secret (replace the constant `dev:owner`), and (3) a boot guard
coupling non-loopback bind to a configured non-bypass auth mode.

---

## 4. Proposals

### 4a. One typed config module with boot-time schema validation

Introduce `config/` (a leaf package) exporting a single `resolveBootConfig(env,
argv): BootConfig` that:
- reads every `NEUTRON_*` / auth var ONCE, with a declared type + default +
  validator per key (zod already in the tree);
- is the ONLY place defaults live (delete the ~dozen scattered resolvers; keep
  `.url_slug`-file precedence as one documented rule);
- is threaded explicitly into `boot()` and the composer, replacing
  `open/server.ts`'s `process.env` mutation and `boot()`'s independent re-reads;
- fails LOUD at boot on an invalid value (bad port, bad bool, non-absolute path,
  unknown deployment mode) instead of silently defaulting;
- emits a redacted config dump at boot for operability.
Generate `.env.example` FROM the schema so the two can never drift, and add a CI
check that every documented key exists in the schema and vice-versa.

### 4b. Secrets-handling convention

Document + enforce one rule set: (i) all long-lived third-party secrets go
through `SecretsStore` (encrypted-at-rest) — the primary Anthropic cred can stay
env-only but should be documented as the single exception; (ii) any plaintext
materialization (codex `auth.json`) is 0600, under `owner_home`, and registered
so uninstall reaps it; (iii) replace the process-wide `SINK_TOKEN` with a
per-session token checked against the session on `/tool-call`; (iv) add an
`InternalHandle` branded string at the `SecretsStore` boundary to kill the
`project_slug`/`url_slug` rename trap by construction.

### 4c. Minimum security hardening list for public launch (fail-closed)

1. **Origin allowlist on the WS upgrade** (`app-ws-surface.ts:204`): reject
   upgrades whose `Origin` isn't the configured self-origin (or null for native).
   Single highest-value fix.
2. **Real per-boot app bearer secret**: replace the constant `dev:owner`
   (`open/composer.ts:1978` + `chat-react/config.ts`) with a random per-boot token
   injected into the served HTML (same channel as the cookie), so a leaked URL or
   a guessed constant can't authenticate.
3. **Boot guard: fail-closed on misconfiguration** — refuse to bind
   non-loopback (`NEUTRON_HOST` not 127.0.0.1/::1) unless a non-bypass auth mode
   (HS256/EdDSA) is configured; warn loudly and exit non-zero otherwise.
4. **Land the deferred production auth resolver** (`app-ws/auth.ts:24-27` TODO):
   EdDSA/JWKS via `jwt-validator/`, `project_slug` cross-check, expiry.
5. **CSRF/state on the cookie-mint + start-token gate** if the box is ever fronted
   by a real domain (the `SameSite=Lax` cookie + `?start=` flow is currently
   single-owner-safe but assumes loopback).
6. **Content secret scanning in CI** — the public leak-gate blocks `.env`/`.pem`
   by extension only (`scripts/ci/leak-gate.sh:214-217`); add a gitleaks-style
   value scan so a pasted token in a committed file is caught.

---

## Appendix — evidence index
- Env counts: `grep -rhoE "NEUTRON_[A-Z0-9_]+"` = 150 uniq; 64 uniq `process.env` keys; 71 prod files.
- `.env.example` — 117 lines, ~15 documented knobs.
- `auth/secrets-store.ts:8-27, 97-107, 208-210, 257-302, 448-471`.
- `open/composer.ts:287-316` (cred pool), `:1160-1189` (cookie/start-token), `:1977-1993` (app-ws bypass wrap), `:3624-3632` (cookie flags).
- `channels/adapters/app-ws/auth.ts:10-16, 24-27, 71-124` (dev-bypass + deferred prod TODO), `landing/chat-react/config.ts:15-18, 64-71` (public `dev:` token).
- `gateway/http/app-ws-surface.ts:204-265` (WS upgrade, no Origin).
- `gateway/index.ts:118-157, 283-340` (dual DB/slug resolvers, inline host).
- `open/server.ts:42-73` (process.env mutation DI).
- `gateway/realmode-composer/build-llm-call-substrate.ts:184-207` (env scrub — done right).
- `trident/codex-auth.ts:20, 180-217` (plaintext auth.json 0600).
- `runtime/adapters/claude-code/persistent/persistent-repl-substrate.ts:965, 1003-1004` + `tools-bridge.ts:52, 173` (process-wide sink token).
- `README.md:232-234, 438` ("fail-closed … tracked for the public launch").
- `scripts/ci/leak-gate.sh:214-217` (extension-only secret gate).
