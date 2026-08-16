import { createElement, forwardRef, useImperativeHandle, type ReactNode, type Ref } from 'react';
// SIBLING STUB, NOT THE `react-native` SPECIFIER — deliberately.
//
// `mock.module('react-native', …)` is PROCESS-GLOBAL and permanent in Bun, and
// two app test files register one (`docs-panes-render`, `diagnostics-pane-
// render`). The harness sidesteps that by rewriting the specifier inside the
// APP's own sources (`native-harness.ts`), but that rewrite is scoped to
// `app/{app,components,lib,features}` — it does not cover this directory. Asking
// the registry for `react-native` from here therefore hands this stub whichever
// three-export fake loaded first in the process, its `View` renders `null`, and
// EVERY row of the transcript silently disappears from a mounted chat test that
// happens to share a chunk with one of those files. That is an order-dependent
// failure with no relationship to the code under test, which is the worst
// possible property for the gate meant to catch device bugs.
import { View } from './react-native';
export interface FlashListProps<T> {
  data?: readonly T[] | null;
  renderItem?: (info: { item: T; index: number }) => ReactNode;
  keyExtractor?: (item: T, index: number) => string;
  ListEmptyComponent?: ReactNode;
  ListFooterComponent?: ReactNode;
  [key: string]: unknown;
}
/**
 * The props of the most recent render, RECORDED (ISSUES #505).
 *
 * This stub deliberately does not virtualise and has no scroll offset, so where a
 * transcript OPENS cannot be observed here as a pixel — the only honest assertion
 * at this level is which position the surface ASKED the list for. Recording the
 * props makes that an assertion instead of a hope; that the ask is then honoured
 * is FlashList's own behaviour, cited from its source in
 * `lib/chat-core/chat-initial-anchor.ts`, and remains a device claim.
 *
 * Read it through {@link lastFlashListProps}, and reset it in `beforeEach` — Bun
 * shares one process across test files.
 */
let recordedProps: Record<string, unknown> | null = null;

/** The props FlashList was last rendered with. `null` before any render. */
export function lastFlashListProps(): Record<string, unknown> | null {
  return recordedProps;
}

/**
 * The IMPERATIVE calls the surface made on the list's ref, in order.
 *
 * The props recorder above can only show which opening position was ASKED FOR at
 * mount. It is blind to the case the push-tap re-anchor exists for: a transcript
 * that is already mounted, where FlashList has latched its initial scroll and the
 * only way to move is a method call on the ref. Before this the stub forwarded no
 * ref at all, so `listRef.current` was null and every imperative scroll in this
 * surface was silently unobservable — a handler could be deleted outright and no
 * test here would notice.
 *
 * These are still ASKS, not pixels: that `scrollToIndex` lands on the row is
 * FlashList's own behaviour and remains a device claim, the same boundary
 * `chat-initial-anchor.ts` draws.
 */
export interface FlashListImperativeCall {
  method: 'scrollToIndex' | 'scrollToEnd' | 'scrollToOffset';
  arg?: unknown;
}
let imperativeCalls: FlashListImperativeCall[] = [];

/** The imperative calls the surface made on the list ref, oldest first. */
export function flashListImperativeCalls(): readonly FlashListImperativeCall[] {
  return imperativeCalls;
}

/** Forget the recorded render + imperative calls. Call in `beforeEach`. */
export function resetFlashListRecorder(): void {
  recordedProps = null;
  imperativeCalls = [];
}

function FlashListInner<T>(props: FlashListProps<T>, ref: Ref<unknown>) {
  recordedProps = props as Record<string, unknown>;
  useImperativeHandle(ref, () => ({
    scrollToIndex: (arg: unknown): void => {
      imperativeCalls.push({ method: 'scrollToIndex', arg });
    },
    scrollToEnd: (arg?: unknown): void => {
      imperativeCalls.push({ method: 'scrollToEnd', arg });
    },
    scrollToOffset: (arg: unknown): void => {
      imperativeCalls.push({ method: 'scrollToOffset', arg });
    },
  }));
  const { data, renderItem, keyExtractor, ListEmptyComponent, ListFooterComponent } = props;
  const rows = data ?? [];
  if (rows.length === 0) {
    return createElement(View, null, ListEmptyComponent as ReactNode, ListFooterComponent as ReactNode);
  }
  return createElement(
    View,
    null,
    rows.map((item, index) =>
      createElement(
        View,
        { key: keyExtractor !== undefined ? keyExtractor(item, index) : String(index) },
        renderItem !== undefined ? renderItem({ item, index }) : null,
      ),
    ),
    ListFooterComponent as ReactNode,
  );
}

export const FlashList = forwardRef(FlashListInner) as <T>(
  props: FlashListProps<T> & { ref?: Ref<unknown> },
) => ReactNode;
