# Subsystem map: federation-auth

Paths: `connect/`, `auth/`, `jwt-validator/`, `gateway/connect/`, `gateway/http/app-connect-*`, `gateway/projects/`, plus the landing-side federation clients (`landing/connect-*.ts`, `landing/auth-gate.ts`) that belong to this concern.

All paths relative to `/Users/ryan/repos/neutron-open`.

---

## 1. Purpose & responsibilities

Three distinct concerns share this subsystem:

1. **`connect/` — cross-instance federation ("Neutron Connect")**, the Slack-Connect model: a shared project is single-hosted on the owner's instance; collaborators on *other* instances reach it through a bearer-JWT'd HTTP API (`/connect/v1/*`), get host-assigned `local_slug` attribution, and receive a one-way GBrain memory mirror on join. **This entire edge is dormant in Open** — verified below — matching STATUS.md blocker #1 (`STATUS.md:161-164`).
2. **`auth/` — the owner-credential vault**: AES-256-GCM encrypted-at-rest `SecretsStore` (SQLite `secrets` table + keyfile `<owner_home>/.neutron-aes-key`), and the credential clients layered on it — Claude Max paste-token (`max-oauth.ts`), ChatGPT/Codex device-code OAuth (`chatgpt-oauth.ts`), BYO API keys (`api-key-store.ts` + `byo-api-key-fallback.ts`). **This is live and load-bearing** — it is how the box authenticates to Anthropic/OpenAI at all.
3. **`jwt-validator/` — EdDSA JWT validation** (JWKS cache, locked claims schema with `memberships[]`, `kid` resolver). Built for federation; in Open production it is only instantiated as an inert placeholder (`open/composer.ts:1246`).

Plus the gateway-side glue: `gateway/connect/` (Open-client federated token store + relay URL resolution), `gateway/http/app-connect-auth.ts` / `app-connect-invite.ts` (Open-side HTTP surfaces), and `gateway/projects/` (project settings store + the shared-projects resolver that would merge federated projects into the local list).

## 2. Module inventory (production code, `wc -l`)

### connect/ (workspace `@neutronai/connect`, ~3,900 prod / ~13,600 with tests)
| file | lines | role | live in Open? |
|---|---|---|---|
| `member-join.ts` | 546 | collaborator join/leave lifecycle, in-tx slug alloc | NO (connect-node only) |
| `api/server.ts` | 442 | `/connect/v1/*` HTTP edge | NO — dynamic-imported only when `connect_api` set (`gateway/composition.ts:119`), never set in Open |
| `shared-project-memory-mirror.ts` | 442 | one-way host→collaborator GBrain snapshot | NO (in-process source only; distributed activation deferred, `member-join.ts:97-116`) |
| `unified-project-list.ts` | 290 | cross-instance project LISTER, 30s cache | NO (only consumer is shared-projects-resolver, unwired) |
| `agent-engagement.ts` | 264 | **PURE** tag-gated engagement policy (`@neutron` mention detector) | **YES — live chat path** |
| `connected-members-store.ts` | 227 | `connected_members` table store | NO |
| `trusted-accept-handler.ts` | 224 | Managed-OAuth collaborator accept | NO |
| `api/handlers/on-inbound-message.ts` | 224 | inbound `POST /messages` → ChannelRouter | NO |
| `guest-auth-handler.ts` | 211 | public guest token handshake | NO |
| `guest-invite-store.ts` | 184 | hashed single-use invite rows | Semi — imported by `gateway/http/app-connect-invite.ts:41`, route 501s in Open |
| `api/jwt-bearer-middleware.ts` | 153 | 4-invariant bearer auth (aud=`connect.<slug>`, origin-from-memberships) | NO |
| `local-slug.ts` / `slug-format.ts` | 133/84 | host-assigned attribution slug grammar | NO (grammar itself re-exported from `runtime/slug-grammar.ts:36-40`) |
| `guest-refresh-handler.ts`, `invite-preview-handler.ts`, `api/edge-rate-limiter.ts`, `api/mint-instance-token.ts`, `api/origin-tag.ts`, `remote-shared-projects-store.ts`, `shared-project-mirror-store.ts`, `shared-project-source-resolver.ts`, `agent- engagement` | 121/106/120/97/64/97/95/83 | supporting pieces | NO |

### auth/ (workspace `@neutronai/auth`, ~1,800 prod)
| file | lines | role | live? |
|---|---|---|---|
| `max-oauth.ts` | 529 | Claude Max **paste-token** client (`claude setup-token` → probe → persist) | YES (`gateway/realmode-composer/resolve-llm-credentials.ts`) |
| `secrets-store.ts` | 471 | AES-256-GCM multi-secret store keyed `(internal_handle, kind, label)` | YES (`open/composer.ts:979`, cores OAuth, telegram, codex) |
| `chatgpt-oauth.ts` | 361 | OpenAI device-code flow → `~/.codex/auth.json` shape | YES (trident Codex: `trident/codex-auth.ts:21,203`) |
| `api-key-store.ts` | 253 | BYO API key CRUD over SecretsStore | YES |
| `max-oauth-multi-sub.ts` | 131 | **deliberate NOT_IMPLEMENTED stub** — "ORPHAN-IN-OPEN BY DESIGN" (`max-oauth-multi-sub.ts:27-33`) | no (Managed-only consumer) |
| `byo-api-key-fallback.ts` | 68 | ApiKeyStore → runtime `CredentialPool` composer | YES |

### jwt-validator/ (~350 prod)
`validator.ts` 207 (JwksCache + `validateJwt`, EdDSA pinned), `claims.ts` (zod `ClaimsSchema`, `Membership`), `resolve-key.ts` (kid→KeyLike with alg/kty/crv confusion guards).

### gateway side
| file | lines | live in Open? |
|---|---|---|
| `gateway/projects/sqlite-store.ts` | 524 | YES — canonical `SqliteProjectSettingsStore` |
| `gateway/connect/federated-token-store.ts` | 270 | **NO — constructed nowhere in production** (only `gateway/http/app-connect-auth.test.ts:9`, `gateway/__tests__/connect-auth-open-mode-production-composer.test.ts:38`) |
| `gateway/http/app-connect-invite.ts` | 269 | mounted but 501-gated (deps not wired) |
| `gateway/projects/shared-projects-resolver.ts` | 265 | NO — `buildSharedProjectsResolver` has zero production callers |
| `gateway/projects/default-emoji.ts` | 231 | YES |
| `gateway/http/app-connect-auth.ts` | 229 | **NO — `app_connect_auth_surface` is set only in a test** (`connect-auth-open-mode-production-composer.test.ts:123`); `open/composer.ts` never sets it |
| `gateway/connect/open-instance-source-resolver.ts` | 78 | NO |
| `gateway/connect/syndication-relay.ts` | 57 | NO (env-pointer leaf) |
| `gateway/projects/enumerate.ts` | 49 | YES |

### landing / app side (federation clients)
| file | lines | live? |
|---|---|---|
| `landing/auth-gate.ts` | 655 | **NO in Open** — `evaluateAuthGate` consumed only via `composition.auth_gate` (`gateway/http/compose.ts:896`), which no production code sets; Open uses its own inline `openFetch` gate (`open/composer.ts:1655-1760`) |
| `landing/connect-relay.ts` | 351 | **DEAD — zero importers anywhere** (grep: only self) |
| `landing/connect-accept.ts` + `.html` | 239 | NO (connect-node page; no connect node exists in Open) |
| `landing/connect-disclosure.ts` | 163 | NO |
| `app/lib/connect-members-client.ts` + `connect-member-helpers.ts` | ~300 | shipped in the Expo app; drives UI (`app/components/ProjectSettingsDrawer.tsx:210`) against routes that **return 501 in Open** |
| `runtime/connect-handlers.ts` | 185 | shadow structural-alias mirror of connect/api types (see debt) |

## 3. Public seams / contracts other subsystems consume

- **`connect/agent-engagement.ts`** — the ONE genuinely live connect export. Consumed by: `gateway/http/chat-bridge.ts:117-126` (engagement gate at `:2749-2830`), `gateway/realmode-composer/build-landing-stack.ts:25-28` + `:1475-1487` (DB-backed `resolveEngagementMode`), `gateway/projects/sqlite-store.ts:41` (row type), `gateway/http/app-projects-surface.ts:44-48` (settings PATCH whitelist), `cores/free/agent-settings/src/backend.ts:45-47` + `tools.ts:38`. Schema anchor: migration `0088_project_agent_engagement_mode.sql`.
- **`auth/index.ts`** barrel: `SecretsStore` (28 importing files incl. `open/composer.ts:125`, `gateway/boot-helpers.ts`, `cores/runtime/lifecycle.ts`, `cores/sdk/secrets.ts`, `gateway/cores/*`), `MaxOAuthClient`/`oauthEnvForPool`, `ChatGPTOAuthClient`, `ApiKeyStore`, `buildBYOApiKeyPool`.
- **`jwt-validator/index.ts`**: `JwksCache` (open composer placeholder :1246; landing auth-gate; jwt-bearer-middleware), `Membership` type (federated-token-store :27, shared-projects-resolver :42), `buildJwksResolveKey`.
- **`CompositionInput.connect_api`** (`gateway/composition/input/connect-input.ts:16-58`) — the DI seam through which a Managed/connect boot *would* mount the federation edge; kept type-only via the `runtime/connect-handlers.ts` structural aliases.
- **`gateway/http/app-projects-surface.ts` optional deps** `sharedProjects?` / `connect?` (`:411-419`) — the graceful-degradation seam: omitted in Open (`open/composer.ts:2297-2306`), so `connect-invites`/`connect-members` return `501 connect_not_configured` (`app-projects-surface.ts:628,646,665`).
- **`gateway/projects/enumerate.ts`** — consumed by gateway boot scheduler + app-admin backups.
- Wire prefix contract: `CONNECT_API_PREFIX = '/connect/v1'` (`connect/api/server.ts:37`).

## 4. Workspace dependencies (declared vs actual)

- `connect/package.json`: declares `@neutronai/jwt-validator`, `@neutronai/persistence`, `jose` (+ `gbrain` git devDep for mirror tests). **Actual imports exceed declaration**: `connect/shared-project-memory-mirror.ts:41` imports `../gbrain-memory/memory-store.ts` and `connect/api/handlers/on-inbound-message.ts:30-31` + `api/server.ts:25` import `../../channels/*` — neither `gbrain-memory` nor `channels` is declared. `slug-format.ts:36` imports `../runtime/slug-grammar.ts` (also undeclared).
- `auth/package.json`: declares `persistence`, `runtime` — matches actual (`max-oauth.ts` → `runtime/models.ts`; `byo-api-key-fallback.ts` → `runtime/credential-pool.ts`). No cycle: runtime never imports auth.
- `jwt-validator`: leaf (jose, zod only). Clean.
- Inbound: gateway (projects, http, connect, realmode-composer), open/composer, cores/free/agent-settings, cores/runtime + cores/sdk (SecretsStore), trident (chatgpt-oauth pattern), onboarding (`optional-keys.ts`, `interview/engine.ts` → auth).
- Outbound oddity: `gateway/http/app-connect-invite.ts:36-39` imports `onboarding/api/invite-link-generate.ts` — a gateway HTTP surface depending on the onboarding workspace for JWT invite minting.
- Import-style split for the same package: `gateway/projects/shared-projects-resolver.ts:36-41` uses the `@neutronai/connect/...` specifier while `gateway/projects/sqlite-store.ts:41` and `gateway/http/chat-bridge.ts:126` use relative `../../connect/...`.

## 5. Internal layering (as-built)

```
jwt-validator (leaf) ──► connect/api/jwt-bearer-middleware ──► connect/api/server (DORMANT edge)
persistence ──► connect stores (guest-invite, connected-members, mirrors, remote-shared)
runtime/slug-grammar ──► connect/slug-format ──► local-slug ──► member-join ──► accept handlers
gbrain-memory ──► shared-project-memory-mirror (in-process only)
auth/secrets-store ──► {api-key-store, max-oauth, chatgpt-oauth} ──► gateway/realmode-composer cred resolution
auth + jwt-validator ──► gateway/connect/federated-token-store (DORMANT) ──► gateway/http/app-connect-auth (UNMOUNTED)
connect/unified-project-list + source-resolver + mint-instance-token ──► gateway/projects/shared-projects-resolver (UNCALLED)
connect/agent-engagement (pure leaf) ──► chat-bridge + projects store + agent-settings core (LIVE)
```

The one clean part: `agent-engagement.ts` is deliberately pure ("no I/O, no imports", `agent-engagement.ts:18-20`) — except it now *does* import nothing, so purity holds; it's just filed in the wrong package.

## 6. Dormancy proof (connect_api never wired)

- `runtime/platform-adapter-local.ts:140` — `connect_api: false` for the local/Open platform adapter.
- `composition.connect_api` is set by **no production code** (grep over gateway/open/landing: only `gateway/composition.ts` reads it; the only setters are tests).
- The Managed edge is loaded only via `await import('../connect/api/server.ts')` guarded on `composition.connect_api !== undefined` (`gateway/composition.ts:107-132`) — Open boots never evaluate the module.
- `wireConnectOverlay` (`gateway/composition/wire-connect-overlay.ts:37-50`) no-ops in Open (no `connect_api`).
- Open's composition input (`open/composer.ts:3578-3614`) sets no `connect_api`, no `app_connect_auth_surface`, no `auth_gate`, and constructs `createAppProjectsSurface` without `sharedProjects`/`connect` (`open/composer.ts:2297-2306`).

## 7. Architectural debt

### D1 (P1) — Dormant federation entangled through four live modules (STATUS.md blocker #1, confirmed and mapped)
The dormant `connect/` package cannot be quarantined today because live Open code takes import edges into it:
1. `gateway/http/chat-bridge.ts:117-126` — the **live single-owner chat routing path** imports engagement policy from `connect/`.
2. `gateway/projects/sqlite-store.ts:41` + `gateway/http/app-projects-surface.ts:44-48` — the canonical projects store/settings surface carry `AgentEngagementMode` from `connect/`.
3. `cores/free/agent-settings/src/backend.ts:45-47` — a bundled core imports `connect/`.
4. `gateway/http/app-connect-invite.ts:41` — imports `ConnectGuestInviteStore` at module scope; the file itself is statically imported by the always-mounted `app-projects-surface.ts:56-61`, so connect store code loads in every Open boot even though the route 501s.
Meanwhile 8 connect migrations (`migrations/0055,0056,0057,0058,0060,0061,0062,0070,0071,0073`) create federation tables in every single-owner DB. Severity P1: it blocks the "reduce connect to a pure relay" refactor and makes the Open dependency graph lie about what's reachable.
**Sketch**: move `agent-engagement.ts` out of `connect/` into a product-policy home (it is chat policy, not federation — e.g. `gateway/chat-policy/` or `channels/`), inverting the 4 live edges; then `connect/` becomes a true leaf loaded only behind `connect_api`, and `gateway/connect/` + `gateway/http/app-connect-*` + `landing/connect-*` can be collapsed into one federation module with a single mount point.

### D2 (P1) — Two parallel, divergent HTTP auth gates; the tested one is unmounted, the mounted one is bespoke
`landing/auth-gate.ts` (655 lines, 769-line test file with fail-closed assertions) is consumed only via `composition.auth_gate` (`gateway/http/compose.ts:896`) which production never sets. Open's real gate is the hand-rolled `openFetch` closure inside `open/composer.ts:1655-1760` (cookie check, single-use `?start=` JTI claim, cold-start redirects, SPA deep-link mint). Two implementations of the same concern, one dead-in-prod, one living inside a 3.7k-line composer closure. Note also `landing/auth-gate.ts:397,441`: `mintStartToken` throw → **falls through to allow** (documented fail-open) — relevant to the pending fail-closed public-launch gate. Severity P1 for maintainability + the security posture ambiguity.
**Sketch**: extract Open's `openFetch` gating into a named, tested module (or converge onto `applyAuthGate` with an Open-mode HMAC verifier), delete whichever path loses, and make the fail-open-on-mint-failure branch an explicit policy decision.

### D3 (P2) — Shipped-but-dead client surfaces produce user-visible 501/404 affordances
- `landing/connect-relay.ts` (351 lines): zero importers — pure dead code.
- Expo `ProjectSettingsDrawer.tsx:210` + `app/lib/connect-members-client.ts` render connect-member management against routes hard-501'd in Open (`app-projects-surface.ts:628,646,665`).
- `gateway/http/app-connect-auth.ts` + `gateway/connect/federated-token-store.ts` + `gateway/connect/open-instance-source-resolver.ts` + `syndication-relay.ts`: complete, tested, never constructed in production.
**Sketch**: either wire `app_connect_auth_surface`/`sharedProjects` for real (M2.5 design) or gate the client affordances on a capability probe and park the server pieces with the federation module (D1).

### D4 (P2) — `runtime/connect-handlers.ts`: a 185-line shadow contract with deliberate `any`
Structural aliases mirror `connect/api/server.ts` types "field-for-field" with `any` handler params (`runtime/connect-handlers.ts:69-80`) so composition avoids an import edge — plus the narrow `as any` casts at the consumption site (`gateway/composition.ts:122-129`). Two hand-synchronized copies of a wire contract with the type checker turned off at the seam. **Sketch**: once D1 makes `connect/` a leaf, replace the aliases with `import type` from connect (type-only imports are erased and don't defeat the dynamic-import isolation), deleting the shadow file.

### D5 (P2) — Undeclared cross-workspace imports in `connect/`
`connect/shared-project-memory-mirror.ts:41` → `gbrain-memory`; `connect/api/handlers/on-inbound-message.ts:30-31`, `api/server.ts:25` → `channels`; `slug-format.ts:36` → `runtime`. None in `connect/package.json` (only jwt-validator, persistence, jose). Works via relative paths in a monorepo but breaks the workspace's dependency story and any future extraction.

### D6 (P2) — `SecretsStore` identity-key rename trap is convention-only
SQL column literally named `project_slug` holds the frozen `internal_handle` (`auth/secrets-store.ts:69-75,96-100`); passing the mutable `url_slug` silently returns null credentials (the 2026-05-12 prod defect, header `:10-27`). The contract is enforced by comments + parameter names only; every new caller re-risks it. This is also the epicenter of the repo-wide "tenant vocabulary" debt. **Sketch**: during the rename refactor, add a branded `InternalHandle` string type at the store boundary.

### D7 (P3) — `shared-projects-resolver` dual-mode branching
`gateway/projects/shared-projects-resolver.ts:162-227` interleaves Managed (`mintInstanceToken`+registry) and Open (federated token+URL template) paths via `openMode` ternaries inside one closure; in this repo the Managed half is unreachable. Fine while dormant; when the pure-relay refactor lands, split into two strategies behind the `mintToken`/`resolveBaseUrl` seams that already exist.

### D8 (P3) — Deliberate stub retained for an absent tree
`auth/max-oauth-multi-sub.ts` throw-on-call stub whose only consumer is the carved-out Managed rotator (`:27-33` says do NOT delete). Reasonable, but it is 131 lines + test that exist purely for a repo that isn't this one; the refactor should re-confirm the Managed overlay still needs it.

### Dead/legacy code candidates (evidence)
- `landing/connect-relay.ts` — zero importers (grep whole repo).
- `landing/auth-gate.ts` `applyAuthGate`/`evaluateAuthGate` — no production `composition.auth_gate` setter.
- `gateway/http/app-connect-auth.ts` — surface never mounted (`app_connect_auth_surface` only in test :123).
- `gateway/connect/federated-token-store.ts`, `open-instance-source-resolver.ts`, `syndication-relay.ts` — no production constructor/caller.
- `gateway/projects/shared-projects-resolver.ts` — `buildSharedProjectsResolver` never called outside tests.
- `connect/` accept/guest/mirror/member machinery — connect-node-only, no connect node in Open.
- `auth/max-oauth-multi-sub.ts` — documented intentional orphan (not for deletion without checking the Managed overlay).
- NOT dead despite appearance: `connect/agent-engagement.ts` (live), `connect/guest-invite-store.ts` (loaded via app-connect-invite).

## 8. Test posture

`bun test connect/ auth/ jwt-validator/ gateway/connect/ gateway/projects/` → **340 pass / 0 fail across 38 files (~14s)**. Character: excellent *unit* coverage — injectable fetch/clock everywhere (`federated-token-store.ts:68-70`, `unified-project-list.ts:43-48`), timing-safe compare tests, jwt no-roundtrip tests (`tests/integration/jwt-no-roundtrip.open.test.ts`), fail-closed auth-gate tests (`landing/__tests__/auth-gate.test.ts:769`). Flake risk low (in-memory DBs, no live network).
**The gap is exactly the dormancy**: `*-production-composer` tests hand-assemble composition fields production never sets (e.g. `gateway/__tests__/connect-auth-open-mode-production-composer.test.ts:123` sets `app_connect_auth_surface`), so green tests prove the *machinery* works while nothing proves — or refutes — that it is reachable from a real boot. A refactor deleting a live wire would be caught; one deleting a dormant wire would not change any user-visible behavior, which cuts both ways for a no-functionality-change guarantee.

## 9. Load-bearing subtleties a refactor must NOT break

1. **Engagement gate fail-soft + transcript invariant** (`chat-bridge.ts:2749-2791`): DB read failure → `DEFAULT_AGENT_ENGAGEMENT_MODE` (`all_messages`), never a dropped turn; `tag_gated` + no mention still **persists the user turn** and sends a no-render `agent_ack` to clear the client's optimistic typing dots. Also the resolver itself swallows errors → default (`build-landing-stack.ts:1475-1487`). Changing the default or the ack breaks group-chat UX and the one-reply-per-turn bookkeeping.
2. **Mention detection quote-guard** (`agent-engagement.ts:70+`): fenced/inline code + blockquotes are blanked before `@neutron` matching — moving this module must keep the `claude` courtesy alias and the doc-quote guard byte-compatible.
3. **SecretsStore key semantics**: `(internal_handle, kind, label)` with the column named `project_slug`; keyfile `ensureKey` **reuses** existing material rather than overwriting (`secrets-store.ts:28-33`) — regenerating it bricks every stored credential.
4. **Max paste-token dual-row shape** (`max-oauth.ts:23-38`): the token persists as BOTH `max_oauth_refresh` and `max_oauth_access` rows (same value) so the resolver's read path short-circuits; probe semantics treat 401-rate-limit / 403-quota as *valid* token. Collapsing to one row silently kills `ownerHasMaxOAuthTokens`-style probes.
5. **FederatedTokenStore self-expiry** (`federated-token-store.ts:112-123,216-220`): the secret row's `expires_at = refresh_expires_at*1000` makes the blob auto-vanish (no sweeper); refresh-401 → `disconnect()`; 120s refresh margin; `getMemberships` decodes **without** signature verification *by design* (`:250-258` — the receiving instance re-verifies).
6. **Origin-slug derivation** (`shared-projects-resolver.ts:164-179`): in open mode the outbound origin header comes from the federated token's `kind:'user'` membership, NOT the local box slug (Argus r2 BLOCKER #2) — stamping the local slug 403s every workspace on any real deployment. Plus the two-layer cache (10s aggregate over 30s per-instance) and the "source_errors never blank the list" degradation contract.
7. **Compose-chain null-fallthrough discipline**: both the connect API handler (`connect/api/server.ts:189-192`) and `app-connect-auth` return `null` for unowned paths; `app-connect-auth.ts:144-153` claims only 4 exact (path,method) pairs so a tokenless request to a sibling path is never 401-shadowed. Cookie (not bearer) auth on those 4 routes is deliberate — `/callback` is a top-level OAuth 302 carrying only the SameSite=Lax cookie (`:35-40`); `safeRelativePath` (`:123-130`) is the open-redirect guard.
8. **Dynamic-import isolation + shutdown ordering** (`gateway/composition.ts:107-132, 400-426`): `connect/api/server.ts` must never be statically imported by composition (Open boots must not load the Managed edge); and `buildComposedHttpFromComposition` failure after `graph.compose()` must `graph.shutdown()` before rethrowing or cron/reminders/watchdog leak.
9. **Overlay ordering & caller authority** (`wire-connect-overlay.ts`): the `on_inbound_message` overlay runs after cores wiring, before HTTP composition, and only when the caller left the handler undefined AND supplied the factory.
10. **Auth-gate Accept-header carve-out** (`landing/auth-gate.ts:46-52`): non-HTML requests are never 302'd to signin — redirecting Expo bearer calls to an HTML page breaks the app. Any gate convergence must preserve this.
11. **Inert JwksCache placeholder** (`open/composer.ts:1244-1246`): `new JwksCache('https://invalid.local/...')` is safe only because the HMAC start-token verifier never resolves a JWKS key; making JwksCache eager (fetch-at-construct) breaks Open boot.
12. **Timing-safe slug compares** (`gateway/http/auth-helpers.ts:31-33`) and internal_handle canonicalization before compare (`app-connect-auth.ts:160-173`) — a "simplifying" `!==` reintroduces the timing side-channel and the rename-breaks-auth P0.
13. **In-tx local_slug allocation** (`member-join.ts` header, #108 fix): slug allocation must stay inside the member-insert transaction (allocator race), and `stampOriginInstance` throws on grammar-violating slugs — the fallback-base discipline in `local-slug.ts` is what keeps joins from throwing.
14. **Connect route 501-vs-404 semantics**: handler-absent federation routes 404 (`connect/api/server.ts:212,232`), unconfigured app routes 501 `connect_not_configured` (`app-projects-surface.ts:628`) — the Expo client branches on these exact codes (`connect-members-client.ts:11-14`).

## 10. What the refactor should do here

1. **Extract `agent-engagement.ts` from `connect/`** into a chat-policy module; update the 4 live import sites (chat-bridge, projects store, app-projects-surface, agent-settings core) + re-export shim if needed. This alone makes `connect/` production-unreachable in Open.
2. **Consolidate the federation remnant** into one clearly-labeled dormant module: `connect/` + `gateway/connect/` + `gateway/http/app-connect-*` + `landing/connect-*` + `runtime/connect-handlers.ts`, with a single composition seam (`connect_api` + `app_connect_auth_surface`) and a README stating the pure-relay target. Delete `landing/connect-relay.ts` (zero importers) outright.
3. **Converge the two auth gates** (D2) and make the fail-closed decision explicit before public launch; extract Open's inline `openFetch` gate from the composer god-closure into a tested module.
4. **Declare connect's real deps** (gbrain-memory, channels, runtime) or invert them (the memory-mirror's `SharedProjectGraphSource` is already an injection seam — the gbrain import is only for `isGbrainBinaryMissingError`).
5. **Keep `auth/` and `jwt-validator/` as-is structurally** (they are the healthy part); fold the internal_handle branding (D6) into the tenant-vocabulary rename.
6. Decide the Expo connect-members UI: capability-gate or remove until federation ships; today it is a guaranteed 501 path on every Open box.
