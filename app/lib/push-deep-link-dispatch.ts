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
 *   - `{kind: 'agent_message', message_id, project_id}`
 *       → `/projects/<pid>/chat?message_id=<mid>`
 *
 *     THE ONE SHAPE A CHAT MESSAGE TAKES — a fired reminder, a ritual post, an
 *     agent post, a brief, a nudge. `project_id` is always present; for the
 *     no-project General scope it is the shared `GENERAL_RAIL_ID` sentinel
 *     (`wire-types/topic-id.ts`), which is the one definition both sides import.
 *     A missing one is still tolerated and read as General, because a payload
 *     already sitting in the notification shade was built by whatever gateway
 *     version delivered it.
 *
 *   - `{kind: 'reminder', reminder_id, project_id?}`
 *       → `/projects/<pid>/reminders?reminder_id=<rid>`
 *
 *     LEGACY, DECODE-ONLY — no sender remains (grep-verified: no `PUSH_KIND_REMINDER`
 *     and no `kind: 'reminder'` producer anywhere in the gateway). Until 2026-08-09
 *     this was how a fired reminder notified, composed from the reminder ROW, which
 *     is why a ritual fire put the literal dispatch token `ritual:<id>` on the
 *     owner's lock screen and why the tap opened the Reminders TAB instead of the
 *     chat the message was in. Both are fixed by `agent_message` above.
 *
 *     THIS BRANCH STAYS ANYWAY, and it is not a dual code path — there is exactly
 *     one SENDER. It is the DECODER for payloads that already exist: notifications
 *     sitting undismissed in the shade right now, and any gateway a self-hoster has
 *     not upgraded yet. A store-published app and a self-hosted gateway do not
 *     upgrade atomically, so deleting the decoder would turn those taps into the
 *     "opens the app and nothing routes" the change exists to end. It also keeps the
 *     reminders deep-link surface (ISSUE #38 — `app/app/projects/[id]/reminders.tsx`
 *     + `ReminderList`'s highlight/scroll) reachable rather than orphaned.
 *
 *     One thing DID change: an UNRESOLVABLE project no longer refuses outright. A
 *     project-scoped legacy reminder carries its project as `topic_id =
 *     'app-project:<id>'` and resolves fine; a GENERAL one carried no project field
 *     at all (only `project_slug`, the owner slug), so this branch used to return
 *     null for every General reminder notification ever sent — the owner's *"it
 *     opens the app but not the right project"*, in the code. It now falls back to
 *     General, so a legacy tap lands on a real, working surface instead of nowhere.
 *
 *     AND THAT IS THE WHOLE OF THE CLAIM — the tapped row itself may well not be in
 *     the list. General's Reminders tab is not an "everything" view: the surface
 *     lists `listPendingByTopic(project_slug, 'app-project:~general')`
 *     (`gateway/http/app-reminders-surface.ts`, the list route) and the
 *     `include_id` widening that exists for exactly this deep-link case re-checks
 *     `extra.topic_id === topic_id` before admitting a row. A legacy General
 *     reminder was written by an engine path with `topic_id` NULL, so it matches
 *     neither test and cannot be highlighted. The tap lands on the right TAB, not on
 *     the row. That is still strictly better than the `null` it used to return (the
 *     app opened and nothing routed at all), and it is not worth chasing further: no
 *     sender has emitted this kind since 2026-08-09, so the population is finite and
 *     shrinking. Stated plainly because the earlier wording here claimed the tab
 *     "lists every reminder", which is the kind of confident, specific, WRONG
 *     docblock that gets believed instead of checked.
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
  /**
   * LEGACY decode-only fields. Declared rather than left to the index signature
   * below because `resolvePushRoute` and `resolveProjectId` actually read them, and
   * this tsconfig has no `noPropertyAccessFromIndexSignature` — so an undeclared
   * read compiles, and renaming one in the decoder would compile too. Naming them
   * here is what makes the interface a description of what is read.
   */
  reminder_id?: unknown;
  topic_id?: unknown;
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
  // A missing `project_id` is read as General rather than refused. The live sender
  // always writes one, so this only forgives an older gateway's payload — and
  // refusing it would mean "the app opened and nothing routed", which is the exact
  // complaint. A missing `message_id` still opens the right chat: the transcript
  // then lands wherever its own unread anchor puts it, which is strictly better
  // than not routing.
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

  // LEGACY, DECODE-ONLY — see the module docblock. No sender remains; this keeps
  // taps working on notifications that were already delivered and on gateways a
  // self-hoster has not upgraded. Kept OUT of `PUSH_KINDS` for the same reason
  // `wow_fired` is: that list is what the system SENDS, and padding it with a kind
  // nothing emits is what let the two lists drift into being disjoint.
  if (kind === 'reminder') {
    const reminder_id =
      typeof payload.reminder_id === 'string' && payload.reminder_id.length > 0
        ? payload.reminder_id
        : null;
    if (reminder_id === null) {
      warn('legacy reminder payload has no reminder_id', { project_id });
      return null;
    }
    // GENERAL IS THE FALLBACK, AND THE ROW MAY NOT BE IN THE LIST THAT OPENS.
    // Settled rather than left as a question, because it looks like a mis-anchor:
    // the tab lists `app-project:<segment>` rows and admits the tapped
    // `include_id` only when its `topic_id` matches EXACTLY
    // (`gateway/http/app-reminders-surface.ts` `handleList`). A General reminder
    // the APP created carries `app-project:~general` — the reserved no-project
    // segment, NOT the literal `general`, which is a legal project id and used to
    // collide with a real project of that name — and lands correctly. One created
    // through the Reminders Core or Telegram carries that channel's topic, so it
    // is filtered out and the tab opens without the row.
    //
    // NOT CHANGED, because the alternative is worse and this kind is decode-only:
    // the only other option is `return null`, i.e. the app opens and nothing
    // routes — the exact complaint (#520) this resolver exists to end. Landing on
    // the owner's reminders with the target unhighlighted still puts him one screen
    // from it. And nothing SENDS this kind any more (a fired reminder is an
    // `agent_message` now, anchored on the durable chat row), so the population is
    // notifications already on a device plus un-upgraded gateways — finite and
    // shrinking, never growing.
    const target = project_id ?? GENERAL_PROJECT_ID;
    return (
      `/projects/${encodeURIComponent(target)}/reminders` +
      `?reminder_id=${encodeURIComponent(reminder_id)}`
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

/** The topic prefix a project-scoped reminder row wears (`reminders/store.ts:474`). */
const APP_PROJECT_PREFIX = 'app-project:';

/**
 * The project a payload names, or null.
 *
 * TWO SOURCES, and the second one is not dead code. The live sender writes
 * `project_id` outright. The retired `reminder` sender wrote the OWNER slug into
 * `project_slug` and — only when the reminder row had one — the row's own
 * `topic_id`, which for a project-scoped reminder is `app-project:<project_id>`
 * (`git show main:gateway/push/dispatcher.ts:277`, read before writing this).
 * So a legacy notification for a project reminder carries its project ONLY here,
 * and dropping this decode would land those taps on the General tab instead of
 * the project they belong to.
 */
function resolveProjectId(payload: PushPayload): string | null {
  if (typeof payload.project_id === 'string' && payload.project_id.length > 0) {
    return payload.project_id;
  }
  if (
    typeof payload.topic_id === 'string' &&
    payload.topic_id.startsWith(APP_PROJECT_PREFIX)
  ) {
    const id = payload.topic_id.slice(APP_PROJECT_PREFIX.length);
    return id.length > 0 ? id : null;
  }
  return null;
}
