/**
 * @neutronai/app — the light / dark / system preference, at the seam that decides it.
 *
 * Four things the owner can observe, and this file asserts all four by PRESSING the
 * real segmented control in Settings' `ThemeControl` and then reading the colour a
 * component actually received:
 *
 *   1. each of the three states resolves to the right palette;
 *   2. `system` FOLLOWS the OS scheme when it changes while the app is running;
 *   3. an explicit `light`/`dark` OVERRIDES the OS scheme rather than being
 *      shadowed by it;
 *   4. the choice survives a relaunch.
 *
 * WHY IT PRESSES, AND WHY IT READS A STYLE. Two failure shapes this repo has
 * already shipped. A test that calls `resolveTheme()` directly proves the pure
 * function is right and says nothing about whether the provider, the storage read
 * and the control are wired to it — the persona-gen shape, where a correct module
 * was never invoked. And a test that asserts on the rendered TREE cannot see
 * colour at all (CLAUDE.md rule 8): the header menu passed a tree-shaped test
 * while being invisible on a real device. So the probe below renders through the
 * SAME `useThemedStyles` path every screen uses, and the assertion is the resolved
 * `backgroundColor` on the DOM node — the value the owner's eye would land on.
 *
 * The OS scheme arrives through the provider's `osScheme` prop rather than through
 * `useColorScheme()`, because that hook reads a native module the harness cannot
 * drive. Re-rendering the provider with a new value is exactly what `Appearance`
 * does on the device, so the seam under test is the real one.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createElement } from 'react';

import {
  installNativeHarness,
  resetHarnessGlobals,
  setHarnessPlatform,
} from './support/native-harness';
// TYPE-ONLY, and therefore static: types are erased, so these cannot evaluate
// either module before `installNativeHarness()` has installed the aliases. Bun's
// transpiler also refuses `type` inside a destructuring pattern, so a dynamic
// import cannot carry them anyway.
import type { NeutronTheme, ResolvedTheme, ThemePreference } from '../lib/theme';
import type { ThemeBacking } from '../lib/theme-context';

installNativeHarness();
setHarnessPlatform('ios');

const { mountScreen } = await import('./support/mount');
const { ThemeControl } = await import('../components/ThemeControl');
const { ThemeProvider, useThemedStyles, __resetThemeBackingForTests, THEME_STORAGE_KEY } =
  await import('../lib/theme-context');
const { DARK_THEME, LIGHT_THEME } = await import('../lib/theme');
const { StyleSheet, Text, View } = await import('react-native');
// The harness's driveable OS-scheme seam. `react-native-web` implements no
// `useColorScheme`, so the stub provides one — see its docblock.
const { setHarnessColorScheme, colorSchemeListenerCount } = await import(
  './support/stubs/react-native'
);

beforeAll(installNativeHarness);
afterAll(() => {
  __resetThemeBackingForTests();
  resetHarnessGlobals();
});

/** A storage that behaves like the device's: async, and inspectable. */
class MemoryBacking implements ThemeBacking {
  readonly map = new Map<string, string>();
  constructor(seed?: string) {
    if (seed !== undefined) this.map.set(THEME_STORAGE_KEY, seed);
  }
  async getItem(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }
  async setItem(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }
}

/**
 * The probe. Builds its sheet through the ORDINARY `useThemedStyles` path — the
 * same call every one of the ~70 converted components makes — and then publishes
 * the RESOLVED `backgroundColor` so the test can read it.
 *
 * WHY IT PUBLISHES THE VALUE RATHER THAN THE TEST READING THE DOM. Under
 * react-native-web a `StyleSheet.create` style becomes a CSS CLASS, so
 * `element.style.backgroundColor` is the empty string and a test that read it
 * would measure nothing while looking like it measured something — the exact
 * false-green shape rule 8 warns about, one level down. `StyleSheet.flatten` is
 * the supported way to ask what a style actually resolved to, so the assertion is
 * on the colour the renderer was handed, not on the shape of the tree.
 */
const makeProbeStyles = (theme: NeutronTheme) =>
  StyleSheet.create({ page: { backgroundColor: theme.background } });

function Probe() {
  const styles = useThemedStyles(makeProbeStyles);
  const resolved = StyleSheet.flatten(styles.page) as { backgroundColor?: string };
  return createElement(
    View,
    { style: styles.page, testID: 'theme-probe' },
    createElement(Text, { testID: 'theme-probe-value' }, resolved.backgroundColor ?? ''),
  );
}

/** The colour the probe's sheet actually resolved to. */
function paintedBackground(screen: { byTestId(id: string): HTMLElement | null }): string {
  const el = screen.byTestId('theme-probe-value');
  if (el === null) throw new Error('the probe never rendered — nothing to measure');
  const value = (el.textContent ?? '').trim();
  if (value === '') throw new Error('the probe rendered with NO background colour');
  return value.toLowerCase();
}

function themedTree(backing: ThemeBacking, osScheme: ResolvedTheme | null) {
  // `children` goes in the props object rather than as variadic arguments: the
  // provider declares it required, and TS's variadic `createElement` overload does
  // not satisfy a required `children` prop.
  return createElement(ThemeProvider, {
    backing,
    osScheme,
    children: [createElement(ThemeControl, { key: 'control' }), createElement(Probe, { key: 'probe' })],
  });
}

/** A mounted tree that can be handed a NEW OS scheme in place, the way the device
 *  hands one to a running app. */
async function mountThemed(opts: { backing: ThemeBacking; osScheme?: ResolvedTheme | null }) {
  const screen = await mountScreen(themedTree(opts.backing, opts.osScheme ?? null));
  return {
    ...screen,
    async setOsScheme(next: ResolvedTheme | null): Promise<void> {
      await screen.rerender(themedTree(opts.backing, next));
    },
  };
}

describe('the three preference states resolve at the real selection seam', () => {
  it('pressing Light paints the LIGHT palette, even while the OS says dark', async () => {
    // Point 3: an explicit choice is an OVERRIDE. The OS is dark throughout.
    const backing = new MemoryBacking();
    const screen = await mountThemed({ backing, osScheme: 'dark' });
    expect(paintedBackground(screen)).toBe(DARK_THEME.background);

    await screen.press('Theme Light');
    expect(paintedBackground(screen)).toBe(LIGHT_THEME.background);

    screen.unmount();
  });

  it('pressing Dark paints the DARK palette, even while the OS says light', async () => {
    const backing = new MemoryBacking();
    const screen = await mountThemed({ backing, osScheme: 'light' });
    // Default preference is `system`, so it starts by following the OS.
    expect(paintedBackground(screen)).toBe(LIGHT_THEME.background);

    await screen.press('Theme Dark');
    expect(paintedBackground(screen)).toBe(DARK_THEME.background);

    screen.unmount();
  });

  it('System follows the OS — and keeps following it when it CHANGES', async () => {
    // Point 2, and the assertion a launch-time-only read would fail. The app is
    // already mounted and showing light; the OS flips underneath it.
    const backing = new MemoryBacking();
    const screen = await mountThemed({ backing, osScheme: 'light' });
    await screen.press('Theme System');
    expect(paintedBackground(screen)).toBe(LIGHT_THEME.background);

    await screen.setOsScheme('dark');
    expect(paintedBackground(screen)).toBe(DARK_THEME.background);

    await screen.setOsScheme('light');
    expect(paintedBackground(screen)).toBe(LIGHT_THEME.background);

    screen.unmount();
  });

  it('an explicit choice is NOT shadowed by a later OS change', async () => {
    // The other half of point 3: once overridden, the OS is irrelevant. A naive
    // implementation that re-resolves from the OS on every change breaks here and
    // nowhere else.
    const backing = new MemoryBacking();
    const screen = await mountThemed({ backing, osScheme: 'dark' });
    await screen.press('Theme Light');
    expect(paintedBackground(screen)).toBe(LIGHT_THEME.background);

    await screen.setOsScheme('dark');
    expect(paintedBackground(screen)).toBe(LIGHT_THEME.background);

    screen.unmount();
  });
});

describe('the choice survives a relaunch', () => {
  it('a preference pressed in one session is what the next session paints', async () => {
    // Point 4. The relaunch is simulated the way a relaunch actually works: the
    // React tree is destroyed and rebuilt, while the STORAGE persists. Sharing the
    // backing across the two mounts is the whole point — a provider that kept the
    // preference only in component state passes every test above and fails this.
    const backing = new MemoryBacking();

    const first = await mountThemed({ backing, osScheme: 'dark' });
    await first.press('Theme Light');
    expect(paintedBackground(first)).toBe(LIGHT_THEME.background);
    first.unmount();

    expect(backing.map.get(THEME_STORAGE_KEY)).toBe('light');

    const second = await mountThemed({ backing, osScheme: 'dark' });
    expect(paintedBackground(second)).toBe(LIGHT_THEME.background);
    second.unmount();
  });

  it('returning to System is a RECORDED choice, not the absence of one', async () => {
    // Otherwise "go back to following my device" would be indistinguishable from
    // "never chose", which is fine today and stops being fine the moment the
    // default changes.
    const backing = new MemoryBacking('dark');
    const screen = await mountThemed({ backing, osScheme: 'light' });
    expect(paintedBackground(screen)).toBe(DARK_THEME.background);

    await screen.press('Theme System');
    expect(backing.map.get(THEME_STORAGE_KEY)).toBe('system');
    expect(paintedBackground(screen)).toBe(LIGHT_THEME.background);

    screen.unmount();
  });

  it('a corrupt stored value degrades to System instead of throwing', async () => {
    const backing = new MemoryBacking('chartreuse');
    const screen = await mountThemed({ backing, osScheme: 'light' });
    expect(paintedBackground(screen)).toBe(LIGHT_THEME.background);
    screen.unmount();
  });

  it('a storage that THROWS still lets the owner change the theme', async () => {
    // A read failure must not be able to swallow the choice — the control applies
    // first and persists second, so a broken store costs persistence and nothing
    // else.
    const broken: ThemeBacking = {
      getItem() {
        throw new Error('storage unavailable');
      },
      setItem() {
        throw new Error('storage unavailable');
      },
    };
    const screen = await mountThemed({ backing: broken, osScheme: 'dark' });
    await screen.press('Theme Light');
    expect(paintedBackground(screen)).toBe(LIGHT_THEME.background);
    screen.unmount();
  });
});

describe('the PRODUCTION OS seam, with no test-only prop in the way', () => {
  // Everything above hands the provider an `osScheme` prop. That proves the
  // resolution RULE and, on its own, proves nothing about whether the app is
  // subscribed to the device at all: with the prop as the only seam, deleting
  // `useOsColorScheme()` from the provider leaves all ten of those tests green.
  //
  // So these mount with NO `osScheme` at all, which forces the provider down its
  // real path — `require('react-native').useColorScheme`, resolved at module
  // scope. The harness's `react-native` stub implements that hook as a genuine
  // subscription (react-native-web does not implement it at all), so the thing
  // under test here is the wiring, not the arithmetic.

  function productionTree(backing: ThemeBacking) {
    // No `osScheme` key AT ALL — not `osScheme: null`, which is a value the
    // provider would prefer over the hook and would put the prop back in the path.
    return createElement(ThemeProvider, {
      backing,
      children: [createElement(ThemeControl, { key: 'control' }), createElement(Probe, { key: 'probe' })],
    });
  }

  it('the provider SUBSCRIBES to the OS scheme', async () => {
    // The wiring assertion, stated as a count rather than as an appearance. A
    // provider that read the scheme once at launch, or not at all, leaves this 0
    // while still painting a perfectly plausible theme.
    expect(colorSchemeListenerCount()).toBe(0);
    setHarnessColorScheme('dark');
    const backing = new MemoryBacking();
    const screen = await mountScreen(productionTree(backing));
    expect(colorSchemeListenerCount()).toBeGreaterThan(0);
    screen.unmount();
    // ...and unsubscribes, so the subscription is not a leak per mount.
    expect(colorSchemeListenerCount()).toBe(0);
  });

  it('`system` paints what the OS reports, through the real hook', async () => {
    setHarnessColorScheme('light');
    const backing = new MemoryBacking('system');
    const screen = await mountScreen(productionTree(backing));
    expect(paintedBackground(screen)).toBe(LIGHT_THEME.background);
    screen.unmount();

    setHarnessColorScheme('dark');
    const second = await mountScreen(productionTree(backing));
    expect(paintedBackground(second)).toBe(DARK_THEME.background);
    second.unmount();
  });

  it('a LIVE OS flip re-themes the running app', async () => {
    // The requirement the brief called out: `system` must track the OS while the
    // app is FOREGROUNDED, not only at launch. Nothing re-renders here except the
    // OS notification itself.
    setHarnessColorScheme('light');
    const backing = new MemoryBacking('system');
    const screen = await mountScreen(productionTree(backing));
    expect(paintedBackground(screen)).toBe(LIGHT_THEME.background);

    await screen.act(() => {
      setHarnessColorScheme('dark');
    });
    expect(paintedBackground(screen)).toBe(DARK_THEME.background);

    await screen.act(() => {
      setHarnessColorScheme('light');
    });
    expect(paintedBackground(screen)).toBe(LIGHT_THEME.background);
    screen.unmount();
  });

  it('an explicit choice still wins over the real hook', async () => {
    // The override, on the production path this time. A provider that resolved
    // from the OS hook unconditionally passes every `system` test above and fails
    // exactly here.
    setHarnessColorScheme('dark');
    const backing = new MemoryBacking();
    const screen = await mountScreen(productionTree(backing));
    expect(paintedBackground(screen)).toBe(DARK_THEME.background);

    await screen.press('Theme Light');
    expect(paintedBackground(screen)).toBe(LIGHT_THEME.background);

    // The OS flips again; the override holds.
    await screen.act(() => {
      setHarnessColorScheme('dark');
    });
    expect(paintedBackground(screen)).toBe(LIGHT_THEME.background);
    screen.unmount();
  });

  it('an OS that reports NOTHING resolves to dark rather than to a guess', async () => {
    setHarnessColorScheme(null);
    const backing = new MemoryBacking('system');
    const screen = await mountScreen(productionTree(backing));
    expect(paintedBackground(screen)).toBe(DARK_THEME.background);
    screen.unmount();
  });
});

describe('the control is REACHABLE, not merely rendered', () => {
  it('all three segments take a real press', async () => {
    // `press()` throws when a control is absent OR disabled, so this is a
    // reachability assertion rather than a presence one.
    const backing = new MemoryBacking();
    const screen = await mountThemed({ backing, osScheme: 'dark' });
    const order: ThemePreference[] = ['light', 'dark', 'system'];
    for (const pref of order) {
      const label = pref === 'system' ? 'System' : pref === 'light' ? 'Light' : 'Dark';
      await screen.press(`Theme ${label}`);
      expect(backing.map.get(THEME_STORAGE_KEY)).toBe(pref);
    }
    screen.unmount();
  });

  it('names the resolved scheme while following the device', async () => {
    // The label is the only thing that tells the owner WHAT "System" currently
    // means, so it is part of the feature, not decoration.
    const backing = new MemoryBacking('system');
    const screen = await mountThemed({ backing, osScheme: 'light' });
    expect(screen.text()).toContain('System (light)');
    screen.unmount();
  });
});
