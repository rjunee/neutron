/**
 * The ⚛ mark's copies must not drift from `landing/favicon.svg`.
 *
 * WHY. The mark exists once as vector (`landing/favicon.svg`) and several times as
 * committed PNG/ICO binaries, plus a second SVG at `landing/logo.svg`. Binaries
 * cannot be diffed by eye in review, so a copy that stops matching is invisible
 * until someone installs the app — which is exactly how the mobile icon came to be
 * teal concentric rings with a satellite dot, a drawing no source in this repo
 * produces (the owner, 2026-07-30: "make the app icon the same as our favicon. What is
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
  /**
   * Samples per pixel in the FILE: 1 greyscale, 3 RGB, 4 RGBA. Exposed because "has an
   * alpha channel" is a property of the encoding, not of the sample values — an RGBA
   * file whose every pixel is opaque is still an RGBA file, and iOS rejects the channel.
   */
  readonly channels: number;
  /** `[r, g, b, a]`, alpha 255 for images with no alpha channel. */
  at(x: number, y: number): [number, number, number, number];
}

/**
 * Decode a PNG buffer to pixels. Handles 8-bit greyscale/RGB/RGBA — everything the
 * Pillow generators emit — and throws on anything else rather than guessing, because a
 * decoder that silently mis-reads a format turns every assertion below into a
 * false negative that looks exactly like a pass.
 */
function decodePng(buf: Buffer): Pixels {
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
    channels,
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

/**
 * A committed PNG, decoded ONCE and on first use.
 *
 * LAZY, for the same reason `geometry()` below is: a `readFileSync` + `expect` at
 * describe-body scope runs while the block is being collected, so one bad file aborts
 * the WHOLE describe — reporting "1 error, N tests never ran" instead of naming which
 * assertion about which asset failed. That is precisely the failure this file already
 * documents for the mutation harness, and the first version of this block reintroduced
 * it for the seven PNG reads. Memoised because several tests read the same 1024px
 * asset and un-filtering it is not free.
 */
const pngCache = new Map<string, Pixels>();
function png(...parts: string[]): Pixels {
  const key = parts.join('/');
  let hit = pngCache.get(key);
  if (hit === undefined) {
    hit = decodePng(readFileSync(join(ROOT, ...parts)));
    pngCache.set(key, hit);
  }
  return hit;
}

/**
 * Every frame of a committed .ico, decoded — `[size, pixels]` pairs.
 *
 * WHY THIS EXISTS. `landing/favicon.ico` is a raster mirror of the mark like any other,
 * and it was the one the 'carries the rejected teal in NO committed icon' guard did not
 * read while claiming "NO committed icon" — the same overstatement, one format over,
 * that let the 2026-08-10 guard pass green over `landing/apple-touch-icon.png`. A guard
 * whose name generalises over every icon has to actually open every icon.
 *
 * `gen-favicon-ico.py` writes every frame PNG-encoded (verified: all six frames of the
 * committed file carry the PNG magic), so the ICO container is a 6-byte ICONDIR plus
 * 16-byte entries pointing at complete PNGs, and the decoder above handles the rest.
 * A frame that is a BMP-encoded DIB instead throws rather than being skipped — silently
 * skipping is how a guard comes to cover less than it says.
 */
function icoFrames(...parts: string[]): [number, Pixels][] {
  const buf = readFileSync(join(ROOT, ...parts));
  expect(buf.readUInt16LE(0), 'ICO reserved field').toBe(0);
  expect(buf.readUInt16LE(2), 'ICO type (1 = icon)').toBe(1);
  const count = buf.readUInt16LE(4);
  expect(count).toBeGreaterThan(0);
  const frames: [number, Pixels][] = [];
  for (let i = 0; i < count; i++) {
    const entry = 6 + i * 16;
    const size = buf.readUInt8(entry) || 256; // 0 means 256, per the format
    const length = buf.readUInt32LE(entry + 8);
    const offset = buf.readUInt32LE(entry + 12);
    const frame = buf.subarray(offset, offset + length);
    if (frame.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
      throw new Error(`favicon.ico frame ${size}px is not PNG-encoded — decoder needs BMP`);
    }
    frames.push([size, decodePng(frame)]);
  }
  return frames;
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

  /**
   * Every `<ellipse>` in a source, as `[rx, ry]` — matched WITHOUT requiring the tag to
   * end at `/>`, so a rotated orbit (which carries a `transform=`) is matched too.
   *
   * ALL THREE, NOT THE FIRST. The previous pattern was anchored on ` />` and therefore
   * only ever saw the un-rotated ellipse; the rotation test beside it read only the
   * ANGLE out of the other two. So `rx`/`ry` on both rotated orbits were pinned by
   * nothing at all: rewriting them in landing/favicon.svg AND landing/logo.svg together
   * leaves the whole suite green (the byte-identity check compares the two files to each
   * other, not to the python module), and nothing in this repo rasterises the SVG — the
   * PNG assertions read Pillow's output, which comes from the python constants. Two
   * orbits could have degenerated into slivers in the file the browser actually serves
   * while every raster mirror stayed perfect. That is exactly the drift this file exists
   * to prevent, so the match COUNT is asserted first.
   */
  function ellipses(source: string): [number, number][] {
    return [...source.matchAll(/<ellipse cx="16" cy="16" rx="([0-9.]+)" ry="([0-9.]+)"/g)].map(
      (m) => [Number(m[1]), Number(m[2])],
    );
  }

  it('uses the same orbit ellipse + stroke, on ALL THREE orbits', () => {
    const pyRx = pyNumber('ORBIT_RX');
    const pyRy = pyNumber('ORBIT_RY');
    expect([pyRx, pyRy], 'the geometry module orbit').toEqual([11.4, 5.4]);

    // Compared as WHOLE ARRAYS, which asserts the count and all three pairs in one go —
    // a two-ellipse file and a three-ellipse file with one orbit rewritten both fail
    // here. landing/logo.svg is checked byte-identical to the favicon further down, but
    // that compares the two files to EACH OTHER and a matched edit to both passes it, so
    // the logo is pinned to the python module too.
    const expected: [number, number][] = [
      [pyRx, pyRy],
      [pyRx, pyRy],
      [pyRx, pyRy],
    ];
    expect(ellipses(svg), 'landing/favicon.svg orbits').toEqual(expected);
    expect(ellipses(logo), 'landing/logo.svg orbits').toEqual(expected);

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

  it('measures the void between the petals rather than proxying it with a ratio', () => {
    // WHAT USED TO BE HERE, AND WHY IT IS GONE. `ORBIT_STROKE / ORBIT_RY <= 0.42`,
    // asserted as "no ring quality left / the six outer voids pinch shut". But lowering
    // ORBIT_RY RAISES that ratio while making both of those properties visibly better,
    // so this pass could only satisfy it by relaxing the bound to 0.5 — and a guard
    // relaxed to admit the change it is meant to police is not a guard, it is a rubber
    // stamp that still reads like coverage in a diff. Deleting it is the honest move,
    // but only once the property it named is measured somewhere, which is the point of
    // `measure_petal_void()`: it walks a 30° ray through one of the six voids on a real
    // render and `verify_raster_invariants()` asserts it, so every generator run checks
    // it before writing. The committed PNGs are checked the same way below.
    expect(py).toContain('def measure_petal_void(');
    expect(py).toContain('assert void >= 1.0');
    // ...and the ratio is not silently unbounded now: at stroke >= ry the ellipse fills
    // solid, and the nucleus-clearance assert above (>= 1.5 units) already forbids that
    // long before it happens, since the gap is ry - stroke/2 - core.
    expect(pyNumber('ORBIT_STROKE')).toBeLessThan(pyNumber('ORBIT_RY'));
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

    // WHAT THE FLOOR STILL MEASURES, now that the mark it was set for is gone. The
    // 2026-07-18 failure had TWO causes: a 1.067 px stroke, and a transparent
    // stroke-only mark compositing onto Chrome's near-black tab strip. The second is
    // fixed structurally — the mark sits on an opaque #0b0e14 tile, and the serving
    // test asserts that separately — so this floor is now doing one job rather than
    // two: keeping the STROKE ITSELF above a hairline at 16px, a legibility bound
    // that is independent of what it sits on. Worth stating because a floor whose
    // original justification has been engineered away is exactly the kind of number
    // that gets "cleaned up" by someone who reads only its comment. It is still the
    // binding constraint on how flat these ellipses may go at a given weight.

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

/**
 * Bun's default per-test timeout is 5s, and the full-resolution scans below need more:
 * decoding eight committed assets (five of them 1024px) and walking every pixel of each
 * is ~20s for the block, and the FIRST test to touch a 1024px file pays its ~2.5s decode.
 *
 * DELIBERATELY A TIMEOUT RATHER THAN A FASTER DECODER. The un-filter loop reads every
 * byte through `readUInt8` so a truncated file throws instead of feeding `undefined` into
 * the arithmetic; a typed-array rewrite would be several times quicker and would put a
 * hand-rolled decoder — the one component whose failure mode is a SILENT false green on
 * every assertion in this block — on the critical path of a performance change. Twenty
 * seconds of CI is the cheaper side of that trade. It is also not the sampling stride's
 * fault: the strided versions of these scans were the defect, not the cost.
 */
const PIXEL_SCAN_TIMEOUT_MS = 60_000;

describe('the COMMITTED icons look like the mark, not merely cite it', () => {
  /**
   * This block exists because the source-only version of this file gave a green run to
   * binaries with the exact defect its headline test was named for. Every assertion
   * here decodes a committed PNG. If the generators are not re-run after a geometry
   * change, these fail — which is the point: `python3 scripts/gen-app-icons.py` and
   * `python3 scripts/gen-favicon-ico.py` are part of the change, not a follow-up.
   */
  const ios = () => png('app', 'assets', 'images', 'icon.png');
  const splash = () => png('app', 'assets', 'images', 'splash-icon.png');
  const foreground = () => png('app', 'assets', 'images', 'android-icon-foreground.png');
  const monochrome = () => png('app', 'assets', 'images', 'android-icon-monochrome.png');
  const androidBackground = () => png('app', 'assets', 'images', 'android-icon-background.png');
  const expoFavicon = () => png('app', 'assets', 'images', 'favicon.png');
  const appleTouch = () => png('landing', 'apple-touch-icon.png');

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
      ['icon.png', ios(), 1],
      ['splash-icon.png', splash(), 1],
      ['android foreground', foreground(), safeScale],
    ] as const) {
      const gap = measureCoreOrbitGap(image, scale);
      expect(gap, `${label} nucleus gap`).toBeGreaterThanOrEqual(1.5);
      // The measured gap must also AGREE with the algebra. Without this the raster could
      // drift a long way from the vector source and still clear the 1.5 floor, which is
      // exactly the hole the 2026-08-10 icons went through.
      expect(Math.abs(gap - expectedGap), `${label} gap vs algebra`).toBeLessThanOrEqual(0.3);
    }
  }, PIXEL_SCAN_TIMEOUT_MS);

  it('SHIPS open voids between the petals, so the three bands have not fused', () => {
    // The property `stroke/ry <= 0.42` claimed to measure and could not. At 30° the ray
    // runs between two orbit long axes, straight through one of the six voids.
    //
    // WHAT THIS DOES AND DOES NOT CLAIM. It proves the bands are separated — that the
    // mark is three crossing ellipses rather than one solid lozenge. It does NOT prove
    // the mark "reads as an atom rather than a rosette" to a human eye, and nothing in
    // this file does. Measured as accent coverage inside the mark's own painted extent,
    // with all three rendered through the same corrected renderer so only the geometry
    // varies: old constants 68.1%, these constants 66.1%, the lighter rail-header icon
    // 51.9%. Two points is a nudge, so the honest claim for this pass is the one the
    // numbers support — the nucleus is visible at every size, the dark nicks are gone,
    // one drawing feeds every mirror — and NOT that the silhouette reads differently.
    // Stated here because the aspect-ratio argument in scripts/lib/atom_mark.py is a
    // real geometric property that is easy to mistake for a perceptual verdict it does
    // not deliver.
    for (const [label, image] of [
      ['icon.png', ios()],
      ['splash-icon.png', splash()],
    ] as const) {
      const beyondCentre = raySegments(image, 30).slice(2);
      const widestVoid = Math.max(...beyondCentre.filter((s) => !s.accent).map((s) => s.units), 0);
      expect(widestVoid, `${label} widest void between petals`).toBeGreaterThanOrEqual(1.0);
    }
  }, PIXEL_SCAN_TIMEOUT_MS);

  it('carries the rejected teal in NO committed icon — every pixel of every one', () => {
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
    //
    // TWO COVERAGE HOLES CLOSED, both of the same shape as the original defect — a
    // guard whose NAME generalises further than its BODY reaches:
    //
    //   1. IT SAMPLED EVERY OTHER PIXEL IN EACH AXIS while asserting exactly zero. A
    //      stride-2 scan reads a quarter of the image, so a foreign artefact confined
    //      to odd rows and columns — an 8px logotype, a stray glyph — was invisible to
    //      a check whose whole assertion is "not one pixel". Cheap, too: seven 1024px
    //      images at full resolution is ~7M reads and runs in well under a second.
    //   2. IT SKIPPED landing/favicon.ico ENTIRELY. Six frames, all raster mirrors of
    //      the mark, none of them read — while the test name said "NO committed icon".
    //      That is verbatim the 08-10 mistake (a guard covering the formats the author
    //      happened to be editing) reproduced one round later, and the .ico is the
    //      single most-served icon in the product.
    const assets: [string, Pixels][] = [
      ['icon.png', ios()],
      ['splash-icon.png', splash()],
      ['android foreground', foreground()],
      ['android monochrome', monochrome()],
      ['android background', androidBackground()],
      ['expo favicon', expoFavicon()],
      ['apple-touch-icon.png', appleTouch()],
      ...icoFrames('landing', 'favicon.ico').map(
        ([size, pixels]): [string, Pixels] => [`favicon.ico ${size}px frame`, pixels],
      ),
    ];
    // The .ico is six frames, so this must not silently shrink to "the PNGs I remembered".
    expect(assets.length, 'assets scanned').toBe(13);

    for (const [label, image] of assets) {
      let greenLeadingBlue = 0;
      for (let y = 0; y < image.height; y++) {
        for (let x = 0; x < image.width; x++) {
          const [, g, b, a] = image.at(x, y);
          if (a > 8 && g > b + 8 && g > 90) greenLeadingBlue++;
        }
      }
      expect(greenLeadingBlue, `${label} teal-family pixels`).toBe(0);
    }
  }, PIXEL_SCAN_TIMEOUT_MS);

  it('ships the iOS and apple-touch icons FULL-BLEED and opaque', () => {
    // iOS rejects alpha and applies its own corner mask. A transparent home-screen
    // icon renders on black, and a baked corner gets rounded twice.
    //
    // FOUR CORNERS DID NOT TEST "FULL-BLEED AND OPAQUE". It tested four pixels. A baked
    // corner radius — the actual mistake this guards, since every other asset in the set
    // is deliberately rounded and copy-paste between them is one line — clips an ARC,
    // and all four sampled points sit at the extreme corner where a modest radius still
    // leaves them... transparent, as it happens, but a radius small enough to spare the
    // exact corner pixel and still visibly round the tile would have passed. The honest
    // form of "opaque" is every pixel, and the honest form of "full-bleed" is that the
    // whole border ring is tile-coloured rather than clipped.
    for (const [label, image] of [
      ['icon.png', ios()],
      ['apple-touch-icon.png', appleTouch()],
    ] as const) {
      // NO ALPHA CHANNEL AT ALL, which is a stronger and different statement from "every
      // pixel is opaque" — and it is the one the docstring in gen-app-icons.py makes.
      // icon.png shipped as RGBA-with-everything-opaque until 2026-08-11, so the
      // every-pixel check below passed over exactly the file that did not satisfy the
      // constraint; without this line, reverting the generator's `.convert("RGB")` is
      // invisible here.
      expect(image.channels, `${label} samples per pixel (3 = RGB, no alpha)`).toBe(3);

      let transparent = 0;
      for (let y = 0; y < image.height; y++) {
        for (let x = 0; x < image.width; x++) {
          if (image.at(x, y)[3] !== 255) transparent++;
        }
      }
      expect(transparent, `${label} pixels that are not fully opaque`).toBe(0);

      // Full-bleed: the entire border ring is the flat tile, so nothing is clipped.
      for (let i = 0; i < image.width; i++) {
        for (const [x, y] of [
          [i, 0],
          [i, image.height - 1],
          [0, i],
          [image.width - 1, i],
        ] as const) {
          const [r, g, b] = image.at(x, y);
          expect(`${label} (${x},${y})=${r},${g},${b}`).toBe(`${label} (${x},${y})=11,14,20`);
        }
      }
      expect(isAccent(image.at(image.width / 2, image.height / 2)), `${label} centre`).toBe(true);
    }
  }, PIXEL_SCAN_TIMEOUT_MS);

  it('insets both Android layers inside the 66/108 safe circle, in pixels', () => {
    // Asserted on the artefact and not just on `mark_scale=SAFE_SCALE` in the
    // generator, because an orbit clipped by an OEM mask only shows up on hardware.
    //
    // This assertion earned its keep on its first run: `SAFE_SCALE` fitted the mark
    // EXACTLY to the safe diameter, so once the stroke was centred the antialiased tips
    // put 3 painted pixels past the line. Hence `ANDROID_SAFE_MARGIN`. Note the bound is
    // `radius + 1`, not `radius` — one pixel of slack for the edge itself, which is a
    // rasterisation fact, while 3 pixels at 2% over is a geometry fact.
    //
    // FULL RESOLUTION, because the thing being counted is the OUTERMOST painted pixel and
    // a stride-2 scan can only ever find it by luck: the four orbit tips are the extreme
    // points of the whole figure, they are a few pixels wide, and half of them fall on
    // odd coordinates. The margin is 2% of a 1024px layer — ~10px — so this is not a
    // theoretical gap. It also reports the worst radius rather than a bare count, so a
    // failure says how far over the line the mark went instead of how many pixels agreed
    // that it did.
    for (const [label, image] of [
      ['android foreground', foreground()],
      ['android monochrome', monochrome()],
    ] as const) {
      const radius = ((66 / 108) * image.width) / 2;
      let worst = 0;
      for (let y = 0; y < image.height; y++) {
        for (let x = 0; x < image.width; x++) {
          if (!painted(image.at(x, y))) continue;
          worst = Math.max(worst, Math.hypot(x - image.width / 2, y - image.height / 2));
        }
      }
      expect(
        worst,
        `${label} outermost painted px at r=${worst.toFixed(1)}, safe radius ${radius.toFixed(1)}`,
      ).toBeLessThanOrEqual(radius + 1);
      expect(image.at(0, 0)[3], `${label} corner must stay transparent`).toBe(0);
    }
  }, PIXEL_SCAN_TIMEOUT_MS);

  it('ships the monochrome layer as a WHITE silhouette on transparency', () => {
    // Android 13+ re-tints this layer from white. Shipping the blue accent makes the
    // themed icon a blue-on-blue smudge on exactly the launchers that opted in.
    //
    // Full resolution: a stray tinted pixel is exactly what a stride-2 scan misses, and
    // the assertion is again an exact zero. Counted rather than asserted per pixel so a
    // failure reports how much of the layer is wrong, not just the first offender.
    const mono = monochrome();
    let opaque = 0;
    let tinted = 0;
    for (let y = 0; y < mono.height; y++) {
      for (let x = 0; x < mono.width; x++) {
        const [r, g, b, a] = mono.at(x, y);
        if (a < 250) continue;
        opaque++;
        if (r !== 255 || g !== 255 || b !== 255) tinted++;
      }
    }
    expect(tinted, 'opaque monochrome pixels that are not pure white').toBe(0);
    expect(opaque).toBeGreaterThan(1000); // the silhouette is actually there
  }, PIXEL_SCAN_TIMEOUT_MS);

  it('ships the Expo web favicon as the ROUNDED tile', () => {
    // This one is landing/favicon.svg verbatim, corner radius included — unlike the
    // iOS icon, nothing masks it for us.
    const favicon = expoFavicon();
    expect(favicon.at(0, 0)[3]).toBe(0); // corner clipped away
    const [, , , centreAlpha] = favicon.at(favicon.width / 2, 4);
    expect(centreAlpha).toBe(255); // mid-edge is inside the radius
  }, PIXEL_SCAN_TIMEOUT_MS);

  it('ships the Android background layer as the flat tile, everywhere', () => {
    // Every pixel, not three of them: this layer's entire job is to be ONE colour, so
    // "three sampled points are the right colour" is a strictly weaker statement than
    // the thing being claimed, and the full scan costs a millisecond.
    const tile = androidBackground();
    let wrong = 0;
    for (let y = 0; y < tile.height; y++) {
      for (let x = 0; x < tile.width; x++) {
        const [r, g, b, a] = tile.at(x, y);
        if (r !== 0x0b || g !== 0x0e || b !== 0x14 || a !== 255) wrong++;
      }
    }
    expect(wrong, 'android background pixels that are not the flat tile').toBe(0);
  }, PIXEL_SCAN_TIMEOUT_MS);
});

describe('landing/logo.svg is the same mark, not a second one', () => {
  /**
   * It held the drawing the owner rejected on 2026-07-30 — teal #6fe3d4 concentric rings
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

  it('CALLS the render check in every generator, before the first write', () => {
    // The algebra was self-consistent and green while the binaries were wrong, so each
    // generator calls the pixel check. A generator that skips it can ship a blob again.
    //
    // THIS USED TO SEARCH FOR THE IDENTIFIER, which both scripts also carry in their
    // `from lib.atom_mark import (...)` block — so deleting the actual call from `main()`
    // left this green, in both files, while the check no longer ran. Presence of an import
    // is not evidence of a call; it is evidence of an import. So: match the CALL
    // statement, and require it to appear before the first `write(`/`.save(` — a check
    // that runs after the artefacts are on disk has not gated anything.
    for (const script of ['gen-app-icons.py', 'gen-favicon-ico.py']) {
      const whole = readFileSync(join(ROOT, 'scripts', script), 'utf8');
      // Scoped to main()'s BODY. Searching the whole file would compare against the
      // `image.save(...)` inside gen-app-icons.py's own `write()` helper, which is
      // defined above main() and so precedes every call in it — an ordering assertion
      // that fails on correct code is as useless as one that passes on broken code.
      const mainAt = whole.indexOf('def main()');
      expect(mainAt, `${script} must define main()`).toBeGreaterThan(-1);
      const body = whole.slice(mainAt);

      const call = /^\s+verify_raster_invariants\(\)\s*$/m.exec(body);
      expect(call, `${script} must CALL verify_raster_invariants() inside main()`).not.toBeNull();

      const writes = [/^\s+write\(/m.exec(body)?.index, /\.save\(/.exec(body)?.index].filter(
        (n): n is number => n !== undefined,
      );
      expect(writes.length, `${script} must write something`).toBeGreaterThan(0);
      expect(call?.index ?? -1, `${script} verifies before it writes`).toBeLessThan(
        Math.min(...writes),
      );
    }
    expect(py).toContain('def verify_raster_invariants()');
    expect(py).toContain('def measure_core_orbit_gap(');
    // The sliver check is the one invariant that can only be seen at launcher size.
    // It lives in python because it is a property of the GEOMETRY, and the geometry is
    // pinned to the SVG above — so it cannot be dodged by editing the constants alone.
    expect(py).toContain('def count_background_slivers(');
    expect(py).toContain('assert slivers == 0');
    // ...and the zero is only meaningful with a NOISE FLOOR under it. Without one the
    // assert reads "BICUBIC rotation resampling leaves no stray background pixel", which
    // is false one resolution over (4 islands of 0.0007 sq units at n=1200) and would
    // hard-block BOTH generators rather than degrade an icon. See the docstring.
    expect(py).toContain('min_sliver_units: float = 0.005');
    expect(py).toContain('if min_sliver_units <= area < max_sliver_units:');
  });
});
