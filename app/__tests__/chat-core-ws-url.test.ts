/**
 * @neutronai/app — ISSUES #40 native app-ws URL builder + IANA timezone
 * detection (the mobile counterpart of the web `config.ts` coverage).
 *
 * BLOCKER 2 mutation-kill: `detectClientTimezone` promises `null` when `Intl`
 * throws or resolves an empty/missing zone; removing the try/catch or the
 * empty-guard reddens the null-fallback tests, and the URL then must OMIT `tz`
 * (never emit an empty `tz=` param).
 */
import { describe, expect, it } from 'bun:test';

import { buildWsUrl, detectClientTimezone } from '../lib/chat-core/ws-url';

describe('detectClientTimezone (mobile)', () => {
  it('returns the runtime zone (a non-empty IANA id in the bun test env)', () => {
    const tz = detectClientTimezone();
    expect(typeof tz).toBe('string');
    expect((tz as string).length).toBeGreaterThan(0);
    expect(() => new Intl.DateTimeFormat(undefined, { timeZone: tz as string })).not.toThrow();
  });

  it('returns the resolved zone when the injected resolver yields one', () => {
    expect(detectClientTimezone(() => 'America/New_York')).toBe('America/New_York');
  });

  it('returns null when Intl THROWS (Hermes without full Intl)', () => {
    expect(
      detectClientTimezone(() => {
        throw new RangeError('no Intl timezone support');
      }),
    ).toBeNull();
  });

  it('returns null when the resolver yields empty / missing', () => {
    expect(detectClientTimezone(() => '')).toBeNull();
    expect(detectClientTimezone(() => undefined)).toBeNull();
  });
});

describe('buildWsUrl (mobile)', () => {
  it('carries token, platform=native, device_id, project_id, and tz', () => {
    const u = buildWsUrl('https://h.test', 'tok', 'proj-9', 'dev-1', 'America/New_York');
    expect(u.startsWith('wss://h.test/ws/app/chat?')).toBe(true);
    expect(u).toContain('token=tok');
    expect(u).toContain('platform=native');
    expect(u).toContain('device_id=dev-1');
    expect(u).toContain('project_id=proj-9');
    expect(u).toContain('tz=America%2FNew_York');
  });

  it('uses ws:// for an http base and omits project_id when empty', () => {
    const u = buildWsUrl('http://h.test', 'tok', '', 'dev-1', 'America/New_York');
    expect(u.startsWith('ws://h.test/')).toBe(true);
    expect(u).not.toContain('project_id=');
  });

  it('OMITS tz when detection yields null (no empty tz= param)', () => {
    const noTz = detectClientTimezone(() => {
      throw new Error('boom');
    });
    const u = buildWsUrl('https://h.test', 'tok', 'proj-9', 'dev-1', noTz);
    expect(u).not.toContain('tz=');
  });

  it('OMITS tz when passed an empty-string zone', () => {
    const u = buildWsUrl('https://h.test', 'tok', 'proj-9', 'dev-1', '');
    expect(u).not.toContain('tz=');
  });
});
