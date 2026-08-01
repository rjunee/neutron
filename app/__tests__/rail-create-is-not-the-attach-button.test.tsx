/**
 * @neutronai/app — TWO `+` CONTROLS, ONE SCREEN (owner report, on device).
 *
 * "The + button in the composer bar for adding attachments is close to, and
 * looks the same as, the + for adding projects."
 *
 * They do unrelated things — one attaches a file to a message, the other creates
 * a project — and after #40 widened the composer to the viewport they sit a
 * thumb apart at the screen's bottom-left, both rendered as a bare plus. The
 * composer's is the one that stays: a leading `+` in a message composer is what
 * iMessage, WhatsApp and Telegram all do, and this composer is a deliberate
 * iMessage reconstruction. So the RAIL's control is the one that differentiates.
 *
 * WHY THIS TEST MOUNTS BOTH. The complaint is comparative. A test that inspects
 * the rail alone would pass just as happily if someone later restyled the
 * composer's leading control into an outlined square and re-created the
 * collision from the other side. The contract is "these two do not read the
 * same", so both have to be in the tree, which is also the arrangement the
 * device screenshot shows.
 *
 * HONEST BOUNDARY, same as `composer-action-swap`: the harness fakes every
 * layout rect, so this asserts the paint each control ASKS FOR — its fill, its
 * ring, its corner radius, its label — not measured pixels or the gap between
 * them on glass. Whether the pair actually reads as distinct at 72pt is a device
 * claim settled with a screenshot, and it is not settled here.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { createElement, Fragment } from 'react';

import {
  installNativeHarness,
  resetHarnessGlobals,
  setHarnessPlatform,
} from './support/native-harness';

installNativeHarness();
setHarnessPlatform('android');

const { FakeChatSocket, mountScreen } = await import('./support/mount');
const { setRuntimeServerConfig, __resetServerConfigForTests } = await import('../lib/config');
const { AuthSessionProvider } = await import('../lib/session');
const { ChatSyncSurface } = await import('../components/ChatSyncSurface');
const { ProjectRail } = await import('../components/ProjectRail');
const { __resetSharedMobileStoreForTests } = await import('../lib/chat-core/op-sqlite-store');
const { clearSessionCache } = await import('../lib/chat-core/session-cache');

const OWNER = {
  id: 'harness-owner',
  email: 'owner@example.test',
  displayName: 'Harness Owner',
  provider: 'dev' as const,
  token: 'harness-token',
};

const PROJECTS = [
  {
    id: 'harness-project',
    name: 'Willow',
    emoji: '🔷',
    unread_count: 0,
    origin_instance: 'local' as const,
  },
  { id: 'acme', name: 'Acme', emoji: '🔶', unread_count: 0, origin_instance: 'local' as const },
];

let created = 0;

beforeEach(() => {
  created = 0;
  FakeChatSocket.install();
  clearSessionCache();
  __resetSharedMobileStoreForTests();
  __resetServerConfigForTests();
  setRuntimeServerConfig({ gateway_base_url: 'https://harness.example.test', auth_base_url: null });
});

afterEach(() => {
  clearSessionCache();
  __resetServerConfigForTests();
});

beforeAll(installNativeHarness);
afterAll(resetHarnessGlobals);

/** The rail and the composer band in ONE tree — the frame the complaint is about. */
async function mountRailAndComposer() {
  const screen = await mountScreen(
    createElement(
      AuthSessionProvider,
      { initialUser: OWNER },
      createElement(
        Fragment,
        null,
        createElement(ProjectRail, {
          projects: PROJECTS,
          overlay: new Map(),
          activeProjectId: 'harness-project',
          onSelect: () => undefined,
          onCreate: () => {
            created += 1;
          },
          reduceMotionOverride: true,
        }),
        createElement(ChatSyncSurface, { projectId: 'harness-project' }),
      ),
    ),
  );
  FakeChatSocket.current().onopen?.();
  await screen.settle();
  return screen;
}

describe('the rail creates projects; the composer attaches files', () => {
  it('renders both controls, so the comparison below is not vacuous', async () => {
    const screen = await mountRailAndComposer();

    expect(screen.byTestId('rail-create')).not.toBeNull();
    expect(screen.byTestId('composer-attach')).not.toBeNull();

    screen.unmount();
  });

  it('gives them silhouettes that cannot be confused: outlined square vs filled circle', async () => {
    const screen = await mountRailAndComposer();

    const tile = screen.byTestId('rail-create-tile')!;
    const attach = screen.byTestId('composer-attach')!;
    expect(tile).not.toBeNull();
    expect(attach).not.toBeNull();

    const tilePaint = paintOf(tile);
    const attachPaint = paintOf(attach);

    // FILL. The composer's control is a filled pill of `surface_raised`; the
    // rail's is an empty slot. "Just give the rail one a background too" is the
    // most likely way this regresses, and it fails here.
    expect(isUnpainted(tilePaint.background)).toBe(true);
    expect(isUnpainted(attachPaint.background)).toBe(false);

    // RING. Only the rail's control is drawn as an outline.
    expect(px(tilePaint.borderWidth)).toBeGreaterThan(0);
    expect(px(attachPaint.borderWidth)).toBe(0);

    // SHAPE. A radius of half the width is a circle; anything well under it is a
    // rounded square. Read as a RATIO so this survives either control being
    // resized.
    expect(radiusRatio(tile)).toBeLessThan(0.35);
    expect(radiusRatio(attach)).toBeGreaterThanOrEqual(0.5);

    screen.unmount();
  });

  it('labels the rail control and leaves the composer control unlabelled', async () => {
    const screen = await mountRailAndComposer();

    // The word is the strongest disambiguator on the screen, and it also puts
    // the create row back into the rail's own anatomy — every other row is a
    // glyph over a name, and this one was the only bare one.
    expect(screen.byTestId('rail-create')!.textContent).toContain('New');
    expect(screen.byTestId('composer-attach')!.textContent?.trim()).toBe('');

    screen.unmount();
  });

  it('no longer draws the rail control as a bare text `+`', async () => {
    const screen = await mountRailAndComposer();

    // The literal thing that was reported, named so it cannot come back: the old
    // control was a `<Text>+</Text>` sized by the system font. The mark is now
    // drawn from views, like every other glyph in this app.
    expect(screen.byTestId('rail-create')!.textContent).not.toContain('+');
    expect(screen.byTestId('rail-create-plus')).not.toBeNull();

    screen.unmount();
  });

  it('reaches the two controls by DIFFERENT names', async () => {
    const screen = await mountRailAndComposer();

    // Distinct for a screen reader too, not only for an eye. And pressing the
    // rail's still opens project creation — the differentiation is paint, not
    // rewiring.
    await screen.press('New project');
    expect(created).toBe(1);

    expect(screen.byTestId('composer-attach')!.getAttribute('aria-label')).toBe('Add attachment');

    screen.unmount();
  });
});

/** What a node puts on screen: its fill and its ring. */
function paintOf(el: HTMLElement): { background: string; borderWidth: string } {
  const computed = el.ownerDocument.defaultView!.getComputedStyle(el);
  return { background: computed.backgroundColor, borderWidth: computed.borderTopWidth };
}

/** Corner radius as a fraction of width: 0.5 is a circle, 0 is a hard square. */
function radiusRatio(el: HTMLElement): number {
  const computed = el.ownerDocument.defaultView!.getComputedStyle(el);
  const width = px(computed.width);
  if (width === 0) throw new Error('control has no width in the harness — assertion would be vacuous');
  return px(computed.borderTopLeftRadius) / width;
}

function px(value: string): number {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

/** Fully transparent, however the style engine happens to spell it. */
function isUnpainted(background: string): boolean {
  if (background === '' || background === 'transparent') return true;
  const alpha = /^rgba\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*([\d.]+)\s*\)$/.exec(background);
  return alpha !== null && Number(alpha[1]) === 0;
}
