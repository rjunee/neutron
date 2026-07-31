/**
 * @neutronai/app — A RAIL TAP LANDS ON THE PROJECT YOU TAPPED (device defect,
 * 2026-07-31).
 *
 * WHAT THE OWNER SAW, on the APK: every rail tap on a project put him on the
 * PREVIOUSLY-ACTIVE project instead. Tapping a third project from General went
 * to the project he had been in before General — the tapped one never loaded,
 * the rail highlight never moved, and the content pane showed a spinner during
 * the bounce. General was the one entry that always worked.
 *
 * THE MECHANISM, instrumented on device (the release build has no console, so
 * the trace below came out through `testID`s read from the accessibility tree;
 * project names neutralised):
 *
 *     press=harbor; rail:tap=harbor:cur=willow;
 *     wp:mount=harbor;      ← the waypoint resolved the RIGHT scope
 *     shell=harbor;         ← the shell moved to it
 *     wp:mount=willow;      ← …then it was re-mounted on the PREVIOUS scope
 *     shell=willow;
 *     wp:go=willow/chat     ← …and it navigated there
 *
 * Three facts compose into that bounce:
 *
 *   1. The shell is ONE root-stack screen named `projects/[id]`, and
 *      expo-router only treats a dynamic segment as diverging when the route
 *      name is exactly `[id]` (`matchDynamicName`, `/^\[([^[\]]+?)\]$/`,
 *      expo-router 6.0.24). So an in-app project switch is applied to the CHILD
 *      navigator and the root route keeps the id you came FROM.
 *   2. The shell rendered the loading pane INSTEAD of `<Slot/>`. `<Slot/>` is
 *      the `[id]` group's navigator, so that unmounted it; remounting re-seeds
 *      it from the stale parent and it opens at its initial route — the
 *      `/projects/<id>` waypoint — carrying the previous project's id.
 *   3. The waypoint's whole job is to navigate. Handed a stale id, it took the
 *      owner back.
 *
 *   …and General's immunity falls out of (2): General has no settings doc to
 *   fetch, so it is never `loading`, so its slot never unmounted.
 *
 * WHAT THIS FILE PINS. The harness models the PATH as the single source of
 * truth, so it cannot reproduce expo-router's stale route params (its own header
 * says so) — but it does not need to. Each test below pins one of the three
 * links, in the terms the harness speaks natively:
 *
 *   A. the tap navigates STRAIGHT to a tab route, so no waypoint is involved;
 *   B. the slot stays MOUNTED while a scope loads, so no navigator is destroyed;
 *   C. the waypoint commits to the scope it was entered with, so a router that
 *      re-reports the previous project cannot steer it.
 *
 * All three fail on the code that shipped this defect.
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

const { mountScreen } = await import('./support/mount');
const { installRouting, resetRouting, useRouter, currentRouterPath, routerCalls } = await import(
  './support/stubs/expo-router'
);
const { LastTabStore, __setLastTabStorageForTests, __resetLastTabStorageForTests } =
  await import('../lib/last-tab-storage');
const { setRuntimeServerConfig, __resetServerConfigForTests } = await import('../lib/config');
const { __resetProjectSettingsCacheForTests } = await import('../lib/project-settings-cache');
const { AuthSessionProvider } = await import('../lib/session');
const { clearSessionCache } = await import('../lib/chat-core/session-cache');
const { __resetSharedMobileStoreForTests } = await import('../lib/chat-core/op-sqlite-store');
const { FakeChatSocket } = await import('./support/mount');

const ProjectLayout = (await import('../app/projects/[id]/_layout')).default;
const ProjectIndexRedirect = (await import('../app/projects/[id]/index')).default;

const OWNER = {
  id: 'harness-owner',
  email: 'owner@example.test',
  displayName: 'Harness Owner',
  provider: 'dev' as const,
  token: 'harness-token',
};
const BASE_URL = 'https://harness.example.test';
const PROJECTS = ['willow', 'harbor', 'lantern'] as const;

/** A stand-in for whatever tab screen the route names — mounted, or not. */
function TabScreen() {
  return createElement('div', { 'data-testid': 'routed-tab-screen' });
}

let restoreCrypto: (() => void) | null = null;
let realFetch: typeof fetch;
/** Scopes whose settings request is held open until the test releases it. */
const held = new Map<string, (v: Response) => void>();

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

function installGateway(holdSettingsFor: readonly string[] = []): void {
  (globalThis as { fetch: typeof fetch }).fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(BASE_URL, '').split('?')[0] ?? '';
    if (path === '/api/app/projects') {
      return Response.json({ ok: true, projects: PROJECTS.map(listRow), project_slug: 'local' });
    }
    const settings = /^\/api\/app\/projects\/([^/]+)\/settings$/.exec(path);
    if (settings !== null) {
      const id = decodeURIComponent(settings[1] ?? '');
      if (holdSettingsFor.includes(id)) {
        // In flight, indefinitely — this is the `loading` frame, held open so a
        // test can look at what the shell renders during it.
        return new Promise<Response>((resolve) => {
          held.set(id, resolve);
        });
      }
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
  held.clear();
  installGateway();
  FakeChatSocket.install();
  clearSessionCache();
  __resetSharedMobileStoreForTests();
  __resetLastTabStorageForTests();
  __resetProjectSettingsCacheForTests();
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

async function mountShell(path: string) {
  installRouting({
    path,
    routes: { index: ProjectIndexRedirect as never, chat: TabScreen as never, docs: TabScreen as never },
  });
  return mountScreen(
    createElement(AuthSessionProvider, { initialUser: OWNER }, createElement(ProjectLayout, null)),
  );
}

async function waitReal(ms: number, screen?: { settle(): Promise<void> }): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  });
  await screen?.settle();
}

describe('a rail tap goes straight to the project it names', () => {
  it('navigates to that project’s TAB route, never to the `/projects/<id>` waypoint', async () => {
    const screen = await mountShell('/projects/willow/chat');
    await waitReal(60, screen);
    routerCalls.length = 0;

    // The real rail entry, pressed by the label the rail renders.
    await screen.press('Open harbor');
    await waitReal(60, screen);

    // ONE navigation, and it is the destination — not a hop that has to
    // re-derive the scope from a router that can answer with the previous one.
    expect(routerCalls.map((c) => c.href)).toEqual(['/projects/harbor/chat']);
    expect(currentRouterPath()).toBe('/projects/harbor/chat');
    screen.unmount();
  });

  it('honours this device’s last tab for the tapped project, still in one hop', async () => {
    __setLastTabStorageForTests(
      new LastTabStore(
        (() => {
          const map = new Map<string, string>([['neutron.project.harbor.lastTab', 'docs']]);
          return {
            getItem: (k: string) => Promise.resolve(map.get(k) ?? null),
            setItem: (k: string, v: string) => {
              map.set(k, v);
            },
            removeItem: (k: string) => {
              map.delete(k);
            },
          };
        })(),
      ),
    );
    const screen = await mountShell('/projects/willow/chat');
    await waitReal(60, screen);
    routerCalls.length = 0;

    await screen.press('Open harbor');
    await waitReal(60, screen);

    expect(routerCalls.map((c) => c.href)).toEqual(['/projects/harbor/docs']);
    screen.unmount();
  });
});

describe('a scope that is still loading must not tear the navigator down', () => {
  it('keeps the slot MOUNTED under the loading pane', async () => {
    // `<Slot/>` is the `[id]` group's navigator. Rendering the spinner INSTEAD
    // of it unmounts that navigator, and the remount re-seeds from the parent
    // route — which, across an in-app switch, still names the previous project.
    // That is the whole bounce, so the slot has to survive the loading frame.
    installGateway(['harbor']);
    const screen = await mountShell('/projects/willow/chat');
    await waitReal(60, screen);

    // FORCE THE UN-WARMED PATH. The list call the rail makes now files every
    // solo row's settings doc (`project-settings-cache.ts`), so a project the
    // rail can show is normally painted from memory and never reaches this pane
    // at all — that is the instant-switch behaviour, pinned separately in
    // `project-switch-is-instant.test.tsx`. The loading pane still exists for
    // the scopes nothing has been told about yet (a deep link that outruns the
    // list, a cold launch), and THAT is the state this test is about: whatever
    // covers the content pane must be drawn OVER a mounted `<Slot/>`, never
    // instead of it.
    __resetProjectSettingsCacheForTests();

    await screen.press('Open harbor');
    await waitReal(60, screen);

    expect(screen.byTestId('project-content-loading')).not.toBeNull();
    expect(screen.byTestId('routed-tab-screen')).not.toBeNull();

    held.get('harbor')?.(
      Response.json({ ok: true, project: settingsDoc('harbor'), project_id: 'harbor' }),
    );
    await waitReal(60, screen);
    expect(screen.byTestId('project-content-loading')).toBeNull();
    expect(screen.byTestId('routed-tab-screen')).not.toBeNull();
    screen.unmount();
  });
});

describe('the waypoint commits to the scope it was entered with', () => {
  it('hands off to that scope even when the router re-reports the previous project', async () => {
    // THE DEVICE OBSERVATION, in the terms this harness speaks. On device the
    // waypoint was re-mounted on the id the ROOT route still carried; here the
    // path — this harness's single source of truth, which its params derive
    // from — reverts underneath the screen while its last-tab read is pending.
    // Either way the question is the same: does the screen hand off to the
    // scope it was entered for, or to whatever it is told a moment later?
    let release: (v: string | null) => void = () => {};
    __setLastTabStorageForTests(
      new LastTabStore({
        getItem: () =>
          new Promise<string | null>((resolve) => {
            release = resolve;
          }),
        setItem: () => {},
        removeItem: () => {},
      }),
    );

    installRouting({ path: '/projects/harbor', routes: { index: ProjectIndexRedirect as never } });
    const screen = await mountScreen(
      createElement(
        AuthSessionProvider,
        { initialUser: OWNER },
        createElement(ProjectIndexRedirect, null),
      ),
    );
    await waitReal(30, screen);

    // The router now says we are back on the project we came from.
    await act(() => {
      useRouter().replace('/projects/willow/chat');
    });
    await waitReal(30, screen);
    routerCalls.length = 0;

    // …and only now does the last-tab read answer.
    await act(async () => {
      release(null);
      await Promise.resolve();
    });
    await waitReal(60, screen);

    expect(routerCalls.map((c) => c.href)).toEqual(['/projects/harbor/chat']);
    screen.unmount();
  });
});
