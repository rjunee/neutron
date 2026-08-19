/**
 * MOBILE — the inline-activity expiry poll must be QUIET.
 *
 * THE DEFECT THIS PINS. `inline_active` now arrives DERIVED from a 90 s
 * write-evidence window, so it expires on a clock with no write to push a fresh
 * frame; the board screen therefore re-polls while any card reads inline-active.
 * The screen renders `loading` as a FULL-SCREEN spinner that REPLACES the whole
 * board, and its error path empties the list. Pointing that poll at the loud
 * `refresh` blanked the board every 15 s — for as long as the feature was on,
 * which is to say precisely while the owner was watching something happen.
 *
 * The web sibling (landing/chat-react/WorkBoardTab.tsx) already had the quiet
 * parameter; this is the mobile half. The refresh body is MIRRORED here rather
 * than rendered, in the style of `workboard-doc-link.test.tsx`, and held in step
 * with the real screen by the source assertions at the bottom.
 */

import { describe, expect, it } from 'bun:test';

interface Spy {
  loading: boolean[];
  items: string[][];
  errors: (string | null)[];
}

/** The screen's `refresh`, mirrored. */
function makeRefresh(
  spy: Spy,
  list: () => Promise<string[]>,
): (quiet?: boolean) => Promise<void> {
  return async (quiet = false): Promise<void> => {
    if (!quiet) {
      spy.loading.push(true);
      spy.errors.push(null);
    }
    try {
      const rows = await list();
      spy.items.push(rows);
      spy.loading.push(false);
    } catch {
      spy.loading.push(false);
      if (quiet) return;
      spy.items.push([]);
      spy.errors.push('could not load the work board');
    }
  };
}

function spy(): Spy {
  return { loading: [], items: [], errors: [] };
}

describe('the board screen refresh — quiet vs loud', () => {
  it('a QUIET refresh never raises the full-screen spinner', async () => {
    const s = spy();
    await makeRefresh(s, async () => ['a'])(true);
    // Deleting the `if (!quiet)` guard turns this red: `true` reappears and the
    // board is replaced by an ActivityIndicator on every poll tick.
    expect(s.loading).not.toContain(true);
    expect(s.items).toEqual([['a']]);
  });

  it('a QUIET refresh that fails leaves the board standing', async () => {
    const s = spy();
    await makeRefresh(s, async () => {
      throw new Error('gateway blipped');
    })(true);
    // One flaky 15 s poll must not empty a populated board or paint an error.
    expect(s.items).toEqual([]);
    expect(s.errors).toEqual([]);
  });

  it('the LOUD refresh is unchanged — spinner on entry, error copy on failure', async () => {
    const s = spy();
    await makeRefresh(s, async () => {
      throw new Error('gateway down');
    })();
    expect(s.loading[0]).toBe(true);
    expect(s.items).toEqual([[]]);
    expect(s.errors.at(-1)).toBe('could not load the work board');
  });
});

describe('the screen actually uses it that way', () => {
  it('polls quietly, and keeps the owner’s explicit Retry loud', async () => {
    const src = await Bun.file(
      new URL('../app/projects/[id]/workboard.tsx', import.meta.url),
    ).text();
    // `includes`, not `toContain`: a failing `toContain` prints the whole file.
    expect(src.includes('const refresh = useCallback((quiet = false): void => {')).toBe(true);
    // The poll must go through the quiet path…
    expect(/hasInlineActive[\s\S]{0,220}?refresh\(true\)/.test(src)).toBe(true);
    // …and must NOT hand `setInterval` the bare function again (the defect).
    expect(src.includes('setInterval(refresh,')).toBe(false);
    // Retry is WRAPPED: a Pressable passes its press event as the first argument,
    // which would silently make the owner's own retry the quiet one.
    expect(src.includes('onPress={refresh}')).toBe(false);
  });
});
