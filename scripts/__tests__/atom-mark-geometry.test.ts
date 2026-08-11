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
 * IT ALSO READS THE COMMITTED PIXELS, and it has to. The previous version asserted
 * only on source text, and said so proudly: "the drift that actually bit us was in
 * the NUMBERS, not the renderer." That was wrong twice over in the same commit.
 *
 *   1. The renderer WAS the drift. Pillow strokes an ellipse inside its bounding box
 *      while SVG centres the stroke, so every generated PNG came out a half-stroke
 *      tighter than this repo's own vector source: the nucleus gap computed as 2.15
 *      viewBox units and MEASURED 0.90 in the binaries that shipped. A suite that
 *      compares constants to constants cannot see a rasteriser, and this one gave a
 *      green run to icons that had the exact defect its headline test was named for.
 *   2. The anti-regression guard for the REJECTED teal artwork read two SVG files, so
 *      it passed green while landing/apple-touch-icon.png — the iOS home-screen icon,
 *      served and declared in the webmanifest — still contained that very drawing.
 *
 * So the rule this file now follows: an assertion about what the mark LOOKS LIKE is
 * made against a decoded PNG, and only assertions about what the SOURCES AGREE ON are
 * made against text. Decoding needs no dependency — `node:zlib` plus ~40 lines is
 * enough for the truecolour PNGs the generators emit, which is a much smaller price
 * than the class of bug it catches.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

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
 * A LITERAL numeric constant out of the python geometry module, whether it is declared
 * alone (`CORE_RADIUS = 2.3`) or as one half of the tuple assignment the module uses
 * for the ellipse (`ORBIT_RX, ORBIT_RY = 11.4, 5.4`).
 *
 * Both patterns are anchored at BOTH ends, and that is the whole point. The previous
 * version anchored only the start, so `MIN_ORBIT_STROKE = 1.2 / (16 / VIEWBOX)`
 * matched the "solo" branch and returned 1.2 — silently, as a plausible number,
 * instead of the 2.4 the expression evaluates to. Its tuple branch was worse: it
 * matched the FIRST tuple assignment anywhere in the file and only then compared
 * names, so inserting an unrelated pair above the ellipse would have made every
 * ellipse lookup throw. A derived constant must THROW here rather than be guessed at;
 * assert on its text, or evaluate it in the test.
 */
function pyNumber(name: string): number {
  const solo = new RegExp(`^${name} = ([0-9.]+)\\s*$`, 'm').exec(py);
  if (solo !== null) return Number(solo[1]);
  const first = new RegExp(`^${name}, \\w+ = ([0-9.]+), [0-9.]+\\s*$`, 'm').exec(py);
  if (first !== null) return Number(first[1]);
  const second = new RegExp(`^\\w+, ${name} = [0-9.]+, ([0-9.]+)\\s*$`, 'm').exec(py);
  if (second !== null) return Number(second[1]);
  throw new Error(`scripts/lib/atom_mark.py has no literal ${name}`);
}

/** Everything an SVG actually PAINTS: `<rect …>` through `</svg>`. */
function drawing(source: string): string {
  const from = source.indexOf('<rect');
  expect(from).toBeGreaterThan(-1);
  return source.slice(from).trim();
}

interface Pixels {
  readonly width: number;
  readonly height: number;
  /** `[r, g, b, a]`, alpha 255 for images with no alpha channel. */
  at(x: number, y: number): [number, number, number, number];
}

/**
 * Decode a committed PNG to pixels. Handles 8-bit greyscale/RGB/RGBA — everything the
 * Pillow generators emit — and throws on anything else rather than guessing, because a
 * decoder that silently mis-reads a format turns every assertion below into a
 * false negative that looks exactly like a pass.
 */
function readPng(...parts: string[]): Pixels {
  const buf = readFileSync(join(ROOT, ...parts));
  expect(buf.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a'); // PNG magic
  let width = 0;
  let height = 0;
  let depth = 0;
  let colourType = -1;
  const idat: Buffer[] = [];
  for (let off = 8; off + 8 <= buf.length; ) {
    const length = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data.readUInt8(8);
      colourType = data.readUInt8(9);
      expect(data.readUInt8(12)).toBe(0); // interlace: none (Adam7 is not handled)
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + length;
  }
  const channels = colourType === 6 ? 4 : colourType === 2 ? 3 : colourType === 0 ? 1 : -1;
  if (channels < 0 || depth !== 8) {
    throw new Error(`unsupported PNG: colourType=${colourType} depth=${depth}`);
  }

  // Un-filter the inflated scanlines in place (PNG filters 0-4, per spec). Every byte is
  // read through readUInt8 rather than `[i]`: `noUncheckedIndexedAccess` types index
  // access as `number | undefined`, and the honest fix is a read that throws on a
  // truncated buffer rather than a cast that lets `undefined` into the arithmetic.
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw.readUInt8(p);
    p += 1;
    const line = raw.subarray(p, p + stride);
    p += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prior = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur.readUInt8(i - channels) : 0;
      const b = prior ? prior.readUInt8(i) : 0;
      const c = prior && i >= channels ? prior.readUInt8(i - channels) : 0;
      let v = line.readUInt8(i);
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur.writeUInt8(v & 0xff, i);
    }
  }

  return {
    width,
    height,
    at(x, y) {
      const i = y * stride + x * channels;
      if (channels === 1) {
        const grey = out.readUInt8(i);
        return [grey, grey, grey, 255];
      }
      if (channels === 3) {
        return [out.readUInt8(i), out.readUInt8(i + 1), out.readUInt8(i + 2), 255];
      }
      return [
        out.readUInt8(i),
        out.readUInt8(i + 1),
        out.readUInt8(i + 2),
        out.readUInt8(i + 3),
      ];
    },
  };
}

/** Is this pixel painted at all (i.e. not fully transparent)? */
function painted(px: [number, number, number, number]): boolean {
  return px[3] > 8;
}

/** Is this pixel the accent, rather than tile background or an antialiased blend? */
function isAccent([r, g, b, a]: [number, number, number, number]): boolean {
  return a > 128 && Math.abs(r - 0x4d) + Math.abs(g - 0xa3) + Math.abs(b - 0xff) < 200;
}

/**
 * The nucleus→orbit background gap MEASURED on a committed image, in viewBox units:
 * walk up the vertical centre line, off the core, and across the background ring to
 * the nearest orbit. `markScale` accounts for layers inset into the Android safe
 * circle, whose viewBox unit is correspondingly smaller.
 */
function measureCoreOrbitGap(image: Pixels, markScale = 1): number {
  const cx = Math.floor(image.width / 2);
  let y = Math.floor(image.height / 2);
  while (y > 0 && isAccent(image.at(cx, y))) y--; // walk off the nucleus
  const coreEdge = y;
  while (y > 0 && !isAccent(image.at(cx, y))) y--; // cross the background ring
  return (coreEdge - y) / ((image.height / 32) * markScale);
}

describe('the atom mark geometry mirrors landing/favicon.svg', () => {
  it('uses the same viewBox', () => {
    expect(svg).toContain('viewBox="0 0 32 32"');
    expect(pyNumber('VIEWBOX')).toBe(32);
  });

  it('uses the same core radius', () => {
    const m = /<circle cx="16" cy="16" r="([0-9.]+)"/.exec(svg);
    expect(m).not.toBeNull();
    expect(Number(m?.[1])).toBe(2.3);
    expect(pyNumber('CORE_RADIUS')).toBe(Number(m?.[1]));
  });

  it('uses the same orbit ellipse + stroke', () => {
    const ellipse = /<ellipse cx="16" cy="16" rx="([0-9.]+)" ry="([0-9.]+)" \/>/.exec(svg);
    expect(ellipse).not.toBeNull();
    expect([Number(ellipse?.[1]), Number(ellipse?.[2])]).toEqual([11.4, 5.4]);
    expect(pyNumber('ORBIT_RX')).toBe(Number(ellipse?.[1]));
    expect(pyNumber('ORBIT_RY')).toBe(Number(ellipse?.[2]));

    const stroke = /stroke-width="([0-9.]+)"/.exec(svg);
    expect(stroke).not.toBeNull();
    expect(Number(stroke?.[1])).toBe(2.6);
    expect(pyNumber('ORBIT_STROKE')).toBe(Number(stroke?.[1]));
  });

  it('centres the raster stroke, because SVG centres it', () => {
    // The ONE line that made the shipped PNGs disagree with this repo's own vector
    // source for eleven days. Pillow strokes inside the bbox, so `render_master` has
    // to grow the bbox by half the stroke; drop that and the whole mark comes out a
    // half-stroke tight, with the nucleus gap 0.50 units instead of 1.80 — while
    // every text-only assertion in this file still passes.
    expect(py).toContain('grow = ORBIT_STROKE / 2');
    expect(py).toContain('cy - (ORBIT_RY + grow) * unit');
    expect(py).toContain('cx - (ORBIT_RX + grow) * unit');
  });

  it('refuses to read a DERIVED python constant as a literal', () => {
    // Guards the helper, not the mark. `MIN_ORBIT_STROKE = 1.2 / (16 / VIEWBOX)`
    // evaluates to 2.4; the previous half-anchored regex returned 1.2 for it without
    // complaint. A wrong number that looks right is worse than a thrown error.
    expect(() => pyNumber('MIN_ORBIT_STROKE')).toThrow(/no literal MIN_ORBIT_STROKE/);
    expect(pyNumber('ORBIT_RX')).toBe(11.4);
    expect(pyNumber('ORBIT_RY')).toBe(5.4);
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
    // ...and this is ALGEBRA. The same expression was green over binaries measuring
    // 0.90, so the artefact is checked separately — see the committed-PNG block.
  });

  it('keeps the orbits eccentric enough to read as orbits, not as a rosette', () => {
    // The property the 2026-08-10 pass missed. Three ellipses at 60° cross in a small
    // central region when they are FLAT and pile into a fat hexagonal void when they
    // are round — at aspect 1.85 the mark was legible, had its nucleus clearance, and
    // read as a six-lobed flower at 256px+. This is the assertion the old geometry
    // FAILS, which is the only reason to believe this file pins anything.
    expect(py).toContain('ORBIT_ASPECT = ORBIT_RX / ORBIT_RY');
    expect(pyNumber('ORBIT_RX') / pyNumber('ORBIT_RY')).toBeGreaterThanOrEqual(2.0);
  });

  it('keeps the orbits reading as strokes, not lozenges', () => {
    // A WEAK proxy, kept only for the degenerate case, and deliberately loosened from
    // the 0.42 it used to assert. That bound was set against the old ry and claimed to
    // measure "no ring quality left / the six outer voids pinch shut" — but this pass
    // lowered ry, which RAISES stroke/ry to 0.45 while making both of those properties
    // visibly better. A ratio that moves the wrong way against the thing it purports
    // to measure is not the guard; the real ones are the aspect above and the measured
    // outer void in the committed-PNG block. Past ~0.5 the ellipse fills solid.
    expect(pyNumber('ORBIT_STROKE') / pyNumber('ORBIT_RY')).toBeLessThanOrEqual(0.5);
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

    // WHAT IS AND IS NOT SHARED HERE, stated precisely, because the comment this
    // replaces claimed the floor was "DERIVED, not retyped, so there is one number in
    // the repo" and that was an overstatement. The literal 1.2 exists in THREE places:
    // the serving test (its home), `MIN_ORBIT_STROKE` in the python module, and the
    // `toContain` on the next line. Only the UNIT CONVERSION (device px → viewBox
    // units, via 16/VIEWBOX) is derived. What this assertion actually buys is that a
    // change to the serving test's floor cannot leave the mark below it — drift is
    // caught in the direction that matters, and the duplication is documented rather
    // than described as absent.
    expect(py).toContain('MIN_ORBIT_STROKE = 1.2 / (16 / VIEWBOX)');
    expect(pyNumber('ORBIT_STROKE') * (16 / pyNumber('VIEWBOX'))).toBeGreaterThanOrEqual(
      devicePxFloor,
    );
  });

  it('leaves the mark a margin inside its tile', () => {
    // OFF BY EXACTLY 2x until 2026-08-11, and therefore incapable of failing: it
    // compared a HALF-extent (12.75 as it then was) against `0.8 * VIEWBOX` (25.6) while
    // its own comment documented the intended 12.8. Mutating ORBIT_RX to 24 — orbits
    // 58% past the tile edge — passed the whole suite. A half-extent belongs against
    // half the tile, so the bound is `0.4 * VIEWBOX`, and it is the same number the
    // python module now asserts as MARK_EXTENT_LIMIT on the FULL extent.
    const halfExtent = pyNumber('ORBIT_RX') + pyNumber('ORBIT_STROKE') / 2;
    expect(halfExtent).toBeLessThanOrEqual(0.4 * pyNumber('VIEWBOX')); // <= 12.8 of 16
    expect(py).toContain('MARK_EXTENT_LIMIT = 0.8 * VIEWBOX');
    expect(2 * halfExtent).toBeLessThanOrEqual(0.8 * pyNumber('VIEWBOX'));
  });
});

/**
 * Runs of accent/background along a ray out of the centre, in viewBox units. Index 0
 * is the nucleus, 1 the central ring, and anything after that is the crossing pattern
 * — which is where the six voids between the petals live.
 */
function raySegments(
  image: Pixels,
  angleDeg: number,
  markScale = 1,
): { accent: boolean; units: number }[] {
  const unit = (image.height / 32) * markScale;
  const cx = image.width / 2;
  const cy = image.height / 2;
  const dx = Math.cos((angleDeg * Math.PI) / 180);
  const dy = -Math.sin((angleDeg * Math.PI) / 180);
  const segments: { accent: boolean; units: number }[] = [];
  const step = 0.25;
  // Scan out to the mark's painted extent — a scan bound, not an assertion.
  const extent = pyNumber('ORBIT_RX') + pyNumber('ORBIT_STROKE') / 2;
  for (let r = 0; r <= extent * unit; r += step) {
    const x = Math.round(cx + dx * r);
    const y = Math.round(cy + dy * r);
    if (x < 0 || y < 0 || x >= image.width || y >= image.height) break;
    const accent = isAccent(image.at(x, y));
    const last = segments.at(-1);
    if (last === undefined || last.accent !== accent) segments.push({ accent, units: step / unit });
    else last.units += step / unit;
  }
  return segments;
}

describe('the COMMITTED icons look like the mark, not merely cite it', () => {
  /**
   * This block exists because the source-only version of this file gave a green run to
   * binaries with the exact defect its headline test was named for. Every assertion
   * here decodes a committed PNG. If the generators are not re-run after a geometry
   * change, these fail — which is the point: `python3 scripts/gen-app-icons.py` and
   * `python3 scripts/gen-favicon-ico.py` are part of the change, not a follow-up.
   */
  const ios = readPng('app', 'assets', 'images', 'icon.png');
  const splash = readPng('app', 'assets', 'images', 'splash-icon.png');
  const foreground = readPng('app', 'assets', 'images', 'android-icon-foreground.png');
  const monochrome = readPng('app', 'assets', 'images', 'android-icon-monochrome.png');
  const androidBackground = readPng('app', 'assets', 'images', 'android-icon-background.png');
  const expoFavicon = readPng('app', 'assets', 'images', 'favicon.png');
  const appleTouch = readPng('landing', 'apple-touch-icon.png');

  /**
   * The geometry DERIVED from the python module rather than retyped from the SVG — the
   * values are already pinned to `landing/favicon.svg` by the block above, so deriving
   * here leaves one place to change a number. (The defect this file spent a round
   * documenting was a floor that existed as a literal in three files.)
   *
   * Called inside each `it`, NOT in the describe body. `pyNumber` throws on a constant
   * the module does not declare, and a throw while evaluating a describe body aborts the
   * whole block — which turned a clean "9 tests failed" into "1 error, 8 tests never
   * ran" when the mutation harness swapped in an older module. A lazy read fails the
   * individual test with its own message instead.
   */
  function geometry() {
    const rx = pyNumber('ORBIT_RX');
    const ry = pyNumber('ORBIT_RY');
    const stroke = pyNumber('ORBIT_STROKE');
    const core = pyNumber('CORE_RADIUS');
    const viewBox = pyNumber('VIEWBOX');
    return {
      expectedGap: ry - stroke / 2 - core,
      safeScale:
        (pyNumber('ANDROID_SAFE_MARGIN') * (66 / 108)) / ((2 * (rx + stroke / 2)) / viewBox),
    };
  }

  it('SHIPS the nucleus clearance the geometry promises, measured in pixels', () => {
    // THE assertion this suite was missing. The 2026-08-10 binaries measured 0.90
    // viewBox units here against an asserted 1.5 floor and an algebraic claim of 2.15,
    // and nothing failed, because nothing looked. Measured on the tile the owner sees
    // and on the mark-only splash, so a regression in either the constants or the
    // rasteriser's stroke placement lands here.
    const { expectedGap, safeScale } = geometry();
    for (const [label, image, scale] of [
      ['icon.png', ios, 1],
      ['splash-icon.png', splash, 1],
      ['android foreground', foreground, safeScale],
    ] as const) {
      const gap = measureCoreOrbitGap(image, scale);
      expect(gap, `${label} nucleus gap`).toBeGreaterThanOrEqual(1.5);
      // The measured gap must also AGREE with the algebra. Without this the raster could
      // drift a long way from the vector source and still clear the 1.5 floor, which is
      // exactly the hole the 2026-08-10 icons went through.
      expect(Math.abs(gap - expectedGap), `${label} gap vs algebra`).toBeLessThanOrEqual(0.3);
    }
  });

  it('SHIPS open voids between the petals, so the mark is not a solid rosette', () => {
    // The property `stroke/ry <= 0.42` claimed to measure and could not. At 30° the ray
    // runs between two orbit long axes, straight through one of the six voids.
    for (const [label, image] of [
      ['icon.png', ios],
      ['splash-icon.png', splash],
    ] as const) {
      const beyondCentre = raySegments(image, 30).slice(2);
      const widestVoid = Math.max(...beyondCentre.filter((s) => !s.accent).map((s) => s.units), 0);
      expect(widestVoid, `${label} widest void between petals`).toBeGreaterThanOrEqual(1.0);
    }
  });

  it('carries the rejected teal in NO committed icon', () => {
    // The 2026-08-10 guard for this read two SVG text files and passed green while
    // landing/apple-touch-icon.png — the iOS home-screen icon, served from
    // landing/boot-impl.ts and declared in landing/site.webmanifest — still WAS the
    // rejected drawing: #6fe3d4 rings at r=48/112/176 with a satellite dot. A guard
    // against artwork has to look at the artwork.
    //
    // The discriminator is structural rather than a hex compare, so it also catches a
    // re-tint: the accent (#4da3ff) on the tile (#0b0e14) blends to a ramp where blue
    // always leads green, and the monochrome layer is neutral (r=g=b). The rejected
    // teal (#6fe3d4) is the other way round — green leads blue by 15. Nothing on our
    // ramp can produce that, so any such pixel is foreign artwork.
    for (const [label, image] of [
      ['icon.png', ios],
      ['splash-icon.png', splash],
      ['android foreground', foreground],
      ['android monochrome', monochrome],
      ['android background', androidBackground],
      ['expo favicon', expoFavicon],
      ['apple-touch-icon.png', appleTouch],
    ] as const) {
      let greenLeadingBlue = 0;
      for (let y = 0; y < image.height; y += 2) {
        for (let x = 0; x < image.width; x += 2) {
          const [r, g, b, a] = image.at(x, y);
          if (a > 8 && g > b + 8 && g > 90) greenLeadingBlue++;
        }
      }
      expect(greenLeadingBlue, `${label} teal-family pixels`).toBe(0);
    }
  });

  it('ships the iOS and apple-touch icons FULL-BLEED and opaque', () => {
    // iOS rejects alpha and applies its own corner mask. A transparent home-screen
    // icon renders on black, and a baked corner gets rounded twice.
    for (const [label, image] of [
      ['icon.png', ios],
      ['apple-touch-icon.png', appleTouch],
    ] as const) {
      for (const [x, y] of [
        [0, 0],
        [image.width - 1, 0],
        [0, image.height - 1],
        [image.width - 1, image.height - 1],
      ] as const) {
        const [r, g, b, a] = image.at(x, y);
        expect(a, `${label} corner alpha`).toBe(255);
        expect([r, g, b], `${label} corner is the tile`).toEqual([0x0b, 0x0e, 0x14]);
      }
      expect(isAccent(image.at(image.width / 2, image.height / 2)), `${label} centre`).toBe(true);
    }
  });

  it('insets both Android layers inside the 66/108 safe circle, in pixels', () => {
    // Asserted on the artefact and not just on `mark_scale=SAFE_SCALE` in the
    // generator, because an orbit clipped by an OEM mask only shows up on hardware.
    //
    // This assertion earned its keep on its first run: `SAFE_SCALE` fitted the mark
    // EXACTLY to the safe diameter, so once the stroke was centred the antialiased tips
    // put 3 painted pixels past the line. Hence `ANDROID_SAFE_MARGIN`. Note the bound is
    // `radius + 1`, not `radius` — one pixel of slack for the edge itself, which is a
    // rasterisation fact, while 3 pixels at 2% over is a geometry fact.
    for (const [label, image] of [
      ['android foreground', foreground],
      ['android monochrome', monochrome],
    ] as const) {
      const radius = ((66 / 108) * image.width) / 2;
      let outside = 0;
      for (let y = 0; y < image.height; y += 2) {
        for (let x = 0; x < image.width; x += 2) {
          if (!painted(image.at(x, y))) continue;
          const dx = x - image.width / 2;
          const dy = y - image.height / 2;
          if (Math.hypot(dx, dy) > radius + 1) outside++;
        }
      }
      expect(outside, `${label} painted px outside the safe circle`).toBe(0);
      expect(image.at(0, 0)[3], `${label} corner must stay transparent`).toBe(0);
    }
  });

  it('ships the monochrome layer as a WHITE silhouette on transparency', () => {
    // Android 13+ re-tints this layer from white. Shipping the blue accent makes the
    // themed icon a blue-on-blue smudge on exactly the launchers that opted in.
    let opaque = 0;
    for (let y = 0; y < monochrome.height; y += 2) {
      for (let x = 0; x < monochrome.width; x += 2) {
        const [r, g, b, a] = monochrome.at(x, y);
        if (a < 250) continue;
        opaque++;
        expect([r, g, b]).toEqual([255, 255, 255]);
      }
    }
    expect(opaque).toBeGreaterThan(1000); // the silhouette is actually there
  });

  it('ships the Expo web favicon as the ROUNDED tile', () => {
    // This one is landing/favicon.svg verbatim, corner radius included — unlike the
    // iOS icon, nothing masks it for us.
    expect(expoFavicon.at(0, 0)[3]).toBe(0); // corner clipped away
    const [, , , centreAlpha] = expoFavicon.at(expoFavicon.width / 2, 4);
    expect(centreAlpha).toBe(255); // mid-edge is inside the radius
  });

  it('ships the Android background layer as the flat tile', () => {
    for (const [x, y] of [
      [0, 0],
      [androidBackground.width - 1, androidBackground.height - 1],
      [androidBackground.width / 2, androidBackground.height / 2],
    ] as const) {
      expect(androidBackground.at(x, y)).toEqual([0x0b, 0x0e, 0x14, 255]);
    }
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
    //
    // THIS COVERS THE TWO SVGs AND NOTHING ELSE, which is precisely how it passed
    // green over landing/apple-touch-icon.png for eleven days. The binaries are
    // covered by 'carries the rejected teal in NO committed icon' above; keep the two
    // together, and when a new raster mirror is added, add it THERE.
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
    expect(py).toContain('ANDROID_SAFE_MARGIN = 0.98');
    expect(generated).toContain(
      'SAFE_SCALE = ANDROID_SAFE_MARGIN * ANDROID_SAFE_FRACTION / (MARK_EXTENT / VIEWBOX)',
    );
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

  it('generates landing/apple-touch-icon.png instead of hand-placing it', () => {
    // It was the LAST hand-placed copy of the mark, and it was still the rejected
    // drawing. `landing/` rasters belong to gen-favicon-ico.py, which already owns
    // favicon.ico, so it owns this too.
    const landing = readFileSync(join(ROOT, 'scripts', 'gen-favicon-ico.py'), 'utf8');
    expect(landing).toContain('APPLE_TOUCH = ROOT / "landing" / "apple-touch-icon.png"');
    expect(landing).toContain('APPLE_TOUCH_PX = 180');
    expect(landing).toContain('render_atom(APPLE_TOUCH_PX, background=BG)');
  });

  it('measures a real render in EVERY generator before writing', () => {
    // The algebra was self-consistent and green while the binaries were wrong, so each
    // generator calls the pixel check. A generator that skips it can ship a blob again.
    for (const script of ['gen-app-icons.py', 'gen-favicon-ico.py']) {
      const source = readFileSync(join(ROOT, 'scripts', script), 'utf8');
      expect(source, script).toContain('verify_raster_invariants');
    }
    expect(py).toContain('def verify_raster_invariants()');
    expect(py).toContain('def measure_core_orbit_gap(');
    // The sliver check is the one invariant that can only be seen at launcher size.
    // It lives in python because it is a property of the GEOMETRY, and the geometry is
    // pinned to the SVG above — so it cannot be dodged by editing the constants alone.
    expect(py).toContain('def count_background_slivers(');
    expect(py).toContain('assert slivers == 0');
  });
});
