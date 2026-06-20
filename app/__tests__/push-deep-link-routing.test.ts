/**
 * @neutronai/app — push deep-link routing tests
 * (2026-05-22 push-deeplink-wow sprint).
 *
 * Exercises `resolvePushRoute` directly so the bun-test runtime does
 * not have to load React Native / expo-notifications. The Expo
 * listener wrapper in `app/lib/push.ts:installPushTapHandler` is a
 * thin adapter over this helper + the typed `router.push` callback;
 * the wrapper itself is verified by a static source-presence check
 * (matches the `chat-deep-link-navigator.test.ts` precedent) so the
 * route translation logic stays exhaustive.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  resolvePushRoute,
  type PushPayload,
} from '../lib/push-deep-link-dispatch';

function recordingWarn(): {
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  entries: Array<{ msg: string; meta?: Record<string, unknown> }>;
} {
  const entries: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
  return {
    warn: (msg, meta) => {
      if (meta !== undefined) entries.push({ msg, meta });
      else entries.push({ msg });
    },
    entries,
  };
}

describe('resolvePushRoute', () => {
  describe('reminder kind', () => {
    it('routes to /projects/<pid>/reminders?reminder_id=<rid> via explicit project_id', () => {
      const payload: PushPayload = {
        kind: 'reminder',
        project_id: 'acme',
        reminder_id: 'rem-abc',
        project_slug: 't1',
      };
      const path = resolvePushRoute(payload);
      expect(path).toBe('/projects/acme/reminders?reminder_id=rem-abc');
    });

    it('extracts project_id from the legacy topic_id = "app-project:<id>" encoding', () => {
      // The existing gateway reminder push payload only carries
      // `topic_id`; the helper must recover project_id from it so
      // existing tokens just start working once the listener lands.
      const payload: PushPayload = {
        kind: 'reminder',
        topic_id: 'app-project:northwind',
        reminder_id: 'rem-1',
        project_slug: 't1',
      };
      const path = resolvePushRoute(payload);
      expect(path).toBe('/projects/northwind/reminders?reminder_id=rem-1');
    });

    it('url-encodes both path + query params', () => {
      // Project ids should never contain weird chars in practice, but
      // the helper must encode defensively so a malformed payload
      // cannot inject path segments.
      const path = resolvePushRoute({
        kind: 'reminder',
        project_id: 'my proj/x',
        reminder_id: 'r e m?id',
      });
      expect(path).toBe(
        '/projects/my%20proj%2Fx/reminders?reminder_id=r%20e%20m%3Fid',
      );
    });

    it('returns null + warns when project_id is missing entirely', () => {
      const { warn, entries } = recordingWarn();
      const path = resolvePushRoute(
        { kind: 'reminder', reminder_id: 'r1' },
        { warn },
      );
      expect(path).toBeNull();
      expect(entries[0]?.msg).toContain('reminder payload missing');
    });

    it('returns null + warns when reminder_id is missing', () => {
      const { warn, entries } = recordingWarn();
      const path = resolvePushRoute(
        { kind: 'reminder', project_id: 'p1' },
        { warn },
      );
      expect(path).toBeNull();
      expect(entries[0]?.msg).toContain('reminder payload missing');
    });

    it('ignores a topic_id that does not carry the app-project: prefix', () => {
      // A bare Telegram-style topic_id should not be misread as a
      // project_id — the helper must require either an explicit
      // project_id or the encoded prefix.
      const { warn, entries } = recordingWarn();
      const path = resolvePushRoute(
        { kind: 'reminder', topic_id: 'telegram:42', reminder_id: 'r1' },
        { warn },
      );
      expect(path).toBeNull();
      expect(entries[0]?.msg).toContain('reminder payload missing');
    });
  });

  describe('wow_fired kind', () => {
    it('routes to /projects/<pid>/chat', () => {
      const payload: PushPayload = { kind: 'wow_fired', project_id: 'neutron' };
      expect(resolvePushRoute(payload)).toBe('/projects/neutron/chat');
    });

    it('falls back to the topic_id prefix when project_id is omitted', () => {
      const payload: PushPayload = {
        kind: 'wow_fired',
        topic_id: 'app-project:beacon',
      };
      expect(resolvePushRoute(payload)).toBe('/projects/beacon/chat');
    });

    it('returns null + warns when project_id is missing', () => {
      const { warn, entries } = recordingWarn();
      const path = resolvePushRoute({ kind: 'wow_fired' }, { warn });
      expect(path).toBeNull();
      expect(entries[0]?.msg).toContain('wow_fired payload missing project_id');
    });
  });

  describe('agent_message kind (forward-compatible)', () => {
    it('routes to /projects/<pid>/chat?message_id=<mid> when message_id is present', () => {
      const path = resolvePushRoute({
        kind: 'agent_message',
        project_id: 'p1',
        message_id: 'm1',
      });
      expect(path).toBe('/projects/p1/chat?message_id=m1');
    });

    it('routes to /projects/<pid>/chat when message_id is omitted', () => {
      const path = resolvePushRoute({
        kind: 'agent_message',
        project_id: 'p1',
      });
      expect(path).toBe('/projects/p1/chat');
    });

    it('returns null + warns when project_id is missing', () => {
      const { warn, entries } = recordingWarn();
      const path = resolvePushRoute(
        { kind: 'agent_message', message_id: 'm1' },
        { warn },
      );
      expect(path).toBeNull();
      expect(entries[0]?.msg).toContain('agent_message payload missing project_id');
    });
  });

  describe('unknown / malformed payloads (Part C future-proofing)', () => {
    it('returns null + warns on an unknown kind string', () => {
      const { warn, entries } = recordingWarn();
      const path = resolvePushRoute(
        { kind: 'task_overdue', project_id: 'p1' },
        { warn },
      );
      expect(path).toBeNull();
      expect(entries[0]?.msg).toContain('unknown push payload kind');
      expect(entries[0]?.meta).toEqual({ kind: 'task_overdue' });
    });

    it('returns null + warns on a payload with no kind at all', () => {
      const { warn, entries } = recordingWarn();
      const path = resolvePushRoute({}, { warn });
      expect(path).toBeNull();
      expect(entries[0]?.msg).toContain('unknown push payload kind');
    });

    it('returns null + warns on a payload whose kind is the wrong type', () => {
      const { warn, entries } = recordingWarn();
      const path = resolvePushRoute(
        { kind: 42 as unknown as string, project_id: 'p1' },
        { warn },
      );
      expect(path).toBeNull();
      expect(entries[0]?.msg).toContain('unknown push payload kind');
    });

    it('never throws on a fully malformed payload (no fields at all)', () => {
      // Cast through unknown — production payloads are operator-supplied
      // and the helper must tolerate any garbage data shape without
      // crashing the listener.
      expect(() =>
        resolvePushRoute({} as PushPayload, { warn: () => undefined }),
      ).not.toThrow();
    });
  });

  it('default warn logger is wired (smoke check on the source)', () => {
    // Pin the helper's default warn shape so a future refactor that
    // accidentally drops console.warn surfaces here. We don't want
    // the production listener to silently swallow malformed payloads.
    const src = readFileSync(
      join(__dirname, '..', 'lib', 'push-deep-link-dispatch.ts'),
      'utf8',
    );
    expect(src).toContain('console.warn');
    expect(src).toContain('[push]');
  });
});

describe('installPushTapHandler wrapper (source-pin)', () => {
  // The Expo notifications API is not loadable under bun-test (no
  // real RN runtime), so the wrapper's behaviour is verified by
  // asserting the source wires `getLastNotificationResponseAsync`
  // (cold-start) AND `addNotificationResponseReceivedListener`
  // (warm). Matches the precedent at
  // `app/__tests__/chat-deep-link-navigator.test.ts` for testing
  // RN-coupled wrappers.
  it('subscribes to both cold-start + warm notification responses', () => {
    const src = readFileSync(
      join(__dirname, '..', 'lib', 'push.ts'),
      'utf8',
    );
    expect(src).toContain('Notifications.getLastNotificationResponseAsync');
    expect(src).toContain(
      'Notifications.addNotificationResponseReceivedListener',
    );
    expect(src).toContain('resolvePushRoute');
  });

  it('root layout mounts the push tap handler alongside the doc-link handler', () => {
    const src = readFileSync(
      join(__dirname, '..', 'app', '_layout.tsx'),
      'utf8',
    );
    expect(src).toContain('installPushTapHandler');
    expect(src).toContain('usePushTapRouting');
  });

  // Codex r1 P2 + Argus r1 I2 round 2 — cold-start dedupe by
  // request.identifier. Expo's `getLastNotificationResponseAsync`
  // keeps returning the same last response until explicitly cleared,
  // so a remount / second-launch after the warm listener already
  // routed the tap can replay a stale notification. Round 2 promotes
  // the in-memory Set to a persistent `PushTapDedupeStore` with a
  // 7-day TTL so force-quit + relaunch can't replay either.
  it('dedupes by notification request.identifier via a persistent dedupe store', () => {
    const src = readFileSync(
      join(__dirname, '..', 'lib', 'push.ts'),
      'utf8',
    );
    expect(src).toContain('PushTapDedupeStore');
    expect(src).toContain('pushTapDedupeStore');
    expect(src).toContain('request.identifier');
    expect(src).toContain('store.markSeen');
    expect(src).toContain('store.has');
    expect(src).toContain('__resetPushTapDedupeForTesting');
  });

  // Argus r1 I2 round 2 — belt-and-braces: cold-start dispatch must
  // dismiss the notification via Expo's
  // `dismissNotificationAsync(notificationId)` so the OS itself stops
  // re-surfacing it from `getLastNotificationResponseAsync` on later
  // cold-starts. Defense in depth on top of the persisted set.
  it('dismisses cold-start notifications via dismissNotificationAsync', () => {
    const src = readFileSync(
      join(__dirname, '..', 'lib', 'push.ts'),
      'utf8',
    );
    expect(src).toContain('dismissNotificationAsync');
  });

  // Argus r1 I2 round 2 — cold-start dispatch must AWAIT hydration
  // so a persisted seen-id is visible by the time the response is
  // routed. Warm dispatch does not need to await (the user-initiated
  // tap is already racing in-memory).
  it('cold-start branch awaits dedupe-store hydration before dispatching', () => {
    const src = readFileSync(
      join(__dirname, '..', 'lib', 'push.ts'),
      'utf8',
    );
    expect(src).toContain('store.hydrate()');
    // The cold-start chain must thread hydrate → getLastNotification...
    // — pinned by string-presence so a future refactor that drops the
    // await regresses here.
    expect(src).toMatch(/hydrated\s*\n?\s*\.then\(\(\)\s*=>\s*Notifications\.getLastNotificationResponseAsync\(\)\)/);
  });
});
