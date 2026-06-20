/**
 * @neutronai/app — push deep-link payload → router path resolver
 * (2026-05-22 push-deeplink-wow sprint).
 *
 * Pure helper consumed by `app/lib/push.ts:installPushTapHandler` and
 * exercised directly by the bun-test suite. Lives in its own module
 * (no React, no expo-notifications import) so the test runtime never
 * has to load RN, matching the split used by
 * `chat-deep-link-dispatch.ts`.
 *
 * Payload shape (as written by `gateway/push/dispatcher.ts` +
 * `gateway/wow-push-emitter.ts`):
 *
 *   - `{kind: 'reminder', topic_id, project_slug, reminder_id, project_id?}`
 *       → `/projects/<pid>/reminders?reminder_id=<rid>`
 *
 *     The existing reminder payload only carries
 *     `topic_id = 'app-project:<project_id>'` (per
 *     `gateway/http/app-reminders-surface.ts:appProjectTopicId`).
 *     Stripping that prefix recovers the route param so the existing
 *     reminder push tokens just start working when the listener lands
 *     — no gateway-side payload change required.
 *
 *   - `{kind: 'wow_fired', project_id}` → `/projects/<pid>/chat`
 *
 *   - `{kind: 'agent_message', project_id, message_id?}`
 *       → `/projects/<pid>/chat[?message_id=<mid>]`
 *
 *     Forward-compat: no gateway emitter fires this kind this sprint
 *     (per the brief's "out of scope"); the router accepts it so a
 *     future per-message push doesn't need a coordinated client +
 *     server release.
 *
 *   - Anything else → null + structured warn. Caller routes to the
 *     default surface (i.e. no-op; the OS already opened the app at
 *     the user's last route).
 */

export type PushPayloadKind = 'reminder' | 'wow_fired' | 'agent_message' | string;

/**
 * The raw `request.content.data` Expo hands the listener. Typed as
 * a permissive bag because every field is operator-supplied and the
 * dispatcher can't statically know which gateway version produced the
 * notification.
 */
export interface PushPayload {
  kind?: unknown;
  project_id?: unknown;
  topic_id?: unknown;
  reminder_id?: unknown;
  message_id?: unknown;
  // Open-ended: a future kind may carry additional fields the helper
  // doesn't need to interpret. The `Record` index keeps TS from
  // complaining when tests pass extra keys.
  [key: string]: unknown;
}

export interface ResolvePushRouteOptions {
  /**
   * Logger for malformed / unknown payloads. Defaults to a
   * `console.warn` that prefixes the entry with `[push]` so prod logs
   * stay grep-able. Tests pass a recorder.
   */
  warn?: (message: string, meta?: Record<string, unknown>) => void;
}

const APP_PROJECT_PREFIX = 'app-project:';

/**
 * Resolve a parsed push payload to a router path string. Returns null
 * when the payload doesn't map to any known kind OR when the kind is
 * known but a required field is missing — the caller can route to a
 * default surface (or no-op) in that case. Never throws.
 */
export function resolvePushRoute(
  payload: PushPayload,
  options: ResolvePushRouteOptions = {},
): string | null {
  const warn =
    options.warn ??
    ((message, meta): void => {
      if (meta !== undefined) {
        console.warn(`[push] ${message}`, meta);
      } else {
        console.warn(`[push] ${message}`);
      }
    });

  const kind = typeof payload.kind === 'string' ? payload.kind : null;
  const project_id = resolveProjectId(payload);

  if (kind === 'reminder') {
    const reminder_id =
      typeof payload.reminder_id === 'string' && payload.reminder_id.length > 0
        ? payload.reminder_id
        : null;
    if (project_id === null || reminder_id === null) {
      warn('reminder payload missing project_id or reminder_id', {
        project_id,
        reminder_id,
      });
      return null;
    }
    return (
      `/projects/${encodeURIComponent(project_id)}/reminders` +
      `?reminder_id=${encodeURIComponent(reminder_id)}`
    );
  }

  if (kind === 'wow_fired') {
    if (project_id === null) {
      warn('wow_fired payload missing project_id', { project_id });
      return null;
    }
    return `/projects/${encodeURIComponent(project_id)}/chat`;
  }

  if (kind === 'agent_message') {
    if (project_id === null) {
      warn('agent_message payload missing project_id', { project_id });
      return null;
    }
    const message_id =
      typeof payload.message_id === 'string' && payload.message_id.length > 0
        ? payload.message_id
        : null;
    if (message_id === null) {
      return `/projects/${encodeURIComponent(project_id)}/chat`;
    }
    return (
      `/projects/${encodeURIComponent(project_id)}/chat` +
      `?message_id=${encodeURIComponent(message_id)}`
    );
  }

  // Unknown / missing kind. Surface a warn so a misconfigured gateway
  // payload is visible in prod logs without crashing the listener.
  warn('unknown push payload kind', { kind });
  return null;
}

/**
 * Recover a project_id from either the explicit `project_id` field OR
 * the existing reminder payload shape, where the gateway encodes it as
 * `topic_id = 'app-project:<project_id>'` (see
 * `gateway/http/app-reminders-surface.ts:appProjectTopicId`). Returns
 * null when neither yields a non-empty string.
 */
function resolveProjectId(payload: PushPayload): string | null {
  if (typeof payload.project_id === 'string' && payload.project_id.length > 0) {
    return payload.project_id;
  }
  if (
    typeof payload.topic_id === 'string' &&
    payload.topic_id.startsWith(APP_PROJECT_PREFIX)
  ) {
    const candidate = payload.topic_id.slice(APP_PROJECT_PREFIX.length);
    if (candidate.length > 0) return candidate;
  }
  return null;
}
