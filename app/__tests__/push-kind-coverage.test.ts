/**
 * EVERY kind the gateway sends must route somewhere (owner-reported, #520).
 *
 * WHAT HE SAW: *"when I tap on a push notification, it opens the app, but it
 * doesn't open in the right project and at the unread message marker like it
 * should."*
 *
 * WHY. The gateway picks a `kind` when it builds a push; the client switches on
 * that string to decide where the tap lands. The two lists were written
 * independently and had drifted until they were **disjoint except for one entry**:
 *
 *   SENT                        KNOWN TO THE RESOLVER
 *   reminder                    reminder          ← the only overlap
 *   calendar_pre_meeting_brief  wow_fired         ← no sender, ever
 *   email_daily_triage          agent_message     ← no sender, ever
 *
 * So a pre-meeting brief or an email triage hit the resolver's "unknown kind"
 * branch: warn, return null, nothing routes. Meanwhile two of the three kinds the
 * client handled carefully could never arrive.
 *
 * NEITHER SIDE'S TESTS COULD SEE IT. The dispatcher's tests assert the payload it
 * builds. The resolver's tests assert the payloads they hand it. Both were green,
 * and their union was broken — the gap was in the space between two files that
 * never met. This test is that meeting point: it walks `PUSH_KINDS`, the list the
 * senders now import their constants from, and requires the resolver to produce a
 * route for each. Add a kind and forget the client, and this reds.
 *
 * 2026-08-09 — `reminder` left the SENT list and `agent_message` joined it (a
 * fired reminder is a chat message; see `wire-types/push-kind.ts`). The union is
 * checked the same way, which is the point of having the list at all: the swap
 * could not be made on one side only.
 */
import { describe, expect, test } from 'bun:test';

import { PUSH_KINDS, type PushKind } from '@neutronai/wire-types/push-kind.ts';
import { GENERAL_RAIL_ID } from '@neutronai/wire-types/topic-id.ts';
import { buildChatMessagePush } from '@neutronai/gateway/push/chat-message-push.ts';
import { resolvePushRoute, type PushPayload } from '../lib/push-deep-link-dispatch';

/**
 * A well-formed payload for each kind — the fields the gateway actually attaches.
 * Keeping these beside the kind list means "what a sender sends" is written down
 * once and checked, rather than implied.
 *
 * `agent_message` is not hand-written: it is whatever the REAL gateway builder
 * emits. A hand-copied fixture is exactly how the two lists drifted the first
 * time — it asserts what the author BELIEVED the sender sends. Taking the payload
 * from the sender means a field renamed on the gateway side reds here.
 */
const WELL_FORMED: Record<PushKind, PushPayload> = {
  agent_message: buildChatMessagePush({
    project_id: 'acme',
    message_id: 'msg-1',
    body: 'the composed body',
  }).data as PushPayload,
  calendar_pre_meeting_brief: {
    kind: 'calendar_pre_meeting_brief',
    event_id: 'evt-1',
    project_id: 'acme',
    project_slug: 'owner',
  },
  email_daily_triage: {
    kind: 'email_daily_triage',
    project_id: 'acme',
    project_slug: 'owner',
  },
};

describe('every sent push kind resolves to a route', () => {
  test('the fixture table covers PUSH_KINDS exactly — no kind is silently skipped', () => {
    // Guards the guard: a kind added to the list but not to the table would
    // otherwise be "covered" by a loop that never sees it.
    expect(Object.keys(WELL_FORMED).sort()).toEqual([...PUSH_KINDS].sort());
  });

  for (const kind of PUSH_KINDS) {
    test(`${kind} routes somewhere`, () => {
      const silent = (): void => {};
      const route = resolvePushRoute(WELL_FORMED[kind], { warn: silent });
      expect(route).not.toBeNull();
      expect(route).toContain('/projects/acme/');
    });
  }
});

describe('the chat-message kind, end to end across the two sides', () => {
  test('what the gateway builds is what the resolver routes to the chat', () => {
    // THE UNION, walked in one assertion: the SENDER composes the payload, the
    // RESOLVER consumes it, and nothing in between is hand-transcribed. This is
    // the shape of test whose absence let the sent list and the handled list
    // drift into being disjoint.
    const built = buildChatMessagePush({
      project_id: 'acme',
      message_id: 'msg-1',
      body: 'Kaizen: three things landed today.',
    });
    const warned: string[] = [];
    const route = resolvePushRoute(built.data as PushPayload, {
      warn: (m) => warned.push(m),
    });
    expect(route).toBe('/projects/acme/chat?message_id=msg-1');
    expect(warned).toEqual([]);
    // And the notification the owner SEES carries the message, not a token.
    expect(built.body).toBe('Kaizen: three things landed today.');
    expect(built.title).toBe('acme');
  });

  test('a General-scope message routes to the General chat, not to nothing', () => {
    const built = buildChatMessagePush({
      project_id: null,
      message_id: 'msg-2',
      body: 'morning brief',
    });
    // The sender NAMES General with the shared sentinel rather than omitting the
    // field: an app bundle already installed reads an absent project as malformed
    // and refuses to route, and a store app cannot be upgraded in lockstep with a
    // self-hosted gateway.
    expect(built.data['project_id']).toBe(GENERAL_RAIL_ID);
    const route = resolvePushRoute(built.data as PushPayload, { warn: () => {} });
    expect(route).toBe('/projects/~general/chat?message_id=msg-2');
  });

  test('the ROW ID the gateway put in reaches the route the client will open', () => {
    // THE LINKAGE, walked rather than assumed. The previous version of this file
    // asserted the ROUTE and left `message_id` to a hand-written fixture that
    // happened to use the same literal as the sender's test — so a gateway that
    // renamed the field, or dropped it, would have kept both green. Here the id is
    // generated, handed to the SENDER, and read back out of the resolver's OUTPUT,
    // so nothing in the chain is transcribed by hand.
    const rowId = `durable-${Math.random().toString(36).slice(2, 10)}`;
    const built = buildChatMessagePush({
      project_id: 'acme',
      message_id: rowId,
      body: 'the composed body',
    });
    const route = resolvePushRoute(built.data as PushPayload, { warn: () => {} });
    expect(route).not.toBeNull();
    const query = new URLSearchParams((route as string).split('?')[1] ?? '');
    expect(query.get('message_id')).toBe(rowId);
  });
});

describe('the two Core kinds specifically — these were the dead ones', () => {
  test('a pre-meeting brief opens the project chat instead of nothing', () => {
    const warned: string[] = [];
    const route = resolvePushRoute(WELL_FORMED.calendar_pre_meeting_brief, {
      warn: (m) => warned.push(m),
    });
    expect(route).toBe('/projects/acme/chat');
    // And it must not warn — an "unknown kind" warning was the old symptom, and a
    // route that both works and complains is a half-fix.
    expect(warned).toEqual([]);
  });

  test('an email triage opens the project chat instead of nothing', () => {
    const warned: string[] = [];
    const route = resolvePushRoute(WELL_FORMED.email_daily_triage, {
      warn: (m) => warned.push(m),
    });
    expect(route).toBe('/projects/acme/chat');
    expect(warned).toEqual([]);
  });

  test('a Core push with NO project_id still warns and refuses, rather than guessing', () => {
    // `project_slug` is the OWNER slug, not a project id. Falling back to it would
    // route to a project that does not exist and look like a routing bug rather
    // than a payload bug.
    const warned: string[] = [];
    const route = resolvePushRoute(
      { kind: 'email_daily_triage', project_slug: 'owner' },
      { warn: (m) => warned.push(m) },
    );
    expect(route).toBeNull();
    expect(warned.length).toBe(1);
  });
});

describe('an unrecognised kind is still handled honestly', () => {
  test('it warns and returns null rather than routing somewhere arbitrary', () => {
    const warned: string[] = [];
    const route = resolvePushRoute(
      { kind: 'something_new', project_id: 'acme' },
      { warn: (m) => warned.push(m) },
    );
    expect(route).toBeNull();
    expect(warned).toEqual(['unknown push payload kind']);
  });
});
