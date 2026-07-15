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

/**
 * RA2 (gbrain live-or-loud) — a coarse, NON-sensitive summary of the memory
 * backend's health, surfaced through the UNAUTHENTICATED `/healthz` liveness
 * probe so a missing/broken gbrain backend is a LOUD, monitorable "degraded"
 * signal instead of a silent no-op (recall quietly falling back to file-grep).
 *
 * Coarse BY DESIGN: `/healthz` is unauthenticated (load-balancer liveness), so
 * this must NEVER carry an internal identifier a report leak would expose
 * (latch reasons with paths, credential cooldowns, REPL pids). The RICH,
 * owner-gated view stays at `GET /api/app/admin/diagnostics` (the `gbrain`
 * section) — this is only the boolean + one non-sensitive sentence a monitor
 * alerts on.
 */
export interface MemoryHealthSummary {
  /** false → the memory backend (gbrain) is unavailable; recall degraded to file-grep. */
  available: boolean
  /** A coarse, non-sensitive one-liner (no paths/pids) safe for the unauthenticated `/healthz`. */
  detail?: string
}

/**
 * A thunk the boot shell evaluates at each `/healthz` request to fold the
 * memory backend's health into the liveness body. Evaluated per-request (not
 * snapshotted) so a future enrichment can reflect live latch state without a
 * contract change; the current source is the boot-time binary-presence probe,
 * which is stable for the process lifetime (a missing binary can't appear
 * without a restart).
 */
export type MemoryHealthProvider = () => MemoryHealthSummary
