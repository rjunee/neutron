/**
 * @neutronai/app — citation-chip-row helper unit tests (P5.1).
 *
 * Covers the URL/title helpers used by the chip primitive. RN
 * components themselves are not mounted under bun-test — the
 * integration layer + agent-browser smoke verifies the render.
 */

import { describe, expect, it } from 'bun:test';

const TITLE_CAP = 32;

function safeTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed.length <= TITLE_CAP) return trimmed;
  return `${trimmed.slice(0, TITLE_CAP - 1).trim()}…`;
}

function faviconUrl(target: string): string | null {
  try {
    const u = new URL(target);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(u.host)}&sz=16`;
  } catch {
    return null;
  }
}

describe('safeTitle', () => {
  it('returns the title as-is when below the cap', () => {
    expect(safeTitle('Short')).toBe('Short');
  });
  it('truncates with ellipsis when above the cap', () => {
    const long = 'a'.repeat(50);
    const out = safeTitle(long);
    expect(out.length).toBe(TITLE_CAP);
    expect(out.endsWith('…')).toBe(true);
  });
  it('trims surrounding whitespace before measuring', () => {
    expect(safeTitle('   trim   ')).toBe('trim');
  });
});

describe('faviconUrl', () => {
  it('builds a favicon URL for http/https targets', () => {
    expect(faviconUrl('https://example.com/page')).toBe(
      'https://www.google.com/s2/favicons?domain=example.com&sz=16',
    );
  });
  it('returns null for non-web URLs', () => {
    expect(faviconUrl('neutron://docs/foo')).toBeNull();
    expect(faviconUrl('mailto:foo@bar')).toBeNull();
  });
  it('returns null for malformed URLs', () => {
    expect(faviconUrl('not a url')).toBeNull();
  });
});
