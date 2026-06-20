/**
 * @neutronai/app — auth session context (P5.0 rewrite).
 *
 * Per `docs/plans/P5.0-app-scaffolding-sprint-brief.md` § 4.5 + § 5.3:
 * the provider hydrates from persistent token storage on mount and
 * persists on every `setUser`. AsyncStorage backs native, localStorage
 * backs web — see `lib/token-storage.ts`. `signOut()` (handled by
 * callers via `clear()`) wipes both the in-memory user + the
 * persisted blobs.
 *
 * Pre-P5.0 this provider held memory-only state — refreshing the
 * page returned every user to /login. That degraded UX is the
 * specific gap this rewrite closes.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from 'react';

import type { AuthUser } from './auth';
import { tokenStorage, type TokenStorage } from './token-storage';

export type AuthSessionStatus = 'hydrating' | 'ready';

interface AuthSessionContextValue {
  /** The currently signed-in user, or `null` when signed out. */
  user: AuthUser | null;
  /**
   * `'hydrating'` until the first read from persistent storage
   * resolves, then `'ready'`. Surfaces that want to avoid a flash of
   * the /login screen during the first paint (`/` route) can gate
   * navigation on `status === 'ready'`.
   */
  status: AuthSessionStatus;
  /**
   * Update the in-memory user AND persist to storage. Pass `null` to
   * clear (equivalent to `clear()`).
   */
  setUser(user: AuthUser | null): void;
  /** Clear the user + wipe persisted blobs. */
  clear(): void;
}

const AuthSessionContext = createContext<AuthSessionContextValue | null>(null);

export interface AuthSessionProviderProps extends PropsWithChildren {
  /**
   * Optional override for tests + Storybook fixtures. Real builds
   * leave this undefined and the provider resolves the platform
   * storage via `tokenStorage()`.
   */
  storageOverride?: TokenStorage;
  /**
   * Optional initial user — used by tests to skip the hydrate cycle
   * + by previews where you want a stable signed-in state.
   */
  initialUser?: AuthUser | null;
}

export function AuthSessionProvider({
  children,
  storageOverride,
  initialUser,
}: AuthSessionProviderProps) {
  const [user, setUserState] = useState<AuthUser | null>(initialUser ?? null);
  const [status, setStatus] = useState<AuthSessionStatus>(
    initialUser !== undefined ? 'ready' : 'hydrating',
  );
  const storageRef = useRef<TokenStorage | null>(storageOverride ?? null);

  // Resolve the storage instance lazily so a test can stub
  // Platform.OS before the first render without paying for an
  // AsyncStorage import on web.
  const getStorage = useCallback((): TokenStorage => {
    if (storageRef.current === null) {
      storageRef.current = tokenStorage();
    }
    return storageRef.current;
  }, []);

  useEffect(() => {
    if (initialUser !== undefined) return;
    let cancelled = false;
    void (async () => {
      try {
        const storage = getStorage();
        const persisted = await storage.getUser();
        if (cancelled) return;
        if (persisted !== null) {
          setUserState(persisted);
        }
      } catch (err) {
        console.warn('[session] hydrate failed:', err);
      } finally {
        if (!cancelled) setStatus('ready');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [getStorage, initialUser]);

  const setUser = useCallback(
    (next: AuthUser | null): void => {
      setUserState(next);
      const storage = getStorage();
      void (async () => {
        try {
          if (next === null) {
            await storage.clearAll();
          } else {
            await Promise.all([storage.setUser(next), storage.setToken(next.token)]);
          }
        } catch (err) {
          console.warn('[session] persist failed:', err);
        }
      })();
    },
    [getStorage],
  );

  const clear = useCallback((): void => {
    setUser(null);
  }, [setUser]);

  const value = useMemo<AuthSessionContextValue>(
    () => ({ user, status, setUser, clear }),
    [user, status, setUser, clear],
  );

  return <AuthSessionContext.Provider value={value}>{children}</AuthSessionContext.Provider>;
}

export function useAuthSession(): AuthSessionContextValue {
  const ctx = useContext(AuthSessionContext);
  if (ctx === null) {
    throw new Error('useAuthSession must be used inside <AuthSessionProvider>');
  }
  return ctx;
}
