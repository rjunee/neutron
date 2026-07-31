/**
 * @neutronai/app — SWITCHING PROJECTS IS A TAP, NOT A LOAD (device defect,
 * 2026-07-31).
 *
 * WHAT THE OWNER SAW, on the APK: "I don't want to see like three screen
 * repaints and a loading indicator appearing for a second and disappearing. I
 * just want tap and instant switch."
 *
 * WHAT WAS ACTUALLY ON SCREEN, filmed at 30 fps on an Android emulator running
 * the release build and diffed frame by frame (8 rail taps, 2026-07-31): every
 * tap produced four to six distinct repaints, and the content pane was showing
 * something other than the destination for ~800 ms after the finger left the
 * glass. In order, on a single tap:
 *
 *   1. nothing at all for 70–130 ms, while an AsyncStorage read decided which
 *      tab to open — no acknowledgement of the tap, still the old project;
 *   2. the content pane blanked, because the shell covers it with a spinner
 *      while the new scope's settings doc is in flight;
 *   3. the tab bar flashed the PRE-FETCH loading default (Chat / Apps / Tasks /
 *      Reminders / Docs) for 3–4 frames, then flipped to the real set;
 *   4. a "Connecting…" strip and a hydrating spinner;
 *   5. "No messages yet. Say hello 👋" over a project with a full transcript;
 *   6. finally, the transcript.
 *
 * NONE OF (1)–(3) WAS WAITING ON ANYTHING IT DID NOT ALREADY HAVE. The rail's
 * own `GET /api/app/projects` returns each solo project's complete settings doc,
 * the tab set for every rail project can be resolved before the tap, and the
 * last-tab preference is a value only this process writes. The shell was asking
 * again for answers it was already holding.
 *
 * WHAT THIS FILE PINS — each test forces the "already answered" case and then
 * makes the corresponding request never come back, so a shell that still waits
 * on the wire cannot pass:
 *
 *   A. the destination's settings request HANGS, and the switch renders anyway;
 *   B. the destination's tabs request HANGS, and the real tab set is on screen
 *      from the first frame — never the loading default;
 *   C. the last-tab read HANGS, and the tap still navigates in the same tick.
 *
 * All three fail on the code that shipped the repaint storm.
 *
 * NOT covered here, deliberately: the chat surface's own hydration (4)–(6),
 * which lives in `mobile-project-switch-spinner.test.tsx`.
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

const { mountScreen, FakeChatSocket } = await import('./support/mount');
const { installRouting, resetRouting, routerCalls } = await import('./support/stubs/expo-router');
const { LastTabStore, __setLastTabStorageForTests, __resetLastTabStorageForTests } = await import(
  '../lib/last-tab-storage'
);
const { setRuntimeServerConfig, __resetServerConfigForTests } = await import('../lib/config');
const { __resetProjectSettingsCacheForTests } = await import('../lib/project-settings-cache');
const { AuthSessionProvider } = await import('../lib/session');
const { clearSessionCache } = await import('../lib/chat-core/session-cache');
const { __resetSharedMobileStoreForTests } = await import('../lib/chat-core/op-sqlite-store');

const ProjectLayout = (await import('../app/projects/[id]/_layout')).default;

const OWNER = {
  id: 'harness-owner',
  email: 'owner@example.test',
  displayName: 'Harness Owner',
  provider: 'dev' as const,
  token: 'harness-token',
};
const BASE_URL = 'https://harness.example.test';
const PROJECTS = ['willow', 'harbor', 'lantern'] as const;

/** Long enough to cover the shell's deliberate prefetch delay (600 ms). */
const AFTER_PREFETCH_MS = 900;

function TabScreen() {
  return createElement('div', { 'data-testid': 'routed-tab-screen' });
}

function settingsDoc(id: string) {
  return {
    id,
    name: `Project ${id}`,
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

/** A registry answer that is distinguishable from the pre-fetch default. */
function tabDescriptors() {
  return [
    { key: 'chat', label: 'Chat', scope: 'project', source: 'builtin', order: 10, mount: { kind: 'builtin', target: 'chat' } },
    { key: 'documents', label: 'Documents', scope: 'project', source: 'builtin', order: 20, mount: { kind: 'builtin', target: 'docs' } },
  ];
}

interface GatewayOptions {
  /** Scopes whose SETTINGS request never answers. */
  hangSettings?: readonly string[];
  /** Scopes whose TABS request never answers after the first successful one. */
  hangTabsAfterFirst?: readonly string[];
}

let restoreCrypto: (() => void) | null = null;
let realFetch: typeof fetch;
const tabsServed = new Set<string>();

function installGateway(opts: GatewayOptions = {}): void {
  tabsServed.clear();
  (globalThis as { fetch: typeof fetch }).fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(BASE_URL, '').split('?')[0] ?? '';
    if (path === '/api/app/projects') {
      return Response.json({ ok: true, projects: PROJECTS.map(listRow), project_slug: 'local' });
    }
    const settings = /^\/api\/app\/projects\/([^/]+)\/settings$/.exec(path);
    if (settings !== null) {
      const id = decodeURIComponent(settings[1] ?? '');
      if (opts.hangSettings?.includes(id) === true) return new Promise<Response>(() => {});
      return Response.json({ ok: true, project: settingsDoc(id), project_id: id });
    }
    const tabs = /^\/api\/app\/projects\/([^/]+)\/tabs$/.exec(path);
    if (tabs !== null) {
      const id = decodeURIComponent(tabs[1] ?? '');
      if (opts.hangTabsAfterFirst?.includes(id) === true && tabsServed.has(id)) {
        return new Promise<Response>(() => {});
      }
      tabsServed.add(id);
      return Response.json({ ok: true, tabs: tabDescriptors() });
    }
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
  __resetProjectSettingsCacheForTests();
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
    routes: { chat: TabScreen as never, docs: TabScreen as never },
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

describe('the destination is painted from what the rail already fetched', () => {
  it('shows no loading pane, even though the new scope’s settings request never answers', async () => {
    // The list call has already returned harbor's complete settings doc — the
    // same row, from the same table, that the per-project GET would serve
    // (`gateway/http/app-projects-surface.ts` ProjectListEntry extends
    // ProjectSettings). So a shell that covers the content pane while it asks
    // again is waiting on an answer it is holding, and here that second request
    // is never coming back at all.
    installGateway({ hangSettings: ['harbor'] });
    const screen = await mountShell('/projects/willow/chat');
    await waitReal(60, screen);

    await screen.press('Open Project harbor');
    await waitReal(60, screen);

    expect(screen.byTestId('project-content-loading')).toBeNull();
    expect(screen.byTestId('project-not-found-back')).toBeNull();
    expect(screen.byTestId('routed-tab-screen')).not.toBeNull();
    // …and the chrome names the project that was tapped, not a placeholder.
    expect(screen.text()).toContain('Project harbor');
    screen.unmount();
  });

  it('never shows a project it has NOT been told about as though it had', async () => {
    // The other half of the same rule. With nothing cached and the fetch hung,
    // the honest answer is the loading pane — the cache may only remove a wait,
    // never invent a scope. (Its companion, that the pane is drawn OVER a
    // mounted `<Slot/>`, is pinned in
    // `rail-tap-lands-on-the-tapped-project.test.tsx`.)
    installGateway({ hangSettings: ['harbor'] });
    const screen = await mountShell('/projects/willow/chat');
    await waitReal(60, screen);
    __resetProjectSettingsCacheForTests();

    await screen.press('Open Project harbor');
    await waitReal(60, screen);

    expect(screen.byTestId('project-content-loading')).not.toBeNull();
    screen.unmount();
  });
});

describe('the tab bar does not flash the pre-fetch default', () => {
  it('renders the destination’s real tabs from the first frame, with its tabs request hung', async () => {
    // `Apps` + `Reminders` are in the hardcoded pre-fetch default and NOT in
    // this gateway's registry answer, so their presence is exactly the flash.
    installGateway({ hangTabsAfterFirst: ['harbor'] });
    const screen = await mountShell('/projects/willow/chat');
    await waitReal(AFTER_PREFETCH_MS, screen);

    await screen.press('Open Project harbor');
    await waitReal(60, screen);

    expect(screen.byTestId('tab-documents')).not.toBeNull();
    expect(screen.byTestId('tab-launcher')).toBeNull();
    expect(screen.byTestId('tab-reminders')).toBeNull();
    screen.unmount();
  });
});

describe('the tap navigates in the same tick', () => {
  it('routes to this device’s last tab without awaiting a read that never answers', async () => {
    // The preference is primed when the rail list lands. After that a read is
    // pure latency in front of the navigation, so this backing stops answering
    // once every project has been primed: a shell that still awaits one cannot
    // navigate at all.
    const stored = new Map<string, string>([['neutron.project.harbor.lastTab', 'docs']]);
    let sealed = false;
    __setLastTabStorageForTests(
      new LastTabStore({
        getItem: (k: string) =>
          sealed
            ? new Promise<string | null>(() => {})
            : Promise.resolve(stored.get(k) ?? null),
        setItem: (k: string, v: string) => {
          stored.set(k, v);
        },
        removeItem: (k: string) => {
          stored.delete(k);
        },
      }),
    );

    const screen = await mountShell('/projects/willow/chat');
    await waitReal(AFTER_PREFETCH_MS, screen);
    // Everything the shell was going to read, it has read. From here the store
    // answers nothing at all, so the only way to land on `docs` is to already
    // know — which is the whole point: a read on the tap path is latency in
    // front of a value this process wrote itself.
    sealed = true;
    routerCalls.length = 0;

    await screen.press('Open Project harbor');

    expect(routerCalls.map((c) => c.href)).toEqual(['/projects/harbor/docs']);
    screen.unmount();
  });
});
