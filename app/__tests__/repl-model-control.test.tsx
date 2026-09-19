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

beforeAll(installNativeHarness);
afterAll(resetHarnessGlobals);
beforeEach(() => {
  document.body.innerHTML = '';
  calls = [];
  postStatus = 200;
  postBody = states.frontier;
  getBody = states.cheap;
  globalThis.fetch = (async (input, init) => {
    const method = init?.method ?? 'GET';
    calls.push({ url: String(input), method,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      token: new Headers(init?.headers).get('authorization') });
    return new Response(JSON.stringify(method === 'POST' ? postBody : getBody), {
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
    postBody = { error: 'session_changed', detail: 'Conversation changed. Refresh.' };
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

  it('surfaces unsupported state without an inert model picker', async () => {
    getBody = { ...states.cheap, status: 'unsupported', detail: 'No active REPL' };
    const screen = await mount('');
    expect(calls[0]?.url).toEndWith('/api/app/projects/~general/repl-model');
    expect(document.querySelector('[data-testid="repl-model-status"]')?.textContent).toContain('No active REPL');
    await press('repl-model-open');
    expect(document.querySelector('[data-testid="repl-model-list"]')).toBeNull();
    screen.unmount();
  });
});
