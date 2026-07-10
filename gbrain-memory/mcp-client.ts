/**
 * @neutronai/gbrain-memory — raw MCP transport surface (BACKEND INTERNAL).
 *
 * `McpClient` is the low-level GBrain MCP transport: a single
 * `call(name, args)` that takes a raw GBrain operation name (`put_page`,
 * `add_link`, `get_links`, `remove_link`, `search`, `get_stats`, …) and
 * returns that tool's response payload. It is the ONLY surface through which a
 * raw backend op can be named + executed.
 *
 * RA5 / invariant I2 — THE ENFORCED INVARIANT: no product-scope module can
 * OBTAIN a raw transport instance, so it can't make ANY raw call on one (literal
 * OR fully-dynamic). That ACQUISITION BOUNDARY rests on three layers:
 *   (1) TYPE-SEAL — this `McpClient` (+ `GBrainStdioMcpClient`) lives in its OWN
 *       gbrain-memory-internal module, NOT in the permitted contract files
 *       (`memory-store.ts` = typed `MemoryStore`, `agent-tool.ts` =
 *       `memory_search`). If it lived in the permitted `memory-store.ts` a
 *       product module could import it and call `client.call('put_page', …)`.
 *   (2) IMPORT-BAN — the depcruise `memory-backend-swap-seam` rule forbids a
 *       product module importing this module (or any adapter / the stdio
 *       transport), so it can't even NAME the type.
 *   (3) NO WIRING LEAK — see below: the one composition module that DOES import
 *       the transport keeps it local and returns only the typed `MemoryStore`.
 * A backend swap re-implements this interface + `gbrain-memory/` internals only.
 *
 * The return is `unknown` because each GBrain MCP tool returns a different
 * shape (`get_links` returns edge rows, `add_link` returns an ack). Callers
 * narrow at the call site.
 *
 * Production wires `GBrainStdioMcpClient` (spawns `gbrain serve`); tests wire an
 * in-process client backed by a real PGLite brain. The legitimate holders of an
 * `McpClient` are the `gbrain-memory/` adapters (`GBrainMemoryStore`,
 * `GBrainSyncHook`) and the `connect/` federation mirror (which the swap-seam
 * rule exempts), never a product surface. Critically, the composer that builds
 * the production transport (`gateway/realmode-composer/build-gbrain-memory.ts`,
 * an exempt module) keeps the `GBrainStdioMcpClient` as a LOCAL and returns ONLY
 * the typed `MemoryStore` (+ syncHook + close) on `GBrainMemoryWiring` — it does
 * NOT surface the transport, so product code cannot reach a raw op even through
 * the one composition module allowed to import it.
 */
export interface McpClient {
  call(name: string, args: Record<string, unknown>): Promise<unknown>
}
