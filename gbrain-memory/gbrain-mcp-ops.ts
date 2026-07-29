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
 *   - an anti-drift check in that same test walks the production GBrain adapters
 *     with the SAME AST visitor and asserts every op they actually pass to a
 *     `.call('<literal>', …)` (receiver-agnostic — any transport name) is a
 *     member here, so a newly-added backend op forces an update to this one
 *     list, which the ban then automatically covers.
 *
 * WHERE THE GUARANTEE LIVES (honest scoping): the AUTHORITATIVE barrier against
 * a product module making ANY raw GBrain call — including a fully-dynamic
 * `client.call(fetchName(), …)` — is the TYPE-SEAL + depcruise IMPORT-BAN:
 * `McpClient` is internal to `gbrain-memory/` and the `memory-backend-swap-seam`
 * rule forbids product code from importing it (or any adapter / the stdio
 * transport), so product code can never OBTAIN a real transport instance. The
 * AST op-NAME scan is DEFENSE-IN-DEPTH on top of that: it catches a raw op name
 * written as a literal or a trivially-constant expression (the accidental
 * copy-paste / structural-lookalike case) — seeing through bracket access,
 * optional chaining, comment/whitespace trivia, and bounded const-folding — but
 * it does NOT (and cannot) catch a fully-dynamic computed name; that case is
 * covered by the type+import layer, by design.
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
