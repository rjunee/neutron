/**
 * @neutronai/app — WCAG contrast maths, and the web stylesheet's palettes.
 *
 * Shared by `contrast.test.ts` (the gate) and `contrast-gate-selfcheck.test.ts`
 * (the proof that the gate can fail). Kept out of `app/lib/` deliberately: this is
 * test apparatus, not something a component should be able to import — a
 * component that needs to compute a contrast ratio at runtime is a design bug.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** One theme's tokens, keyed WITHOUT the leading `--`. */
export type ColorSurface = Record<string, string | undefined>;

/** sRGB channel -> linear light, per WCAG 2.1 relative-light. */
function channel(v: number): number {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Accepts `#rgb` and `#rrggbb`. Throws on anything else, rather than returning a
 *  number for input it did not understand — a silent 0 here would make a failing
 *  pair look like a passing one. */
export function wcagLuma(hex: string): number {
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-f]{6}$/i.test(h)) {
    throw new Error(`not a hex colour: ${JSON.stringify(hex)}`);
  }
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG 2.1 contrast ratio, 1..21. Order-independent. */
export function contrastRatio(a: string, b: string): number {
  const la = wcagLuma(a);
  const lb = wcagLuma(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/** Absolute path to `landing/chat-react.html`, resolved from THIS file so the
 *  test does not depend on the runner's working directory. */
function webStylesheetPath(): string {
  // .../app/__tests__/support -> repo root
  const here = dirname(new URL(import.meta.url).pathname);
  return join(here, '..', '..', '..', 'landing', 'chat-react.html');
}

/**
 * The web chat's two palettes, read out of its stylesheet.
 *
 * `:root` holds dark (the historical default) and `:root[data-theme="light"]`
 * OVERRIDES a subset of the same names — so light is the dark block with the
 * override applied on top, exactly as the cascade resolves it. Getting that
 * inheritance wrong in the parser would test a palette the browser never renders.
 *
 * Only hex values are kept. The `rgba(...)` tints are washes over another colour,
 * so a flat two-colour ratio is not the right measurement for them and reporting
 * one would be worse than reporting none.
 */
export function parseWebThemes(): { dark: ColorSurface; light: ColorSurface } {
  const css = readFileSync(webStylesheetPath(), 'utf8');

  const block = (selector: string): string => {
    const at = css.indexOf(selector);
    if (at === -1) throw new Error(`selector not found in stylesheet: ${selector}`);
    const open = css.indexOf('{', at);
    const close = css.indexOf('\n  }', open);
    if (open === -1 || close === -1) throw new Error(`unterminated block: ${selector}`);
    return css.slice(open, close);
  };

  const varsOf = (selector: string): ColorSurface => {
    const out: ColorSurface = {};
    for (const m of block(selector).matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g)) {
      const value = m[2]!.trim();
      if (value.startsWith('#')) out[m[1]!] = value;
    }
    return out;
  };

  const dark = varsOf(':root {');
  const light = { ...dark, ...varsOf(':root[data-theme="light"] {') };
  return { dark, light };
}
