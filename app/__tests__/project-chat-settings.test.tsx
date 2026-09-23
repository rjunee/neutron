import { afterAll, expect, test } from 'bun:test';
import { act, createElement } from 'react';
import { installNativeHarness, resetHarnessGlobals, setHarnessPlatform } from './support/native-harness';
installNativeHarness(); setHarnessPlatform('ios');
const { mountScreen } = await import('./support/mount');
const { AuthSessionProvider } = await import('../lib/session');
const { installRouting, resetRouting } = await import('./support/stubs/expo-router');
const { default: SettingsTab } = await import('../app/projects/[id]/settings');
afterAll(() => { resetRouting(); resetHarnessGlobals(); });

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
