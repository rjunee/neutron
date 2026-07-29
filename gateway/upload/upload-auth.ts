/**
 * @neutronai/gateway/upload — S1/S2 owner-bearer auth shim for the upload surfaces.
 *
 * The `/api/upload/*` routes are in the NON-GATED HTTP route set (the landing
 * session cookie wouldn't survive the cross-origin POST — see
 * `gateway/http/compose.ts`), and BOTH upload handlers
 * (`import-upload-handler.ts` single-shot + `chunked-upload-handler.ts`) default
 * their `auth` seam to allow-all. On a LOOPBACK bind that is fine — the box is
 * only reachable from the machine itself (single-owner-local). On a WIDE
 * (non-loopback) bind (`NEUTRON_HOST=0.0.0.0` / a LAN address) it is a hole:
 * any network client could POST an attacker-controlled export ZIP into
 * `<owner_home>/imports/` and kick the import pipeline with NO bearer / cookie /
 * origin. This is the same wide-bind fail-closed guarantee S1/S2
 * (`gateway/boot-bind-policy.ts`) built for every SIBLING surface (app-ws /
 * docs / project-credentials), which this shim MIRRORS.
 *
 * Behaviour (mirrors the app-ws `appOwnerAuth` gate in `open/composer.ts` +
 * `gateway/http/app-ws-surface.ts` exactly):
 *   - LOOPBACK bind → always `{ ok: true }` (unchanged dev ergonomics — the
 *     127.0.0.1 dogfood, tests, a bare `bun start`).
 *   - WIDE bind     → `{ ok: true }` iff the request carries
 *                     `Authorization: Bearer <ownerBearer>` (constant-time
 *                     compared to the SAME per-install owner bearer the app-ws /
 *                     docs / credentials surfaces require; `server.ts` refuses to
 *                     boot a wide bind whose bearer is only ephemeral, so on a
 *                     wide bind this is a stable per-install credential). Any
 *                     missing / malformed / mismatched bearer → `{ ok: false }`
 *                     and the handler 401s BEFORE any body parse, disk write, or
 *                     engine notify.
 */

import { constantTimeEqual } from '@neutronai/runtime/constant-time-equal.ts'

export interface UploadOwnerBearerAuthInput {
  /** True when the gateway binds ONLY the loopback interface
   *  (`isLoopbackBindHost`). Allow-all on loopback; enforce on a wide bind. */
  bindIsLoopback: boolean
  /** The per-install owner bearer (== the app-ws token / `selectAppWsToken`).
   *  On a wide bind this is guaranteed PERSISTENT by `assertOwnerCredentialPolicy`. */
  ownerBearer: string
}

/** Result shape shared by BOTH upload handlers' `auth` seams
 *  (`ImportUploadAuthResult` / `ChunkedUploadAuthResult`). */
export interface UploadAuthResult {
  ok: boolean
}

/**
 * Build the upload `auth` shim. The returned validator satisfies BOTH
 * `ImportUploadDeps.auth` and `ChunkedUploadDeps.auth` (identical contract), so
 * the single-shot and chunked handlers gate identically.
 */
export function buildUploadOwnerBearerAuth(
  input: UploadOwnerBearerAuthInput,
): (req: Request) => Promise<UploadAuthResult> {
  const { bindIsLoopback, ownerBearer } = input
  return async (req: Request): Promise<UploadAuthResult> => {
    // Loopback bind — single-owner-local box, allow-all (unchanged dev behaviour).
    if (bindIsLoopback) return { ok: true }
    // Wide bind — a real owner bearer is mandatory. A blank configured bearer
    // (should be impossible: `server.ts` refuses to boot a wide bind without a
    // persistent one) rejects everything rather than accepting a blank token.
    if (ownerBearer.length === 0) return { ok: false }
    const header = req.headers.get('authorization') ?? ''
    if (!header.toLowerCase().startsWith('bearer ')) return { ok: false }
    const token = header.slice('bearer '.length).trim()
    if (token.length === 0) return { ok: false }
    return { ok: constantTimeEqual(token, ownerBearer) }
  }
}
