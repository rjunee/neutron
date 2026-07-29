/**
 * @neutronai/contracts — MCP tool-resolver callable shape (L2 leaf).
 *
 * L2 (2026-07) — `McpToolResolver` extracted VERBATIM out of
 * `runtime/adapters/openai-responses/mcp-shim.ts` into this node-free leaf
 * (critic-layering.md §2.1 edge #11: `mcp → runtime`). `mcp/server.ts` now
 * imports the type directly from here instead of reaching into `runtime`,
 * severing that edge. `mcp-shim.ts` keeps a re-export so any other existing
 * import specifier (e.g. `runtime/adapters/openai-responses/index.ts`) stays
 * valid (test-policy §2.2 barrel rule).
 */

export interface McpToolResolver {
  /**
   * Resolve a tool call against the per-instance MCP server. The resolver is
   * the boundary between "substrate" and "tool runtime" — at S3 the per-instance
   * MCP server hasn't shipped yet, so callers can pass a minimal in-process
   * resolver for tests. P1 S4 lands the production resolver.
   *
   * Returns the JSON-serialisable result. Throws to signal a tool-runtime
   * error; the shim surfaces those as an `error` event with `retryable: false`.
   */
  (call: { call_id: string; tool_name: string; args: unknown }): Promise<unknown>
}
