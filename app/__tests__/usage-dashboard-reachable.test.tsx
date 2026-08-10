/**
 * THE OWNER CAN SEE HIS QUOTA STANDING FROM HIS PHONE.
 *
 * The chain: the monitor measured every 60 seconds and discarded it → the store keeps
 * it → the endpoint summarises it → the web card renders it. Each of those was correct
 * on its own while the phone had nothing at all, which is the shape this repo keeps
 * re-learning, so the assertions here are about REACHING and RENDERING rather than
 * about the arithmetic — the server owns that and has its own tests.
 *
 * WHY IT PRESSES THINGS. A source check confirms a component mentions a value; it
 * cannot tell a rendered-and-correct row from one the layout never shows. Every
 * assertion goes through the real screen.
 *
 * THE BEHAVIOURS MOST WORTH PINNING ARE THE ABSENCES, because each has a plausible
 * alternative that renders fine and states something false:
 *
 *   - an unreachable server must draw NO BAR (a 0% bar invents a measurement)
 *   - a null pace must read as an em dash, never `0.0×` ("burning nothing")
 *   - a null projection must OMIT its row (null is the common GOOD case; a permanent
 *     "—" trains the eye to hunt for a warning that is normally absent)
 *   - a null account label must read "active credential" and never guess
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

const OWNER = {
  id: 'harness-owner',
  email: 'owner@example.test',
  displayName: 'Harness Owner',
  provider: 'dev' as const,
  token: 'harness-token',
};

const HOT_SESSION = {
  fraction: 0.75,
  reset_at: 1_700_009_000_000,
  resets_in_ms: 9_000_000,
  pace: 1.5,
  exhausts_at: Date.now() + 3_000_000,
};

function pools(
  session: unknown,
  weekly: unknown,
  account_label: string | null = null,
): Record<string, unknown> {
  return {
    pools: [
      { pool: 'anthropic', measured_at: 1_700_000_000_000, account_label, session, weekly },
    ],
  };
}

let response: { status: number; body: unknown } = { status: 200, body: pools(HOT_SESSION, null) };
let requested: string[] = [];

function installFetch(): void {
  (globalThis as unknown as { fetch: unknown }).fetch = async (
    input: string | URL,
  ): Promise<Response> => {
    requested.push(String(input));
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { 'content-type': 'application/json' },
    });
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
  requested = [];
  response = { status: 200, body: pools(HOT_SESSION, null) };
  installFetch();
});

async function mountUsage(): Promise<void> {
  const mod = await import('../app/usage');
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

const textOf = (id: string): string => byTestId(id)?.textContent ?? '';

async function press(id: string): Promise<void> {
  const el = byTestId(id);
  if (el === null) throw new Error(`control '${id}' is not on screen`);
  await act(async () => {
    el.click();
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe('the screen reads the series and shows the standing', () => {
  it('fetches the dashboard route on mount', async () => {
    await mountUsage();
    expect(requested.some((u) => u.endsWith('/api/app/usage/dashboard'))).toBe(true);
  });

  it('shows the percent, the pace and its reading', async () => {
    await mountUsage();
    expect(textOf('usage-anthropic-session-pct')).toBe('75%');
    expect(textOf('usage-anthropic-session-pace')).toContain('1.5×');
    expect(textOf('usage-anthropic-session-resets')).toBe('2h 30m');
    expect(byTestId('usage-anthropic-session')?.textContent ?? '').toContain('faster');
  });

  it('bands the fill by the shared thresholds', async () => {
    // 0.9 is warning; the band rides on an accessibility label rather than only on a
    // style, because a test that can read only a colour cannot tell amber from red on
    // a 6px bar.
    response = { status: 200, body: pools({ ...HOT_SESSION, fraction: 0.9 }, null) };
    await mountUsage();
    const fill = byTestId('usage-anthropic-session-fill');
    expect(fill?.getAttribute('aria-label') ?? fill?.getAttribute('accessibilityLabel') ?? '').toContain(
      'warning',
    );
  });

  it('refreshes on demand', async () => {
    await mountUsage();
    const before = requested.length;
    await press('usage-refresh');
    expect(requested.length).toBeGreaterThan(before);
  });
});

describe('what the screen refuses to say', () => {
  it('draws NO bar when the route is not mounted', async () => {
    // An older server 404s here. A 0% bar would invent a measurement.
    response = { status: 404, body: { ok: false } };
    await mountUsage();
    expect(byTestId('usage-unreachable')).not.toBeNull();
    expect(byTestId('usage-anthropic')).toBeNull();
    expect(byTestId('usage-anthropic-session-fill')).toBeNull();
  });

  it('draws NO bar when the request throws', async () => {
    (globalThis as unknown as { fetch: unknown }).fetch = async (): Promise<Response> => {
      throw new Error('server unreachable');
    };
    await mountUsage();
    expect(byTestId('usage-unreachable')).not.toBeNull();
    expect(byTestId('usage-anthropic-session-fill')).toBeNull();
  });

  it('renders a null pace as a dash with no reading beside it', async () => {
    response = {
      status: 200,
      body: pools(
        { fraction: 0.2, reset_at: null, resets_in_ms: null, pace: null, exhausts_at: null },
        null,
      ),
    };
    await mountUsage();
    expect(textOf('usage-anthropic-session-pace').trim()).toBe('—');
    // And no note: "unknown pace" would draw the eye to an absence the owner cannot fix.
    const row = byTestId('usage-anthropic-session')?.textContent ?? '';
    expect(row).not.toContain('faster');
    expect(row).not.toContain('within');
  });

  it('OMITS the projection row when there is no projection', async () => {
    response = {
      status: 200,
      body: pools({ ...HOT_SESSION, pace: 0.4, exhausts_at: null }, null),
    };
    await mountUsage();
    expect(byTestId('usage-anthropic-session-exhausts')).toBeNull();
    expect(document.body.textContent ?? '').not.toContain('Caps out in');
  });

  it('SHOWS the projection row when the window is on track to run out', async () => {
    await mountUsage();
    expect(byTestId('usage-anthropic-session-exhausts')).not.toBeNull();
  });

  it('says a window was not reported rather than drawing an empty track', async () => {
    await mountUsage();
    expect(textOf('usage-anthropic-weekly-none')).toBe('not reported');
    expect(byTestId('usage-anthropic-weekly-fill')).toBeNull();
  });

  it('never guesses the account, and uses a real label when given one', async () => {
    await mountUsage();
    expect(textOf('usage-anthropic-account')).toBe('active credential');
    response = { status: 200, body: pools(HOT_SESSION, null, 'acct-2') };
    await press('usage-refresh');
    expect(textOf('usage-anthropic-account')).toBe('acct-2');
  });

  it('distinguishes "answered with nothing" from "could not ask"', async () => {
    response = { status: 200, body: { pools: [] } };
    await mountUsage();
    expect(byTestId('usage-empty')).not.toBeNull();
    expect(byTestId('usage-unreachable')).toBeNull();
  });
});
