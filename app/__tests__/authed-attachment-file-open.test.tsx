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
import * as React from 'react';

/* ── react hooks WITHOUT a process-global module mock ──────────────────────
 * We do NOT `mock.module('react', ...)`. Bun module mocks are process-global
 * and survive across files; a react mock silently replaces `import * as
 * RealReact from 'react'` in EVERY later file in the same test process —
 * including docs-mutations-race / diagnostics-pane-render, which deliberately
 * use REAL react via an injected HookRuntime and DID break/hang when this file
 * mocked react (CI incident PR #428, a235eea3..141d2c1c; see the "process-
 * global" warnings in docs-mutations-race.test.ts:52 + diagnostics-pane-render).
 *
 * `AuthedAttachmentFile` calls `useState`, so calling it as a plain function
 * would throw "Invalid hook call" under REAL react (no active dispatcher). We
 * install a MINIMAL hook dispatcher on react's current-dispatcher slot for the
 * synchronous duration of that call only (see `pressChip`), then restore it —
 * scoped to this file, never leaking to other files' `import 'react'`. */
const reactInternals = (
  React as unknown as {
    __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown };
  }
).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
const noopHookDispatcher = {
  useState: (initial: unknown) => [
    typeof initial === 'function' ? (initial as () => unknown)() : initial,
    () => {},
  ],
  useEffect: () => {},
  useRef: (v: unknown) => ({ current: v }),
  useMemo: (f: () => unknown) => f(),
  useCallback: (f: unknown) => f,
  useContext: () => undefined,
};

// Shared, MUTABLE Platform so individual tests can flip web ↔ native. The
// component reads `Platform.OS` at call time inside its handler.
const platform = { OS: 'web' as 'web' | 'ios' };
// react-native genuinely can't be parsed by bun (Flow types), so it MUST be a
// module mock — but it is NOT react, so it never pollutes `import … from 'react'`.
// Keep it a SUPERSET of every export the sibling app modules import so that,
// whichever react-native mocker wins the process-global registration in a
// shared CI chunk, every import is satisfied (docs-panes-render superset note).
mock.module('react-native', () => ({
  Image: 'Image',
  Platform: platform,
  Pressable: 'Pressable',
  StyleSheet: { create: (styles: unknown) => styles },
  Text: 'Text',
  View: 'View',
  ScrollView: 'ScrollView',
  TextInput: 'TextInput',
  ActivityIndicator: 'ActivityIndicator',
  Modal: 'Modal',
  Linking: { openURL: () => Promise.resolve() },
  useWindowDimensions: () => ({ width: 1200, height: 800 }),
}));

let openBrowserCalls: string[] = [];
mock.module('expo-web-browser', () => ({
  openBrowserAsync: async (uri: string) => {
    openBrowserCalls.push(uri);
  },
}));

/* ── native file-persist + share (the r2 BLOCKER fix path) ── */
let fsWrites: Array<{ uri: string; base64: string; encoding: string | undefined }> = [];
mock.module('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/',
  writeAsStringAsync: async (
    uri: string,
    contents: string,
    opts?: { encoding?: string },
  ) => {
    fsWrites.push({ uri, base64: contents, encoding: opts?.encoding });
  },
}));

let sharingAvailable = true;
let shareCalls: Array<{ url: string; options: unknown }> = [];
mock.module('expo-sharing', () => ({
  isAvailableAsync: async () => sharingAvailable,
  shareAsync: async (url: string, options?: unknown) => {
    shareCalls.push({ url, options });
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
const origFileReader = (globalThis as { FileReader?: unknown }).FileReader;

// RN provides a `FileReader` global that `blobToDataUrl` uses on the native
// path; bun does not, so stand one up that yields a deterministic data URL.
class FakeFileReader {
  result: string | null = null;
  error: unknown = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readAsDataURL(_blob: Blob) {
    this.result = 'data:application/pdf;base64,UERGQllURVM=';
    queueMicrotask(() => this.onload?.());
  }
}

beforeEach(() => {
  platform.OS = 'web';
  openArgs = [];
  fakeWin = null;
  popupBlocked = false;
  fetchCalls = [];
  createdObjectUrls = 0;
  openBrowserCalls = [];
  fsWrites = [];
  shareCalls = [];
  sharingAvailable = true;
  (globalThis as { FileReader?: unknown }).FileReader =
    FakeFileReader as unknown as typeof FileReader;

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
  (globalThis as { FileReader?: unknown }).FileReader = origFileReader;
});

async function pressChip(url: string, auth: typeof AUTH | null) {
  const mod = await import('../components/AuthedAttachmentImage');
  // Install the minimal hook dispatcher ONLY around the synchronous component
  // call (no `await` in between), then restore it — so a concurrent test's real
  // render can never observe our stub, and we never module-mock react.
  const prevH = reactInternals.H;
  reactInternals.H = noopHookDispatcher;
  try {
    const el = mod.AuthedAttachmentFile({ url, auth }) as {
      props: { onPress: () => Promise<void> };
    };
    return el.props.onPress;
  } finally {
    reactInternals.H = prevH;
  }
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

describe('AuthedAttachmentFile — native open (Argus r2 BLOCKER)', () => {
  it('persists the authed blob to a cache file and hands it to the OS share sheet — never a data: URL to WebBrowser', async () => {
    platform.OS = 'ios';
    const onPress = await pressChip(PDF_URL, AUTH);
    await onPress();
    // The bytes are fetched WITH the bearer (no web popup on native)…
    expect(fetchCalls).toEqual([RESOLVED_PDF]);
    expect(openArgs).toEqual([]);
    // …written to a cache file as base64…
    expect(fsWrites).toHaveLength(1);
    expect(fsWrites[0]).toEqual({
      uri: 'file:///cache/report.pdf',
      base64: 'UERGQllURVM=',
      encoding: 'base64',
    });
    // …and opened via the native share/preview sheet with the blob's mime type.
    expect(shareCalls).toEqual([
      { url: 'file:///cache/report.pdf', options: { mimeType: 'application/pdf' } },
    ]);
    // Crux of the BLOCKER: a data:/file: URL is NEVER handed to WebBrowser
    // (SFSafariViewController / Chrome Custom Tabs reject it), so the open can't
    // fail silently the way the pre-fix `openBrowserAsync(dataUrl)` did.
    expect(openBrowserCalls).toEqual([]);
  });

  it('falls back to WebBrowser with the file:// URL when native sharing is unavailable', async () => {
    platform.OS = 'ios';
    sharingAvailable = false;
    const onPress = await pressChip(PDF_URL, AUTH);
    await onPress();
    expect(fsWrites).toHaveLength(1);
    expect(shareCalls).toEqual([]);
    // Fallback opens the file:// URL — still never a data: URL.
    expect(openBrowserCalls).toEqual(['file:///cache/report.pdf']);
  });
});
