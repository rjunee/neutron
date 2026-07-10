/**
 * @neutronai/gbrain-memory — raw MCP transport surface (BACKEND INTERNAL).
 *
 * `McpClient` is the low-level GBrain MCP transport: a single
 * `call(name, args)` that takes a raw GBrain operation name (`put_page`,
 * `add_link`, `get_links`, `remove_link`, `search`, `get_stats`, …) and
 * returns that tool's response payload. It is the ONLY surface through which a
 * raw backend op can be named + executed.
 *
 * RA5 / invariant I2 — WHY THIS LIVES IN ITS OWN MODULE (not in
 * `memory-store.ts`): the depcruise `memory-backend-swap-seam` rule permits
 * product modules to import the backend-neutral contract files
 * (`memory-store.ts` = the typed `MemoryStore` interface, `agent-tool.ts` = the
 * `memory_search` tool) but forbids importing any other `gbrain-memory/`
 * internal. If `McpClient` lived in the permitted `memory-store.ts`, a product
 * module could import it (a permitted edge) and call `client.call('put_page',
 * …)` — a stray backend op the import-edge rule can't see. Keeping the
 * op-name-taking surface HERE, off the allowlist, means no product module can
 * even name a raw op: the swap seam is a real compile-time type boundary, so a
 * backend swap re-implements this interface + `gbrain-memory/` internals only.
 *
 * The return is `unknown` because each GBrain MCP tool returns a different
 * shape (`get_links` returns edge rows, `add_link` returns an ack). Callers
 * narrow at the call site.
 *
 * Production wires `GBrainStdioMcpClient` (spawns `gbrain serve`); tests wire an
 * in-process client backed by a real PGLite brain. The legitimate holders of an
 * `McpClient` are the `gbrain-memory/` adapters (`GBrainMemoryStore`,
 * `GBrainSyncHook`) and the `connect/` federation mirror (which the swap-seam
 * rule exempts), never a product surface.
 */
export interface McpClient {
  call(name: string, args: Record<string, unknown>): Promise<unknown>
}
