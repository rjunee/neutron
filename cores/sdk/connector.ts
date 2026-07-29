/**
 * @neutronai/cores-sdk — Connector interface.
 *
 * A Core implements a `Connector` per third-party data source it
 * integrates with (the reference `dtc-analytics` Core ships `ShopifyConnector`,
 * `GoogleAdsConnector`, etc.). The platform doesn't dictate transport
 * or pagination — every Connector composes the same shape so the Cores
 * runtime (P3) can drive them uniformly: schedule fetches, persist
 * watermarks, snapshot for reconciliation.
 *
 * Generics:
 * - `TConfig` — connection configuration (typically `{shop, accessToken}`
 *               for Shopify; `{customerId, refreshToken}` for Google
 *               Ads). Pulled from the per-project SecretsStore at runtime
 *               via `SecretsAccessor`.
 * - `TState`  — per-source persisted state (last-sync watermark,
 *               cursor, page token, bulk-op job id).
 * - `TRow`    — per-source row shape. MUST extend `ConnectorRow` so the
 *               row carries the `(project_slug, ts)` provenance the
 *               platform needs for project isolation + ordering.
 *
 * Contract guarantees the platform side will rely on (P3):
 * - `fetchSince` is the streaming primary path; the Cores runtime
 *   drives it incrementally and writes rows transactionally. It MAY
 *   pause / resume mid-stream — implementations MUST resume cleanly
 *   from the persisted `TState` on next call.
 * - `fetchSnapshot` is the bulk-pull path used for daily / weekly
 *   reconciliation rebuilds. Returns the full set of rows.
 *   Implementations MAY use the same upstream pagination as
 *   `fetchSince` but MUST NOT rely on `TState` for ordering.
 * - `testConnection` is invoked on the install-time "Test connection"
 *   button + on every Core boot. It MUST be idempotent and side-
 *   effect-free.
 *
 * Cross-refs:
 * - docs/engineering-plan.md § B.P3 (Cores runtime)
 * - docs/engineering-plan.md § D.10 (third-party auth + secrets — the
 *   `TConfig` of any production Connector resolves through SecretsStore)
 */

/**
 * Minimum row shape every connector returns. Cores enrich this with
 * source-specific columns; the runtime only reads `project_slug` and
 * `ts` for ordering / isolation.
 */
export interface ConnectorRow {
  /** Project the row belongs to. Stamped at fetch time, NEVER trusted
   *  from the upstream payload — provider responses don't know about
   *  Neutron projects. */
  project_slug: string
  /** Source-of-truth event timestamp in epoch ms. Connectors MUST
   *  derive this from upstream data, NOT `Date.now()`, so reconciliation
   *  guards (cores/sdk/reconcile.ts) can compare across rebuilds. */
  ts: number
}

/**
 * Result of `testConnection`. `ok: false` rows must explain why so the
 * admin UI's connection card can render an actionable diagnostic.
 */
export interface ConnectorTestResult {
  ok: boolean
  detail?: string
}

export interface Connector<
  TConfig,
  TState,
  TRow extends ConnectorRow,
> {
  /** Stable id (`shopify`, `google-ads`, `meta-ads`). The Cores runtime
   *  keys per-source state on this; once shipped, it's a forward-compat
   *  contract — never rename. */
  readonly id: string

  /** Capability strings this Connector requests at install. The runtime
   *  cross-checks against the manifest's `capabilities[]` block before
   *  it will dispatch a fetch. Empty = read-only-no-network connectors
   *  (rare; mostly for in-project data movers). */
  readonly capabilities: ReadonlyArray<string>

  /**
   * Verify `cfg` reaches the upstream and authenticates. MUST be
   * idempotent and side-effect-free. Used by the admin UI's "Test
   * connection" button and the Cores runtime's boot health-check.
   */
  testConnection(cfg: TConfig): Promise<ConnectorTestResult>

  /**
   * Stream rows newer than `since` (epoch ms). Implementations may
   * paginate / page-token internally; the consumer drives via
   * `for await`. The runtime persists a checkpoint after every N
   * rows (P3 detail) — implementations MUST NOT yield rows out of
   * `ts` order within a single call.
   *
   * Resumability: the runtime calls `getState()` after a transient
   * abort and re-invokes `fetchSince` with the watermark from there;
   * implementations MUST resume from that watermark cleanly.
   */
  fetchSince(cfg: TConfig, since: number): AsyncIterable<TRow>

  /**
   * Bulk-snapshot every row the source currently exposes. Used for
   * reconciliation rebuilds and for the first ingest after install
   * (when `since` would be 0). Implementations MAY make this a thin
   * wrapper around `fetchSince(cfg, 0)` collected into an array, but
   * SHOULD use the upstream's bulk-export pathway when available
   * (Shopify Bulk Operations, Meta Ads insights bulk-fetch, etc.) —
   * those don't burn the rate-limit window.
   */
  fetchSnapshot(cfg: TConfig): Promise<TRow[]>

  /** Read the current persisted per-source state. */
  getState(): Promise<TState>

  /** Persist updated per-source state. Runtime calls this after every
   *  successful fetch increment + on graceful shutdown. */
  setState(s: TState): Promise<void>
}

/**
 * Helper type for the most common `TState` shape — a single
 * monotonic watermark. Cores with simpler state can lift this verbatim:
 *
 * ```ts
 * class ShopifyConnector implements Connector<Cfg, WatermarkState, ShopifyOrderRow> {
 *   private state: WatermarkState = { last_seen_ts: 0 }
 *   getState() { return Promise.resolve(this.state) }
 *   setState(s: WatermarkState) { this.state = s; return Promise.resolve() }
 *   ...
 * }
 * ```
 */
export interface WatermarkState {
  /** Highest `ts` ingested so far; epoch ms. */
  last_seen_ts: number
}

/**
 * Helper type for connectors that page via an opaque cursor token.
 */
export interface CursorState {
  cursor: string | null
  last_seen_ts: number
}
