/**
 * @neutronai/runtime — Connect API structural types (Sprint B, 2026-05-20).
 *
 * Structural type aliases for the Neutron Connect (instance ↔ instance)
 * API. Lifted out of `connect/api/` so core composition
 * code (`gateway/composition.ts`) can describe the handler bundle that
 * flows through `PlatformAdapter.connectApiHandlers?()` without
 * taking an import edge on the Managed connect-api implementation.
 *
 * The Managed implementations (`connect/api/server.ts:
 * ConnectApiHandlers`, `connect/api/jwt-bearer-
 * middleware.ts:JwtBearerMiddlewareOptions`) structurally satisfy these
 * aliases — no `extends` relationship needed, TypeScript structural
 * typing closes the gap.
 *
 * Open code never constructs these — the corresponding adapter method
 * on `LocalPlatformAdapter` returns null and the connect API
 * surface never mounts on Open self-hosted single-instance boxes.
 */

import type { JwksCache } from '../jwt-validator/index.ts'

/**
 * Structural alias for the JWT-bearer auth context the connect API
 * derives from the inbound JWT. Mirrors the Managed concrete
 * (`connect/api/jwt-bearer-middleware.ts:
 * ConnectAuthContext`) field-for-field so values constructed in
 * either tree are mutually assignable. Core composition only reads
 * `origin_instance_slug` + `origin_user_id`; the additional
 * `scopes`/`memberships` arrays flow through unread but the shape match
 * keeps assignment from Managed concrete values clean.
 *
 * `memberships` mirrors the JWT `Membership` shape (`jwt-validator/
 * claims.ts`) inline (NOT imported) so this file holds no edge on the
 * JWT validator's claim ontology. Core composition never inspects the
 * values, only threads the array through.
 */
export interface ConnectAuthContext {
  readonly origin_instance_slug: string
  readonly origin_user_id: string
  readonly scopes: ReadonlyArray<string>
  readonly memberships: ReadonlyArray<{
    readonly slug: string
    readonly role: string
    readonly kind: string
  }>
}

/**
 * Structural alias for the connect project descriptor the receiver
 * returns from `list_projects`. Same kind/owning_instance_slug shape the
 * Managed `connect/api/server.ts:ProjectRef` exports. `owning_instance_slug`
 * is the connect WIRE field; both trees declare it identically so values
 * cross the seam structurally assignable.
 */
export interface ProjectRef {
  project_id: string
  display_name: string
  kind: 'solo' | 'group'
  owning_instance_slug: string
}

/**
 * Narrow structural alias for the connect handler bundle. Both
 * handlers are optional so the Managed server can mount partial
 * surfaces during incremental rollout.
 *
 * Parameters use `any` deliberately. The Managed concrete handlers in
 * `connect/api/server.ts` and `handlers/on-inbound-
 * message.ts` accept strictly-typed context + message arguments
 * (`ConnectAuthContext`, `TaggedContent<IncomingMessage>`). Under
 * TypeScript's contravariant function-parameter rules, those concrete
 * types are NOT assignable to a parameter typed as `unknown`. Core
 * code never inspects these argument shapes — it just threads the
 * handler bundle through the composer — so `any` keeps the structural
 * subtype relation working without leaking Managed types into core.
 */
export interface ConnectApiHandlers {
  /** Inbound message handler — receiver side of workspace fan-out. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on_inbound_message?: (ctx: any, msg: any) => Promise<{ ack_id: string }>
  /**
   * Project-list handler — member view of group + solo projects. The
   * return type is `ProjectRef[]` (mutable array, not ReadonlyArray) to
   * match the Managed concrete signature exactly; the structural alias
   * makes the Managed implementation directly assignable here without a
   * cast.
   */
  list_projects?: (ctx: ConnectAuthContext) => Promise<ProjectRef[]>
  /**
   * Neutron Connect (M2.6 Ph2) member-identity resolver — CONNECT-NODE ONLY.
   * Structural alias for the Managed concrete
   * (`connect/api/server.ts:ConnectApiHandlers.resolve_member`).
   * When set, `POST /messages` re-namespaces the routed turn to the resolved
   * member's `local_slug` (or 403s a revoked/unknown caller). `any` parameter
   * for the same contravariance reason as `on_inbound_message` above; core
   * composition only threads the handler through, never inspects it.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  resolve_member?: (ctx: any) => Promise<MemberResolution>
  /**
   * Neutron Connect (M2.6 Ph3) public guest-auth handshake — CONNECT-NODE ONLY.
   * Structural alias for the Managed concrete
   * (`connect/api/server.ts:ConnectApiHandlers.guest_auth`). The
   * pre-authenticated `POST /connect/guest-auth` endpoint that mints a guest
   * bearer. Core composition only threads it through, never inspects it.
   */
  guest_auth?: (req: Request) => Promise<Response>
  /**
   * Neutron Connect (M2.6 Ph5) public, read-only, NON-CONSUMING invite preview —
   * CONNECT-NODE ONLY. Structural alias for the Managed concrete
   * (`connect/api/server.ts:ConnectApiHandlers.invite_preview`).
   * Core composition only threads it through, never inspects it.
   */
  invite_preview?: (req: Request) => Promise<Response>
  /**
   * Neutron Connect (M2.6 Ph5) guest-bearer refresh — CONNECT-NODE ONLY.
   * Structural alias for the Managed concrete
   * (`connect/api/server.ts:ConnectApiHandlers.guest_refresh`).
   * `any` ctx for the same contravariance reason as the other connect handlers.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  guest_refresh?: (ctx: any) => Promise<Response>
  /**
   * Neutron Connect (M2.6 Ph5) cross-instance trusted-member accept —
   * CONNECT-NODE ONLY. Structural alias for the Managed concrete
   * (`connect/api/server.ts:ConnectApiHandlers.trusted_accept`).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  trusted_accept?: (ctx: any, req: Request) => Promise<Response>
}

/**
 * Structural alias for the connect member-resolution result. Mirrors the
 * Managed concrete (`connect/api/server.ts:MemberResolution`). The
 * optional `role` is the SERVER-RESOLVED role (owner|collaborator) — read from
 * the stored member row, never a token claim, and display-only. `access`
 * (read|write) drives the post-boundary gate (connect-spec §1.4) and
 * `display_name` seeds the author envelope (connect-spec §4); both are likewise
 * server-resolved from the stored row, never a token claim.
 */
export type MemberResolution =
  | {
      ok: true
      local_slug: string
      role?: 'owner' | 'collaborator'
      access?: 'read' | 'write'
      display_name?: string
    }
  | { ok: false; status: 403; reason: string }

/**
 * Structural alias for the JWT-bearer middleware options the
 * connect API server requires. Mirrors the Managed concrete
 * (`connect/api/jwt-bearer-middleware.ts:
 * JwtBearerMiddlewareOptions`) field-for-field so Managed-side
 * constructed values are directly assignable to the alias.
 *
 * The `jwks` field uses the OSS `JwksCache` from `jwt-validator/`
 * (already part of the public tree) — no Managed edge.
 *
 * `receiving_instance_slug` is the connect WIRE field; both trees declare it
 * identically so Managed-side constructed values stay structurally assignable.
 */
export interface JwtBearerMiddlewareOptions {
  /** JWKS cache pointing at the identity service. */
  jwks: JwksCache
  /** Slug of the instance hosting THIS connect API. */
  receiving_instance_slug: string
  /** Optional injection point for the slug the caller claims to speak as. */
  read_claimed_origin?: (req: Request) => string | null
  /** Optional clock override (tests). */
  now?: () => number
}

/**
 * Bundled return shape of `PlatformAdapter.connectApiHandlers?()`.
 * When the adapter returns this bundle the composer mounts the
 * instance ↔ instance connect API on the per-instance HTTP listener;
 * when the adapter returns null the surface stays unmounted.
 */
export interface ConnectApiBundle {
  handlers: ConnectApiHandlers
  jwtMiddleware: JwtBearerMiddlewareOptions
}
