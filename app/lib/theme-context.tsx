/**
 * @neutronai/app — the ACTIVE theme, threaded to every component.
 *
 * `lib/theme.ts` owns the two palettes and the one selection rule. This module
 * owns the live state around them: what the owner picked, what the OS is
 * currently showing, which palette that resolves to, and how a component gets
 * hold of it.
 *
 * THE SEAM. `useThemedStyles(makeStyles)` is how ~70 components consume this.
 * They used to call `StyleSheet.create({...THEME.background...})` at MODULE
 * scope, which reads the palette exactly once — at import — and can therefore
 * never change. Each one is now a factory of the palette, memoised per palette,
 * called during render:
 *
 *     const styles = useThemedStyles(makeStyles);   // in the component
 *     const makeStyles = (theme: NeutronTheme) => StyleSheet.create({ ... });
 *
 * The memo key is the palette OBJECT, and both palettes are frozen
 * module-scope singletons, so a sheet is built at most twice per component for
 * the life of the process — flipping the theme back and forth does not
 * re-create sheets, and nothing is rebuilt on an unrelated re-render.
 *
 * WHY `system` NEEDS A SUBSCRIPTION, NOT A READ AT LAUNCH. React Native's
 * `useColorScheme()` is already a subscription — it re-renders on an
 * `Appearance` change — so a preference of `system` re-themes the app while it
 * is foregrounded, which is the behaviour the web has had since its light theme
 * shipped. Reading the scheme once at boot would look identical in every test
 * that mounts and asserts, and be wrong on the device the moment the OS flipped.
 *
 * ONE PATH, NOT A FLAG. A three-state owner-facing preference is product
 * functionality he asked for, not a feature flag: there is a single theming
 * path, both palettes are reachable from a shipped build, and no dark-only
 * fallback survives beside it (`THEME` is gone from `lib/theme.ts` precisely so
 * one cannot).
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  DARK_PALETTE,
  DEFAULT_PREFERENCE,
  isThemePreference,
  paletteFor,
  resolveTheme,
  type NeutronPalette,
  type NeutronPhaseColors,
  type NeutronTheme,
  type ResolvedTheme,
  type ThemePreference,
} from './theme';

/**
 * THE OS COLOUR SCHEME, resolved through a lazy `require` rather than a static
 * `import { useColorScheme } from 'react-native'`.
 *
 * The static form breaks MODULE LOAD, not just this file: Bun cannot resolve
 * `useColorScheme` as a named export of the real `react-native` barrel, so every
 * test whose component tree reaches this module WITHOUT the react-native-web alias
 * installed died with `SyntaxError: Export named 'useColorScheme' not found` — 29
 * tests across the attachment, docs-pane and reminder suites, none of them about
 * theming. On a device the export is there; the failure is a resolution artefact,
 * and the cost of the static import is that a resolution artefact becomes an
 * import-time crash for unrelated code.
 *
 * Resolved ONCE at module scope, so the returned function has a stable identity and
 * calling it unconditionally in the provider still satisfies the rules of hooks. A
 * runtime that does not provide it degrades to `null` — reported as "the OS did not
 * say", which {@link resolveTheme} already treats as dark, rather than guessed at.
 */
const useOsColorScheme: () => string | null | undefined = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const RN = require('react-native') as { useColorScheme?: () => string | null | undefined };
    if (typeof RN.useColorScheme === 'function') return RN.useColorScheme;
  } catch {
    /* No react-native in this runtime (pure-TS unit tests). */
  }
  return () => null;
})();

/** Storage key. Deliberately the SAME string the web chat persists under
 *  (`landing/chat-react/theme.ts` THEME_STORAGE_KEY) — different devices, but one
 *  name for one concept keeps the two implementations readable side by side. */
export const THEME_STORAGE_KEY = 'neutron-theme';

/** The key/value surface this module needs. Satisfied by `window.localStorage`
 *  (sync) and by AsyncStorage (async) alike, because every result is awaited. */
export interface ThemeBacking {
  getItem(key: string): Promise<string | null> | string | null;
  setItem(key: string, value: string): Promise<void> | void;
}

/** Read the stored preference. Never throws and never invents one: an absent,
 *  unreadable, or corrupt value is reported as the default (`system`). */
export async function readStoredPreference(
  backing: ThemeBacking | null,
): Promise<ThemePreference> {
  if (backing === null) return DEFAULT_PREFERENCE;
  try {
    const raw = await Promise.resolve(backing.getItem(THEME_STORAGE_KEY));
    return isThemePreference(raw) ? raw : DEFAULT_PREFERENCE;
  } catch {
    return DEFAULT_PREFERENCE;
  }
}

/**
 * THE PRE-PAINT READ — the same answer, taken synchronously, where the platform
 * has a synchronous store.
 *
 * `readStoredPreference` above is the async path and is correct; the problem is
 * WHEN it answers. It resolves after the first render, so the first painted frame
 * shows the OS-resolved theme and the owner's override lands a frame later — an
 * explicit `light` choice on a dark-OS phone flashes dark and then snaps. The web
 * client has never had that, because its pre-paint inline script
 * (`landing/chat-react.html`) reads `localStorage` BEFORE the stylesheet applies.
 * This is that script's mobile counterpart.
 *
 * `undefined` means "this backing cannot answer synchronously" — which is a
 * different fact from `null`/absent, and the distinction is the whole point:
 * absent means "use the default", unanswerable means "wait for the async read".
 * `window.localStorage` answers; AsyncStorage returns a Promise and does not, so
 * on native the boot gate in `app/_layout.tsx` remains the mechanism.
 *
 * The residual, stated rather than glossed: the NATIVE SPLASH renders before any
 * JavaScript exists to consult, so it follows the OS scheme (`splash.dark` in
 * `app.json`) and cannot follow a stored override. No JS-side change can reach
 * it.
 */
export function readStoredPreferenceSync(
  backing: ThemeBacking | null,
): ThemePreference | undefined {
  if (backing === null) return undefined;
  try {
    const raw = backing.getItem(THEME_STORAGE_KEY);
    // A thenable is the async backing; do not block on it here.
    if (raw !== null && typeof raw === 'object' && 'then' in raw) return undefined;
    return isThemePreference(raw) ? raw : DEFAULT_PREFERENCE;
  } catch {
    return undefined;
  }
}

/** Persist the choice — including `system`, so returning to "follow the OS" is a
 *  recorded decision and not merely the absence of one. Never throws. */
export async function writeStoredPreference(
  backing: ThemeBacking | null,
  pref: ThemePreference,
): Promise<void> {
  if (backing === null) return;
  try {
    await Promise.resolve(backing.setItem(THEME_STORAGE_KEY, pref));
  } catch {
    /* Quota / IO. The in-memory choice still drives this session. */
  }
}

class MemoryBacking implements ThemeBacking {
  private readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

let _defaultBacking: ThemeBacking | null = null;

/**
 * The platform's store: `localStorage` on web, AsyncStorage on native, an
 * in-memory map when neither exists. Same Platform / lazy-`require` shape as
 * `lib/last-tab-storage.ts` and `lib/token-storage.ts`.
 */
export function themeBacking(): ThemeBacking {
  if (_defaultBacking !== null) return _defaultBacking;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Platform } = require('react-native') as { Platform: { OS: string } };
  if (Platform.OS === 'web') {
    const g = globalThis as { localStorage?: ThemeBacking };
    _defaultBacking = g.localStorage ?? new MemoryBacking();
  } else {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('@react-native-async-storage/async-storage') as {
      default: ThemeBacking;
    };
    _defaultBacking = mod.default;
  }
  return _defaultBacking;
}

/** Test-only — drop the cached backing so the next resolve re-reads the platform. */
export function __resetThemeBackingForTests(): void {
  _defaultBacking = null;
}

/** Test-only — install a backing that behaves like the device's (slow, broken,
 *  pre-seeded). There is no other seam: `themeBacking()` resolves through a
 *  `require`, which a test file cannot intercept. */
export function __setThemeBackingForTests(backing: ThemeBacking | null): void {
  _defaultBacking = backing;
}

export interface ThemeState {
  /** What the owner picked: `light` | `dark` | `system`. */
  preference: ThemePreference;
  /** The scheme actually painted. Never `system`. */
  scheme: ResolvedTheme;
  /** The active palette. */
  palette: NeutronPalette;
  /** Persist + apply a new preference. */
  setPreference: (pref: ThemePreference) => void;
  /**
   * False until the stored preference has been read back.
   *
   * The read is a bridge round-trip on native, so the very first paint happens
   * before the answer arrives. Until then we show the OS-resolved theme, which
   * is the correct answer for the default preference and for every owner who
   * never overrode it. A consumer that must not paint the wrong theme for one
   * frame can gate on this; the app shell does (`app/_layout.tsx`), which is
   * mobile's equivalent of the web's pre-paint inline script.
   */
  hydrated: boolean;
}

/**
 * The default context value exists so a component rendered OUTSIDE the provider
 * still gets a real palette instead of crashing — a screen mounted bare in a
 * test, or an error boundary that renders above the provider. It is dark and
 * inert: `setPreference` is a no-op because there is no state to change.
 */
const FALLBACK: ThemeState = {
  preference: DEFAULT_PREFERENCE,
  scheme: 'dark',
  palette: DARK_PALETTE,
  setPreference: () => undefined,
  hydrated: true,
};

const ThemeContext = createContext<ThemeState>(FALLBACK);

export interface ThemeProviderProps {
  children: ReactNode;
  /** Test-only override for the persistence backing. */
  backing?: ThemeBacking | null;
  /**
   * Test-only override for the OS scheme. Supplied because `useColorScheme()`
   * answers from a native module the harness has no way to drive; a test that
   * needs to prove `system` FOLLOWS a change re-renders the provider with a new
   * value here, which is exactly what `Appearance` does on the device.
   */
  osScheme?: ResolvedTheme | null;
}

export function ThemeProvider({
  children,
  backing,
  osScheme,
}: ThemeProviderProps): ReactNode {
  // `useColorScheme` IS the subscription — it re-renders this provider when the
  // OS scheme changes, so `system` tracks it live with no listener of our own.
  const nativeScheme = useOsColorScheme();
  const resolvedOsScheme: ResolvedTheme | null =
    osScheme !== undefined ? osScheme : nativeScheme === 'light' ? 'light' : nativeScheme === 'dark' ? 'dark' : null;

  const store = useMemo<ThemeBacking | null>(
    () => (backing !== undefined ? backing : themeBacking()),
    [backing],
  );

  // Seeded from the SYNCHRONOUS read where one exists, so the very first render
  // already has the owner's choice and there is no wrong-theme frame at all. Where
  // it does not (native), `seeded` is undefined and the async effect below is the
  // path — with `hydrated` false meanwhile, which the app shell gates on.
  const seeded = readStoredPreferenceSync(store);
  const [preference, setPreferenceState] = useState<ThemePreference>(
    seeded ?? DEFAULT_PREFERENCE,
  );
  const [hydrated, setHydrated] = useState(seeded !== undefined);

  useEffect(() => {
    if (hydrated) return;
    let cancelled = false;
    void readStoredPreference(store).then((pref) => {
      if (cancelled) return;
      setPreferenceState(pref);
      setHydrated(true);
    });
    return () => {
      cancelled = true;
    };
    // `hydrated` is deliberately NOT a dependency: it is a latch, and re-running
    // this on the transition to true would re-read the store for no reason. The
    // store IS a dependency, because a new backing is a new answer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store]);

  const setPreference = useCallback(
    (pref: ThemePreference): void => {
      if (!isThemePreference(pref)) return;
      // Apply first, persist second: the control must feel instant, and a
      // storage failure must not be able to swallow the owner's choice.
      setPreferenceState(pref);
      void writeStoredPreference(store, pref);
    },
    [store],
  );

  const scheme = resolveTheme(preference, resolvedOsScheme);
  const palette = paletteFor(scheme);

  const value = useMemo<ThemeState>(
    () => ({ preference, scheme, palette, setPreference, hydrated }),
    [preference, scheme, palette, setPreference, hydrated],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/**
 * Read the context, TOTALLY.
 *
 * `useContext` normally answers with the default when there is no provider, so the
 * `?? FALLBACK` looks redundant — and is not. Several component tests in this suite
 * drive a component by CALLING it directly under a hand-written hook dispatcher
 * whose `useContext` returns `undefined` unconditionally
 * (`authed-attachment-file-open`, `docs-panes-render`, and others — it is how they
 * avoid a process-global `react` mock). Without this, all of those died on
 * `undefined is not an object` inside a theming hook: 29 tests, none of them about
 * theming, with the component under test entirely fine.
 *
 * A palette is also the wrong thing to be strict about. There is no useful
 * behaviour for "no provider" other than "paint something legible", which is what
 * FALLBACK is. Throwing would turn a missing provider into a blank screen, and a
 * blank screen carrying no information is a failure mode this app has already paid
 * for once.
 *
 * ═══ AND THE CASE WHERE THERE IS NO DISPATCHER AT ALL ═══
 *
 * `?? FALLBACK` covers a stub whose `useContext` RETURNS `undefined`. It does not
 * cover the other shape those tests take: invoking a component from plain
 * JavaScript, outside any React render, with its own hooks supplied through the
 * `HookRuntime` DI seam (`lib/hook-runtime.ts`). React then has no current
 * dispatcher, and `useContext` throws `TypeError: null is not an object` from
 * inside React itself before this function's `??` is ever reached.
 *
 * That is not hypothetical and it is not a test-only concern about test-only code:
 * closing the hardcoded-colour budget converted `DiagnosticsPane` and the docs
 * panes, and the moment they took a theming hook, EIGHT tests about diagnostics and
 * document rendering — none of them about theming — died in `useThemedStyles`. The
 * components were fine. `HookRuntime` deliberately does not carry `useContext`
 * (only "the dispatcher hooks a unit needs substituted"), and threading a palette
 * through ~70 call sites to satisfy it would be a large change for no product
 * benefit.
 *
 * So the totality above is extended: no provider, no context value, AND no
 * dispatcher all resolve to a legible palette. It is the same judgement in a third
 * position — a palette must never be the reason a render fails.
 *
 * Only `TypeError` is swallowed, and only around the context read, so a genuine
 * fault anywhere else still propagates. The exposure this accepts is narrow: any
 * component that really did violate the rules of hooks calls its OTHER hooks
 * through the same absent dispatcher and fails loudly on one of those instead —
 * `useThemedStyles` is simply the first one a themed component reaches.
 *
 * KNOWN COSMETIC COST: React logs its own "Invalid hook call" warning from inside
 * `resolveDispatcher()` BEFORE throwing, so those tests print it even though they
 * pass. Silencing it would mean reading React's internal current-dispatcher field to
 * decide whether to call the hook at all — internal-API coupling that a React upgrade
 * can break silently, traded against console noise in eight test files. The catch is
 * the version-stable choice; the noise is the price and is recorded here so it is not
 * mistaken for a real fault.
 */
interface ThemeRead {
  state: ThemeState;
  /**
   * Whether React answered — i.e. whether we are inside a render with a live hook
   * dispatcher. `false` means no further hook may be called in this pass, which is
   * the fact {@link useThemedStyles} needs and cannot recover on its own: it calls
   * `useMemo` AFTER this, and that would throw for exactly the same reason.
   */
  live: boolean;
}

function themeRead(): ThemeRead {
  try {
    return { state: useContext(ThemeContext) ?? FALLBACK, live: true };
  } catch (err) {
    if (err instanceof TypeError) return { state: FALLBACK, live: false };
    throw err;
  }
}

function themeState(): ThemeState {
  return themeRead().state;
}

/** The whole theme state — for the settings control and the app shell. */
export function useThemeState(): ThemeState {
  return themeState();
}

/** The active colors. The hook ~70 components call. */
export function useTheme(): NeutronTheme {
  return themeState().palette.colors;
}

/** The active work-phase colors (dot + tag). */
export function usePhase(): NeutronPhaseColors {
  return themeState().palette.phase;
}

/**
 * Build a component's stylesheet from the active palette, memoised per palette.
 *
 * `factory` MUST be a stable module-scope function (that is the convention every
 * converted component follows) — an inline arrow would be a new identity every
 * render and defeat the memo.
 *
 * Both halves of the palette are passed, so a sheet that tints a work-phase tag
 * declares `(theme, phase)` and one that doesn't simply ignores the second
 * argument. One signature rather than an overload pair: the alternative had every
 * phase-using component remember to pass `usePhase()` back in at the call site,
 * which is a thing to get wrong for no benefit.
 *
 * MEMOISATION IS SKIPPED WHEN THERE IS NO DISPATCHER. See `themeRead` — a component
 * invoked from plain JavaScript through the `HookRuntime` DI seam has no live React
 * dispatcher, so `useMemo` would throw the same `TypeError` the context read just
 * absorbed. Building the sheet directly is the correct degradation and costs nothing
 * that matters: the memo is a performance optimisation over a pure function of the
 * palette, so calling it is always semantically identical to reading the cache.
 */
export function useThemedStyles<T>(
  factory: (theme: NeutronTheme, phase: NeutronPhaseColors) => T,
): T {
  const { state, live } = themeRead();
  const palette = state.palette;
  // `live` is constant for a given call context — either this code is running inside
  // a React render or it is not — so the conditional hook below cannot vary between
  // renders of the same component, which is the property the rule protects.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  if (!live) return factory(palette.colors, palette.phase);
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return useMemo(() => factory(palette.colors, palette.phase), [factory, palette]);
}

/** A sheet built from a NAMED palette, for a test that compares both without
 *  mounting anything. The production path is {@link useThemedStyles}. */
export function buildStyles<T>(
  factory: (theme: NeutronTheme, phase: NeutronPhaseColors) => T,
  palette: NeutronPalette,
): T {
  return factory(palette.colors, palette.phase);
}
