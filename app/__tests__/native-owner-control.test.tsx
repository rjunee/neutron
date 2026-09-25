import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { act, createElement } from 'react';
import { installNativeHarness, resetHarnessGlobals, setHarnessPlatform } from './support/native-harness';
import type { NativeOwnerControlState } from '../lib/native-owner-control-client';

installNativeHarness();
const { mountScreen } = await import('./support/mount');
const { NativeOwnerControl } = await import('../components/NativeOwnerControl');
const { ReplModelControl } = await import('../components/ReplModelControl');
const identity = { projectId: 'willow', threadId: 'native-thread', bindingRevision: 'binding', generation: 2, epoch: 4, turnId: 'turn-one' };
const initial = (): NativeOwnerControlState => ({ ...identity, status: 'turn', pending: [{
  requestId: 17, method: 'item/commandExecution/requestApproval', params: {
    threadId: identity.threadId, turnId: identity.turnId, reason: 'Run the tests?', command: 'bun test', availableDecisions: ['accept', 'decline', 'acceptForSession'],
  },
}] });
let state: NativeOwnerControlState;
let posts: Record<string, unknown>[];
let postStatus: number;
let deferPost: boolean;
let completePost: (() => void) | undefined;
let getPayload: unknown;
let controlPaths: string[];
beforeAll(installNativeHarness);
afterAll(resetHarnessGlobals);
beforeEach(() => {
  document.body.innerHTML = '';
  state = initial(); posts = []; postStatus = 200; deferPost = false; completePost = undefined; getPayload = undefined;
  controlPaths = [];
  globalThis.fetch = (async (input, init) => {
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer owner-token');
    if (String(input).endsWith('/repl-model')) return Response.json({ harness: 'codex', sessionId: 'session', currentModel: 'small',
      availableModels: [{ id: 'small', label: 'Small' }], status: 'busy' });
    expect(String(input)).toMatch(/\/api\/app\/projects\/[^/]+\/repl-control$/);
    controlPaths.push(new URL(String(input)).pathname);
    if (init?.method !== 'POST') return Response.json(getPayload ?? state);
    const body = JSON.parse(String(init.body));
    posts.push(body);
    if (deferPost) await new Promise<void>(resolve => { completePost = resolve; });
    if (postStatus !== 200) return Response.json({ message: 'Native turn changed. Refresh the controls.' }, { status: postStatus });
    state = { ...state, pending: [], ...(body.action === 'interrupt' ? { turnId: null, status: 'idle' } : {}) };
    return Response.json(state);
  }) as typeof fetch;
});
const props = { projectId: 'willow', baseUrl: 'https://example.test', token: 'owner-token' };
async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); }
async function press(id: string) {
  const element = document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
  expect(element).not.toBeNull();
  await act(async () => { element!.click(); await new Promise(resolve => setTimeout(resolve, 0)); });
}
async function mount() { const screen = await mountScreen(createElement(NativeOwnerControl, props)); await settle(); return screen; }

describe.each(['ios', 'web'] as const)('native owner controls on %s', platform => {
  beforeEach(() => setHarnessPlatform(platform));

  it.each([
    ['~general', null], ['', null], ['general', 'general'], ['willow', 'willow'],
  ] as const)('preserves native scope for %s through approval and interruption', async (routeId, nativeId) => {
    state = { ...state, projectId: nativeId };
    const screen = await mountScreen(createElement(ReplModelControl, { ...props, projectId: routeId })); await settle();
    expect(document.body.textContent).toContain('Run the tests?');
    await press('native-owner-accept');
    await press('native-owner-interrupt');
    expect(posts).toEqual([
      { ...identity, projectId: nativeId, action: 'reply', requestId: 17, result: { decision: 'accept' } },
      { ...identity, projectId: nativeId, action: 'interrupt' },
    ]);
    expect(controlPaths.length).toBeGreaterThanOrEqual(3);
    expect(new Set(controlPaths)).toEqual(new Set([
      `/api/app/projects/${nativeId === null ? '~general' : nativeId}/repl-control`,
    ]));
    expect(document.querySelector('[data-testid="native-owner-error"]')).toBeNull();
    expect(document.querySelector('[data-testid="native-owner-interrupt"]')).toBeNull();
    screen.unmount();
  });

  it.each([
    ['~general', 'general'], ['~general', 'willow'], ['general', null], ['willow', null],
  ] as const)('refuses foreign native scope %s / %s from the model selector', async (routeId, nativeId) => {
    getPayload = { ...state, projectId: nativeId };
    const screen = await mountScreen(createElement(ReplModelControl, { ...props, projectId: routeId })); await settle();
    expect(document.querySelector('[data-testid="native-owner-error"]')?.textContent).toContain('invalid Codex control state');
    expect(document.querySelector('[data-testid="native-owner-accept"]')).toBeNull();
    expect(document.querySelector('[data-testid="native-owner-interrupt"]')).toBeNull();
    expect(posts).toHaveLength(0);
    screen.unmount();
  });

  it('reaches approvals from the existing model selector and sends only one-time exact identity approval', async () => {
    const screen = await mountScreen(createElement(ReplModelControl, props)); await settle();
    expect(document.body.textContent).toContain('Run the tests?');
    expect(document.body.textContent).toContain('bun test');
    expect(document.body.textContent).not.toContain('acceptForSession');
    expect(document.querySelector('[data-testid="native-owner-cancel"]')).toBeNull();
    await press('native-owner-accept');
    expect(posts).toEqual([{ ...identity, action: 'reply', requestId: 17, result: { decision: 'accept' } }]);
    expect(document.querySelector('[data-testid="native-owner-question"]')).toBeNull();
    screen.unmount();
  });

  it('interrupts the observed turn once and clears its affordance after acknowledgement', async () => {
    const screen = await mount();
    await press('native-owner-interrupt');
    expect(posts).toEqual([{ ...identity, action: 'interrupt' }]);
    expect(document.querySelector('[data-testid="native-owner-interrupt"]')).toBeNull();
    screen.unmount();
  });

  it.each(['native-owner-accept', 'native-owner-interrupt'])('does not retry a stale %s on the replacement turn', async control => {
    const screen = await mount();
    postStatus = 409;
    state = { ...state, epoch: 9, turnId: 'successor', pending: [] };
    await press(control); await settle();
    expect(posts).toHaveLength(1);
    expect(posts[0]?.turnId).toBe('turn-one');
    expect(document.querySelector('[data-testid="native-owner-error"]')?.textContent).toContain('turn changed');
    expect(document.querySelector('[data-testid="native-owner-question"]')).toBeNull();
    screen.unmount();
  });

  it('prevents concurrent approval and interruption while delivery is unresolved', async () => {
    const screen = await mount(); deferPost = true;
    await press('native-owner-accept');
    await press('native-owner-interrupt');
    await press('native-owner-accept');
    expect(posts).toHaveLength(1);
    await act(async () => { completePost!(); }); await settle();
    screen.unmount();
  });

  it('ignores an old project action completing after navigation', async () => {
    const screen = await mount(); deferPost = true;
    await press('native-owner-accept');
    state = { ...state, projectId: 'maple', threadId: 'maple-thread', turnId: null, pending: [] };
    await screen.rerender(createElement(NativeOwnerControl, { ...props, projectId: 'maple' })); await settle();
    await act(async () => { completePost!(); }); await settle();
    expect(posts).toHaveLength(1);
    expect(document.querySelector('[data-testid="native-owner-error"]')).toBeNull();
    expect(document.querySelector('[data-testid="native-owner-question"]')).toBeNull();
    screen.unmount();
  });

  it.each(['project', 'thread', 'turn'])('rejects foreign %s response identity before exposing an action', async field => {
    if (field === 'project') getPayload = { ...state, projectId: 'foreign' };
    else state.pending[0]!.params[`${field}Id`] = 'foreign';
    const screen = await mount();
    expect(document.querySelector('[data-testid="native-owner-error"]')?.textContent).toContain('invalid Codex control state');
    expect(document.querySelector('[data-testid="native-owner-accept"]')).toBeNull();
    expect(document.querySelector('[data-testid="native-owner-interrupt"]')).toBeNull();
    expect(posts).toHaveLength(0);
    screen.unmount();
  });

  it('renders native user input and returns only the requested answer IDs', async () => {
    state.pending = [{ requestId: 'question', method: 'item/tool/requestUserInput', params: {
      threadId: identity.threadId, turnId: identity.turnId,
      questions: [{ id: 'choice', question: 'Which suite?', options: [{ label: 'Unit', description: 'Run unit tests' }] }],
    } }];
    const screen = await mount();
    const option = Array.from(document.querySelectorAll('[role="button"]')).find(element => element.textContent?.includes('Run unit tests')) as HTMLElement;
    await act(async () => { option.click(); });
    await press('native-owner-submit');
    expect(posts).toEqual([{ ...identity, action: 'reply', requestId: 'question', result: { answers: { choice: { answers: ['Unit'] } } } }]);
    screen.unmount();
  });

  it('retains unsupported questions without inventing an approval', async () => {
    state.pending[0]!.method = 'item/unknown/requestApproval';
    const screen = await mount();
    expect(document.body.textContent).toContain('needs an answer in the Codex terminal');
    expect(document.querySelector('[data-testid="native-owner-accept"]')).toBeNull();
    expect(posts).toHaveLength(0);
    screen.unmount();
  });

  it('discovers a new native question while the owner stays in the conversation', async () => {
    const waiting = initial(); state = { ...state, turnId: null, status: 'idle', pending: [] };
    const screen = await mount();
    expect(document.querySelector('[data-testid="native-owner-question"]')).toBeNull();
    state = waiting;
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 2_100)); });
    expect(document.body.textContent).toContain('Run the tests?');
    await press('native-owner-decline');
    expect(posts).toEqual([{ ...identity, action: 'reply', requestId: 17, result: { decision: 'decline' } }]);
    screen.unmount();
  });
});
