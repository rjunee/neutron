/**
 * @neutronai/app — THE ONE-MISSED-COMPONENT GUARD.
 *
 * Light mode is not "a light palette exists". It is "every screen uses it". A
 * single component that still resolves its colours at MODULE LOAD is a dark card
 * sitting in a light page, and it is invisible to every other test in this suite:
 * it renders, it has the right shape, its own unit test passes, and it is wrong
 * only on a device and only in one theme.
 *
 * So this file asserts the STRUCTURAL property that makes that impossible, by
 * reading the source rather than by rendering anything. Three invariants:
 *
 *   1. the captured palette no longer EXISTS to be imported;
 *   2. no stylesheet is built at module scope — every one is a factory of the
 *      active palette;
 *   3. NO colour literal appears anywhere in the app outside the theme module.
 *
 * ═══ WHAT THIS FILE USED TO DO, AND WHY IT WAS WORSE THAN NOTHING ═══
 *
 * Invariant 3 was a per-file BUDGET: a frozen count of hardcoded literals per
 * file, ~380 of them across 19 files, which could only go down. The reasoning was
 * that fixing them was a second lane and freezing the number made the gap
 * "finite and visible instead of ambient".
 *
 * That was wrong in a specific and instructive way. The budget's exemption list
 * named `app/features/docs/docs-ui.tsx` and `app/lib/markdown-render.tsx` — and
 * those two files were where the WORST light-mode defect in the change lived: the
 * docs viewer drew #f4f4f4 body text on a themed white page (1.10:1) and a #fafafa
 * title on it (1.04:1). The document was not low-contrast, it was INVISIBLE. So
 * the guard was not merely tolerating a known gap; it was holding open the exact
 * hole through which the change's headline bug shipped, and the two files it
 * excused were the two a reviewer would most want it to check.
 *
 * The general lesson, worth more than the fix: A RATCHET OVER A DEFECT IS A
 * DECISION TO SHIP THE DEFECT. "The number cannot go up" sounds like control, and
 * reads in review like diligence, but it converts a bug into a budget line — and a
 * budget line does not get fixed, because the test is green. Worse, the file that
 * needs a budget is by construction the file with the most colour logic, i.e. the
 * one most likely to be wrong. The counts also made the test LOOK rigorous while
 * measuring the one thing that does not matter: a literal that happens to equal
 * the active palette's value is counted, and a literal that makes text invisible
 * is counted the same.
 *
 * All 19 files are now converted (~400 literals) and the budget is DELETED. The
 * invariant is absolute, which is also what makes it cheap to state.
 *
 * ═══ AND THE MATCHER NOW PROVES IT CAN SEE ═══
 *
 * The old matcher was `/'#(?:[0-9a-f]{3}|[0-9a-f]{6})'/` — single quotes only, no
 * alpha hex, `rgb()` only inside a module-scope sheet. It therefore could not see
 * 25 real defects that were sitting in the tree the whole time, all of them
 * DOUBLE-quoted JSX attributes: `<ActivityIndicator color="#cfcfcf" />` (1.6:1 on
 * a white page — every loading state in light mode was a blank screen) and
 * `placeholderTextColor="#5a5a5a"`. A guard that cannot see a whole syntactic class
 * returns a green that means "I did not look there".
 *
 * So `LITERAL_CLASSES` below enumerates the classes, and
 * `the matcher can see every class of colour literal` feeds each one a KNOWN
 * POSITIVE and asserts it is caught. That is the control: an absence claim is only
 * as good as the tool's proven ability to report a presence.
 */

import { describe, expect, it } from 'bun:test';

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

/** Repo-relative paths, so a failure message never contains a username (the leak
 *  gate treats one as a PII term, and this tree is public). */
const APP_DIR = join(dirname(new URL(import.meta.url).pathname), '..');
const REPO_ROOT = join(APP_DIR, '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** Comment bodies blanked, offsets preserved — so a hex or a pattern MENTIONED in
 *  a docblock is never mistaken for one in the code. Without this the guard reads
 *  its own explanatory comments as violations. */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      out += c;
      i++;
      while (i < n && src[i] !== q) {
        if (src[i] === '\\') {
          out += src[i]! + (src[i + 1] ?? '');
          i += 2;
          continue;
        }
        out += src[i];
        i++;
      }
      out += src[i] ?? '';
      i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') {
        out += ' ';
        i++;
      }
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i);
      const stop = end === -1 ? n : end + 2;
      for (; i < stop; i++) out += src[i] === '\n' ? '\n' : ' ';
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

interface SourceFile {
  path: string;
  code: string;
}

const FILES: SourceFile[] = walk(APP_DIR)
  .map((full) => ({ path: relative(REPO_ROOT, full), code: stripComments(readFileSync(full, 'utf8')) }))
  .sort((a, b) => a.path.localeCompare(b.path));

/** The theme module itself is where literals BELONG, and tests are apparatus. */
const PALETTE_HOME = ['app/lib/theme.ts', 'app/lib/theme-context.tsx'];

function isTest(path: string): boolean {
  return path.includes('__tests__');
}

/**
 * EVERY SYNTACTIC FORM A COLOUR CAN TAKE — each with a known-positive sample the
 * test below feeds it, because a class the matcher cannot see is a class the
 * codebase can hide a defect in. The old single-quote-only matcher hid 25.
 *
 * `transparent` is NOT here and is deliberately allowed: it is the absence of a
 * colour, identical in both palettes, and tokenising it would buy nothing.
 */
const LITERAL_CLASSES: ReadonlyArray<{ name: string; re: RegExp; positive: string }> = [
  {
    name: "single-quoted hex",
    re: /'#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})'/g,
    positive: "backgroundColor: '#101419',",
  },
  {
    // The class that hid the invisible spinners: a JSX attribute is double-quoted
    // by convention and is not inside a stylesheet at all.
    name: 'double-quoted hex (JSX attribute)',
    re: /"#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})"/g,
    positive: '<ActivityIndicator color="#cfcfcf" />',
  },
  {
    // Anywhere, not just inside a module-scope sheet — the old matcher only
    // looked there, so an `rgba(...)` inside a factory was unchecked.
    //
    // LITERAL channel values only. `withAlpha(theme.link, .4)` builds
    // `` `rgba(${r},${g},${b},${alpha})` `` from a palette colour it was HANDED,
    // which follows the theme perfectly and is the correct way to get a tint; a
    // matcher that flagged it would be pushing people back toward writing the
    // wash out by hand.
    name: 'rgb()/rgba() literal, anywhere',
    re: /['"`]rgba?\(\s*[\d.\s,%]+\)/g,
    positive: "backgroundColor: 'rgba(0,0,0,0.6)',",
  },
  {
    // Never used in this tree today, and that is worth locking in rather than
    // discovering later: a named colour follows no palette at all.
    name: 'CSS named colour in a colour position',
    re: /(?:[Cc]olor\s*[:=]\s*\{?\s*|[Cc]olor=)['"](?:red|green|blue|black|white|gray|grey|yellow|orange|purple|pink|cyan|magenta|silver|gold|navy|teal|olive|maroon|lime|aqua|fuchsia)['"]/g,
    positive: 'placeholderTextColor="grey"',
  },
];

function colourLiterals(code: string): string[] {
  const hits: string[] = [];
  for (const { re } of LITERAL_CLASSES) {
    for (const m of code.matchAll(re)) hits.push(m[0]);
  }
  return hits;
}

describe('the guard can see the source it is guarding', () => {
  it('found the app tree, with comments stripped and strings intact', () => {
    // The positive control. A walker that matched nothing, or a comment-stripper
    // that blanked everything, would make every assertion below vacuously true —
    // the "make the tool prove it can return a POSITIVE" habit, applied here
    // because every other test in this file is an ABSENCE claim.
    expect(FILES.length).toBeGreaterThan(200);
    const theme = FILES.find((f) => f.path === 'app/lib/theme.ts');
    expect(theme, 'app/lib/theme.ts must be in the scan').toBeDefined();
    // A string literal survives stripping...
    expect(theme!.code).toContain("'#101419'");
    // ...and a docblock does not.
    expect(theme!.code).not.toContain('THE NEUTRON BLUE');
  });

  it('the matcher can see every class of colour literal', () => {
    // The control for the matcher itself, not for the walker. Each class is fed a
    // sample that IS a violation; a class that reports nothing here is a class the
    // absence assertions below cannot speak for. This exists because the previous
    // matcher silently omitted double-quoted hex and let 25 real defects through
    // while reading as a passing guard.
    for (const { name, re, positive } of LITERAL_CLASSES) {
      expect(colourLiterals(positive).length, `${name}: sample not matched`).toBeGreaterThan(0);
      expect([...positive.matchAll(re)].length, `${name}: own regex missed its sample`).toBe(1);
    }
    // ...and the allowed value is NOT flagged, so the guard is not simply
    // matching everything.
    expect(colourLiterals("backgroundColor: 'transparent',")).toEqual([]);
    expect(colourLiterals('backgroundColor: theme.background,')).toEqual([]);
  });
});

describe('the captured palette no longer exists', () => {
  it('lib/theme.ts exports neither THEME nor PHASE', async () => {
    // Deleting the export is what turns "a component still reads dark" from a
    // visual bug into a compile error. Asserted on the MODULE, not the text, so a
    // re-export from anywhere would also fail.
    const mod = (await import('../lib/theme')) as Record<string, unknown>;
    expect(mod['THEME']).toBeUndefined();
    expect(mod['PHASE']).toBeUndefined();
    // ...and the replacements are all present, so this is not passing because the
    // import failed.
    expect(mod['DARK_THEME']).toBeDefined();
    expect(mod['LIGHT_THEME']).toBeDefined();
    expect(mod['DARK_PHASE']).toBeDefined();
    expect(mod['LIGHT_PHASE']).toBeDefined();
  });

  it('no COMPONENT imports THEME or PHASE from the theme module or its barrel', () => {
    // Tests are excluded because several legitimately alias a named palette to the
    // old name (`import { DARK_THEME as THEME }`) to keep an existing lock-test
    // readable. That is apparatus asserting on a palette BY NAME, which is the
    // opposite of a component capturing whichever one happened to be default.
    const offenders = FILES.filter((f) => !PALETTE_HOME.includes(f.path) && !isTest(f.path))
      .filter((f) => /import\s*\{[^}]*\b(THEME|PHASE)\b[^}]*\}\s*from\s*'[^']*(theme|composer-constants)'/s.test(f.code))
      .map((f) => f.path);
    expect(offenders, `these still import the captured palette:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('the composer-constants barrel no longer passes a palette through', () => {
    // Six components imported `THEME` from here and named `lib/theme` nowhere, so
    // a grep for the theme import missed them entirely. The barrel is the reason
    // that was possible, so the barrel is where it is prevented.
    const barrel = FILES.find((f) => f.path === 'app/lib/composer-constants.ts');
    expect(barrel).toBeDefined();
    expect(barrel!.code).not.toMatch(/\bTHEME\b/);
    expect(barrel!.code).not.toMatch(/\bPHASE\b/);
  });
});

describe('no COLOUR is resolved at module load', () => {
  it('no module-scope stylesheet contains a colour', () => {
    // The invariant, stated structurally. A module-scope `const styles =
    // StyleSheet.create(...)` resolves its contents once, at import, and can never
    // change — so a COLOUR in one can never follow the theme. The converted form is
    // `const makeStyles = (theme) => StyleSheet.create(...)` consumed via
    // `useThemedStyles`, which yields a sheet per palette.
    //
    // A module-scope sheet holding only LAYOUT is fine and is deliberately allowed:
    // `LauncherGrid`'s is four flexbox properties and `VoiceNoteBubble`'s is
    // geometry only (it takes its colours from the bubble tone it is handed). There
    // is nothing theme-dependent in either, so requiring them to become factories
    // would be churn that buys no correctness. The rule is about colour, not about
    // where a sheet lives.
    //
    // No file is skipped any more. The `.filter(f => !(f.path in BUDGET))` that
    // used to sit here is why 19 files were never checked at all.
    const offenders = FILES.filter((f) => !isTest(f.path) && !PALETTE_HOME.includes(f.path))
      .filter((f) => {
        const m = /^(?:export\s+)?const\s+\w*styles\w*\s*=\s*StyleSheet\.create\(/im.exec(f.code);
        if (m === null) return false;
        return colourLiterals(f.code.slice(m.index)).length > 0;
      })
      .map((f) => f.path);
    expect(
      offenders,
      `these resolve a colour at module load, so it cannot follow the theme:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('and there are plenty of factories, so the rule is being followed not dodged', () => {
    // The other direction: a codebase that deleted every stylesheet would satisfy
    // the assertion above. This is the positive half.
    const factories = FILES.filter((f) => /const makeStyles = \(/.test(f.code));
    expect(factories.length).toBeGreaterThan(60);
  });
});

describe('no colour literal exists outside the theme module', () => {
  const counted = FILES.filter((f) => !isTest(f.path) && !PALETTE_HOME.includes(f.path))
    .map((f) => [f.path, colourLiterals(f.code)] as const)
    .filter(([, hits]) => hits.length > 0);

  it('ZERO, with no per-file budget and no exempt files', () => {
    // The whole invariant, in one assertion, because there is nothing left to
    // qualify. Every colour a component draws comes from `useTheme()` /
    // `useThemedStyles`, so flipping the palette flips the component — which is
    // the property "light mode works" actually reduces to.
    //
    // If this fails: do not add the file to a list. Take the colour from the
    // palette, and if the palette has no token for what you mean, add one there
    // first (`lib/theme.ts` names the two deliberately theme-INVARIANT ones,
    // `scrim` and `veil`, so "this genuinely does not change" already has a home
    // that is not a hardcoded literal).
    const offenders = counted.map(([path, hits]) => `${path}: ${hits.join(' ')}`);
    expect(
      offenders,
      `these hardcode colours — take them from useTheme() instead:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('and the two files that DO hold literals are the palette itself', () => {
    // The complement, so "zero" cannot be passing because the scan found nothing
    // anywhere. The colours have to live SOMEWHERE, and this names where.
    for (const home of PALETTE_HOME) {
      const f = FILES.find((x) => x.path === home);
      expect(f, `${home} must exist`).toBeDefined();
    }
    const themeFile = FILES.find((f) => f.path === 'app/lib/theme.ts')!;
    expect(colourLiterals(themeFile.code).length).toBeGreaterThan(60);
  });
});
