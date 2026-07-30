import { createElement, type ReactNode } from 'react';
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
export function FlashList<T>({ data, renderItem, keyExtractor, ListEmptyComponent, ListFooterComponent }: FlashListProps<T>) {
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
