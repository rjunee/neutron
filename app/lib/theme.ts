/**
 * @neutronai/app — resolved light/dark palette + typography / spacing / motion
 * tokens (P5.0 palette, P5.1 extensions).
 *
 * P5.0 locked the dark color palette so every component reads colors
 * from one source. P5.1 layers typography, spacing, motion, and density
 * tokens on top of that palette so the impeccable design pass has a
 * coherent vocabulary to thread through the chat surface and every
 * primitive that the surface emits for later sprints (P5.2 project view
 * shell, P5.3 launcher, P7.2 inline-comment threads, ...).
 *
 * Anti-pattern guard: no `react-native-paper`, no `@shopify/restyle`,
 * no `tailwind-rn`, no `nativewind`. Plain `StyleSheet.create` +
 * constants from this file only. Inline magic numbers in component
 * styles are forbidden — every spacing / radius / motion duration
 * MUST come from these tokens. If a new value is needed, add it here
 * first and reference the token from the component.
 */

import { StyleSheet, type ImageStyle, type TextStyle, type ViewStyle } from 'react-native';

export interface NeutronTheme {
  /** Page background. */
  background: string;
  /** Surface (cards, drawer panels) sitting on top of the background. */
  surface: string;
  /** Surface raised one level higher (hovered card, active tab). */
  surface_raised: string;
  /** Primary text (headings, body that needs full contrast). */
  text_primary: string;
  /** Secondary text (body paragraphs, descriptive copy). */
  text_secondary: string;
  /** Muted text (captions, footnotes, deemphasized labels). */
  text_muted: string;
  /** Accent color (active states, focus rings, primary action). */
  accent: string;
  /** Hairline / border color (separators, card outlines). */
  hairline: string;
  /** Danger / error (sign-out destructive action, error text). */
  danger: string;
  /** Warning / pending (reconnect banner, attention without alarm). */
  warning: string;
  /** Link color (markdown links, citation chip text). */
  link: string;
  /**
   * The OWNER's own chat bubble. Mirror of the web `--user-bubble` (#0a84ff).
   *
   * A dedicated token rather than reusing `accent`: `accent` paints spinners,
   * active states and focus rings, and repainting all of those is a much broader
   * decision than "my messages should be blue". Web keeps the same separation.
   */
  user_bubble: string;
  /** The rail's SELECTED row fill. Carries selection ALONE — see theme.ts note. */
  rail_selected: string;
  /** Content drawn ON `user_bubble`. Mirror of the web `--user-fg`. */
  user_ink: string;
  /** M1 UX REDESIGN — rail work-activity dot: a project with a live build /
   *  running turn. Mirror of the web `--work` token. */
  work: string;
  /** M1 UX REDESIGN — rail attention dot: a failed-not-done item or a stalled
   *  live run. Mirror of the web `--attention` token. */
  attention: string;
  /** Usage meter, below 85% of a window. Mirror of the web `--usage-nominal`. */
  usage_nominal: string;
  /** Usage meter, 85–95%. Mirror of the web `--usage-warning`. */
  usage_warning: string;
  /** Usage meter, 95% and up. Mirror of the web `--usage-critical`. */
  usage_critical: string;
}

/**
 * THE DARK RAMP, LIFTED AND TINTED (owner feedback 2026-08-07).
 *
 * He compared the app to Telegram side by side: *"our colors are too dark, can you
 * make it a little bit lighter and some more variation between the chat bubbles and
 * the background?"* Both halves were true, and the second was the worse one — at
 * `background: #0a0a0a` against `surface_raised: #1a1a1a` an agent bubble sat 16
 * units off the ground it was drawn on, so the transcript read as one flat sheet.
 *
 * Two changes, not one. Every step is LIFTED (nothing is near-black any more), and
 * every neutral is TINTED toward the product's own blue rather than being a pure
 * grey — which is what makes a dark UI look composed instead of switched-off, and
 * what Telegram's blue-grey ground is doing. The hue family is taken from the web
 * chat's palette (`--bg #0b0d10`, `--agent-bubble #1d2026`), so the two clients
 * still look like the same product; mobile simply sits a step brighter, because a
 * phone is read in daylight and a desktop usually is not.
 *
 * The steps are deliberately EVEN. background → surface → surface_raised each lift
 * by a comparable amount, so "raised" reads as raised at every level rather than
 * only where the delta happened to be big enough.
 */
export const DARK_THEME: NeutronTheme = Object.freeze({
  background: '#101419',
  surface: '#171d25',
  surface_raised: '#222834',
  // Not pure white: #fff on a dark ground reads as heavier than it is and glares.
  text_primary: '#eceff4',
  text_secondary: '#b6becb',
  text_muted: '#7c848f',
  accent: '#e0e0e0',
  hairline: '#2b3240',
  danger: '#ff5c5c',
  warning: '#ffae42',
  link: '#5fb6ff',
  // The signature blue. Owner: "make messages from me in our signature blue color
  // not white/grey" — the web chat has rendered his bubbles in exactly this since
  // it shipped; mobile was painting them with `accent`, a near-white.
  user_bubble: '#0a84ff',
  user_ink: '#ffffff',
  // THE SELECTED RAIL ROW. Owner: "Make the highlight color of the currently
  // selected project much more obvious. it's VERY hard to see what project is
  // selected." It was `surface_raised` — a neutral one step up from the ground,
  // which is a correct RAISED cue and a useless SELECTED one: every raised surface
  // in the app uses that same value, so the row read as a panel rather than as the
  // answer to "where am I". Selection is carried by HUE instead.
  //
  // ONE CUE, NOT TWO. The first attempt paired this fill with a saturated blue
  // border. He rejected it on sight: "I did NOT ask for that ugly ass blue border
  // on the active project. I just wanted the highlight color to be more prominent."
  // Correct — a border is a different visual statement (it outlines, it frames, it
  // reads as a control), and two cues for one fact is louder than the fact. So the
  // border is gone and the FILL does the work, pushed considerably further up the
  // blue than the timid first value so it does not need help.
  rail_selected: '#1e4b87',
  work: '#66ccff',
  attention: '#ffd27d',
  usage_nominal: '#4bbf73',
  usage_warning: '#e0a832',
  usage_critical: '#e0553f',
});

/** Light values mirror the web variables in `landing/chat-react.html`. */
export const LIGHT_THEME: NeutronTheme = Object.freeze({
  background: '#ffffff',
  surface: '#f5f5f7',
  surface_raised: '#e9e9eb',
  text_primary: '#1c1c1e',
  text_secondary: '#3a3f4a',
  text_muted: '#66666a',
  accent: '#1064cc',
  hairline: '#d1d1d6',
  danger: '#c9252d',
  warning: '#8a5f00',
  link: '#0b57d0',
  user_bubble: '#1064cc',
  user_ink: '#ffffff',
  rail_selected: 'rgba(16,100,204,.12)',
  work: '#1064cc',
  attention: '#e0a020',
  usage_nominal: '#1a7f37',
  usage_warning: '#b07407',
  usage_critical: '#c9252d',
});

export type ResolvedTheme = 'light' | 'dark';
export type ThemePreference = 'system' | ResolvedTheme;

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'system' || value === 'light' || value === 'dark';
}

export function resolveTheme(
  preference: ThemePreference,
  systemAppearance: ResolvedTheme | null | undefined,
): ResolvedTheme {
  if (preference === 'light' || preference === 'dark') return preference;
  return systemAppearance === 'light' ? 'light' : 'dark';
}

export interface ThemeStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<unknown>;
}

export const THEME_STORAGE_KEY = 'neutron-theme';

export async function readThemePreference(storage: ThemeStorage): Promise<ThemePreference> {
  try {
    const stored = await storage.getItem(THEME_STORAGE_KEY);
    return isThemePreference(stored) ? stored : 'system';
  } catch {
    return 'system';
  }
}

export async function writeThemePreference(
  storage: ThemeStorage,
  preference: ThemePreference,
): Promise<void> {
  try {
    await storage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Persistence failure must not prevent the in-memory choice from applying.
  }
}

let resolvedTheme: ResolvedTheme = 'dark';

/** Called by the root theme owner before it renders its keyed subtree. */
export function setResolvedTheme(next: ResolvedTheme): void {
  resolvedTheme = next;
}

export function getResolvedTheme(): ResolvedTheme {
  return resolvedTheme;
}

/** Runtime palette. Property reads resolve against the current appearance. */
export const THEME: NeutronTheme = new Proxy({} as NeutronTheme, {
  get(_target, property: keyof NeutronTheme) {
    return (resolvedTheme === 'light' ? LIGHT_THEME : DARK_THEME)[property];
  },
  ownKeys: () => Reflect.ownKeys(DARK_THEME),
  getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
});

type NamedStyles<T> = { [P in keyof T]: ViewStyle | TextStyle | ImageStyle };

const paletteKeys = Object.keys(DARK_THEME) as (keyof NeutronTheme)[];

function rgbaReplacement(value: string): string | undefined {
  const match = /^rgba\((\d+),(\d+),(\d+),([\d.]+)\)$/.exec(value);
  if (match === null) return undefined;
  const sourceRgb = `${Number(match[1]).toString(16).padStart(2, '0')}${Number(match[2]).toString(16).padStart(2, '0')}${Number(match[3]).toString(16).padStart(2, '0')}`;
  const active = resolvedTheme === 'light' ? LIGHT_THEME : DARK_THEME;
  const inactive = resolvedTheme === 'light' ? DARK_THEME : LIGHT_THEME;
  for (const palette of [active, inactive]) {
    for (const key of paletteKeys) {
      if (palette[key].slice(1).toLowerCase() !== sourceRgb) continue;
      const color = THEME[key];
      const rgb = /^#(..)(..)(..)$/.exec(color);
      if (rgb === null) return color;
      return `rgba(${parseInt(rgb[1], 16)},${parseInt(rgb[2], 16)},${parseInt(rgb[3], 16)},${match[4]})`;
    }
  }
  return undefined;
}

function phaseReplacement(value: string): string | undefined {
  const active = resolvedTheme === 'light' ? LIGHT_PHASE : DARK_PHASE;
  const inactive = resolvedTheme === 'light' ? DARK_PHASE : LIGHT_PHASE;
  for (const phases of [active, inactive]) {
    for (const key of Object.keys(phases) as (keyof NeutronPhaseColors)[]) {
      for (const field of ['fg', 'bg'] as const) {
        if (value === phases[key][field]) return PHASE[key][field];
      }
    }
  }
  return undefined;
}

function resolvePaletteValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const resolvedRgba = rgbaReplacement(value);
  if (resolvedRgba !== undefined) return resolvedRgba;
  const resolvedPhase = phaseReplacement(value);
  if (resolvedPhase !== undefined) return resolvedPhase;
  const active = resolvedTheme === 'light' ? LIGHT_THEME : DARK_THEME;
  const inactive = resolvedTheme === 'light' ? DARK_THEME : LIGHT_THEME;
  for (const palette of [active, inactive]) {
    for (const key of paletteKeys) {
      const color = palette[key];
      if (value === color) return THEME[key];
      if (value.startsWith(color) && value.length > color.length) return THEME[key] + value.slice(color.length);
    }
  }
  return value;
}

function isPaletteValue(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return rgbaReplacement(value) !== undefined || phaseReplacement(value) !== undefined
    || paletteKeys.some((key) => value.startsWith(DARK_THEME[key]) || value.startsWith(LIGHT_THEME[key]));
}

/**
 * StyleSheet.create is an identity function in React Native, which means a
 * module-level color read normally freezes the startup palette. These getters
 * preserve the same style objects while resolving palette values at render.
 */
export function createThemedStyles<T extends NamedStyles<T> | NamedStyles<unknown>>(
  styles: T & NamedStyles<unknown>,
): T {
  for (const style of Object.values(styles) as Array<Record<string, unknown>>) {
    for (const property of Object.keys(style)) {
      const initial = style[property];
      if (!isPaletteValue(initial)) continue;
      Object.defineProperty(style, property, {
        enumerable: true,
        configurable: false,
        get: () => resolvePaletteValue(initial),
      });
    }
  }
  return StyleSheet.create(styles as NamedStyles<T>) as T;
}

/** One phase's tinted-capsule colors: solid foreground + a low-alpha background wash. */
export interface PhaseColor {
  fg: string;
  bg: string;
}

/**
 * M1 redesign — Work-list row phase colors (dot / tag). Mirror of the web
 * `cwb-tag-*` / `cwb-dot-*` CSS colors (`landing/chat-react/chat-react.html`);
 * the runtime proxy selects the matching light/dark pair with the core palette.
 * Keyed by the same coarse phase the row derives from `RunStepLabel`
 * (`merge` covers both the live "merging" step and the terminal "done"/merged
 * state — same green, mirroring the web `cwb-tag-merge` class reuse).
 */
export interface NeutronPhaseColors {
  build: PhaseColor;
  review: PhaseColor;
  fix: PhaseColor;
  merge: PhaseColor;
  failed: PhaseColor;
  /** BLOCKED is not FAILED — a build that stopped on purpose and needs a decision, not
   *  one that broke. Orange rather than red so the two never read as one state. */
  blocked: PhaseColor;
}

export const DARK_PHASE: NeutronPhaseColors = Object.freeze({
  build: { fg: '#8cc6ff', bg: 'rgba(140,198,255,0.14)' },
  review: { fg: '#a8a2ff', bg: 'rgba(168,162,255,0.14)' },
  fix: { fg: '#ffd27d', bg: 'rgba(255,210,125,0.14)' },
  merge: { fg: '#7ddf9b', bg: 'rgba(125,223,155,0.14)' },
  failed: { fg: '#ff8a8a', bg: 'rgba(255,138,138,0.14)' },
  blocked: { fg: '#ffa94d', bg: 'rgba(255,169,77,0.14)' },
});

export const LIGHT_PHASE: NeutronPhaseColors = Object.freeze({
  build: { fg: '#0b57d0', bg: 'rgba(11,87,208,.10)' },
  review: { fg: '#5b4bd6', bg: 'rgba(91,75,214,.12)' },
  fix: { fg: '#8a5f00', bg: 'rgba(138,95,0,.12)' },
  merge: { fg: '#146c2e', bg: 'rgba(20,108,46,.12)' },
  failed: { fg: '#c9252d', bg: 'rgba(201,37,45,.10)' },
  blocked: { fg: '#a14f00', bg: 'rgba(161,79,0,.12)' },
});

export const PHASE: NeutronPhaseColors = new Proxy({} as NeutronPhaseColors, {
  get(_target, property: keyof NeutronPhaseColors) {
    return (resolvedTheme === 'light' ? LIGHT_PHASE : DARK_PHASE)[property];
  },
});

export interface TypographyToken {
  fontSize: number;
  lineHeight: number;
  fontWeight?:
    | 'normal'
    | 'bold'
    | '100'
    | '200'
    | '300'
    | '400'
    | '500'
    | '600'
    | '700'
    | '800'
    | '900';
  fontFamily?: string;
}

export interface NeutronTypography {
  h1: TypographyToken;
  h2: TypographyToken;
  h3: TypographyToken;
  h4: TypographyToken;
  body: TypographyToken;
  body_small: TypographyToken;
  caption: TypographyToken;
  mono: TypographyToken;
}

/**
 * Cross-platform monospace stack. iOS + macOS resolve to Menlo, Android
 * picks system monospace, React Native Web honors the CSS fallback
 * chain. Computed at module-load without importing `react-native` so
 * the theme tokens stay loadable from pure-TS unit tests.
 */
const MONO_FAMILY: string = (() => {
  // RN platform detection without an import — RN tags `process.env`
  // and the global. In test runtimes we get the multi-fallback chain
  // (which is what react-native-web wants anyway).
  const g = globalThis as { navigator?: { product?: string } };
  if (g.navigator?.product === 'ReactNative') {
    // Best single-family choice across iOS + Android. Android falls
    // back to system monospace when Menlo is unavailable.
    return 'Menlo';
  }
  return 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
})();

export const TYPOGRAPHY: NeutronTypography = Object.freeze({
  h1: { fontSize: 22, lineHeight: 30, fontWeight: '700' as const },
  h2: { fontSize: 19, lineHeight: 26, fontWeight: '700' as const },
  h3: { fontSize: 17, lineHeight: 24, fontWeight: '600' as const },
  h4: { fontSize: 15, lineHeight: 22, fontWeight: '600' as const },
  body: { fontSize: 15, lineHeight: 22 },
  body_small: { fontSize: 13, lineHeight: 19 },
  caption: { fontSize: 11, lineHeight: 16 },
  mono: { fontSize: 14, lineHeight: 20, fontFamily: MONO_FAMILY },
});

export interface NeutronSpacing {
  xs: number;
  sm: number;
  md: number;
  lg: number;
  xl: number;
  xxl: number;
}

export const SPACING: NeutronSpacing = Object.freeze({
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
});

export interface NeutronMotion {
  /** Hover, micro-state transitions. */
  fast: number;
  /** Option-tap settle, button press. */
  base: number;
  /** Banner fade, message-arrival. */
  slow: number;
  /** Streaming-cursor pulse cycle (one full period). */
  pulse: number;
  /** Default easing curve identifier (passed to Animated.timing easing). */
  ease: 'ease-in-out';
}

export const MOTION: NeutronMotion = Object.freeze({
  fast: 150,
  base: 250,
  slow: 400,
  pulse: 600,
  ease: 'ease-in-out',
});

export interface NeutronDensity {
  bubble_radius: number;
  /** Message bubble maximum width as a percentage of the row. */
  bubble_max_width: '85%';
  composer_radius: number;
  /** Pill / chip radius (large enough to be fully rounded). */
  chip_radius: number;
  /** Banner top sticky region radius. */
  banner_radius: number;
}

export const DENSITY: NeutronDensity = Object.freeze({
  bubble_radius: 14,
  bubble_max_width: '85%',
  composer_radius: 12,
  chip_radius: 999,
  banner_radius: 8,
});

export interface NeutronBreakpoints {
  /**
   * Below this width (CSS px) on web targets, components render their
   * narrow / phone-shaped layout. At or above this width on web they
   * render the wide / desktop layout. Native targets always render the
   * narrow shape regardless of physical width. Single threshold by
   * design — adding more breakpoints requires a follow-up brief.
   */
  narrow_max: number;
}

export const BREAKPOINTS: NeutronBreakpoints = Object.freeze({
  narrow_max: 799,
});
