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
 * Payload shape (as written by `gateway/push/chat-message-push.ts` +
 * the Core emitters):
 *
 *   - `{kind: 'agent_message', message_id, project_id?}`
 *       → `/projects/<pid>/chat?message_id=<mid>`
 *
 *     THE ONE SHAPE A CHAT MESSAGE TAKES — a fired reminder, a ritual post, an
 *     agent post. `project_id` is ABSENT when the message landed in the
 *     no-project General scope, and that absence is the ENCODING, not a
 *     malformed payload: the gateway deliberately does not name General's route
 *     spelling, because the client owns it (`GENERAL_PROJECT_ID`, and the
 *     `~general` / `#general` / `general` confusion of ISSUES #410/#411 is what a
 *     second copy of that sentinel costs).
 *
 *     Until 2026-08-09 there was a `reminder` kind here that routed to
 *     `/projects/<pid>/reminders` — the Reminders TAB, not the chat the message
 *     was actually in — and it was composed from the reminder ROW, so a ritual
 *     fire notified the owner with the literal dispatch token `ritual:<id>`. Both
 *     halves are gone: the notification is a chat message and the tap opens the
 *     chat. See `wire-types/push-kind.ts`.
 *
 *   - `{kind: 'wow_fired', project_id}` → `/projects/<pid>/chat` (no sender today)
 *   - `{kind: 'calendar_pre_meeting_brief', project_id, event_id}` → `/projects/<pid>/chat`
 *   - `{kind: 'email_daily_triage', project_id}` → `/projects/<pid>/chat`
 *
 *   - Anything else → null + structured warn. Caller routes to the
 *     default surface (i.e. no-op; the OS already opened the app at
 *     the user's last route).
 */

import type { PushKind } from '@neutronai/wire-types/push-kind.ts';
import { GENERAL_PROJECT_ID } from './project-rail-view';

export type PushPayloadKind = PushKind | string;

/**
 * The raw `request.content.data` Expo hands the listener. Typed as
 * a permissive bag because every field is operator-supplied and the
 * dispatcher can't statically know which gateway version produced the
 * notification.
 */
export interface PushPayload {
  kind?: unknown;
  project_id?: unknown;
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

  // A CHAT MESSAGE — the one shape a reminder, a ritual and an agent post share.
  //
  // A missing `project_id` means the General (no-project) scope, NOT a bad
  // payload: that is the wire encoding (see the module docblock), and General's
  // route id lives in exactly one place on this side of the wire. A missing
  // `message_id` still opens the right chat — the transcript then lands wherever
  // its own unread anchor puts it, which is strictly better than not routing.
  if (kind === 'agent_message') {
    const target = project_id ?? GENERAL_PROJECT_ID;
    const message_id =
      typeof payload.message_id === 'string' && payload.message_id.length > 0
        ? payload.message_id
        : null;
    if (message_id === null) {
      warn('agent_message payload has no message_id — opening the chat unanchored', {
        project_id: target,
      });
      return `/projects/${encodeURIComponent(target)}/chat`;
    }
    return (
      `/projects/${encodeURIComponent(target)}/chat` +
      `?message_id=${encodeURIComponent(message_id)}`
    );
  }

  // NOTE: nothing sends `wow_fired` (grep-verified 2026-08-09 — no `wow_fired`
  // string exists outside this file and its tests). The branch and its tests are
  // LEFT IN PLACE rather than deleted; removing tested behaviour is a separate
  // cleanup, not something to slip into a routing fix. It is deliberately absent
  // from `PUSH_KINDS`, so the exhaustiveness test covers only what is genuinely
  // sent and cannot be padded by a kind no gateway emits.
  if (kind === 'wow_fired') {
    if (project_id === null) {
      warn('wow_fired payload missing project_id', { project_id });
      return null;
    }
    return `/projects/${encodeURIComponent(project_id)}/chat`;
  }

  // The two kinds the Cores actually send. Both carry `project_id` and both used
  // to fall through to the "unknown kind" branch below — the app opened and
  // nothing routed. See `wire-types/push-kind.ts` for how the sent list and this
  // one had drifted apart.
  if (kind === 'calendar_pre_meeting_brief' || kind === 'email_daily_triage') {
    if (project_id === null) {
      warn(`${kind} payload missing project_id`, { project_id });
      return null;
    }
    return `/projects/${encodeURIComponent(project_id)}/chat`;
  }

  // Unknown / missing kind. Surface a warn so a misconfigured gateway
  // payload is visible in prod logs without crashing the listener.
  warn('unknown push payload kind', { kind });
  return null;
}

/**
 * The project a payload names, or null.
 *
 * There used to be a second source here: `topic_id = 'app-project:<project_id>'`,
 * the shape the retired `reminder` push carried instead of a project id. Every
 * live sender writes `project_id` outright, so the fallback had no producer left
 * once that kind was deleted — and a decode path with no encoder is a branch that
 * cannot be exercised, which is how a wrong one survives.
 */
function resolveProjectId(payload: PushPayload): string | null {
  if (typeof payload.project_id === 'string' && payload.project_id.length > 0) {
    return payload.project_id;
  }
  return null;
}
