/**
 * @neutronai/app — upload-client unit tests (P5.1).
 *
 * Covers the happy path + every failure branch in `uploadAttachment`
 * via a stub `fetch_impl`. No network. No platform-bound APIs.
 */

import { describe, expect, it } from 'bun:test';

import { mimeToExt, uploadAttachment } from '../lib/upload-client';

/**
 * `typeof fetch` requires `preconnect` in newer @types/bun, but our
 * test stubs don't need that surface. Cast to `typeof fetch` via the
 * runtime hatch so each stub stays a minimal `(...) => Promise<Response>`.
 */
type FetchStub = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
const asFetch = (s: FetchStub): typeof fetch => s as unknown as typeof fetch;

describe('uploadAttachment', () => {
  it('returns the gateway-provided URL on success', async () => {
    const fetch_impl = asFetch(async () =>
      new Response(JSON.stringify({ url: '/api/app/upload/abc123' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const events: string[] = [];
    const result = await uploadAttachment({
      uri: 'data:image/png;base64,iVBORw0KGgo=',
      token: 'tok',
      base_url: 'http://gw',
      fetch_impl,
      onProgress: (p) => events.push(p.phase),
    });
    expect(result).not.toBeNull();
    expect(result?.url).toBe('/api/app/upload/abc123');
    expect(events).toContain('started');
    expect(events).toContain('complete');
  });

  it('returns null + emits an error event on a 500 response', async () => {
    const fetch_impl = asFetch(async () => new Response('boom', { status: 500 }));
    const events: { phase: string; code?: string }[] = [];
    const result = await uploadAttachment({
      uri: 'data:image/png;base64,iVBORw0KGgo=',
      token: 'tok',
      base_url: 'http://gw',
      fetch_impl,
      onProgress: (p) =>
        events.push(p.phase === 'error' ? { phase: p.phase, code: p.code } : { phase: p.phase }),
    });
    expect(result).toBeNull();
    const errorEvent = events.find((e) => e.phase === 'error');
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.code).toBe('http_500');
  });

  it('returns null + emits an error event on a malformed JSON success', async () => {
    const fetch_impl = asFetch(async () => new Response('not json', { status: 200 }));
    const events: { phase: string; code?: string }[] = [];
    const result = await uploadAttachment({
      uri: 'data:image/png;base64,iVBORw0KGgo=',
      token: 'tok',
      base_url: 'http://gw',
      fetch_impl,
      onProgress: (p) =>
        events.push(p.phase === 'error' ? { phase: p.phase, code: p.code } : { phase: p.phase }),
    });
    expect(result).toBeNull();
    expect(events.find((e) => e.phase === 'error')?.code).toBe('malformed_response');
  });

  it('returns null + emits an error event on a network throw', async () => {
    const fetch_impl = asFetch(async () => {
      throw new Error('econnreset');
    });
    const events: { phase: string; code?: string }[] = [];
    const result = await uploadAttachment({
      uri: 'data:image/png;base64,iVBORw0KGgo=',
      token: 'tok',
      base_url: 'http://gw',
      fetch_impl,
      onProgress: (p) =>
        events.push(p.phase === 'error' ? { phase: p.phase, code: p.code } : { phase: p.phase }),
    });
    expect(result).toBeNull();
    expect(events.find((e) => e.phase === 'error')?.code).toBe('network');
  });
});

describe('mimeToExt — M2 modality parity', () => {
  it('maps images + PDF to their extensions, else bin', () => {
    expect(mimeToExt('image/png')).toBe('png');
    expect(mimeToExt('image/jpeg')).toBe('jpg');
    expect(mimeToExt('image/gif')).toBe('gif');
    expect(mimeToExt('image/webp')).toBe('webp');
    // M2 documents — PDF now maps (previously fell through to 'bin').
    expect(mimeToExt('application/pdf')).toBe('pdf');
    expect(mimeToExt('application/zip')).toBe('zip');
  });

  it('maps M2 task-5 audio voice notes (canonical + iOS/legacy aliases)', () => {
    expect(mimeToExt('audio/mpeg')).toBe('mp3');
    expect(mimeToExt('audio/mp3')).toBe('mp3');
    expect(mimeToExt('audio/mp4')).toBe('m4a');
    expect(mimeToExt('audio/m4a')).toBe('m4a');
    expect(mimeToExt('audio/x-m4a')).toBe('m4a');
    expect(mimeToExt('audio/wav')).toBe('wav');
    expect(mimeToExt('audio/x-wav')).toBe('wav');
    expect(mimeToExt('audio/wave')).toBe('wav');
    // An unknown audio subtype still falls through to bin.
    expect(mimeToExt('audio/ogg')).toBe('bin');
  });
});
