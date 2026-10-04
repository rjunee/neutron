import { afterAll, expect, test } from 'bun:test';
import { act, createElement } from 'react';
import { installNativeHarness, resetHarnessGlobals, setHarnessPlatform } from './support/native-harness';
installNativeHarness(); setHarnessPlatform('ios');
const { mountScreen } = await import('./support/mount');
const { AuthSessionProvider } = await import('../lib/session');
const { installRouting, resetRouting } = await import('./support/stubs/expo-router');
const { default: SettingsTab } = await import('../app/projects/[id]/settings');
afterAll(() => { resetRouting(); resetHarnessGlobals(); });

test('phone existing account selection grants only after Connect and removes only the project connection', async () => {
  const { ProjectChatSettings } = await import('../components/ProjectChatSettings');
  const account = { source_row_id: 'fixture-row', account_identity: 'fixture-identity', account: 'seat-1', label: 'Configured fixture' };
  const writes: { path: string; method: string; body: unknown }[] = [];
  let connected = false;
  let refused = true;
  let finishBeta!: (response: Response) => void;
  const beta = new Promise<Response>(resolve => { finishBeta = resolve; });
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    const path = new URL(url).pathname;
    const method = init?.method ?? 'GET';
    if (path.endsWith('/settings')) return Response.json({ project: { model_provider: null }, model_provider_resolution: { provider: 'anthropic', source: 'instance' } });
    if (method !== 'GET') {
      writes.push({ path, method, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (init?.body && JSON.parse(String(init.body)).auth) return Response.json({ code: 'existing_account_requires_grant', message: 'Select the existing configured account' }, { status: 400 });
      if (refused) return Response.json({ code: 'project_account_unavailable', message: 'Select the configured account again' }, { status: 409 });
      connected = method === 'POST';
    }
    if (path.includes('/beta/')) return beta;
    return Response.json({ available_accounts: [account], override_present: connected,
      owner_credential: { configured: connected, checked_at: '2026-10-04T00:00:00Z', detail: connected ? 'Project grant connected' : 'Project grant required' } });
  };
  const props = { projectId: 'alpha', baseUrl: 'https://example.test', token: 'fixture', fetchImpl };
  const screen = await mountScreen(createElement(ProjectChatSettings, props));
  try {
    expect(writes).toEqual([]);
    const connect = () => screen.host.querySelector('[aria-label="Connect selected account to project"]') as HTMLButtonElement;
    expect(connect().disabled).toBe(true);
    await act(async () => {
      const input = screen.host.querySelector('[aria-label="Project Codex auth.json"]') as HTMLTextAreaElement;
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'synthetic-auth');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await screen.press('Connect project Codex');
    expect(screen.text()).toContain('existing_account_requires_grant');
    expect(screen.text()).toContain('Select the existing configured account');
    expect(screen.text()).toContain('Configured fixture');
    await screen.press('Select Codex account Configured fixture');
    expect(writes).toHaveLength(1);
    await screen.press('Connect selected account to project');
    expect(screen.text()).toContain('Select the configured account again');
    expect(screen.text()).not.toContain('Project grant connected');
    refused = false;
    await screen.press('Select Codex account Configured fixture');
    await screen.press('Connect selected account to project');
    expect(writes.at(-1)).toEqual({ path: '/api/app/projects/alpha/codex-auth', method: 'POST', body: { source_row_id: account.source_row_id, account_identity: account.account_identity } });
    expect(screen.text()).toContain('Project grant connected');
    await screen.press('Remove project Codex connection');
    expect(writes.at(-1)).toEqual({ path: '/api/app/projects/alpha/codex-auth', method: 'DELETE', body: null });
    expect(screen.text()).toContain('Configured fixture');
    await screen.rerender(createElement(ProjectChatSettings, { ...props, projectId: 'beta' }));
    expect(screen.text()).not.toContain('Configured fixture');
    expect(screen.text()).not.toContain('Project grant required');
    expect(connect().disabled).toBe(true);
    await act(async () => { finishBeta(Response.json({ message: 'Beta unavailable' }, { status: 503 })); });
    await screen.settle();
    expect(screen.text()).toContain('Beta unavailable');
    expect(screen.text()).not.toContain('Configured fixture');
  } finally { screen.unmount(); }
});

test('phone project settings select either provider and connect only the current project credential', async () => {
  const original = globalThis.fetch;
  const providers: Record<string, string | null> = { alpha: null, beta: 'anthropic' };
  const connections = new Set<string>();
  const writes: { path: string; method: string; body: unknown }[] = [];
  let reject = false;
  let holdPatch = false;
  let releasePatch: (() => void) | undefined;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input).replace(/^https?:\/\/[^/]+/, '');
    const project = path.split('/')[4]!;
    const method = init?.method ?? 'GET';
    if (method !== 'GET') {
      const body = JSON.parse(String(init?.body)); writes.push({ path, method, body });
      if (reject) return Response.json({ code: 'refused', message: 'Save refused' }, { status: 409 });
      if (method === 'PATCH') providers[project] = body.model_provider;
      if (method === 'POST' && path.endsWith('/codex-auth')) connections.add(project);
    }
    if (path.endsWith('/settings')) {
      const response = Response.json({ project: { name: project, emoji: '', members: [], model_provider: providers[project] },
        model_provider_resolution: { provider: providers[project] ?? 'anthropic', source: providers[project] ? 'project' : 'instance' } });
      if (method === 'PATCH' && holdPatch) await new Promise<void>(resolve => { releasePatch = resolve; });
      return response;
    }
    if (path.endsWith('/codex-auth')) return Response.json({ owner_credential: { configured: connections.has(project), checked_at: '2026-09-23T00:00:00Z',
      detail: connections.has(project) ? 'Project credential configured' : 'Connect a Codex subscription to this project' } });
    return Response.json({ project: [], global: [], services: [] });
  }) as typeof fetch;
  installRouting({ path: '/projects/alpha/settings', routes: {} });
  const screen = await mountScreen(createElement(AuthSessionProvider, { initialUser: {
    id: 'owner', email: 'owner@example.test', displayName: 'Owner', provider: 'dev', token: 'fixture',
  } }, createElement(SettingsTab)));
  try {
    expect(screen.byTestId('project-chat-settings')).not.toBeNull();
    expect(screen.text()).toContain('Connect a Codex subscription to this project');
    await screen.press('Codex');
    expect(providers).toEqual({ alpha: 'openai-codex', beta: 'anthropic' });
    expect(screen.text()).toContain('Effective: Codex · project setting');
    reject = true;
    await screen.press('Claude Code');
    expect(screen.text()).toContain('Save refused');
    expect(screen.text()).toContain('Effective: Codex · project setting');
    reject = false;
    await screen.press('Follow instance');
    expect(providers.alpha).toBeNull();
    const input = screen.host.querySelector('[aria-label="Project Codex auth.json"]') as HTMLTextAreaElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'synthetic-auth');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await screen.press('Connect project Codex');
    expect(writes.at(-1)).toEqual({ path: '/api/app/projects/alpha/codex-auth', method: 'POST', body: { auth: 'synthetic-auth' } });
    expect(screen.text()).toContain('Project credential configured');
    expect(input.value).toBe('');
    holdPatch = true;
    await screen.press('Codex');
    await act(async () => { installRouting({ path: '/projects/beta/settings', routes: {} }); });
    await screen.settle();
    await act(async () => { releasePatch?.(); });
    await screen.settle();
    expect(screen.text()).toContain('Connect a Codex subscription to this project');
    expect(screen.text()).toContain('Effective: Claude Code · project setting');
    holdPatch = false;
    await screen.press('Codex');
    expect(providers).toEqual({ alpha: 'openai-codex', beta: 'openai-codex' });
    expect(connections).toEqual(new Set(['alpha']));
  } finally { screen.unmount(); resetRouting(); globalThis.fetch = original; }
});
