/**
 * @neutronai/app — the theme toggle is reachable THROUGH SETTINGS, not just mountable.
 *
 * `theme-preference.test.tsx` mounts `ThemeControl` DIRECTLY. Every one of its
 * assertions is about the control's behaviour, and all of them stay green if the
 * `<ThemeControl />` call site in `app/settings.tsx` is deleted — the component
 * would be perfect, tested, and unreachable. That is the persona-gen shape
 * exactly: a correct module that nothing invokes (`CLAUDE.md`, "Exists ≠ wired"),
 * and this repo has shipped it before.
 *
 * So this file mounts the REAL Settings route and presses the segmented control
 * through it, then reads the colour a component actually resolved. Three things
 * have to be true at once for it to pass, and each is a separate way the feature
 * could be broken while looking fine:
 *
 *   1. Settings RENDERS the control (delete the call site → the press throws);
 *   2. the control is ENABLED and hittable there (`press` refuses a disabled or
 *      absent target, so this is reachability, not presence);
 *   3. pressing it changes the PALETTE a sibling component receives — i.e. it is
 *      wired to the provider that actually paints the app, not to local state.
 *
 * WHY IT ASSERTS A RESOLVED COLOUR AND NOT THE TREE. `CLAUDE.md` rule 8: a
 * tree-shaped test cannot see layout or colour, and on this repo's own record one
 * passed while the control was invisible on a device. The probe below reads
 * `StyleSheet.flatten`, which is the value the renderer was handed.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { createElement } from 'react';

import {
  installNativeHarness,
  resetHarnessGlobals,
  setHarnessPlatform,
} from './support/native-harness';
import type { NeutronTheme } from '../lib/theme';
import type { ThemeBacking } from '../lib/theme-context';

installNativeHarness();
setHarnessPlatform('ios');

const { mountScreen } = await import('./support/mount');
const { installRouting, resetRouting } = await import('./support/stubs/expo-router');
const { setRuntimeServerConfig, __resetServerConfigForTests } = await import('../lib/config');
const { AuthSessionProvider } = await import('../lib/session');
const {
  ThemeProvider,
  useThemedStyles,
  buildStyles,
  THEME_STORAGE_KEY,
  __resetThemeBackingForTests,
} = await import('../lib/theme-context');
const { DARK_THEME, LIGHT_THEME, DARK_PALETTE, LIGHT_PALETTE } = await import('../lib/theme');
const { StyleSheet, Text, View } = await import('react-native');

const settingsModule = await import('../app/settings');
const SettingsScreen = settingsModule.default;
const makeSettingsStyles = settingsModule.makeStyles;

const OWNER = {
  id: 'harness-owner',
  email: 'owner@example.test',
  displayName: 'Harness Owner',
  provider: 'dev' as const,
  token: 'harness-token',
};
const BASE_URL = 'https://harness.example.test';

let realFetch: typeof fetch;

beforeAll(() => {
  installNativeHarness();
  // No route table: nothing here navigates. The path only has to be `/settings`
  // so the screen behaves as the route it is.
  installRouting({ path: '/settings', routes: {} });
  realFetch = globalThis.fetch;
  setRuntimeServerConfig({ gateway_base_url: BASE_URL, auth_base_url: null });
  // Settings mounts the voice-transcription card, which fetches its status on
  // mount and DEREFERENCES the response (`job.phase`) — a bare `{ ok: true }`
  // crashes the whole screen, taking the appearance control with it. So the stub
  // answers with the real SHAPE. Nothing here asserts on that pane; it just has to
  // render, because a screen that throws has no reachable controls at all and the
  // failure would read as "the toggle is missing".
  globalThis.fetch = (async () =>
    Response.json({
      ok: true,
      backend: 'local',
      local_available: false,
      openai_key: { present: false, source: null },
      installed: false,
      model_id: null,
      installed_bytes: 0,
      binary_downloadable: false,
      binary_present: false,
      whisper_version: 'harness',
      default_model_id: 'base',
      models: [],
      job: null,
    })) as unknown as typeof fetch;
});

afterEach(resetRouting);

afterAll(() => {
  globalThis.fetch = realFetch;
  __resetServerConfigForTests();
  __resetThemeBackingForTests();
  resetHarnessGlobals();
});

class MemoryBacking implements ThemeBacking {
  readonly map = new Map<string, string>();
  async getItem(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }
  async setItem(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }
}

/** Reads the palette through the SAME hook the ~70 converted components use, and
 *  publishes the resolved colour so the assertion is a measurement. */
const makeProbeStyles = (theme: NeutronTheme) =>
  StyleSheet.create({ page: { backgroundColor: theme.background } });

function Probe() {
  const styles = useThemedStyles(makeProbeStyles);
  const resolved = StyleSheet.flatten(styles.page) as { backgroundColor?: string };
  return createElement(
    View,
    { style: styles.page, testID: 'settings-theme-probe' },
    createElement(Text, { testID: 'settings-theme-probe-value' }, resolved.backgroundColor ?? ''),
  );
}

function paintedBackground(screen: { byTestId(id: string): HTMLElement | null }): string {
  const el = screen.byTestId('settings-theme-probe-value');
  if (el === null) throw new Error('the probe never rendered — nothing to measure');
  const value = (el.textContent ?? '').trim();
  if (value === '') throw new Error('the probe rendered with NO background colour');
  return value.toLowerCase();
}

/** The real Settings route, under the providers the app gives it, with the probe
 *  as a SIBLING — so what it measures is the shared provider state and not
 *  something Settings handed it. */
async function mountSettings(backing: ThemeBacking) {
  return mountScreen(
    createElement(ThemeProvider, {
      backing,
      osScheme: 'dark',
      children: createElement(AuthSessionProvider, {
        // `initialUser`, which also puts the session straight into `ready` — Settings
        // renders NOTHING while the session is hydrating, so a wrong prop name here
        // produced an empty screen rather than an error.
        initialUser: OWNER,
        children: createElement(
          View,
          null,
          createElement(SettingsScreen, { key: 'settings' }),
          createElement(Probe, { key: 'probe' }),
        ),
      }),
    }),
  );
}

describe('the appearance control is reachable from the Settings screen', () => {
  it('Settings renders it, and pressing Light through Settings repaints the app', async () => {
    const backing = new MemoryBacking();
    const screen = await mountSettings(backing);

    // Starts dark: preference is unset, so `system` follows the OS, which is dark.
    // The positive control: Settings really rendered, so a press that finds no
    // control below means the control is missing rather than the screen being empty.
    expect(screen.text()).toContain('Appearance');
    expect(paintedBackground(screen)).toBe(DARK_THEME.background);

    // THE ASSERTION THAT CATCHES A DELETED CALL SITE. `press` throws when no
    // control carries the label, so if `<ThemeControl />` is removed from
    // `app/settings.tsx` this line fails with "no control labelled ... is in the
    // tree" — which is the failure mode the direct-mount tests cannot produce.
    await screen.press('Theme Light');
    expect(paintedBackground(screen)).toBe(LIGHT_THEME.background);

    // ...and it went through the real provider, so it PERSISTED too.
    expect(backing.map.get(THEME_STORAGE_KEY)).toBe('light');

    screen.unmount();
  });

  it('all three segments are hittable from Settings', async () => {
    // Reachability for each state, not only the one the happy path uses. A
    // segmented control whose middle option is covered by another view presses
    // fine in isolation and not here.
    const backing = new MemoryBacking();
    const screen = await mountSettings(backing);

    await screen.press('Theme Dark');
    expect(paintedBackground(screen)).toBe(DARK_THEME.background);
    expect(backing.map.get(THEME_STORAGE_KEY)).toBe('dark');

    await screen.press('Theme Light');
    expect(paintedBackground(screen)).toBe(LIGHT_THEME.background);

    await screen.press('Theme System');
    // `system` with a dark OS resolves back to dark.
    expect(paintedBackground(screen)).toBe(DARK_THEME.background);
    expect(backing.map.get(THEME_STORAGE_KEY)).toBe('system');

    screen.unmount();
  });

  it("Settings' OWN sheet resolves differently in the two palettes", () => {
    // The other half of "light mode works": the SCREEN carrying the control has to
    // change too. A screen that stayed dark around a light toggle would be the most
    // obvious possible version of the one-missed-component bug, and the press tests
    // above cannot see it — they measure a sibling probe.
    //
    // Built from each palette rather than read off the DOM, because under
    // react-native-web a `StyleSheet.create` style becomes a CSS CLASS: reading
    // `element.style.backgroundColor` returns the empty string, so a DOM-reading
    // version of this test would measure nothing while looking like it measured
    // something. `buildStyles` is the same factory the component calls.
    const dark = buildStyles(makeSettingsStyles, DARK_PALETTE) as Record<
      string,
      Record<string, unknown>
    >;
    const light = buildStyles(makeSettingsStyles, LIGHT_PALETTE) as Record<
      string,
      Record<string, unknown>
    >;

    const darkFlat = StyleSheet.flatten(dark['container']) as { backgroundColor?: string };
    const lightFlat = StyleSheet.flatten(light['container']) as { backgroundColor?: string };
    expect(darkFlat.backgroundColor?.toLowerCase()).toBe(DARK_THEME.background);
    expect(lightFlat.backgroundColor?.toLowerCase()).toBe(LIGHT_THEME.background);

    // And it is not ONE key that follows the theme while the rest are pinned: every
    // colour-bearing key in the sheet has to differ between the palettes. This is
    // the assertion that would have caught the docs viewer, whose container WAS
    // themed while its text was a literal.
    const colourKeys = Object.keys(dark).filter((k) => {
      const d = StyleSheet.flatten(dark[k]) as Record<string, unknown>;
      return typeof d['color'] === 'string' || typeof d['backgroundColor'] === 'string';
    });
    expect(colourKeys.length, 'the sheet must actually carry colours').toBeGreaterThan(5);
    const pinned = colourKeys.filter((k) => {
      const d = StyleSheet.flatten(dark[k]) as Record<string, unknown>;
      const l = StyleSheet.flatten(light[k]) as Record<string, unknown>;
      for (const prop of ['color', 'backgroundColor'] as const) {
        if (typeof d[prop] === 'string' && d[prop] === l[prop]) return true;
      }
      return false;
    });
    expect(
      pinned,
      `these Settings styles are the SAME colour in both palettes:\n${pinned.join('\n')}`,
    ).toEqual([]);
  });
});
