/**
 * @neutronai/app — the LIGHT and DARK palettes + typography / spacing / motion
 * tokens (P5.0 palette, P5.1 extensions).
 *
 * P5.0 locked a single dark palette so every component read colors from one
 * source. That was right about the source and wrong about the count: the owner
 * asked for light mode, so this module now exports TWO palettes of the SAME
 * shape ({@link NeutronTheme}) plus the resolution rules that pick between
 * them. There is no third state and no "legacy dark-only" path — a component
 * receives whichever palette is active and cannot tell which one it is.
 *
 * WHY THERE IS NO `THEME` CONSTANT ANY MORE. There used to be one, frozen, and
 * every component captured its colors at MODULE LOAD inside
 * `StyleSheet.create({...})`. A captured color cannot change, so a single such
 * capture left anywhere is a dark card sitting in a light screen. Removing the
 * export makes that a COMPILE error rather than a visual bug someone has to
 * notice on a device — components read the active palette per-render via
 * `useTheme()` (`lib/theme-context.tsx`) and build their sheets from it.
 *
 * Anti-pattern guard: no `react-native-paper`, no `@shopify/restyle`,
 * no `tailwind-rn`, no `nativewind`. Plain `StyleSheet.create` +
 * constants from this file only. Inline magic numbers in component
 * styles are forbidden — every spacing / radius / motion duration
 * MUST come from these tokens. If a new value is needed, add it here
 * first and reference the token from the component.
 *
 * CONTRAST IS A TEST, NOT AN INTENTION. Every token below that is drawn as TEXT
 * clears WCAG AA (4.5:1) against every ground it can land on — `background`,
 * `surface`, AND `surface_raised` — in BOTH palettes, and the ink on each bubble
 * fill clears it too. `__tests__/contrast.test.ts` computes those ratios from
 * these values (and from the web stylesheet's, so the two clients cannot
 * drift apart) and fails on a regression. Purely decorative tokens — the 1px
 * usage-meter bars, the rail activity dots, `hairline` — are held to the
 * non-text bar (3:1, WCAG 1.4.11) and are listed explicitly in that test.
 */

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
   * The OWNER's own chat bubble. Mirror of the web `--user-bubble` — the SAME hex
   * in both palettes, asserted in `__tests__/contrast.test.ts`. See NEUTRON_BLUE.
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

  // ── STATUS FAMILIES ───────────────────────────────────────────────────────
  //
  // Each family is a TRIPLE: ink + a low-contrast wash it is drawn on + the
  // border of that wash. They exist because the admin panes, the Cores screens,
  // the docs tab and the backup diff viewer all draw status callouts, and every
  // one of them had written its own dark hex inline — `#3b1212` for a danger
  // wash, `#0f2418` for a success one, `#bfdbfe` for info ink. Those are the
  // literals the theme conversion could not see (they never imported the
  // palette) and they are why those surfaces were unreadable in light mode.
  //
  // The INK tokens are TEXT and clear AA against `background`, `surface`,
  // `surface_raised` AND against their own wash — the wash is a ground, and it
  // is the ground most easily forgotten because it is the one introduced by the
  // same commit. `__tests__/contrast.test.ts` asserts all four.

  /** Success / healthy ink (a passing check, an "added" diff line). */
  success: string;
  /** The wash `success` is drawn on (callout card fill). */
  success_surface: string;
  /** Border of a `success_surface` card. */
  success_border: string;
  /** The wash `danger` is drawn on (error callout fill). */
  danger_surface: string;
  /** Border of a `danger_surface` card. */
  danger_border: string;
  /** A destructive BUTTON's fill — saturated, carries `danger_ink`. */
  danger_fill: string;
  /** Content drawn ON `danger_fill`. */
  danger_ink: string;
  /** Informational ink (a "changed" diff line, a hint callout). */
  info: string;
  /** The wash `info` is drawn on. */
  info_surface: string;
  /** Border of an `info_surface` card. */
  info_border: string;
  /** The wash `warning` is drawn on. */
  warning_surface: string;
  /** Border of a `warning_surface` card. */
  warning_border: string;
  /**
   * Drop-shadow colour. Black in both palettes — a shadow is an absence of
   * light, not a hue, and it is the one colour that legitimately does not
   * invert. It is a token anyway so that `shadowColor` stops being the single
   * exception a hardcoded-literal guard has to carve out.
   */
  shadow: string;

  // ── THE TWO DELIBERATELY THEME-INVARIANT FILLS ────────────────────────────
  //
  // Both are the SAME value in both palettes, and that is a decision rather than
  // an oversight, so each says why. They are tokens — not the inline `rgba(...)`
  // literals they replace — because "this one does not change" and "someone
  // forgot this one" are indistinguishable when the value is written at the call
  // site, and 20 call sites of the second kind is how the dark-only app got here.

  /**
   * Modal dim. A scrim's job is to push the page back, and it does that by
   * DARKENING in both themes — iOS dims a light sheet's backdrop with black too.
   * A light scrim over a light page would be invisible and a light scrim over a
   * dark one would flash.
   */
  scrim: string;
  /**
   * A dark veil over MEDIA — an image caption strip, a badge over a thumbnail.
   * An image is not one of this palette's grounds: its content is arbitrary, so
   * the only safe ink is light-on-dark regardless of theme.
   */
  veil: string;
  /**
   * Ink on `veil`. Fixed light in both palettes, for the reason above — reading
   * `text_primary` here was a real light-mode defect, because it is near-black in
   * light and the veil under it is not.
   */
  veil_ink: string;
}

/**
 * THE NEUTRON BLUE — the outgoing bubble fill, in BOTH palettes.
 *
 * Owner decision (2026-08-10): *"in dark mode, keep the white text in blue bubble
 * for user chat messages it's fine"*. So white ink on blue is the shape in both
 * themes, exactly as iMessage does it, and the only free variable is WHICH blue.
 *
 * It could not stay `#0a84ff`: white on that measures **3.65**, below the 4.5 AA
 * floor, and the light theme's `#007aff` was no better at 4.02. Honouring the
 * decision therefore means picking a blue that carries white legibly rather than
 * overriding the measurement — which is also what Apple does, whose dark bubble
 * (`#0b84ff`) is a different value from its accents.
 *
 * `#1064cc` is the same azure a few steps deeper, and it is the value that
 * satisfies all FIVE things this one hex has to do at once:
 *
 *   white ON it                      5.65   (bubble ink, both themes — AA 4.5)
 *   it ON light `background` #ffffff  5.65   (light link on the page)
 *   it ON light `surface` #f5f5f7     5.19   (light link on a card)
 *   it ON light `surface_raised`      4.66   (light link INSIDE an agent bubble)
 *   it ON dark `background` #101419   3.27   (the bubble's own edge — non-text 3:1)
 *
 * The fourth line is the one that is easy to miss and the reason this is not
 * `#1069d9` (which measures a failing 4.28 there): `markdown-render.tsx` paints
 * links with `link`, and markdown renders INSIDE agent bubbles, so a light-theme
 * link lands on `surface_raised` and not just on the page. The last line pulls
 * the opposite way — too dark and the owner's own bubble stops separating from
 * the dark ground — so the value is a genuine intersection, not a maximum.
 *
 * ONE hex for both palettes, deliberately: the outgoing bubble is the single
 * most recognisable object in the product, and a bubble that changed hue with
 * the theme would read as two different blues rather than one brand.
 *
 * The pale `#6cf` / `#5fb6ff` accents are NOT this and never become a fill —
 * they are dark-mode LINK colors, where their lightness is the whole point
 * (dark `link` measures 8.47 on `background`). A pale blue behind white ink is
 * the unreadable combination this token exists to avoid.
 */
export const NEUTRON_BLUE = '#1064cc';

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
  // LIFTED from #7c848f (2026-08-10). The old value measured 4.89 on `background`,
  // 4.48 on `surface` and 3.91 on `surface_raised` — i.e. it failed AA on two of
  // the three grounds it actually lands on, which is the "ours is more difficult
  // to read" the owner reported next to Telegram. Now 6.28 / 5.76 / 5.02.
  text_muted: '#8f97a5',
  accent: '#e0e0e0',
  hairline: '#2b3240',
  danger: '#ff5c5c',
  warning: '#ffae42',
  link: '#5fb6ff',
  // THE NEUTRON BLUE — see NEUTRON_BLUE.
  user_bubble: NEUTRON_BLUE,
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
  // Status families. Inks measured against background / surface / surface_raised
  // / own wash: success 11.35 / 10.41 / 9.08 / 9.88, info 10.24 / 9.39 / 8.19 /
  // 8.91, warning (reuses `warning` above) 10.02 / 9.19 / 8.01 / 8.53, danger
  // (reuses `danger`) 6.11 / 5.60 / 4.88 / 5.65.
  success: '#7ddf9b',
  success_surface: '#12251a',
  success_border: '#1f5133',
  danger_surface: '#2e1416',
  danger_border: '#7a2c2c',
  danger_fill: '#8f2222',
  danger_ink: '#ffffff',
  info: '#8cc6ff',
  info_surface: '#132234',
  info_border: '#2a4a70',
  warning_surface: '#2c2113',
  warning_border: '#5f4a1f',
  shadow: '#000000',
  scrim: 'rgba(0,0,0,0.6)',
  veil: 'rgba(0,0,0,0.7)',
  veil_ink: '#ffffff',
});

/**
 * THE LIGHT RAMP (owner request 2026-08-10: *"I want fucking light mode on the
 * mobile app … for the chat interface model the colors after iMessage but use our
 * own Neutron blue"*).
 *
 * Same shape, same token names, same MEANINGS — only the values invert. The
 * surfaces are taken from the web chat's light theme (`--bg #ffffff`,
 * `--surface #f5f5f7`, `--agent-bubble #e9e9eb`) so a phone and a browser
 * showing light mode look like one product, and `surface_raised` is deliberately
 * the iMessage incoming-bubble grey — on this client that token IS the agent
 * bubble, so the two facts want the same value.
 *
 * The ramp runs the other way (background is the LIGHTEST step here, the darkest
 * step in dark) and every text token is chosen for its measured ratio against
 * all three grounds, not by eye:
 *
 *   text_primary  17.01 / 15.63 / 14.03   text_secondary  10.55 / 9.69 / 8.70
 *   text_muted     5.77 /  5.30 /  4.76   danger           5.55 / 5.09 / 4.57
 *   warning        5.65 /  5.19 /  4.66   link             5.65 / 5.19 / 4.66
 *
 * The `surface_raised` column is the one that does the work here: it is the agent
 * bubble, markdown renders inside it, so `text_muted` and `link` have to clear AA
 * on a grey — not merely on white, which is the easy case and the one an eyeball
 * check would have stopped at.
 */
export const LIGHT_THEME: NeutronTheme = Object.freeze({
  background: '#ffffff',
  surface: '#f5f5f7',
  // The iMessage incoming-bubble grey. On this client `surface_raised` IS the
  // agent bubble, so "one step up from the ground" and "the grey iMessage uses"
  // are the same requirement.
  surface_raised: '#e9e9eb',
  // Not pure black, for the mirror-image reason `text_primary` is not pure white
  // in dark: #000 on white is harsher than the ink it imitates.
  text_primary: '#1c1c1e',
  text_secondary: '#3a3f4a',
  text_muted: '#62666d',
  // THE NEUTRAL POLE, mirroring dark's near-white `#e0e0e0`. On this client
  // `accent` is not the brand blue — it is the high-contrast neutral that
  // primary buttons fill with and that `background` is drawn ON (see
  // `lib/button-primitives.tsx`: `btnPrimary` fills with `accent`,
  // `btnTextPrimary` inks with `background`). Inverting the pole keeps that
  // pairing correct without touching a single component: white on #14171c
  // measures 17.96, the mirror of #101419 on #e0e0e0.
  accent: '#14171c',
  hairline: '#d1d1d6',
  danger: '#c9252d',
  // Amber is the one hue that cannot survive the inversion unchanged: dark's
  // #ffae42 measures 1.80 on white. This is the same warning, darkened until it
  // is legible as TEXT (5.65 / 5.19 / 4.66) while still reading amber, not brown.
  warning: '#8a5f00',
  link: NEUTRON_BLUE,
  user_bubble: NEUTRON_BLUE,
  user_ink: '#ffffff',
  // Selection by HUE, same principle as dark — a pale blue wash that is
  // unmistakably not `surface`, carrying `text_primary` at 14.6:1. The dark
  // theme darkens the blue to separate from a dark ground; light lightens it.
  rail_selected: '#cfe3ff',
  work: NEUTRON_BLUE,
  // DECORATIVE, and deliberately NOT re-derived for contrast. This is a 6px dot.
  // Owner decision (FIX #345) rejected a darker amber here as "a muddy brown";
  // the value is his. It measures 2.28 on white, below even the 3:1 non-text bar,
  // so the contrast test lists it as an explicit documented exemption rather than
  // silently passing — see `__tests__/contrast.test.ts` DECORATIVE_EXEMPT.
  attention: '#e0a020',
  usage_nominal: '#1a7f37',
  usage_warning: '#b07407',
  usage_critical: '#c9252d',
  // Status families, light. Inks measured against background / surface /
  // surface_raised / own wash: success 6.53 / 5.99 / 5.39 / 5.79, info 6.39 /
  // 5.87 / 5.27 / 5.57, warning 5.65 / 5.19 / 4.66 / 5.13, danger 5.55 / 5.09 /
  // 4.57 / 4.79.
  //
  // `success` is NOT `usage_nominal`'s #1a7f37, which is the one value that
  // looked obviously fine and was not: it measures 4.19 on `surface_raised`, so
  // an "added" diff line inside a raised card would have failed AA. Darkened
  // until it clears every ground, which is a step the eye does not take.
  success: '#146c2e',
  success_surface: '#e3f6e8',
  success_border: '#a6ddb5',
  danger_surface: '#fdeaea',
  danger_border: '#f0b4b4',
  danger_fill: '#c9252d',
  danger_ink: '#ffffff',
  info: '#0b57d0',
  info_surface: '#e8f0fe',
  info_border: '#adc9f5',
  warning_surface: '#fdf3e0',
  warning_border: '#e3c68a',
  shadow: '#000000',
  // Same values as dark, deliberately — see the token docs.
  scrim: 'rgba(0,0,0,0.6)',
  veil: 'rgba(0,0,0,0.7)',
  veil_ink: '#ffffff',
});

/** One phase's tinted-capsule colors: solid foreground + a low-alpha background wash. */
export interface PhaseColor {
  fg: string;
  bg: string;
}

/**
 * M1 redesign — Work-list row phase colors (dot / tag). Mirror of the web
 * `--phase-*` CSS tokens in `landing/chat-react.html`, which have had a light
 * pair since the light theme shipped there; mobile now needs the same pair
 * rather than one literal set (the docblock here used to say "mobile is
 * dark-only", which stopped being true on 2026-08-10).
 *
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
}

export const DARK_PHASE: NeutronPhaseColors = Object.freeze({
  build: { fg: '#8cc6ff', bg: 'rgba(140,198,255,0.14)' },
  review: { fg: '#a8a2ff', bg: 'rgba(168,162,255,0.14)' },
  fix: { fg: '#ffd27d', bg: 'rgba(255,210,125,0.14)' },
  merge: { fg: '#7ddf9b', bg: 'rgba(125,223,155,0.14)' },
  failed: { fg: '#ff8a8a', bg: 'rgba(255,138,138,0.14)' },
});

/**
 * The light pair. A phase tag is TEXT on a low-alpha wash of its own hue, so each
 * `fg` has to clear AA against the light grounds the wash sits on — the dark set's
 * pastels measure under 2:1 on white and would be unreadable. `fix` is the amber
 * again, darkened to `#8a5f00` for the same reason `LIGHT_THEME.warning` is.
 * Mirrors the web `:root[data-theme="light"]` `--phase-*-fg` values.
 */
export const LIGHT_PHASE: NeutronPhaseColors = Object.freeze({
  build: { fg: '#0b57d0', bg: 'rgba(11,87,208,0.10)' },
  review: { fg: '#5b4bd6', bg: 'rgba(91,75,214,0.12)' },
  fix: { fg: '#8a5f00', bg: 'rgba(138,95,0,0.12)' },
  merge: { fg: '#1a7f37', bg: 'rgba(26,127,55,0.12)' },
  failed: { fg: '#c9252d', bg: 'rgba(201,37,45,0.10)' },
});

/**
 * WHAT THE OWNER PICKED. Mirrors `landing/chat-react/theme.ts` exactly — same
 * three states, same default, same rule — so the phone and the browser cannot
 * disagree about what "system" means.
 */
export type ThemePreference = 'light' | 'dark' | 'system';

/** The concrete scheme actually painted. `system` never reaches a component. */
export type ResolvedTheme = 'light' | 'dark';

/** Absent / unrecognised preference follows the OS. */
export const DEFAULT_PREFERENCE: ThemePreference = 'system';

/** Type guard for a value read back out of storage. */
export function isThemePreference(v: unknown): v is ThemePreference {
  return v === 'light' || v === 'dark' || v === 'system';
}

/**
 * THE ONE SELECTION RULE. An explicit `light`/`dark` wins outright — it is an
 * override, so it must NOT be shadowed by the OS scheme; `system` (and anything
 * unrecognised) follows `osScheme`, and a platform that reports nothing
 * (`useColorScheme()` returns null before the first native read) is treated as
 * dark, which is where this app has always started.
 */
export function resolveTheme(
  pref: ThemePreference,
  osScheme: ResolvedTheme | null,
): ResolvedTheme {
  if (pref === 'light') return 'light';
  if (pref === 'dark') return 'dark';
  return osScheme === 'light' ? 'light' : 'dark';
}

/** Everything a resolved scheme carries. One object so a component takes one hook. */
export interface NeutronPalette {
  scheme: ResolvedTheme;
  colors: NeutronTheme;
  phase: NeutronPhaseColors;
}

export const DARK_PALETTE: NeutronPalette = Object.freeze({
  scheme: 'dark' as const,
  colors: DARK_THEME,
  phase: DARK_PHASE,
});

export const LIGHT_PALETTE: NeutronPalette = Object.freeze({
  scheme: 'light' as const,
  colors: LIGHT_THEME,
  phase: LIGHT_PHASE,
});

/** The palette for a resolved scheme. */
export function paletteFor(scheme: ResolvedTheme): NeutronPalette {
  return scheme === 'light' ? LIGHT_PALETTE : DARK_PALETTE;
}

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

/**
 * THE SCALE, RAISED ONE STEP (owner feedback 2026-08-07, comparing us to Telegram:
 * its text is *"brighter and more vivid and easier to read"*, ours *"more
 * difficult"* — he asked for a larger size).
 *
 * `body` was 15/22 against Telegram's ~17. Everything moves with it rather than
 * body alone: a 17px body under a 15px `h4` inverts the hierarchy, and captions
 * left at 11 would read as fine print next to it. So the whole ramp shifts +2 and
 * the line-heights go with it, keeping the ~1.45 body / ~1.35 heading rhythm the
 * P5.1 scale established. The web stylesheet moves the same amount in the same
 * commit (`landing/chat-react.html` `body { font: 17px/… }`) so the two clients
 * still agree — that agreement is asserted in `__tests__/type-scale.test.ts`.
 */
export const TYPOGRAPHY: NeutronTypography = Object.freeze({
  h1: { fontSize: 24, lineHeight: 32, fontWeight: '700' as const },
  h2: { fontSize: 21, lineHeight: 28, fontWeight: '700' as const },
  h3: { fontSize: 19, lineHeight: 26, fontWeight: '600' as const },
  h4: { fontSize: 17, lineHeight: 24, fontWeight: '600' as const },
  body: { fontSize: 17, lineHeight: 25 },
  body_small: { fontSize: 15, lineHeight: 21 },
  caption: { fontSize: 13, lineHeight: 18 },
  mono: { fontSize: 15, lineHeight: 22, fontFamily: MONO_FAMILY },
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
