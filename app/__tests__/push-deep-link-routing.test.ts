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
import { GENERAL_PROJECT_ID } from '../lib/project-rail-view';
import { PUSH_KINDS } from '@neutronai/wire-types/push-kind.ts';

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
  describe('agent_message kind — the ONE shape a chat message takes', () => {
    it('routes to /projects/<pid>/chat?message_id=<mid> — the CHAT, not the Reminders tab', () => {
      // The owner's second symptom: *"when I tapped the notification it opened
      // the app but didn't open in the right project"*. The retired `reminder`
      // kind routed to `/projects/<pid>/reminders` — a different tab from the one
      // the message is in — and its project field was the OWNER slug, so it could
      // not resolve a project at all.
      const path = resolvePushRoute({
        kind: 'agent_message',
        project_id: 'p1',
        message_id: 'm1',
      });
      expect(path).toBe('/projects/p1/chat?message_id=m1');
    });

    it('routes a project-less payload to the General chat — absence IS the encoding', () => {
      // The gateway deliberately omits `project_id` for the no-project scope
      // rather than shipping a copy of General's route sentinel (ISSUES #410/#411
      // is what a second copy costs). This is the decode half of that contract,
      // and it is what makes the owner's General ritual land in General.
      const path = resolvePushRoute({ kind: 'agent_message', message_id: 'm1' });
      expect(path).toBe(`/projects/${GENERAL_PROJECT_ID}/chat?message_id=m1`);
    });

    it('the General route id needs no percent-encoding (the #411 constraint)', () => {
      // `~general` survives `encodeURIComponent` untouched, which is the whole
      // reason it is a tilde and not `#general`. A route with a `%23` in it landed
      // on the projects list instead of the chat.
      const path = resolvePushRoute({ kind: 'agent_message', message_id: 'm1' });
      expect(path).not.toContain('%');
    });

    it('opens the chat unanchored (and warns) when message_id is missing', () => {
      // Half a payload still beats no navigation: the right transcript with its
      // own unread anchor is closer to what he asked for than staying put.
      const { warn, entries } = recordingWarn();
      const path = resolvePushRoute({ kind: 'agent_message', project_id: 'p1' }, { warn });
      expect(path).toBe('/projects/p1/chat');
      expect(entries[0]?.msg).toContain('no message_id');
    });

    it('url-encodes both the project segment and the message id', () => {
      // Defensive: a malformed payload must not be able to inject path segments.
      const path = resolvePushRoute({
        kind: 'agent_message',
        project_id: 'my proj/x',
        message_id: 'm?1',
      });
      expect(path).toBe('/projects/my%20proj%2Fx/chat?message_id=m%3F1');
    });
  });

  describe('the LEGACY `reminder` kind — no sender left, but its payloads are real', () => {
    // The SENDER is retired: it composed from the reminder ROW, which for a ritual
    // is the dispatch token `ritual:<id>`, i.e. the string the owner's phone
    // actually displayed. The DECODER stays, and these are the reasons — each one
    // an already-delivered payload this resolver will still be handed:
    //   - a notification sitting undismissed in the shade right now;
    //   - a self-hosted gateway that has not been upgraded, talking to a store app.
    // Deleting the decoder would turn those taps into "the app opens and nothing
    // routes", which is the complaint this whole change exists to end.

    it('an explicit project still lands on that project’s reminders tab', () => {
      const { warn, entries } = recordingWarn();
      const path = resolvePushRoute(
        { kind: 'reminder', project_id: 'acme', reminder_id: 'rem-abc' },
        { warn },
      );
      expect(path).toBe('/projects/acme/reminders?reminder_id=rem-abc');
      expect(entries).toEqual([]);
    });

    it('a PROJECT-scoped legacy payload resolves its project from `topic_id`', () => {
      // The retired sender wrote the reminder row's own topic when it had one
      // (`git show main:gateway/push/dispatcher.ts:277`), and a project reminder's
      // topic is `app-project:<id>` (`reminders/store.ts:474`). That is the ONLY
      // place a legacy project notification carries its project, so dropping this
      // decode would land those taps on General instead.
      const path = resolvePushRoute({
        kind: 'reminder',
        reminder_id: 'rem-abc',
        project_slug: 'owner',
        topic_id: 'app-project:beacon',
      });
      expect(path).toBe('/projects/beacon/reminders?reminder_id=rem-abc');
    });

    it('a GENERAL legacy payload falls back to General rather than refusing', () => {
      // The old sender put the OWNER slug in `project_slug` and no project id
      // anywhere, so this branch used to return null for every General reminder
      // notification ever sent — the owner's "it opens the app but not the right
      // project", in the code.
      const path = resolvePushRoute({
        kind: 'reminder',
        reminder_id: 'rem-abc',
        project_slug: 'owner',
      });
      expect(path).toBe('/projects/~general/reminders?reminder_id=rem-abc');
    });

    it('without a reminder_id there is nothing to open, so it refuses and says why', () => {
      const { warn, entries } = recordingWarn();
      const path = resolvePushRoute({ kind: 'reminder', project_id: 'acme' }, { warn });
      expect(path).toBeNull();
      expect(entries[0]?.msg).toContain('legacy reminder payload has no reminder_id');
    });

    it('is NOT in the sent list — that list is what the system emits', () => {
      // Padding `PUSH_KINDS` with a kind nothing sends is how the sent list and the
      // handled list drifted into being disjoint in the first place.
      expect((PUSH_KINDS as readonly string[]).includes('reminder')).toBe(false);
    });
  });

  describe('wow_fired kind', () => {
    it('routes to /projects/<pid>/chat', () => {
      const payload: PushPayload = { kind: 'wow_fired', project_id: 'neutron' };
      expect(resolvePushRoute(payload)).toBe('/projects/neutron/chat');
    });

    it('returns null + warns when project_id is missing', () => {
      const { warn, entries } = recordingWarn();
      const path = resolvePushRoute({ kind: 'wow_fired' }, { warn });
      expect(path).toBeNull();
      expect(entries[0]?.msg).toContain('wow_fired payload missing project_id');
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
    expect(src).toContain('useDocLinkRouting');
  });

  it('both handlers are gated on boot being ready AND a server being configured', () => {
    // Argus r2 MINOR: ISSUES #385 made push-tap routing conditional
    // (`usePushTapRouting(phase === 'ready')` + an `if (!enabled) return;`
    // early-out) because there is no navigator mounted to receive a
    // `router.push` before the Stack exists. The presence check above kept
    // passing straight through that behavioural change, so the gate itself
    // is pinned here.
    //
    // 2026-07-25 (LOGIN-FIRST): the gate gained a SECOND condition, and
    // widening it is deliberate. The Stack now mounts even when no server is
    // configured — that is what makes `/login` the first surface instead of
    // the typed-URL gate — so `phase === 'ready'` alone no longer implies
    // "safe to deep-link". Routing a push tap straight into a project screen
    // while unconfigured would fire requests at nowhere, the exact #385
    // failure. Both conditions are load-bearing; a future change that drops
    // either (or leaves the handlers permanently disabled) fails here.
    const src = readFileSync(
      join(__dirname, '..', 'app', '_layout.tsx'),
      'utf8',
    );
    expect(src).toContain("phase === 'ready' && loadAppConfig().configured");
    expect(src).toContain('usePushTapRouting(configured)');
    expect(src).toContain('useDocLinkRouting(configured)');
    // The early-out is what makes the flag load-bearing.
    expect(src).toContain('if (!enabled) return;');
    // And 'ready' has to be reachable: the boot state machine must set it.
    expect(src).toContain("setPhase('ready')");
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
