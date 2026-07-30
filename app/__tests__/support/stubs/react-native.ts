/**
 * `react-native` → `react-native-web`, plus the few things RNW does not provide.
 *
 * Loaded via the module alias in `../native-harness.ts`; never imported directly
 * by a test.
 */

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
