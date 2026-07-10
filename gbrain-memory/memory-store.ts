/**
 * @neutronai/gbrain-memory — `MemoryStore` backend-neutral CONTRACT surface.
 *
 * The per-instance memory substrate is **GBrain** (`github.com/garrytan/gbrain`):
 * a Postgres-native (PGLite for OSS / Postgres for Managed) personal knowledge
 * brain. Neutron talks to it over GBrain's MCP (`gbrain serve`) — `put_page`,
 * `add_link`, `get_links`, `remove_link`, `search`, `get_stats`.
 *
 * This module is the BACKEND-NEUTRAL contract the rest of Neutron programs
 * against — the read/write recall surface the admin "Memory" tab + the
 * `memory_search` agent tool use. It exposes only typed methods
 * (`add`/`query`/`delete`/`stats`); it deliberately does NOT expose the raw
 * op-name transport. That transport (`McpClient.call(name, args)`) lives in the
 * sibling `mcp-client.ts` as a BACKEND INTERNAL so no product module can name a
 * raw GBrain op through this permitted seam (RA5 / invariant I2 — enforced by
 * the depcruise `memory-backend-swap-seam` rule). A future backend swap
 * re-implements `MemoryStore` (+ the `mcp-client.ts` transport + the
 * `gbrain-memory/` adapters) rather than churning every call site again.
 *
 * **Cross-instance safety.** The caller is responsible for instantiating the
 * transport already scoped to the instance — the per-instance systemd unit sets
 * `GBRAIN_BRAIN_ID` / `GBRAIN_SOURCE` before launching `gbrain serve` (see
 * `docs/architecture/memory-adapter-gbrain-2026-06-06.md`). Nothing here
 * cross-checks instance identity; the contract assumes the client is the right
 * one.
 */

/**
 * Per-instance memory backend (GBrain). Plugs in behind this interface so the
 * admin browse surface stays substrate-neutral.
 */
export interface MemoryStore {
  /**
   * Persist a single memory item. Backend assigns + returns a stable id.
   * `metadata` is opaque key/value to the contract; GBrain maps it onto the
   * page's frontmatter / provenance columns but no field is required.
   */
  add(input: {
    content: string
    metadata?: Record<string, unknown>
  }): Promise<{ id: string }>

  /**
   * Semantic / textual recall. Returns the top `limit` matches ranked by
   * `score` (descending). `filter` is opaque structured filtering; backends
   * that don't implement it MUST ignore unknown keys rather than throw.
   */
  query(input: {
    query: string
    limit?: number
    filter?: Record<string, unknown>
  }): Promise<
    Array<{
      id: string
      content: string
      metadata: Record<string, unknown>
      score: number
    }>
  >

  /** Hard delete by id. Idempotent — missing id MUST resolve, not throw. */
  delete(input: { id: string }): Promise<void>

  /** Per-store stats — sized for monitoring + budget enforcement. */
  stats(): Promise<{ count: number; size_bytes: number }>
}

/**
 * 2026-06-10 (wow-hang-resilience) — thrown by `GBrainStdioMcpClient`
 * when the `gbrain` binary is permanently unreachable (not on PATH /
 * spawn ENOENT). The condition is latched: after the first detection
 * every subsequent `call(...)` throws this immediately WITHOUT
 * re-attempting the spawn, so a host without gbrain installed degrades
 * to one cheap throw per op instead of a spawn-fail-log storm (prod
 * incident t-33333333: "[gbrain-sync-hook] stage=gbrain_put_page …
 * err=Executable not found in $PATH: gbrain" repeated for every entity
 * page + edge). Consumers (notably `GBrainSyncHook`) use this type to
 * log the degradation ONCE and short-circuit further sync work.
 *
 * Lives here (the shared interface module) rather than in the stdio
 * client so consumers can `instanceof`-check without importing the
 * transport implementation.
 */
export class GBrainUnavailableError extends Error {
  constructor(detail: string) {
    super(`gbrain unavailable: ${detail}`)
    this.name = 'GBrainUnavailableError'
  }
}

/**
 * Match the spawn-failure shapes that mean "the gbrain binary does not
 * exist on this host" (permanent until installed): Bun's "Executable
 * not found in $PATH", node's spawn ENOENT.
 */
export function isGbrainBinaryMissingError(err: unknown): boolean {
  if (err instanceof GBrainUnavailableError) return true
  const msg = err instanceof Error ? err.message : String(err ?? '')
  return /executable not found|ENOENT/i.test(msg)
}
