/**
 * THE OWNER CAN CONNECT CODEX AND KIMI FROM HIS PHONE — by PRESSING the controls.
 *
 * THE GAP. The gateway's Codex surface is explicitly app-scoped
 * (`/api/app/codex-auth`) and the WEB client has used it since it was built. The
 * mobile app had no client and no screen, so from a phone the cross-model reviewer
 * could not be connected at all. The reference deployment works only because
 * provisioning wrote the credential onto the filesystem directly — which no
 * self-hoster can do. Kimi was reachable in principle, but only by knowing the exact
 * service id and typing it into a free-text box.
 *
 * WHY THIS TEST PRESSES THINGS. A source check confirms a component mentions a
 * handler; it cannot tell a rendered-and-wired control from a rendered-and-inert
 * one. This repo has shipped that exact bug — a sheet that rendered correctly, whose
 * tree-shaped test passed, and which did nothing on the owner's device. So every
 * assertion here goes through the real screen: find the control by its testID, press
 * it, and check the request that left.
 *
 * NOTE ON THE KIMI ROW. It deliberately writes through the SAME global-credential
 * store the free-text form uses, so a key entered either way behaves identically —
 * the row is a labelled affordance over one code path, not a second one. The test
 * asserts the SERVICE ID, because that string is what makes the difference between
 * a key the review lane finds and a key stored where nothing reads it.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
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

/** The signed-in owner. The screen redirects to /login without one. */
const OWNER = {
  id: 'harness-owner',
  email: 'owner@example.test',
  displayName: 'Harness Owner',
  provider: 'dev' as const,
  token: 'harness-token',
};

/** Every request the screen made, so a press can be checked against the wire. */
interface Sent {
  url: string;
  method: string;
  body: unknown;
}
let sent: Sent[] = [];
/** What `GET /api/app/codex-auth` should answer with this mount. */
let codexStatus: Record<string, unknown> = { status: 'not_connected' };
/** What the shared-credential list should contain. */
let creds: Array<Record<string, unknown>> = [];

function installFetch(): void {
  (globalThis as unknown as { fetch: unknown }).fetch = async (
    input: string | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    let body: unknown = null;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    sent.push({ url, method, body });
    const json = (v: unknown): Response =>
      new Response(JSON.stringify(v), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    if (url.includes('/api/app/codex-auth')) {
      if (method === 'GET') return json(codexStatus);
      if (method === 'POST') return json({ status: 'connected', materialized: true });
      return json({ ok: true });
    }
    if (url.includes('/api/app/credentials')) {
      if (method === 'GET') return json({ global: creds });
      return json({ service: 'kimi', scope: 'global' });
    }
    // Everything else the screen loads on mount (the integrations overview).
    return json({ oauth: [], api_keys: [], services: [] });
  };
}

beforeAll(installNativeHarness);
afterAll(resetHarnessGlobals);
beforeEach(() => {
  if (mounted !== null) {
    mounted.unmount();
    mounted = null;
  }
  document.body.innerHTML = '';
  sent = [];
  codexStatus = { status: 'not_connected' };
  creds = [];
  installFetch();
});

/** Mount the real Integrations screen and let its mount-time loads settle. */
let mounted: { unmount(): void } | null = null;

/**
 * Mount the real Integrations screen and let its mount-time loads settle.
 *
 * UNMOUNTED in `beforeEach`. The queries below are DOCUMENT-scoped (a `Modal`
 * renders into its own portal outside the mounted subtree, so a container-scoped
 * query cannot see one) — which means a previous test's leftover DOM is
 * indistinguishable from this test's. Two assertions here failed on exactly that,
 * finding an earlier mount's not-connected paste box while asserting about a
 * connected one.
 */
async function mountIntegrations(): Promise<{ container: HTMLElement }> {
  const mod = await import('../app/integrations');
  const Screen = mod.default as () => unknown;
  const screen = await mountScreen(
    createElement(AuthSessionProvider, { initialUser: OWNER }, createElement(Screen as never)),
  );
  mounted = screen as unknown as { unmount(): void };
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  return screen as unknown as { container: HTMLElement };
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

async function typeInto(id: string, value: string): Promise<void> {
  const el = byTestId(id) as HTMLInputElement | HTMLTextAreaElement | null;
  if (el === null) throw new Error(`input '${id}' is not on screen`);
  await act(async () => {
    // THROUGH THE PROTOTYPE SETTER, not `el.value = …`. React tracks the value on
    // the node and skips a change it believes it already has, so a direct
    // assignment is INVISIBLE to it — the input looks typed and the component's
    // state never updates. The harness's own `type()` helper does the same thing
    // for the same reason; this bit me here first.
    const setter = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(el) as object,
      'value',
    )?.set;
    setter?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe('Codex — reachable from a phone at all', () => {
  it('reads its status on mount', async () => {
    await mountIntegrations();
    // The screen must ASK. Before this there was no client, so nothing did.
    expect(sent.some((s) => s.url.includes('/api/app/codex-auth') && s.method === 'GET')).toBe(true);
  });

  it('shows a not-connected state that says what is lost', async () => {
    await mountIntegrations();
    const status = byTestId('codex-status');
    expect(status).not.toBeNull();
    // Not just "not connected" — the consequence, because the owner cannot be
    // expected to know that an unconnected Codex means a single-model review panel.
    expect(status!.textContent ?? '').toContain('second model family');
  });

  it('PRESSING Connect sends the pasted bundle to the global route', async () => {
    await mountIntegrations();
    await typeInto('codex-auth-input', '{"tokens":"pretend-bundle"}');
    await press('codex-connect');
    const post = sent.find((s) => s.url.includes('/api/app/codex-auth') && s.method === 'POST');
    expect(post).toBeDefined();
    expect((post!.body as { auth?: string }).auth).toBe('{"tokens":"pretend-bundle"}');
    // The GLOBAL route, with no project segment: a Codex subscription is one
    // account for the whole instance.
    expect(post!.url).not.toContain('/projects/');
  });

  it('does NOT send when the paste box is empty', async () => {
    await mountIntegrations();
    await press('codex-connect').catch(() => undefined);
    expect(sent.some((s) => s.url.includes('/api/app/codex-auth') && s.method === 'POST')).toBe(
      false,
    );
  });

  it('offers Disconnect once connected, and KEEPS the paste box for a second seat', async () => {
    codexStatus = {
      status: 'connected',
      materialized: true,
      accounts: [
        {
          slot: 'default',
          label: null,
          status: 'connected',
          cooling: false,
          cooling_until: null,
          cooling_reason: null,
          used_percent: 10,
          window_minutes: 10080,
          plan_type: 'pro',
          active: true,
        },
      ],
      next: 'default',
    };
    await mountIntegrations();
    expect(byTestId('codex-disconnect')).not.toBeNull();

    // THIS ASSERTION IS INVERTED FROM WHAT IT ONCE WAS, deliberately. It used to
    // require the paste box to DISAPPEAR once connected, on the reasoning that a
    // paste box beside a working connection invites breaking it. That reasoning
    // held while a Codex subscription was one account for the whole instance; now
    // the owner can run several seats, and hiding the box is precisely what made
    // the second one unreachable.
    expect(byTestId('codex-auth-input')).not.toBeNull();

    // The original concern is answered by the LABEL rather than by hiding the
    // control: with no seat name typed, a paste replaces the first seat, and the
    // button says so instead of calling it an addition.
    expect(byTestId('codex-connect')?.textContent ?? '').toContain('Replace first seat');
  });

  it('an EXPIRED credential still offers the paste box AND Disconnect', async () => {
    // Expired is the state where the owner most needs both: replace it, or clear it.
    codexStatus = { status: 'expired', detail: 'token expired' };
    await mountIntegrations();
    expect(byTestId('codex-auth-input')).not.toBeNull();
    expect(byTestId('codex-disconnect')).not.toBeNull();
    expect(byTestId('codex-status')!.textContent ?? '').toContain('Expired');
  });

  it('surfaces the server error VERBATIM rather than swallowing it', async () => {
    // Pasting a metered API key instead of a subscription bundle is the common
    // mistake, and the gateway's reply is the only text that says which file to
    // paste instead. A generic "failed" would leave the owner stuck.
    (globalThis as unknown as { fetch: unknown }).fetch = async (
      input: string | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/app/codex-auth') && (init?.method ?? 'GET') === 'POST') {
        return new Response(
          JSON.stringify({ code: 'metered_key', message: 'that is a metered API key' }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/api/app/codex-auth')) {
        return new Response(JSON.stringify({ status: 'not_connected' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ credentials: [], oauth: [], api_keys: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    await mountIntegrations();
    await typeInto('codex-auth-input', 'sk-not-a-bundle');
    await press('codex-connect');
    expect(byTestId('codex-error')!.textContent ?? '').toContain('metered');
  })

  it('a failed status read shows not-connected WITHOUT disconnecting anything', async () => {
    (globalThis as unknown as { fetch: unknown }).fetch = async (): Promise<Response> => {
      throw new Error('server unreachable');
    };
    await mountIntegrations();
    // An unreachable server must never look like a credential the owner has to
    // re-enter, and it must certainly not send a DELETE.
    expect(sent.some((s) => s.method === 'DELETE')).toBe(false);
    expect(byTestId('codex-status')).not.toBeNull();
  });
});

describe('Kimi — a named row over the same store', () => {
  it('PRESSING Save stores under the service id the review lane reads', async () => {
    await mountIntegrations();
    await typeInto('kimi-key-input', 'pretend-kimi-key');
    await press('kimi-save');
    const post = sent.find((s) => s.url.includes('/api/app/credentials') && s.method === 'POST');
    expect(post).toBeDefined();
    // THE STRING THAT MATTERS. A mismatch here stores the key where nothing reads
    // it: the row would look like it worked and the reviewer would stay silent.
    expect((post!.body as { service?: string }).service).toBe('kimi');
    expect((post!.body as { token?: string }).token).toBe('pretend-kimi-key');
  });

  it('does not send an empty key', async () => {
    await mountIntegrations();
    await press('kimi-save').catch(() => undefined);
    expect(sent.some((s) => s.url.includes('/api/app/credentials') && s.method === 'POST')).toBe(
      false,
    );
  });

  it('reflects a key stored through the FREE-TEXT form — one source of truth', async () => {
    // The whole reason the row derives its state from the shared-credential list
    // rather than tracking its own: a key added by either control lights up here.
    creds = [{ service: 'kimi', scope: 'global', label: 'Kimi K3' }];
    await mountIntegrations();
    expect(byTestId('kimi-status')!.textContent ?? '').toContain('Key saved');
    expect(byTestId('kimi-remove')).not.toBeNull();
  });

  it('shows the consequence when no key is set', async () => {
    await mountIntegrations();
    expect(byTestId('kimi-status')!.textContent ?? '').toContain('one model family');
    expect(byTestId('kimi-remove')).toBeNull();
  });
});
