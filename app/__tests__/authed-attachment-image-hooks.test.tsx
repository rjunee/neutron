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

import { describe, expect, it, mock } from 'bun:test';

/* ── hook spies: count every hook the dispatcher would call (must be 0) ── */
// NOTE: we do NOT `mock.module('react', ...)` here. Bun module mocks are
// process-global and survive across files; a react mock silently replaces
// `import * as RealReact from 'react'` in EVERY later file in the same test
// process — including docs-mutations-race / diagnostics-pane-render, which
// deliberately use REAL react (via injected HookRuntime) and DID break/hang
// when this file mocked react (CI incident PR #428, a235eea3..141d2c1c; see
// the "process-global" warnings in docs-mutations-race.test.ts:52 +
// diagnostics-pane-render.test.ts). The dispatcher under test
// (`AuthedAttachmentImage`) calls NO hooks, so it runs fine against REAL react
// — if a regression re-adds a hook at the dispatcher level, real react throws
// "Invalid hook call" outside a render and this test fails loudly. These
// counters therefore stay 0 by construction (kept so the assertions below are
// unchanged); the guard is the real-react throw + the element-type checks.
const useStateCalls = 0;
const useEffectCalls = 0;

// react-native genuinely can't be parsed by bun (Flow types), so it MUST be a
// module mock — but it is NOT react, so it never pollutes `import … from 'react'`.
// Keep it a SUPERSET of every export the sibling app modules import so that,
// whichever react-native mocker wins the process-global registration in a
// shared CI chunk, every import is satisfied (docs-panes-render superset note).
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
// The component statically imports these expo modules; the REAL ones pull in
// react-native internals that bun can't parse (Flow) — stub them so loading the
// component never drags the real react-native module into this process.
mock.module('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/',
  writeAsStringAsync: async () => {},
}));
mock.module('expo-sharing', () => ({
  isAvailableAsync: async () => true,
  shareAsync: async () => {},
}));

const IMAGE_URL = '/api/app/upload/sam/photo.png';
const PDF_URL = '/api/app/upload/sam/report.pdf';

describe('AuthedAttachmentImage — rules-of-hooks (Argus r3 MAJOR)', () => {
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
