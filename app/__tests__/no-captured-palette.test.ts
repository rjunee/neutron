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
 *   3. the population of raw hex literals cannot GROW.
 *
 * Invariant 3 is a ratchet, not a clean bill of health. See the note on
 * HARDCODED_HEX_BUDGET: there is a real, pre-existing, still-unfixed gap here and
 * this test's job is to state its exact size rather than to imply it is closed.
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
 * RAW HEX LITERALS, PER FILE — A RATCHET OVER A KNOWN GAP.
 *
 * These are colours written directly into a component instead of taken from the
 * palette, so they do NOT change with the theme. Every entry below is a screen
 * that will still look dark in light mode, and none of it is new: these files
 * never imported the palette at all, which is exactly why the theme conversion
 * did not touch them and why no compiler error pointed at them. They were found by
 * scanning for hex literals after the conversion was already green.
 *
 * The count is frozen rather than fixed because fixing it is a second lane of
 * comparable size to the first (~300 literals across the admin panes, the Cores
 * screens and the docs tab), and shipping a half-converted admin surface inside
 * this change would make both harder to review. Filed as a known gap; see
 * `AS-BUILT.md` and the PR body.
 *
 * WHAT THIS TEST BUYS: the number cannot go UP. A new component cannot hardcode a
 * colour, and a fix can only lower an entry. That makes the gap finite and
 * visible instead of ambient.
 */
const HARDCODED_HEX_BUDGET: Readonly<Record<string, number>> = {
  'app/app/admin.tsx': 11,
  'app/app/cores/[slug].tsx': 29,
  'app/app/index.tsx': 1,
  'app/app/integrations.tsx': 3,
  'app/app/projects/[id]/backups.tsx': 20,
  'app/app/projects/[id]/cores/dtc-analytics.tsx': 30,
  'app/components/ActivityInspectorDrawer.tsx': 1,
  'app/components/CommentsSidePane.tsx': 1,
  'app/components/DocsDrillList.tsx': 6,
  'app/components/ProjectSettingsDrawer.tsx': 1,
  'app/features/admin/BackupPane.tsx': 43,
  'app/features/admin/CoresPane.tsx': 24,
  'app/features/admin/DiagnosticsPane.tsx': 21,
  'app/features/admin/GatewayPane.tsx': 17,
  'app/features/admin/MaxAccountPane.tsx': 17,
  'app/features/admin/MemoryPane.tsx': 18,
  'app/features/admin/PersonalityPane.tsx': 36,
  'app/features/docs/docs-ui.tsx': 78,
  'app/lib/markdown-render.tsx': 1,
};

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
    const offenders = FILES.filter((f) => !isTest(f.path) && !PALETTE_HOME.includes(f.path))
      .filter((f) => !(f.path in HARDCODED_HEX_BUDGET))
      .filter((f) => {
        const m = /^(?:export\s+)?const\s+\w*styles\w*\s*=\s*StyleSheet\.create\(/im.exec(f.code);
        if (m === null) return false;
        const body = f.code.slice(m.index);
        return /'#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})'|rgba?\(/.test(body);
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


describe('raw hex literals cannot spread', () => {
  const HEX = /'#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})'/g;

  function hexCount(code: string): number {
    return (code.match(HEX) ?? []).length;
  }

  const counted = FILES.filter((f) => !isTest(f.path) && !PALETTE_HOME.includes(f.path))
    .map((f) => [f.path, hexCount(f.code)] as const)
    .filter(([, n]) => n > 0);

  it('no file hardcodes MORE colours than its recorded budget', () => {
    const grown = counted
      .filter(([path, n]) => n > (HARDCODED_HEX_BUDGET[path] ?? 0))
      .map(([path, n]) => `${path}: ${n} (budget ${HARDCODED_HEX_BUDGET[path] ?? 0})`);
    expect(
      grown,
      `these gained hardcoded colours — take them from useTheme() instead:\n${grown.join('\n')}`,
    ).toEqual([]);
  });

  it('no file outside the recorded set hardcodes a colour at all', () => {
    const fresh = counted.filter(([path]) => !(path in HARDCODED_HEX_BUDGET)).map(([p, n]) => `${p}: ${n}`);
    expect(
      fresh,
      `new files must read colours from the palette:\n${fresh.join('\n')}`,
    ).toEqual([]);
  });

  it('the budget has no stale entries, so a fix must lower the number', () => {
    // Without this, a file could be fully fixed and its budget left behind,
    // and the ratchet would silently allow the hardcoding to come back.
    const live = new Map(counted);
    const stale = Object.entries(HARDCODED_HEX_BUDGET)
      .filter(([path, n]) => (live.get(path) ?? 0) !== n)
      .map(([path, n]) => `${path}: budget ${n}, actual ${live.get(path) ?? 0}`);
    expect(stale, `update the budget to match reality:\n${stale.join('\n')}`).toEqual([]);
  });
});
