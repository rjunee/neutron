/**
 * THE OWNER CAN INSTALL AND APPROVE AN MCP SERVER FROM HIS PHONE — by pressing things.
 *
 * WHY IT PRESSES. A source check confirms a component mentions a handler; it cannot
 * tell a rendered-and-wired control from a rendered-and-inert one, and this repo has
 * shipped that exact bug. Here it would be at its worst: an Approve button that
 * renders and does nothing looks precisely like a working security gate.
 *
 * THE BEHAVIOUR MOST WORTH PINNING is that INSTALLING IS NOT APPROVING. Adding a
 * server must POST the collection route and NOT the decision route, and the row must
 * stay pending until Approve is pressed. If those two collapsed into one press, the
 * gate would not exist — and every other test in this feature would still pass.
 *
 * REACHABILITY is asserted too (ISSUES #385): a registered route nothing pushes is a
 * screen the owner cannot get to, which this suite has been bitten by before. The nav
 * row in `settings.tsx` is part of the feature, not decoration.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, createElement } from 'react';

import {
  installNativeHarness,
  setHarnessPlatform,
  resetHarnessGlobals,
} from './support/native-harness';

installNativeHarness();
setHarnessPlatform('ios');

const { mountScreen } = await import('./support/mount');
const { AuthSessionProvider } = await import('../lib/session');

const APP_ROOT = join(__dirname, '..');
const OWNER = {
  id: 'harness-owner',
  email: 'owner@example.test',
  displayName: 'Harness Owner',
  provider: 'dev' as const,
  token: 'harness-token',
};

/** A value the screen must never render. */
const SECRET = 'sk-not-a-real-key';

const GRANT = [
  'Install the MCP server "example-server"?',
  '',
  '    /usr/local/bin/example-mcp --stdio',
  '',
  'It receives these environment variables (names shown, values never):',
  '',
  '    EXAMPLE_API_KEY',
].join('\n');

function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'example-server',
    command: '/usr/local/bin/example-mcp',
    args: ['--stdio'],
    env_names: ['EXAMPLE_API_KEY'],
    approval: 'pending',
    grant_prompt: GRANT,
    secrets_present: true,
    active: false,
    ...over,
  };
}

function payload(servers: Array<Record<string, unknown>>): Record<string, unknown> {
  return { ok: true, servers, reserved_names: ['neutron'], max_servers: 24 };
}

interface Sent {
  method: string;
  url: string;
  body: unknown;
}
let sent: Sent[] = [];
/** Answers GET; POST/DELETE fall through to `mutationReply`. */
let getPayload: Record<string, unknown> = payload([]);
let mutationReply: { status: number; body: unknown } | null = null;

function installFetch(): void {
  (globalThis as unknown as { fetch: unknown }).fetch = async (
    input: string | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const method = init?.method ?? 'GET';
    let body: unknown = null;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    sent.push({ method, url: String(input), body });
    const json = (v: unknown, status = 200): Response =>
      new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
    if (method === 'GET') return json(getPayload);
    if (mutationReply !== null) return json(mutationReply.body, mutationReply.status);
    return json(getPayload);
  };
}

let mounted: { unmount(): void } | null = null;

beforeAll(installNativeHarness);
afterAll(resetHarnessGlobals);
beforeEach(() => {
  if (mounted !== null) {
    mounted.unmount();
    mounted = null;
  }
  document.body.innerHTML = '';
  sent = [];
  getPayload = payload([]);
  mutationReply = null;
  installFetch();
});

async function mountScreenUnderTest(): Promise<void> {
  const mod = await import('../app/mcp-servers');
  const Screen = mod.default as () => unknown;
  const screen = await mountScreen(
    createElement(AuthSessionProvider, { initialUser: OWNER }, createElement(Screen as never)),
  );
  mounted = screen as unknown as { unmount(): void };
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

const byTestId = (id: string): HTMLElement | null =>
  document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

async function press(id: string): Promise<void> {
  const el = byTestId(id);
  if (el === null) throw new Error(`control '${id}' is not on screen`);
  await act(async () => {
    el.click();
    await new Promise((r) => setTimeout(r, 0));
  });
}

/** Set a controlled RN TextInput's text through the harness's change path. */
async function typeInto(id: string, value: string): Promise<void> {
  const el = byTestId(id) as HTMLInputElement | HTMLTextAreaElement | null;
  if (el === null) throw new Error(`input '${id}' is not on screen`);
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  // The prototype setter, not `.value =`: React's own value tracker would otherwise
  // see no change and never fire onChangeText, leaving the DOM updated and the
  // component's state empty — a test that then asserts on the wrong request body.
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter === undefined) throw new Error('no value setter on the element prototype');
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe('the screen is REACHABLE (ISSUES #385)', () => {
  it('Settings pushes /mcp-servers', () => {
    const settings = readFileSync(join(APP_ROOT, 'app', 'settings.tsx'), 'utf8');
    expect(settings).toContain("router.push('/mcp-servers')");
    expect(settings).toContain('settings-mcp-servers');
  });

  it('the route is REGISTERED in the stack', () => {
    // Pushed-but-unregistered and registered-but-unpushed are two different broken
    // states, so both halves are asserted.
    const layout = readFileSync(join(APP_ROOT, 'app', '_layout.tsx'), 'utf8');
    expect(layout).toContain('name="mcp-servers"');
  });
});

describe('installing is not approving', () => {
  it('loads on mount and says nothing is installed', async () => {
    await mountScreenUnderTest();
    expect(sent.some((s) => s.method === 'GET')).toBe(true);
    expect(byTestId('mcp-empty')).not.toBeNull();
  });

  it('Add POSTs the collection route and NEVER the decision route', async () => {
    await mountScreenUnderTest();
    await typeInto('mcp-form-name', 'example-server');
    await typeInto('mcp-form-command', '/usr/local/bin/example-mcp --stdio');
    await typeInto('mcp-form-env', `EXAMPLE_API_KEY=${SECRET}`);
    mutationReply = { status: 200, body: payload([row()]) };
    await press('mcp-form-save');

    const post = sent.find((s) => s.method === 'POST');
    expect(post).toBeDefined();
    expect(post!.url).toContain('/api/app/mcp-servers');
    expect(post!.url).not.toContain('/decision');
    // The one-line command was split for the server to validate and the prompt to
    // itemise.
    expect(post!.body).toEqual({
      name: 'example-server',
      command: '/usr/local/bin/example-mcp',
      args: ['--stdio'],
      env: { EXAMPLE_API_KEY: SECRET },
    });
    expect(sent.some((s) => s.url.includes('/decision'))).toBe(false);
    // And the row is PENDING, not running.
    expect(byTestId('mcp-example-server-status')!.textContent ?? '').toContain('approval');
    expect(byTestId('mcp-example-server-active')).toBeNull();
  });

  it('Approve posts the decision route with an explicit verb, and the row goes active', async () => {
    getPayload = payload([row()]);
    await mountScreenUnderTest();
    expect(byTestId('mcp-example-server-attention')).not.toBeNull();
    mutationReply = { status: 200, body: payload([row({ approval: 'approved', active: true })]) };
    await press('mcp-example-server-approve');

    const decision = sent.find((s) => s.url.includes('/decision'));
    expect(decision).toBeDefined();
    expect(decision!.body).toEqual({ name: 'example-server', decision: 'approve' });
    // The button was WIRED — the row re-rendered from the reply.
    expect(byTestId('mcp-example-server-active')).not.toBeNull();
    expect(byTestId('mcp-example-server-approve')).toBeNull();
  });

  it('Deny is a separate press with its own verb', async () => {
    getPayload = payload([row()]);
    await mountScreenUnderTest();
    mutationReply = { status: 200, body: payload([row({ approval: 'denied' })]) };
    await press('mcp-example-server-deny');
    expect(sent.find((s) => s.url.includes('/decision'))!.body).toEqual({
      name: 'example-server',
      decision: 'deny',
    });
  });

  it('Remove deletes by name and the row disappears', async () => {
    getPayload = payload([row()]);
    await mountScreenUnderTest();
    mutationReply = { status: 200, body: payload([]) };
    await press('mcp-example-server-remove');
    const del = sent.find((s) => s.method === 'DELETE');
    expect(del).toBeDefined();
    expect(del!.url).toContain('name=example-server');
    expect(byTestId('mcp-example-server')).toBeNull();
  });
});

describe('what the screen shows, and what it never shows', () => {
  it('renders the SERVER\'S grant prompt verbatim', async () => {
    // The client must not summarise what a program is allowed to do: a prompt built
    // on the device could describe something other than what the server would run.
    getPayload = payload([row()]);
    await mountScreenUnderTest();
    expect(byTestId('mcp-example-server-grant')!.textContent).toBe(GRANT);
  });

  it('never renders a VALUE, only the variable names', async () => {
    getPayload = payload([row()]);
    await mountScreenUnderTest();
    const text = document.body.textContent ?? '';
    expect(text).toContain('EXAMPLE_API_KEY');
    expect(text).not.toContain(SECRET);
  });

  it('an APPROVED row shows no approve control and no prompt — the gate is spent', async () => {
    getPayload = payload([row({ approval: 'approved', active: true })]);
    await mountScreenUnderTest();
    expect(byTestId('mcp-example-server-approve')).toBeNull();
    expect(byTestId('mcp-example-server-grant')).toBeNull();
    expect(byTestId('mcp-example-server-status')!.textContent ?? '').toContain('running');
  });

  it('an approved server with a MISSING secret is not reported as running', async () => {
    getPayload = payload([row({ approval: 'approved', secrets_present: false, active: false })]);
    await mountScreenUnderTest();
    expect(byTestId('mcp-example-server-active')).toBeNull();
    expect(byTestId('mcp-example-server-status')!.textContent ?? '').toContain('missing');
  });
});

describe('a rejected install', () => {
  it('shows the server\'s message verbatim and KEEPS the draft', async () => {
    await mountScreenUnderTest();
    await typeInto('mcp-form-name', 'Bad Name');
    mutationReply = {
      status: 400,
      body: {
        code: 'invalid_mcp_server',
        message: 'name must be lowercase letters, digits and dashes; command is required',
      },
    };
    await press('mcp-form-save');
    const err = byTestId('mcp-error');
    expect(err).not.toBeNull();
    expect(err!.textContent ?? '').toContain('command is required');
    // Discarding the draft would punish a typo by throwing away the rest of the work.
    expect((byTestId('mcp-form-name') as HTMLInputElement).value).toBe('Bad Name');
  });

  it('a failed LOAD says so instead of rendering an empty list', async () => {
    // "Nothing installed" and "we could not ask" are different facts, and only one of
    // them is actionable.
    (globalThis as unknown as { fetch: unknown }).fetch = async (): Promise<Response> => {
      throw new Error('server unreachable');
    };
    await mountScreenUnderTest();
    expect(byTestId('mcp-error')).not.toBeNull();
    expect(byTestId('mcp-empty')).toBeNull();
  });
});
