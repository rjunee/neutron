/**
 * The ⚛ mark's copies must not drift from `landing/favicon.svg`.
 *
 * WHY. The mark exists once as vector (`landing/favicon.svg`) and several times as
 * committed PNG/ICO binaries, plus a second SVG at `landing/logo.svg`. Binaries
 * cannot be diffed by eye in review, so a copy that stops matching is invisible
 * until someone installs the app — which is exactly how the mobile icon came to be
 * teal concentric rings with a satellite dot, a drawing no source in this repo
 * produces (Ryan, 2026-07-30: "make the app icon the same as our favicon. What is
 * this weird icon you made"). Every raster is now rendered from ONE set of numbers
 * in `scripts/lib/atom_mark.py`; this test pins those numbers to the SVG so a
 * change to one without the other fails here instead of on a phone.
 *
 * It deliberately does NOT rasterize: that would need Pillow in CI, and the drift
 * that actually bit us was in the NUMBERS, not the renderer. Where a number
 * carries a DESIGN decision rather than just a value, the ratio is asserted
 * alongside it — see the nucleus-clearance test, which is the one assertion here
 * that would have caught the 2026-08-10 blob before it shipped.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const svg = readFileSync(join(ROOT, 'landing', 'favicon.svg'), 'utf8');
const logo = readFileSync(join(ROOT, 'landing', 'logo.svg'), 'utf8');
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

/**
 * A numeric constant out of the python geometry module, whether it is declared
 * alone (`CORE_RADIUS = 2.8`) or as one half of the tuple assignment the module
 * uses for the ellipse (`ORBIT_RX, ORBIT_RY = 11.5, 6.2`).
 */
function pyNumber(name: string): number {
  const solo = new RegExp(`^${name} = ([0-9.]+)`, 'm').exec(py);
  if (solo !== null) return Number(solo[1]);
  const pair = /^(\w+), (\w+) = ([0-9.]+), ([0-9.]+)$/m.exec(py);
  if (pair?.[1] === name) return Number(pair[3]);
  if (pair?.[2] === name) return Number(pair[4]);
  throw new Error(`scripts/lib/atom_mark.py has no ${name}`);
}

/** Everything an SVG actually PAINTS: `<rect …>` through `</svg>`. */
function drawing(source: string): string {
  const from = source.indexOf('<rect');
  expect(from).toBeGreaterThan(-1);
  return source.slice(from).trim();
}

describe('the atom mark geometry mirrors landing/favicon.svg', () => {
  it('uses the same viewBox', () => {
    expect(svg).toContain('viewBox="0 0 32 32"');
    expect(pyNumber('VIEWBOX')).toBe(32);
  });

  it('uses the same core radius', () => {
    const m = /<circle cx="16" cy="16" r="([0-9.]+)"/.exec(svg);
    expect(m).not.toBeNull();
    expect(Number(m?.[1])).toBe(2.8);
    expect(pyNumber('CORE_RADIUS')).toBe(Number(m?.[1]));
  });

  it('uses the same orbit ellipse + stroke', () => {
    const ellipse = /<ellipse cx="16" cy="16" rx="([0-9.]+)" ry="([0-9.]+)" \/>/.exec(svg);
    expect(ellipse).not.toBeNull();
    expect([Number(ellipse?.[1]), Number(ellipse?.[2])]).toEqual([11.5, 6.2]);
    const [rx, ry] = /^ORBIT_RX, ORBIT_RY = ([0-9.]+), ([0-9.]+)/m.exec(py)?.slice(1) ?? [];
    expect(Number(rx)).toBe(Number(ellipse?.[1]));
    expect(Number(ry)).toBe(Number(ellipse?.[2]));

    const stroke = /stroke-width="([0-9.]+)"/.exec(svg);
    expect(stroke).not.toBeNull();
    expect(Number(stroke?.[1])).toBe(2.5);
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

  it('paints the nucleus AFTER the orbits, as the raster renderer does', () => {
    // `render_master` composites the orbit layers and then fills the core on top.
    // The SVG used to declare the core FIRST, so its paint order was the inverse of
    // its own raster mirror's — invisible only because both are the same flat
    // colour, and a trap the moment either gains opacity or a second hue.
    expect(svg.indexOf('<circle')).toBeGreaterThan(svg.indexOf('</g>'));
    expect(py.indexOf('# Solid core last')).toBeGreaterThan(py.indexOf('for angle in'));
  });
});

describe('the nucleus reads as a nucleus', () => {
  /**
   * THE design assertion, not a value assertion. `CORE_ORBIT_GAP` is the ring of
   * tile background between the core and the orbits' inner edge; it is the whole
   * difference between "nucleus with orbits around it" and a lump. Before
   * 2026-08-10 it was 0.40 viewBox units — 0.2 device px at a 16px favicon — so the
   * core and all three orbits fused and NO nucleus was visible at any size, right
   * up to 1024px launcher. Nothing failed, because every number was individually
   * self-consistent and the test only compared them to each other.
   */
  it('keeps real background clearance between the core and the orbits', () => {
    expect(py).toContain('CORE_ORBIT_GAP = ORBIT_RY - ORBIT_STROKE / 2 - CORE_RADIUS');
    const gap = pyNumber('ORBIT_RY') - pyNumber('ORBIT_STROKE') / 2 - pyNumber('CORE_RADIUS');
    // >= 1.5 units is >= 0.75 device px at 16px and >= 48 px at 1024px: visible at
    // the favicon size, generous at the launcher size. The old numbers gave 0.40.
    expect(gap).toBeGreaterThanOrEqual(1.5);
  });

  it('keeps the orbits reading as strokes, not lozenges', () => {
    // At 53% (the old 2.6/4.9) the stroke is so heavy relative to the minor radius
    // that the ellipse has no ring quality left and the six outer voids pinch shut.
    expect(pyNumber('ORBIT_STROKE') / pyNumber('ORBIT_RY')).toBeLessThanOrEqual(0.42);
  });

  it('keeps the orbits above the 16px tab-slot floor the serving test already sets', () => {
    // The floor is 1.2 device px and it is NOT invented here: it belongs to
    // `landing/__tests__/favicon-serving.test.ts`, which set it after the icon that
    // shipped broken on 2026-07-18 drew 1.067 px on transparency and read as "no
    // favicon". Opening up the mark for large sizes means thinning the stroke, and
    // the first draft of this pass went to 1.00 px — BELOW the value already known
    // to fail — which that test caught. So the same number is asserted here against
    // the python mirror, and read out of the serving test rather than retyped, so
    // the two gates cannot drift into disagreeing about the floor.
    const serving = readFileSync(
      join(ROOT, 'landing', '__tests__', 'favicon-serving.test.ts'),
      'utf8',
    );
    const floor = /expect\(devicePx\)\.toBeGreaterThanOrEqual\(([\d.]+)\)/.exec(serving);
    expect(floor).not.toBeNull();
    const devicePxFloor = Number(floor?.[1]);
    expect(devicePxFloor).toBeGreaterThan(1.067); // above the value known to fail

    // The python mirror carries the same floor DERIVED, not retyped, so there is one
    // number in the repo and this assertion is what ties the two files to it.
    expect(py).toContain('MIN_ORBIT_STROKE = 1.2 / (16 / VIEWBOX)');
    expect(pyNumber('ORBIT_STROKE') * (16 / pyNumber('VIEWBOX'))).toBeGreaterThanOrEqual(
      devicePxFloor,
    );
  });

  it('leaves the mark a margin inside its tile', () => {
    const extent = pyNumber('ORBIT_RX') + pyNumber('ORBIT_STROKE') / 2;
    expect(extent).toBeLessThanOrEqual(0.8 * pyNumber('VIEWBOX')); // <= 12.8 of 32
  });
});

describe('landing/logo.svg is the same mark, not a second one', () => {
  /**
   * It held the drawing Ryan rejected on 2026-07-30 — teal #6fe3d4 concentric rings
   * with a satellite dot — for eleven days AFTER the app icons were regenerated
   * from the ⚛ mark, live the whole time on the onboarding page. A rejected design
   * left in the tree is the likeliest thing for the next change to pick up.
   */
  it('paints byte-identically to landing/favicon.svg', () => {
    expect(drawing(logo)).toBe(drawing(svg));
  });

  it('differs from the favicon only in rendered size', () => {
    expect(logo).toContain('viewBox="0 0 32 32"');
    expect(logo).toContain('width="512" height="512"');
  });

  it('carries none of the rejected drawing', () => {
    // Scoped to what each file PAINTS, not to its whole text: both docblocks name
    // the rejected teal in order to explain why it must not come back, and an
    // assertion that forbids describing a mistake also forbids documenting it.
    for (const source of [logo, svg]) {
      expect(drawing(source)).not.toContain('#6fe3d4'); // the rejected teal
      expect(drawing(source)).not.toMatch(/<circle[^>]*\br="1(12|76)"/); // its rings
    }
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

  it('tints the monochrome layer white and leaves it on transparency', () => {
    // Android 13+ themed icons are re-tinted by the system from a white silhouette;
    // shipping the blue accent here makes the themed icon render as a blue-on-blue
    // smudge on exactly the launchers that opted into theming.
    const mono = writeCallFor('android-icon-monochrome.png');
    expect(mono).toContain('accent=WHITE');
    expect(mono).not.toContain('background=');
  });

  it('does NOT inset the iOS icon — the OS mask crops less, and alpha is rejected', () => {
    const ios = writeCallFor('icon.png');
    expect(ios).not.toContain('mark_scale');
    expect(ios).toContain('background=BG');
  });
});
