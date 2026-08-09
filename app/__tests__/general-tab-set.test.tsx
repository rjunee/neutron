/**
 * @neutronai/app — GENERAL RENDERS CHAT · WORK · DOCS (owner-reported, 2026-08-09).
 *
 * WHAT THE OWNER SAW, one screenshot of the General scope on the APK: a tab bar
 * reading Chat / Apps / Tasks / Reminders / Docs / Settings — no Work tab, Docs in
 * fifth place — and, inside Docs, the raw validator string `invalid_project_id:
 * project_id must be 1-128 chars from [A-Za-z0-9_.-]` where the file tree should
 * be. He read it as two bugs, an ordering one and a broken pane. It was one.
 *
 * The mobile rail spells General `'~general'`, which is deliberately OUTSIDE the
 * gateway's project-id alphabet so the sentinel can never collide with a real
 * project. Both the tabs client and the docs client sent it RAW, so both requests
 * 400'd — and the layout swallows a failed tabs fetch by design ("whatever this
 * scope already had stands"), which left General pinned to the PRE-FETCH loading
 * default forever. That default is precisely the legacy set in the screenshot.
 * Nothing was mis-ordering anything; the real set had never arrived.
 *
 * WHY THE STUB BELOW REPLICATES THE SERVER'S VALIDATOR RATHER THAN ANSWERING
 * EVERYTHING. A stub that serves `/projects/~general/tabs` happily would let the
 * exact shipped defect pass this test — the request would be wrong and the tab bar
 * right. So `installGateway` rejects any project id the real `sanitizeProjectId`
 * would reject, with the same code and message. Revert the client mapping and this
 * file reproduces the device screenshot instead of going green.
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
const { installRouting, resetRouting } = await import('./support/stubs/expo-router');
const { __resetLastTabStorageForTests } = await import('../lib/last-tab-storage');
const { setRuntimeServerConfig, __resetServerConfigForTests } = await import('../lib/config');
const { __resetProjectSettingsCacheForTests } = await import('../lib/project-settings-cache');
const { AuthSessionProvider } = await import('../lib/session');
const { clearSessionCache } = await import('../lib/chat-core/session-cache');
const { __resetSharedMobileStoreForTests } = await import('../lib/chat-core/op-sqlite-store');
const { GENERAL_PROJECT_ID } = await import('../lib/project-rail-view');

const ProjectLayout = (await import('../app/projects/[id]/_layout')).default;

const OWNER = {
  id: 'harness-owner',
  email: 'owner@example.test',
  displayName: 'Harness Owner',
  provider: 'dev' as const,
  token: 'harness-token',
};
const BASE_URL = 'https://harness.example.test';

/** The gateway's own project-id alphabet (`sanitizeProjectId`). */
const LEGAL_PROJECT_ID = /^[A-Za-z0-9_.-]{1,128}$/;

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

/**
 * The engine's real per-project builtin set, in registry order — Chat (0),
 * Work (5), Documents (10), Apps (12), Settings (15). `resolveProjectTabs` is a
 * pure resolver over builtins ∪ Core contributions and never consults a project
 * row, so the live surface answers this for `general` exactly as it does for a
 * named project. Apps + Settings are here ON PURPOSE: they are what General must
 * be narrowed OUT of.
 */
function registryTabs() {
  const t = (key: string, label: string, order: number, target: string) => ({
    key,
    label,
    scope: 'project',
    source: 'builtin',
    order,
    mount: { kind: 'builtin', target },
  });
  return [
    t('chat', 'Chat', 0, 'chat'),
    t('work_board', 'Work', 5, 'workboard'),
    t('documents', 'Documents', 10, 'docs'),
    t('launcher', 'Apps', 12, 'launcher'),
    t('settings', 'Settings', 15, 'settings'),
  ];
}

/** Every project-scoped path the gateway would 400 on an illegal id. */
const PROJECT_SCOPED = /^\/api\/app\/projects\/([^/]+)\/(.+)$/;

const rejected: string[] = [];

function installGateway(): void {
  rejected.length = 0;
  (globalThis as { fetch: typeof fetch }).fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(BASE_URL, '').split('?')[0] ?? '';
    if (path === '/api/app/projects') {
      return Response.json({ ok: true, projects: [listRow('willow')], project_slug: 'local' });
    }
    const scoped = PROJECT_SCOPED.exec(path);
    if (scoped !== null) {
      const id = decodeURIComponent(scoped[1] ?? '');
      // THE VALIDATOR, replicated. Without this the shipped bug passes.
      if (!LEGAL_PROJECT_ID.test(id)) {
        rejected.push(path);
        return Response.json(
          {
            ok: false,
            code: 'invalid_project_id',
            message: 'project_id must be 1-128 chars from [A-Za-z0-9_.-]',
          },
          { status: 400 },
        );
      }
      const action = scoped[2] ?? '';
      if (action === 'tabs') return Response.json({ ok: true, tabs: registryTabs() });
      if (action === 'settings') {
        return Response.json({ ok: true, project: settingsDoc(id), project_id: id });
      }
      if (action === 'docs/tree') {
        return Response.json({ ok: true, tree: [], file_count: 0 });
      }
      return Response.json({ ok: true });
    }
    return Response.json({ ok: false, code: 'not_found', message: path }, { status: 404 });
  }) as typeof fetch;
}

let restoreCrypto: (() => void) | null = null;
let realFetch: typeof fetch;

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
    routes: {
      chat: TabScreen as never,
      docs: TabScreen as never,
      workboard: TabScreen as never,
    },
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

/** The rendered tab keys, IN DOM ORDER — what the owner reads left to right. */
function tabKeys(host: HTMLElement): string[] {
  return Array.from(host.querySelectorAll('[data-testid^="tab-"]')).map((el) =>
    (el.getAttribute('data-testid') ?? '').slice('tab-'.length),
  );
}

describe('General', () => {
  it('renders Chat · Work · Docs, in that order, with Docs THIRD', async () => {
    const screen = await mountShell(`/projects/${GENERAL_PROJECT_ID}/chat`);
    await waitReal(60, screen);

    // The owner's ask, stated as the assertion: "docs always the third tab even
    // in general so it goes chat, work, docs".
    expect(tabKeys(screen.host)).toEqual(['chat', 'work_board', 'documents']);
    screen.unmount();
  });

  it('does NOT render the project-only tabs, which have no row behind them here', async () => {
    const screen = await mountShell(`/projects/${GENERAL_PROJECT_ID}/chat`);
    await waitReal(60, screen);

    // Settings reads a project row General does not have; Apps lists a project's
    // installed Cores. Both were in the legacy default the owner photographed.
    expect(screen.byTestId('tab-settings')).toBeNull();
    expect(screen.byTestId('tab-launcher')).toBeNull();
    // And the two legacy tabs the registry no longer emits at all.
    expect(screen.byTestId('tab-tasks')).toBeNull();
    expect(screen.byTestId('tab-reminders')).toBeNull();
    screen.unmount();
  });

  it('never sends the rail sentinel to a project-scoped surface', async () => {
    const screen = await mountShell(`/projects/${GENERAL_PROJECT_ID}/chat`);
    await waitReal(60, screen);

    // The stub records every request the real gateway would have 400'd. This is
    // the assertion that fails on the code that shipped: the tab bar could
    // conceivably be fixed by hardcoding a General set while the requests stayed
    // wrong, and that would leave the Docs pane exactly as broken as the owner
    // found it.
    expect(rejected).toEqual([]);
    screen.unmount();
  });
});

describe('a named project is untouched', () => {
  it('still renders the full registry set, Apps and Settings included', async () => {
    // The narrowing is gated on the General sentinel. Applying it everywhere
    // would silently delete Settings — the only route to a project's credentials
    // UI — from every project, which is a worse bug than the one being fixed.
    const screen = await mountShell('/projects/willow/chat');
    await waitReal(60, screen);

    expect(tabKeys(screen.host)).toEqual([
      'chat',
      'work_board',
      'documents',
      'launcher',
      'settings',
    ]);
    // Docs is third there too, which is what makes "always third" true.
    expect(tabKeys(screen.host)[2]).toBe('documents');
    screen.unmount();
  });
});
