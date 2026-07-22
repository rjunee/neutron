/**
 * @neutronai/app — `AuthedAttachmentImage` rules-of-hooks regression
 * (Argus r3 MAJOR).
 *
 * BUG (pre-fix): `AuthedAttachmentImage` early-returned an
 * `<AuthedAttachmentFile>` for non-image URLs ABOVE the `useState` /
 * `useEffect` block it used for the image path. If the SAME component
 * instance re-rendered with `url` flipping image↔non-image (user sends an
 * image, then a PDF, and React or list virtualization recycles the
 * instance), the number of hooks executed changed between renders — a
 * rules-of-hooks violation that crashes at runtime with "Rendered
 * more/fewer hooks than expected" and trips `eslint-plugin-react-hooks`.
 *
 * FIX: `AuthedAttachmentImage` is now a PURE dispatcher that calls no hooks
 * and branches to two DIFFERENT component types — `AuthedAttachmentFile`
 * (non-image) vs the new hook-owning leaf `AuthedAttachmentImageView`
 * (image). A url flip therefore swaps the rendered component TYPE, so React
 * unmounts the old leaf and mounts a fresh one rather than reusing an
 * instance whose hook count changed. Each leaf renders with a stable hook
 * count for its whole lifetime.
 *
 * Convention note (matching `comments-side-pane.test.tsx`): the app's
 * bun:test runtime does NOT install React / React-Native, so components
 * can't be mounted. We instead virtualize `react`, `react/jsx-runtime`,
 * `react-native` and `expo-web-browser` via `mock.module`, import the real
 * component module, and invoke the dispatcher as a plain function —
 * asserting (a) it dispatches image vs non-image to distinct component
 * types, and (b) it executes ZERO hooks itself (the crux of the fix: the
 * hooks live only in the leaf, never above a branch). Against the pre-fix
 * code, invoking the dispatcher for an image URL runs `useState`/`useEffect`
 * at the top level, so assertion (b) fails — this test is a true regression
 * guard, not just a render smoke test.
 */

import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as RealReact from 'react';
import * as RealJsxRuntime from 'react/jsx-runtime';
import * as RealJsxDevRuntime from 'react/jsx-dev-runtime';

/* ── hook spies: count every hook the imported module actually calls ── */
let useStateCalls = 0;
let useEffectCalls = 0;

// process-global bun mock — must stay a SUPERSET and delegate-to-real outside this suite;
// see docs-mutations-race.test.ts:52 + diagnostics-pane-render superset note; CI incident PR #428 (a235eea3..141d2c1c).
let useStateImpl: (initial: unknown) => unknown = RealReact.useState as never;
let useEffectImpl: (...a: never[]) => unknown = RealReact.useEffect as never;
const useState = (initial: unknown) => useStateImpl(initial);
const useEffect = (...a: never[]) => useEffectImpl(...a);
mock.module('react', () => ({
  ...RealReact,
  useState,
  useEffect,
  default: { ...RealReact, useState, useEffect },
}));

// process-global bun mock — must stay a SUPERSET and delegate-to-real outside this suite;
// see docs-mutations-race.test.ts:52 + diagnostics-pane-render superset note; CI incident PR #428 (a235eea3..141d2c1c).
let jsxImpl: (type: unknown, props: unknown) => unknown = RealJsxRuntime.jsx as never;
mock.module('react/jsx-runtime', () => ({
  ...RealJsxRuntime,
  jsx: (t: unknown, p: unknown) => jsxImpl(t, p),
  jsxs: (t: unknown, p: unknown) => jsxImpl(t, p),
}));
// Bun's test transpiler emits the DEV automatic runtime (`jsxDEV`).
mock.module('react/jsx-dev-runtime', () => ({
  ...RealJsxDevRuntime,
  jsxDEV: (t: unknown, p: unknown, ..._rest: unknown[]) => jsxImpl(t, p),
}));

// process-global bun mock — must stay a SUPERSET and delegate-to-real outside this suite;
// see docs-mutations-race.test.ts:52 + diagnostics-pane-render superset note; CI incident PR #428 (a235eea3..141d2c1c).
mock.module('react-native', () => ({
  Image: 'Image',
  Platform: { OS: 'web' },
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

mock.module('expo-web-browser', () => ({
  openBrowserAsync: async () => {},
}));

const IMAGE_URL = '/api/app/upload/sam/photo.png';
const PDF_URL = '/api/app/upload/sam/report.pdf';

describe('AuthedAttachmentImage — rules-of-hooks (Argus r3 MAJOR)', () => {
  beforeEach(() => {
    useStateCalls = 0;
    useEffectCalls = 0;
    // Point the delegating hooks at this suite's counting stubs.
    useStateImpl = (initial: unknown) => {
      useStateCalls += 1;
      return [typeof initial === 'function' ? (initial as () => unknown)() : initial, () => {}];
    };
    useEffectImpl = () => {
      useEffectCalls += 1;
    };
    jsxImpl = (type: unknown, props: unknown) => ({ type, props });
  });

  // After this suite, the process-global react/jsx mocks must behave exactly
  // like real react for EVERY export — so nothing leaks into later files in
  // the same bun process (the CI-red incident, PR #428 a235eea3..141d2c1c).
  afterAll(() => {
    useStateImpl = RealReact.useState as never;
    useEffectImpl = RealReact.useEffect as never;
    jsxImpl = RealJsxRuntime.jsx as never;
  });

  it('dispatches an IMAGE url to the hook-owning leaf without calling any hook itself', async () => {
    const mod = await import('../components/AuthedAttachmentImage');
    const el = mod.AuthedAttachmentImage({ url: IMAGE_URL, auth: null }) as {
      type: unknown;
    };
    // The dispatcher returns the LEAF component element — it must NOT invoke it,
    // so no hook runs at the dispatcher level.
    expect(el.type).toBe(mod.AuthedAttachmentImageView);
    expect(useStateCalls).toBe(0);
    expect(useEffectCalls).toBe(0);
  });

  it('dispatches a NON-image url to the file chip without calling any hook itself', async () => {
    const mod = await import('../components/AuthedAttachmentImage');
    const el = mod.AuthedAttachmentImage({ url: PDF_URL, auth: null }) as {
      type: unknown;
    };
    expect(el.type).toBe(mod.AuthedAttachmentFile);
    expect(useStateCalls).toBe(0);
    expect(useEffectCalls).toBe(0);
  });

  it('image and non-image URLs resolve to DIFFERENT component types (url flip → React remounts, no hook-count mismatch)', async () => {
    const mod = await import('../components/AuthedAttachmentImage');
    const imageEl = mod.AuthedAttachmentImage({ url: IMAGE_URL, auth: null }) as {
      type: unknown;
    };
    const pdfEl = mod.AuthedAttachmentImage({ url: PDF_URL, auth: null }) as {
      type: unknown;
    };
    // Distinct element types across the flip is exactly what forces React to
    // unmount + remount instead of reusing one instance whose hook count changed.
    expect(imageEl.type).not.toBe(pdfEl.type);
  });

  it('flipping the same dispatcher call image→non-image→image never runs a hook at the dispatcher level', async () => {
    const mod = await import('../components/AuthedAttachmentImage');
    // Simulate a recycled instance re-rendering with a flipping url. Because the
    // dispatcher is hook-free, no sequence of url values can change its hook
    // count (the pre-fix crash). The leaf it returns owns the hooks per-type.
    for (const url of [IMAGE_URL, PDF_URL, IMAGE_URL, PDF_URL]) {
      mod.AuthedAttachmentImage({ url, auth: null });
    }
    expect(useStateCalls).toBe(0);
    expect(useEffectCalls).toBe(0);
  });
});
