/**
 * gateway/composition/types.ts — shared primitive types for the composition
 * layer, in a dependency-free leaf.
 *
 * Extracted in R5 (audit P2-5) so the per-concern input interfaces and the
 * extracted sub-builders can import these without importing `composition.ts`
 * back (which imports them) — that would re-introduce the composition.ts ↔
 * composition/* import cycles. `composition.ts` re-exports `CompositionHttpHandler`
 * so external importers see the same public surface.
 */

/**
 * HTTP handler signature shared by the default-fallback stub and every
 * surface mounted by `composeProductionGraph`. Mirrors `HttpHandler` in
 * `gateway/index.ts` (kept duplicated to avoid a circular import —
 * `gateway/index.ts` already imports from the composition layer).
 */
export type CompositionHttpHandler = (req: Request) => Response | Promise<Response>
