/**
 * THE MOBILE REACHABILITY GATE'S OWN GATE — has the inventory fallen behind the
 * app?
 *
 * A reachability suite is only worth what its inventory covers, and an inventory
 * maintained by remembering is an inventory that rots. This is the piece that
 * makes the mobile half self-extending. It reads two things out of the app's own
 * source and fails when either has moved on without the gate.
 *
 * 1. THE COMPOSER'S OPTIONAL CALLBACKS. `InputComposer` renders controls whose
 *    behaviour lives in props the HOST supplies, and every one of those props is
 *    optional — so a host that forgets one ships a control that renders
 *    perfectly and does nothing. That is not a hypothetical: it is exactly how
 *    voice messages shipped, with `ChatSyncSurface` mounting the composer minus
 *    its four `onVoice*` props and the mic answering "Voice messages are not
 *    available yet." Every optional callback must therefore be exercised by an
 *    affordance in `reachability-inventory.ts`, or excluded there in writing,
 *    with a reason. Adding the next one turns this red on the PR that adds it.
 *
 * 2. WHETHER THE APP STILL HAS ONE LAYOUT. The web gate's second axis is layout
 *    width; the mobile gate's is platform, because every width branch in this
 *    app is gated on `Platform.OS === 'web'` and web is not a shipped platform
 *    (`app/app.json`). That is a claim about the source, and claims about source
 *    go stale — so it is re-derived here on every run instead of being written
 *    in a comment and believed. The day someone ships a real tablet layout, this
 *    reds and says the reachability matrix needs a width axis back.
 *
 * WHY SOURCE SCANS AND NOT RUNTIME ONES. Neither question can be asked of the
 * running tree. "Which callbacks does the composer accept?" is a type, erased
 * before anything runs; "does this width branch apply on a phone?" is a
 * condition whose whole point is that it was false on the platform the test ran
 * on. The alternative was to make components declare their own seams for a
 * test's benefit — a product change made to serve a gate. Two small regexes over
 * files a person already reads is the cheaper seam.
 *
 * FALSE-ALARM SURFACE, deliberately tiny: one props interface and one constant
 * name. Neither can fire on a renamed style, a moved component or anything in a
 * Core. Both scans assert they found a plausible number of hits FIRST, so a
 * refactor that moves the file fails LOUDLY as "the scan found nothing" rather
 * than passing vacuously on an empty set — the failure mode that let a dead gate
 * sit green for days (#384/#388).
 */

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  COMPOSER_HANDLER_EXCLUSIONS,
  NATIVE_WIDTH_BRANCHES,
  OWNER_AFFORDANCES,
} from './reachability-inventory';

const APP_ROOT = join(import.meta.dir, '..');
const COMPOSER_FILE = join(APP_ROOT, 'components', 'InputComposer.tsx');

/**
 * Lower bounds. Not exact counts — an exact count is a second inventory to
 * maintain, and the whole point is to have one. These only have to be high
 * enough that a scan matching nothing is a failure instead of a pass.
 */
const MIN_EXPECTED_CALLBACKS = 5;
const MIN_EXPECTED_WIDTH_BRANCHES = 5;

/** Every optional CALLBACK prop `InputComposer` accepts. */
function optionalComposerCallbacks(): string[] {
  const source = readFileSync(COMPOSER_FILE, 'utf8');
  const start = source.indexOf('export interface InputComposerProps {');
  if (start < 0) return [];
  // The interface ends at the first line that closes it at column zero.
  const end = source.indexOf('\n}', start);
  const body = source.slice(start, end < 0 ? source.length : end);
  const names = new Set<string>();
  // `name?: (` — an optional prop whose type opens a parameter list, i.e. a
  // function. Skips `sending?: boolean`, `file_accept?: string` and friends.
  for (const m of body.matchAll(/^ {2}(\w+)\?:\s*\(/gm)) names.add(m[1] as string);
  return [...names].sort();
}

/** Every app source file, tests excluded. */
function appSources(dir: string = APP_ROOT, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) appSources(full, out);
    else if (full.endsWith('.ts') || full.endsWith('.tsx')) out.push(full);
  }
  return out;
}

interface WidthBranch {
  /** Path relative to `app/`, the form the inventory records. */
  readonly file: string;
  readonly line: number;
  /** Is it gated on the web platform, i.e. unreachable on a shipped phone? */
  readonly webOnly: boolean;
}

/** Every place the app compares a viewport width to the breakpoint. */
function widthBranches(): WidthBranch[] {
  const out: WidthBranch[] = [];
  for (const file of appSources()) {
    const rel = file.slice(APP_ROOT.length + 1);
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((text, i) => {
      const code = text.trim();
      // Prose mentions the breakpoint constantly (the components document their
      // own responsive rules); only executable lines are branches.
      if (code.startsWith('*') || code.startsWith('//') || code.startsWith('/*')) return;
      if (!/BREAKPOINTS\.narrow_max/.test(code)) return;
      if (!/[<>]/.test(code)) return;
      out.push({ file: rel, line: i + 1, webOnly: /Platform\.OS\s*===\s*'web'/.test(code) });
    });
  }
  return out;
}

describe('reachability — the mobile inventory still describes the app', () => {
  test('the composer scan is alive', () => {
    // A scan that matches nothing would make the assertion below vacuously true.
    // That is how a gate becomes decoration.
    expect(optionalComposerCallbacks().length).toBeGreaterThanOrEqual(MIN_EXPECTED_CALLBACKS);
  });

  test('every optional composer callback is either probed or excluded with a reason', () => {
    const found = optionalComposerCallbacks();
    const probed = new Set(OWNER_AFFORDANCES.flatMap((a) => a.handlers ?? []));
    const excluded = new Set(COMPOSER_HANDLER_EXCLUSIONS.map((e) => e.handler));

    const unaccounted = found.filter((h) => !probed.has(h) && !excluded.has(h));
    const report =
      unaccounted.length === 0
        ? ''
        : [
            'The composer accepts these callbacks with no reachability entry.',
            'Every one of them is OPTIONAL, so a host that forgets it ships a control that renders',
            'perfectly and does nothing — that is how the mic shipped saying voice messages were not',
            'available. Add the name to an affordance’s `handlers`, or an entry to',
            'COMPOSER_HANDLER_EXCLUSIONS saying why not:',
            ...unaccounted.map((h) => `  • ${h}`),
          ].join('\n');
    expect(report).toBe('');
  });

  test('the inventory does not describe callbacks the composer no longer has', () => {
    // The other direction. A probe for a deleted callback fails at runtime as
    // "the owner lost voice messages", which is a confusing way to learn that a
    // prop was renamed. Catch it here, where the message is accurate.
    const found = new Set(optionalComposerCallbacks());
    const stale = [
      ...OWNER_AFFORDANCES.flatMap((a) => a.handlers ?? []),
      ...COMPOSER_HANDLER_EXCLUSIONS.map((e) => e.handler),
    ].filter((h) => !found.has(h));
    expect(stale).toEqual([]);
  });

  test('every exclusion carries a real reason', () => {
    // An exclusion is a decision with a cost. A blank `why` is a way of not
    // making the decision while looking like you did.
    const thin = [
      ...COMPOSER_HANDLER_EXCLUSIONS.filter((e) => e.why.trim().length < 40).map((e) => e.handler),
      ...NATIVE_WIDTH_BRANCHES.filter((b) => b.why.trim().length < 40).map((b) => b.file),
    ];
    expect(thin).toEqual([]);
  });

  test('the width scan is alive', () => {
    expect(widthBranches().length).toBeGreaterThanOrEqual(MIN_EXPECTED_WIDTH_BRANCHES);
  });

  test('the app still renders one layout on a phone — or the matrix needs a width axis', () => {
    const accounted = new Set(NATIVE_WIDTH_BRANCHES.map((b) => b.file));
    const unaccounted = widthBranches().filter((b) => !b.webOnly && !accounted.has(b.file));
    const report =
      unaccounted.length === 0
        ? ''
        : [
            'These render differently at different widths WITHOUT being gated on the web platform,',
            'so they are real layouts a phone or tablet can be in. The mobile reachability matrix',
            'runs one width because the app had none of these; that is no longer true. Either add a',
            'width axis to reachability.test.ts, or record the branch in NATIVE_WIDTH_BRANCHES with',
            'the reason it is out of scope:',
            ...unaccounted.map((b) => `  • ${b.file}:${b.line}`),
          ].join('\n');
    expect(report).toBe('');
  });

  test('the inventory does not describe width branches that are gone', () => {
    const live = new Set(widthBranches().filter((b) => !b.webOnly).map((b) => b.file));
    const stale = NATIVE_WIDTH_BRANCHES.map((b) => b.file).filter((f) => !live.has(f));
    expect(stale).toEqual([]);
  });
});
