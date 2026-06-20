/**
 * @neutronai/app — locked dark palette + typography / spacing / motion
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
}

export const THEME: NeutronTheme = Object.freeze({
  background: '#0a0a0a',
  surface: '#121212',
  surface_raised: '#1a1a1a',
  text_primary: '#ffffff',
  text_secondary: '#cfcfcf',
  text_muted: '#8a8a8a',
  accent: '#e0e0e0',
  hairline: '#1f1f1f',
  danger: '#ff5c5c',
  warning: '#ffae42',
  link: '#5fb6ff',
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
