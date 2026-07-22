/**
 * @neutronai/app — `AuthedAttachmentFile` web-open user-activation regression
 * (Argus r1 MAJOR).
 *
 * BUG (pre-fix): the file chip's `open()` handler called
 * `globalThis.open(objUrl, '_blank')` only AFTER `await fetch` + `await
 * res.blob()`. Browsers (Safari especially) only honor `window.open()` while
 * the click's user activation is still live; across those `await`s the
 * activation is gone, so the browser blocks the call as an unrequested popup.
 * The null return was ALSO ignored, so a blocked popup failed silently — the
 * user tapped a PDF and nothing happened, no error surfaced.
 *
 * FIX: open a blank tab SYNCHRONOUSLY inside the gesture (before any await),
 * then navigate it via `location.href` once the blob is ready. A null handle
 * (popup blocked) now short-circuits — we don't fetch, don't leak an object
 * URL, and surface the failure.
 *
 * Convention note (matching `authed-attachment-image-hooks.test.tsx`): the
 * app's bun:test runtime does NOT install React / React-Native, so we
 * virtualize `react`, the jsx runtimes, `react-native` and `expo-web-browser`
 * via `mock.module`, import the real component module, invoke the file-chip
 * component as a plain function to get its `onPress`, and drive that handler
 * against mocked web globals (`globalThis.open`, `fetch`, `URL`).
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

/* ── react: no-op hooks (state is unobservable here; we assert side effects) ── */
mock.module('react', () => {
  const useState = (initial: unknown) => [
    typeof initial === 'function' ? (initial as () => unknown)() : initial,
    () => {},
  ];
  const useEffect = () => {};
  return { useState, useEffect, default: { useState, useEffect } };
});

const jsx = (type: unknown, props: unknown) => ({ type, props });
mock.module('react/jsx-runtime', () => ({ jsx, jsxs: jsx, Fragment: Symbol('Fragment') }));
mock.module('react/jsx-dev-runtime', () => ({ jsxDEV: jsx, Fragment: Symbol('Fragment') }));

// Shared, MUTABLE Platform so individual tests can flip web ↔ native. The
// component reads `Platform.OS` at call time inside its handler.
const platform = { OS: 'web' as 'web' | 'ios' };
mock.module('react-native', () => ({
  Image: 'Image',
  Platform: platform,
  Pressable: 'Pressable',
  StyleSheet: { create: (styles: unknown) => styles },
  Text: 'Text',
  View: 'View',
}));

let openBrowserCalls: string[] = [];
mock.module('expo-web-browser', () => ({
  openBrowserAsync: async (uri: string) => {
    openBrowserCalls.push(uri);
  },
}));

const PDF_URL = '/api/app/upload/sam/report.pdf';
const AUTH = { base_url: 'http://127.0.0.1:8080', token: 'tok' };
const RESOLVED_PDF = 'http://127.0.0.1:8080/api/app/upload/sam/report.pdf';

/* ── web globals the handler touches ── */
type FakeWin = { location: { href: string }; closed: boolean; close: () => void };
let openArgs: Array<[string, string]> = [];
let fakeWin: FakeWin | null = null;
let popupBlocked = false;
let fetchCalls: string[] = [];
let createdObjectUrls = 0;
const origOpen = globalThis.open;
const origFetch = globalThis.fetch;
const origSetTimeout = globalThis.setTimeout;
const origCreate = URL.createObjectURL;
const origRevoke = URL.revokeObjectURL;

beforeEach(() => {
  platform.OS = 'web';
  openArgs = [];
  fakeWin = null;
  popupBlocked = false;
  fetchCalls = [];
  createdObjectUrls = 0;
  openBrowserCalls = [];

  globalThis.open = ((url?: string | URL, target?: string) => {
    openArgs.push([String(url ?? ''), String(target ?? '')]);
    if (popupBlocked) return null;
    fakeWin = { location: { href: '' }, closed: false, close() { this.closed = true; } };
    return fakeWin as unknown as Window;
  }) as typeof globalThis.open;

  globalThis.fetch = (async (input: unknown) => {
    fetchCalls.push(String(input));
    return {
      ok: true,
      status: 200,
      blob: async () => ({ type: 'application/pdf' }) as unknown as Blob,
    } as unknown as Response;
  }) as typeof globalThis.fetch;

  URL.createObjectURL = (() => {
    createdObjectUrls += 1;
    return 'blob:obj-123';
  }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL;
  // Don't leave a real 60s revoke timer pending across the test run.
  globalThis.setTimeout = ((_fn: unknown) => 0) as unknown as typeof globalThis.setTimeout;
});

afterEach(() => {
  globalThis.open = origOpen;
  globalThis.fetch = origFetch;
  globalThis.setTimeout = origSetTimeout;
  URL.createObjectURL = origCreate;
  URL.revokeObjectURL = origRevoke;
});

async function pressChip(url: string, auth: typeof AUTH | null) {
  const mod = await import('../components/AuthedAttachmentImage');
  const el = mod.AuthedAttachmentFile({ url, auth }) as { props: { onPress: () => Promise<void> } };
  return el.props.onPress;
}

describe('AuthedAttachmentFile — web open user-activation (Argus r1 MAJOR)', () => {
  it('opens the tab SYNCHRONOUSLY within the gesture, before the fetch settles', async () => {
    const onPress = await pressChip(PDF_URL, AUTH);
    const pending = onPress();
    // Crux of the fix: the window is opened during the synchronous portion of
    // the handler — before any `await` — so user activation is still live.
    expect(openArgs).toEqual([['', '_blank']]);
    await pending;
    // …and only navigated to the object URL once the blob is ready.
    expect(fakeWin?.location.href).toBe('blob:obj-123');
    expect(fetchCalls).toEqual([RESOLVED_PDF]);
    expect(createdObjectUrls).toBe(1);
  });

  it('when the browser BLOCKS the popup, it does not fetch or leak an object URL', async () => {
    popupBlocked = true;
    const onPress = await pressChip(PDF_URL, AUTH);
    await onPress();
    // Blocked handle short-circuits: no fetch, no blob URL, no silent success.
    expect(openArgs).toEqual([['', '_blank']]);
    expect(fetchCalls).toEqual([]);
    expect(createdObjectUrls).toBe(0);
    expect(openBrowserCalls).toEqual([]);
  });

  it('non-authed url navigates the same synchronously-opened tab, no fetch', async () => {
    const onPress = await pressChip('https://cdn.example/report.pdf', null);
    await onPress();
    expect(openArgs).toEqual([['', '_blank']]);
    expect(fakeWin?.location.href).toBe('https://cdn.example/report.pdf');
    expect(fetchCalls).toEqual([]);
  });
});
