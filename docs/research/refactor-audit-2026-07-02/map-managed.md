# neutron-managed + neutron-managed-contract — repo map for the refactor window

Investigated 2026-07-02 (read-only). All paths absolute; `managed:` = `/Users/ryan/repos/neutron-managed`, `open:` = `/Users/ryan/repos/neutron-open`. Facts are cited file:line; items marked **[inference]** are judgment calls.

---

## 1. Purpose & product shape

**Verified:** neutron-managed is the proprietary hosted multi-instance overlay: a single Bun control-plane process (`auth.<managed-host>` + apex) that provisions and orchestrates **N single-owner Neutron Open instances, one OS process per tenant**, each a stock vendored Open server (`managed:README.md:1-8`, `managed:package.json` "thin multi-tenant overlay that orchestrates N single-owner Neutron Open instances").

- Tenant runtime = `bun run <vendor>/open/server.ts` with per-tenant env (`managed:src/provision/launcher.ts:113-133`), as systemd unit `neutron-tenant@<slug>.service` in prod (`launcher.ts:135-238`), loopback ports 7800-7899 (`managed:src/config.ts:12-13`), fronted by Caddy for TLS + subdomain routing (`managed:src/edge/caddy.ts`), wildcard DNS-01 TLS via IONOS (`managed:src/edge/tls.ts`).
- Control plane owns: central identity (RS256 key ring + JWKS, refresh rotation — `managed:src/identity/jwt.ts`, `keys.ts`), Google/Apple OAuth (`src/identity/oauth/`), signup→provision (`src/signup/`), per-tenant **Anthropic Max token handoff** (each tenant's OWN `CLAUDE_CODE_OAUTH_TOKEN`, never shared — `launcher.ts:31-37,94-100`, `src/identity/oauth/max-*.ts`), end-of-onboarding personal-URL claim (`src/claim/`), tenant rename + 301 redirects (`src/edge/rename.ts`), boot-time fleet reconcile (`src/fleet/reconcile.ts`, invoked `src/index.ts:715-728`).
- Managed **never imports Open's runtime into its own process** (one deliberate exception, §8.5). Tenants receive Open features solely via `vendor/neutron` submodule re-pin ("RE-PIN-ONLY, never edited" — `managed:SPEC.md:455`).
- Prod: Hetzner CCX43 `neutron-prod` (`managed:docs/DEPLOY-ACCESS.md:8-17`), repo at `/opt/neutron-managed`, service `neutron-managed.service` on 127.0.0.1:7780 (`DEPLOY-ACCESS.md:40`). Verified live 2026-07-02: exactly **1 running tenant unit** (`neutron-tenant@n7bd11f54bf71d9e4.service`, via read-only ssh).

**Key strategic context** (`managed:SPEC.md:107`): build spine re-sequenced 2026-06-19 to rebuild Managed fresh on Open *before* the daily-driver waves; M1 acceptance explicitly requires onboarding to work on BOTH local Open install AND a provisioned managed tenant (`SPEC.md:114`).

## 2. What neutron-managed-contract actually is

**Verified:** NOT a separate repo. It is a **git worktree of neutron-managed** (`managed-contract:.git` → `gitdir: /Users/ryan/repos/neutron-managed/.git/worktrees/neutron-managed-contract`), pinned on branch `managed-contract-gate` at `9252e63` ("feat(ops): Open→Managed compatibility gate"), with `vendor/neutron` at `23c4351` — frozen since **2026-06-19** (file mtimes; `git worktree list` output). The gate itself was merged to main via PR #103 (`7c39c6a` in `git log main`), so the worktree is **stale debris ~13 days / ~150 commits behind main**. Nothing in either repo's code references this path. The open refactor plan's D-3 note ("`neutron-managed-contract` holds an Open→Managed compat gate", plan:1304) is **misleading** — the live gate is `managed:src/ops/open-contract.ts` on main; the worktree can be deleted.

Two more worktrees exist under `managed:.claude/worktrees/` (forge branches `managed-tenant-disable-ambient-auth`, `marketing/neutron-computer-purple-rebuild`).

## 3. src/ module inventory (10,609 LOC across 59 .ts files)

| Module | LOC | Responsibility | Wired? |
|---|---|---|---|
| `src/index.ts` | 750 | Control-plane composition root + hand-rolled if-chain HTTP router (~25 routes, listed at :8-27) | yes (entrypoint) |
| `src/claim/claim-page.ts` | 502 | /claim picker page (inline HTML string) | yes |
| `src/edge/caddy.ts` | 471 | Caddy admin-API route add/remove/flip | yes |
| `src/identity/oauth/max-handoff.ts` | 441 | Max-auth start/callback/skip + install-token flow | yes |
| `src/signup/signup-page.ts` | 436 | /signup Google-first browser flow (inline HTML) | yes |
| `src/identity/oauth/install-token-page.ts` | 385 | one-liner installer polling page | yes |
| `src/identity/jwt.ts` | 332 | RS256 access tokens + refresh rotation/theft detection | yes |
| `src/ops/open-contract.ts` | 312 | **the Open→Managed contract gate** (§7) | test/gate only |
| `src/identity/keys.ts` | 282 | signing-key ring, JWKS, rotation+grace | yes |
| `src/signup/signup.ts` | 265 | slug availability + signup→provision | yes |
| `src/registry/registry.ts` | 249 | tenants registry (bun:sqlite) | yes |
| `src/provision/systemd.ts` | 247 | SystemdLauncher: unit write, daemon-reload, health-poll | yes (prod) |
| `src/provision/launcher.ts` | 245 | **buildTenantEnv (the env ABI)** + subprocess launcher + unit renderer | yes |
| `src/ops/deploy.ts` | 244 | `bumpOpenSubmodule` (gated) + `rollingRestart` + `deployOpenBump` | **NOT invoked by any script/route** |
| `src/billing/stripe.ts` | 242 | Stripe client + webhook handler | **dormant** (no route mounts it) |
| `src/identity/oauth/max-token-store.ts` | 228 | AES-256-GCM per-tenant Max token store | yes |
| `src/provision/provision.ts` | 213 | validate→allocate→datadir→register→launch orchestrator | yes |
| `src/identity/oauth/install-token-store.ts` | 209 | ephemeral signup_id handoff store | yes |
| `src/identity/oauth/max-oauth.ts` | 208 | Max probe/client | yes |
| `src/fleet/supervisor.ts` | 203 | health-poll + restart-budget supervisor | **dormant** (never started; only doc-comment refs, e.g. `index.ts:250`) |
| `src/edge/ionos-dns.ts` | 202 | IONOS DNS records | **dormant in src** (provisioning-era) |
| `src/edge/tls.ts` | 197 | wildcard TLS automation config | **dormant in src** |
| `src/bots/telegram.ts` + `token-store.ts` + `provision.ts` + `routing.ts` | 188+177+151+107 | per-tenant Telegram bots | **dormant** — no route/import except `parseKey` reuse (`max-token-store.ts:30`) |
| `src/identity/accounts.ts` | 187 | Argon2 account store | yes |
| `src/provision/user-isolation.ts` | 177 | per-tenant POSIX user | yes (prod) |
| `src/lifecycle/lifecycle.ts` | 171 | start/stop/restart/archive fleet ops | **dormant** — "CLI + HTTP endpoints are a thin follow-up wiring task" (`IMPLEMENTATION_PLAN.md:49-50`) |
| `src/identity/oauth/install-token-script.ts` | 165 | the `curl \| bash` token capture script | yes |
| `src/fleet/reconcile.ts` | 147 | boot reconcile: relaunch actives + re-add routes | yes |
| `src/ops/backup.ts` + `run-backup.ts` | 145+42 | git snapshot backups | yes (systemd timer via `scripts/provision-hetzner.sh`) |
| `src/identity/oauth/google.ts`/`apple.ts`/`oidc-verify.ts`/`fake.ts`/`identities.ts`/`types.ts`/`registry.ts`/`pkce.ts` | ~575 | OAuth providers | yes |
| `src/registry/migrations.ts` | 135 | versioned registry migrations | yes |
| `src/billing/tier.ts` | 126 | tier enforcement at provision | yes (`provision.ts:25`) |
| `src/edge/rename.ts` | 117 | slug rename + route flip + 301 | yes |
| `src/signup/waitlist.ts` | 115 | marketing waitlist sink | yes |
| `src/claim/url-suggester.ts` | 114 | personal-URL suggestions — **imports vendored Open source** (§8.5) | yes |
| remainder (`config.ts` 78, `routing/resolve.ts` 45, `host/commands.ts` 87, `provision/slug.ts` 74, `ports.ts` 51, `data-dir.ts` 48, `select-launcher.ts` 85, `identity/cross-tenant.ts` 90, `claim-cookie.ts` 55, `claim-flow.ts` 69, `oauth-pending.ts` 67, `edge/dns-automation.ts` 77, `identity/db.ts` 22) | ~850 | config/glue | yes |

Tests: **45 test files, 6,481 LOC** under `managed:tests/` (bunfig scopes test root to `tests/` so vendor's suite is excluded — `managed:bunfig.toml`). 10.6k src + 6.5k tests ≈ the "~17k LOC" figure.

## 4. How deploys work (vendor bump cadence + procedure)

**Verified:**
- **Cadence:** 77 of 258 total commits are `deploy: vendor bump` commits, first 2026-06-20, latest 2026-07-02 (`git log --grep 'vendor bump'`) → **~6/day; effectively after every Open merge wave**. A bump commit changes only the `vendor/neutron` gitlink + one AS-BUILT line (e.g. `bd2bd9c`).
- **Standing policy** (`managed:SPEC.md:449`, Ryan 2026-06-20): auto-bump Managed → latest Open after each Open deploy, contract-gated; auto-proceed on green + non-risky; PAUSE + ask on red gate or risky boundary (tenant/identity/billing/migration). Batch during overnight waves. "[workflow to be scripted; for now the coordinator runs it]" — i.e. **an agent runs the bump by hand**.
- **Procedure** (`managed:docs/DEPLOY-ACCESS.md:44-61`): on the Mac — run `bun test tests/open-contract.test.ts` gate + commit the re-pin; then `ssh root@neutron-prod`: ff-only fetch/reset of `/opt/neutron-managed`, `git submodule update --init --recursive vendor/neutron`, **mandatory `bun install` inside vendor/neutron** (Open is a bun workspace; skipping it crash-loops every tenant on `Cannot find module '@neutron/chat-core'` — `DEPLOY-ACCESS.md` note, root-caused 2026-06-23), `systemctl restart neutron-managed.service`, curl /healthz.
- Bump commit messages carry the gate result (e.g. "Contract 14/0" in `bd2bd9c`).
- The *programmatic* pipeline (`deployOpenBump` = gated bump → wave-based health-gated `rollingRestart`, `managed:src/ops/deploy.ts:235-244`) is fully built + tested but **not invoked by any script, route, or cron** — the manual ssh procedure is what actually runs. **[inference]** debt: two deploy mechanisms, only the unwired one has the rolling-restart safety.

## 5. Governing docs state

- **SPEC.md** (568 lines / 252KB): the *product master spec for all of Neutron* (both repos), not just Managed — milestone arc M1–M6 (`SPEC.md:112-120`; note M2/M3 resequenced 2026-07-01: Ryan's hard cutover now BEFORE multi-user), build-spine waves, Decisions Log appendix (`:324+`), detail-spec index (`:294`). Repo-routing model locked at `:455` (one topic, strict two-repo separation, ONE repo per PR, vendor re-pin-only).
- **ISSUES.md** (2,019 lines / 648KB): **39 open** (`grep -c '### \[open\]'`). Head issue = **#332 P0** (opened 2026-07-02, commit `20c850d`): work-board items + trident builds started from a NAMED project land on the GENERAL board — write path (`mcp/server.ts:77,119-135` `currentTopicContextOrSystem` falls back to instance slug; build dispatch) doesn't thread active project_id even though storage/read (`work-board/store.ts:146-153` `workBoardScopeKey`) is correct; Forge `workboard-project-scope-fix` already dispatched. Note: **most open issues are labeled "(Open)"** — this ISSUES.md is the shared dogfood log for defects whose fix lands in neutron-open.
- **IMPLEMENTATION_PLAN.md** (143 lines): Managed-layer plan, Phases 0–6 all `[x]` except noted follow-ups; explicitly OUT of scope: `internal_handle`/`url_slug` split machinery and the 275KB realmode-composer ("managed injects via `NEUTRON_GRAPH_COMPOSER_MODULE` only if it ever needs to" — `:136-142`).
- **AS-BUILT.md**: 3.4MB append-only build log.
- **Legacy contamination (verified):** the docs corpus was *seeded from the old monorepo* on 2026-06-18 (`a032f35` "Seed governing docs… + planning corpus"; fresh-start commit `4392e17`). So `docs/operations/deploy-runbook.md` (last_updated 2026-05-08) describes the **dead** old-monorepo tag-poller pipeline (`neutron-tag-poller`, `deploy-tag.sh`) that contradicts the live DEPLOY-ACCESS.md flow; ISSUES.md mixes live issues with old-monorepo ones referencing paths that don't exist in either new repo (e.g. #302 cites `tenant-provisioning/render-systemd-unit.ts`, `scripts/install/*.service.template` — `ISSUES.md:219-224`).

## 6. Architectural debt (same lens as the open audit)

1. **God-file risk: low.** Largest file is `index.ts` at 750 lines — a miniature of open's composer problem (composition root + inline router + inline handlers in one closure), but 4× smaller and injectable throughout. **[inference]** worth an M-side cleanup (route table + handler modules) but not urgent.
2. **Inline-HTML page modules** (`claim-page.ts` 502, `signup-page.ts` 436, `install-token-page.ts` 385): template-literal HTML with duplicated styling; no shared layout primitive. **[inference]** fine at current page count.
3. **Built-but-dormant modules (~1.5k LOC):** bots/* (623), `billing/stripe.ts` (242, webhook never mounted — no `/v1/billing` route in `index.ts`), `lifecycle/lifecycle.ts` (171), `fleet/supervisor.ts` (203, never constructed; actual resilience = systemd `Restart=on-failure` + boot reconcile), `edge/tls.ts`/`ionos-dns.ts`/`dns-automation.ts` (476, superseded by box-level Caddy config from `scripts/provision-hetzner.sh`), `ops/deploy.ts` rolling-restart path (§4). All are tested, none dead-*broken* — they are parity modules built ahead of wiring (IMPLEMENTATION_PLAN checkboxes claim them done with "NEEDS LIVE" caveats). **Wire-or-annotate decision needed per module.**
4. **Duplication vs open: minimal by design.** The one place it was tempting (name suggestions) was solved by importing the vendored Open function instead of copying (§8.5). Slug grammar (`src/provision/slug.ts`) is Managed-owned, not a copy of an Open module (checked — no counterpart import).
5. **Config/env posture: clean.** All control-plane config via `resolveConfig` (`src/config.ts:57-78`; NEUTRON_HOME / NEUTRON_BASE_DOMAIN / NEUTRON_TENANT_PORT_RANGE / NEUTRON_REGISTRY_DB_PATH / NEUTRON_VENDOR_NEUTRON_DIR / NEUTRON_PUBLIC_AUTH_URL), plus opt-in feature envs read in `index.ts` (NEUTRON_CADDY_ADMIN_URL :189, NEUTRON_MAX_TOKEN_KEY/NEUTRON_BOT_TOKEN_KEY :198-199, NEUTRON_INSTALL_TOKEN_SECRET :222, NEUTRON_PORT/NEUTRON_HOST :730-733). tsconfig is strict + noUncheckedIndexedAccess (`managed:tsconfig.json`).
6. **Test posture: strong ratio, but NO CI.** 45 files/6.5k LOC over 10.6k src; injectable seams everywhere (FetchLike, HostCommandRunner, launcher, probes). **There is no `.github/` directory — no CI runs anything, ever.** The suite + contract gate run only when a human/agent runs `bun test` on the Mac. Contract test verified green right now: 14 pass / 0 fail against pinned vendor `f04b3f68` (ran during this audit).
7. **Doc debt:** §5 legacy contamination; three giant single-file governing docs; stale worktree (§2).

## 7. The Open→Managed contract gate — mechanics + where it runs

`managed:src/ops/open-contract.ts` pins the implicit ABI **derived from Managed's real usage** (:1-40):

- **Surfaces checked** (`openContractSurfaces()`, :162-206): (1) `entrypoint:open/server.ts` must exist + contain `startOpenServer` (:164-169); (2) `boot:/healthz` — `gateway/index.ts` must contain `defaultHealthzHandler`, `/healthz`, `project_slug`, `status: 'ok'` (:171-180); (3) `route:/chat` — `open/composer.ts` must contain `'/chat'` (:183-186); (4) `reuse:agent-name-suggester` — `onboarding/interview/agent-name-suggester.ts` must contain `buildDiverseAgentNameFallback` (:189-196); (5) one `env:<NAME>` surface per key of `buildTenantEnv` (:198-204) — each name must be *read* somewhere in Open source **under `open/` or `gateway/` only** (`ENV_READ_DIRS`, :117; `envIsRead` :147-159). Env list auto-extends when `buildTenantEnv` grows (:107-114). Currently 8 env names → the "Contract 14/0" figure (4 fixed + 8 env + 2 assertions… count as reported by the test).
- **Enforcement points:** (a) `tests/open-contract.test.ts` (14 tests) — run manually pre-bump per `DEPLOY-ACCESS.md:61`; (b) `bumpOpenSubmodule(gate)` — records HEAD, checks out new ref, runs static contract + full Managed `bun test`, **reverts the checkout on red** and throws `OpenContractError` before `rollingRestart` (`src/ops/deploy.ts:54-92`).
- **Where it runs in CI: NOWHERE.** No CI in managed (no `.github/`); nothing in neutron-open's CI checks the Managed contract either (open CI has leak-gate etc., not this). The gate's only execution is agent-run `bun test` at bump time + the unwired programmatic path. **This is the single biggest process gap for the refactor window** — a 6-bumps/day human-in-the-loop gate with no CI backstop, right when open starts moving every file the gate greps for.
- **Explicit forward seam, intentionally NOT asserted** (:34-39): `NEUTRON_GRAPH_COMPOSER_MODULE` — Managed does not thread it; tenants boot the plain single-owner Open shape.

## 8. The exact Open↔Managed coupling list (the real ABI)

1. **Process entrypoint:** `bun run <vendor>/open/server.ts` + `startOpenServer` export — spawned by `OpenSubprocessLauncher` (`launcher.ts:115-117`) and baked into every on-disk systemd unit (`launcher.ts:212,230`). Moving/renaming `open/server.ts` breaks running units until regenerated.
2. **Tenant env contract** (`buildTenantEnv`, `launcher.ts:72-102`): `NEUTRON_HOME`, `NEUTRON_DB_PATH`, `NEUTRON_INSTANCE_SLUG`, `NEUTRON_PORT`, `NEUTRON_HOST`, `NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET`, `NEUTRON_DISABLE_AMBIENT_CLAUDE_AUTH` (read at `open/ambient-claude-auth.ts` per :93), conditional `CLAUDE_CODE_OAUTH_TOKEN` (read at `open/composer.ts` `resolveOpenLlmPool` per :97). Secrets split to a 0600 EnvironmentFile (`launcher.ts:165-182`). **Renaming any of these in Open, or moving their read out of `open/`+`gateway/`, reds the gate; renames also require per-tenant unit regeneration on prod (precedent: ISSUES #302, `ISSUES.md:219-224`).**
3. **`/healthz` JSON shape** incl. field `project_slug` + `status:'ok'` (`open-contract.ts:171-180`), polled by `defaultHealthProbe`/reconcile/deploy waves.
4. **`/chat` route** — the product entry every tenant subdomain fronts; also the post-provision redirect target `<slug>.<baseDomain>/chat` (`launcher.ts:58-61`).
5. **The one runtime source import:** `managed:src/claim/url-suggester.ts:22` imports `buildDiverseAgentNameFallback` from `vendor/neutron/onboarding/interview/agent-name-suggester.ts` (deliberate, pinned as contract surface 4; driven LLM-less/deterministic — file header :1-20).
6. **`NEUTRON_POST_ONBOARDING_CLAIM_URL`** — Open reads it (`open:open/composer.ts:1710-1721, 3526`, landed with claim-redirect PR #152) **but `buildTenantEnv` does NOT set it yet**. `managed:docs/SYSTEM-OVERVIEW.md:313` claims "Managed threads via buildTenantEnv" — **stale/aspirational; grep of managed src/tests/scripts finds zero setters**. So hosted tenants currently never auto-redirect to /claim. Gap to close on the Managed side (and once added, the env auto-joins the contract).
7. **Workspace install invariant:** Open must stay `bun install`-able inside `vendor/neutron` with `open/server.ts` resolving workspace packages (`DEPLOY-ACCESS.md` bun-install note). Refactor changes to workspace/package layout hit the deploy procedure.
8. **What is NOT coupled (myth-busting for the open plan):** there is **no private Managed composer**. `NEUTRON_GRAPH_COMPOSER_MODULE` appears in managed only as a doc comment (`open-contract.ts:35`); `internal_handle`/`url_slug`/`RouteSlot` have **zero runtime references** in managed src (only "we deliberately dropped this" comments: `src/edge/rename.ts:3`, `src/registry/registry.ts:9`, `scripts/reset-tenant-by-email.sh:11-15`; exclusion confirmed at `IMPLEMENTATION_PLAN.md:136-142`). The refactor plan's line-1200 claim ("The Managed composer's option-bag property names include `internal_handle`") describes the **old monorepo** (`rjunee/neutron-old`), not this repo.

## 9. Refactor units the MANAGED side needs when open's plan executes

**Plan corrections first (highest value):**

- **P-1 — Rewrite the plan's Managed-ABI model.** The consumer surface is the 8-item list in §8, not "a private Managed composer importing gateway internals". C2's `gateway/composer-contract.ts` barrel has **no external consumer today** — it's still worth building as the sanctioned seam, but it is not load-bearing for Managed compatibility; the *actual* cross-repo contract to co-evolve is `managed:src/ops/open-contract.ts`. The internal_handle→owner_handle unit (plan:1200-1204) can **drop the dual-spelling compat window for Managed's composer option-bag** — no such consumer exists.
- **P-2 — D-2 (per-chunk hosted-signup import pipeline): "relocate to neutron-managed" is architecturally impossible as stated.** Managed never injects code into tenant processes — tenants run *stock vendored Open*. Anything hosted tenants exercise at runtime must live in Open; anything only the OLD monorepo's hosted-signup used is dead for the NEW Managed too (new signup = Managed's own pages → provision → tenant onboards in-instance via stock Open onboarding, `managed:src/signup/signup-page.ts`, `SPEC.md:114`). So the decision is **verify-dead-then-delete in Open** (or keep if the *single-owner* path uses it), never "move to Managed".
- **P-3 — D-1 (slugPicker): Managed already owns its slug picker** (`/v1/slug/check` + `checkSlugAvailability`, `managed:src/signup/signup.ts`; suggestions via `src/claim/url-suggester.ts`). Open's slug-picker relic can be deleted, not relocated — nothing in new Managed consumes it.
- **P-4 — D-5 (Managed onboarding mode):** hosted tenants run the same single-owner onboarding as self-hosters (per-tenant Open process). Open onboarding branches reachable only under old-monorepo "managed mode" flags are not exercised by the new Managed; the safe-delete check is "reachable in single-owner boot?", not "Managed-mode-reachable?".

**Concrete Managed-side units (M-series) to append to the plan:**

- **M0 — CI for neutron-managed (do FIRST, before open's C-waves).** GitHub Actions: `bun test` + `bunx tsc --noEmit` + the contract test against the pinned submodule, on PR and on every vendor-bump commit. Today the 6-bumps/day gate has no automated backstop (§7). Cheap, and it converts every open refactor mistake into a red check instead of a prod 502.
- **M1 — Contract-surface co-evolution (lockstep edits to `open-contract.ts`).** Triggered by these open units:
  - **C1 (BootConfig / `open/server.ts` env handling):** keep the file at `open/server.ts` + keep exporting `startOpenServer`, or update surface 1 + regenerate prod tenant units in the same bump.
  - **C3a–d composer carve + C4 RouteSlot + G1:** the `'/chat'` literal will move out of `open/composer.ts` into a route registry → update surface 3's file path; better, replace the string-grep with an assertion against G1's route-matrix snapshot (the plan already proposes a "Managed-contract variant" of `open-route-matrix.test.ts` at plan:163-164 — make Open emit a machine-readable route manifest and have Managed's gate read *that*).
  - **Any env-read relocation:** `envIsRead` only scans `open/` + `gateway/` (`open-contract.ts:117`) — if C-waves move env reads into a new top-level dir (e.g. `boot/`, `config/`), extend `ENV_READ_DIRS` in the same bump or the gate false-reds.
  - **healthz extraction:** if `defaultHealthzHandler` leaves `gateway/index.ts`, update surface 2; treat the `/healthz` JSON (esp. `project_slug`) as a frozen public ABI — it's also the self-hosters' health surface.
  - **onboarding restructure:** if `onboarding/interview/agent-name-suggester.ts` moves, update surface 4 AND the import at `managed:src/claim/url-suggester.ts:22` (it path-couples into the vendor tree).
  - **C7 (`realmode-composer/`→`wiring/` rename):** zero Managed code impact (doc comments only: `open-contract.ts:35`); update comments opportunistically.
- **M2 — Thread `NEUTRON_POST_ONBOARDING_CLAIM_URL` through `buildTenantEnv`** (closes the §8.6 gap; the designed-but-unbuilt auto-arrival for the claim flow, `managed:docs/plans/2026-07-01-managed-personal-url-claim.md:31`). One-line env + tests; the contract auto-extends.
- **M3 — Env/identity rename wave runbook.** If open's owner_handle wave renames `NEUTRON_INSTANCE_SLUG` or the healthz `project_slug` field: coordinated PR pair + **mandatory per-tenant systemd unit regeneration + daemon-reload on the prod deploy** (ISSUES #302 is the documented precedent for exactly this failure shape). Currently 1 live tenant, so the window is cheap NOW — another reason to sequence identity renames early.
- **M4 — Script the gated bump.** Replace the manual DEPLOY-ACCESS ssh recipe with a thin CLI over the already-built `deployOpenBump` (`src/ops/deploy.ts:235`), so the contract+suite+revert+rolling-restart machinery that exists actually runs on every bump (SPEC.md:449 already flags "workflow to be scripted").
- **M5 — Wire-or-annotate the dormant modules** (§6.3): mount the Stripe webhook or mark it pre-built; start `FleetSupervisor` (or delete in favor of systemd Restart + reconcile); expose lifecycle ops; delete the superseded edge/tls+dns modules if box-level Caddy config is the permanent answer.
- **M6 — Docs hygiene:** archive the neutron-old-seeded docs that describe dead pipelines (`docs/operations/deploy-runbook.md`), split legacy monorepo ISSUES entries from live ones, prune the stale `neutron-managed-contract` worktree (`git worktree remove`), and fix the plan's D-3 wording.

**Sequencing note [inference]:** M0 and M3's "regenerate units" discipline should land before any open unit touching `open/server.ts`, `gateway/index.ts`, `open/composer.ts` routes, or `buildTenantEnv` names — i.e., before C1/C3/C4/G1. Everything else can trail.
