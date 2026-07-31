/**
 * @neutronai/connect — the Connect SURFACE STATE GATE (ISSUES #421).
 *
 * Connect is a CROSS-BOUNDARY API: it accepts calls from other instances. Every
 * Neutron install ships its source, and (since #421) every Neutron install WIRES
 * it — there is exactly ONE code path and Managed runs the same one. What decides
 * whether `/connect/v1/*` answers is not a build tier, an env var, or a feature
 * flag; it is the instance's own CONNECT STATE:
 *
 *   the surface is REACHABLE exactly while there is somebody to reach it.
 *
 * Concretely, `connectSurfaceIsOpen` is true iff EITHER
 *
 *   (1) a LIVE invite exists — unredeemed AND unexpired. This is the owner's
 *       deliberate act of opening the door: they tapped "Invite a collaborator"
 *       (`gateway/http/app-connect-invite.ts`) and an invitee now needs to reach
 *       `/connect/v1/connect/invite-preview` + `/connect/v1/connect/guest-auth`
 *       to walk through it.
 *
 *   (2) a NON-REVOKED collaborator exists. Redeeming an invite marks it redeemed,
 *       so (1) alone would slam the door on the very guest it just admitted. A
 *       member with `status IN ('pending','active')` keeps the surface open for
 *       as long as they are a member — that is what they were admitted FOR.
 *
 * and therefore CLOSED when neither holds: a fresh install, and an install whose
 * invites have all lapsed, been redeemed-and-revoked, or been WITHDRAWN. Closing
 * is a real, reachable state and — since the #421 residual fix — a state the
 * owner can reach ON DEMAND rather than by waiting: they revoke the last member
 * (`revokeMember`, `member-join.ts`) and revoke any outstanding invite
 * (`ConnectGuestInviteStore.revoke`, migration 0110), and the surface goes back
 * to being indistinguishable from an install that never had Connect at all.
 * Expiry (the 7-day `DEFAULT_CONNECT_INVITE_TTL_MS` ceiling) is still the
 * backstop; it is no longer the only exit.
 *
 * WHY THIS IS A STATE GATE AND NOT A FEATURE FLAG (repo rule: no flags, no dual
 * paths). A flag is a second code path chosen by configuration. This is one code
 * path whose reachability is a function of rows the owner already controls
 * through existing product actions. There is no way to configure it open: the
 * predicate takes a `ProjectDb`, not a boolean, so a caller cannot pass `true`.
 *
 * PER REQUEST, NEVER LATCHED. The mount site (`gateway/composition.ts`) calls
 * this on every inbound `/connect/v1/*` request. Latching at boot would mean the
 * owner had to restart the gateway after creating their first invite — the whole
 * point is that the first invite opens the door immediately.
 *
 * FAIL CLOSED. Any error reading the state (a pre-0058 DB, a corrupt file, a
 * closed handle) resolves to CLOSED. An instance that cannot prove someone is
 * meant to reach it does not expose a cross-boundary API.
 *
 * WHAT A CLOSED SURFACE LOOKS LIKE FROM OUTSIDE. Nothing. The mount site returns
 * `null` for the whole `/connect/v1` prefix, so the request falls through to the
 * same default 404 any unrouted path gets — identical status, identical body. An
 * unauthenticated caller cannot distinguish "this instance has Connect and it is
 * closed" from "this instance has no Connect" from "there is no such instance".
 * That is why the gate wraps the ENTIRE prefix and not just the authenticated
 * endpoints: `GET /connect/v1/health` answers with the receiving instance's slug,
 * so leaving it reachable on a closed instance would confirm existence and leak
 * the slug to anyone who asked.
 */

import type { ProjectDb } from '@neutronai/persistence/index.ts'

/**
 * A live invite: issued, not yet redeemed, not yet expired, NOT REVOKED.
 *
 * `revoked_at_ms IS NULL` is the load-bearing half of the ISSUES #421 residual
 * fix (migration 0110). Before it, the owner's only way to close a door they had
 * opened by mistake was to wait out the 7-day TTL — and because this predicate
 * gates the WHOLE `/connect/v1` prefix, that meant an unwanted invite held a
 * cross-boundary API reachable from the internet for a week. Revocation is
 * evaluated here, per request, so withdrawing the last live invite closes the
 * surface on the very next request with no restart.
 */
const LIVE_INVITE_SQL = `SELECT 1 AS present FROM connect_guest_invites
   WHERE redeemed_at_ms IS NULL AND revoked_at_ms IS NULL AND expires_at_ms > ?
   LIMIT 1`

/**
 * A non-revoked collaborator. `home_instance_slug IS NOT NULL` excludes any
 * owner row — the owner's own row (should one ever be written) carries a NULL
 * home instance by contract (`connected-members-store.ts`), and an owner row must
 * never hold the door open for the outside world.
 */
const LIVE_MEMBER_SQL = `SELECT 1 AS present FROM connected_members
   WHERE status IN ('pending','active') AND home_instance_slug IS NOT NULL LIMIT 1`

/**
 * Evaluate the gate against CURRENT state. Synchronous + cheap: two indexed
 * `LIMIT 1` probes on a local SQLite file, short-circuited on the first hit.
 */
export function connectSurfaceIsOpen(db: ProjectDb, nowMs: number): boolean {
  try {
    const invite = db
      .prepare<{ present: number }, [number]>(LIVE_INVITE_SQL)
      .get(nowMs)
    if (invite !== null && invite !== undefined) return true
    const member = db.prepare<{ present: number }, []>(LIVE_MEMBER_SQL).get()
    return member !== null && member !== undefined
  } catch {
    // Fail closed — see the docblock. Deliberately silent: this runs on an
    // unauthenticated edge, so a log line per request would be a free
    // amplification vector for anyone probing a closed instance.
    return false
  }
}

export interface ConnectSurfaceGateDeps {
  /** The owner's project DB — the one holding `connect_guest_invites` +
   *  `connected_members`. */
  db: ProjectDb
  /** Clock seam (tests). */
  now?: () => number
}

export interface ConnectSurfaceGate {
  /** True while the surface should answer. Evaluated fresh on every call. */
  isOpen(): boolean
}

export function buildConnectSurfaceGate(deps: ConnectSurfaceGateDeps): ConnectSurfaceGate {
  const now = deps.now ?? ((): number => Date.now())
  return {
    isOpen: (): boolean => connectSurfaceIsOpen(deps.db, now()),
  }
}
