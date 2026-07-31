/**
 * @neutronai/app — `useKeyboardInset`: the react-native half of the keyboard
 * inset. The arithmetic (and the reason `KeyboardAvoidingView` could not do this
 * job) lives in `keyboard-inset.ts`; this file is only the wiring.
 *
 * SHAPE. Attach `containerRef` to a view that is NEVER itself padded by the
 * result — otherwise the padding changes the measurement that produced it and
 * the two oscillate. Apply `inset` as `paddingBottom` on a CHILD of that view.
 *
 * EVENTS. iOS gets `keyboardWillChangeFrame`, which fires for show, hide, height
 * changes (autocomplete bar, emoji switch) and interactive dismissal, and which
 * lands before the animation so the lift is in step with the keyboard rather
 * than a frame behind it. Android has no `will*` events, so it gets
 * `keyboardDidShow` / `keyboardDidHide`.
 *
 * TWO PLATFORMS, TWO SOURCES — and this is the whole correction of 2026-07-31.
 * iOS uses the measured window-space overlap (`screenY` vs `measureInWindow`).
 * Android CANNOT: those two numbers are a status-bar height apart on Android, so
 * the subtraction under-padded and the composer stayed behind the keyboard.
 * Android instead uses the keyboard's own reported HEIGHT plus the bottom
 * safe-area inset, which is one OS quantity and no cross-space arithmetic. The
 * derivation, with the RN source lines it was read from, is in
 * `keyboard-inset.ts` on `androidKeyboardInset`.
 *
 * The three seams (`subscribe`, `measure`, `platform`) are parameters with real
 * defaults so the wiring is assertable off-device: a test drives fake keyboard
 * events and a fake measurement and checks the inset it produces on either
 * platform.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Keyboard, Platform, type View } from 'react-native';

import { androidKeyboardInset, keyboardOverlap } from './keyboard-inset';

/** What a keyboard event tells us about the keyboard's geometry. */
export interface KeyboardGeometry {
  /** Window-space top edge — RN's `endCoordinates.screenY`. */
  screenY: number;
  /** Keyboard height — RN's `endCoordinates.height`. */
  height: number;
}

/** Keyboard geometry, or `null` when the keyboard is gone. */
export type KeyboardTopListener = (geometry: KeyboardGeometry | null) => void;

/** Subscribe to keyboard geometry. Returns an unsubscribe. */
export type KeyboardSubscribe = (listener: KeyboardTopListener) => () => void;

/** Measure the container's window-space bottom edge, async (RN's API is a
 *  callback). `null` when there is nothing measurable yet. */
export type MeasureContainerBottom = (cb: (bottomY: number | null) => void) => void;

/** The real RN keyboard subscription. */
export const subscribeToKeyboard: KeyboardSubscribe = (listener) => {
  const isIos = Platform.OS === 'ios';
  const subs = isIos
    ? [
        Keyboard.addListener('keyboardWillChangeFrame', (e) => {
          listener({ screenY: e.endCoordinates.screenY, height: e.endCoordinates.height });
        }),
        Keyboard.addListener('keyboardWillHide', () => {
          listener(null);
        }),
      ]
    : [
        Keyboard.addListener('keyboardDidShow', (e) => {
          listener({ screenY: e.endCoordinates.screenY, height: e.endCoordinates.height });
        }),
        Keyboard.addListener('keyboardDidHide', () => {
          listener(null);
        }),
      ];
  return () => {
    for (const s of subs) s.remove();
  };
};

export interface UseKeyboardInsetResult {
  /** Bottom padding the surface needs right now, in points. */
  inset: number;
  /** Attach to the view that must NOT receive the padding (see the header). */
  containerRef: React.RefObject<View | null>;
}

export interface UseKeyboardInsetOptions {
  /** Injectable for tests. Defaults to the real RN keyboard events. */
  subscribe?: KeyboardSubscribe;
  /** Injectable for tests. Defaults to `containerRef.measureInWindow`. */
  measure?: MeasureContainerBottom;
  /**
   * `useSafeAreaInsets().bottom`. Android adds it back to the keyboard height
   * (RN reports the keyboard net of the navigation bar it covers); iOS ignores
   * it, because the measured overlap already spans the home indicator.
   */
  safeAreaBottom?: number;
  /** Injectable for tests. Defaults to `Platform.OS`. */
  platform?: string;
}

export function useKeyboardInset(opts: UseKeyboardInsetOptions = {}): UseKeyboardInsetResult {
  const containerRef = useRef<View | null>(null);
  // Two states, one per platform strategy. Android's is the keyboard geometry
  // the OS reported (a pure render derives the inset from it, so a changing
  // safe-area inset is picked up without re-subscribing); iOS's is the result of
  // an ASYNC measurement, which cannot be derived during render.
  const [geometry, setGeometry] = useState<KeyboardGeometry | null>(null);
  const [measuredInset, setMeasuredInset] = useState(0);

  const measureViaRef = useCallback<MeasureContainerBottom>((cb) => {
    const node = containerRef.current;
    if (node === null || typeof node.measureInWindow !== 'function') {
      cb(null);
      return;
    }
    node.measureInWindow((_x, y, _w, height) => {
      cb(y + height);
    });
  }, []);

  const subscribe = opts.subscribe ?? subscribeToKeyboard;
  const measure = opts.measure ?? measureViaRef;
  const safeAreaBottom = opts.safeAreaBottom ?? 0;
  const platform = opts.platform ?? Platform.OS;
  // Android's `measureInWindow` is offset by the status bar relative to the
  // keyboard's `screenY`, so the window-space subtraction is unavailable there.
  const measuresWindowSpace = platform !== 'android';

  useEffect(() => {
    let disposed = false;
    const unsubscribe = subscribe((next) => {
      if (disposed) return;
      if (!measuresWindowSpace) {
        setGeometry(next);
        return;
      }
      if (next === null) {
        setMeasuredInset(0);
        return;
      }
      measure((containerBottomY) => {
        if (disposed || containerBottomY === null) return;
        setMeasuredInset(keyboardOverlap({ containerBottomY, keyboardScreenY: next.screenY }));
      });
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [subscribe, measure, measuresWindowSpace]);

  const inset = measuresWindowSpace
    ? measuredInset
    : androidKeyboardInset({ keyboardHeight: geometry?.height ?? 0, safeAreaBottom });

  return { inset, containerRef };
}
