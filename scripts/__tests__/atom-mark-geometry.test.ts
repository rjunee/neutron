/**
 * The ⚛ mark's raster mirrors must not drift from `landing/favicon.svg`.
 *
 * WHY. The mark exists once as vector (`landing/favicon.svg`, geometry lifted
 * from `AtomMark()` in `landing/chat-react/ChatApp.tsx`) and several times as
 * committed PNG/ICO binaries. Binaries cannot be diffed by eye in review, so a
 * copy that stops matching is invisible until someone installs the app — which
 * is exactly how the mobile icon came to be teal concentric rings with a
 * satellite dot, a drawing no source in this repo produces (Ryan, 2026-07-30:
 * "make the app icon the same as our favicon. What is this weird icon you
 * made"). Every raster is now rendered from ONE set of numbers in
 * `scripts/lib/atom_mark.py`; this test pins those numbers to the SVG so a
 * change to one without the other fails here instead of on a phone.
 *
 * It deliberately does NOT rasterize: that would need Pillow in CI, and the
 * drift that actually bit us was in the NUMBERS, not the renderer.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const svg = readFileSync(join(ROOT, 'landing', 'favicon.svg'), 'utf8');
const py = readFileSync(join(ROOT, 'scripts', 'lib', 'atom_mark.py'), 'utf8');
const appJson = JSON.parse(readFileSync(join(ROOT, 'app', 'app.json'), 'utf8')) as {
  expo: {
    icon: string;
    splash: { image: string };
    android: {
      adaptiveIcon: { foregroundImage: string; backgroundImage: string; monochromeImage: string };
    };
  };
};

/** `NAME = value` out of the python geometry module. */
function pyNumber(name: string): number {
  const m = new RegExp(`^${name} = ([0-9.]+)`, 'm').exec(py);
  if (m === null) throw new Error(`scripts/lib/atom_mark.py has no ${name}`);
  return Number(m[1]);
}

describe('the atom mark geometry mirrors landing/favicon.svg', () => {
  it('uses the same viewBox', () => {
    expect(svg).toContain('viewBox="0 0 32 32"');
    expect(pyNumber('VIEWBOX')).toBe(32);
  });

  it('uses the same core radius', () => {
    const m = /<circle cx="16" cy="16" r="([0-9.]+)"/.exec(svg);
    expect(m).not.toBeNull();
    expect(pyNumber('CORE_RADIUS')).toBe(Number(m?.[1]));
  });

  it('uses the same orbit ellipse + stroke', () => {
    const ellipse = /<ellipse cx="16" cy="16" rx="([0-9.]+)" ry="([0-9.]+)" \/>/.exec(svg);
    expect(ellipse).not.toBeNull();
    const [rx, ry] = /^ORBIT_RX, ORBIT_RY = ([0-9.]+), ([0-9.]+)/m.exec(py)?.slice(1) ?? [];
    expect(Number(rx)).toBe(Number(ellipse?.[1]));
    expect(Number(ry)).toBe(Number(ellipse?.[2]));

    const stroke = /stroke-width="([0-9.]+)"/.exec(svg);
    expect(stroke).not.toBeNull();
    expect(pyNumber('ORBIT_STROKE')).toBe(Number(stroke?.[1]));
  });

  it('uses the same three orbit rotations', () => {
    const rotations = [...svg.matchAll(/transform="rotate\((\d+) 16 16\)"/g)].map((m) =>
      Number(m[1]),
    );
    expect(rotations).toEqual([60, 120]); // the third orbit is un-rotated
    expect(/^ORBIT_ROTATIONS = \(0, 60, 120\)$/m.test(py)).toBe(true);
  });

  it('uses the same palette + corner radius', () => {
    expect(svg).toContain('fill="#0b0e14"');
    expect(svg).toContain('fill="#4da3ff"');
    expect(svg).toContain('rx="7"');
    expect(py).toContain('BG = (0x0B, 0x0E, 0x14, 0xFF)');
    expect(py).toContain('ACCENT = (0x4D, 0xA3, 0xFF, 0xFF)');
    expect(pyNumber('CORNER_RADIUS')).toBe(7);
  });
});

describe('app.json points at the generated icon set', () => {
  const generated = readFileSync(join(ROOT, 'scripts', 'gen-app-icons.py'), 'utf8');

  it.each([
    ['icon', appJson.expo.icon],
    ['splash', appJson.expo.splash.image],
    ['adaptive foreground', appJson.expo.android.adaptiveIcon.foregroundImage],
    ['adaptive background', appJson.expo.android.adaptiveIcon.backgroundImage],
    ['adaptive monochrome', appJson.expo.android.adaptiveIcon.monochromeImage],
  ])('%s is produced by scripts/gen-app-icons.py', (_label, path) => {
    const basename = path.split('/').pop() ?? '';
    expect(basename.length).toBeGreaterThan(0);
    expect(generated).toContain(`"${basename}"`);
  });

  /** The `write(render_atom(...), "<name>")` call that produces `name`. */
  function writeCallFor(name: string): string {
    const at = generated.indexOf(`"${name}"`);
    expect(at).toBeGreaterThan(-1);
    const from = generated.lastIndexOf('write(', at);
    expect(from).toBeGreaterThan(-1);
    return generated.slice(from, at);
  }

  it('insets BOTH Android adaptive layers into the 66/108 safe circle', () => {
    // An orbit clipped by an OEM mask shape is the one adaptive-icon mistake
    // that only shows up on hardware, so the inset is asserted per LAYER rather
    // than trusted to a comment — or to the mere presence of the constant
    // somewhere in the file, which is satisfied even if one layer drops it.
    expect(py).toContain('ANDROID_SAFE_FRACTION = 66 / 108');
    expect(generated).toContain('SAFE_SCALE = ANDROID_SAFE_FRACTION / (MARK_EXTENT / VIEWBOX)');
    expect(writeCallFor('android-icon-foreground.png')).toContain('mark_scale=SAFE_SCALE');
    expect(writeCallFor('android-icon-monochrome.png')).toContain('mark_scale=SAFE_SCALE');
  });

  it('does NOT inset the iOS icon — the OS mask crops less, and alpha is rejected', () => {
    const ios = writeCallFor('icon.png');
    expect(ios).not.toContain('mark_scale');
    expect(ios).toContain('background=BG');
  });
});
