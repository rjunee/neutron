/**
 * @neutronai/app — WebSocket connection-state context (P5.0).
 *
 * Per `docs/plans/P5.0-app-scaffolding-sprint-brief.md` § 5.3:
 *
 *   Optional Context wrapper exposing `useWsConnection() →
 *   'connecting' | 'open' | 'closed' | 'error'` for the chat-tab
 *   indicator.
 *
 * The provider stays decoupled from the `AppWsClient` (lib/ws-client.ts)
 * implementation — it just holds the latest reported state. Callers
 * subscribe a client via `setWsState(...)` from inside their socket
 * lifecycle hook. The chat tab's connection indicator + the future
 * Settings drawer's "Disconnected — retrying…" footnote both read
 * via `useWsConnection()`.
 *
 * Why this lives separately from the actual socket: P5.1's chat
 * surface already manages its own per-project `AppWsClient` lifecycle.
 * This provider lets a SECOND surface (e.g. Settings, Focus header)
 * mirror the connection state without re-implementing the listener
 * plumbing.
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type PropsWithChildren,
} from 'react';

export type WsConnectionState = 'connecting' | 'open' | 'closed' | 'error';

interface WsConnectionContextValue {
  state: WsConnectionState;
  setWsState(next: WsConnectionState): void;
}

const WsConnectionContext = createContext<WsConnectionContextValue | null>(null);

export function WsConnectionProvider({ children }: PropsWithChildren) {
  const [state, setState] = useState<WsConnectionState>('closed');
  const setWsState = useCallback((next: WsConnectionState): void => {
    setState((prev) => (prev === next ? prev : next));
  }, []);
  const value = useMemo<WsConnectionContextValue>(
    () => ({ state, setWsState }),
    [state, setWsState],
  );
  return (
    <WsConnectionContext.Provider value={value}>{children}</WsConnectionContext.Provider>
  );
}

/**
 * Read-only hook for surfaces that just want to render the current
 * state ("Connecting…" / "Connected" / "Disconnected — retrying…").
 */
export function useWsConnection(): WsConnectionState {
  const ctx = useContext(WsConnectionContext);
  if (ctx === null) {
    // Provider is optional — if no parent mounted one, default to
    // 'closed'. This keeps the chat-tab indicator a no-op rather
    // than crashing.
    return 'closed';
  }
  return ctx.state;
}

/**
 * Writer hook for the surface that owns the WebSocket lifecycle
 * (the chat tab). Calling outside a provider is a silent no-op —
 * a screen can wire up its connection-state subscription unconditionally.
 */
export function useSetWsConnection(): (next: WsConnectionState) => void {
  const ctx = useContext(WsConnectionContext);
  if (ctx === null) {
    return () => undefined;
  }
  return ctx.setWsState;
}
