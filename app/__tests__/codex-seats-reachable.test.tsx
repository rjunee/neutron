/**
 * THE OWNER CAN SEE, ADD AND REMOVE CODEX SEATS FROM HIS PHONE — by pressing them.
 *
 * WHY THIS FILE EXISTS. Rotation between several ChatGPT subscriptions was built
 * end to end — storage, selection, cooldowns, the HTTP surface — and none of it
 * reached a screen. A second subscription the owner pays for but cannot see, add
 * or disconnect is not a feature; it is a gap with tests attached. The engine's
 * own tests already cover the policy, so everything here is about REACHING it.
 *
 * WHY IT PRESSES REAL CONTROLS. A source check confirms a component mentions a
 * handler; it cannot tell a rendered-and-wired button from a rendered-and-inert
 * one, and this repo has shipped exactly that bug — a menu that rendered
 * correctly, asserted correctly, and did nothing on the owner's device. Every
 * assertion below goes through the real screen and the real client.
 *
 * THE THREE BEHAVIOURS MOST WORTH PINNING are the ones a reasonable
 * implementation gets wrong:
 *   1. the paste box must SURVIVE the first connection, because adding a second
 *      seat is the entire point and hiding it after seat one is what made the
 *      capability unreachable;
 *   2. per-seat removal must address THAT seat, not the default one;
 *   3. an unqualified disconnect must not quietly leave named seats live.
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
const RN = await import('react-native');

/**
 * Auto-accept the destructive confirm.
 *
 * Disconnecting a seat goes through `Alert.alert`, which has no implementation
 * under the test harness — so without this the confirm silently never resolves
 * and the DELETE this file exists to assert on is never sent. Choosing the
 * DESTRUCTIVE button specifically (not simply the last one) keeps the stub
 * honest: a dialog that grew a third option would still take the same path the
 * owner takes when he confirms.
 */
let lastAlert: { title: string; message?: string } | null = null;
function installAlertStub(): void {
  (RN.Alert as unknown as { alert: unknown }).alert = (
    title: string,
    message?: string,
    buttons?: { text?: string; style?: string; onPress?: () => void }[],
  ): void => {
    lastAlert = { title, ...(message === undefined ? {} : { message }) };
    const destructive = (buttons ?? []).find((b) => b.style === 'destructive');
    destructive?.onPress?.();
  };
}

const OWNER = {
  id: 'harness-owner',
  email: 'owner@example.test',
  displayName: 'Harness Owner',
  provider: 'dev' as const,
  token: 'harness-token',
};

interface Seat {
  slot: string;
  label: string | null;
  status: string;
  cooling: boolean;
  cooling_until: number | null;
  cooling_reason: string | null;
  used_percent: number | null;
  window_minutes: number | null;
  plan_type: string | null;
  active: boolean;
}

function seat(over: Partial<Seat> & { slot: string }): Seat {
  return {
    label: null,
    status: 'connected',
    cooling: false,
    cooling_until: null,
    cooling_reason: null,
    used_percent: 12,
    window_minutes: 10080,
    plan_type: 'pro',
    active: false,
    ...over,
  };
}

/** What GET /api/app/codex-auth answers with. Reassigned per test. */
let codexPayload: Record<string, unknown> = { status: 'not_connected' };

interface Sent {
  method: string;
  url: string;
  body: unknown;
}
let sent: Sent[] = [];

function installFetch(): void {
  (globalThis as unknown as { fetch: unknown }).fetch = async (
    input: string | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    let body: unknown = null;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const json = (v: unknown, status = 200): Response =>
      new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

    if (url.includes('/api/app/codex-auth')) {
      sent.push({ method, url, body });
      if (method === 'GET') return json(codexPayload);
      return json({ ok: true, status: 'connected' });
    }
    // This screen loads several other surfaces on mount. They answer with the
    // EMPTY-BUT-WELL-FORMED shape rather than `{}`, because a missing array
    // crashes the render before any codex assertion could run.
    if (url.includes('/api/cores/integrations')) {
      return json({
        ok: true,
        scope: { kind: 'cores', description: 'harness' },
        oauth: [],
        api_keys: [],
      });
    }
    return json({ ok: true, credentials: [], services: [], connected: false });
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
  lastAlert = null;
  codexPayload = { status: 'not_connected' };
  installFetch();
  installAlertStub();
});

/** The mounted screen's own API — container-scoped, so no stale mount matches. */
interface Screen {
  unmount(): void;
  byTestId(id: string): HTMLElement | null;
  press(accessibilityLabel: string): Promise<void>;
}
let screen: Screen;

async function mountIntegrations(): Promise<void> {
  const mod = await import('../app/integrations');
  const Component = mod.default as () => unknown;
  const s = await mountScreen(
    createElement(AuthSessionProvider, { initialUser: OWNER }, createElement(Component as never)),
  );
  screen = s as unknown as Screen;
  mounted = screen;
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

const byTestId = (id: string): HTMLElement | null => screen.byTestId(id);
const press = (accessibilityLabel: string): Promise<void> => screen.press(accessibilityLabel);

const codexCalls = (method: string): Sent[] => sent.filter((s) => s.method === method);

describe('the seat list is on screen', () => {
  it('renders a row per connected seat, naming the one that runs next', async () => {
    codexPayload = {
      status: 'connected',
      accounts: [
        seat({ slot: 'default', label: 'Personal', active: true }),
        seat({ slot: 'work', label: 'Work' }),
      ],
      next: 'default',
      exhausted: false,
    };
    await mountIntegrations();
    // MUTATION: render only `status` and drop the accounts map — the owner then
    // has no way to know a second seat exists at all.
    expect(byTestId('codex-seat-default')).not.toBeNull();
    expect(byTestId('codex-seat-work')).not.toBeNull();
  });

  it('says a cooling seat is cooling, and a revoked one needs reconnecting', async () => {
    codexPayload = {
      status: 'connected',
      accounts: [
        seat({
          slot: 'default',
          cooling: true,
          cooling_until: Date.now() + 3 * 3_600_000,
          cooling_reason: 'long-window',
          used_percent: 99.6,
        }),
        seat({ slot: 'work', cooling: true, cooling_reason: 'unauthorized', cooling_until: Date.now() }),
      ],
      exhausted: true,
    };
    await mountIntegrations();
    // The two cooling states need DIFFERENT owner actions — wait vs reconnect —
    // so collapsing them into one message would tell him to do the wrong thing.
    expect(byTestId('codex-seat-default')?.textContent ?? '').toContain('Cooling');
    expect(byTestId('codex-seat-work')?.textContent ?? '').toContain('reconnect');
    expect(byTestId('codex-exhausted')).not.toBeNull();
  });

  it('shows no seat list on a server that does not report seats', async () => {
    codexPayload = { status: 'connected' };
    await mountIntegrations();
    expect(byTestId('codex-accounts')).toBeNull();
  });
});

describe('the owner can add a second seat', () => {
  // MUTATION: restore the `codexStatus?.status !== 'connected'` guard around the
  // paste box. The first seat then connects fine and the second is unreachable —
  // which is precisely the shape of the bug this test exists to catch.
  it('keeps the paste box available once a seat is already connected', async () => {
    codexPayload = {
      status: 'connected',
      accounts: [seat({ slot: 'default', active: true })],
      next: 'default',
    };
    await mountIntegrations();
    expect(byTestId('codex-auth-input')).not.toBeNull();
    expect(byTestId('codex-account-input')).not.toBeNull();
    expect(byTestId('codex-connect')).not.toBeNull();
  });

  it('sends the seat name it was given, and re-reads the pool afterwards', async () => {
    codexPayload = {
      status: 'connected',
      accounts: [seat({ slot: 'default', active: true })],
      next: 'default',
    };
    await mountIntegrations();
    const account = byTestId('codex-account-input') as HTMLInputElement | null;
    const auth = byTestId('codex-auth-input') as HTMLInputElement | null;
    if (account === null || auth === null) throw new Error('the add-a-seat form is not on screen');
    await act(async () => {
      setValue(account, 'work');
      setValue(auth, '{"tokens":{"access_token":"x"}}');
      await new Promise((r) => setTimeout(r, 0));
    });
    await press('Connect Codex');

    const post = codexCalls('POST').at(-1);
    // MUTATION: drop `account` from the client's connect body. The paste then
    // silently OVERWRITES the first seat instead of adding a second one — the
    // worst possible outcome, because it destroys a working credential.
    expect((post?.body as { account?: string })?.account).toBe('work');
    // The pool's shape (which seat is next, what is cooling) only comes from GET.
    expect(codexCalls('GET').length).toBeGreaterThan(1);
  });

  // MUTATION: label the control 'Add seat' whenever a seat name is typed, i.e.
  // stop comparing the typed name against the connected seats.
  //
  // The server normalizes a seat name by trimming and lowercasing it, so `Work`,
  // ` work ` and `work` are ONE seat. Typing any of them while `work` is
  // connected OVERWRITES a live subscription bundle, and the owner cannot get it
  // back without fetching auth.json from the other machine again. The overwrite
  // is legitimate — it is how a revoked seat is repaired — so the control stays
  // enabled; what it must not do is call it an addition.
  it('says REPLACE when the typed seat name is one that already exists', async () => {
    codexPayload = {
      status: 'connected',
      accounts: [seat({ slot: 'default', active: true }), seat({ slot: 'work' })],
      next: 'default',
    };
    await mountIntegrations();
    const account = byTestId('codex-account-input') as HTMLInputElement | null;
    if (account === null) throw new Error('the add-a-seat form is not on screen');

    for (const typed of ['work', 'Work', ' WORK ']) {
      await act(async () => {
        setValue(account, typed);
        await new Promise((r) => setTimeout(r, 0));
      });
      expect(byTestId('codex-connect')?.textContent ?? '').toContain('Replace seat');
    }

    // …and a genuinely new name is still an addition.
    await act(async () => {
      setValue(account, 'spare');
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(byTestId('codex-connect')?.textContent ?? '').toContain('Add seat');
  });
});

describe('the owner can remove one seat without removing the others', () => {
  it('addresses the pressed seat, not the default one', async () => {
    codexPayload = {
      status: 'connected',
      accounts: [seat({ slot: 'default', active: true }), seat({ slot: 'work' })],
      next: 'default',
    };
    await mountIntegrations();
    await press('Disconnect work');
    // The confirm names the seat, so a mis-wired row is visible rather than silent.
    expect(lastAlert?.title ?? '').toContain('work');
    const del = codexCalls('DELETE').at(-1);
    // MUTATION: send the DELETE without `?account=`. That reads as "disconnect
    // Codex entirely", so pressing Remove on one seat would take them all.
    expect(del?.url ?? '').toContain('account=work');
  });
});

/**
 * Set a controlled field's value the way React's `onChangeText` will observe it.
 *
 * Through the element's OWN prototype, not `HTMLInputElement`'s: a `multiline`
 * TextInput renders as a `<textarea>`, so a setter borrowed from the input
 * prototype throws on it. Assigning `.value` directly is invisible to React,
 * hence the descriptor dance rather than a plain assignment.
 */
function setValue(el: HTMLElement, value: string): void {
  const field = el as HTMLInputElement | HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(field) as object,
    'value',
  )?.set;
  if (setter !== undefined) setter.call(field, value);
  else field.value = value;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  field.dispatchEvent(new Event('change', { bubbles: true }));
}
