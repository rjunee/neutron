/**
 * THE APP MUST OPEN ON A CHAT ROUTE (SPEC § Decisions Log 2026-07-27).
 *
 * Ryan locked this on device — *"I don't want this screen shown. It should just
 * open into the general chat with the rail on the left. Delete this screen
 * completely."* — and the code went unchanged for two days: the decision was
 * written down, `app/index.tsx` kept `router.replace('/projects')`, and he hit
 * the list screen again on 2026-07-29. Nothing failed in between because nothing
 * asserted it.
 *
 * That is what this file is for. Every test here fails against the pre-fix
 * code: `entryRouteForProjects` did not exist, and the source pins at the bottom
 * assert the list route is GONE from the entry (they would have caught the
 * two-day gap on their own).
 *
 * The app suite has no React Native mount harness (see
 * `project-card-interactivity.test.ts`), so the DECISION lives in a pure module
 * and is asserted directly; the wiring is source-pinned, in the established
 * style of `server-editor-reachability.test.ts`.
 *
 * FIXTURE IDS ARE INVENTED, and hosts are `*.example.com`. This is a PUBLIC repo
 * and `scripts/ci/leak-gate.sh` matches an owner-PII denylist that only exists as
 * a CI secret — so a fixture named after one of the owner's real projects passes
 * locally and fails the `purity` gate. The first draft of this file did exactly
 * that.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  chatRouteForProject,
  entryRouteForProjects,
  GENERAL_CHAT_ROUTE,
  resolveEntryRoute,
} from '../lib/entry-route';
import { GENERAL_PROJECT_ID } from '../lib/project-rail-view';
import type { Project } from '../lib/projects';

const APP_ROOT = join(__dirname, '..');
const read = (...parts: string[]): string => readFileSync(join(APP_ROOT, ...parts), 'utf8');

function project(over: Partial<Project> & Pick<Project, 'id'>): Project {
  return {
    name: over.id,
    label: over.id,
    description: '',
    emoji: '📁',
    last_activity_ms: 0,
    unread_count: 0,
    members: [],
    persona: '',
    privacy_mode: 'private',
    kind: 'solo',
    origin_instance: 'local',
    ...over,
  };
}

describe('the entry route is always a CHAT route', () => {
  it('opens on the MOST RECENTLY ACTIVE project chat', () => {
    const route = entryRouteForProjects([
      project({ id: 'willow', last_activity_ms: 1_000 }),
      project({ id: 'orchard', last_activity_ms: 9_000 }),
      project({ id: 'tabs', last_activity_ms: 5_000 }),
    ]);
    expect(route).toBe('/projects/orchard/chat');
  });

  it('never resolves to the deleted list route, whatever the input', () => {
    const inputs: Array<readonly Project[] | null> = [
      null,
      [],
      [project({ id: 'willow' })],
      [project({ id: 'shared-one', kind: 'shared', origin_instance: 'acme' })],
    ];
    for (const input of inputs) {
      const route = entryRouteForProjects(input);
      expect(route).not.toBe('/projects');
      // The invariant Ryan actually asked for: it is a chat route.
      expect(route.endsWith('/chat')).toBe(true);
    }
  });

  it('falls back to GENERAL when there are no projects', () => {
    expect(entryRouteForProjects([])).toBe(GENERAL_CHAT_ROUTE);
    expect(GENERAL_CHAT_ROUTE).toBe(`/projects/${GENERAL_PROJECT_ID}/chat`);
  });

  it('falls back to GENERAL when the fetch failed (null), not to a blank screen', () => {
    expect(entryRouteForProjects(null)).toBe(GENERAL_CHAT_ROUTE);
  });

  it('SKIPS non-navigable shared projects — entering on one opens the wrong local project', () => {
    // `projectCardInteractivity(shared).navigable === false`: the detail loader
    // is local-only, so a shared id resolves to an empty or COLLIDING local
    // project. A shared project must never be the app's entry.
    const route = entryRouteForProjects([
      project({ id: 'acme', kind: 'shared', origin_instance: 'acme', last_activity_ms: 9_000 }),
      project({ id: 'willow', kind: 'solo', last_activity_ms: 1_000 }),
    ]);
    expect(route).toBe('/projects/willow/chat');
  });

  it('resolves to GENERAL when EVERY project is shared', () => {
    expect(
      entryRouteForProjects([
        project({ id: 'acme', kind: 'shared', origin_instance: 'acme' }),
      ]),
    ).toBe(GENERAL_CHAT_ROUTE);
  });

  it('ties break deterministically by id (a fresh list has equal timestamps)', () => {
    const route = entryRouteForProjects([
      project({ id: 'beta', last_activity_ms: 7 }),
      project({ id: 'alpha', last_activity_ms: 7 }),
    ]);
    expect(route).toBe('/projects/alpha/chat');
  });

  it('percent-encodes an id with a space, and leaves the ~general sentinel alone', () => {
    expect(chatRouteForProject('my project')).toBe('/projects/my%20project/chat');
    // ISSUES #411 — `~` survives encodeURIComponent untouched, which is the
    // whole reason the sentinel is `~general` and not web's `#general`.
    expect(GENERAL_CHAT_ROUTE).toBe('/projects/~general/chat');
  });
});

describe('resolveEntryRoute against the gateway', () => {
  const originalFetch = globalThis.fetch;
  const withFetch = async (
    impl: typeof globalThis.fetch,
    body: () => Promise<string>,
  ): Promise<string> => {
    globalThis.fetch = impl;
    try {
      return await body();
    } finally {
      globalThis.fetch = originalFetch;
    }
  };

  it('picks the most-recent project from a real list payload', async () => {
    const route = await withFetch(
      (async () =>
        new Response(
          JSON.stringify({
            projects: [
              {
                id: 'willow',
                name: 'Willow',
                description: '',
                persona: '',
                privacy_mode: 'private',
                billing_mode: 'personal',
                members: [],
                kind: 'solo',
                origin_instance: 'local',
                last_activity_at: '2026-07-01T00:00:00.000Z',
              },
              {
                id: 'tabs',
                name: 'Tabs',
                description: '',
                persona: '',
                privacy_mode: 'private',
                billing_mode: 'personal',
                members: [],
                kind: 'solo',
                origin_instance: 'local',
                last_activity_at: '2026-07-28T00:00:00.000Z',
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )) as unknown as typeof globalThis.fetch,
      () => resolveEntryRoute({ base_url: 'https://instance.example.com', token: 't' }),
    );
    expect(route).toBe('/projects/tabs/chat');
  });

  it('an OFFLINE launch lands on General instead of throwing or hanging', async () => {
    const route = await withFetch(
      (async () => {
        throw new Error('Network request failed');
      }) as unknown as typeof globalThis.fetch,
      () => resolveEntryRoute({ base_url: 'https://instance.example.com', token: 't' }),
    );
    expect(route).toBe(GENERAL_CHAT_ROUTE);
  });

  it('a 500 from the gateway lands on General too', async () => {
    const route = await withFetch(
      (async () => new Response('boom', { status: 500 })) as unknown as typeof globalThis.fetch,
      () => resolveEntryRoute({ base_url: 'https://instance.example.com', token: 't' }),
    );
    expect(route).toBe(GENERAL_CHAT_ROUTE);
  });
});

describe('the entry is WIRED — the list screen is gone, not merely unused', () => {
  it('app/index.tsx redirects through resolveEntryRoute, never to /projects', () => {
    const src = read('app', 'index.tsx');
    expect(src).toContain('resolveEntryRoute');
    expect(src).not.toContain("router.replace('/projects')");
  });

  it('the list SCREEN FILE does not exist', () => {
    expect(() => read('app', 'projects', 'index.tsx')).toThrow();
  });

  it('the list route is unregistered on the Stack (a screen for a deleted file)', () => {
    expect(read('app', '_layout.tsx')).not.toContain('projects/index');
    // The project shell itself is still registered — this is a deletion, not a
    // regression that takes the workspace with it.
    expect(read('app', '_layout.tsx')).toContain('<Stack.Screen name="projects/[id]" />');
  });

  it('NOTHING anywhere navigates to the list route any more', () => {
    // Enumerated, not spot-checked: the same technique as
    // `server-editor-reachability.test.ts`, so a reintroduced `/projects` hop in
    // any file fails here.
    //
    // NOT `/g`. A global regex reused across `.test()` calls carries `lastIndex`
    // between files, so it silently SKIPS matches — the first draft of this test
    // missed `app/focus.tsx` (three real offenders) for exactly that reason and
    // reported a shorter list than the truth.
    const re = /router\.(?:push|replace)\(\s*['"`]\/projects['"`]\s*\)/;
    const offenders: string[] = [];
    for (const dir of ['app', 'components', 'lib']) {
      const walk = (rel: string): void => {
        for (const entry of readdirSync(join(APP_ROOT, rel))) {
          if (entry === 'node_modules') continue;
          const relFull = join(rel, entry);
          if (statSync(join(APP_ROOT, relFull)).isDirectory()) walk(relFull);
          else if (/\.(ts|tsx)$/.test(entry) && re.test(read(relFull))) offenders.push(relFull);
        }
      };
      walk(dir);
    }
    expect(offenders).toEqual([]);
  });
});
