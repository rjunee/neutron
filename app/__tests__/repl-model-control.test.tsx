import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { act, createElement } from 'react';

import { installNativeHarness, resetHarnessGlobals, setHarnessPlatform } from './support/native-harness';

installNativeHarness();
setHarnessPlatform('ios');

const { mountScreen } = await import('./support/mount');
const { ReplModelControl } = await import('../components/ReplModelControl');

const states = {
  cheap: { harness: 'codex', sessionId: 'session-one', currentModel: 'cheap',
    availableModels: [{ id: 'cheap', label: 'Cheap' }, { id: 'frontier', label: 'Frontier' }], status: 'ready' },
  frontier: { harness: 'codex', sessionId: 'session-one', currentModel: 'frontier',
    availableModels: [{ id: 'cheap', label: 'Cheap' }, { id: 'frontier', label: 'Frontier' }], status: 'ready' },
};

interface Call { url: string; method: string; body: unknown; token: string | null }
let calls: Call[] = [];
let postStatus = 200;
let postBody: unknown = states.frontier;
let getBody: unknown = states.cheap;
let deferPost = false;
let completePost: (() => void) | null = null;
let deferGetAt = 0;
let deferGetToken: string | null = null;
let getCount = 0;
let completeGet: (() => void) | null = null;

beforeAll(installNativeHarness);
afterAll(resetHarnessGlobals);
beforeEach(() => {
  document.body.innerHTML = '';
  calls = [];
  postStatus = 200;
  postBody = states.frontier;
  getBody = states.cheap;
  deferPost = false;
  completePost = null;
  deferGetAt = 0;
  deferGetToken = null;
  getCount = 0;
  completeGet = null;
  globalThis.fetch = (async (input, init) => {
    if (String(input).endsWith('/repl-control')) {
      return Response.json({ projectId: decodeURIComponent(String(input).split('/').at(-2)!), threadId: 'native-thread',
        bindingRevision: 'binding-one', generation: 1, epoch: 0, turnId: null, status: 'idle', pending: [] });
    }
    const method = init?.method ?? 'GET';
    const responseBody = method === 'POST' ? postBody : getBody;
    if (method === 'GET') getCount += 1;
    calls.push({ url: String(input), method,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      token: new Headers(init?.headers).get('authorization') });
    if (method === 'POST' && deferPost) {
      await new Promise<void>((resolve) => { completePost = resolve; });
    }
    if (method === 'GET' && (getCount === deferGetAt ||
      (deferGetToken !== null && new Headers(init?.headers).get('authorization') === deferGetToken))) {
      await new Promise<void>((resolve) => { completeGet = resolve; });
    }
    return new Response(JSON.stringify(responseBody), {
      status: method === 'POST' ? postStatus : 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
});

async function mount(projectId = 'willow') {
  const screen = await mountScreen(createElement(ReplModelControl,
    { projectId, baseUrl: 'https://example.test', token: 'test-token' }));
  await settle();
  return screen;
}

async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function press(id: string) {
  const element = document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
  if (element === null) throw new Error(`Missing rendered control ${id}`);
  await act(async () => { element.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
}

describe('conversation REPL model on phone', () => {
  it('discovers an owner started after the screen opened and mounts native controls', async () => {
    getBody = { ...states.cheap, sessionId: '', currentModel: null, availableModels: [], status: 'unsupported' };
    const screen = await mount();
    expect(document.querySelector('[data-testid="native-owner-control"]')).toBeNull();
    getBody = states.cheap;
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5_100)); });
    expect(document.querySelector('[data-testid="repl-model-open"]')?.textContent).toContain('cheap');
    expect(document.querySelector('[data-testid="native-owner-control"]')).not.toBeNull();
    screen.unmount();
  }, 10_000);

  it('does not let a background model read roll back an acknowledged switch', async () => {
    const screen = await mount();
    deferGetAt = 2;
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5_100)); });
    expect(completeGet).not.toBeNull();
    await press('repl-model-open');
    await press('repl-model-option-frontier');
    await act(async () => { completeGet!(); }); await settle();
    expect(document.querySelector('[data-testid="repl-model-open"]')?.textContent).toContain('frontier');
    screen.unmount();
  }, 10_000);

  it('accepts a new conditional revision on the same native conversation and uses it next time', async () => {
    getBody = { ...states.cheap, sessionId: 'revision-1', conversationId: 'native-thread-one' };
    postBody = { ...states.frontier, sessionId: 'revision-2', conversationId: 'native-thread-one' };
    const screen = await mount();
    await press('repl-model-open');
    await press('repl-model-option-frontier');
    expect(document.querySelector('[data-testid="repl-model-error"]')).toBeNull();
    expect(document.querySelector('[data-testid="repl-model-open"]')?.textContent).toContain('frontier');
    postBody = { ...states.cheap, sessionId: 'revision-3', conversationId: 'native-thread-one' };
    await press('repl-model-open');
    await press('repl-model-option-cheap');
    expect(calls.filter(call => call.method === 'POST').map(call => call.body)).toEqual([
      { model: 'frontier', sessionId: 'revision-1' }, { model: 'cheap', sessionId: 'revision-2' },
    ]);
    expect(document.querySelector('[data-testid="repl-model-error"]')).toBeNull();
    screen.unmount();
  });

  it('refuses a different native conversation even when the selected model is confirmed', async () => {
    getBody = { ...states.cheap, sessionId: 'revision-1', conversationId: 'native-thread-one' };
    postBody = { ...states.frontier, sessionId: 'revision-2', conversationId: 'native-thread-two' };
    const screen = await mount();
    await press('repl-model-open');
    await press('repl-model-option-frontier');
    expect(document.querySelector('[data-testid="repl-model-error"]')?.textContent).toContain('conversation changed');
    expect(document.querySelector('[data-testid="repl-model-open"]')?.textContent).toContain('cheap');
    screen.unmount();
  });

  it('renders authoritative current/list and switches in the same session', async () => {
    const screen = await mount();
    expect(calls[0]).toMatchObject({ url: 'https://example.test/api/app/projects/willow/repl-model',
      method: 'GET', token: 'Bearer test-token' });
    expect(document.querySelector('[data-testid="repl-model-open"]')?.textContent).toContain('cheap');
    await press('repl-model-open');
    expect(document.querySelector('[data-testid="repl-model-option-frontier"]')).not.toBeNull();
    await press('repl-model-option-frontier');
    expect(calls[1]).toMatchObject({ method: 'POST', body: { model: 'frontier', sessionId: 'session-one' } });
    expect(document.querySelector('[data-testid="repl-model-open"]')?.textContent).toContain('frontier');
    screen.unmount();
  });

  it('keeps the old model visible and shows server error after a rejected switch', async () => {
    postStatus = 409;
    postBody = { ok: false, code: 'session_changed', message: 'Conversation changed. Refresh.' };
    const screen = await mount();
    await press('repl-model-open');
    await press('repl-model-option-frontier');
    expect(document.querySelector('[data-testid="repl-model-open"]')?.textContent).toContain('cheap');
    expect(document.querySelector('[data-testid="repl-model-error"]')?.textContent).toContain('Conversation changed');
    screen.unmount();
  });

  it('does not claim a switch when an acknowledgement has a different session', async () => {
    postBody = { ...states.frontier, sessionId: 'another-session' };
    const screen = await mount();
    await press('repl-model-open');
    await press('repl-model-option-frontier');
    expect(document.querySelector('[data-testid="repl-model-open"]')?.textContent).toContain('cheap');
    expect(document.querySelector('[data-testid="repl-model-error"]')?.textContent).toContain('conversation changed');
    screen.unmount();
  });

  it('does not claim a switch when the REPL acknowledges a different model', async () => {
    postBody = { ...states.cheap };
    const screen = await mount();
    await press('repl-model-open');
    await press('repl-model-option-frontier');
    expect(document.querySelector('[data-testid="repl-model-open"]')?.textContent).toContain('cheap');
    expect(document.querySelector('[data-testid="repl-model-error"]')?.textContent).toContain('did not confirm');
    screen.unmount();
  });

  it('ignores session A switch completion after focus refreshes to session B', async () => {
    deferPost = true;
    const screen = await mount();
    await press('repl-model-open');
    await press('repl-model-option-frontier');
    expect(calls.at(-1)?.body).toEqual({ model: 'frontier', sessionId: 'session-one' });
    expect(completePost).not.toBeNull();

    // Changing the auth identity re-runs the focus effect in the device-shaped
    // router stub, matching blur/refocus's cleanup + authoritative GET sequence.
    getBody = { ...states.cheap, sessionId: 'session-two', currentModel: 'other' };
    await screen.rerender(createElement(ReplModelControl,
      { projectId: 'willow', baseUrl: 'https://example.test', token: 'second-token' }));
    expect(document.querySelector('[data-testid="repl-model-open"]')?.textContent).toContain('other');

    await act(async () => { completePost?.(); await Promise.resolve(); });
    await screen.settle();
    expect(document.querySelector('[data-testid="repl-model-open"]')?.textContent).toContain('other');
    expect(document.querySelector('[data-testid="repl-model-error"]')).toBeNull();
    screen.unmount();
  });

  it('ignores session A GET completion after focus refreshes to session B', async () => {
    deferGetAt = 1;
    const screen = await mount();
    expect(completeGet).not.toBeNull();
    getBody = { ...states.cheap, sessionId: 'session-two', currentModel: 'other' };
    await screen.rerender(createElement(ReplModelControl,
      { projectId: 'willow', baseUrl: 'https://example.test', token: 'second-token' }));
    expect(document.querySelector('[data-testid="repl-model-open"]')?.textContent).toContain('other');
    await act(async () => { completeGet?.(); await Promise.resolve(); });
    await screen.settle();
    expect(document.querySelector('[data-testid="repl-model-open"]')?.textContent).toContain('other');
    screen.unmount();
  });

  it('ignores session A recovery GET completion after focus refreshes to session B', async () => {
    postStatus = 409;
    postBody = { ok: false, code: 'session_changed', message: 'Session A changed.' };
    deferGetAt = 2;
    const screen = await mount();
    await press('repl-model-open');
    await press('repl-model-option-frontier');
    expect(completeGet).not.toBeNull();
    getBody = { ...states.cheap, sessionId: 'session-two', currentModel: 'other' };
    await screen.rerender(createElement(ReplModelControl,
      { projectId: 'willow', baseUrl: 'https://example.test', token: 'second-token' }));
    expect(document.querySelector('[data-testid="repl-model-open"]')?.textContent).toContain('other');
    await act(async () => { completeGet?.(); await Promise.resolve(); });
    await screen.settle();
    expect(document.querySelector('[data-testid="repl-model-open"]')?.textContent).toContain('other');
    expect(document.querySelector('[data-testid="repl-model-error"]')).toBeNull();
    screen.unmount();
  });

  it('uses a same-generation recovery GET after a rejected switch', async () => {
    postStatus = 409;
    postBody = { ok: false, code: 'session_changed', message: 'Session changed.' };
    const screen = await mount();
    getBody = { ...states.cheap, sessionId: 'session-two', currentModel: 'other' };
    await press('repl-model-open');
    await press('repl-model-option-frontier');
    expect(document.querySelector('[data-testid="repl-model-open"]')?.textContent).toContain('other');
    expect(document.querySelector('[data-testid="repl-model-error"]')?.textContent).toContain('Session changed');
    screen.unmount();
  });

  it('replaces a successful POST snapshot only when the next focus GET completes', async () => {
    const screen = await mount();
    await press('repl-model-open');
    await press('repl-model-option-frontier');
    expect(document.querySelector('[data-testid="repl-model-open"]')?.textContent).toContain('frontier');

    // A background read can consume the next GET ordinal before focus changes.
    await fetch('https://example.test/api/app/projects/willow/repl-model');
    deferGetToken = 'Bearer second-token';
    getBody = { ...states.cheap, sessionId: 'session-two', currentModel: 'other' };
    await screen.rerender(createElement(ReplModelControl,
      { projectId: 'willow', baseUrl: 'https://example.test', token: 'second-token' }));
    expect(calls.some(call => call.method === 'GET' && call.token === deferGetToken)).toBe(true);
    expect(completeGet).not.toBeNull();
    expect(document.querySelector('[data-testid="repl-model-open"]')?.textContent).toContain('unknown');
    await act(async () => { completeGet?.(); await Promise.resolve(); });
    await screen.settle();
    expect(document.querySelector('[data-testid="repl-model-open"]')?.textContent).toContain('other');
    screen.unmount();
  });

  it('renders the exact no-session unsupported DTO without offering a switch', async () => {
    getBody = { harness: 'codex', sessionId: '', currentModel: null,
      availableModels: [], status: 'unsupported', detail: 'No hosted Codex session' };
    const screen = await mount('');
    expect(calls[0]?.url).toEndWith('/api/app/projects/~general/repl-model');
    expect(document.querySelector('[data-testid="repl-model-status"]')?.textContent).toContain('No hosted Codex session');
    expect(document.querySelector('[data-testid="repl-model-error"]')).toBeNull();
    await press('repl-model-open');
    expect(document.querySelector('[data-testid="repl-model-list"]')).toBeNull();
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0);
    screen.unmount();
  });

  it('accepts unknown without a session as non-switchable', async () => {
    getBody = { harness: 'codex', sessionId: '', currentModel: null,
      availableModels: [], status: 'unknown', detail: 'Unable to identify the REPL' };
    const screen = await mount();
    expect(document.querySelector('[data-testid="repl-model-status"]')?.textContent).toContain('unknown');
    expect(document.querySelector('[data-testid="repl-model-error"]')).toBeNull();
    expect(document.querySelector('[data-testid="repl-model-list"]')).toBeNull();
    screen.unmount();
  });

  for (const status of ['ready', 'busy'] as const) {
    it(`rejects an empty session ID on ${status} rather than suggesting a switch`, async () => {
      getBody = { ...states.cheap, status, sessionId: '' };
      const screen = await mount();
      expect(document.querySelector('[data-testid="repl-model-error"]')?.textContent).toContain('invalid model state');
      expect(document.querySelector('[data-testid="repl-model-status"]')).toBeNull();
      await press('repl-model-open');
      expect(document.querySelector('[data-testid="repl-model-list"]')).toBeNull();
      expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0);
      screen.unmount();
    });
  }

  it('refuses a direct switch call with an empty session ID before the wire', async () => {
    const { ReplModelClient } = await import('../lib/repl-model-client');
    const client = new ReplModelClient('https://example.test', 'test-token');
    await expect(client.switch('willow', 'frontier', '')).rejects.toThrow('No active REPL session');
    expect(calls).toHaveLength(0);
  });
});
