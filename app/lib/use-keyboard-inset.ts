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
 * `keyboardDidShow` / `keyboardDidHide`. On Android the OS usually resizes the
 * window first, which makes the measured overlap ≤ 0 and this a no-op — the
 * correct outcome, reached without a platform branch in the math.
 *
 * The two seams (`subscribe`, `measure`) are parameters with real defaults so
 * the wiring is assertable off-device: a test drives fake keyboard events and a
 * fake measurement and checks the inset it produces.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Keyboard, Platform, type View } from 'react-native';

import { keyboardOverlap } from './keyboard-inset';

/** Window-space top edge of the keyboard; `null` when it is gone. */
export type KeyboardTopListener = (keyboardScreenY: number | null) => void;

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
          listener(e.endCoordinates.screenY);
        }),
        Keyboard.addListener('keyboardWillHide', () => {
          listener(null);
        }),
      ]
    : [
        Keyboard.addListener('keyboardDidShow', (e) => {
          listener(e.endCoordinates.screenY);
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
}

export function useKeyboardInset(opts: UseKeyboardInsetOptions = {}): UseKeyboardInsetResult {
  const containerRef = useRef<View | null>(null);
  const [inset, setInset] = useState(0);

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

  useEffect(() => {
    let disposed = false;
    const unsubscribe = subscribe((keyboardScreenY) => {
      if (keyboardScreenY === null) {
        if (!disposed) setInset(0);
        return;
      }
      measure((containerBottomY) => {
        if (disposed || containerBottomY === null) return;
        setInset(keyboardOverlap({ containerBottomY, keyboardScreenY }));
      });
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [subscribe, measure]);

  return { inset, containerRef };
}
