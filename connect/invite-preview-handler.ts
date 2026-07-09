/**
 * @neutronai/connect — the public, read-only, NON-CONSUMING invite-preview
 * handler (M2.6 Phase 5).
 *
 * `GET /connect/v1/connect/invite-preview?token_hash=<sha256(token)>` — the
 * net-new read the guest accept page (landing/connect-accept) calls to render
 * the LOCKED data-locality disclosure (brief § 2.2, § 3.1) BEFORE the guest
 * commits to the single-use handshake. Preview WITHOUT redeeming is necessary:
 * the existing `POST /connect/guest-auth` handshake is single-use and consumes
 * the invite, so the disclosure cannot be driven by a redeem.
 *
 * The client sends the SHA-256 hash of its raw token (the on-disk lookup key),
 * never the raw token — preview is a pure read of display fields by hash.
 *
 * SECURITY (brief § 5 #1): read-only — returns ONLY display fields for a valid,
 * unredeemed, unexpired invite, and a benign, detail-free 404/410 otherwise. It
 * NEVER claims the invite (single-use is preserved for the handshake), NEVER
 * reveals owner internals beyond the disclosure copy, and is rate-limited by the
 * existing edge limiter (wired at the server, per-IP). A wrong / expired /
 * already-redeemed token cannot be distinguished beyond {not_found, gone,
 * expired} — no field leak.
 */

import type { ProjectDb } from '@neutronai/persistence/index.ts'
import { ConnectGuestInviteStore } from './guest-invite-store.ts'

/** A SHA-256 hex digest — 64 lowercase hex chars. The client computes this from
 *  its raw token; we reject anything that isn't shaped like one before touching
 *  the store (no SQL, no detail leak on garbage). */
const TOKEN_HASH_RE = /^[0-9a-f]{64}$/

export interface InvitePreviewHandlerDeps {
  inviteStore: ConnectGuestInviteStore
  /** The owner's project DB — reads project name + privacy_mode for the
   *  disclosure (read-only). */
  db: ProjectDb
  /** Owner display (the owner/connect instance slug — "whose instance hosts it"). */
  owner_display: string
  /** The connect node's public host (e.g. `connect.example.com`) — resolved
   *  from the configured public base URL, never a placeholder (brief § 3.1). */
  connect_host: string
  now?: () => number
}

interface ProjectDisplayRow {
  name: string
  privacy_mode: string
}

/**
 * Build the `GET /connect/invite-preview` handler. Returns a fetch-style handler
 * the cross-instance API server mounts on the PUBLIC (pre-auth) edge, alongside
 * `guest-auth`.
 */
export function buildInvitePreviewHandler(
  deps: InvitePreviewHandlerDeps,
): (req: Request) => Promise<Response> {
  const now = deps.now ?? ((): number => Date.now())

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url)
    const tokenHash = (url.searchParams.get('token_hash') ?? '').trim()
    if (!TOKEN_HASH_RE.test(tokenHash)) {
      // Malformed lookup key — benign 404, no detail.
      return json(404, { error: 'not_found' })
    }

    const row = deps.inviteStore.getByHash(tokenHash)
    if (row === null) {
      return json(404, { error: 'not_found' })
    }
    // Already redeemed (single-use consumed) → gone. Expired → gone. Benign,
    // no field leak in either case.
    if (row.redeemed_at_ms !== null) {
      return json(410, { error: 'gone' })
    }
    if (row.expires_at_ms <= now()) {
      return json(410, { error: 'expired' })
    }

    // Resolve the display fields the disclosure needs from REAL context (brief
    // § 3.1 — never a hardcoded placeholder).
    const project = deps.db
      .prepare<ProjectDisplayRow, [string]>(
        `SELECT name, privacy_mode FROM projects WHERE id = ? LIMIT 1`,
      )
      .get(row.project_id)

    return json(200, {
      project_name: project?.name ?? row.project_id,
      owner_display: deps.owner_display,
      connect_host: deps.connect_host,
      privacy_tier: project?.privacy_mode ?? 'private',
      // Wire field stays `scope` (write|read) for the disclosure renderer; the
      // value now comes from the invite's renamed `access` column (§1.4).
      scope: row.access,
    })
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
