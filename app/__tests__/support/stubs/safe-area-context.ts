/**
 * @neutronai/app — harness stub for `react-native-safe-area-context`.
 *
 * The real package reads its insets from a native module through a React
 * context that `expo-router`'s `ExpoRoot` installs (`SafeAreaProvider`, see
 * `app/node_modules/expo-router/build/ExpoRoot.js`). Neither exists under bun,
 * and v5's `useSafeAreaInsets` THROWS when no provider is above it — so without
 * this stub every harness-mounted screen that respects the safe area dies at
 * first render.
 *
 * The insets are SETTABLE, which is the point: the composer must clear the home
 * indicator with the keyboard down and must NOT add it again with the keyboard
 * up, and the only way to assert both is to drive a non-zero bottom inset.
 * Defaults to an iPhone-with-a-notch shape, because a zero-inset default would
 * make an inset regression invisible.
 */

export interface EdgeInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** iPhone 15 portrait: 59pt status bar / Dynamic Island, 34pt home indicator. */
export const HARNESS_SAFE_AREA_TOP = 59;
export const HARNESS_SAFE_AREA_BOTTOM = 34;

let insets: EdgeInsets = {
  top: HARNESS_SAFE_AREA_TOP,
  right: 0,
  bottom: HARNESS_SAFE_AREA_BOTTOM,
  left: 0,
};

/** Drive a different device shape (or a tablet's zero bottom inset). */
export function setHarnessSafeAreaInsets(next: Partial<EdgeInsets>): void {
  insets = { ...insets, ...next };
}

/** Back to the default iPhone shape. Call in `afterEach` if a test changed it. */
export function resetHarnessSafeAreaInsets(): void {
  insets = {
    top: HARNESS_SAFE_AREA_TOP,
    right: 0,
    bottom: HARNESS_SAFE_AREA_BOTTOM,
    left: 0,
  };
}

export function useSafeAreaInsets(): EdgeInsets {
  return insets;
}

export function useSafeAreaFrame(): { x: number; y: number; width: number; height: number } {
  return { x: 0, y: 0, width: 393, height: 852 };
}

/** Inert pass-throughs — the harness never needs the real provider behaviour. */
export function SafeAreaProvider({ children }: { children?: unknown }): unknown {
  return children ?? null;
}
export function SafeAreaView({ children }: { children?: unknown }): unknown {
  return children ?? null;
}
export const initialWindowMetrics = null;
