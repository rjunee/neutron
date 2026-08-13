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
 *   - an ABSENT reset instant must read "unknown", never "available now" — the one
 *     that decides whether the owner raises concurrency or waits
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, setSystemTime } from 'bun:test';
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

// Time-RELATIVE, because a countdown asserted against a hardcoded epoch is a test
// that passes today and lies later.
const NOW = Date.now();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const HOT_SESSION = {
  fraction: 0.75,
  window_ms: 5 * HOUR,
  reset_at: NOW + 2.5 * HOUR,
  pace: 1.5,
  exhausts_at: NOW + 50 * MINUTE,
};

type Json = Record<string, unknown>;

/**
 * One account as the SERVER sends it: instants and figures, and no verdicts.
 *
 * There is no `age_ms`, no `stale`, no `floor` and no `capacity` to override,
 * because none of them ride the wire — the screen derives all four from
 * `measured_at`, `stale_after_ms` and its own clock. A test that wants a stale card
 * backdates `measured_at`, which is the same lever a dead poller pulls.
 */
function account(over: Json = {}): Json {
  return {
    account_label: null,
    measured_at: NOW,
    session: HOT_SESSION,
    weekly: null,
    ...over,
  };
}

function poolOf(over: Json = {}): Json {
  const accounts = (over['accounts'] as Json[] | undefined) ?? [account()];
  return {
    pool: 'anthropic',
    connection: 'connected',
    measured_at: (accounts[0]?.['measured_at'] as number | undefined) ?? NOW,
    // Anthropic's deadline: a 60s cadence with one missed probe of grace.
    stale_after_ms: 2 * MINUTE,
    ...over,
    accounts,
  };
}

function pools(
  session: unknown,
  weekly: unknown,
  account_label: string | null = null,
): Record<string, unknown> {
  return { pools: [poolOf({ accounts: [account({ session, weekly, account_label })] })] };
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
    expect(textOf('usage-anthropic-acct-0-session-pct')).toBe('75%');
    expect(textOf('usage-anthropic-acct-0-session-pace')).toContain('1.5×');
    // The countdown is computed HERE from the absolute instant, so it reads in the
    // owner's units rather than in whatever the server computed a request ago.
    expect(textOf('usage-anthropic-acct-0-session-resets')).toBe('2h 30m');
    expect(byTestId('usage-anthropic-acct-0-session')?.textContent ?? '').toContain('faster');
  });

  it('bands the fill by the shared thresholds', async () => {
    // 0.9 is warning; the band rides on an accessibility label rather than only on a
    // style, because a test that can read only a colour cannot tell amber from red on
    // a 6px bar.
    response = { status: 200, body: pools({ ...HOT_SESSION, fraction: 0.9 }, null) };
    await mountUsage();
    const fill = byTestId('usage-anthropic-acct-0-session-fill');
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
    expect(byTestId('usage-anthropic-acct-0-session-fill')).toBeNull();
  });

  it('draws NO bar when the request throws', async () => {
    (globalThis as unknown as { fetch: unknown }).fetch = async (): Promise<Response> => {
      throw new Error('server unreachable');
    };
    await mountUsage();
    expect(byTestId('usage-unreachable')).not.toBeNull();
    expect(byTestId('usage-anthropic-acct-0-session-fill')).toBeNull();
  });

  it('renders a null pace as a dash with no reading beside it', async () => {
    response = {
      status: 200,
      body: pools(
        { fraction: 0.2, reset_at: null, pace: null, exhausts_at: null },
        null,
      ),
    };
    await mountUsage();
    expect(textOf('usage-anthropic-acct-0-session-pace').trim()).toBe('—');
    // And no note: "unknown pace" would draw the eye to an absence the owner cannot fix.
    const row = byTestId('usage-anthropic-acct-0-session')?.textContent ?? '';
    expect(row).not.toContain('faster');
    expect(row).not.toContain('within');
  });

  it('OMITS the projection row when there is no projection', async () => {
    response = {
      status: 200,
      body: pools({ ...HOT_SESSION, pace: 0.4, exhausts_at: null }, null),
    };
    await mountUsage();
    expect(byTestId('usage-anthropic-acct-0-session-exhausts')).toBeNull();
    expect(document.body.textContent ?? '').not.toContain('Caps out in');
  });

  it('SHOWS the projection row when the window is on track to run out', async () => {
    await mountUsage();
    expect(byTestId('usage-anthropic-acct-0-session-exhausts')).not.toBeNull();
  });

  it('says a window was not reported rather than drawing an empty track', async () => {
    await mountUsage();
    expect(textOf('usage-anthropic-acct-0-weekly-none')).toBe('not reported');
    expect(byTestId('usage-anthropic-acct-0-weekly-fill')).toBeNull();
  });

  it('never guesses the account, and uses a real label when given one', async () => {
    await mountUsage();
    expect(textOf('usage-anthropic-acct-0-name')).toBe('active credential');
    response = { status: 200, body: pools(HOT_SESSION, null, 'acct-2') };
    await press('usage-refresh');
    expect(textOf('usage-anthropic-acct-0-name')).toBe('acct-2');
  });

  it('distinguishes "answered with nothing" from "could not ask"', async () => {
    response = { status: 200, body: { pools: [] } };
    await mountUsage();
    expect(byTestId('usage-empty')).not.toBeNull();
    expect(byTestId('usage-unreachable')).toBeNull();
  });
});

describe('when capacity comes back — the number the owner acts on', () => {
  it('says how many accounts are free right now, above the fold', async () => {
    await mountUsage();
    expect(textOf('usage-anthropic-capacity')).toBe('1 available now');
  });

  it('counts down to the BINDING window and names what still constrains it', async () => {
    // A 5-hour window resetting in 17 minutes buys nothing while the 7-day window is
    // 97% spent. A line that said "next capacity in 17m" would be an instruction to
    // raise concurrency into a wall.
    const cooling = account({
      account_label: 'owner-a',
      session: { ...HOT_SESSION, fraction: 0.98, reset_at: NOW + 17 * MINUTE },
      weekly: {
        ...HOT_SESSION,
        window_ms: 7 * DAY,
        fraction: 0.97,
        reset_at: NOW + 3 * DAY,
        exhausts_at: null,
        pace: null,
      },
    });
    response = { status: 200, body: { pools: [poolOf({ accounts: [cooling] })] } };
    await mountUsage();
    const line = textOf('usage-anthropic-capacity');
    expect(line).toContain('Next capacity in');
    expect(line).toContain('7d window');
    expect(line).toContain('5h window 98% used');
    expect(line).not.toContain('17m');
    // The per-window countdown is still there, paired with that window's own
    // utilisation — the 17 minutes are a fact about the 5-hour window, and the card
    // shows it as one.
    expect(textOf('usage-anthropic-acct-0-session-resets')).toBe('17m');
    expect(textOf('usage-anthropic-acct-0-session-pct')).toBe('98%');
  });

  it('renders an ABSENT reset instant as "unknown" — never "available now"', async () => {
    // THE MUTATION TEST: turning a missing instant into availability is the failure
    // this whole line exists to prevent.
    response = {
      status: 200,
      body: {
        pools: [
          poolOf({
            accounts: [
              account({
                account_label: 'owner-a',
                session: {
                  ...HOT_SESSION,
                  fraction: 0.99,
                  reset_at: null,
                  pace: null,
                  exhausts_at: null,
                },
              }),
            ],
          }),
        ],
      },
    };
    await mountUsage();
    expect(textOf('usage-anthropic-acct-0-session-resets')).toBe('unknown');
    expect(textOf('usage-anthropic-acct-0-capacity')).toBe('capacity unknown');
    expect(textOf('usage-anthropic-capacity')).toContain('unknown');
    expect(document.body.textContent ?? '').not.toContain('available now');
  });
});

describe('the screen REFETCHES, not just re-renders', () => {
  it('a healthy install stays fresh across the staleness deadline', async () => {
    // THE DEFECT THIS PINS. Computing every delta at paint is what ages a card
    // honestly across a DEAD poller — and, on its own, it is a slow lie in the other
    // direction. This pool goes stale at two minutes, so a screen left open with a
    // fetch-once mount would floor its gauge to "≥ 75%" and drop capacity to
    // "unknown" about two and a half minutes in, while the poller behind it wrote a
    // fresh row every 60 seconds, and would stay that way. A screen that paints a
    // working install as broken is the same defect as one that paints a broken
    // install as working.
    //
    // The interval is CAPTURED rather than waited on: waiting thirty real seconds in
    // a test is how a suite becomes something nobody runs.
    const { USAGE_POLL_MS } = await import('../lib/usage-dashboard-client');
    const ticks: Array<() => void> = [];
    const realSetInterval = globalThis.setInterval;
    // Stamped with the CURRENT clock on every request — exactly what a live poller
    // writing a fresh row every 60 seconds produces.
    (globalThis as unknown as { fetch: unknown }).fetch = async (
      input: string | URL,
    ): Promise<Response> => {
      requested.push(String(input));
      const at = Date.now();
      const body = {
        pools: [
          poolOf({
            accounts: [
              account({ measured_at: at, session: { ...HOT_SESSION, reset_at: at + 2 * HOUR } }),
            ],
          }),
        ],
      };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const startedAt = Date.now();
    (globalThis as unknown as Record<string, unknown>)['setInterval'] = ((
      fn: () => void,
      ms: number,
    ) => {
      if (ms === USAGE_POLL_MS) ticks.push(fn);
      return 0;
    }) as unknown as typeof setInterval;
    try {
      await mountUsage();
      expect(textOf('usage-anthropic-acct-0-session-pct')).toBe('75%');
      // A poll interval was registered AT ALL, at the cadence the client exports —
      // the positive control for the assertions below, which would otherwise pass
      // vacuously against a screen that registered no timer.
      expect(ticks.length).toBeGreaterThan(0);

      // Two and a half minutes pass: past this pool's two-minute deadline.
      setSystemTime(new Date(startedAt + 150_000));
      const before = requested.length;
      await act(async () => {
        ticks[ticks.length - 1]!();
        await new Promise((r) => setTimeout(r, 0));
        await new Promise((r) => setTimeout(r, 0));
      });
      // THE MUTANT THIS KILLS: a tick that advances the render clock and nothing
      // else. It leaves the request count where it was, and the two assertions below
      // flip to "≥ 75%" and "2m ago".
      expect(requested.length).toBeGreaterThan(before);
      expect(textOf('usage-anthropic-acct-0-session-pct')).toBe('75%');
      expect(textOf('usage-anthropic-acct-0-age')).toBe('just now');
      // And the button the OWNER presses is not left saying "Refreshing…" by a
      // background poll — a control disabled every thirty seconds forever is a
      // control he cannot use.
      expect(textOf('usage-refresh')).toBe('Refresh');
    } finally {
      setSystemTime();
      (globalThis as unknown as Record<string, unknown>)['setInterval'] = realSetInterval;
    }
  });
});

describe('staleness is shown, never hidden', () => {
  it('floors a stale reading with a ≥ and shows its age', async () => {
    response = {
      status: 200,
      body: {
        pools: [
          poolOf({
            accounts: [
              // Nothing here says "stale". The reading is simply three hours old and
              // the screen works that out against its own clock — which is the whole
              // fix: a server that said "fresh" three hours ago cannot keep being
              // believed. The fixture sits OFF the minute boundary because an age
              // FLOORS — it is a claim about the past, and at 61 seconds the reading
              // is one minute old — so a fixture exactly on a minute would render one
              // way or the other depending on how long the render took.
              account({
                measured_at: NOW - (3 * HOUR + 90_000),
                session: {
                  ...HOT_SESSION,
                  fraction: 0.43,
                  reset_at: NOW + 2 * HOUR,
                  pace: null,
                  exhausts_at: null,
                },
              }),
            ],
          }),
        ],
      },
    };
    await mountUsage();
    // The last known value, marked as a lower bound. Never blanked, never a zero.
    expect(textOf('usage-anthropic-acct-0-session-pct')).toBe('≥ 43%');
    expect(textOf('usage-anthropic-acct-0-age')).toBe('3h 01m ago');
  });

  it('a pool with no samples says WHY, and draws nothing', async () => {
    // Codex until its harvest lands: "not connected", never a row of zeros, which
    // would read as a connected account that has used nothing.
    response = {
      status: 200,
      body: {
        pools: [
          {
            pool: 'codex',
            connection: 'not_connected',
            measured_at: null,
            stale_after_ms: 30 * MINUTE,
            accounts: [],
          },
        ],
      },
    };
    await mountUsage();
    expect(textOf('usage-codex-empty')).toBe('Not connected.');
    expect(byTestId('usage-codex-acct-0-session-fill')).toBeNull();
    // And no capacity line: nothing measured means no standing to report.
    expect(byTestId('usage-codex-capacity')).toBeNull();
    expect(textOf('usage-codex-age')).toBe('never measured');
  });

  it('renders EVERY pool as its own card, in its own units', async () => {
    response = {
      status: 200,
      body: { pools: [poolOf(), poolOf({ pool: 'kimi' })] },
    };
    await mountUsage();
    expect(textOf('usage-anthropic-title')).toBe('Anthropic');
    // Kimi's endpoint is account-wide, and the title says so rather than implying a
    // per-key reading the provider does not offer.
    expect(textOf('usage-kimi-title')).toBe('Kimi (account-wide)');
  });
});
