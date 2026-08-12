/**
 * `react-native` → `react-native-web`, plus the few things RNW does not provide.
 *
 * Loaded via the module alias in `../native-harness.ts`; never imported directly
 * by a test.
 */

import { useEffect, useState } from 'react';
import { Platform as WebPlatform } from 'react-native-web';

export * from 'react-native-web';
export { default } from 'react-native-web';

/**
 * `Platform.OS` is `'web'` under react-native-web, but the code under test
 * branches on `'ios'` / `'android'` in the places device bugs actually live —
 * including the keyboard behaviour that shipped broken. The harness sets
 * `__HARNESS_OS__` before mounting so those branches execute.
 */
export const Platform = {
  ...WebPlatform,
  get OS(): string {
    return (globalThis as { __HARNESS_OS__?: string }).__HARNESS_OS__ ?? 'web';
  },
  select<T>(spec: Record<string, T>): T | undefined {
    const os = (globalThis as { __HARNESS_OS__?: string }).__HARNESS_OS__ ?? 'web';
    if (os in spec) return spec[os];
    if ('native' in spec && os !== 'web') return spec['native'];
    return spec['default'];
  },
};

/** RN keyboard event names the app subscribes to. */
export type HarnessKeyboardEvent =
  | 'keyboardWillChangeFrame'
  | 'keyboardWillHide'
  | 'keyboardDidShow'
  | 'keyboardDidHide';

interface KeyboardListener {
  event: HarnessKeyboardEvent;
  fn: (payload: { endCoordinates: { screenY: number; height: number } }) => void;
}

const keyboardListeners = new Set<KeyboardListener>();

/**
 * `Keyboard`, with a driveable event bus. react-native-web ships a `Keyboard`
 * whose listeners never fire (a browser has no soft keyboard), so subscribing to
 * the real one would make every keyboard assertion vacuously green.
 */
export const Keyboard = {
  addListener(event: HarnessKeyboardEvent, fn: KeyboardListener['fn']): { remove: () => void } {
    const entry: KeyboardListener = { event, fn };
    keyboardListeners.add(entry);
    return {
      remove: (): void => {
        keyboardListeners.delete(entry);
      },
    };
  },
  dismiss(): void {
    emitKeyboard('keyboardWillHide', 0);
  },
  isVisible(): boolean {
    return false;
  },
};

/** Fire a keyboard event at whatever is currently subscribed. */
export function emitKeyboard(event: HarnessKeyboardEvent, screenY: number, height = 0): void {
  for (const l of [...keyboardListeners]) {
    if (l.event === event) l.fn({ endCoordinates: { screenY, height } });
  }
}

/** How many keyboard listeners are live — lets a test assert unsubscribe. */
export function keyboardListenerCount(): number {
  return keyboardListeners.size;
}

/**
 * `useColorScheme` — THE OS SCHEME, DRIVEABLE.
 *
 * react-native-web does not implement this hook at all (grep it: there is no
 * `useColorScheme` anywhere in `react-native-web/dist`). So without this, the
 * theme provider's PRODUCTION path — `require('react-native').useColorScheme`,
 * resolved at module scope in `lib/theme-context.tsx` — finds nothing and degrades
 * to `() => null`, and every theming test has to inject the scheme through the
 * provider's test-only `osScheme` prop instead.
 *
 * That is the gap this closes, and it is the one Argus named: with the prop as the
 * ONLY seam, deleting `useOsColorScheme()` from the provider left all ten theme
 * tests green — the tests proved the resolution rule and said nothing about
 * whether the app is subscribed to the device. Same shape as `Keyboard` above,
 * whose react-native-web listeners never fire and would make every keyboard
 * assertion vacuously true.
 *
 * A REAL SUBSCRIPTION, not a value read once: `Appearance` re-renders subscribers
 * when the OS flips, and `system` following a LIVE change is a requirement, so a
 * stub that only returned a value could not tell a correct implementation from one
 * that reads the scheme at launch.
 */
type ColorSchemeName = 'light' | 'dark' | null;

let harnessColorScheme: ColorSchemeName = null;
const colorSchemeListeners = new Set<(next: ColorSchemeName) => void>();

export function useColorScheme(): ColorSchemeName {
  const [scheme, setScheme] = useState<ColorSchemeName>(harnessColorScheme);
  useEffect(() => {
    const fn = (next: ColorSchemeName): void => setScheme(next);
    colorSchemeListeners.add(fn);
    // Re-sync on subscribe: the value may have moved between render and effect.
    setScheme(harnessColorScheme);
    return () => {
      colorSchemeListeners.delete(fn);
    };
  }, []);
  return scheme;
}

/** Set what the "OS" reports, and notify live subscribers — what `Appearance`
 *  does when the device theme changes under a running app. */
export function setHarnessColorScheme(next: ColorSchemeName): void {
  harnessColorScheme = next;
  for (const fn of [...colorSchemeListeners]) fn(next);
}

/** How many components are subscribed to the OS scheme. A provider that never
 *  called the hook would leave this at 0 — which is the assertion that makes the
 *  production seam testable at all. */
export function colorSchemeListenerCount(): number {
  return colorSchemeListeners.size;
}

/** RN-only escape hatches react-native-web does not implement. */
export const TurboModuleRegistry = {
  get: (): null => null,
  getEnforcing: (name: string): never => {
    throw new Error(`native module "${name}" is unavailable in the JS harness`);
  },
};
export function requireNativeComponent(name: string): string {
  return name;
}
