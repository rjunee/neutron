/**
 * @neutronai/app — the type scale, and the two clients agreeing about it.
 *
 * The owner read our chat next to Telegram and asked for a larger size: theirs is
 * *"brighter and more vivid and easier to read"*, ours *"more difficult"*. Body
 * was 15px on both clients; Telegram sits at about 17.
 *
 * Bumping one number would have inverted the hierarchy (a 17px body under a 15px
 * `h4`) and left every control pinned at an absolute px reading small next to it.
 * So the whole ramp moved, and on the web every `font-size` became a `rem` against
 * a 17px root. This file asserts the RELATIONSHIPS that has to preserve, not the
 * individual numbers — a scale is only ever right relative to itself.
 */

import { describe, expect, it } from 'bun:test';

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { TYPOGRAPHY } from '../lib/theme';

/** What Telegram renders body copy at, and therefore the floor the owner asked
 *  for. Not a magic number — it is the comparison he actually made. */
const TELEGRAM_BODY_PX = 17;

const WEB_CSS = readFileSync(
  join(dirname(new URL(import.meta.url).pathname), '..', '..', 'landing', 'chat-react.html'),
  'utf8',
);

describe('mobile type scale', () => {
  it('body is at least as large as the thing it was compared against', () => {
    expect(TYPOGRAPHY.body.fontSize).toBeGreaterThanOrEqual(TELEGRAM_BODY_PX);
  });

  it('the hierarchy is strictly descending, so nothing outranks its heading', () => {
    // The assertion a one-number bump fails. h4 at 15 under a 17px body was the
    // actual risk, and it is the kind of thing that looks like a rendering glitch
    // rather than a type-scale bug.
    const descending = [
      TYPOGRAPHY.h1.fontSize,
      TYPOGRAPHY.h2.fontSize,
      TYPOGRAPHY.h3.fontSize,
      TYPOGRAPHY.h4.fontSize,
    ];
    for (let i = 1; i < descending.length; i++) {
      expect(descending[i]!, `h${i + 1} must not be larger than h${i}`).toBeLessThan(
        descending[i - 1]!,
      );
    }
    expect(TYPOGRAPHY.h4.fontSize).toBeGreaterThanOrEqual(TYPOGRAPHY.body.fontSize);
    expect(TYPOGRAPHY.body.fontSize).toBeGreaterThan(TYPOGRAPHY.body_small.fontSize);
    expect(TYPOGRAPHY.body_small.fontSize).toBeGreaterThan(TYPOGRAPHY.caption.fontSize);
  });

  it('every size has leading that scales with it', () => {
    // A ramp that grew its sizes and kept its old line-heights reads as crowded.
    for (const [name, token] of Object.entries(TYPOGRAPHY)) {
      const ratio = token.lineHeight / token.fontSize;
      expect(ratio, `${name} leading ratio ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(1.25);
      expect(ratio, `${name} leading ratio ${ratio.toFixed(2)}`).toBeLessThanOrEqual(1.6);
    }
  });

  it('the smallest text is still legible on a phone', () => {
    // Captions were 11px. Anything under ~12 is where the owner's complaint
    // started, so this is the floor that keeps it from creeping back.
    expect(TYPOGRAPHY.caption.fontSize).toBeGreaterThanOrEqual(12);
  });
});

describe('web type scale', () => {
  it('the rem BASE is the new body size', () => {
    const m = /html \{ font-size: (\d+)px; \}/.exec(WEB_CSS);
    expect(m, 'the stylesheet must set an explicit rem base on html').not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(TELEGRAM_BODY_PX);
  });

  it('body uses the base and a themed line-height', () => {
    expect(WEB_CSS).toContain('font: 1rem/var(--body-line)');
    // Light text on a dark ground reads lighter than it is and needs more leading.
    const dark = /:root \{[\s\S]*?--body-line: ([\d.]+);/.exec(WEB_CSS);
    const light = /:root\[data-theme="light"\] \{[\s\S]*?--body-line: ([\d.]+);/.exec(WEB_CSS);
    expect(dark, 'dark must declare --body-line').not.toBeNull();
    expect(light, 'light must declare --body-line').not.toBeNull();
    expect(Number(dark![1])).toBeGreaterThan(Number(light![1]));
  });

  it('NO control is pinned to an absolute px size any more', () => {
    // This is the assertion that makes the base meaningful. Before, ~147
    // `font-size: Npx` declarations sat between 10px and 22px; a 17px body would
    // have made every one of them read undersized. They are all `rem` now, so the
    // one base above moves the whole UI.
    const style = WEB_CSS.slice(WEB_CSS.indexOf('<style>'), WEB_CSS.indexOf('</style>'));
    const pinned = [...style.matchAll(/font-size: ([\d.]+)px/g)].map((m) => m[0]);
    // The html base is the ONE legitimate px font-size: it is what rem resolves
    // against, so it cannot itself be relative.
    expect(pinned, `these are still pinned to absolute px:\n${pinned.join('\n')}`).toEqual([
      'font-size: 17px',
    ]);
  });

  it('and there are many rem sizes, so the rule was applied not deleted', () => {
    // The positive half: a stylesheet that had simply dropped its font sizes would
    // satisfy the assertion above.
    const rems = [...WEB_CSS.matchAll(/font-size: [\d.]+rem/g)];
    expect(rems.length).toBeGreaterThan(100);
  });
});

describe('the two clients agree', () => {
  it('the phone and the browser render body copy at the same size', () => {
    // Two clients drifting apart on type size is what produced "ours is more
    // difficult to read" in the first place, and nothing relates a TS token to a
    // CSS declaration except this assertion.
    const base = Number(/html \{ font-size: (\d+)px; \}/.exec(WEB_CSS)![1]);
    expect(TYPOGRAPHY.body.fontSize).toBe(base);
  });
});
