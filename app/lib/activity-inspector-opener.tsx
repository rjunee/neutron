import { createContext, useContext, type ReactNode } from 'react';

const OpenActivityInspectorContext = createContext<((scope: string | null) => void) | null>(null);

export function ActivityInspectorOpenProvider({
  onOpen,
  children,
}: {
  onOpen: (scope: string | null) => void;
  children?: ReactNode;
}): React.JSX.Element {
  return (
    <OpenActivityInspectorContext.Provider value={onOpen}>
      {children}
    </OpenActivityInspectorContext.Provider>
  );
}

export function useOpenActivityInspector(): ((scope: string | null) => void) | null {
  return useContext(OpenActivityInspectorContext);
}
