# `@neutron/cores-sdk` — Contract & Migration Guide

This is the contract first-party Cores (Topline `dtc-analytics`, future
Acme/Northwind analytics, etc.) build against **before** the full
Cores runtime ships in P3. The interfaces here are deliberately stable
v1 — when P3 lands, dev-mode stubs become platform-backed
implementations with no caller-side code change.

Cross-refs:

- `docs/engineering-plan.md § A.3` — SQLite-per-project + per-Core data
- `docs/engineering-plan.md § B.P3` — Cores runtime + manifest + capability gating (the platform side this SDK forward-defines)
- `docs/engineering-plan.md § D.10` — third-party auth + secrets, capability gating per § D.10.4
- `docs/engineering-plan.md § E` — locked decision: npm-shape Core authoring with `"neutron"` section in `package.json`
- internal design notes — reconciliation guard (1% drift, fail loud)
- `core-sdk/types.ts` — the parallel P0 contract surface (closed-enum capability list); see "Relationship to `core-sdk/`" below.

---

## Module map

```
cores/sdk/
├── manifest.ts    Zod schema for the package.json "neutron" block
├── connector.ts   Connector<TConfig, TState, TRow> interface
├── auth.ts        validatePlatformJwt(token, jwks, opts) + dev stub
├── secrets.ts     SecretsAccessor (capability-gated wrapper) + dev stub
├── route.ts       mountCoreRoutes(app, opts) — Hono helper
├── reconcile.ts   ReconciliationGuard + runReconciliation([...])
├── index.ts       public barrel
└── __tests__/     Bun test suite covering each module
```

Each module exports stable types + functions. The public barrel is
`@neutron/cores-sdk`; per-module deep imports (`@neutron/cores-sdk/manifest`)
also work for callers that prefer narrow imports.

---

## What each interface guarantees

### `manifest.ts` — `NeutronManifest`

Captures the seven required fields per § E + § D.10.4:

- `capabilities: string[]` — `<verb>:<resource>`-shape capability strings (`read:project.db`, `connect:google-ads`, …)
- `tier_support: ('regular'|'private')[]` — substrate tiers the Core supports (at least one required)
- `tools: ToolDef[]` — MCP tool definitions; each names a `capability_required`
- `ui_components: UiComponentDef[]` — surface mounts (`launcher_icon` | `project_tab` | `settings_panel` | `route_mount`); `route_mount` requires `mount_path`
- `billing_hooks: BillingMeter[]` — usage meters (empty array for v1; meters land in P3+)
- `linked_sources: LinkedSourceDef[]` — third-party providers this Core integrates with (Shopify, Google Ads, …)
- `secrets: ManifestSecret[]` — capability-gated secrets the Core declares (per § D.10.4)
- `compat: { coreApi: <semver-range> }` — host SDK version range
- `build: { neutronVersion: <host-version> }` — Neutron host version this Core was built against

`parseManifest(input)` throws on invalid; `safeParseManifest(input)` returns `{success, data|error}`. Both enforce the `route_mount.mount_path` refinement.

**Guarantee:** every Core's runtime API access (tools, routes, secrets) is gated on this manifest. The platform refuses to dispatch a tool whose `capability_required` isn't in `capabilities[]`, and `SecretsAccessor.get(...)` throws when the requested `(kind, label)` isn't in `secrets[]`.

**`network:browse` capability semantics (added 2026-05-20, Research Core).** Declaring `network:browse` implies `network:external` (the looser any-network capability). It additionally promises that the Core's network calls are gated by a per-Core domain allow-list — the runtime does NOT enforce the allow-list itself; the Core is the source of truth. The capability is a contract: "this Core's network use is bounded by a documented allow-list, not arbitrary egress." Cores that need arbitrary outbound network should declare `network:external` directly. The Research Core is the first user — see `cores/free/research/src/web-fetch.ts` for the reference allow-list enforcer (RFC-1918 / loopback / link-local / `file://` / `ftp://` / `data:` / `javascript:` unconditionally rejected; configurable public-domain allow-list per-instance; redirect-follow safety refuses redirects to blocked destinations). The marketplace Store UI can surface "this Core uses `network:browse` → see its allow-list" badging at install time.

### `connector.ts` — `Connector<TConfig, TState, TRow>`

Shape every Core's third-party data-source integration implements:

- `id: string` — stable id (`shopify`, `google-ads`)
- `capabilities: ReadonlyArray<string>` — capability strings the connector requests
- `testConnection(cfg)` — idempotent, side-effect-free auth check
- `fetchSince(cfg, since)` — `AsyncIterable<TRow>` streaming primary path
- `fetchSnapshot(cfg)` — bulk-pull for daily/weekly reconciliation
- `getState() / setState(s)` — last-sync watermark persistence

`TRow` extends `ConnectorRow` (which carries `project_slug + ts`); `WatermarkState` and `CursorState` are common-shape helpers.

**Guarantee:** the Cores runtime (P3) drives any `Connector` uniformly — schedule fetches, persist watermarks, snapshot for reconciliation. Implementations MUST yield rows in `ts` order within a single `fetchSince` call and MUST resume cleanly from `getState()` after a transient abort.

### `auth.ts` — JWT validation (two-layer)

Verifies a `start_token` JWT issued by the configured auth service. Two layers:

**Low-level: `validatePlatformJwt(token, jwks, options)`** — caller manages the JWKS lifecycle. Steps:

1. Verify EdDSA signature against the supplied `JSONWebKeySet`.
2. Confirm `aud` includes `'neutron'` (overridable for tests).
3. Confirm `exp` is in the future (with optional clock skew).
4. Confirm `iat` and `exp` claims are present + numeric (rejected if missing — never silently defaulted).
5. Confirm the decoded `memberships[]` contains the Core's `expected_project_slug` — cross-project safety.

**High-level: `buildPlatformJwtValidator({jwks_url, expected_project_slug, ...})`** — returns a `(token) => Promise<PlatformAuthResult>` factory backed by an in-process `JwksCache`. The cache fetches the URL at most once per `ttlMs` (default 1h) and serves stale-on-error to survive transient JWKS outages. **Use this in production** — passing a JWKS URL to `validatePlatformJwt` directly is no longer supported (would refetch per request).

`JwksCache` is exported as a public class for callers that already manage their own rotation. Same TTL semantics + stale-on-error behaviour as `jwt-validator/validator.ts:JwksCache` (lifted, inlined so a Core shipping outside the monorepo doesn't need a separate `@neutron/jwt-validator` dependency).

Throws `PlatformJwtError(code, message)` with codes: `token_invalid` | `token_expired` | `wrong_audience` | `missing_membership` | `jwks_fetch_failed`.

**Dev stub.** `buildDevPlatformJwtValidator({admin_email, bearer_token, project_slug})` returns a factory that accepts a single hardcoded bearer token + yields synthetic claims. Gated behind `NEUTRON_DEV_AUTH=1`. Tests pass `bypass_env_guard: true`.

### `secrets.ts` — `SecretsAccessor` (capability-gated)

`buildSecretsAccessor({manifest|secrets}, {internal_handle, store, core_id})` wraps the platform's `SecretsStore` (`auth/secrets-store.ts`, AES-256-GCM keyfile). Every `get/put/list` call:

1. Looks up `(kind, label)` in the Core's manifest `secrets[]`.
2. If absent: throws `CapabilityDeniedError`. The Core never sees the plaintext.
3. If present: forwards the call to the platform store.

**Write/rotate semantics.** The platform `SecretsStore.put()` is INSERT-only — duplicate `(project_slug, kind, label)` rejects with `duplicate_label`. The SDK's `SecretsAccessor.put()` hides this fork: it `list()`s for an existing row, calls `rotate(id, plaintext, {expires_at})` when one exists, otherwise `put({...expires_at})`. This is what an OAuth re-auth or BYOK update flow needs.

**Expiry.** OAuth `oauth_token` rows must carry `expires_at` so the platform store returns null on a stale-cache read and the caller's refresh path runs. `SecretsAccessor.put(kind, label, plaintext, {expires_at})` propagates the timestamp on BOTH insert and rotate paths. The dev accessor ignores `expires_at` (the dev JSON file has no expiry index — documented limitation).

**Required `id` on `list()`.** `PlatformSecretsStoreListItem.id` is required, NOT optional. The SDK's write-rotate path needs the id to call `rotate(...)`; a store implementation that omits id would silently fall through to a `put()` that re-raises `duplicate_label`. The SDK fails fast with a `CapabilityDeniedError({code: 'misconfigured'})` instead.

`buildDevSecretsAccessor({manifest|secrets}, {file_path, core_id})` is the dev-only passthrough — reads/writes plaintext JSON. Gated behind `NEUTRON_DEV_AUTH=1`. NEVER prod.

The SDK does NOT own audit-log writes — § D.10.5's per-project `secret_audit_log` is platform-side, written by the production `SecretsStore` itself when the SDK forwards a call through.

### `route.ts` — `mountCoreRoutes(app, options)`

Wires the four canonical Core surfaces onto a Hono instance:

- `GET /healthz` — public, optional override body
- `* /api/*` — bearer-token-required (validated via the supplied `PlatformJwtValidator`); auth context exposed at `c.get('auth')`
- `<adminMountPath>` AND `<adminMountPath>/*` — same auth gate (mount path resolved from the manifest's `route_mount` UI component); the SDK registers BOTH the bare path and the wildcard so an SPA-shell or redirect handler at the bare `/admin` path is also auth-gated (Hono's `/admin/*` glob does not match `/admin` exactly)
- `ws /ws/*` — placeholder; P3+

Returns `{adminMountPath: string | null}` so the caller can register its admin-bundle handler under the resolved prefix.

`apiHandler({manifest, capability_required, handler})` is the per-route capability-gate decorator. Returns 500 (always a Core author bug) when the manifest doesn't declare `capability_required`.

### `reconcile.ts` — `ReconciliationGuard` + `runReconciliation`

Per CM-DASHBOARD-PLAN § 4 — every Core that materializes derived tables registers guards comparing derived-table sums to source-of-truth direct queries. `runReconciliation([...])` throws `ReconciliationError` (carrying every failure, not just the first) when any guard's `|derived - source| / |source|` exceeds `threshold` (default `0.01` / 1%). Edge case: when source is 0, drift is 0 iff derived is also 0; otherwise infinite drift (always fails).

Guard `derived()` and `source()` may also throw — those collapse to `outcome: 'guard_error'` failures with the cause attached.

---

## Dev-mode stubs vs P3 prod implementations

| Surface | Dev (this SDK, today) | Prod (P3 platform-backed) |
|---|---|---|
| `validatePlatformJwt` | Low-level primitive; caller passes a pre-loaded JWKS object. | Same call signature, no change between dev/prod. |
| `buildPlatformJwtValidator` | High-level factory wrapping a `JwksCache` (1h TTL, stale-on-error). | Same call signature, no change between dev/prod. |
| `JwksCache` | Inlined in `cores/sdk/auth.ts` (lifted from `jwt-validator/validator.ts:JwksCache`). | Same — the inlined class IS the prod implementation. |
| `buildDevPlatformJwtValidator` | Accepts a single hardcoded bearer token; gated by `NEUTRON_DEV_AUTH=1`. | DELETED at the Core's prod-config import path. SDK exports remain for tests. |
| `SecretsAccessor` (prod factory) | Forwards to a duck-typed `PlatformSecretsStore` — works against any in-tests fake. | Forwards to `auth/secrets-store.ts:SecretsStore`; platform store handles AES envelope + audit-log write. |
| `buildDevSecretsAccessor` | Plaintext JSON file at `<core_data_dir>/.secrets-dev.json`. | DELETED at the Core's prod-config import path. Tests + dev boot only. |
| `mountCoreRoutes` | Auth middleware composes the supplied validator. | Same call signature; platform also injects rate-limit + audit middleware ahead of the Core's chain (P3 detail). |
| `runReconciliation` | Pure function, called by Core after every materialized refresh. | Same signature; Cores runtime ALSO fires this on a per-Core schedule (default daily) and surfaces failures in admin UI. |

The migration shape is "configuration swap, not API swap." Cores keep:

```ts
// config/auth.ts — unchanged shape across dev/prod cutover
export const validator = process.env.NODE_ENV === 'production'
  ? buildPlatformJwtValidator({jwks_url: JWKS_URL, expected_project_slug: SLUG})
  : buildDevPlatformJwtValidator({admin_email: 'user@example.com', bearer_token: 'dev-token-tabs', project_slug: SLUG})
```

The `validator` is the only thing that changes — the `mountCoreRoutes(app, {validator, ...})` call site stays unchanged.

---

## How to write a first-party Core

Walkthrough using a hypothetical `dtc-analytics` Core (Topline's actual use case). All paths are Core-relative.

### 1. Declare the manifest in your `package.json`

```json
{
  "name": "@neutron/dtc-analytics",
  "version": "0.1.0",
  "type": "module",
  "main": "./index.ts",
  "neutron": {
    "capabilities": [
      "read:project.db",
      "write:project.db",
      "read:dtc-analytics.db",
      "write:dtc-analytics.db",
      "connect:shopify",
      "connect:google-ads",
      "network:external"
    ],
    "tier_support": ["regular"],
    "tools": [
      {
        "name": "rebuild_cm_daily",
        "description": "Rebuild materialized cm_daily table.",
        "input_schema": { "type": "object", "properties": {} },
        "output_schema": { "type": "object", "properties": { "rows": { "type": "number" } } },
        "capability_required": "write:dtc-analytics.db"
      }
    ],
    "ui_components": [
      {
        "name": "DtcAnalyticsAdmin",
        "entry_point": "./admin/index.tsx",
        "surface": "route_mount",
        "mount_path": "/admin"
      }
    ],
    "billing_hooks": [],
    "linked_sources": [
      { "kind": "shopify",    "scope": "read", "target_kinds": ["user"] },
      { "kind": "google-ads", "scope": "read", "target_kinds": ["user"] },
      { "kind": "meta-ads",   "scope": "read", "target_kinds": ["user"] }
    ],
    "compat": { "coreApi": "^0.1.0" },
    "build": { "neutronVersion": "0.1.0" },
    "secrets": [
      {
        "name": "shopify_access_token",
        "kind": "byo_api_key",
        "label": "shopify",
        "scope": "read:orders read:products",
        "required": true,
        "install_prompt": "Paste your Shopify Admin API access token (read_orders + read_products scope)."
      },
      {
        "name": "google_ads_oauth",
        "kind": "oauth_token",
        "label": "google",
        "scope": "https://www.googleapis.com/auth/adwords",
        "required": true,
        "install_prompt": "Connect Google Ads — Acme Ventures owns the OAuth client."
      }
    ]
  }
}
```

### 2. Implement a `Connector` per third-party source

```ts
// connectors/shopify.ts
import type { Connector, ConnectorRow, ConnectorTestResult, WatermarkState } from '@neutron/cores-sdk'

interface ShopifyConfig { shop: string; access_token: string }
interface ShopifyOrderRow extends ConnectorRow {
  order_id: string
  total_price: number
}

export class ShopifyConnector implements Connector<ShopifyConfig, WatermarkState, ShopifyOrderRow> {
  readonly id = 'shopify'
  readonly capabilities = ['connect:shopify', 'network:external'] as const

  private state: WatermarkState = { last_seen_ts: 0 }

  async testConnection(cfg: ShopifyConfig): Promise<ConnectorTestResult> {
    const r = await fetch(`https://${cfg.shop}/admin/api/2024-10/shop.json`, {
      headers: { 'X-Shopify-Access-Token': cfg.access_token },
    })
    return r.ok ? { ok: true } : { ok: false, detail: `HTTP ${r.status}` }
  }

  async *fetchSince(cfg: ShopifyConfig, since: number): AsyncIterable<ShopifyOrderRow> {
    // ... bulk-op or page-walk; yield rows in ts order ...
  }

  async fetchSnapshot(cfg: ShopifyConfig): Promise<ShopifyOrderRow[]> {
    const rows: ShopifyOrderRow[] = []
    for await (const r of this.fetchSince(cfg, 0)) rows.push(r)
    return rows
  }

  getState(): Promise<WatermarkState> { return Promise.resolve(this.state) }
  setState(s: WatermarkState): Promise<void> { this.state = s; return Promise.resolve() }
}
```

### 3. Mount the routes + capability gate

```ts
// gateway.ts
import { Hono } from 'hono'
import { mountCoreRoutes, apiHandler, parseManifest, buildPlatformJwtValidator } from '@neutron/cores-sdk'
import pkg from './package.json' with { type: 'json' }

const manifest = parseManifest(pkg.neutron)

const app = new Hono()
const { adminMountPath } = mountCoreRoutes(app, {
  core_id: pkg.name,
  manifest,
  validator: buildPlatformJwtValidator({
    jwks_url: 'https://auth.example.test/.well-known/jwks.json',
    expected_project_slug: SLUG,
  }),
})

// Capability-gated tool route
app.post('/api/rebuild_cm_daily', apiHandler({
  manifest,
  capability_required: 'write:dtc-analytics.db',
  handler: async (c, auth) => {
    const rows = await rebuildCmDaily()
    return c.json({ rows })
  },
}))

// React admin bundle handler under the manifest-resolved prefix
if (adminMountPath !== null) {
  app.get(`${adminMountPath}/*`, serveAdminBundle)
}
```

### 4. Read secrets through `SecretsAccessor`

```ts
// secrets.ts
import { buildSecretsAccessor } from '@neutron/cores-sdk'

const secrets = buildSecretsAccessor({manifest}, {
  internal_handle: SLUG,
  store: platformSecretsStore, // injected — duck-typed against PlatformSecretsStore
  core_id: pkg.name,
})

// Throws CapabilityDeniedError if 'shopify' isn't in manifest.secrets[]
const shopifyToken = await secrets.get('byo_api_key', 'shopify')
```

### 5. Register reconciliation guards + invoke after every refresh

```ts
// transform/cm-daily.ts
import { runReconciliation, type ReconciliationGuard, DEFAULT_RECONCILIATION_THRESHOLD } from '@neutron/cores-sdk'

const totalSalesGuard: ReconciliationGuard = {
  metric: 'total_sales_30d',
  threshold: DEFAULT_RECONCILIATION_THRESHOLD,
  derived: () => duckdb.query('SELECT SUM(total_sales) FROM cm_daily WHERE date_pt >= today() - 30'),
  source:  () => duckdb.query('SELECT SUM(total_price) FROM shopify_orders WHERE created_at >= today() - 30'),
}

export async function rebuildCmDaily(): Promise<number> {
  await duckdb.exec('INSERT INTO cm_daily ... ')
  await runReconciliation([totalSalesGuard])  // throws ReconciliationError on >1% drift
  return rowCount
}
```

### 6. Wire up dev mode

```ts
// config/dev.ts
import { buildDevPlatformJwtValidator, buildDevSecretsAccessor } from '@neutron/cores-sdk'

const devValidator = buildDevPlatformJwtValidator({
  admin_email: 'user@example.com',
  bearer_token: 'dev-token-tabs',
  project_slug: SLUG,
})

const devSecrets = buildDevSecretsAccessor({manifest}, {
  file_path: `${CORE_DATA_DIR}/.secrets-dev.json`,
  core_id: pkg.name,
})
```

Both factories require `NEUTRON_DEV_AUTH=1` in the env (or `bypass_env_guard: true` in tests). The Core's prod-config branch never imports them.

---

## Per-Core data lifecycle (engineering-plan § A.3)

Per the locked decision: per-Core data lives in named tables in `project.db` by default, with a separate `<core>.db` only when a Core needs isolated lifecycle. Topline's `dtc-analytics` wants an isolated DuckDB analytical store, so it ships:

- `project.db` — Neutron-standard project state (users, sessions, OAuth tokens encrypted, audit log) — owned by the platform
- `dtc-analytics.db` — DuckDB analytical store (raw + materialized CM tables) — owned by the Core

The SDK is agnostic to which path a Core picks; the manifest's `capabilities[]` declares both:
- `read:project.db` / `write:project.db` for any Core
- `read:<core>.db` / `write:<core>.db` for Cores that ship an isolated store

The P3 install pipeline will allocate the on-disk file + register the capability strings; v1 SDK only validates the manifest declares them.

---

## Forward compatibility — what is locked vs not

**Locked v1 (won't change between SDK 0.x and P3 cutover):**

- `NeutronManifest` shape (the seven required fields)
- `Connector<TConfig, TState, TRow>` interface
- `validatePlatformJwt(token, jwks, options)` signature
- `SecretsAccessor.get/put/list` shape
- `mountCoreRoutes(app, options)` shape (the four surfaces)
- `ReconciliationGuard` + `runReconciliation` shape
- `CapabilityDeniedError`, `PlatformJwtError`, `ReconciliationError` constructor + `code` shape

**Not yet locked (may change between SDK 0.x and P3):**

- Closed-enum vs open-string capability list — current SDK accepts `<verb>:<resource>` strings; the P3 install pipeline will refuse unknowns. `core-sdk/types.ts:NeutronCapability` is the closed enum the Cores marketplace will reject manifests against.
- Audit-log shape — § D.10.5 names the columns; the SDK doesn't expose a read API yet.
- Per-Core scheduler integration (`fetchSince` cadence, retry-on-fail backoff) — P3 detail; the Core registers schedules at install time.
- WebSocket / SSE event shape for `/ws/*` — placeholder in the route helper; P3 ships the spec.

**Carve-outs that will land later (won't break v1 callers):**

- Telegram-channel Core surface mounting (P3+; new `surface: 'telegram_channel'` UI-component kind, additive)
- Multi-Core per-project runtime (P3+)
- Cores marketplace registry (P3+)
- Cross-project linked-source consent records (P3+)

---

## Relationship to `core-sdk/` (merged — X3)

**X3 — one manifest contract.** There is now a SINGLE manifest schema: this
package (`cores/sdk/manifest.ts`, Zod). The former `core-sdk/` hand validator
(`validateNeutronManifest()`, 650 lines) + its JSON-Schema mirror
(`manifest.schema.json`) had ZERO production callers and were deleted;
`core-sdk/` is now a one-release **path-shim** that re-exports the pure types +
the platform-known helpers (`KNOWN_CAPABILITIES`, `isKnownCapability`,
`isValidSemverRange`) from this package. New code imports `@neutronai/cores-sdk`.

Validate a manifest with `parseManifest` / `safeParseManifest` /
`NeutronManifestSchema`. The schema locks the required-fields list
(`capabilities`, `tier_support`, `tools`, `ui_components`, `billing_hooks`,
`linked_sources`, `secrets`, `compat`, `build`) and every field shape:

- **`tier_support` enum** — `'regular' | 'private' | 'both'`.
- **`linked_sources[]`** — `{kind, scope, target_kinds[]}` with free-form
  `kind` string (per § A.3.5; `KNOWN_LINKED_SOURCE_KINDS` is informational /
  marketplace-display only — values outside it still validate).
- **`billing_hooks[]`** — `{model, price_cents, currency, on_install?, on_uninstall?}`.
- **`secrets[]`** — per § D.10.4: `{name, kind, label, scope?, required, install_prompt}`.
- **`UiComponentSurface`** — `route_mount` requires `mount_path` (schema `superRefine`).
- **`compat.coreApi`** — semver-range syntax validated (`isValidSemverRange`,
  folded into this module; preserves the check the deleted hand validator had).

**Capabilities — open shape + known-platform set.** `CapabilitySchema`
validates the OPEN `<verb>:<resource>` string, so a Core can declare a
capability the platform doesn't enumerate (`connect:google-ads`, `read:notes.db`)
and it still validates + installs. The platform-KNOWN set (what X1's install
gate can enforce natively) is `KNOWN_CAPABILITIES`, consulted via
`isKnownCapability()` — consulted, never used to reject unknowns. This replaces
the former closed-union-vs-open-regex split (and the casts that bridged them at
`install-bundled.ts`).

---

## Test coverage (`cores/sdk/__tests__/`)

- `manifest.test.ts` — Zod parse / safeParse round-trips; required-field rejection; `route_mount` mount-path refinement; capability regex.
- `connector.test.ts` — type-only + an in-memory connector implementing the interface end-to-end.
- `auth.test.ts` — JWKS-based positive + negative paths; `expected_project_slug` cross-project safety; dev stub `NEUTRON_DEV_AUTH` guard.
- `secrets.test.ts` — capability-gate enforcement (declared → ok, undeclared → CapabilityDeniedError); dev-stub plaintext-roundtrip; `NEUTRON_DEV_AUTH` guard.
- `route.test.ts` — `/healthz` public; `/api/*` 401 without token, 200 with valid; admin mount path resolved from manifest; `apiHandler` 500 on undeclared capability.
- `reconcile.test.ts` — pass on no drift; throw on > threshold drift; throw on guard `derived()` exception; multi-failure aggregation.

---

## Out of scope (delegated to other sprints/phases)

- Real platform-backed implementations beyond stubs (P3)
- The `dtc-analytics` Core itself (Topline builds against this SDK; separate sprint)
- Cores marketplace registry, dependency resolver, billing meter aggregation (P3+)
- Multi-Core per-project runtime — Cores running side-by-side in one project (P3+)
- Telegram-channel Core surface mounting (P3+)
- Cross-project linked-source consent records (P3+)
