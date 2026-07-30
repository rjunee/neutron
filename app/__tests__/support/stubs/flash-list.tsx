import { createElement, type ReactNode } from 'react';
import { View } from 'react-native';
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
