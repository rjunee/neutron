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

/**
 * THE STYLESHEET WITH ITS COMMENTS REMOVED — i.e. what the browser actually parses.
 *
 * Every assertion below reads from this rather than from the raw file, and the
 * reason is a defect this file was green through: the comment above `html {
 * font-size: 106.25%; }` was TERMINATED mid-paragraph, and the remaining five lines
 * of prose ran on until a second terminator. A browser reads that trailing prose as
 * a selector prelude, fails to parse it, and CSS error recovery discards the rule
 * that follows — so the 17px rem base, the entire point of the change, never
 * applied. Every test here still passed, because `readFileSync` finds the string
 * whether or not the rule is reachable.
 *
 * That is the general trap, and it is worth naming: MATCHING A DECLARATION IN A
 * FILE IS NOT EVIDENCE THE DECLARATION TAKES EFFECT. Stripping comments the way the
 * parser does — and asserting the comments are well-formed, below — is the cheapest
 * thing that makes the difference visible without a browser.
 */
function styleBlock(html: string): string {
  const open = html.indexOf('<style>');
  const close = html.indexOf('</style>');
  if (open < 0 || close < 0) throw new Error('no <style> block in the web client');
  return html.slice(open + '<style>'.length, close);
}

/** Remove comment spans exactly as a CSS parser does: from the first opener to the
 *  NEXT closer, never nesting. A stray closer therefore survives into the output,
 *  which is what makes it detectable. */
function stripCssComments(css: string): string {
  let out = '';
  let i = 0;
  for (;;) {
    const open = css.indexOf('/*', i);
    if (open < 0) return out + css.slice(i);
    out += css.slice(i, open);
    const close = css.indexOf('*/', open + 2);
    if (close < 0) return out; // unterminated: the parser eats the rest of the sheet
    i = close + 2;
  }
}

const WEB_CSS_PARSED = stripCssComments(styleBlock(WEB_CSS));

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

/**
 * The `html` rem base, in px, read from a PERCENTAGE declaration.
 *
 * It used to be `font-size: 17px` and is now `106.25%`. Both compute to 17px against
 * the 16px default every browser ships — but a percentage SCALES with whatever base
 * the reader has actually configured, and a px value discards it. That distinction is
 * the whole point of the change: a reader who had raised their browser font size to
 * cope with our old 15px body would have been silently overridden by the fix meant to
 * help them.
 *
 * So this test resolves the percentage against the 16px reference rather than reading
 * a px literal. Asserting the literal `106.25%` string instead would be the
 * zero-coverage shape the contrast gate's docblock warns about — it would pass
 * against any value at all, including a revert to a pinned px.
 */
const CSS_DEFAULT_BASE_PX = 16;

function webRemBasePx(): number {
  const pct = /html \{ font-size: ([\d.]+)%; \}/.exec(WEB_CSS_PARSED);
  if (pct !== null) return (Number(pct[1]) / 100) * CSS_DEFAULT_BASE_PX;
  throw new Error('the stylesheet must set a PERCENTAGE rem base on html');
}

describe('the stylesheet the browser sees', () => {
  it('the comment stripper can see a comment at all', () => {
    // Positive control, per the "prove the tool returns a POSITIVE" habit: a
    // stripper that returned its input unchanged would make the assertion below
    // vacuous, and a stripper that returned '' would make it vacuously true.
    expect(stripCssComments('a{} /* gone */ b{}')).toBe('a{}  b{}');
    expect(WEB_CSS_PARSED.length).toBeGreaterThan(10_000);
    expect(WEB_CSS_PARSED.length).toBeLessThan(styleBlock(WEB_CSS).length);
  });

  it('has NO stray comment terminator, so no rule is silently discarded', () => {
    // The assertion the type base needed. A closer left in the parsed output means a
    // comment ended early and the prose after it became garbage in selector position
    // — everything up to the next `{...}` is then dropped by error recovery, which is
    // invisible to any test that greps the raw file.
    const strays = [...WEB_CSS_PARSED.matchAll(/.{0,60}\*\/.{0,60}/g)].map((m) => m[0].trim());
    expect(
      strays,
      `these sit OUTSIDE any comment — a rule after each one is being dropped:\n${strays.join('\n---\n')}`,
    ).toEqual([]);
    // And the complement: no comment left open, which would eat the rest of the sheet.
    const openers = (styleBlock(WEB_CSS).match(/\/\*/g) ?? []).length;
    const closers = (styleBlock(WEB_CSS).match(/\*\//g) ?? []).length;
    expect(closers, 'unbalanced CSS comment delimiters').toBe(openers);
  });
});

describe('web type scale', () => {
  it('the rem BASE is the new body size, and is reader-relative', () => {
    // Both halves. The first is the size; the second is that it is expressed in a
    // form that respects a configured base — a `px` here would satisfy the size
    // assertion and quietly break the preference.
    expect(webRemBasePx()).toBeGreaterThanOrEqual(TELEGRAM_BODY_PX);
    expect(WEB_CSS_PARSED, 'the rem base must be a percentage, not px').toMatch(
      /html \{ font-size: [\d.]+%; \}/,
    );
    expect(WEB_CSS_PARSED).not.toMatch(/html \{ font-size: [\d.]+px; \}/);
  });

  it('body uses the base and a themed line-height', () => {
    expect(WEB_CSS_PARSED).toContain('font: 1rem/var(--body-line)');
    // Light text on a dark ground reads lighter than it is and needs more leading.
    const dark = /:root \{[\s\S]*?--body-line: ([\d.]+);/.exec(WEB_CSS_PARSED);
    const light = /:root\[data-theme="light"\] \{[\s\S]*?--body-line: ([\d.]+);/.exec(WEB_CSS_PARSED);
    expect(dark, 'dark must declare --body-line').not.toBeNull();
    expect(light, 'light must declare --body-line').not.toBeNull();
    expect(Number(dark![1])).toBeGreaterThan(Number(light![1]));
  });

  it('NO control is pinned to an absolute px size any more', () => {
    // This is the assertion that makes the base meaningful. Before, ~147
    // `font-size: Npx` declarations sat between 10px and 22px; a 17px body would
    // have made every one of them read undersized. They are all `rem` now, so the
    // one base above moves the whole UI.
    const pinned = [...WEB_CSS_PARSED.matchAll(/font-size: ([\d.]+)px/g)].map((m) => m[0]);
    // ZERO now, with no exception. The html base used to be the one legitimate px
    // font-size; expressing it as a percentage removes even that, so the rule has no
    // carve-out left to hide behind.
    expect(pinned, `these are still pinned to absolute px:\n${pinned.join('\n')}`).toEqual([]);
  });

  it('and there are many rem sizes, so the rule was applied not deleted', () => {
    // The positive half: a stylesheet that had simply dropped its font sizes would
    // satisfy the assertion above.
    const rems = [...WEB_CSS_PARSED.matchAll(/font-size: [\d.]+rem/g)];
    expect(rems.length).toBeGreaterThan(100);
  });
});

describe('the two clients agree', () => {
  it('the phone and the browser render body copy at the same size', () => {
    // Two clients drifting apart on type size is what produced "ours is more
    // difficult to read" in the first place, and nothing relates a TS token to a
    // CSS declaration except this assertion.
    expect(TYPOGRAPHY.body.fontSize).toBe(webRemBasePx());
  });

  it('the chat transcript is not tighter-leaded than the prose it sits beside', () => {
    // `.car-md p` and `.car-text` used to pin `line-height: 1.4`, which OVERRODE
    // `--body-line` on the one surface the owner was actually complaining about — so
    // the leading fix reached every part of the page except the chat. `--chat-line`
    // is deliberately tighter than body (a bubble should hug its text) and no longer
    // tighter than the old pin.
    for (const sel of ['.car-md p', '.car-text']) {
      const rule = new RegExp(`\\${sel.replace('.', '.')}[^}]*line-height: var\\(--chat-line\\)`);
      expect(WEB_CSS_PARSED, `${sel} must take its leading from --chat-line`).toMatch(rule);
    }
    const dark = /:root \{[\s\S]*?--chat-line: ([\d.]+);/.exec(WEB_CSS_PARSED);
    const light = /:root\[data-theme="light"\] \{[\s\S]*?--chat-line: ([\d.]+);/.exec(WEB_CSS_PARSED);
    expect(dark, 'dark must declare --chat-line').not.toBeNull();
    expect(light, 'light must declare --chat-line').not.toBeNull();
    // Same relationship as --body-line, for the same reason.
    expect(Number(dark![1])).toBeGreaterThan(Number(light![1]));
    // And strictly looser than the 1.4 it replaced.
    expect(Number(light![1])).toBeGreaterThan(1.4);
  });

  it('inline code is sized off the mono token, not a literal', () => {
    // `markdown-render.tsx` pinned `fontSize: 14` while body moved 15 → 17, so the
    // gap between prose and code WIDENED in the change meant to make code legible.
    expect(TYPOGRAPHY.mono.fontSize).toBeGreaterThanOrEqual(15);
    // Code is allowed to be a step below body — a monospace face reads larger at the
    // same nominal size — but not by more than one step of the ramp.
    expect(TYPOGRAPHY.body.fontSize - TYPOGRAPHY.mono.fontSize).toBeLessThanOrEqual(2);
  });
});
