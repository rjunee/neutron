/**
 * THE OWNER CAN CONNECT GITHUB FROM HIS PHONE — by PRESSING the control (#551).
 *
 * THE GAP. `gateway/http/github-connect-surface.ts` has shipped the whole device
 * flow for months: GET reports status, POST starts one, the route slot resolves
 * and a composition-coverage test asserts it is mounted. NO CLIENT CALLED IT, on
 * any surface. Every automated signal said the feature worked, and the only human
 * path to a GitHub token was a shell on the machine — which is how the agent came
 * to answer a failed push with a terminal command, to an owner holding a phone.
 *
 * WHY THIS TEST PRESSES THINGS. A source check confirms a component mentions a
 * handler; it cannot tell a rendered-and-wired control from a rendered-and-inert
 * one. This repo has shipped that exact bug — a sheet that rendered correctly,
 * whose tree-shaped test passed, and which did nothing on the owner's device. So
 * every assertion here goes through the real screen: find the control by its
 * testID, press it, and check what left over the wire.
 *
 * WHY IT IS ITS OWN FILE RATHER THAN AN ENTRY IN `reachability-inventory.ts`. The
 * mobile inventory probes the CHAT SHELL — the composer, the rail, the tab bar.
 * Integrations is a separate route with its own screen, and the convention for
 * its controls is already a dedicated press-the-control file
 * (`model-providers-reachable.test.tsx`, which covers Codex and Kimi the same
 * way). This is that file for GitHub.
 *
 * THE DEVICE FLOW IS THE PART WORTH TESTING. It is not a redirect and not a paste
 * box. Starting it produces a CODE the owner types somewhere else, so the
 * assertions are: the POST goes out, the code is on screen, it can be copied in
 * one press, the verification page actually opens, and the screen polls itself
 * into the connected state instead of waiting to be reloaded.
 *
 * AND WHAT MUST NEVER BE ON SCREEN: the `device_code`. It is the bearer half of
 * the exchange — anyone holding it can complete the flow and take the token — so
 * the surface never returns it and nothing here may render it. Asserted against a
 * response that carries one anyway, because the interesting failure is a client
 * that renders whatever the server sent.
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

/** The public half of a device grant — exactly what the surface returns. */
const USER_CODE = 'WDJB-MJHT';
const VERIFICATION_URI = 'https://github.example.com/login/device';

/** The documented poll cadence (`GITHUB_POLL_MS` in the screen). A test cannot
 *  wait five real seconds, so the timer at exactly this delay is intercepted and
 *  fired by hand — which also asserts the screen scheduled one at all. */
const POLL_MS = 5_000;

interface Sent {
  url: string;
  method: string;
}
let sent: Sent[] = [];
/** What GET answers. Mutated by the POST handler and by individual tests. */
let state: Record<string, unknown> = { status: 'not_connected' };
/** Set by a test to make POST fail the way the gateway fails. */
let startFailure: { status: number; body: Record<string, unknown> } | null = null;
/** Extra keys the response carries — used to prove none of them leak. */
let extraOnStart: Record<string, unknown> = {};
/** URLs handed to `Linking.openURL` (react-native-web routes it to window.open). */
let opened: string[] = [];
/** Text handed to the clipboard. */
let copied: string[] = [];
/** LIVE poll callbacks the screen registered at the documented cadence, by the
 *  fake id handed back for each. An entry leaves when the screen clears it, so
 *  emptiness here means "the screen stopped polling", not "it never started". */
let pollTimers = new Map<number, () => void>();
let nextPollId = -1;

function installFetch(): void {
  (globalThis as unknown as { fetch: unknown }).fetch = async (
    input: string | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    sent.push({ url, method });
    const json = (v: unknown, status = 200): Response =>
      new Response(JSON.stringify(v), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    if (url.includes('/api/app/github-auth')) {
      if (method === 'POST') {
        if (startFailure !== null) return json(startFailure.body, startFailure.status);
        state = {
          status: 'awaiting_owner',
          user_code: USER_CODE,
          verification_uri: VERIFICATION_URI,
          expires_in_seconds: 900,
        };
        return json({ ...state, ...extraOnStart });
      }
      return json(state);
    }
    if (url.includes('/api/app/codex-auth')) return json({ status: 'not_connected' });
    if (url.includes('/api/app/credentials')) return json({ global: [] });
    // Everything else the screen loads on mount (the integrations overview).
    return json({ oauth: [], api_keys: [], services: [] });
  };
}

/**
 * Intercept ONLY the screen's poll timer — both ends of it.
 *
 * Every other interval — React's scheduler, happy-dom's own — is delegated to the
 * real implementation untouched, so this cannot silently freeze the harness. The
 * narrow match on the delay is deliberate: it means "the screen scheduled a poll
 * at the cadence it documents", which is itself part of what is being asserted.
 *
 * `clearInterval` is intercepted TOO, and that is the half worth explaining: a
 * capture that only sees `setInterval` can prove a poll STARTED and can never
 * prove it stopped, so a flow that settles and then hammers the server every five
 * seconds forever would pass. Clearing a fake id drops it from `pollTimers`;
 * every other id goes to the real implementation.
 */
let realSetInterval: typeof setInterval;
let realClearInterval: typeof clearInterval;
function installPollCapture(): void {
  realSetInterval = globalThis.setInterval;
  realClearInterval = globalThis.clearInterval;
  (globalThis as unknown as { setInterval: unknown }).setInterval = ((
    fn: () => void,
    ms?: number,
    ...rest: unknown[]
  ): unknown => {
    if (ms === POLL_MS) {
      const id = nextPollId--;
      pollTimers.set(id, fn);
      return id;
    }
    return (realSetInterval as unknown as (...a: unknown[]) => unknown)(fn, ms, ...rest);
  }) as unknown as typeof setInterval;
  (globalThis as unknown as { clearInterval: unknown }).clearInterval = ((
    id?: unknown,
  ): void => {
    if (typeof id === 'number' && pollTimers.has(id)) {
      pollTimers.delete(id);
      return;
    }
    (realClearInterval as unknown as (...a: unknown[]) => void)(id);
  }) as unknown as typeof clearInterval;
}

/** Run every LIVE poll once, the way five elapsed seconds would. */
async function firePoll(): Promise<void> {
  const callbacks = [...pollTimers.values()];
  await act(async () => {
    for (const cb of callbacks) cb();
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeAll(() => {
  installNativeHarness();
  installPollCapture();
});
afterAll(() => {
  if (realSetInterval !== undefined) {
    (globalThis as unknown as { setInterval: unknown }).setInterval = realSetInterval;
  }
  if (realClearInterval !== undefined) {
    (globalThis as unknown as { clearInterval: unknown }).clearInterval = realClearInterval;
  }
  resetHarnessGlobals();
});

let mounted: { unmount(): void } | null = null;

beforeEach(() => {
  if (mounted !== null) {
    mounted.unmount();
    mounted = null;
  }
  document.body.innerHTML = '';
  sent = [];
  opened = [];
  copied = [];
  pollTimers = new Map();
  state = { status: 'not_connected' };
  startFailure = null;
  extraOnStart = {};
  installFetch();
  // `Linking.openURL` under react-native-web is `window.open(url, target,
  // 'noopener')`, so this is where the hand-off becomes observable.
  (globalThis as unknown as { open: unknown }).open = (url: string): null => {
    opened.push(url);
    return null;
  };
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: (t: string): Promise<void> => {
        copied.push(t);
        return Promise.resolve();
      },
    },
  });
});

/**
 * Mount the real Integrations screen and let its mount-time loads settle.
 *
 * UNMOUNTED in `beforeEach`: the queries below are DOCUMENT-scoped, so a previous
 * mount's leftover DOM would be indistinguishable from this one's.
 */
async function mountIntegrations(): Promise<void> {
  const mod = await import('../app/integrations');
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

const githubRequests = (): Sent[] => sent.filter((s) => s.url.includes('/api/app/github-auth'));

describe('GitHub — reachable from a phone at all', () => {
  it('reads its status on mount', async () => {
    await mountIntegrations();
    // The screen must ASK. Before this there was no client, so nothing did.
    expect(githubRequests().some((s) => s.method === 'GET')).toBe(true);
  });

  it('shows a not-connected state that says what is LOST, plus a live control', async () => {
    await mountIntegrations();
    const status = byTestId('github-status');
    expect(status).not.toBeNull();
    // Not just "not connected" — the consequence, because "no GitHub token" does
    // not obviously mean "your build has nowhere to put its work".
    expect(status!.textContent ?? '').toContain('cannot push');
    expect(byTestId('github-connect')).not.toBeNull();
  });

  it('PRESSING Connect POSTs the flow open and puts the code on screen', async () => {
    await mountIntegrations();
    await press('github-connect');
    expect(githubRequests().some((s) => s.method === 'POST')).toBe(true);
    // The code is the interaction — it has to be the thing the owner sees.
    expect(byTestId('github-user-code')?.textContent).toBe(USER_CODE);
  });

  it('COPY puts the code on the clipboard in one press', async () => {
    // The owner reads this off the phone and types it into whatever has a
    // keyboard. One press to copy is most of the value of the whole screen.
    await mountIntegrations();
    await press('github-connect');
    await press('github-copy-code');
    expect(copied).toEqual([USER_CODE]);
  });

  it('OPEN GITHUB actually hands the device off to the verification page', async () => {
    await mountIntegrations();
    await press('github-connect');
    await press('github-open');
    // A press that renders and never reaches `Linking` is the exact defect this
    // whole file exists for, and only the hand-off itself can see it.
    expect(opened).toEqual([VERIFICATION_URI]);
  });

  it('the verification address is READABLE on screen, for the other-device path', async () => {
    // Copy + tap covers "approve on this phone". Reading the address off the
    // screen is how it gets typed into a laptop, which is the common case.
    await mountIntegrations();
    await press('github-connect');
    expect(byTestId('github-verification-uri')?.textContent ?? '').toContain(VERIFICATION_URI);
  });

  it('POLLS itself into the connected state — the owner never has to reload', async () => {
    await mountIntegrations();
    await press('github-connect');
    // A poll must have been scheduled at all; without one the owner approves at
    // GitHub and this screen keeps showing a code forever.
    expect(pollTimers.size).toBeGreaterThan(0);
    // The owner approves at GitHub, on some other device. Nothing tells the phone.
    state = { status: 'connected' };
    await firePoll();
    expect(byTestId('github-status')?.textContent ?? '').toContain('Connected');
    expect(byTestId('github-user-code')).toBeNull();
  });

  it('STOPS polling once connected — a settled flow must not hammer the server', async () => {
    // Starting a poll is half the requirement. A screen that never tears it down
    // asks the gateway for a status it already has, every five seconds, for as
    // long as the app is open — and on a phone that is battery and data.
    await mountIntegrations();
    await press('github-connect');
    state = { status: 'connected' };
    await firePoll();
    expect(pollTimers.size).toBe(0);
    const settled = githubRequests().length;
    await firePoll();
    expect(githubRequests().length).toBe(settled);
  });

  it('a DROPPED poll keeps the code on screen instead of blanking the flow', async () => {
    // The owner is at GitHub typing the code when one poll hits a flaky network.
    // Treating that as "not connected" would take the code away AND tear down the
    // poll that was about to see the approval — the flow would look like it had
    // failed at the exact moment it was working.
    await mountIntegrations();
    await press('github-connect');
    const failing = (globalThis as unknown as { fetch: unknown }).fetch;
    (globalThis as unknown as { fetch: unknown }).fetch = async (): Promise<Response> => {
      throw new Error('server unreachable');
    };
    await firePoll();
    expect(byTestId('github-user-code')?.textContent).toBe(USER_CODE);
    expect(pollTimers.size).toBeGreaterThan(0);
    // …and the very next poll, on a network that came back, still finishes it.
    (globalThis as unknown as { fetch: unknown }).fetch = failing;
    state = { status: 'connected' };
    await firePoll();
    expect(byTestId('github-status')?.textContent ?? '').toContain('Connected');
  });

  it('an ALREADY-CONNECTED account renders connected, with no code and no Connect', async () => {
    state = { status: 'connected' };
    await mountIntegrations();
    expect(byTestId('github-status')?.textContent ?? '').toContain('Connected');
    expect(byTestId('github-connect')).toBeNull();
    expect(byTestId('github-user-code')).toBeNull();
  });

  it('a flow ALREADY in flight shows its code straight away, without a second start', async () => {
    // The gateway is deliberately idempotent here — reopening the screen must
    // show the SAME code, not mint a rival the server has stopped polling.
    state = {
      status: 'awaiting_owner',
      user_code: USER_CODE,
      verification_uri: VERIFICATION_URI,
      expires_in_seconds: 300,
    };
    await mountIntegrations();
    expect(byTestId('github-user-code')?.textContent).toBe(USER_CODE);
    expect(githubRequests().some((s) => s.method === 'POST')).toBe(false);
  });

  it("surfaces the gateway's message VERBATIM when the flow cannot start", async () => {
    // "No client id is configured" and "GitHub refused the request" need
    // different things from the owner; a generic "failed" leaves them stuck.
    startFailure = {
      status: 503,
      body: {
        code: 'github_client_id_unset',
        message: 'NEUTRON_GITHUB_CLIENT_ID is not configured, so a device code cannot be requested',
      },
    };
    await mountIntegrations();
    await press('github-connect');
    expect(byTestId('github-error')?.textContent ?? '').toContain(
      'NEUTRON_GITHUB_CLIENT_ID is not configured',
    );
    // And the owner can try again — a failed start must not eat the control.
    expect(byTestId('github-connect')).not.toBeNull();
  });

  it('a failed status read shows not-connected WITHOUT disconnecting anything', async () => {
    (globalThis as unknown as { fetch: unknown }).fetch = async (): Promise<Response> => {
      throw new Error('server unreachable');
    };
    await mountIntegrations();
    // An unreachable server must never look like a credential to re-supply, and
    // it must certainly not send a write.
    expect(sent.some((s) => s.method !== 'GET')).toBe(false);
    expect(byTestId('github-status')).not.toBeNull();
  });

  it('NEVER renders the device_code, even when a response carries one', async () => {
    // The bearer half of the exchange. The real surface omits it by construction;
    // this asserts the CLIENT would not render it if it ever arrived.
    extraOnStart = { device_code: 'bearer-half-must-not-render' };
    await mountIntegrations();
    await press('github-connect');
    expect(byTestId('github-user-code')?.textContent).toBe(USER_CODE);
    expect(document.body.innerHTML).not.toContain('bearer-half-must-not-render');
  });
});
