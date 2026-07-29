/**
 * The General rail entry must open the General TRANSCRIPT.
 *
 * Found on a running emulator, not by reading code: tapping General produced a
 * permanently empty chat. `GENERAL_PROJECT_ID` is a sentinel that only *looks*
 * like a project id — it has to, because the rail selects by id and the only
 * chat route is `/projects/[id]/chat` — so it reached `appWsProjectTopicId`
 * unchanged and derived `app:<user>:general`, a topic that has never existed.
 * General is the NO-PROJECT scope; its topic is `app:<user>`.
 *
 * These assert the collapse, in both directions, so the sentinel can never
 * again be mistaken for a project on its way to a topic key.
 */
import { describe, expect, test } from 'bun:test';
import { appWsProjectTopicId, appWsTopicId } from '@neutronai/wire-types/topic-id.ts';
import { GENERAL_PROJECT_ID, railIdToScope } from '../lib/project-rail-view';

const USER = 'owner';

/** Mirrors the derivation in `use-mobile-chat.ts` after the collapse. */
function topicForRailId(railId: string): string {
  const scope = railIdToScope(railId);
  return scope.length > 0 ? appWsProjectTopicId(USER, scope) : appWsTopicId(USER);
}

describe('General rail entry resolves to the General scope', () => {
  test('General maps to the USER topic, never to app:<user>:general', () => {
    expect(topicForRailId(GENERAL_PROJECT_ID)).toBe(appWsTopicId(USER));
    expect(topicForRailId(GENERAL_PROJECT_ID)).not.toBe(
      appWsProjectTopicId(USER, GENERAL_PROJECT_ID),
    );
  });

  test('a real project is untouched by the collapse', () => {
    expect(railIdToScope('willow')).toBe('willow');
    expect(topicForRailId('willow')).toBe(appWsProjectTopicId(USER, 'willow'));
  });

  test('General and a project never share a topic', () => {
    expect(topicForRailId(GENERAL_PROJECT_ID)).not.toBe(topicForRailId('willow'));
  });

  test('the collapse yields the empty scope, which is what "no project" means on the wire', () => {
    // The socket URL and the transcript filter both branch on this same
    // emptiness, so a non-empty sentinel here would desync all three.
    expect(railIdToScope(GENERAL_PROJECT_ID)).toBe('');
  });
});

describe('ISSUES #410 — the scope sentinel cannot collide with a real project id', () => {
  // The gateway's validator, mirrored: `channels/adapters/app-ws/envelope.ts`
  // `sanitizeProjectId` accepts only these characters, so anything it REJECTS
  // can never be a real project id.
  const LEGAL_PROJECT_ID = /^[A-Za-z0-9_.-]+$/;

  test('the sentinel is rejected by the gateway validator — collision-proof by construction', () => {
    expect(LEGAL_PROJECT_ID.test(GENERAL_PROJECT_ID)).toBe(false);
  });

  test('the two sentinels that were TRIED and FAILED are both legal project ids', () => {
    // Recorded so nobody re-proposes them. `general` was mobile's bug (#410);
    // `__general__` was web's earlier attempt, and it collided too.
    expect(LEGAL_PROJECT_ID.test('general')).toBe(true);
    expect(LEGAL_PROJECT_ID.test('__general__')).toBe(true);
  });

  test('a REAL project called "general" keeps its OWN topic, distinct from the scope', () => {
    // The user-visible regression: on an instance that has such a project
    // (Ryan's does), it was unreachable because the rail id was swallowed.
    expect(topicForRailId('general')).toBe(appWsProjectTopicId(USER, 'general'));
    expect(topicForRailId('general')).not.toBe(topicForRailId(GENERAL_PROJECT_ID));
    expect(railIdToScope('general')).toBe('general');
  });

  test('the scope still resolves to the user topic', () => {
    expect(topicForRailId(GENERAL_PROJECT_ID)).toBe(appWsTopicId(USER));
  });

  test('THE SECOND CONSTRAINT (#411): the sentinel needs NO percent-encoding', () => {
    // This is the property #460 violated and that unit tests missed, because
    // nothing here exercised the ROUTER. Mobile puts the rail id straight into
    // `/projects/[id]/chat`, so the sentinel must survive as a path segment —
    // a constraint web's `#general` never had to meet, since there it is only
    // ever a map key. `#` needs `%23` AND is the fragment delimiter; on-device
    // the General tile landed on the projects list instead of the chat.
    expect(encodeURIComponent(GENERAL_PROJECT_ID)).toBe(GENERAL_PROJECT_ID);
    expect(GENERAL_PROJECT_ID).not.toContain('#');
  });

  test('the route built from the sentinel round-trips through URL parsing', () => {
    const route = `/projects/${encodeURIComponent(GENERAL_PROJECT_ID)}/chat`;
    expect(route).toBe('/projects/~general/chat');
    expect(new URL(route, 'http://x').pathname).toBe(route);
  });
});
