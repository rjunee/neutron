/**
 * @neutronai/app — REPRODUCTION: tapping a project in the rail must put THAT
 * project on the wire.
 *
 * This mounts the real project shell (`app/projects/[id]/_layout.tsx`) over a
 * routing harness, so a switch travels the whole chain the device travels:
 * rail tap → `/projects/<id>` → the shell's settings gate → `<Slot/>` → the
 * default-tab redirect screen → `/projects/<id>/chat` → the chat surface → a
 * socket. Every previous test on this defect stopped at one link of that chain.
 *
 * THE ASSERTION IS THE SOCKET, deliberately. "The spinner came down" has already
 * passed while the owner could not open a single project; the server's session
 * log is what said the client was not even trying.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { act, createElement } from 'react';

import {
  installNativeHarness,
  setHarnessPlatform,
  resetHarnessGlobals,
  withoutWebCrypto,
} from './support/native-harness';

installNativeHarness();
setHarnessPlatform('ios');

const { FakeChatSocket, mountScreen } = await import('./support/mount');
// The stub BY PATH, not by the `'expo-router'` specifier: the harness aliases
// that specifier at runtime, but `tsc` resolves it to the real package, whose
// types carry none of the routing controls below.
const { installRouting, resetRouting, useRouter, currentRouterPath } = await import(
  './support/stubs/expo-router'
);
const { REQUEST_TIMEOUT_MS } = await import('../lib/projects-client');
const { LAST_TAB_READ_TIMEOUT_MS } = await import('../app/projects/[id]/index');
const { LastTabStore, __setLastTabStorageForTests, __resetLastTabStorageForTests } =
  await import('../lib/last-tab-storage');
const { GENERAL_CHAT_ROUTE } = await import('../lib/entry-route');
const { setRuntimeServerConfig, __resetServerConfigForTests } = await import('../lib/config');
const { AuthSessionProvider } = await import('../lib/session');
const { clearSessionCache } = await import('../lib/chat-core/session-cache');
const { __resetSharedMobileStoreForTests } = await import('../lib/chat-core/op-sqlite-store');

const ProjectLayout = (await import('../app/projects/[id]/_layout')).default;
const ProjectIndexRedirect = (await import('../app/projects/[id]/index')).default;
const ProjectChatTab = (await import('../app/projects/[id]/chat')).default;

const OWNER = {
  id: 'harness-owner',
  email: 'owner@example.test',
  displayName: 'Harness Owner',
  provider: 'dev' as const,
  token: 'harness-token',
};
const BASE_URL = 'https://harness.example.test';

/** The owner's rail, in the shape the list endpoint returns. */
const PROJECTS = ['willow', 'acme', 'orchard'] as const;

let restoreCrypto: (() => void) | null = null;
let realFetch: typeof fetch;

function settingsDoc(id: string) {
  return {
    id,
    name: id,
    description: '',
    persona: '',
    emoji: '📁',
    privacy_mode: 'private',
    billing_mode: 'personal',
    agent_engagement_mode: 'all_messages',
    members: [],
  };
}

function listRow(id: string) {
  return {
    ...settingsDoc(id),
    kind: 'solo',
    origin_instance: 'local',
    owning_instance_slug: 'local',
    last_activity_at: new Date().toISOString(),
    unread_count: 0,
  };
}

/** A gateway that answers everything the shell asks for, promptly. */
function installGateway(): void {
  (globalThis as { fetch: typeof fetch }).fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(BASE_URL, '').split('?')[0] ?? '';
    if (path === '/api/app/projects') {
      return Response.json({ ok: true, projects: PROJECTS.map(listRow), project_slug: 'local' });
    }
    const settings = /^\/api\/app\/projects\/([^/]+)\/settings$/.exec(path);
    if (settings !== null) {
      const id = decodeURIComponent(settings[1] ?? '');
      return Response.json({ ok: true, project: settingsDoc(id), project_id: id });
    }
    const tabs = /^\/api\/app\/projects\/([^/]+)\/tabs$/.exec(path);
    if (tabs !== null) return Response.json({ ok: true, tabs: [] });
    return Response.json({ ok: false, code: 'not_found', message: path }, { status: 404 });
  }) as typeof fetch;
}

beforeEach(() => {
  restoreCrypto = withoutWebCrypto();
  realFetch = globalThis.fetch;
  installGateway();
  FakeChatSocket.install();
  clearSessionCache();
  __resetSharedMobileStoreForTests();
  __resetLastTabStorageForTests();
  __resetServerConfigForTests();
  setRuntimeServerConfig({ gateway_base_url: BASE_URL, auth_base_url: null });
});

afterEach(() => {
  restoreCrypto?.();
  restoreCrypto = null;
  (globalThis as { fetch: typeof fetch }).fetch = realFetch;
  resetRouting();
  clearSessionCache();
  __resetSharedMobileStoreForTests();
  __resetLastTabStorageForTests();
});

beforeAll(installNativeHarness);

afterAll(() => {
  resetRouting();
  __resetServerConfigForTests();
  resetHarnessGlobals();
});

function socketsFor(projectId: string): number {
  return FakeChatSocket.opened.filter((s) => s.url.includes(`project_id=${projectId}`)).length;
}

async function mountShell(path: string, opts: { paramsBlind?: boolean } = {}) {
  installRouting({
    path,
    routes: {
      index: ProjectIndexRedirect as never,
      chat: ProjectChatTab as never,
    },
    ...(opts.paramsBlind === true ? { paramsBlind: true } : {}),
  });
  return mountScreen(
    createElement(
      AuthSessionProvider,
      { initialUser: OWNER },
      createElement(ProjectLayout, null),
    ),
  );
}

/** Real time, with React able to observe whatever timers the tree armed. */
async function waitReal(ms: number, screen?: { settle(): Promise<void> }): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  });
  await screen?.settle();
}

/** What the rail tap does — the shell's own handler, through the real router. */
async function tapRail(projectId: string): Promise<void> {
  await act(async () => {
    useRouter().replace(`/projects/${encodeURIComponent(projectId)}`);
  });
}

describe('switching projects', () => {
  it('opens the app on one project and puts it on the wire', async () => {
    const screen = await mountShell('/projects/willow/chat');
    await waitReal(50, screen);

    expect(socketsFor('willow')).toBeGreaterThan(0);
    expect(screen.byTestId('project-content-loading')).toBeNull();
    screen.unmount();
  });

  it('a rail tap on a DIFFERENT project reaches that project’s chat', async () => {
    const screen = await mountShell('/projects/willow/chat');
    await waitReal(50, screen);
    expect(socketsFor('willow')).toBeGreaterThan(0);

    await tapRail('acme');
    await waitReal(50, screen);

    // The chain: the shell resolved `acme`, mounted `<Slot/>`, the redirect
    // screen chose the default tab, and the chat surface connected.
    expect(currentRouterPath()).toBe('/projects/acme/chat');
    expect(screen.byTestId('project-content-loading')).toBeNull();
    expect(socketsFor('acme')).toBeGreaterThan(0);
    screen.unmount();
  });

  it('every project the owner taps gets a socket', async () => {
    const screen = await mountShell('/projects/willow/chat');
    await waitReal(50, screen);

    for (const project of ['acme', 'orchard', 'willow', 'acme']) {
      await tapRail(project);
      await waitReal(50, screen);
      expect(socketsFor(project)).toBeGreaterThan(0);
    }
    screen.unmount();
  });

  it(
    'still reaches the tapped project when the route PARAM does not name it',
    async () => {
      // The hazard `_layout.tsx` recorded from the device, applied to the screens
      // INSIDE the shell: the param does not carry the current `[id]`. The shell
      // reads the path and is fine; the redirect screen and the chat surface must
      // read the same thing, or the tap lands on the wrong scope (or on nothing)
      // while the header and rail confidently name the right one.
      const screen = await mountShell('/projects/willow/chat', { paramsBlind: true });
      await waitReal(50, screen);
      expect(socketsFor('willow')).toBeGreaterThan(0);

      await tapRail('acme');
      await waitReal(50, screen);

      expect(currentRouterPath()).toBe('/projects/acme/chat');
      expect(socketsFor('acme')).toBeGreaterThan(0);
      screen.unmount();
    },
    20_000,
  );
});

describe('a wait that cannot end is not allowed to be the screen', () => {
  it(
    'a last-tab read that never answers still lands the owner in the chat',
    async () => {
      // `try/catch` cannot save you from a promise that never settles, and the
      // native storage read is a bridge call with no timeout of its own. The
      // preference is a nicety; arriving at the project is not.
      __setLastTabStorageForTests(
        new LastTabStore({
          getItem: () => new Promise<string | null>(() => {}),
          setItem: () => {},
          removeItem: () => {},
        }),
      );

      const screen = await mountShell('/projects/willow/chat');
      await waitReal(50, screen);

      await tapRail('acme');
      await waitReal(LAST_TAB_READ_TIMEOUT_MS + 400, screen);

      expect(currentRouterPath()).toBe('/projects/acme/chat');
      expect(socketsFor('acme')).toBeGreaterThan(0);
      screen.unmount();
    },
    LAST_TAB_READ_TIMEOUT_MS + 20_000,
  );

  it('a redirect screen with NO scope to resolve goes to General, not to a spinner', async () => {
    // Neither source names a project. The screen used to return from its effect
    // and leave its own ActivityIndicator up permanently — a dead end with a
    // live rail around it. General always exists and needs no fetch.
    installRouting({ path: '/settings', routes: {}, paramsBlind: true });
    const screen = await mountScreen(
      createElement(
        AuthSessionProvider,
        { initialUser: OWNER },
        createElement(ProjectIndexRedirect, null),
      ),
    );
    await waitReal(50, screen);

    expect(currentRouterPath()).toBe(GENERAL_CHAT_ROUTE);
    screen.unmount();
  });

  it(
    'a settings fetch that never answers becomes a RETRYABLE error, not a spinner',
    async () => {
      // The production settings store synthesises defaults rather than 404ing
      // (`gateway/http/app-projects-surface.ts` `buildDefaultSettings`), so the
      // shell's failure pane was unreachable and every stall was permanent.
      // Bound the request and the pane becomes reachable — with copy that blames
      // the connection rather than the project sitting right there in the rail.
      const passthrough = globalThis.fetch;
      (globalThis as { fetch: typeof fetch }).fetch = (async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('/projects/acme/settings')) {
          // Never answers — but honours the abort the client must be arming.
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(new Error('aborted'));
            });
          });
        }
        return passthrough(input as never, init as never);
      }) as typeof fetch;

      const screen = await mountShell('/projects/willow/chat');
      await waitReal(50, screen);

      await tapRail('acme');
      await waitReal(REQUEST_TIMEOUT_MS + 600, screen);

      expect(screen.byTestId('project-content-loading')).toBeNull();
      expect(screen.byTestId('project-load-failed')).not.toBeNull();
      expect(screen.byTestId('project-load-retry')).not.toBeNull();
      // And it does NOT accuse the project of being missing.
      expect(screen.text()).not.toContain('Project not found');
      screen.unmount();
    },
    REQUEST_TIMEOUT_MS + 30_000,
  );
});
