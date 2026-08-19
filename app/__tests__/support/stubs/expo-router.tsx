/**
 * @neutronai/app — the router stand-in for the device-shaped harness.
 *
 * TWO MODES, and the difference matters.
 *
 * INERT (the default, and what every pre-existing harness file gets). `replace`
 * / `push` only RECORD into `routerCalls`, `usePathname()` is `'/'`, params are
 * empty and `<Slot/>` renders nothing. A test that only wants to know "did this
 * control try to navigate?" needs no more than that, and giving it more would
 * change files that never asked for it.
 *
 * ROUTING (opt in with {@link installRouting}). The stub becomes a real, minimal
 * router: a current path, a route table keyed by the leaf segment, and `<Slot/>`
 * mounting the matching screen. This is what makes a PROJECT SWITCH reproducible
 * in-process — the shell, the default-tab redirect screen and the chat surface
 * all participate, so "tapping a project puts it on the wire" becomes an
 * assertion about the real chain rather than about one component in isolation.
 *
 * WHAT IT MODELS, and therefore what it can prove. The path is the single source
 * of truth: `usePathname()` returns it and `useLocalSearchParams()` DERIVES from
 * it (`/projects/<id>/<leaf>` ⇒ `{ id, ...query }`). Real expo-router carries
 * params on the route node instead, and their staleness across a
 * dynamic-segment change is the hazard `projectIdFromPathname` exists to dodge —
 * so a defect living ONLY in that divergence cannot appear here, and this
 * harness must not be read as clearing it. Everything downstream of "the path
 * changed" is faithful.
 */

import {
  createElement,
  useEffect,
  useSyncExternalStore,
  type ComponentType,
  type ReactNode,
} from 'react';

export const routerCalls: Array<{ kind: 'push' | 'replace'; href: string }> = [];

/** Leaf segment → screen. Empty ⇒ `<Slot/>` renders nothing (inert mode). */
type RouteTable = Record<string, ComponentType<unknown>>;

let routing = false;
let routes: RouteTable = {};
let currentPath = '/';
let paramsBlind = false;
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of [...listeners]) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return (): void => {
    listeners.delete(listener);
  };
}

/**
 * Turn the stub into a routing router, seeded at `path`.
 *
 * `routes` is keyed by the LEAF segment of the path — `'chat'`, `'docs'` — plus
 * `'index'` for a bare `/projects/<id>`, which is how expo-router resolves a
 * directory route and is the case the default-tab redirect screen owns.
 */
export function installRouting(opts: {
  path: string;
  routes: RouteTable;
  /**
   * FAULT INJECTION: `useLocalSearchParams()` yields NOTHING, however the path
   * reads.
   *
   * Not invented, and not exotic. `app/projects/[id]/_layout.tsx` records from
   * the device that this hook stopped reporting the current `[id]` across a
   * project switch, which is why the SHELL was changed to read
   * `projectIdFromPathname(usePathname())` instead — and `index.tsx` has always
   * carried an explicit `typeof id !== 'string' || id.length === 0` branch,
   * i.e. its own author treated an absent param as reachable. That fix landed on
   * the shell alone, leaving the screens INSIDE it reading the source the shell
   * had already stopped trusting. This turns "the whole route family agrees on
   * the scope" into something a test can fail, instead of a convention.
   */
  paramsBlind?: boolean;
}): void {
  routing = true;
  routes = opts.routes;
  currentPath = opts.path;
  paramsBlind = opts.paramsBlind === true;
  routerCalls.length = 0;
  notify();
}

/** Back to inert. Call from `afterEach`/`afterAll`; the module is process-wide. */
export function resetRouting(): void {
  routing = false;
  routes = {};
  currentPath = '/';
  paramsBlind = false;
  routerCalls.length = 0;
  notify();
}

/** The path the router is on right now (read from outside React). */
export function currentRouterPath(): string {
  return currentPath;
}

function navigate(kind: 'push' | 'replace', href: string): void {
  routerCalls.push({ kind, href });
  if (!routing) return;
  if (href === currentPath) return;
  currentPath = href;
  notify();
}

const ROUTER = {
  push: (href: string): void => {
    navigate('push', href);
  },
  replace: (href: string): void => {
    navigate('replace', href);
  },
  back: (): void => {},
};

export function useRouter(): typeof ROUTER {
  return ROUTER;
}

/**
 * `useFocusEffect` — run on focus, clean up on blur.
 *
 * A mounted screen in this harness is always the focused one (there is no
 * navigator stacking screens behind each other), so focus IS mount and blur IS
 * unmount, and `useEffect` is the faithful model of it here.
 *
 * ADDED BECAUSE ITS ABSENCE WAS INVISIBLE IN THE WORST WAY. `ChatSyncSurface`
 * started importing this hook, the stub did not export it, and the files that
 * mount that surface stopped LOADING — so the local suite ran 122 FEWER tests
 * and reported FEWER failures than before the change. A drop in the failure
 * count read as an improvement while a fifth of the suite silently stopped
 * running. Count the tests that RAN, not just the ones that failed.
 *
 * Real expo-router re-runs the effect whenever the callback identity changes,
 * which is why callers wrap it in `useCallback` — mirrored here by keying the
 * effect on the callback.
 */
export function useFocusEffect(effect: () => undefined | (() => void)): void {
  useEffect(() => effect(), [effect]);
}

export function usePathname(): string {
  return useSyncExternalStore(
    subscribe,
    () => currentPath,
    () => currentPath,
  );
}

export function useSegments(): string[] {
  return (usePathname().split('?')[0] ?? '').split('/').filter((p) => p.length > 0);
}

/**
 * Params for the current path. `/projects/<id>/<leaf>?a=b` ⇒ `{ id, a }`.
 * Inert mode (path `'/'`) yields `{}`, which is what every existing caller saw.
 */
export function useLocalSearchParams<T>(): T {
  const path = usePathname();
  const [bare, query] = path.split('?');
  const parts = (bare ?? '').split('/').filter((p) => p.length > 0);
  const out: Record<string, string> = {};
  if (parts[0] === 'projects' && typeof parts[1] === 'string') {
    out['id'] = decodeURIComponent(parts[1]);
  }
  if (query !== undefined) {
    for (const [k, v] of new URLSearchParams(query)) out[k] = v;
  }
  return (paramsBlind ? {} : out) as T;
}

/** The screen the current path names. Nothing, in inert mode. */
export function Slot(): ReactNode {
  const path = usePathname();
  if (!routing) return null;
  const parts = (path.split('?')[0] ?? '').split('/').filter((p) => p.length > 0);
  // `/projects/<id>` (no leaf) is the directory route — expo-router's `index`.
  const leaf = parts.length <= 2 ? 'index' : (parts[parts.length - 1] ?? 'index');
  const Screen = routes[leaf];
  if (Screen === undefined) return null;
  return createElement(Screen, null);
}

export function Stack(): ReactNode {
  return null;
}
export function Link({ children }: { children?: ReactNode }) {
  return createElement('span', null, children);
}
export function Redirect(): ReactNode {
  return null;
}
