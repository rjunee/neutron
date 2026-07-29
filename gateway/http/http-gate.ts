/**
 * @neutronai/gateway/http — the ONE auth-gate seam (C5b).
 *
 * Before C5b the live browser login path had TWO gate implementations wired
 * through DIFFERENT seams:
 *
 *   - Managed owner-gated mode wrapped the WHOLE route ladder via
 *     `composition.auth_gate` (an `AuthGateOptions` decision object consumed by
 *     `evaluateAuthGate`) — OAuth-backed, 302s a tokenless browser to the
 *     identity service, verifies a `?start=` JWT cryptographically.
 *
 *   - Open anonymous mode wired the single-owner `openFetch` as
 *     `landing_server.fetch` — a serving wrapper deep in the landing rung that
 *     mints the owner cookie locally, cold-starts, and injects the React shell.
 *
 * C5b resolves the duality onto ONE seam: `composition.auth_gate` now carries an
 * `HttpGate` for BOTH modes, and `composeHttpHandler` dispatches every gated
 * request through the single `gate.apply(...)` call. Each mode supplies its own
 * `HttpGate` implementation (Managed: `buildManagedAuthGate`; Open:
 * `buildOpenOwnerGate().gate`), so the behavior of each mode is unchanged — only
 * the wiring is unified.
 *
 * The seam is a middleware: `apply` receives the request, the Bun server, and a
 * `next` that dispatches the downstream route ladder. It returns the final
 * Response — either a terminal one the gate produced itself (a redirect, or, in
 * Open mode, the served-and-injected shell) OR the downstream response with the
 * gate's cookie stitched on (APPEND, never replace).
 */

import type { Server } from 'bun'

export interface HttpGate {
  /**
   * Apply the gate to a single user-facing request.
   *
   * @param req    the incoming request.
   * @param server the Bun server (needed by surfaces that upgrade WebSockets;
   *               Managed's decision gate ignores it, Open's serving gate
   *               forwards it to the landing fetch).
   * @param next   dispatch the downstream route ladder. A gate that wants the
   *               underlying surface to serve calls `next()` and MAY stitch a
   *               `Set-Cookie` onto the result (append — never replacing a
   *               cookie the surface itself set). A gate that terminates the
   *               request (redirect, or a self-served response) returns without
   *               calling `next()`.
   */
  apply(
    req: Request,
    server: Server<unknown>,
    next: () => Promise<Response>,
  ): Promise<Response>
}
