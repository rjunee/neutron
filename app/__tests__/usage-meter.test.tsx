/**
 * @neutronai/app — the usage meter, and the tab band that owns it.
 *
 * The same two guarantees the web meter carries, checked on the RN tree:
 *   1. nothing measured ⇒ no fill node at all, so the seam is the plain hairline
 *      it has always been rather than a bar sitting at zero;
 *   2. the WHOLE fill changes colour at 85% and again at 95% — one line, one
 *      number, one colour.
 *
 * Plus the structural fact that makes it a divider rather than a widget: the tab
 * band renders it as its last child, and the band no longer draws a bottom
 * hairline of its own. Two lines there would be one line too many.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createElement } from 'react';

import {
  installNativeHarness,
  setHarnessPlatform,
  resetHarnessGlobals,
} from './support/native-harness';

installNativeHarness();
setHarnessPlatform('ios');

const { mountScreen } = await import('./support/mount');
const { UsageMeter } = await import('../components/UsageMeter');
const { ProjectTabBar } = await import('../components/ProjectTabBar');
const { THEME } = await import('../lib/theme');
const { USAGE_UNKNOWN } = await import('../lib/usage-client');

type UsagePayload = import('../lib/usage-client').UsagePayload;

beforeAll(installNativeHarness);
afterAll(resetHarnessGlobals);

/**
 * The harness resolves colours to `rgba(...)`, so compare on a normal form
 * rather than on the literal token — the assertion is about WHICH band colour is
 * painted, not about the notation the renderer chose.
 */
function normalizeColor(value: string | undefined): string {
  if (value === undefined || value.length === 0) return 'none';
  const hex = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (hex !== null) {
    const n = Number.parseInt(hex[1] as string, 16);
    return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
  }
  const rgba = /rgba?\(\s*([0-9.]+)[,\s]+([0-9.]+)[,\s]+([0-9.]+)/i.exec(value);
  if (rgba !== null) {
    return `${Math.round(Number(rgba[1]))},${Math.round(Number(rgba[2]))},${Math.round(Number(rgba[3]))}`;
  }
  return value;
}

function available(session: number, weekly: number): UsagePayload {
  return { available: true, session, weekly, measured_at: 1 };
}

async function mountMeter(usage: UsagePayload) {
  return mountScreen(createElement(UsageMeter, { usage }));
}

describe('UsageMeter', () => {
  it('is two lines — session over weekly', async () => {
    const screen = await mountMeter(available(0.1, 0.9));
    expect(screen.byTestId('usage-meter-session')).not.toBeNull();
    expect(screen.byTestId('usage-meter-weekly')).not.toBeNull();
    screen.unmount();
  });

  it('draws NO fill when nothing is measured — the plain hairline, not a 0% bar', async () => {
    const screen = await mountMeter(USAGE_UNKNOWN);
    expect(screen.byTestId('usage-meter-session')).not.toBeNull();
    expect(screen.byTestId('usage-meter-session-fill')).toBeNull();
    expect(screen.byTestId('usage-meter-weekly-fill')).toBeNull();
    screen.unmount();
  });

  it('recolours the WHOLE fill at each threshold', async () => {
    const cases: ReadonlyArray<[number, string]> = [
      [0.5, THEME.usage_nominal],
      [0.8499, THEME.usage_nominal],
      [0.85, THEME.usage_warning],
      [0.94, THEME.usage_warning],
      [0.95, THEME.usage_critical],
      [1, THEME.usage_critical],
    ];
    for (const [fraction, expected] of cases) {
      const screen = await mountMeter(available(fraction, 0));
      const fill = screen.byTestId('usage-meter-session-fill');
      expect(`${fraction} → ${normalizeColor(fill?.style.backgroundColor)}`).toBe(
        `${fraction} → ${normalizeColor(expected)}`,
      );
      screen.unmount();
    }
  });

  it('sizes each fill from the left as a percentage of its line', async () => {
    const screen = await mountMeter(available(0.42, 0.07));
    expect(screen.byTestId('usage-meter-session-fill')?.style.width).toBe('42.00%');
    expect(screen.byTestId('usage-meter-weekly-fill')?.style.width).toBe('7.00%');
    screen.unmount();
  });

  it('clamps a blown-through window instead of overflowing its track', async () => {
    const screen = await mountMeter(available(1.4, 0.5));
    expect(screen.byTestId('usage-meter-session-fill')?.style.width).toBe('100.00%');
    screen.unmount();
  });
});

describe('the tab band', () => {
  it('renders the meter as its own bottom edge', async () => {
    const screen = await mountScreen(
      createElement(ProjectTabBar, {
        active: 'chat',
        onSelect: () => undefined,
        usage: available(0.9, 0.2),
      }),
    );
    expect(screen.byTestId('project-tab-bar-narrow')).not.toBeNull();
    expect(screen.byTestId('usage-meter')).not.toBeNull();
    expect(normalizeColor(screen.byTestId('usage-meter-session-fill')?.style.backgroundColor)).toBe(
      normalizeColor(THEME.usage_warning),
    );
    screen.unmount();
  });

  it('degrades to the plain divider when the caller has no reading to give', async () => {
    const screen = await mountScreen(
      createElement(ProjectTabBar, { active: 'chat', onSelect: () => undefined }),
    );
    expect(screen.byTestId('usage-meter')).not.toBeNull();
    expect(screen.byTestId('usage-meter-session-fill')).toBeNull();
    screen.unmount();
  });
});

describe('decodeUsage', () => {
  it('accepts a well-formed reading', async () => {
    const { decodeUsage } = await import('../lib/usage-client');
    expect(decodeUsage({ available: true, session: 0.2, weekly: 0.4, measured_at: 7 })).toEqual({
      available: true,
      session: 0.2,
      weekly: 0.4,
      measured_at: 7,
    });
  });

  it('carries an unavailable reason through verbatim', async () => {
    const { decodeUsage } = await import('../lib/usage-client');
    expect(decodeUsage({ available: false, reason: 'no_credential' })).toEqual({
      available: false,
      reason: 'no_credential',
    });
  });

  it('refuses to build a bar out of a payload that is missing its numbers', async () => {
    const { decodeUsage } = await import('../lib/usage-client');
    // The failure mode this guards: coercing `undefined` to 0 and drawing an
    // empty bar, which asserts "0% used" from a payload that said nothing.
    for (const bad of [
      { available: true },
      { available: true, session: 0.2 },
      { available: true, session: '0.2', weekly: 0.4, measured_at: 7 },
      null,
      'nonsense',
    ]) {
      expect(decodeUsage(bad).available).toBe(false);
    }
  });
});
