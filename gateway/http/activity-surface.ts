/**
 * @neutronai/gateway/http — ACTIVITY INSPECTOR snapshot surface (SPEC § WAVE 3.5).
 *
 *   - `GET /api/app/projects/<project_id>/activity`   one project's live buffer
 *   - `GET /api/app/activity`                          the General (no-project) scope
 *
 * READ-ONLY, and there is deliberately no write path: the buffer is produced by
 * the server's own taps, never by a client.
 *
 * WHY A SNAPSHOT ENDPOINT EXISTS AT ALL, given the live `activity_event` push:
 * because the push alone cannot answer the question the panel is for. A WEDGED
 * session emits NOTHING — that is what makes it wedged. A panel that only
 * subscribed to the live stream would open blank on exactly the session the owner
 * is worried about, and could not say "last event 6 minutes ago". So the panel
 * fetches this once on open (buffer + both clocks + the derived state) and then
 * appends live frames on top. The snapshot is the load-bearing half for the wedge
 * case; the push is the load-bearing half for the ticking case.
 *
 * Bearer-authed via the shared `AppWsAuthResolver` — same dev-bypass + HS256 paths
 * as the tabs / tasks / work-board surfaces.
 *
 * LIVE-ONLY (Ryan-locked): the buffer behind this is an in-memory ring that dies
 * with the process. There is no persistence, no schema, no retention policy and no
 * scrollback — a restart legitimately returns an empty buffer.
 */

import { sanitizeProjectId } from '@neutronai/channels/adapters/app-ws/envelope.ts'
import type { AppWsAuthResolver } from '@neutronai/channels/adapters/app-ws/auth.ts'
import { jsonError, jsonOk, resolveBearer } from './surface-kit.ts'

/**
 * The minimal inspector read surface this route needs. `ActivityInspector`
 * (`open/activity-inspector.ts`) satisfies it structurally, so this gateway-band
 * module never imports the Open-band store.
 */
export interface ActivitySnapshotSource {
  snapshot(scope_key: string): {
    scope_key: string
    events: ReadonlyArray<{
      seq: number
      at: number
      kind: string
      label: string
      detail?: string
      synthetic?: boolean
    }>
    state: string
    last_event_age_ms: number | null
    last_real_activity_age_ms: number | null
    now: number
    turn_in_flight: boolean
  }
}

export interface ActivitySurfaceOptions {
  inspector: ActivitySnapshotSource
  auth: AppWsAuthResolver
}

export interface ActivitySurface {
  handler: (req: Request) => Promise<Response | null>
}

/** `/api/app/projects/<project_id>/activity` */
const PROJECT_PATH_RE = /^\/api\/app\/projects\/([^/]+)\/activity$/
/** `/api/app/activity` — the General (no-project) scope. */
const GENERAL_PATH = '/api/app/activity'

export function createActivitySurface(opts: ActivitySurfaceOptions): ActivitySurface {
  const { inspector, auth } = opts
  return {
    handler: async (req) => {
      const url = new URL(req.url)
      const pathname = url.pathname

      // Resolve the SCOPE KEY first (cheap, no auth needed to decide this route
      // isn't ours). General is a first-class scope, not a fallback: mobile and web
      // both model a no-project General chat with its own warm session, so it has
      // its own buffer and must be inspectable — never assume a project row exists.
      let scope_key: string
      let project_id: string | null = null
      if (pathname === GENERAL_PATH) {
        scope_key = 'general'
      } else {
        const match = PROJECT_PATH_RE.exec(pathname)
        if (match === null) return null
        const raw = match[1] ?? ''
        project_id = sanitizeProjectId(raw)
        if (project_id === null) {
          return jsonError(
            400,
            'invalid_project_id',
            'project_id must be 1-128 chars from [A-Za-z0-9_.-]',
          )
        }
        scope_key = project_id
      }

      if (req.method !== 'GET') {
        return jsonError(405, 'method_not_allowed', 'activity is read-only')
      }

      const resolved = await resolveBearer(req, auth)
      if ('code' in resolved) {
        return jsonError(401, resolved.code, resolved.message)
      }

      const snap = inspector.snapshot(scope_key)
      return jsonOk({
        scope_key: snap.scope_key,
        project_id,
        events: snap.events,
        state: snap.state,
        last_event_age_ms: snap.last_event_age_ms,
        last_real_activity_age_ms: snap.last_real_activity_age_ms,
        now: snap.now,
        turn_in_flight: snap.turn_in_flight,
      })
    },
  }
}
