/**
 * @neutronai/gbrain-memory — the canonical set of RAW GBrain MCP operation
 * names (RA5 / invariant I2 — SINGLE SOURCE OF TRUTH).
 *
 * These are the low-level op names the memory backend exposes over its MCP
 * transport (`McpClient.call(name, args)` in `mcp-client.ts`). They are the
 * strings a raw `.call('<op>', …)` names — the exact surface RA5 §(b) forbids
 * product modules from reaching for. The list lives HERE, once, so the
 * source-text conformance guard (`__tests__/raw-op-seam-ban.test.ts`) can't
 * drift from what the seam actually calls:
 *
 *   - the guard's op-name BAN-LIST is derived from this constant, and
 *   - an anti-drift check in that same test asserts every op the production
 *     GBrain adapters actually pass to `mcp.call(…)` is a member here — so a
 *     newly-added backend op forces an update to this one list, which the ban
 *     then automatically covers.
 *
 * WHY A SOURCE-TEXT BAN (not just the depcruise import rule): `McpClient` is a
 * purely STRUCTURAL interface — a product module could declare its own
 * identically-shaped `{ call(name, args) }` type with ZERO gbrain import and
 * call `client.call('put_page', …)`, which the import-edge depcruise rule has
 * no edge to reject. The op-NAME scan closes that structural bypass; the
 * depcruise import ban stays as belt-and-suspenders.
 *
 * Legitimate holders of the raw transport (which therefore legitimately name
 * these ops) are the `gbrain-memory/` adapters and the `connect/` federation
 * mirror — both exempted by the guard, mirroring the depcruise rule's exempt
 * set. Everything else must go through the typed `MemoryStore` methods.
 */
export const GBRAIN_MCP_OP_NAMES = [
  'put_page',
  'get_page',
  'delete_page',
  'list_pages',
  'search',
  'get_stats',
  'add_link',
  'get_links',
  'remove_link',
] as const

export type GbrainMcpOpName = (typeof GBRAIN_MCP_OP_NAMES)[number]
