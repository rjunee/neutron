/**
 * @neutronai/gbrain-memory — raw MCP transport surface (BACKEND INTERNAL).
 *
 * `McpClient` is the low-level GBrain MCP transport: a single
 * `call(name, args)` that takes a raw GBrain operation name (`put_page`,
 * `add_link`, `get_links`, `remove_link`, `search`, `get_stats`, …) and
 * returns that tool's response payload. It is the ONLY surface through which a
 * raw backend op can be named + executed.
 *
 * RA5 / invariant I2 — THE ENFORCED GUARANTEE: no product-scope module can
 * OBTAIN a raw transport instance through any of:
 *   (i)   IMPORTING the sealed type — this `McpClient` (+ `GBrainStdioMcpClient`)
 *         lives in its OWN gbrain-memory-internal module, NOT the permitted
 *         contract files (`memory-store.ts` = typed `MemoryStore`,
 *         `agent-tool.ts` = `memory_search`), and the depcruise
 *         `memory-backend-swap-seam` rule forbids product code importing it, so
 *         product code can't even NAME the type.
 *   (ii)  the COMPOSER WIRING — `build-gbrain-memory.ts` keeps the transport a
 *         local and returns only the typed `MemoryStore` (compile-time probe).
 *   (iii) a connect PROVIDER surface — the type-checker acquisition scan
 *         (alias / re-export / generic resolved) flags any connect export that
 *         hands out a transport.
 * Since product code has no SOURCE for a raw client, it can make no raw call on
 * one — literal or dynamic. OUT OF SCOPE (accepted, documented): deliberate
 * type-ERASING param-echo laundering written INSIDE the trusted, reviewed
 * connect/ backend boundary — connect is a reviewed integration boundary, and
 * that path additionally presupposes an already-obtained client that acquisition
 * denies. A backend swap re-implements this interface + `gbrain-memory/`
 * internals only.
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
