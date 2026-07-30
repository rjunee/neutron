/**
 * @neutronai/app — the harness must not be silently degraded.
 *
 * A test harness that quietly stops mounting anything is worse than no harness:
 * every suite built on it goes green for the wrong reason. This file asserts the
 * harness's own preconditions, so a broken alias, a missing DOM, or another test
 * file capturing the `react-native` specifier fails HERE with a clear cause
 * instead of turning the device suites into no-ops.
 */

import { afterAll, describe, expect, it } from 'bun:test';
import { createElement } from 'react';

import {
  HARNESS_SCREEN_HEIGHT,
  installNativeHarness,
  setHarnessPlatform,
  resetHarnessGlobals,
  withoutWebCrypto,
} from './support/native-harness';

installNativeHarness();

// IMPORT THE STUB BY PATH, NOT the bare `react-native` specifier. The bare
// specifier is contested: other app tests own it with process-global
// `mock.module('react-native', …)` fakes, and Bun runs many test files per
// process. The harness deliberately does not fight for that specifier — it
// rewrites the app's own source imports to this path instead — so this is the
// module the code under test actually receives, and therefore the one worth
// asserting on. (Asserting the bare specifier would test another file's fake.)
const RN = await import('./support/stubs/react-native');
const { mountScreen } = await import('./support/mount');

afterAll(() => {
  resetHarnessGlobals();
});

describe('native harness preconditions', () => {
  it('has a DOM to render into', () => {
    expect(typeof document).toBe('object');
    expect(typeof document.createElement).toBe('function');
  });

  it('resolves react-native to a COMPLETE surface, not another test file’s fake', () => {
    // The exports a real component tree links against. `AppState` is named
    // explicitly: a three-export `mock.module('react-native', …)` fake from a
    // neighbouring test file omitted it, and that is how order-dependent breakage
    // announced itself.
    for (const name of ['View', 'Text', 'Pressable', 'TextInput', 'AppState', 'Keyboard', 'Platform']) {
      expect(RN[name as keyof typeof RN], `react-native.${name} is missing`).toBeDefined();
    }
  });

  it('reports a phone platform, so ios-only branches execute', () => {
    setHarnessPlatform('ios');
    expect(RN.Platform.OS).toBe('ios');
    setHarnessPlatform('web');
    expect(RN.Platform.OS).toBe('web');
    setHarnessPlatform('ios');
  });

  it('measures a real viewport (layout assertions would be vacuous at 0×0)', async () => {
    const screen = await mountScreen(createElement(RN.View, { style: { flex: 1 } }));
    const node = screen.host.querySelector('div');
    expect(node).not.toBeNull();
    expect(node?.getBoundingClientRect().bottom).toBe(HARNESS_SCREEN_HEIGHT);
    screen.unmount();
  });

  it('can remove WebCrypto and put it back', () => {
    expect(globalThis.crypto).toBeDefined();
    const restore = withoutWebCrypto();
    expect(globalThis.crypto).toBeUndefined();
    restore();
    expect(globalThis.crypto).toBeDefined();
  });

  it('mounts a real component and renders its text', async () => {
    const screen = await mountScreen(
      createElement(RN.View, null, createElement(RN.Text, null, 'harness is alive')),
    );
    expect(screen.text()).toContain('harness is alive');
    screen.unmount();
  });
});
