/**
 * @neutronai/gateway/http — HTTP surface-kit.
 *
 * O7 (world-class-refactor plan §O7) — every per-instance `gateway/http`
 * surface (`app-*-surface.ts`, `admin-*-surface.ts`, `cores-*-surface.ts`,
 * `codex-credential-surface.ts`, `project-credentials-surface.ts`,
 * `work-board-surface.ts`) hand-rolled its own byte-identical copy of:
 *
 *   - `resolveBearer` — parse `Authorization: Bearer <token>` + resolve it
 *     via the surface's `AppWsAuthResolver` (19 verbatim copies)
 *   - `jsonError` / `jsonOk` / `jsonResponse` — the `{ ok, ... }` JSON
 *     response envelope (13 verbatim `jsonError` copies; every surface also
 *     had its own `jsonOk` / `jsonResponse`)
 *   - `readJsonBody` — parse a JSON request body, `null` on any failure
 *     (12 verbatim copies)
 *   - the `ResolvedAuth` / `AuthFailure` handler interfaces (21 identical
 *     copies)
 *
 * This module is the ONE canonical implementation; every surface deletes
 * its copy and imports from here.
 *
 * CRITICAL — byte-identical wire output: the Expo client parses `jsonError`'s
 * `{ ok: false, code, message }` shape (field order + the stable `code`
 * strings) and `jsonOk`'s `{ ok: true, ...body }` shape. This module must
 * NEVER change field order, add/drop a field, or alter a `code` string.
 * Pinned by `__tests__/surface-kit-wire.test.ts`.
 *
 * `chat-history-surface.ts` and `chat-topics-surface.ts` are the two
 * exceptions: their pre-existing `jsonOk` / `jsonError` set
 * `content-type: application/json; charset=utf-8` (every other surface
 * sets plain `application/json`). That's a pre-existing, harmless
 * discrepancy — O7 is a pure dedup, not a wire-behavior change, so those
 * two files keep tiny local wrappers around this module's `jsonResponse`
 * that pin the charset rather than silently normalizing it away.
 *
 * `ownerIdentityMismatch` / `ownerSlugMismatch` (+ the owner-handle-resolver
 * helpers) stay defined in `./auth-helpers.ts` — that module has its own
 * dedicated source-text guardrail test
 * (`__tests__/owner-slug-timing-safe.test.ts`) pinned to
 * `from './auth-helpers.ts'`, so relocating them would require rewriting a
 * security invariant test as a side effect of a pure-dedup unit. Folding
 * them into the kit means re-exporting them here so every surface can reach
 * the full bearer/JSON/slug-identity toolkit through one import.
 */

import type { AppWsAuthResolver } from '@neutronai/channels/adapters/app-ws/auth.ts'

export {
  buildOwnerHandleResolver,
  ownerIdentityMismatch,
  ownerSlugMismatch,
  type OwnerHandleLookup,
  type OwnerHandleResolver,
} from './auth-helpers.ts'

/** Successful bearer resolution: the caller's identity + instance slug. */
export interface ResolvedAuth {
  user_id: string
  project_slug: string
}

/** Bearer resolution failure — the `AppWsAuthResolver`'s error code/message. */
export interface AuthFailure {
  code: string
  message: string
}

/**
 * Parse `Authorization: Bearer <token>` and resolve it via the supplied
 * `AppWsAuthResolver`. Byte-identical to the 19 verbatim copies this
 * replaces (O7): same `missing_bearer` code/message on a missing/malformed
 * header, same case-insensitive `bearer ` prefix check + trim, same
 * pass-through of the resolver's own failure code/message.
 */
export async function resolveBearer(
  req: Request,
  auth: AppWsAuthResolver,
): Promise<ResolvedAuth | AuthFailure> {
  const header = req.headers.get('authorization') ?? ''
  if (!header.toLowerCase().startsWith('bearer ')) {
    return {
      code: 'missing_bearer',
      message: 'expected Authorization: Bearer <token>',
    }
  }
  const token = header.slice('bearer '.length).trim()
  const resolved = await auth.resolve(token)
  if ('code' in resolved) {
    return { code: resolved.code, message: resolved.message }
  }
  return { user_id: resolved.user_id, project_slug: resolved.project_slug }
}

/**
 * Parse a JSON request body; `null` on any parse failure (malformed JSON,
 * empty body, wrong content-type). Byte-identical to the 12 verbatim
 * copies this replaces (O7).
 */
export async function readJsonBody(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    return null
  }
}

/**
 * Low-level `{ status, body }` → `Response` JSON serializer — the shared
 * primitive `jsonOk` / `jsonError` build on. `contentType` defaults to
 * `application/json`; the two charset-pinning call sites pass their own
 * value explicitly (see the module docblock).
 */
export function jsonResponse(status: number, body: unknown, contentType = 'application/json'): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': contentType },
  })
}

/** `{ ok: true, ...body }` success envelope. Byte-identical to the 12
 *  verbatim `jsonOk` copies this replaces (O7). */
export function jsonOk(body: object, status = 200): Response {
  return jsonResponse(status, { ok: true, ...body })
}

/**
 * `{ ok: false, code, message, ...extra }` error envelope — the ONE shape
 * every `gateway/http` surface emits on failure. Byte-identical to the 13
 * verbatim `jsonError` copies this replaces (O7). `extra` is an optional
 * additional-fields merge (`app-projects-surface.ts`'s PATCH validation
 * errors add a `field` key) — omitted, it's a no-op spread and the output
 * is exactly `{ ok: false, code, message }`.
 */
export function jsonError(
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): Response {
  return jsonResponse(status, { ok: false, code, message, ...extra })
}
